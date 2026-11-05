/**
 * Tests for src/lib/trace.ts (Phase 6 sidecar layout).
 *
 * Coverage map:
 *   - File naming pattern: 0001_POST_<slug>.json (manifest) + sibling
 *     0001_POST_<slug>.req + 0001_POST_<slug>.res sidecars.
 *   - Roundtrip: synthetic FlowRecord + raw req/res bytes → 3 files →
 *     manifest JSON.parse → walk sidecars → byte-equal compare.
 *   - SSE summary metadata preserved when body_kind=sse (event_counts,
 *     data_type_counts, total_lines — NEVER raw body text).
 *   - Empty bodies → no sidecar file + manifest carries body_path:null +
 *     body_bytes:0.
 *   - body_truncated:true honored when caller passes the flag.
 *   - Redaction integration: Authorization header passed in → comes out as
 *     <redacted, len=N> in the persisted manifest. Sidecar bodies are
 *     written verbatim (no body redaction at this layer).
 *   - classifyBody: empty / json / text / sse classification (no body parse).
 */

import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";

import {
  classifyBody,
  type FlowRecord,
  TraceWriter,
  slugify,
} from "../../src/lib/trace.ts";

let tempDirs: Array<string> = [];

afterEach(async () => {
  // Reset any time-mock leaked from F-DISC-8 retention tests below.
  setSystemTime();
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-trace-"));
  tempDirs.push(d);
  return d;
}

const ENC = new TextEncoder();

function makeFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  const base: FlowRecord = {
    request: {
      method: "POST",
      url: "http://localhost:4143/v1/messages",
      host: "localhost",
      path: "/v1/messages",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body_kind: "json",
      body_path: null,
      body_bytes: 0,
      body_truncated: false,
    },
    response: {
      status: 200,
      reason: "OK",
      headers: { "Content-Type": "application/json" },
      body_kind: "json",
      body_path: null,
      body_bytes: 0,
      body_truncated: false,
    },
  };
  return { ...base, ...overrides };
}

/** Default sample request/response payloads for the standard makeFlow. */
const SAMPLE_REQ_BYTES = ENC.encode(JSON.stringify({ hello: "world" }));
const SAMPLE_RES_BYTES = ENC.encode(JSON.stringify({ ok: true }));

describe("slugify", () => {
  it("collapses non-alphanumeric runs to dashes and trims leading/trailing", () => {
    expect(slugify("localhost/v1/messages")).toBe("localhost-v1-messages");
    expect(slugify("---a/b---c---")).toBe("a-b-c");
  });

  it("truncates to maxlen", () => {
    expect(slugify("a".repeat(100), 40).length).toBe(40);
  });
});

describe("classifyBody", () => {
  it("classifies empty bodies", () => {
    const out = classifyBody(new Uint8Array(0), "");
    expect(out.kind).toBe("empty");
    expect(out.summary).toBeUndefined();
  });

  it("classifies JSON bodies by content-type (no parse)", () => {
    const bytes = ENC.encode(`{"a":1}`);
    const out = classifyBody(bytes, "application/json");
    expect(out.kind).toBe("json");
    // Phase 6: classifyBody NEVER parses bodies; raw bytes go to .req/.res.
    expect(out.summary).toBeUndefined();
  });

  it("classifies json-shaped payloads even without content-type", () => {
    const bytes = ENC.encode(`{"a":1}`);
    const out = classifyBody(bytes, "");
    expect(out.kind).toBe("json");
  });

  it("falls back to text for non-JSON, non-SSE content", () => {
    const bytes = ENC.encode("not json or sse");
    const out = classifyBody(bytes, "text/plain");
    expect(out.kind).toBe("text");
  });

  it("classifies SSE by content-type and tallies events / data types", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start"}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta"}',
      "event: content_block_delta",
      'data: {"type":"content_block_delta"}',
      "",
    ].join("\n");
    const out = classifyBody(ENC.encode(sse), "text/event-stream");
    expect(out.kind).toBe("sse");
    expect(out.summary).toBeDefined();
    const summary = out.summary!;
    expect(summary.event_counts["message_start"]).toBe(1);
    expect(summary.event_counts["content_block_delta"]).toBe(2);
    expect(summary.data_type_counts["message_start"]).toBe(1);
    expect(summary.data_type_counts["content_block_delta"]).toBe(2);
    expect(typeof summary.total_lines).toBe("number");
    expect(summary.total_lines).toBeGreaterThan(0);
  });

  it("classifies SSE by leading 'data:' even when content-type is missing", () => {
    const sse = `data: {"type":"x"}\n`;
    const out = classifyBody(ENC.encode(sse), "");
    expect(out.kind).toBe("sse");
  });

  it("BodySummary carries no body text — only tallies", () => {
    // Anti-pattern guard: the summary MUST NOT regrow a body string field
    // (would duplicate the .res sidecar contents and invite escape-encoded
    // re-introduction of operator-issue #2).
    const sse = `event: x\ndata: {"type":"x"}\n\n`;
    const out = classifyBody(ENC.encode(sse), "text/event-stream");
    expect(out.kind).toBe("sse");
    const summary = out.summary as unknown as Record<string, unknown>;
    expect(summary).toBeDefined();
    expect(Object.keys(summary).sort()).toEqual([
      "data_type_counts",
      "event_counts",
      "total_lines",
    ]);
  });
});

