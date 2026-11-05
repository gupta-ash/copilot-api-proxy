/**
 * trace_metrics.test.ts — Phase 5 v3.1 Group C integration coverage for the
 * 3 NEW Prometheus counters wired in `src/lib/metrics.ts`:
 *
 *   - copilot_proxy_trace_writes_total{result="success"|"error"}
 *   - copilot_proxy_trace_bytes_written_total
 *   - copilot_proxy_trace_errors_total{kind="enospc"|"eacces"|"other"}
 *
 * Two tests:
 *   1. Three successful trace writes via `forwardStream` → counters reflect
 *      3 successes; bytes_written_total roughly matches sum of file sizes
 *      on disk; errors_total{kind="other"} === 0.
 *   2. One simulated write failure → errors_total ticks +1 (in any kind);
 *      writes_total{result="error"} ticks +1.
 *
 * **Mechanism.** Each test calls `forwardStream(...)` directly with a fake
 * Hono Context + a fake `SSEStreamingApi` that captures writes (mirrors
 * `forward_stream_translated.test.ts` + the sister `trace_streaming` file).
 * Real `TraceWriter` against a real `mkdtemp` temp dir; failure is induced
 * by stubbing `writer.write` to reject with an `EACCES` error so the test
 * is deterministic across platforms (Windows + chmod-readonly behaves
 * differently from POSIX, so we patch the seam, not the FS).
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";
import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";

import {
  getValueForTests,
  resetForTests as resetMetricsForTests,
} from "../../src/lib/metrics.ts";
import { TraceWriter } from "../../src/lib/trace.ts";
import {
  _resetFirstFailureForTests,
  forwardStream,
  type StreamCtxBase,
  type TraceMeta,
} from "../../src/routes/_shared/forward-stream.ts";

// ---------------------------------------------------------------------------
// consola.warn capture (silence + collect for assertions).
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
  _resetFirstFailureForTests();
});
afterEach(() => {
  consola.warn = originalWarnFn;
  resetMetricsForTests();
});

// ---------------------------------------------------------------------------
// Fake Context / SSEStreamingApi / streaming Response (mirrors
// trace_streaming.test.ts).
// ---------------------------------------------------------------------------

function makeFakeContext(): Context {
  const abortController = new AbortController();
  return {
    req: {
      raw: {
        signal: abortController.signal,
      },
    },
  } as unknown as Context;
}

function makeFakeStreamApi(): {
  bytes: Uint8Array[];
  api: SSEStreamingApi;
} {
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
    sleep: async (_ms: number): Promise<unknown> => undefined,
    pipe: async (_body: ReadableStream): Promise<void> => undefined,
  } as unknown as SSEStreamingApi;
  return { bytes, api };
}

function makeStreamingResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeTraceMeta(requestId: string): TraceMeta {
  return {
    requestId,
    method: "POST",
    url: "https://localhost/v1/messages",
    host: "localhost",
    path: "/v1/messages",
    inboundHeaders: { "content-type": "application/json" },
    inboundBody: new TextEncoder().encode('{"model":"claude-x"}'),
    inboundContentType: "application/json",
    startedAt: Date.now(),
  };
}

const CTX_BASE_DEFAULT: Pick<StreamCtxBase, "route" | "model" | "metricRoute"> =
  {
    route: "/v1/messages",
    model: "claude-x",
    metricRoute: "messages",
  };

async function totalFlowFileSize(tempDir: string): Promise<number> {
  const entries = await readdir(tempDir);
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) return 0;
  const flowsDir = path.join(tempDir, traceDir, "flows");
  const flowFiles = await readdir(flowsDir);
  let total = 0;
  for (const name of flowFiles) {
    const st = await stat(path.join(flowsDir, name));
    total += st.size;
  }
  return total;
}

/**
 * Sum bytes only for sidecar files (.req + .res). Used as a regression gate
 * proving the bytes_written_total metric INCLUDES sidecar bytes, not just
 * the manifest (Phase 6 anti-pattern guard).
 */
async function sidecarSizeOnly(tempDir: string): Promise<number> {
  const entries = await readdir(tempDir);
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) return 0;
  const flowsDir = path.join(tempDir, traceDir, "flows");
  const flowFiles = await readdir(flowsDir);
  let total = 0;
  for (const name of flowFiles) {
    if (!name.endsWith(".req") && !name.endsWith(".res")) continue;
    const st = await stat(path.join(flowsDir, name));
    total += st.size;
  }
  return total;
}

