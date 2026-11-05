/**
 * incident-log.ts — always-on, level-INDEPENDENT record of every stream that
 * did NOT complete cleanly.
 *
 * Routine trace detail is level-gated; failure records must remain available
 * at the shipped log level. This module is therefore a sibling of
 * `logging.level`, not a child of it, matching `logging.stall_detection`.
 *
 * **What it records.** One JSONL line per stream whose outcome is anything
 * other than `success`. Successes are deliberately excluded: they are the
 * majority, and their latency distribution belongs in a histogram, not
 * a file. This keeps the file bounded by the failure rate rather than traffic.
 *
 * **`ttfbMs` and `elapsedMs` are separate on purpose.** The two stall shapes
 * differ precisely on whether a first upstream byte ever arrived: an ABSENT
 * `ttfbMs` means the upstream never produced one (pre-content death), while a
 * present one means the stream had started and then broke. Collapsing them
 * into a single duration destroys the only distinction that matters.
 *
 * **Total-safe discipline, mirroring `lib/crash.ts` and
 * `routes/_shared/stall-detect.ts`.** This runs inside a stream's OUTER
 * `finally` block, so a throw here would tear down a live proxy stream on its
 * way out. Every path is wrapped; the writer never throws, and degrades to a
 * constant line rather than losing the record entirely.
 *
 * **It DOES block — on SYNCHRONOUS I/O, and that is deliberate.** `mkdirSync`,
 * `statSync`, `renameSync` and `appendFileSync` all execute inline on the event
 * loop from that `finally`, so a slow filesystem here delays unrelated streams.
 * An earlier version of this paragraph said the writer "never blocks on async
 * I/O", which is true and useless: this module does no async I/O at all, which
 * is not the same as not blocking. Two things make the cost acceptable:
 *
 *   - **The cost is bounded by the FAILURE RATE, not by traffic.** A record is
 *     written only when the forwarder's outcome is not `success` — see the
 *     `outcome !== "success"` guard in `recordStreamCompletion`
 *     (`routes/_shared/forward-stream.ts`) — so a healthy proxy does no disk
 *     I/O here at all, whatever its request volume.
 *   - **Durability over latency is the trade, chosen on purpose.** A serialized
 *     fire-and-forget async writer with a bounded queue was proposed and
 *     rejected on the merits: a queued record is lost in exactly the crash it
 *     exists to explain, and crash diagnosability is the entire reason this
 *     module exists.
 *
 * **The condition that falsifies the argument: it assumes LOCAL disk.** The
 * default path is built from `PATHS.INCIDENT_LOG_PATH`, i.e. `os.homedir()` +
 * `.local/share/copilot-proxy/logs/` — the local user profile on every fleet
 * box. An operator's `logging.incident_log.log_path` override carries no such
 * property. Point it at a network filesystem (SMB/NFS) — or run on a box whose
 * profile is redirected onto one — and a single append can block for seconds on
 * a transport timeout while unrelated streams wait. That is the case in which
 * this trade should be reconsidered rather than defended.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import consola from "consola";

import { PATHS, expandTilde } from "~/lib/paths.ts";

/**
 * One non-success stream completion.
 *
 * `outcome` is typed as a plain `string` rather than importing
 * `StreamCompletionOutcome` from `forward-stream.ts`. That is deliberate:
 * D73 treats the outcome union as a machine-checked invariant of the proxy's
 * highest-risk file, and a second copy of it here would be a drift surface the
 * compiler could not police. The record carries whatever the forwarder
 * assigned, and `status` carries the number the forwarder already derived — so
 * this module introduces no mapping of its own and cannot disagree with the
 * one in force.
 */