describe("TraceWriter — file naming + 3-file sidecar layout", () => {
  it("uses pad-4 counter + METHOD + slug filename for the manifest", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    await writer.write(
      makeFlow({
        request: {
          ...makeFlow().request,
          body_bytes: SAMPLE_REQ_BYTES.length,
        },
        response: {
          ...makeFlow().response,
          body_bytes: SAMPLE_RES_BYTES.length,
        },
      }),
      SAMPLE_REQ_BYTES,
      SAMPLE_RES_BYTES,
    );
    const entries = (await readdir(path.join(dir, "flows"))).sort();
    // 3 files: 0001_POST_*.json + 0001_POST_*.req + 0001_POST_*.res
    expect(entries.length).toBe(3);
    const exts = entries.map((n) => path.extname(n)).sort();
    expect(exts).toEqual([".json", ".req", ".res"]);
    const manifestName = entries.find((n) => n.endsWith(".json"))!;
    expect(manifestName).toMatch(/^0001_POST_[A-Za-z0-9-]+\.json$/);
    expect(manifestName).toContain("localhost-v1-messages");
    // Sidecars share the manifest stem.
    const stem = manifestName.replace(/\.json$/, "");
    expect(entries).toContain(`${stem}.req`);
    expect(entries).toContain(`${stem}.res`);
  });

  it("monotonically increments the counter across calls", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    await writer.write(makeFlow(), new Uint8Array(0), new Uint8Array(0));
    await writer.write(makeFlow(), new Uint8Array(0), new Uint8Array(0));
    const entries = (await readdir(path.join(dir, "flows")))
      .filter((n) => n.endsWith(".json"))
      .sort();
    expect(entries[0]).toMatch(/^0001_/);
    expect(entries[1]).toMatch(/^0002_/);
  });

  it("written manifest has the canonical Phase-6 top-level shape", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    const fpath = await writer.write(
      makeFlow({
        request: {
          ...makeFlow().request,
          body_bytes: SAMPLE_REQ_BYTES.length,
        },
        response: {
          ...makeFlow().response,
          body_bytes: SAMPLE_RES_BYTES.length,
        },
      }),
      SAMPLE_REQ_BYTES,
      SAMPLE_RES_BYTES,
    );
    const parsed = JSON.parse(await readFile(fpath, "utf-8"));
    expect(typeof parsed.n).toBe("number");
    expect(typeof parsed.captured_at).toBe("number");
    expect(parsed.request).toBeDefined();
    expect(parsed.response).toBeDefined();
    for (const k of [
      "method",
      "url",
      "host",
      "path",
      "headers",
      "body_kind",
      "body_path",
      "body_bytes",
      "body_truncated",
    ]) {
      expect(parsed.request[k]).toBeDefined();
    }
    for (const k of [
      "status",
      "reason",
      "headers",
      "body_kind",
      "body_path",
      "body_bytes",
      "body_truncated",
    ]) {
      expect(parsed.response[k]).toBeDefined();
    }
    expect(["json", "sse", "text", "empty"]).toContain(
      parsed.request.body_kind,
    );
    expect(["json", "sse", "text", "empty"]).toContain(
      parsed.response.body_kind,
    );
    // Phase 6 anti-pattern guard: manifest MUST NOT carry a `body` field.
    expect(parsed.request.body).toBeUndefined();
    expect(parsed.response.body).toBeUndefined();
  });

  it("sidecar contents byte-equal the bytes passed to write()", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    const reqBytes = ENC.encode('{"model":"claude-3","prompt":"hi"}');
    const resBytes = ENC.encode('{"id":"msg_1","content":[{"text":"yo"}]}');
    const fpath = await writer.write(
      makeFlow({
        request: {
          ...makeFlow().request,
          body_bytes: reqBytes.length,
        },
        response: {
          ...makeFlow().response,
          body_bytes: resBytes.length,
        },
      }),
      reqBytes,
      resBytes,
    );
    const flowsDir = path.dirname(fpath);
    const stem = path.basename(fpath).replace(/\.json$/, "");
    const reqOnDisk = await readFile(path.join(flowsDir, `${stem}.req`));
    const resOnDisk = await readFile(path.join(flowsDir, `${stem}.res`));
    // Deep-equal raw byte content — F36/F49/F51 regression gate.
    expect(new Uint8Array(reqOnDisk)).toEqual(reqBytes);
    expect(new Uint8Array(resOnDisk)).toEqual(resBytes);
    // Manifest carries the basename only (not a full path).
    const manifest = JSON.parse(await readFile(fpath, "utf-8"));
    expect(manifest.request.body_path).toBe(`${stem}.req`);
    expect(manifest.response.body_path).toBe(`${stem}.res`);
    expect(manifest.request.body_bytes).toBe(reqBytes.length);
    expect(manifest.response.body_bytes).toBe(resBytes.length);
  });

  it("empty bodies → NO sidecar file + manifest carries body_path:null + body_bytes:0", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    const fpath = await writer.write(
      makeFlow({
        request: {
          ...makeFlow().request,
          body_kind: "empty",
        },
        response: {
          ...makeFlow().response,
          body_kind: "empty",
        },
      }),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    const entries = await readdir(path.dirname(fpath));
    // Only the manifest exists; no .req / .res siblings.
    expect(entries.filter((n) => n.endsWith(".req"))).toEqual([]);
    expect(entries.filter((n) => n.endsWith(".res"))).toEqual([]);
    expect(entries.filter((n) => n.endsWith(".json")).length).toBe(1);
    const manifest = JSON.parse(await readFile(fpath, "utf-8"));
    expect(manifest.request.body_path).toBeNull();
    expect(manifest.request.body_bytes).toBe(0);
    expect(manifest.response.body_path).toBeNull();
    expect(manifest.response.body_bytes).toBe(0);
  });

  it("body_truncated:true is honored in the manifest when caller sets it", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    // Simulate a streaming-side cap-hit: caller passes body_truncated:true
    // on the response side. The .res sidecar holds whatever bytes did fit.
    const partialResponse = ENC.encode("event: a\ndata: {}\n\n");
    const flow = makeFlow({
      response: {
        status: 200,
        reason: "OK",
        headers: { "content-type": "text/event-stream" },
        body_kind: "sse",
        body_path: null,
        body_bytes: partialResponse.length,
        body_truncated: true,
      },
    });
    const fpath = await writer.write(flow, new Uint8Array(0), partialResponse);
    const manifest = JSON.parse(await readFile(fpath, "utf-8"));
    expect(manifest.response.body_truncated).toBe(true);
    expect(manifest.response.body_bytes).toBe(partialResponse.length);
    // Sidecar exists and matches the partial bytes.
    const stem = path.basename(fpath).replace(/\.json$/, "");
    const onDisk = await readFile(
      path.join(path.dirname(fpath), `${stem}.res`),
    );
    expect(new Uint8Array(onDisk)).toEqual(partialResponse);
  });

  it("body_summary present iff response.body_kind=sse — and never carries body text", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    const sse = ENC.encode(
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const classified = classifyBody(sse, "text/event-stream");
    const flow = makeFlow({
      response: {
        status: 200,
        reason: "OK",
        headers: { "content-type": "text/event-stream" },
        body_kind: "sse",
        body_path: null,
        body_bytes: sse.length,
        body_truncated: false,
        body_summary: classified.summary,
      },
    });
    const fpath = await writer.write(flow, new Uint8Array(0), sse);
    const manifest = JSON.parse(await readFile(fpath, "utf-8"));
    expect(manifest.response.body_kind).toBe("sse");
    expect(manifest.response.body_summary).toBeDefined();
    expect(manifest.response.body_summary.event_counts["message_start"]).toBe(
      1,
    );
    expect(manifest.response.body_summary.event_counts["message_stop"]).toBe(1);
    // Anti-pattern guard: body_summary keys are tallies only.
    expect(Object.keys(manifest.response.body_summary).sort()).toEqual([
      "data_type_counts",
      "event_counts",
      "total_lines",
    ]);
    // .res sidecar holds the raw SSE bytes verbatim (no JSON wrapping, no
    // escape-encoding of `"`).
    const stem = path.basename(fpath).replace(/\.json$/, "");
    const sidecar = await readFile(
      path.join(path.dirname(fpath), `${stem}.res`),
      "utf-8",
    );
    expect(sidecar).toContain("event: message_start");
    expect(sidecar).not.toContain('\\"');
  });
});

