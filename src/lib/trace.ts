/**
 * trace.ts — sidecar trace writer for raw-mode flow capture.
 *
 * **Phase 6 layout (3 files per flow):**
 *
 *   {dir}/traces-YYYY-MM-DD/flows/0001_POST_<slug>.json   — manifest (small)
 *   {dir}/traces-YYYY-MM-DD/flows/0001_POST_<slug>.req    — raw request body bytes
 *   {dir}/traces-YYYY-MM-DD/flows/0001_POST_<slug>.res    — raw response body bytes
 *
 * Phase 5 v3.1 wrote a single JSON file per flow with the body inlined as a
 * string field; SSE responses were truncated to first 2 KB via `raw_first_2k`,
 * and every `"` inside the body string was escape-encoded `\"` because the
 * containing JSON document re-quoted it. Operator UX after deploy: traces
 * unreadable. Phase 6 keeps a small readable manifest .json and writes the
 * full request/response bytes to two raw-byte sidecar files in the same dir
 * — `cat`/`tail`/`grep` just work.
 *
 * **Manifest schema:**
 *
 *   {
 *     "n": <int>,
 *     "captured_at": <unix_seconds_float>,
 *     "request": {
 *       "method": <str>, "url": <str>, "host": <str>, "path": <str>,
 *       "headers": <Record<string,string>>,           // redacted
 *       "body_kind": "json"|"sse"|"text"|"empty",
 *       "body_path": <str|null>,                      // sibling basename or null
 *       "body_bytes": <int>,                          // raw byte length
 *       "body_truncated": <bool>                      // true iff sidecar was capped
 *     },
 *     "response": {
 *       "status": <int>, "reason": <str>,
 *       "headers": <Record<string,string>>,           // redacted
 *       "body_kind": "json"|"sse"|"text"|"empty",
 *       "body_path": <str|null>,
 *       "body_bytes": <int>,
 *       "body_truncated": <bool>,
 *       "body_summary"?: BodySummary                  // present iff body_kind=="sse"
 *     }
 *   }
 *
 * **`BodySummary`** (additive metadata for SSE bodies; never carries body text):
 *
 *   { event_counts: Record<string, number>,
 *     data_type_counts: Record<string, number>,
 *     total_lines: number }
 *
 * **Sidecar files:** basename equals the manifest basename with `.json`
 * replaced by `.req` (request) or `.res` (response). Empty bodies emit NO
 * sidecar file; `body_path: null`, `body_bytes: 0` in the manifest.
 *
 * **Write order** (per `TraceWriter.write`): `.req` first (if non-empty) →
 * `.res` (if non-empty) → manifest `.json` LAST. A partial-failure leaves
 * an orphan sidecar without a manifest, which is operator-debuggable; the
 * retention sweep (`runRetention`) eventually reaps the bucket.
 *
 * **File naming:** `{counter:04d}_{METHOD}_{slug}.json` where slug is
 * `host+path` with non-alphanumeric runs collapsed to `-` and trimmed to 40
 * chars (carried forward from Phase 5).
 *
 * **Redaction discipline:** All header redaction goes through
 * `lib/redact.ts § redactHeaders`. trace.ts never duplicates that logic.
 * Body bytes go to disk verbatim (no body redaction; the Phase 5 path didn't
 * redact bodies inside the manifest either — operator-visible auth secrets
 * live in headers, not bodies).
 *
 * **Rotation policy (M1b — per O16 / X8) — UNCHANGED from Phase 5:**
 *   - Day-bucketed directories by default; size cap; retention sweep.
 *   - F-DISC-26 byte-tally now sums manifest + sidecar bytes per write so
 *     the size-cap warning reflects actual disk usage.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LEVEL_ON, debug } from "./debug.ts";
import { redactHeaders } from "./redact.ts";

/** SSE body summary — additive metadata only; carries no body text. */
export interface BodySummary {
  event_counts: Record<string, number>;
  data_type_counts: Record<string, number>;
  total_lines: number;
}

/** Body classification — preserved from Phase 5 (SSE detection identical). */
export type BodyKind = "json" | "sse" | "text" | "empty";

/** Result of classifying a raw body byte stream + content-type. */
export interface ClassifiedBody {
  kind: BodyKind;
  /** Present iff kind === "sse"; metadata-only, no body text. */
  summary?: BodySummary;
}