export interface IncidentRecord {
  /** ISO-8601 instant the stream completed. */
  ts: string;
  /** The forwarder's own `StreamCompletionOutcome`, verbatim. */
  outcome: string;
  /** The numeric status the forwarder derived from `outcome`. */
  status: number;
  /** Clean metric route label ("messages" | "responses" | "chat_completions"). */
  route: string;
  /** Client protocol label; with `route` + `model` this identifies the lane. */
  protocol?: string;
  model?: string;
  /** The level-independent join key (`getRequestId`). Absent is a defect signal. */
  requestId?: string;
  /**
   * D99(c) — the UPSTREAM Anthropic `message_start` id (`msg_…`), the join key
   * that ties this record to one entry in a Claude Code transcript. `requestId`
   * joins the proxy's own surfaces to each other; this one joins them to the
   * CLIENT, which is the half D96 could not close.
   *
   * This key also belongs on the level-independent record: raw trace buffers
   * can contain it while `traceMeta` is absent at ordinary logging levels.
   *
   * ABSENT for three distinct reasons, and the field alone cannot tell them
   * apart — `copilot_proxy_upstream_msg_id_total{result}` is where that lives:
   *
   *   - stall detection is OFF, so no `PeekState` exists and nothing looked
   *     (`result="not_observed"`);
   *   - no `message_start` was seen at all — correct BY CONSTRUCTION for every
   *     Responses-upstream lane, and also the case for a stream that died before
   *     its first byte (`result="absent"`);
   *   - a `message_start` was seen and its id failed the shape guard
   *     (`result="rejected"`).
   *
   * ⚠ **Failures-only, like every field here.** Records are appended only when
   * `outcome !== "success"`, so a SUCCESSFUL stream's upstream id reaches no
   * level-independent surface at all. That gap is known and deliberate: closing
   * it means a second surface, which is a separate change.
   */
  upstreamMessageId?: string;
  /**
   * Milliseconds from forwarder entry to the FIRST non-empty upstream chunk.
   * ABSENT means no upstream byte ever arrived — the discriminator between the
   * two stall shapes. Never conflate with `elapsedMs`.
   */
  ttfbMs?: number;
  /** Milliseconds from forwarder entry to completion. Always present. */
  elapsedMs: number;
  /**
   * Milliseconds from forwarder entry to the first CONTENT delta as the
   * smart-peek classifies it — NOT to the first raw byte, which is `ttfbMs`.
   * ABSENT means content was never observed, mirroring `ttfbMs`'s
   * absent-is-the-discriminator contract; `phase` says WHY.
   *
   * ⚠ **Never source a stall window from this field.** Records are appended
   * only when `outcome !== "success"`, so any statistic drawn from them is a
   * FAILURES-ONLY population — the censored-denominator defect arriving through
   * the diagnostic surface instead of the metric surface. The tuning surface is
   * `copilot_proxy_first_content_seconds`, which is observed for every stream;
   * this field is the per-stream JOIN that explains one failure.
   */
  firstContentMs?: number;
  /**
   * The largest COMPLETED detector-active await this stream spent in any one
   * phase, in milliseconds, with {@link maxDetectorWaitPhase} naming that phase.
   *
   * ⚠ **COMPLETED waits only — a right-censored wait is reported by
   * {@link censoredWaitMs} / {@link censoredWaitPhase} instead, and is NOT
   * folded in here.** The two are not comparable: each phase carries its own
   * window, so a censored `response` wait (`>= 600 s` at the defaults) may be
   * smaller or larger than a completed `no_response` one (up to 1 140 s), and a
   * max over the union would mix a bound with a measurement.
   *
   * ABSENT when no detector-active wait ever COMPLETED. That is three cases, not
   * two: the detector never armed (stall detection off, or a null upstream
   * body), OR every armed read was censored — which is exactly the canonical
   * pre-content stall, where the one and only armed read loses to the stall
   * timer. On that stream `censoredWaitPhase` is the field that carries the
   * story; absence HERE is not evidence the detector never armed.
   *
   * ⚠ **Same failures-only caveat as `firstContentMs`, and it bites harder
   * here** — the tuning surface is `copilot_proxy_detector_max_wait_seconds`,
   * which is observed for every stream and sliced by phase. A window derived
   * from this field is derived from failures alone.
   */
  maxDetectorWaitMs?: number;
  /**
   * The `DetectorPhase` {@link maxDetectorWaitMs} was measured in. Typed as a
   * plain `string` for the same reason `outcome` is: the union lives in
   * `routes/_shared/stall-detect.ts`, and a second copy here would be a drift
   * surface the compiler could not police.
   *
   * ⚠ **Failures-only, like every field in this record.** Aggregating it across
   * the JSONL ("which phase dominates our worst waits?") answers that question
   * for the FAILURE population alone; the fleet-wide answer is the
   * `phase` label on `copilot_proxy_detector_max_wait_seconds`.
   */
  maxDetectorWaitPhase?: string;
  /**
   * The `DetectorPhase` whose detector-active wait was RIGHT-CENSORED — the
   * stall timer won the race, so that read was orphaned and its true wait is
   * unknowable. At most one per stream: a stall arm terminates the stream.
   *
   * PRESENT is the marker that this stream was killed by the stall detector
   * while waiting, and ABSENT means no wait was censored. Read it BEFORE
   * {@link maxDetectorWaitMs}: when this field is present, that one describes
   * some earlier, completed wait and is not the wait that ended the stream.
   *
   * ⚠ Failures-only, like every field here.
   */
  censoredWaitPhase?: string;
  /**
   * Milliseconds elapsed on that censored read — a **LOWER BOUND**, not a
   * measurement. The stall window is armed one statement before the wait clock
   * starts, so this is ≈ the window that was in force; the true wait is known
   * only to be at least this.
   *
   * This is the field that answers "this 504 was preceded by a wait of at least
   * 1,140 s in the no_response phase" for ONE stream. Present iff
   * {@link censoredWaitPhase} is.
   *
   * ⚠ **Never source a stall window from it** — beyond the failures-only
   * caveat, a censored value is a function of the CONFIGURED window and would
   * simply read that window back. The tuning surface is
   * `copilot_proxy_detector_wait_censored_total` as a FRACTION of the streams
   * that entered the phase; see that counter's HELP.
   */
  censoredWaitMs?: number;
  /**
   * Content phase at completion, when the smart-peek was active.
   *
   * `"unobservable"` means the lane's smart-peek is structurally incapable of
   * observing content (translated × `openai_chat`), so `"pre_content"` would be
   * a false claim rather than a measurement — the same mislabel
   * `stream_no_content_total{reason="lane_unobservable"}` exists to prevent, one
   * field over.
   */
  phase?: "pre_content" | "mid_stream" | "thinking" | "unobservable";
  /** Upstream bytes actually received before the stream ended. */
  bytesReceived: number;
  /** Request body size in bytes, when the handler threaded it. */
  requestBytes?: number;
  /** Concurrent in-flight requests on this route at stream start. */
  inflightAtStart?: number;
  /** Concurrent in-flight requests on this route at completion. */
  inflightAtEnd?: number;
}