describe("TraceWriter — redaction integration", () => {
  it("Authorization header is redacted in the persisted manifest", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    const fpath = await writer.write(
      makeFlow({
        request: {
          method: "POST",
          url: "http://localhost/v1/messages",
          host: "localhost",
          path: "/v1/messages",
          headers: { Authorization: "Bearer abc12345" },
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
      }),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    const parsed = JSON.parse(await readFile(fpath, "utf-8"));
    // Original was 15 chars: "Bearer abc12345"
    expect(parsed.request.headers["authorization"]).toBe(`<redacted, len=15>`);
    // And the original (capitalized) key shape is gone.
    expect(parsed.request.headers["Authorization"]).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// F-DISC-13 — `init()` counter seed from disk (post-restart monotonicity)
// ----------------------------------------------------------------------------

describe("TraceWriter — init() (F-DISC-13)", () => {
  it("is a no-op when the bucket dir is missing — counter stays 0; first write is 0001", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    await writer.init(); // dir does not exist yet; ENOENT path
    const fpath = await writer.write(
      makeFlow(),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(path.basename(fpath)).toMatch(/^0001_POST_/);
  });

  it("seeds the counter from the highest existing 4-digit prefix (daily=false)", async () => {
    const dir = await makeTempDir();
    const flowsDir = path.join(dir, "flows");
    await mkdir(flowsDir, { recursive: true });
    // Pre-existing files left by a previous proxy session.
    await writeFile(path.join(flowsDir, "0001_POST_x.json"), "{}");
    await writeFile(path.join(flowsDir, "0003_POST_y.json"), "{}");
    // Distractor files that must NOT influence the counter.
    await writeFile(path.join(flowsDir, "README.txt"), "leave me alone");
    await writeFile(path.join(flowsDir, "abcd_POST_x.json"), "{}");

    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    await writer.init();
    const fpath = await writer.write(
      makeFlow(),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    // Next write must be 0004 (max=3 + 1) — never overwrite 0001 or 0003.
    expect(path.basename(fpath)).toMatch(/^0004_POST_/);
  });

  it("seeds the counter from today's bucket when daily=true", async () => {
    const dir = await makeTempDir();
    // Compute today's UTC ISO date the same way the writer does.
    const now = Date.now() / 1000;
    const d = new Date(now * 1000);
    const today = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const flowsDir = path.join(dir, `traces-${today}`, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(path.join(flowsDir, "0007_GET_some-host-path.json"), "{}");

    const writer = new TraceWriter(dir); // default daily=true
    await writer.init();
    // Synthesize a flow captured "now" so it lands in today's bucket.
    const fpath = await writer.write(
      makeFlow({ captured_at: now }),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(path.basename(fpath)).toMatch(/^0008_POST_/);
  });

  it("is idempotent — repeated calls do not clobber an advanced counter", async () => {
    const dir = await makeTempDir();
    const flowsDir = path.join(dir, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(path.join(flowsDir, "0002_POST_x.json"), "{}");

    const writer = new TraceWriter(dir, { rotation: { daily: false } });
    await writer.init(); // seeds counter to 2
    await writer.write(makeFlow(), new Uint8Array(0), new Uint8Array(0)); // 0003
    await writer.init(); // SECOND init must NOT re-seed (no clobber to 3)
    const fpath = await writer.write(
      makeFlow(),
      new Uint8Array(0),
      new Uint8Array(0),
    ); // must be 0004
    expect(path.basename(fpath)).toMatch(/^0004_POST_/);
  });
});

// ----------------------------------------------------------------------------
// F-DISC-26 — throttled getDirSize() (in-memory bytesThisBucket cache)
// Phase 6: tally now sums manifest + sidecar bytes.
// ----------------------------------------------------------------------------

describe("TraceWriter — getDirSize throttle (F-DISC-26)", () => {
  it("rapid-fire writes within 5 min trigger only ONE getDirSize call", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, {
      rotation: { daily: true, warn_size_mb: 1024 }, // warn unreachable
    });
    // Spy: count getDirSize invocations by replacing the method on this
    // instance only. Preserves the original for fall-through correctness.
    const origGetDirSize = writer.getDirSize.bind(writer);
    let callCount = 0;
    writer.getDirSize = async (date: string) => {
      callCount++;
      return origGetDirSize(date);
    };

    // 10 rapid writes against the same day-bucket. With the F-DISC-26 cache
    // + 5-min throttle, only the first write should trigger a recompute
    // (lastSizeCheckAt starts at 0 → intervalElapsed=true on write #1).
    const day = Date.UTC(2026, 4, 5, 12, 0, 0) / 1000; // 2026-05-05 12:00 UTC
    for (let i = 0; i < 10; i++) {
      await writer.write(
        {
          captured_at: day,
          request: {
            method: "POST",
            url: "http://localhost/v1/messages",
            host: "localhost",
            path: "/v1/messages",
            headers: {},
            body_kind: "empty",
            body_path: null,
            body_bytes: 0,
            body_truncated: false,
          },
          response: {
            status: 200,
            reason: "OK",
            headers: {},
            body_kind: "empty",
            body_path: null,
            body_bytes: 0,
            body_truncated: false,
          },
        },
        new Uint8Array(0),
        new Uint8Array(0),
      );
    }
    expect(callCount).toBe(1);
  });

  it("recomputes via getDirSize when the cached tally crosses warn_size_mb (manifest + sidecar bytes)", async () => {
    const dir = await makeTempDir();
    // 1 MB cap — easy to overshoot with a few padded sidecar bodies.
    const writer = new TraceWriter(dir, {
      rotation: { daily: true, warn_size_mb: 1 },
    });
    const origGetDirSize = writer.getDirSize.bind(writer);
    let callCount = 0;
    writer.getDirSize = async (date: string) => {
      callCount++;
      return origGetDirSize(date);
    };

    const day = Date.UTC(2026, 4, 6, 12, 0, 0) / 1000; // 2026-05-06 12:00 UTC
    // Phase 6: bytes-tally counts manifest + .req + .res. We push ~300 KB
    // sidecar payloads (NOT inlined in the manifest) — 5 flows × ~300 KB ≈
    // 1.5 MB → cache crosses 1 MB cap during the run.
    const padding = ENC.encode("z".repeat(300 * 1024));
    for (let i = 0; i < 5; i++) {
      await writer.write(
        {
          captured_at: day,
          request: {
            method: "POST",
            url: "http://localhost/v1/messages",
            host: "localhost",
            path: "/v1/messages",
            headers: { "Content-Type": "application/json" },
            body_kind: "json",
            body_path: null,
            body_bytes: padding.length,
            body_truncated: false,
          },
          response: {
            status: 200,
            reason: "OK",
            headers: { "Content-Type": "application/json" },
            body_kind: "json",
            body_path: null,
            body_bytes: 0,
            body_truncated: false,
          },
        },
        padding,
        new Uint8Array(0),
      );
    }
    // First write primes the cache (1 call); the write that crosses the cap
    // forces an extra recompute (1 more). All within the same 5-min window,
    // so we expect exactly 2 — strictly fewer than the per-write 5 calls of
    // the unthrottled implementation.
    expect(callCount).toBe(2);
    expect(callCount).toBeLessThan(5);
  });
});

// ----------------------------------------------------------------------------
// F-DISC-8 — runRetention() validation: cap-up <2 days; never delete today.
// Verifies sidecars (.req/.res) get reaped alongside the .json manifest by
// the rm-rf-bucket sweep.
// ----------------------------------------------------------------------------

describe("TraceWriter — runRetention validation (F-DISC-8)", () => {
  it("caps retention_days < 2 up to 2 (does NOT delete the day-1 bucket)", async () => {
    const dir = await makeTempDir();
    // retention_days=1 — without the F-DISC-8 cap, the bucket dated
    // (today - 1 day) would be deleted. With the cap to 2, it survives.
    const writer = new TraceWriter(dir, {
      rotation: { daily: true, retention_days: 1 },
    });
    const todayMs = Date.UTC(2026, 4, 10, 12, 0, 0); // 2026-05-10 12:00 UTC
    const yesterdayUnix = (todayMs - 24 * 60 * 60 * 1000) / 1000;
    const twoDaysAgoUnix = (todayMs - 2 * 24 * 60 * 60 * 1000) / 1000;

    // Write a flow on yesterday — at retention_days=1 this would normally
    // be deleted; capped to 2 it survives.
    await writer.write(
      {
        captured_at: yesterdayUnix,
        request: {
          method: "POST",
          url: "http://localhost/v1/messages",
          host: "localhost",
          path: "/v1/messages",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
        response: {
          status: 200,
          reason: "OK",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
      },
      new Uint8Array(0),
      new Uint8Array(0),
    );
    // Write a flow on 2-days-ago. With cap=2 → cutoff=today-2=2026-05-08
    // and `bucketDate < cutoff` is "2026-05-08 < 2026-05-08" → false → survives.
    await writer.write(
      {
        captured_at: twoDaysAgoUnix,
        request: {
          method: "POST",
          url: "http://localhost/v1/messages",
          host: "localhost",
          path: "/v1/messages",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
        response: {
          status: 200,
          reason: "OK",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
      },
      new Uint8Array(0),
      new Uint8Array(0),
    );

    setSystemTime(new Date(todayMs));
    const result = await writer.runRetention();
    const remaining = (await readdir(dir)).filter((n) =>
      n.startsWith("traces-"),
    );
    expect(remaining).toContain("traces-2026-05-09");
    expect(remaining).toContain("traces-2026-05-08");
    expect(result.deleted.length).toBe(0);
  });

  it("never deletes today's bucket even when math would qualify it; sidecars in older buckets reaped with manifest", async () => {
    const dir = await makeTempDir();
    const writer = new TraceWriter(dir, {
      rotation: { daily: true, retention_days: 7 },
    });
    const todayMs = Date.UTC(2026, 4, 10, 12, 0, 0);
    const todayUnix = todayMs / 1000;

    await writer.write(
      {
        captured_at: todayUnix,
        request: {
          method: "POST",
          url: "http://localhost/v1/messages",
          host: "localhost",
          path: "/v1/messages",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
        response: {
          status: 200,
          reason: "OK",
          headers: {},
          body_kind: "empty",
          body_path: null,
          body_bytes: 0,
          body_truncated: false,
        },
      },
      new Uint8Array(0),
      new Uint8Array(0),
    );
    // Synthetic future-dated bucket (e.g. clock skew on a peer host) — must
    // also survive because `bucketDate >= today` short-circuits the delete.
    await mkdir(path.join(dir, "traces-2026-05-15", "flows"), {
      recursive: true,
    });
    // Plant an old-bucket fixture with all 3 sidecar files so we can verify
    // the rm-rf-bucket sweep reaps them together (Phase 6 anti-pattern guard:
    // sidecars MUST be co-located with the manifest in the same dir).
    const oldBucketFlows = path.join(dir, "traces-2026-04-01", "flows");
    await mkdir(oldBucketFlows, { recursive: true });
    await writeFile(path.join(oldBucketFlows, "0001_POST_x.json"), '{"n":1}');
    await writeFile(path.join(oldBucketFlows, "0001_POST_x.req"), "raw req");
    await writeFile(path.join(oldBucketFlows, "0001_POST_x.res"), "raw res");

    setSystemTime(new Date(todayMs));
    const result = await writer.runRetention();
    const remaining = (await readdir(dir))
      .filter((n) => n.startsWith("traces-"))
      .sort();
    expect(remaining).toContain("traces-2026-05-10");
    expect(remaining).toContain("traces-2026-05-15");
    expect(remaining).not.toContain("traces-2026-04-01");
    expect(
      result.deleted.find((p) => p.includes("traces-2026-04-01")),
    ).toBeDefined();
    expect(
      result.deleted.find((p) => p.includes("traces-2026-05-10")),
    ).toBeUndefined();
    expect(
      result.deleted.find((p) => p.includes("traces-2026-05-15")),
    ).toBeUndefined();
    // Defense-in-depth: the old-bucket sidecar files are gone too (rm -rf
    // of the bucket dir handles them; this catches any future drift toward
    // sidecars-in-different-dirs, which would survive the bucket-dir sweep).
    let sidecarsSurvive = false;
    try {
      await access(path.join(oldBucketFlows, "0001_POST_x.req"));
      sidecarsSurvive = true;
    } catch {
      /* expected — file gone */
    }
    expect(sidecarsSurvive).toBe(false);
  });
});