/**
 * A single captured flow record — manifest-only metadata. Raw body bytes are
 * passed separately to `TraceWriter.write` and serialized to sidecar files.
 *
 * `body_path` MAY be left null/empty by the caller; `TraceWriter.write` sets
 * it to the sidecar basename before serializing the manifest (or leaves null
 * when the corresponding body bytes are empty).
 */
export interface FlowRecord {
  /** 1-based monotonic counter (assigned by the writer). */
  n?: number;
  /** Unix epoch seconds (float). Defaults to Date.now()/1000 if omitted. */
  captured_at?: number;
  request: {
    method: string;
    url: string;
    host: string;
    path: string;
    headers: Record<string, string>;
    body_kind: BodyKind;
    /** Sidecar basename (e.g. "0001_POST_v1-messages.req") or null. */
    body_path: string | null;
    /** Raw body byte length. 0 when there is no body. */
    body_bytes: number;
    /**
     * True iff the writer-supplied body bytes were capped upstream of the
     * writer (e.g. streaming forwarder hit its 16 MB buffer cap). For
     * non-streaming paths and for request bodies, always false (handlers
     * stash the full body via the body-stash pattern).
     */
    body_truncated: boolean;
  };
  response: {
    status: number;
    reason: string;
    headers: Record<string, string>;
    body_kind: BodyKind;
    body_path: string | null;
    body_bytes: number;
    body_truncated: boolean;
    /** SSE event/data tallies. Present iff response.body_kind === "sse". */
    body_summary?: BodySummary;
  };
}

/** Rotation policy options — passed via the TraceWriter constructor. */
export interface RotationOptions {
  /**
   * If true (default), per-day directories `traces-YYYY-MM-DD/flows/...` are
   * created and the counter resets per day. If false, all flows land in the
   * single `flows/` dir (M1a behavior; for backwards compat).
   */
  daily?: boolean;
  /**
   * Per-day-bucket size in megabytes at which we log a warning and CONTINUE
   * writing — trace integrity wins over a strict cap, so this throttles
   * nothing. Default 1024 (1 GB).
   *
   * The 1024 here deliberately disagrees with the schema default of 50 in
   * `config-schema.ts`: a TraceWriter built without an explicit rotation
   * option warns 20x later than one built from config. Pre-existing, and
   * preserved verbatim through the F143 rename.
   */
  warn_size_mb?: number;
  /**
   * Retention horizon in days. Default 7. `runRetention()` deletes day-bucket
   * dirs whose date is older than `now - retention_days`.
   */
  retention_days?: number;
}

/** Constructor options for `TraceWriter`. */
export interface TraceWriterOptions {
  rotation?: RotationOptions;
}

/**
 * Slugify `host+path` matching capture_addon.py `_slugify`:
 *   - replace non-[a-zA-Z0-9]+ runs with `-`
 *   - strip leading/trailing `-`
 *   - truncate to maxlen
 */
export function slugify(s: string, maxlen = 40): string {
  const replaced = s.replace(/[^a-zA-Z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, maxlen);
}

/**
 * Pad a positive integer to `width` digits with leading zeros (capture_addon
 * uses `{counter:04d}`). Negative values are passed through.
 */
function pad(n: number, width: number): string {
  const s = String(n);
  if (s.length >= width) return s;
  return "0".repeat(width - s.length) + s;
}

/**
 * Format a Unix-seconds-float timestamp to UTC ISO date `YYYY-MM-DD`.
 * Used to derive a flow's day-bucket name.
 */
function isoDateUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1, 2);
  const dd = pad(d.getUTCDate(), 2);
  return `${y}-${m}-${dd}`;
}

/**
 * Subtract N days from an ISO date `YYYY-MM-DD` (UTC). Returns the resulting
 * ISO date string. Used by `runRetention` to compute the cutoff date.
 */
function subtractDaysUtc(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map((s) => Number(s));
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d)
  ) {
    throw new Error(`subtractDaysUtc: bad ISO date: ${dateIso}`);
  }
  const t = Date.UTC(y, m - 1, d) - days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