export interface IncidentConfig {
  /** Append one record. Never throws. */
  log(record: IncidentRecord): void;
}

// ---------------------------------------------------------------------------
// Total-safe serialization (same shape as stall-detect.ts's helpers, which are
// module-private there; re-stated rather than exported from a shipped file).
// ---------------------------------------------------------------------------

const UNSERIALIZABLE_LINE = '{"incident":"[unserializable record]"}';

/** `String(x)` without throwing (null-prototype, throwing toString, …). */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

/** `JSON.stringify` without throwing (circular / bigint). */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Serialize to ONE JSONL line. If the record itself resists `JSON.stringify`
 * (a circular ref or bigint smuggled in on a string field), rebuild from the
 * fields that are structurally scalars so a line is still emitted. A constant
 * is the last resort — an unparseable line still proves an incident occurred,
 * which is strictly better than silence.
 *
 * **The whole fallback assembly is wrapped, and `safeString` is NOT enough on
 * its own.** `safeString(record.ts)` evaluates `record.ts` BEFORE `safeString`
 * is entered, so a throwing getter — or a `Proxy` with a throwing `get` trap —
 * escapes the per-field guard entirely, propagates out of this function, and
 * lands in `appendIncidentLog`'s catch, which warns and appends NOTHING. That
 * path emits no `UNSERIALIZABLE_LINE` at all, so the module's "degrades to a
 * constant line rather than losing the record" contract was FALSE for exactly
 * the malformed input the fallback exists to handle. The `try` below is what
 * makes that sentence true; `safeString` still earns its place for the values
 * that are readable but not stringifiable.
 *
 * Reachability is hostile/malformed-caller only — normally C-2's defer class —
 * but the fix is three lines and it closes a false claim in a shipped docblock.
 */
export function serializeIncident(record: IncidentRecord): string {
  const direct = safeJson(record);
  if (direct !== undefined) return direct;

  try {
    const safe: Record<string, unknown> = {
      ts: safeString(record.ts),
      outcome: safeString(record.outcome),
      status: record.status,
      route: safeString(record.route),
      elapsedMs: record.elapsedMs,
      bytesReceived: record.bytesReceived,
      degraded: true,
    };
    if (record.requestId !== undefined) {
      safe.requestId = safeString(record.requestId);
    }
    // D99(c) — the degraded line keeps the IDENTIFIERS. A rebuild that drops
    // the join key is exactly as unjoinable as the `<unknown>` lines D96 was
    // written about, which is why `requestId` is already here.
    if (record.upstreamMessageId !== undefined) {
      safe.upstreamMessageId = safeString(record.upstreamMessageId);
    }
    if (record.model !== undefined) safe.model = safeString(record.model);
    if (record.ttfbMs !== undefined) safe.ttfbMs = record.ttfbMs;

    return safeJson(safe) ?? UNSERIALIZABLE_LINE;
  } catch {
    return UNSERIALIZABLE_LINE;
  }
}

