/**
 * forward_stream_translated.test.ts — integration test for
 * `src/routes/_shared/forward-stream.ts § forwardStreamTranslated` (M10
 * D-LOCK-4).
 *
 * Covers all 7 cases enumerated in the spec § D-LOCK-4 § Test coverage:
 *   1. Identity passthrough (no-op rule emits original event) → output
 *      events shape-equal to input events.
 *   2. Translator path (a rule that maps `event.type === "msg"` → two
 *      output events) → multi-event emission per single input event.
 *   3. Empty-body upstream → no-op (`Promise<void>` resolves cleanly).
 *   4. Mid-stream client abort → reader cancelled + state released
 *      (`_streamStateCount() === 0` post-abort).
 *   5. Final-flush partial-event-dropped → the partial is dropped (debug log
 *      `"sse-codec: partial-event-dropped"` fires) + M1 surfaces the
 *      truncation as an injected `error` event.
 *   6. Multi-event chunk: single `reader.read()` returns 2 SSE events →
 *      both events flow through applyEvent + are emitted.
 *   7. Cross-chunk-boundary event: SSE event split across 3
 *      `reader.read()` calls → decoder buffer reassembles + emits once.
 *
 * **Mechanism.** Each test calls `forwardStreamTranslated(c, upstream,
 * rules, snap, requestId, ctxBase)(stream)` directly with a fake `Context`
 * (carrying an AbortSignal so abort tests can fire) and a fake
 * `SSEStreamingApi` (capturing writes into a buffer). The mock upstream
 * `Response` body is a `ReadableStream<Uint8Array>` constructed from the
 * test's chunk plan, mirroring `mid_stream_error.test.ts:61-79`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";
import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { z } from "zod";

import { LEVEL_ON, debug } from "../../src/lib/debug.ts";
import {
  registerStreamEvent,
  reset as resetRegistry,
  snapshot as registrySnapshot,
} from "../../src/lib/transform/registry.ts";
import {
  _resetStreamStates,
  _streamStateCount,
} from "../../src/lib/transform/sse-state.ts";
import type { AnyEvent } from "../../src/lib/transform/types.ts";
import {
  forwardStreamTranslated,
  type StreamCtxBase,
} from "../../src/routes/_shared/forward-stream.ts";

// ---- consola.debug capture ----------------------------------------------

let capturedDebugMessages: string[] = [];
let originalDebugFn: typeof consola.debug;

beforeEach(() => {
  debug.setLevel(LEVEL_ON);
  capturedDebugMessages = [];
  originalDebugFn = consola.debug;
  consola.debug = ((msg: unknown): void => {
    capturedDebugMessages.push(typeof msg === "string" ? msg : String(msg));
  }) as typeof consola.debug;
  // Each test gets a fresh state map so leak/release assertions are
  // independent of test ordering.
  _resetStreamStates();
});

afterEach(() => {
  consola.debug = originalDebugFn;
  debug.setLevel(LEVEL_ON);
  _resetStreamStates();
});

// ---- Test fixtures: fake Context + fake SSEStreamingApi -----------------

function makeFakeContext(signal?: AbortSignal): Context {
  const abortController = new AbortController();
  const sig = signal ?? abortController.signal;
  // Minimal stub satisfying the surface forwardStreamTranslated touches.
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
  setAborted(): void;
}

function makeFakeStreamApi(): FakeStreamCapture {
  const bytes: Uint8Array[] = [];
  let aborted = false;
  const api = {
    aborted,
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
      aborted = true;
      // also flip the field so forwardStreamTranslated's `stream.aborted`
      // check sees true on the next loop iteration.
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
    setAborted(): void {
      (api as unknown as { aborted: boolean }).aborted = true;
    },
  };
}

function makeStreamingResponse(
  chunks: Array<Uint8Array | string>,
  options?: { delayMs?: number; afterChunkCb?: (i: number) => Promise<void> },
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const u8 = typeof c === "string" ? enc.encode(c) : c;
        controller.enqueue(u8);
        if (options?.delayMs !== undefined && options.delayMs > 0) {
          await new Promise((r) => setTimeout(r, options.delayMs));
        }
        if (options?.afterChunkCb) await options.afterChunkCb(i);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CTX_BASE: StreamCtxBase = {
  route: "/v1/messages",
  model: "test-model",
  // M12.5 H1: clean Prometheus label distinct from `route` (path).
  metricRoute: "messages",
};

// ---- Rule-registration helpers ------------------------------------------

function registerNoopRule(): void {
  // A no-op stream-event rule that emits the original event back unchanged
  // (identity passthrough explicit fire — distinct from the engine's
  // default-passthrough on no-rule-fires which also emits the original).
  registerStreamEvent(
    "test_noop_passthrough",
    (ctx) => ({
      events_out: [ctx.event],
      applied: true,
    }),
    z.unknown(),
    { allow_override: true },
  );
}

function registerDoubleRule(): void {
  // Maps a single input event with type === "msg" to TWO output events
  // (a "msg.translated" and a "msg.echo"). Tests the "translator path"
  // case 2 — emit count differs from input count.
  registerStreamEvent(
    "test_double_emit",
    (ctx) => {
      if (ctx.event.type === "msg") {
        return {
          events_out: [
            { type: "msg.translated", payload: ctx.event["payload"] },
            { type: "msg.echo", payload: ctx.event["payload"] },
          ],
          applied: true,
        };
      }
      return { events_out: [ctx.event], applied: true };
    },
    z.unknown(),
    { allow_override: true },
  );
}

// ---- Helpers to extract emitted events from captured bytes --------------

function decodeWire(bytes: Uint8Array[]): AnyEvent[] {
  // Concatenate then re-decode using the same codec the encoder uses.
  // Using TextDecoder + manual SSE split (avoids importing sse-codec —
  // independent verification).
  let total = 0;
  for (const b of bytes) total += b.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const b of bytes) {
    merged.set(b, off);
    off += b.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  const events: AnyEvent[] = [];
  for (const segment of text.split(/\r?\n\r?\n/)) {
    if (segment.length === 0) continue;
    const dataLines: string[] = [];
    for (const line of segment.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as AnyEvent);
    } catch {
      // skip malformed
    }
  }
  return events;
}

// ---- Tests --------------------------------------------------------------

describe("forwardStreamTranslated (M10 D-LOCK-4)", () => {
  // ---- 1. Identity passthrough -----------------------------------------

  it("(1) identity passthrough — no-op rule emits original events", async () => {
    registerNoopRule();
    const upstream = makeStreamingResponse([
      `event: a\ndata: {"type":"a","i":0}\n\n`,
      `event: b\ndata: {"type":"b","i":1}\n\n`,
    ]);
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const requestId = "rid-identity";
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      requestId,
      CTX_BASE,
    );
    await handler(stream.api);
    const events = decodeWire(stream.bytes);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("a");
    expect((events[0] as unknown as { i: number }).i).toBe(0);
    expect(events[1]?.type).toBe("b");
    expect((events[1] as unknown as { i: number }).i).toBe(1);
    // State released in finally.
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 2. Translator path ----------------------------------------------

  it("(2) translator path — single input event emits N output events", async () => {
    registerDoubleRule();
    const upstream = makeStreamingResponse([
      `event: msg\ndata: {"type":"msg","payload":"hello"}\n\n`,
    ]);
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "double", use: "test_double_emit" }],
      snap,
      "rid-translator",
      CTX_BASE,
    );
    await handler(stream.api);
    const events = decodeWire(stream.bytes);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("msg.translated");
    expect((events[0] as unknown as { payload: string }).payload).toBe("hello");
    expect(events[1]?.type).toBe("msg.echo");
    expect((events[1] as unknown as { payload: string }).payload).toBe("hello");
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 3. Empty-body upstream ------------------------------------------

  it("(3) empty-body upstream → no-op resolution", async () => {
    registerNoopRule();
    const upstream = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      "rid-empty",
      CTX_BASE,
    );
    await handler(stream.api);
    expect(stream.bytes.length).toBe(0);
    // Note: empty body returns BEFORE acquireStreamState is called, so
    // no state to release. _streamStateCount stays 0.
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 4. Mid-stream client abort --------------------------------------

  it("(4) mid-stream client abort → reader cancelled + state released", async () => {
    registerNoopRule();
    const abortController = new AbortController();
    let firstChunkSeen = false;
    const upstream = makeStreamingResponse(
      [
        `event: a\ndata: {"type":"a"}\n\n`,
        `event: b\ndata: {"type":"b"}\n\n`,
        `event: c\ndata: {"type":"c"}\n\n`,
      ],
      {
        delayMs: 5,
        afterChunkCb: async (i): Promise<void> => {
          if (i === 0) {
            firstChunkSeen = true;
            // Abort right after the first chunk is enqueued.
            abortController.abort();
          }
        },
      },
    );
    const c = makeFakeContext(abortController.signal);
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      "rid-abort",
      CTX_BASE,
    );
    await handler(stream.api);
    expect(firstChunkSeen).toBe(true);
    // State MUST be released even on abort.
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 5. Final-flush partial-event-dropped ----------------------------

  it("(5) final-flush of partial event drops + logs marker + surfaces M1 error frame", async () => {
    registerNoopRule();
    // Send one complete event followed by a partial event (no terminating
    // blank line). The decoder emits the complete event during the chunk loop,
    // then DROPS the partial during the final flush + logs
    // 'sse-codec: partial-event-dropped'. M1 additionally surfaces the
    // truncation as an injected `error` event so the client isn't left with a
    // silent 200 after a mid-event upstream close.
    const upstream = makeStreamingResponse([
      `event: complete\ndata: {"type":"complete"}\n\n`,
      `event: partial\ndata: {"type":"partial"`, // NO `\n\n`
    ]);
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      "rid-flush",
      CTX_BASE,
    );
    await handler(stream.api);
    const events = decodeWire(stream.bytes);
    // Two events on the wire: the complete event + the M1 injected error frame.
    // The dropped partial is NOT emitted as a "partial" event.
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("complete");
    expect(events[1]?.type).toBe("error");
    expect((events[1] as { error?: { type?: string } }).error?.type).toBe(
      "api_error",
    );
    expect(events.some((e) => e.type === "partial")).toBe(false);
    const matched = capturedDebugMessages.some(
      (m) => m === "sse-codec: partial-event-dropped",
    );
    expect(matched).toBe(true);
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 6. Multi-event chunk --------------------------------------------

  it("(6) multi-event chunk → both events flow through applyEvent + emit", async () => {
    registerNoopRule();
    // Single chunk carrying 2 SSE events.
    const upstream = makeStreamingResponse([
      `event: a\ndata: {"type":"a","i":0}\n\nevent: b\ndata: {"type":"b","i":1}\n\n`,
    ]);
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      "rid-multi",
      CTX_BASE,
    );
    await handler(stream.api);
    const events = decodeWire(stream.bytes);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("a");
    expect(events[1]?.type).toBe("b");
    expect(_streamStateCount()).toBe(0);
  });

  // ---- 7. Cross-chunk-boundary event -----------------------------------

  it("(7) cross-chunk-boundary event split across 3 reads → emits exactly once", async () => {
    registerNoopRule();
    const fullEvent = `event: long\ndata: {"type":"long","s":"abcdefghij"}\n\n`;
    const c1 = fullEvent.slice(0, 10);
    const c2 = fullEvent.slice(10, 30);
    const c3 = fullEvent.slice(30);
    const upstream = makeStreamingResponse([c1, c2, c3]);
    const c = makeFakeContext();
    const stream = makeFakeStreamApi();
    const snap = registrySnapshot("stream_event");
    const handler = forwardStreamTranslated(
      c,
      upstream,
      [{ name: "noop", use: "test_noop_passthrough" }],
      snap,
      "rid-cross",
      CTX_BASE,
    );
    await handler(stream.api);
    const events = decodeWire(stream.bytes);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("long");
    expect((events[0] as unknown as { s: string }).s).toBe("abcdefghij");
    expect(_streamStateCount()).toBe(0);
  });

  // ---- F5. Operator log on non-truncation mid-stream failure -----------

  it("(F5) logs consola.error on an upstream mid-stream failure (catch else branch)", async () => {
    registerNoopRule();
    const captured: string[] = [];
    const origError = consola.error;
    consola.error = ((...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(" "));
    }) as typeof consola.error;
    try {
      // Emit one complete event, then error the stream mid-flight (NOT a clean
      // done + NOT a client abort) so the catch `else` (upstream_error) branch
      // fires — the branch F5 added the operator log to.
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(`event: a\ndata: {"type":"a"}\n\n`),
            );
            setTimeout(
              () => controller.error(new Error("upstream socket reset")),
              5,
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      const c = makeFakeContext();
      const stream = makeFakeStreamApi();
      const snap = registrySnapshot("stream_event");
      const handler = forwardStreamTranslated(
        c,
        upstream,
        [{ name: "noop", use: "test_noop_passthrough" }],
        snap,
        "rid-f5",
        CTX_BASE,
      );
      await handler(stream.api);
      expect(
        captured.some((m) => m.includes("upstream mid-stream failure")),
      ).toBe(true);
      // F5 — CTX_BASE has no traceMeta (tracing off), so the pre-F5 log would
      // have printed "<unknown>". The fix logs the `requestId` param ("rid-f5").
      expect(captured.some((m) => m.includes("rid-f5"))).toBe(true);
      expect(captured.some((m) => m.includes("<unknown>"))).toBe(false);
      // Per-stream state still released on the error path.
      expect(_streamStateCount()).toBe(0);
    } finally {
      consola.error = origError;
    }
  });

  // ---- Sanity: unused import shake -------------------------------------

  it("(sanity) test fixture imports are reachable", () => {
    expect(typeof resetRegistry).toBe("function");
  });
});