/**
 * Classify a raw body byte stream + content-type. Returns the body kind and,
 * for SSE bodies, an additive `BodySummary` (event/data tallies).
 *
 *   - empty bytes              → { kind: "empty" }
 *   - SSE detection (priority order, IDENTICAL to Phase 5 `summarizeBody`):
 *       content-type contains "event-stream"
 *       OR text starts with "data:"
 *       OR text contains "\nevent:" within the first 300 chars
 *     → { kind: "sse", summary: BodySummary }
 *   - JSON content-type or json-shaped payload → { kind: "json" }
 *   - everything else                          → { kind: "text" }
 *
 * **Phase 6 vs Phase 5.** Phase 5's `summarizeBody` returned the parsed body
 * object as `body` (json), the truncated text as `body` (text), or the SSE
 * summary including `raw_first_2k`/`raw_full_size` (sse). Phase 6 returns
 * KIND ONLY for non-SSE; the raw bytes are written to the .req/.res sidecar
 * by the caller. SSE detection logic is preserved verbatim. There is NO
 * `JSON.parse` of the body — Phase 5's F-DISC-22 1MB guard is now moot.
 */
export function classifyBody(
  bytes: Uint8Array,
  contentType: string,
): ClassifiedBody {
  if (!bytes || bytes.length === 0) return { kind: "empty" };

  // utf-8 decode with replacement (matches Python's `errors="replace"` fallback).
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes);
  const ct = (contentType || "").toLowerCase();

  const isSse =
    ct.includes("event-stream") ||
    text.startsWith("data:") ||
    text.slice(0, 300).includes("\nevent:");

  if (isSse) {
    const events: Record<string, number> = {};
    const dataTypes: Record<string, number> = {};
    const lines = text.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("event:")) {
        const name = line.slice(6).trim();
        events[name] = (events[name] ?? 0) + 1;
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        try {
          const j: unknown = JSON.parse(data);
          if (j && typeof j === "object" && !Array.isArray(j)) {
            const obj = j as Record<string, unknown>;
            const t = obj["type"] ?? obj["object"];
            if (typeof t === "string" && t.length > 0) {
              dataTypes[t] = (dataTypes[t] ?? 0) + 1;
            }
          }
        } catch {
          // non-JSON data lines are common in SSE; ignore
        }
      }
    }
    const summary: BodySummary = {
      event_counts: events,
      data_type_counts: dataTypes,
      total_lines: lines.length,
    };
    return { kind: "sse", summary };
  }

  // JSON detection — content-type-driven OR shape-driven (`{` or `[` start).
  // Phase 6 does NOT parse the body (no JSON.parse) — we just classify so the
  // manifest carries an honest `body_kind`. The raw bytes go to the .req/.res
  // sidecar verbatim. Operator can `cat foo.req | jq` if they want parsed.
  if (ct.includes("application/json")) return { kind: "json" };
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") return { kind: "json" };

  return { kind: "text" };
}

/**
 * Writes captured flows as a 3-file sidecar layout per flow (manifest .json
 * + raw .req + raw .res), with M1b rotation policy (day-bucketed dirs,
 * size cap, retention sweep).
 *
 * - Default file path:
 *     `{dir}/traces-YYYY-MM-DD/flows/{NNNN}_{METHOD}_{slug}.json`
 *     `{dir}/traces-YYYY-MM-DD/flows/{NNNN}_{METHOD}_{slug}.req`
 *     `{dir}/traces-YYYY-MM-DD/flows/{NNNN}_{METHOD}_{slug}.res`
 * - With `rotation: { daily: false }`: `{dir}/flows/...` (M1a-original).
 *
 * Counter is per-day-bucket (resets each day); monotonically increases within
 * a bucket. Headers are redacted via `redactHeaders` before serialization.
 */
export class TraceWriter {
  private readonly rootDir: string;
  private readonly rotation: Required<RotationOptions>;
  // Per-bucket monotonic counter. Key = date ISO ("none" when daily=false).
  private counters: Map<string, number> = new Map();
  // Per-bucket "directory ensured" cache so we mkdir once per bucket.
  private dirsEnsured: Map<string, Promise<void>> = new Map();
  // F-DISC-26: per-bucket in-memory byte tally — incremented on every write
  // by manifest+sidecar bytes so the size-cap warning can fire without
  // calling `getDirSize()` (full readdir+stat) on the hot path. Corrected
  // periodically by `getDirSize()` (caches drift if files are deleted out-
  // of-band, e.g. by retention).
  private bytesThisBucket: Map<string, number> = new Map();
  // F-DISC-26: throttle the corrective `getDirSize()` recompute to ≤1 per
  // 5 minutes per bucket. Stores the Date.now() of the most recent recompute.
  private lastSizeCheckAt: Map<string, number> = new Map();
  // F-DISC-13: tracks buckets whose counter has already been seeded from
  // disk so repeated `init()` calls are cheap no-ops.
  private initializedBuckets: Set<string> = new Set();