/**
 * Default cap before the file rotates to a single `.1` sibling. 8 MB holds
 * roughly 40k incident lines — years of a home fleet's failures.
 *
 * **This is a best-effort cap, not a disk guarantee.** It bounds worst-case
 * disk to 2 × `maxBytes` only while `rename` keeps working, and that weakness
 * is a direct consequence of the priority this module is built on: an oversized
 * log is a smaller problem than a dropped incident record. Two mechanisms let
 * the file exceed the cap, and only one of them is bounded:
 *
 *   1. **Persistent rotation failure — UNBOUNDED.** `rotateIfNeeded` never
 *      propagates a `rename` failure, because the only way to propagate it
 *      would be to drop the record. If the rename fails permanently — a
 *      DIRECTORY sitting at the `.1` path (measured: `EPERM` on Windows,
 *      `EISDIR` on POSIX), or any other condition that makes the rename
 *      impossible, such as the live file being held open by another process —
 *      then every rotation fails while every append still lands, and the live
 *      file grows without limit. Measured against a directory blocker: 1.0x,
 *      2.0x, 3.0x, 4.0x the cap over four appends, all four records retained.
 *      It is at least not silent — each append whose rotation attempt FAILS
 *      emits a `consola.warn` naming the rename error. A rotation that
 *      SUCCEEDS is silent, and so is the first-ever append (no file to stat,
 *      so the rename is never reached) — which is why the measured warn count
 *      over N blocked appends is N-1, not N.
 *   2. **One-record overshoot — bounded by that record.** Rotation is decided
 *      on the PROJECTED post-append size, so a record smaller than `maxBytes`
 *      never pushes the live file past it. A record LARGER than `maxBytes`
 *      still lands whole on a freshly rotated file, so the real per-file bound
 *      is `max(maxBytes, largest single record)`.
 *
 * Read this constant as "how big the file gets when the filesystem cooperates",
 * never as a ceiling the proxy enforces.
 */
export const INCIDENT_LOG_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;

/**
 * Rotate when appending `pendingBytes` more would push the file past
 * `maxBytes`.
 *
 * Checked on the PROJECTED size rather than the current one: checking the
 * current size lets every single record overshoot the cap by its own length,
 * and rotating one record early costs nothing.
 *
 * Best-effort and total-safe, in two distinct senses that must not be
 * collapsed. A missing file is the normal first-call case and is silent. A
 * refused RENAME is the failure that makes the cap stop holding at all
 * (`INCIDENT_LOG_MAX_BYTES_DEFAULT` case 1), so it warns — and then still falls
 * through to the append, because dropping the record would be the worse
 * outcome.
 */
function rotateIfNeeded(
  logPath: string,
  maxBytes: number,
  pendingBytes: number,
): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; /* no file yet (the normal first call), or it cannot be stat'ed */
  }
  if (size + pendingBytes <= maxBytes) return;
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    try {
      consola.warn(
        `incident log rotation failed, so ${logPath} is no longer capped: ${safeString(err)}`,
      );
    } catch {
      /* even the warn must never throw */
    }
  }
}

/**
 * Append-only JSONL writer. Ensures the parent dir, rotates when this line
 * would cross the cap (best-effort — see `INCIDENT_LOG_MAX_BYTES_DEFAULT`),
 * appends a single line synchronously, and NEVER throws.
 */
export function appendIncidentLog(
  record: IncidentRecord,
  logPath: string,
  maxBytes: number = INCIDENT_LOG_MAX_BYTES_DEFAULT,
): void {
  try {
    const payload = serializeIncident(record) + "\n";
    mkdirSync(path.dirname(logPath), { recursive: true });
    // Byte length, not `.length`: the line is UTF-8 on disk and a multibyte
    // model name or outcome would make a code-unit count undercount the cap.
    rotateIfNeeded(logPath, maxBytes, Buffer.byteLength(payload, "utf8"));
    appendFileSync(logPath, payload, "utf8");
  } catch (err) {
    try {
      consola.warn(`appendIncidentLog failed (swallowed): ${safeString(err)}`);
    } catch {
      /* even the warn must never throw */
    }
  }
}

/**
 * Build an `IncidentConfig` from the parsed `logging.incident_log` sub-object.
 *
 * Read DEFENSIVELY. Zod's outer `.default(() => ({...}))` literal does not
 * re-run the inner object's defaults, so on a minimal `parse({})` this nested
 * object can be absent entirely — the F66 trap that `makeStallConfig` already
 * guards the same way. Returns `undefined` ONLY when explicitly disabled, so
 * the feature is on by default and reaches the fleet through the schema rather
 * than through `config.yaml` (which `install_bundle.ps1` places only-if-absent,
 * making a `default.yaml` edit a first-install seed and not a fleet lever —
 * F128/D95).
 */
export function makeIncidentConfig(
  cfg:
    | {
        enabled?: boolean;
        log_path?: string;
        max_bytes?: number;
      }
    | undefined,
): IncidentConfig | undefined {
  if (cfg?.enabled === false) return undefined;
  const logPath = expandTilde(cfg?.log_path ?? PATHS.INCIDENT_LOG_PATH);
  const maxBytes = cfg?.max_bytes ?? INCIDENT_LOG_MAX_BYTES_DEFAULT;
  return {
    log: (record: IncidentRecord): void => {
      appendIncidentLog(record, logPath, maxBytes);
    },
  };
}