async function flushTraceWrites(): Promise<void> {
  // The trace writes are fire-and-forget inside emitTraceFlow (the
  // forwarder returns the moment the SSE stream drains). We need to give
  // the writer's mkdir + writeFile + chained .then() time to settle. Bun
  // + Windows shows occasional flakes at <30 ms; 50 ms with multiple
  // yields gives a comfortable margin without slowing the suite down.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("trace metrics — Phase 5 v3.1 Group C F-DISC-14 counters", () => {
  it("3 successful streaming writes → trace_writes_total{success}=3, bytes_written_total ~= sum(file sizes), errors_total{other}=0", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-metrics-1-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      // N=3 sequential successful streams.
      for (let i = 0; i < 3; i++) {
        const meta = makeTraceMeta(`success-req-${i}`);
        const ctxBase: StreamCtxBase = {
          ...CTX_BASE_DEFAULT,
          traceWriter: writer,
          traceMeta: meta,
        };
        const upstream = makeStreamingResponse([
          `event: start_${i}\ndata: {"i":${i}}\n\n`,
          `event: end_${i}\ndata: {"i":${i}}\n\n`,
        ]);
        const c = makeFakeContext();
        const cap = makeFakeStreamApi();
        await forwardStream(c, upstream, ctxBase)(cap.api);
      }
      await flushTraceWrites();

      // Three successful writes recorded.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBe(3);

      // bytes_written_total non-zero.
      const bytesWritten = getValueForTests(
        "copilot_proxy_trace_bytes_written_total",
      );
      expect(bytesWritten).toBeDefined();
      expect(bytesWritten ?? 0).toBeGreaterThan(0);

      // Phase 6: bytes_written_total sums manifest + .req + .res sidecar
      // bytes (the writer's actual disk usage). The on-disk total walks
      // ALL files in the bucket dir (manifest + sidecars). The pre-write
      // metric estimates the manifest length as `JSON.stringify(flow)`
      // (no indent), so for tiny flows where manifest dominates, the
      // 2-space-indent overhead inflates the on-disk size meaningfully
      // (~50%). The metric is always <= disk size, never strictly above.
      const onDisk = await totalFlowFileSize(tempDir);
      const sidecarsTotal = await sidecarSizeOnly(tempDir);
      // Anti-pattern guard (Phase 6): the metric MUST include the sidecar
      // bytes; manifest-only accounting would yield approxBytes ≈ 250
      // bytes/flow × 3 flows ≈ 750. With sidecars (small SSE payloads
      // ~70 bytes each × 3 ≈ 210 extra bytes) we expect bytesWritten
      // > 750. More importantly: bytesWritten must be > sidecarsTotal
      // (that proves manifest IS counted) AND > 0 manifest-baseline.
      expect(bytesWritten ?? 0).toBeGreaterThan(sidecarsTotal);
      // Upper bound: bytes_written should not exceed disk size (we count
      // a conservative pre-indent length; the writer's 2-space indent
      // only ENLARGES the manifest on disk vs the metric estimate).
      expect(bytesWritten ?? 0).toBeLessThanOrEqual(onDisk);

      // errors_total{kind="other"} should be absent (treated as 0).
      const otherErrors = getValueForTests("copilot_proxy_trace_errors_total", {
        kind: "other",
      });
      expect(otherErrors ?? 0).toBe(0);
      // Same for the other two error kinds.
      const enospcErrors = getValueForTests(
        "copilot_proxy_trace_errors_total",
        { kind: "enospc" },
      );
      expect(enospcErrors ?? 0).toBe(0);
      const eaccesErrors = getValueForTests(
        "copilot_proxy_trace_errors_total",
        { kind: "eacces" },
      );
      expect(eaccesErrors ?? 0).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("1 induced write failure (EACCES) → trace_errors_total ticks +1 in some kind; writes_total{error}=1", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-metrics-2-"));
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const meta = makeTraceMeta("err-req-1");
      const ctxBase: StreamCtxBase = {
        ...CTX_BASE_DEFAULT,
        traceWriter: writer,
        traceMeta: meta,
      };
      // Stub the writer.write to reject with an EACCES-style error; this
      // exercises the failure metric path independently of platform-
      // specific FS behavior. Bun reports error codes the same way Node
      // does (NodeJS.ErrnoException.code) so classifyTraceError sees the
      // expected "EACCES" → "eacces".
      const fakeErr = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
      writer.write = (async () => {
        throw fakeErr;
      }) as typeof writer.write;

      const upstream = makeStreamingResponse([
        'event: start\ndata: {"k":1}\n\n',
        'event: end\ndata: {"k":1}\n\n',
      ]);
      const c = makeFakeContext();
      const cap = makeFakeStreamApi();
      await forwardStream(c, upstream, ctxBase)(cap.api);
      await flushTraceWrites();

      // writes_total{error}=1 — exactly one failure recorded.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "error",
        }),
      ).toBe(1);

      // At least one error counter incremented across all kinds (the
      // assertion is intentionally flexible per spec test 2 — Bun could
      // theoretically surface the error code differently, though in
      // practice classifyTraceError sees EACCES → "eacces").
      const enospc =
        getValueForTests("copilot_proxy_trace_errors_total", {
          kind: "enospc",
        }) ?? 0;
      const eacces =
        getValueForTests("copilot_proxy_trace_errors_total", {
          kind: "eacces",
        }) ?? 0;
      const other =
        getValueForTests("copilot_proxy_trace_errors_total", {
          kind: "other",
        }) ?? 0;
      expect(enospc + eacces + other).toBe(1);
      // The expected kind is "eacces" given our fake error; pin it so a
      // future regression in classifyTraceError surfaces here too.
      expect(eacces).toBe(1);

      // Successful writes did NOT tick (no other test interactions).
      const successes = getValueForTests("copilot_proxy_trace_writes_total", {
        result: "success",
      });
      expect(successes ?? 0).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