  /** F-DISC-26: minimum interval (ms) between corrective getDirSize calls. */
  private static readonly SIZE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

  constructor(dir: string, opts?: TraceWriterOptions) {
    this.rootDir = dir;
    const r = opts?.rotation ?? {};
    this.rotation = {
      daily: r.daily ?? true,
      warn_size_mb: r.warn_size_mb ?? 1024,
      retention_days: r.retention_days ?? 7,
    };
  }

  /**
   * F-DISC-13: seed the in-memory counter from disk so post-restart writes
   * resume monotonically and never overwrite prior files. Scans the active
   * day-bucket's `flows/` dir (when `daily: true`) or the flat `flows/` dir
   * (when `daily: false`), parses the highest existing `NNNN` from filenames
   * matching `^(\d{4})_[A-Z]+_.*\.json$`, and seeds
   * `this.counters.set(bucketKey, max)`. The next call to `nextCounter()`
   * returns `max + 1`.
   *
   * Idempotent: subsequent calls for an already-seeded bucket are cheap
   * no-ops (gated by `initializedBuckets`). If the dir is missing (ENOENT —
   * expected first-run case) the counter stays 0 so the first write creates
   * `0001_*`. Other readdir errors are logged via `debug.on(LEVEL_ON, ...)`
   * and treated as no-op (defensive: never throw from startup).
   *
   * Caller invokes once at startup. Safe to call again e.g. across the day
   * boundary or in test cleanup-and-restart scenarios.
   */
  async init(): Promise<void> {
    const bucketKey = this.rotation.daily
      ? isoDateUtc(Date.now() / 1000)
      : "none";
    if (this.initializedBuckets.has(bucketKey)) return;
    const flowsDir = this.rotation.daily
      ? path.join(this.rootDir, `traces-${bucketKey}`, "flows")
      : path.join(this.rootDir, "flows");
    let entries: string[];
    try {
      entries = await readdir(flowsDir);
    } catch (err) {
      // ENOENT (no dir yet) is the expected first-run case → counter stays 0.
      // Anything else: log + treat as no-op rather than crashing startup.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        debug.on(
          LEVEL_ON,
          () => `[trace] init readdir failed for ${flowsDir}: ${String(err)}`,
        );
      }
      this.initializedBuckets.add(bucketKey);
      return;
    }
    let max = 0;
    const nameRe = /^(\d{4})_[A-Z]+_.*\.json$/;
    for (const name of entries) {
      const m = nameRe.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    if (max > 0) this.counters.set(bucketKey, max);
    this.initializedBuckets.add(bucketKey);
  }

  /**
   * Build the on-disk filename for the given counter + method + flow.
   * Exposed for tests. Slug is built from `host+path`.
   */
  buildFilename(
    n: number,
    method: string,
    host: string,
    reqPath: string,
  ): string {
    const cleanPath = reqPath.split("?")[0] ?? "/";
    const slug = slugify(`${host}${cleanPath}`);
    return `${pad(n, 4)}_${method}_${slug}.json`;
  }

  /**
   * Compute the directory path for a flow given its captured_at timestamp.
   * Returns the absolute path to the `flows/` directory inside the bucket
   * (or simply `{rootDir}/flows` when `daily: false`).
   */
  private flowsDirFor(captured_at: number): {
    bucketKey: string;
    flowsDir: string;
  } {
    if (!this.rotation.daily) {
      return { bucketKey: "none", flowsDir: path.join(this.rootDir, "flows") };
    }
    const date = isoDateUtc(captured_at);
    return {
      bucketKey: date,
      flowsDir: path.join(this.rootDir, `traces-${date}`, "flows"),
    };
  }

  /** Lazily ensure the per-bucket flows dir exists; idempotent + cached. */
  private ensureDir(bucketKey: string, flowsDir: string): Promise<void> {
    let p = this.dirsEnsured.get(bucketKey);
    if (!p) {
      p = mkdir(flowsDir, { recursive: true }).then(() => undefined);
      this.dirsEnsured.set(bucketKey, p);
    }
    return p;
  }

  /**
   * Get + advance the per-bucket counter atomically (single-threaded JS, so
   * no actual atomicity needed beyond synchronous increment).
   */
  private nextCounter(bucketKey: string): number {
    const next = (this.counters.get(bucketKey) ?? 0) + 1;
    this.counters.set(bucketKey, next);
    return next;
  }

  /**
   * Total bytes in a day-bucket's `flows/` dir. Returns 0 if the bucket dir
   * does not yet exist. Helper for tests + the size-cap warning check.
   *
   * For `daily: false`, pass `"none"` as the date.
   */
  async getDirSize(date: string): Promise<number> {
    const flowsDir =
      date === "none"
        ? path.join(this.rootDir, "flows")
        : path.join(this.rootDir, `traces-${date}`, "flows");
    let total = 0;
    let entries: string[];
    try {
      entries = await readdir(flowsDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      try {
        const st = await stat(path.join(flowsDir, name));
        if (st.isFile()) total += st.size;
      } catch {
        /* ignore — file may have been removed concurrently */
      }
    }
    return total;
  }

  /**
   * Sweep day-bucket directories whose date is older than `retention_days`
   * (relative to the current Date.now()). Returns the list of absolute paths
   * deleted. No-op when `daily: false`.
   *
   * Caller (M5+ scheduler) is responsible for periodic invocation.
   */
  async runRetention(): Promise<{ deleted: string[] }> {
    if (!this.rotation.daily) return { deleted: [] };
    // F-DISC-8: at 25-100 concurrent users a too-aggressive retention can
    // race with in-flight writes. Cap-up to 2-day minimum and warn. trace.ts
    // is a library — `consola` is reserved for entry-point modules per the
    // M5 D-LOCK conventions, so we route the warn through `debug.on(LEVEL_ON,
    // ...)`. Orchestrator-side adapts as needed.
    let retentionDays = this.rotation.retention_days;
    if (retentionDays < 2) {
      debug.on(
        LEVEL_ON,
        () =>
          `[trace] retention_days=${retentionDays} below safe minimum; capping to 2`,
      );
      retentionDays = 2;
    }
    const today = isoDateUtc(Date.now() / 1000);
    const cutoff = subtractDaysUtc(today, retentionDays);
    const deleted: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return { deleted };
    }
    for (const name of entries) {
      const m = /^traces-(\d{4}-\d{2}-\d{2})$/.exec(name);
      if (!m) continue;
      const bucketDate = m[1]!;
      // F-DISC-8: defense-in-depth — never delete today's bucket even if the
      // cutoff math somehow qualifies it (clock skew, mid-day config edits,
      // retention_days set to a degenerate value that slipped past the cap).
      if (bucketDate >= today) continue;
      if (bucketDate < cutoff) {
        const full = path.join(this.rootDir, name);
        try {
          await rm(full, { recursive: true, force: true });
          deleted.push(full);
        } catch (err) {
          debug.on(
            LEVEL_ON,
            () => `[trace] retention rm failed for ${full}: ${String(err)}`,
          );
        }
      }
    }
    return { deleted };
  }

  /**
   * Persist a flow as 3 sibling files: `.req` + `.res` raw-byte sidecars
   * (when their bodies are non-empty) plus the manifest `.json`. Returns the
   * absolute manifest path.
   *
   * @param flow                 metadata-only FlowRecord (no body fields).
   *                             `body_path` is overwritten by the writer.
   * @param requestBodyBytes     raw inbound body bytes; pass `new Uint8Array(0)`
   *                             for GETs / empty bodies.
   * @param responseBodyBytes    raw outbound body bytes; pass `new Uint8Array(0)`
   *                             for empty responses.
   *
   * **Write order.** `.req` first (if non-empty), then `.res` (if non-empty),
   * then manifest `.json` LAST. A partial-failure leaves an orphan sidecar
   * without a manifest (operator-debuggable; retention reaps the bucket).
   * If `.req` write throws, propagation aborts before `.res` and manifest;
   * the caller's existing fire-and-forget `.catch` reports the error.
   *
   * Mutates neither the input flow nor its nested objects (redaction returns
   * fresh dicts; we shallow-copy each record before serialization).
   */
  async write(
    flow: FlowRecord,
    requestBodyBytes: Uint8Array,
    responseBodyBytes: Uint8Array,
  ): Promise<string> {
    const captured_at = flow.captured_at ?? Date.now() / 1000;
    const { bucketKey, flowsDir } = this.flowsDirFor(captured_at);
    await this.ensureDir(bucketKey, flowsDir);
    const n = flow.n ?? this.nextCounter(bucketKey);

    const manifestName = this.buildFilename(
      n,
      flow.request.method,
      flow.request.host,
      flow.request.path,
    );
    const manifestPath = path.join(flowsDir, manifestName);
    // Sidecar basenames replace the trailing `.json` with `.req` / `.res`.
    // Live in the SAME dir as the manifest so cat/grep/tail just work.
    const reqBasename = manifestName.replace(/\.json$/, ".req");
    const resBasename = manifestName.replace(/\.json$/, ".res");
    const reqPath = path.join(flowsDir, reqBasename);
    const resPath = path.join(flowsDir, resBasename);

    const reqBytes = requestBodyBytes.length;
    const resBytes = responseBodyBytes.length;

    // Sequential writes: .req first, then .res, then manifest LAST. Binary
    // writes are tiny relative to network I/O — serial keeps error semantics
    // simple (the first failure aborts the chain; caller's .catch fires).
    if (reqBytes > 0) {
      await writeFile(reqPath, requestBodyBytes);
    }
    if (resBytes > 0) {
      await writeFile(resPath, responseBodyBytes);
    }

    const record = {
      n,
      captured_at,
      request: {
        method: flow.request.method,
        url: flow.request.url,
        host: flow.request.host,
        path: flow.request.path,
        headers: redactHeaders(flow.request.headers),
        body_kind: flow.request.body_kind,
        body_path: reqBytes > 0 ? reqBasename : null,
        body_bytes: reqBytes,
        body_truncated: flow.request.body_truncated,
      },
      response: {
        status: flow.response.status,
        reason: flow.response.reason,
        headers: redactHeaders(flow.response.headers),
        body_kind: flow.response.body_kind,
        body_path: resBytes > 0 ? resBasename : null,
        body_bytes: resBytes,
        body_truncated: flow.response.body_truncated,
        // Preserve the SSE summary metadata if the caller computed one.
        // Optional field — omitted from the JSON when undefined.
        ...(flow.response.body_summary !== undefined
          ? { body_summary: flow.response.body_summary }
          : {}),
      },
    };

    const serialized = JSON.stringify(record, null, 2);
    await writeFile(manifestPath, serialized, "utf-8");

    // Soft size-cap check. We log a warning but do NOT abort — trace
    // integrity wins. Caller may schedule retention to claw back space.
    //
    // F-DISC-26: under 25-100 concurrent writes the per-write `getDirSize()`
    // (full readdir+stat over up to ~1000 files/bucket) was the dominant
    // bottleneck. Replace with an in-memory `bytesThisBucket` tally. Only
    // call `getDirSize()` to correct the tally either (a) at most once per
    // SIZE_CHECK_INTERVAL_MS (5 min) per bucket, or (b) when the in-memory
    // tally first crosses the cap (so the cap warning fires promptly even
    // before the timer elapses). The cached value drives the warning;
    // `getDirSize()` is purely for cache correction (catches external
    // mutations like retention sweeps + restart drift).
    //
    // Phase 6: tally now sums manifest + sidecar bytes so the cap reflects
    // actual disk usage (sidecars dominate for SSE responses).
    if (this.rotation.daily) {
      const warnBytes = this.rotation.warn_size_mb * 1024 * 1024;
      const manifestBytes = Buffer.byteLength(serialized, "utf-8");
      const writtenBytes = manifestBytes + reqBytes + resBytes;
      const prevBytes = this.bytesThisBucket.get(bucketKey) ?? 0;
      const nextBytes = prevBytes + writtenBytes;
      this.bytesThisBucket.set(bucketKey, nextBytes);

      const lastCheck = this.lastSizeCheckAt.get(bucketKey) ?? 0;
      const now = Date.now();
      const intervalElapsed =
        now - lastCheck >= TraceWriter.SIZE_CHECK_INTERVAL_MS;
      const justCrossedThreshold =
        prevBytes <= warnBytes && nextBytes > warnBytes;

      if (intervalElapsed || justCrossedThreshold) {
        this.lastSizeCheckAt.set(bucketKey, now);
        const trueSize = await this.getDirSize(bucketKey);
        this.bytesThisBucket.set(bucketKey, trueSize);
      }

      const observed = this.bytesThisBucket.get(bucketKey) ?? nextBytes;
      if (observed > warnBytes) {
        debug.on(
          LEVEL_ON,
          () =>
            `[trace] day-bucket ${bucketKey} exceeds warn_size_mb=${this.rotation.warn_size_mb} (${observed} bytes); continuing — consider runRetention()`,
        );
      }
    }

    return manifestPath;
  }
}
