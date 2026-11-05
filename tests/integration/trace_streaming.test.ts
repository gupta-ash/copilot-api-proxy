/**
 * trace_streaming.test.ts — Phase 5 v3.1 Group C integration coverage for
 * the streaming-side trace wiring in `src/routes/_shared/forward-stream.ts`.
 *
 * Tests 1-6 exercise `forwardStream` in isolation (forwarder + a fake
 * `Context`); test 7 (Phase 5 v3.1 follow-up) exercises the full
 * handler→middleware→forwarder integration as the regression gate for the
 * inbound-body propagation bug.
 *
 * Tests:
 *   1. Success path: stub upstream emits SSE → flow file written;
 *      `response.body_kind === "sse"` + `event_counts` non-empty.
 *   2. Buffer overflow: stub upstream emits >4 MB of SSE → `consola.warn`
 *      fires once; flow file STILL written; event_counts reflects the
 *      sub-cap captured chunks.
 *   3. Upstream mid-stream abort: stub upstream errors after one chunk →
 *      flow file written with `status === 502` (upstream_error).
 *   4. Trace dir read-only: simulate writer failure → request still drains;
 *      `bumpTraceWrites("error",...)` ticks the error counter; first failure
 *      bubbles via `consola.warn`.
 *   5. Client abort: client aborts mid-stream → flow file written with
 *      `status === 499` (client_abort).
 *   6. No-trace passthrough: `traceWriter`/`traceMeta` unset → no flow
 *      file appears; trace counters NOT bumped.
 *   7. (Phase 5 v3.1 follow-up) end-to-end via `buildApp` + `app.request`
 *      with a stubbed SSE upstream: streaming flow file's
 *      `request.body_kind === "json"` AND `request.body` deep-equals the
 *      sent payload AND `response.body_kind === "sse"`. Regression gate
 *      for the streaming-flow `inboundBody` propagation bug — pre-fix,
 *      handlers stashed via `c.set` but the streaming forwarder consumed
 *      a stale `traceMeta` snapshot still carrying `inboundBody: null`,
 *      producing `body_kind: "empty"` in every streaming trace.
 *
 * **Mechanism (tests 1-6).** Each test calls
 * `forwardStream(c, upstream, ctxBase)(stream)` directly with a fake Hono
 * `Context` + a fake `SSEStreamingApi` that captures writes. The mock
 * upstream is a `ReadableStream<Uint8Array>` constructed from the test's
 * chunk plan. This keeps the test independent of Group B's
 * `with-trace.ts` middleware (which threads `traceWriter`/`traceMeta`
 * through the per-request context); Group C tests the forwarder in
 * isolation.
 *
 * **Mechanism (test 7).** Builds a real Hono app via `buildApp(...)` with
 * a `TraceWriter`, stubs `globalThis.fetch` so the upstream returns a
 * canned SSE stream, and exercises `app.request("/v1/messages", ...)`.
 * This drives the full handler → `withTrace` middleware → `stashInboundBody`
 * helper → `forwardStream` chain so the meta-mutation step in the helper
 * is the link under test.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";
import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { LEVEL_ON, LEVEL_RAW, debug } from "../../src/lib/debug.ts";
import {
  getValueForTests,
  resetForTests as resetMetricsForTests,
} from "../../src/lib/metrics.ts";
import { TraceWriter } from "../../src/lib/trace.ts";
import { _resetFirstFailureForTests as _resetWithTraceFirstFailureForTests } from "../../src/routes/_shared/with-trace.ts";
import {
  _resetFirstFailureForTests,
  forwardStream,
  type StreamCtxBase,
  type TraceMeta,
} from "../../src/routes/_shared/forward-stream.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

// Side-effect import: ensure transform rules register so buildApp can wire
// the lane-1 route below without registry-empty errors.
import "../../src/lib/transform/index.ts";

// ---------------------------------------------------------------------------
// consola.warn capture (so tests can assert the F-DISC-3/F-DISC-4 surfaces).
// ---------------------------------------------------------------------------

let warnMessages: string[] = [];
let originalWarnFn: typeof consola.warn;

beforeEach(() => {
  warnMessages = [];
  originalWarnFn = consola.warn;
  consola.warn = ((msg: unknown, ...rest: unknown[]): void => {
    const flat = [msg, ...rest]
      .map((m) => (typeof m === "string" ? m : String(m)))
      .join(" ");
    warnMessages.push(flat);
  }) as typeof consola.warn;
  resetMetricsForTests();
  // Reset the first-failure throttle so tests are independent of each
  // other AND of test files that ran before us in the same process.
  _resetFirstFailureForTests();
  _resetWithTraceFirstFailureForTests();
  // Dynamic logging toggle: the app-path integration test (test 7) drives
  // with-trace.ts, which now arms trace capture only at level >= raw. The
  // isolated forwardStream tests (1-6) inject the writer directly into
  // ctxBase and are level-agnostic (forward-stream.ts never reads the level),
  // so raising it globally is harmless to them.
  debug.setLevel(LEVEL_RAW);
});
afterEach(() => {
  consola.warn = originalWarnFn;
  resetMetricsForTests();
  debug.setLevel(LEVEL_ON);
});

// ---------------------------------------------------------------------------
// Fake Context + Fake SSEStreamingApi (lifted from forward_stream_translated).
// ---------------------------------------------------------------------------

function makeFakeContext(signal?: AbortSignal): Context {
  const abortController = new AbortController();
  const sig = signal ?? abortController.signal;
  return {
    req: {
      raw: {
        signal: sig,
      },
    },
  } as unknown as Context;
}

interface FakeStreamCapture {
  bytes: Uint8Array[];
  api: SSEStreamingApi;
  abort(): void;
}

function makeFakeStreamApi(): FakeStreamCapture {
  const bytes: Uint8Array[] = [];
  const api = {
    aborted: false,
    closed: false,
    async write(input: Uint8Array | string): Promise<unknown> {
      const u8 =
        typeof input === "string" ? new TextEncoder().encode(input) : input;
      bytes.push(u8);
      return api;
    },
    async writeln(_s: string): Promise<unknown> {
      return api;
    },
    async close(): Promise<void> {
      // no-op
    },
    onAbort(_listener: () => void | Promise<void>): void {
      // no-op
    },
    abort(): void {
      (api as unknown as { aborted: boolean }).aborted = true;
    },
    sleep: async (_ms: number): Promise<unknown> => undefined,
    pipe: async (_body: ReadableStream): Promise<void> => undefined,
  } as unknown as SSEStreamingApi;
  return {
    bytes,
    api,
    abort(): void {
      (api as unknown as { aborted: boolean }).aborted = true;
    },
  };
}

function makeStreamingResponse(chunks: Array<Uint8Array | string>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Chunked stream that errors mid-flight (after the first chunk). */
function makeAbortingResponse(firstChunk: string): Response {
  const enc = new TextEncoder();
  let chunkDelivered: ((v: void) => void) | null = null;
  const delivered = new Promise<void>((r) => {
    chunkDelivered = r;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(enc.encode(firstChunk));
      // Defer the error so the first chunk is observably read by the
      // forwarder before the stream fails. Without this, some
      // ReadableStream impls deliver the error to the very first read()
      // call (the chunk gets lost). The microtask + 1ms delay gives the
      // reader's first `read()` a chance to resolve with `value` first.
      void delivered.then(() => {
        controller.error(new Error("simulated upstream socket reset"));
      });
    },
    pull(_controller): void {
      // Signal that the consumer has begun reading. Once the first chunk
      // has been delivered (the `pull` is invoked AFTER the buffered
      // enqueue is taken), trigger the error.
      if (chunkDelivered !== null) {
        const f = chunkDelivered;
        chunkDelivered = null;
        f();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Locate the only manifest .json file under tempDir/traces-YYYY-MM-DD/flows/. */
async function findOnlyFlowFile(tempDir: string): Promise<string> {
  const entries = await readdir(tempDir);
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) {
    throw new Error(`no traces-YYYY-MM-DD subdir under ${tempDir}`);
  }
  const flowsDir = path.join(tempDir, traceDir, "flows");
  const flowFiles = (await readdir(flowsDir)).filter((n) =>
    n.endsWith(".json"),
  );
  if (flowFiles.length !== 1) {
    throw new Error(
      `expected 1 manifest file, found ${flowFiles.length}: ${flowFiles.join(", ")}`,
    );
  }
  return path.join(flowsDir, flowFiles[0]!);
}

/** Build a minimal TraceMeta. */
function makeTraceMeta(overrides?: Partial<TraceMeta>): TraceMeta {
  return {
    requestId: "test-req-001",
    method: "POST",
    url: "https://localhost/v1/messages",
    host: "localhost",
    path: "/v1/messages",
    inboundHeaders: { "content-type": "application/json" },
    inboundBody: new TextEncoder().encode('{"model":"claude-x"}'),
    inboundContentType: "application/json",
    startedAt: Date.now(),
    ...(overrides ?? {}),
  };
}

/**
 * Wait for the trace writer's fire-and-forget promise to settle. The
 * `emitTraceFlow` helper inside forward-stream.ts kicks off
 * `writer.write(flow).then(...).catch(...)` and returns immediately —
 * the test must yield to the event loop several times so the writer's
 * mkdir + writeFile + chained .then/.catch all run before assertions.
 *
 * Bun + Windows shows occasional flakes at <30 ms total; 50 ms with
 * 10 yields gives a comfortable margin without slowing the suite down.
 */
async function waitForTraceFlush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

const CTX_BASE_DEFAULT: Pick<StreamCtxBase, "route" | "model" | "metricRoute"> =
  {
    route: "/v1/messages",
    model: "claude-x",
    metricRoute: "messages",
  };

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("forwardStream — Phase 5 v3.1 Group C trace wiring", () => {
  it("test 1: success path → flow file written with body_kind=sse + non-empty event_counts", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-1-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta();
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
      };
      const upstream = makeStreamingResponse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as {
        response: {
          status: number;
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
          body_truncated: boolean;
          body_summary?: { event_counts?: Record<string, number> };
        };
        request: { method: string };
      };
      expect(flow.response.status).toBe(200);
      expect(flow.response.body_kind).toBe("sse");
      const counts = flow.response.body_summary?.event_counts ?? {};
      // At least one event type present with count > 0.
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
      // Specifically the three event types we emitted.
      expect(counts["message_start"]).toBe(1);
      expect(counts["content_block_delta"]).toBe(1);
      expect(counts["message_stop"]).toBe(1);
      expect(flow.request.method).toBe("POST");
      // Phase 6 SSE regression gate: .res sidecar holds the raw bytes
      // verbatim — STARTS with `event: ` (no JSON wrapping) and contains NO
      // `\"` escape sequences.
      expect(flow.response.body_path).toMatch(/\.res$/);
      const resOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.response.body_path!),
        "utf-8",
      );
      expect(resOnDisk.startsWith("event: ")).toBe(true);
      expect(resOnDisk).not.toContain('\\"');
      expect(resOnDisk).toContain("event: message_start");
      expect(resOnDisk).toContain("event: content_block_delta");
      expect(resOnDisk).toContain("event: message_stop");
      expect(flow.response.body_bytes).toBe(
        Buffer.byteLength(resOnDisk, "utf-8"),
      );
      expect(flow.response.body_truncated).toBe(false);
      // bumpTraceWrites("success") was called.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 2: buffer overflow → consola.warn fires once + flow file still written + event_counts reflects sub-cap chunks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-2-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta({ requestId: "overflow-req" });
      // Force a tiny 1-byte cap so the second non-empty chunk overflows;
      // capMb=1 still gives us a 1 MB cap which would need huge upstream
      // bytes to overflow. Use the back-door `streamBufferMb` — but the
      // unit is MB. Use a fractional value via the public field:
      // streamBufferMb is `number`, accepts fractional.
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
        // 8 KB cap so each ~5 KB chunk takes us over fast.
        streamBufferMb: 8 / 1024,
      };
      // 4 chunks of ~5 KB each (20 KB total > 8 KB cap).
      const filler = "a".repeat(5000);
      const chunks: string[] = [];
      for (let i = 0; i < 4; i++) {
        chunks.push(`event: chunk_${i}\ndata: ${filler}\n\n`);
      }
      const upstream = makeStreamingResponse(chunks);
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      // Exactly one overflow warn (per-stream throttle).
      const overflowWarns = warnMessages.filter((m) => m.includes("exceeded"));
      expect(overflowWarns.length).toBe(1);
      expect(overflowWarns[0]).toContain("overflow-req");
      expect(overflowWarns[0]).toContain("undercount");

      // Flow file STILL written — overflow does not abort persistence.
      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as {
        response: {
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
          body_truncated: boolean;
          body_summary?: { event_counts: Record<string, number> };
        };
      };
      expect(flow.response.body_kind).toBe("sse");
      // Phase 6: cap-hit → body_truncated:true in the manifest. .res sidecar
      // ends abruptly at the cap byte boundary.
      expect(flow.response.body_truncated).toBe(true);
      // event_counts should reflect ONLY the captured (sub-cap) chunks; we
      // sent 4 distinct event names, but at most 1-2 fit in 8 KB so the
      // map should NOT contain all 4.
      const distinctEvents = Object.keys(
        flow.response.body_summary?.event_counts ?? {},
      );
      expect(distinctEvents.length).toBeLessThan(4);
      expect(distinctEvents.length).toBeGreaterThan(0);
      // .res sidecar exists and ends at the cap boundary (size matches
      // body_bytes which counts only what fit in the buffer).
      expect(flow.response.body_path).toMatch(/\.res$/);
      const resOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.response.body_path!),
      );
      expect(resOnDisk.byteLength).toBe(flow.response.body_bytes);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 3: upstream mid-stream abort → flow file written with status=502 (upstream_error)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-3-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta({ requestId: "mid-abort-req" });
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
      };
      const upstream = makeAbortingResponse(
        'event: partial\ndata: {"type":"partial"}\n\n',
      );
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as {
        response: {
          status: number;
          body_kind: string;
          body_path: string | null;
          body_summary?: { event_counts: Record<string, number> };
        };
      };
      // upstream_error → status 502.
      expect(flow.response.status).toBe(502);
      // Partial buffer summary still present.
      expect(flow.response.body_kind).toBe("sse");
      expect(flow.response.body_summary?.event_counts["partial"]).toBe(1);
      // .res sidecar exists with the partial bytes.
      expect(flow.response.body_path).toMatch(/\.res$/);
      const resOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.response.body_path!),
        "utf-8",
      );
      expect(resOnDisk).toContain("event: partial");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 4: writer fails (delete tracedir mid-flight) → request drains + error counter ticks + first failure surfaces via consola.warn", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-4-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta({ requestId: "rofs-req" });
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
      };
      const upstream = makeStreamingResponse([
        'event: ping\ndata: {"type":"ping"}\n\n',
      ]);
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();

      // Stub the writer.write to reject with an EACCES-style error so we
      // exercise the failure path independent of platform-specific FS
      // behavior (Windows + chmod rules differ from POSIX). This still
      // routes through emitTraceFlow's catch + bumpTraceWrites + the
      // first-failure throttle.
      const fakeErr = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
      const originalWrite = writer.write.bind(writer);
      writer.write = (async () => {
        throw fakeErr;
      }) as typeof writer.write;

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      // Restore so the afterEach cleanup doesn't trip on us.
      writer.write = originalWrite;

      // Request still drained — captured at least one chunk to client.
      expect(cap.bytes.length).toBeGreaterThan(0);
      // Error counter ticked.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "error",
        }),
      ).toBe(1);
      expect(
        getValueForTests("copilot_proxy_trace_errors_total", {
          kind: "eacces",
        }),
      ).toBe(1);
      // First-failure surfaced via consola.warn (the spec calls for at
      // least one — the throttle test is implicit: the metric counter
      // ticks once but never produces multiple warn lines; that's
      // covered by the trace_metrics suite which fires multiple errors).
      const failureWarns = warnMessages.filter((m) =>
        m.includes("first write failure"),
      );
      expect(failureWarns.length).toBe(1);
      expect(failureWarns[0]).toContain("rofs-req");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 5: client abort mid-stream → flow file written with status=499 (client_abort)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-5-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta({ requestId: "client-abort-req" });
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
      };
      // We trigger the abort AFTER the first chunk is observably delivered.
      // `deriveUpstreamSignal` deliberately filters pre-aborted signals (to
      // work around the srvx + Node v24 false-pre-abort bug) — so a signal
      // already aborted at handler-entry is treated as NOT aborted. We
      // need a real mid-stream abort.
      const abortController = new AbortController();
      const c = makeFakeContext(abortController.signal);
      const enc = new TextEncoder();
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              enc.encode('event: first\ndata: {"type":"first"}\n\n'),
            );
          },
          pull(controller): void {
            // After the consumer has pulled the first chunk, fire the
            // client-side abort. The abort listener inside forwardStream
            // (registered through deriveUpstreamSignal) cancels the reader
            // → next read resolves done:true → loop exits → outer finally
            // sees outcome="client_abort".
            abortController.abort();
            // Enqueue a chunk that we expect to NEVER be delivered (the
            // cancel happens first). Defensive: keep the controller alive
            // long enough to be cancelled.
            controller.enqueue(
              enc.encode('event: never\ndata: {"type":"never"}\n\n'),
            );
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
      const cap = makeFakeStreamApi();

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as { response: { status: number } };
      expect(flow.response.status).toBe(499);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 6: traceWriter/traceMeta absent → no flow file written + trace counters NOT bumped", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-6-"));
    try {
      // No writer, no meta on ctxBase — exercising the legacy passthrough.
      const ctxBase: StreamCtxBase = { ...CTX_BASE_DEFAULT };
      const upstream = makeStreamingResponse([
        'event: a\ndata: {"type":"a"}\n\n',
      ]);
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();

      await forwardStream(c, upstream, ctxBase)(cap.api);
      await waitForTraceFlush();

      // No flow file under tempDir (no traces-* subdir created at all
      // because the writer was never invoked).
      const entries = await readdir(tempDir);
      const traceSubdirs = entries.filter((n) => n.startsWith("traces-"));
      expect(traceSubdirs.length).toBe(0);

      // Trace counters not touched — `getValueForTests` returns undefined
      // when the series has not been incremented.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBeUndefined();
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "error",
        }),
      ).toBeUndefined();
      // Existing forward-stream behavior unchanged: client got the chunk.
      expect(cap.bytes.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5 v3.1 follow-up — full handler→middleware→forwarder integration
// regression gate for the streaming-flow inbound-body propagation bug.
//
// **The bug.** Pre-fix, each handler called `c.set("inboundBody", bytes)`
// after parsing the body. The non-streaming trace path read it back via
// `c.get("inboundBody")` and worked. The streaming path consumed a snapshot
// `TraceMeta` (built by `with-trace.ts` BEFORE the handler ran with
// `inboundBody: null` as a placeholder) and never refreshed it from
// `c.get`. Result: every streaming flow file showed
// `request.body_kind: "empty"` even when a real JSON body was POSTed.
//
// **Why this test belongs in trace_streaming.test.ts.** The existing six
// forwarder-isolation tests above all pre-built a TraceMeta with
// `inboundBody` populated and threaded it directly into `forwardStream` —
// they could never have caught the handler-side propagation gap. The
// regression gate must exercise the full handler path (req → withTrace
// middleware → handler → stash helper → forwardStream) so the meta
// mutation in `stash-inbound-body.ts` is the link that closes the bug.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installStubFetch(responder: (call: FetchCall) => Response): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const call: FetchCall = { url: input.toString(), init };
    calls.push(call);
    return responder(call);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

async function makeReadyTokenManager(): Promise<{
  tm: TokenManager;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "trace-streaming-tm-"));
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "stub-copilot-token",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await tm.start();
  return {
    tm,
    cleanup: async () => {
      tm.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function configLane1Native(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        body_rules: [],
        header_rules: [],
        response_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

async function findOnlyFlowFileIntegration(tempDir: string): Promise<string> {
  const entries = await readdir(tempDir);
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) {
    throw new Error(`no traces-YYYY-MM-DD subdir under ${tempDir}`);
  }
  const flowsDir = path.join(tempDir, traceDir, "flows");
  const flowFiles = (await readdir(flowsDir)).filter((n) =>
    n.endsWith(".json"),
  );
  if (flowFiles.length !== 1) {
    throw new Error(
      `expected 1 manifest file, found ${flowFiles.length}: ${flowFiles.join(", ")}`,
    );
  }
  return path.join(flowsDir, flowFiles[0]!);
}

describe("forwardStream — Phase 5 v3.1 follow-up streaming-body capture (integration)", () => {
  it("test 7 (regression gate): streaming POST /v1/messages flow file has request.body_kind=json AND request.body deep-equals sent payload AND response.body.kind=sse", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-streaming-7-"));
    // Stub fetch returns a small SSE stream so isStreamingResponse trips
    // the streaming forwarder path (not the non-streaming write path).
    const stub = installStubFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          const enc = new TextEncoder();
          controller.enqueue(
            enc.encode(
              'event: message_start\ndata: {"type":"message_start"}\n\n',
            ),
          );
          controller.enqueue(
            enc.encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
            ),
          );
          controller.enqueue(
            enc.encode(
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);

      // Non-trivial body so an "empty" capture would be unambiguously wrong.
      const sentBody = {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: 50,
      };
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(r.status).toBe(200);
      // Drain the stream so the forwarder's finally fires + trace is written.
      await r.text();
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFileIntegration(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as {
        request: {
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
        };
        response: {
          body_kind: string;
          body_path: string | null;
          body_summary?: { event_counts?: Record<string, number> };
        };
      };

      // === Regression assertions ===
      // Pre-fix these were `body_kind === "empty"` + body_bytes === 0.
      expect(flow.request.body_kind).toBe("json");
      // Phase 6 anti-pattern guard (F36/F49/F51): walk the .req sidecar and
      // deep-equal the parsed body to catch any case where the file is
      // missing, empty, or otherwise non-faithful.
      expect(flow.request.body_path).toMatch(/\.req$/);
      const reqOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.request.body_path!),
      );
      expect(JSON.parse(reqOnDisk.toString("utf-8"))).toEqual(sentBody);
      expect(flow.request.body_bytes).toBe(reqOnDisk.byteLength);

      // Confirm we exercised the streaming code path (and not the
      // non-streaming one which already worked pre-fix). body_kind=sse +
      // non-empty event_counts proves the flow came from the streaming
      // forwarder's emitTraceFlow, not from with-trace.ts's after-handler
      // path.
      expect(flow.response.body_kind).toBe("sse");
      const counts = flow.response.body_summary?.event_counts ?? {};
      expect(Object.keys(counts).length).toBeGreaterThan(0);
      expect(counts["message_start"]).toBe(1);
      expect(counts["content_block_delta"]).toBe(1);
      expect(counts["message_stop"]).toBe(1);

      // Phase 6 SSE regression gate: .res sidecar holds raw bytes (no JSON
      // wrapping, no `\"` escape sequences).
      expect(flow.response.body_path).toMatch(/\.res$/);
      const resOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.response.body_path!),
        "utf-8",
      );
      expect(resOnDisk.startsWith("event: ")).toBe(true);
      expect(resOnDisk).not.toContain('\\"');
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
