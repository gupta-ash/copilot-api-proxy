/**
 * forward-stream.test.ts — verbatim byte-pass-through SSE forwarder
 * regression coverage (per discriminator iter-1 H1).
 *
 * Coverage:
 *   1. UTF-8 multi-byte char split across two upstream chunks → assembled
 *      correctly client-side (no codepoint truncation; NO re-encode round-trip).
 *   2. Reader cleanup on client abort (mock upstream that never returns;
 *      abort client; assert reader.cancel() was called via the abort
 *      listener).
 *   3. Final flush works (last chunk does not silently truncate).
 *   4. Binary-safe (non-UTF-8 bytes preserved exactly).
 *   5. (M12.5 M2) Empty-chunk boundary bridge: a 3-chunk sequence where
 *      chunk A ends with `\n`, chunk B is empty, chunk C starts with `\n`
 *      MUST count exactly +1 boundary event (the bridge survives the
 *      empty chunk).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import type { FlowRecord, TraceWriter } from "../../../src/lib/trace.ts";
import {
  getValueForTests,
  resetForTests,
  setGauge,
} from "../../../src/lib/metrics.ts";
import {
  EngineAbort500Error,
  EngineAbort502Error,
} from "../../../src/lib/transform/apply.ts";
import {
  registerStreamEvent,
  snapshot as registrySnapshot,
} from "../../../src/lib/transform/registry.ts";
import type { AnyEvent } from "../../../src/lib/transform/types.ts";
import { encodeSseEvent } from "../../../src/lib/sse-codec.ts";
import {
  forwardStream,
  forwardStreamTranslated,
  type StreamCtxBase,
  type TraceMeta,
} from "../../../src/routes/_shared/forward-stream.ts";

/**
 * Build a Response wrapping a ReadableStream that emits the supplied
 * chunks (each a Uint8Array) and then closes. Optionally pause N
 * milliseconds between chunks.
 */
function makeChunkedResponse(chunks: Uint8Array[], pauseMs = 0): Response {
  const body = new ReadableStream({
    async start(controller): Promise<void> {
      for (const c of chunks) {
        controller.enqueue(c);
        if (pauseMs > 0) {
          await new Promise((r) => setTimeout(r, pauseMs));
        }
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Build a Hono app that exposes a single GET /sse endpoint which uses
 * forwardStream to forward the supplied upstream Response. Returns the
 * app + a function that triggers the route.
 *
 * M12 D-LOCK-3: forwardStream now takes a third arg (ctxBase: { route,
 * model, metricRoute }) for per-route metrics labels.
 * M12.5 H1: ctxBase requires `metricRoute` (clean Prometheus label) in
 * addition to `route` (inbound path). Tests pass a stub.
 */
function buildAppFor(upstream: Response): Hono {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStream(c, upstream, {
        route: "/test",
        model: "test-model",
        metricRoute: "test",
      }),
    ),
  );
  return app;
}

describe("forwardStream — UTF-8 byte-exact preservation", () => {
  it("splits a 4-byte emoji across chunk boundaries; client receives intact codepoint", async () => {
    // U+1F4A9 PILE OF POO is 4 bytes in UTF-8: F0 9F 92 A9.
    // Split: chunk 1 = "data: " (ASCII) + first 2 bytes of the emoji;
    //        chunk 2 = last 2 bytes + "\n\n".
    const prefix = new TextEncoder().encode("data: ");
    const emojiBytes = new TextEncoder().encode("\u{1F4A9}"); // F0 9F 92 A9
    expect(emojiBytes.length).toBe(4);
    const suffix = new TextEncoder().encode("\n\n");

    const chunk1 = new Uint8Array(prefix.length + 2);
    chunk1.set(prefix, 0);
    chunk1.set(emojiBytes.slice(0, 2), prefix.length);

    const chunk2 = new Uint8Array(2 + suffix.length);
    chunk2.set(emojiBytes.slice(2), 0);
    chunk2.set(suffix, 2);

    const upstream = makeChunkedResponse([chunk1, chunk2], 5);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);

    // Client decodes the WHOLE response — codepoint must reassemble.
    const text = await resp.text();
    expect(text).toContain("data: \u{1F4A9}\n\n");
  });

  it("binary-safe: non-UTF-8 byte sequence preserved exactly", async () => {
    // 0xFF 0xFE is invalid UTF-8 (lone high bytes); a decode-then-encode
    // round-trip would replace these with U+FFFD REPLACEMENT CHARACTER and
    // re-encode as 0xEF 0xBF 0xBD — a 3-byte expansion that corrupts the
    // wire. Verbatim forwarding preserves the original 2 bytes.
    const lonely = new Uint8Array([0xff, 0xfe, 0x0a, 0x0a]);
    const upstream = makeChunkedResponse([lonely]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    // Read raw bytes and assert byte-exact preservation.
    if (resp.body === null) throw new Error("no body");
    const reader = resp.body.getReader();
    const out: number[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) out.push(...value);
    }
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xfe);
  });
});

describe("forwardStream — final flush", () => {
  it("emits the last chunk in full (no silent truncation at upstream close)", async () => {
    // Three small chunks forming a well-formed SSE stream (terminating `\n\n`).
    // Verbatim forwarder MUST emit every byte we sent — the final-flush bug
    // this guards against dropped the trailing chunk. (A stream that ends
    // WITHOUT `\n\n` is treated as truncated by M1 and gets an injected error
    // frame; that path is covered by the M1 tests below.)
    const chunks = [
      new TextEncoder().encode("a"),
      new TextEncoder().encode("bc"),
      new TextEncoder().encode("d\n\n"),
    ];
    const upstream = makeChunkedResponse(chunks);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    const text = await resp.text();
    expect(text).toBe("abcd\n\n");
  });
});

describe("forwardStream — reader cleanup on client abort", () => {
  it("calls reader.cancel() when the client aborts mid-read", async () => {
    // Construct a ReadableStream whose `pull` never produces data; record
    // whether `cancel` was invoked. Then simulate a client abort by aborting
    // the request signal partway through.
    let cancelCalled = false;
    let resolveCancel: (() => void) | null = null;
    const cancelObserved = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });

    const body = new ReadableStream({
      start(controller): void {
        // Emit one chunk so the read loop enters at least once.
        controller.enqueue(new TextEncoder().encode("first\n\n"));
        // Then stall — never enqueue again, never close.
      },
      cancel(): void {
        cancelCalled = true;
        resolveCancel?.();
      },
    });

    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Build a Hono app and issue a request with an AbortController.
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "test",
        }),
      ),
    );

    const ac = new AbortController();
    const reqPromise = app.request("/sse", { signal: ac.signal });
    const resp = await reqPromise;
    expect(resp.status).toBe(200);

    // Drain the first chunk, then abort.
    if (resp.body === null) throw new Error("no body");
    const reader = resp.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Abort the signal — forwardStream's abort listener calls reader.cancel
    // on the UPSTREAM body's reader. We then wait for the upstream cancel
    // to be observed (bounded timeout to avoid hanging the test).
    ac.abort();

    // Also try to read further — this should resolve to done: true (the
    // forwarder's read loop exits, closing the downstream stream).
    void reader.cancel().catch(() => {
      /* downstream cancel; we only care about upstream cancel signal */
    });

    // Wait up to 500ms for the upstream cancel to fire.
    await Promise.race([
      cancelObserved,
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("upstream cancel not observed within 500ms")),
          500,
        ),
      ),
    ]);
    expect(cancelCalled).toBe(true);
  });
});

describe("forwardStream — M12.5 M2 empty-chunk boundary bridge", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("counts +1 boundary for chunkA='\\n' + chunkB=empty + chunkC='\\n'", async () => {
    // The 3-chunk scenario the M12.5 M2 discriminator finding identified.
    // Pre-fix: empty chunkB resets `boundaryTail` to 0, so the bridge
    // event between chunkA's trailing `\n` and chunkC's leading `\n` is
    // LOST. Post-fix: empty chunk short-circuits the loop body without
    // touching `boundaryTail`, so the bridge fires.
    const chunkA = new Uint8Array([0x61, 0x0a]); // "a\n"
    const chunkB = new Uint8Array(0); // empty
    const chunkC = new Uint8Array([0x0a]); // "\n" — bridges with chunkA's tail AND terminates the stream with \n\n (no M1 truncation frame)

    const upstream = makeChunkedResponse([chunkA, chunkB, chunkC]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    // Drain the stream so forwardStream's read loop completes + finally
    // runs (where post-stream metric writes are visible).
    await resp.text();

    // Expect exactly 1 boundary event (the cross-chunk \n\n bridge).
    expect(
      getValueForTests("copilot_proxy_stream_events_total", {
        route: "test",
      }),
    ).toBe(1);
    // Bytes counted: chunkA (2) + chunkC (1) = 3 (chunkB is empty +
    // short-circuited so no byte counter increment).
    expect(
      getValueForTests("copilot_proxy_response_bytes_total", {
        route: "test",
      }),
    ).toBe(3);
  });

  it("empty trailing chunk does not erase prior chunk's trailing newline", async () => {
    // Sequence: "data: x\n\n" (one full event in chunkA) + empty chunkB +
    // "\nrest" (chunkC). The first event is fully contained in chunkA
    // (single `\n\n` boundary). The empty chunkB must not corrupt
    // accounting.
    //
    // M12.6 M2-NEW: chunkA's `\n\n` pair ends at byteLength-1, so the
    // trailing `\n` was already CONSUMED as the second-of-pair —
    // boundaryTail must be 0 after chunkA, NOT 1. ChunkC's leading `\n`
    // therefore does NOT form a bridge boundary (no false double-count).
    // Total events = 1 (chunkA's internal `\n\n` only).
    //
    // Pre-M12.6 the post-loop assignment unconditionally set
    // boundaryTail=1 here (since value[byteLength-1]==='\n'), causing
    // the bridge to fire wrongly and expected events=2. The M2-NEW
    // discriminator finding identified that as a false positive — the
    // second `\n` cannot belong to two different boundary pairs.
    const enc = new TextEncoder();
    const chunkA = enc.encode("data: x\n\n"); // ends with \n; contains \n\n
    const chunkB = new Uint8Array(0);
    const chunkC = enc.encode("\n"); // leading \n: NOT a bridge post-fix; also terminates the stream with \n\n (no M1 truncation frame)

    const upstream = makeChunkedResponse([chunkA, chunkB, chunkC]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    await resp.text();

    expect(
      getValueForTests("copilot_proxy_stream_events_total", {
        route: "test",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M12.6 H1-NEW — null-body inflight leak fix
//
// Prior to M12.6, both `forwardStream` and `forwardStreamTranslated`
// returned EARLY when `upstream.body === null` BEFORE entering the
// try { ... } finally { recordStreamCompletion(...) } block. The wrapping
// `withMetrics` middleware (M12.5 H2) skips the inflight decrement +
// requests_total for stream Content-Type responses, deferring ownership to
// the forwarder. So a null-body SSE response left the inflight gauge
// permanently incremented (no decrement, no requests_total emission).
//
// The fix: outer try/finally so `recordStreamCompletion` fires regardless
// of the early-return path. These tests simulate the withMetrics-entry
// inflight increment by setting the gauge to 1 BEFORE invoking the
// forwarder, then assert the gauge returns to 0 + requests_total === 1.
// ---------------------------------------------------------------------------

describe("forwardStream — M12.6 H1-NEW null-body inflight leak fix", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("null-body upstream still calls recordStreamCompletion (inflight 1 -> 0)", async () => {
    // Synthesize a Response with body === null (the bug-trigger condition).
    const upstream = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(upstream.body).toBeNull();

    // Simulate withMetrics-entry: inflight=1 for this route.
    setGauge("copilot_proxy_inflight_requests", 1, { route: "nbtest" });

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "nbtest",
        }),
      ),
    );

    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    // Drain so the streamSSE callback runs to completion (the outer
    // finally block fires recordStreamCompletion).
    await resp.text();

    // Inflight gauge MUST be back to 0 (no leak).
    expect(
      getValueForTests("copilot_proxy_inflight_requests", { route: "nbtest" }),
    ).toBe(0);
    // requests_total MUST have been emitted exactly once with status="200".
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "nbtest",
        status: "200",
      }),
    ).toBe(1);
  });
});

describe("forwardStreamTranslated — M12.6 H1-NEW null-body inflight leak fix", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("null-body upstream still calls recordStreamCompletion (inflight 1 -> 0); skips acquireStreamState", async () => {
    const { _streamStateCount, _resetStreamStates } =
      await import("../../../src/lib/transform/sse-state.ts");
    _resetStreamStates();
    const baselineCount = _streamStateCount();

    const upstream = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(upstream.body).toBeNull();

    // Simulate withMetrics-entry: inflight=1.
    setGauge("copilot_proxy_inflight_requests", 1, { route: "nbttest" });

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(c, upstream, [], new Map(), "nbtest-req-id", {
          route: "/test",
          model: "test-model",
          metricRoute: "nbttest",
        }),
      ),
    );

    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await resp.text();

    // Inflight back to 0.
    expect(
      getValueForTests("copilot_proxy_inflight_requests", { route: "nbttest" }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "nbttest",
        status: "200",
      }),
    ).toBe(1);
    // acquireStreamState was NOT called for the null-body path: the
    // stream-state map size is unchanged from baseline.
    expect(_streamStateCount()).toBe(baselineCount);
  });
});

// ---------------------------------------------------------------------------
// M12.6 M1-NEW — recordStreamCompletion outcome parameter
//
// Pre-M12.6, the helper recorded `status="200"` unconditionally even when
// the catch block fired due to a client abort or upstream socket error.
// Post-fix: the catch block sets a closure-scoped `outcome` variable based
// on `c.req.raw.signal.aborted` / `stream.aborted`, and the outer finally
// threads it into `recordStreamCompletion(metricRoute, outcome)`. The
// helper maps:
//   success        -> status="200"
//   client_abort   -> status="499" (Nginx convention)
//   upstream_error -> status="502" (bad gateway)
// ---------------------------------------------------------------------------

describe("forwardStream — M12.6 M1-NEW recordStreamCompletion outcome parameter", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it('clean drain records status="200"', async () => {
    // Single chunk, upstream closes cleanly. No abort, no error.
    const chunks = [new TextEncoder().encode("data: ok\n\n")];
    const upstream = makeChunkedResponse(chunks);

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "ok-route",
        }),
      ),
    );

    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await resp.text();

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "ok-route",
        status: "200",
      }),
    ).toBe(1);
    // No 499 / 502 emitted.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "ok-route",
        status: "499",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "ok-route",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it('upstream error mid-stream records status="502"', async () => {
    // ReadableStream that emits one chunk then errors. forwardStream's
    // reader.read() rejects on the second pull; catch block fires; neither
    // signal is aborted -> outcome = upstream_error.
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        // Defer the error to the next tick so the first chunk gets read +
        // forwarded before the failure surfaces.
        setTimeout(() => {
          controller.error(new Error("upstream socket reset"));
        }, 5);
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "err-route",
        }),
      ),
    );

    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    // Drain — the read loop will hit the controller.error and the outer
    // finally records outcome="upstream_error" -> status="502".
    try {
      await resp.text();
    } catch {
      /* downstream may also surface the error; we only care about metrics */
    }

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "err-route",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "err-route",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it('synthetic catch with pre-aborted inbound signal classifies as upstream_error (status="502")', async () => {
    // Forwarding uses a derived clientSignal
    // (deriveUpstreamSignal-filtered) instead of c.req.raw.signal directly.
    // The filter exists because srvx 0.8.16 + Node v24 spuriously reports
    // c.req.raw.signal.aborted=true at handler-entry on EVERY request, which
    // would otherwise classify every upstream error as client_abort (499).
    //
    // Pre-aborted INBOUND signal is filtered -> clientSignal.aborted=false
    // throughout the request lifetime (unless a REAL late abort fires the
    // listener). The catch-block detection in the catch path therefore sees
    // clientSignal.aborted=false; with stream.aborted=false too, outcome
    // falls through to "upstream_error" -> status="502". This is correct:
    // a pre-aborted signal that we cannot distinguish from srvx-false-positive
    // is treated as not-a-client-abort. The PRIMARY production path for real
    // client aborts (onAbort listener fires LATE -> reader.cancel() ->
    // done:true) is covered by the next test using a real Hono request
    // lifecycle (M12.7 F36-prevention).
    const ac = new AbortController();
    ac.abort();
    const mockCtx = {
      req: { raw: { signal: ac.signal } },
    } as unknown as Parameters<typeof forwardStream>[0];

    const body = new ReadableStream({
      pull(controller): void {
        // Throw on the FIRST pull so reader.read() rejects synchronously
        // (no done:true short-circuit). The catch in forwardStream then
        // sees signal.aborted === true (we pre-aborted above).
        controller.error(new Error("synthetic upstream-error"));
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Mock SSEStreamingApi — only `aborted` and `write` are touched.
    const mockStream = {
      aborted: false,
      write: async (_v: Uint8Array | string): Promise<void> => {
        /* no-op */
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "abort-route",
    });
    await cb(mockStream);

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "abort-route",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "abort-route",
        status: "200",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "abort-route",
        status: "499",
      }),
    ).toBeUndefined();
  });

  it('client abort via real Hono signal pipeline records status="499" (M12.7 F36-prevention)', async () => {
    // M12.7 — PRIMARY production-path coverage. Exercises the actual
    // sequence that fires when a real client closes the connection
    // mid-stream: Hono signal -> onAbort listener -> reader.cancel() ->
    // next reader.read() resolves done:true (NO throw) -> code hits
    // `if (done) return` -> outer finally records outcome.
    //
    // Pre-M12.7 BUG (caught by iter-3 discriminator): the catch block was
    // the ONLY place outcome was set to "client_abort". cancel() resolves
    // cleanly, so catch did NOT fire on real client aborts -> outcome
    // stayed default "success" -> status="200" was recorded instead of
    // "499". M12.7 sets outcome inside onAbort BEFORE cancel.
    //
    // F36 test-masking prevention: this test uses REAL Hono
    // `app.request({ signal })` flow; do NOT replace with a synthetic
    // signal mock or pre-aborted controller paired with a throwing pull.
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
        // Stall — never enqueue again, never close. The forwarder will
        // suspend on the next reader.read() until cancel is invoked.
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "real-abort-route",
        }),
      ),
    );

    const ac = new AbortController();
    const reqPromise = app.request("/sse", { signal: ac.signal });
    const resp = await reqPromise;
    expect(resp.status).toBe(200);
    if (resp.body === null) throw new Error("no body");

    // Drain first chunk to ensure the read loop is suspended on chunk #2.
    const reader = resp.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Trigger the abort: Hono's c.req.raw.signal fires onAbort ->
    // reader.cancel() on upstream -> upstream reader.read() resolves
    // done:true -> `if (done) return` -> outer finally w/ outcome
    // already set to "client_abort" by onAbort.
    ac.abort();
    void reader.cancel().catch(() => {
      /* downstream cancel; we only care about upstream metrics */
    });

    // Give the forwarder a tick to run finally + record metric. Poll
    // briefly to avoid flake on slow CI.
    for (let i = 0; i < 20; i++) {
      const v = getValueForTests("copilot_proxy_requests_total", {
        route: "real-abort-route",
        status: "499",
      });
      if (v === 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Assert: status="499" recorded (the production-path fix).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "real-abort-route",
        status: "499",
      }),
    ).toBe(1);
    // Regression guard — status="200" must NOT be recorded.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "real-abort-route",
        status: "200",
      }),
    ).toBeUndefined();
    // Regression guard — status="502" must NOT be recorded (this is a
    // client-abort, not an upstream error).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "real-abort-route",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it('stream.aborted=true downstream tear-down race records status="499" (M12.7 line-247 guard)', async () => {
    // M12.7 — covers the second outcome-flip site: `if (stream.aborted)
    // return` early-exit at line ~242. This path fires when the
    // downstream SSE writer (streamSSE) marks itself aborted between
    // chunks (race with downstream socket close that beats the inbound
    // signal listener). Pre-M12.7 hit the bare `return` -> outer finally
    // recorded default outcome="success" -> status="200".
    //
    // Use a mock context (no signal aborted) + a mock stream with
    // aborted=true so the read loop bails on the FIRST iteration.
    const mockCtx = {
      req: { raw: { signal: new AbortController().signal } },
    } as unknown as Parameters<typeof forwardStream>[0];

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const mockStream = {
      aborted: true, // ← triggers the line-247 early return
      write: async (_v: Uint8Array | string): Promise<void> => {
        /* no-op */
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "downstream-race-route",
    });
    await cb(mockStream);

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "downstream-race-route",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "downstream-race-route",
        status: "200",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M12.6 M2-NEW — boundaryTail consumed-pair tracking
//
// Pre-M12.6 the post-loop assignment `boundaryTail = value[last]==='\n' ? 1
// : 0` blindly inspected the last byte. When a `\n\n` pair ended at the
// chunk's last position, the trailing `\n` had ALREADY been consumed as
// the second-of-pair — but the pre-fix code still set boundaryTail=1,
// double-counting it as a dangling-tail bridge with the next chunk's
// leading `\n`.
//
// The M2-NEW fix tracks `lastConsumed` inside the loop (and inside the
// bridge case for single-byte chunks). After the loop:
//   if lastConsumed:    boundaryTail = 0
//   else:               boundaryTail = value[last]==='\n' ? 1 : 0
//
// These tests cover the three scenarios the spec calls out:
//   1. consumed-pair tail + next chunk leading `\n`: NO false bridge
//      (the case the existing M12.5 test originally codified the wrong
//      expectation for; that test was updated above).
//   2. dangling-tail `\n` + next chunk leading `\n`: legitimate bridge
//      still works (no regression).
//   3. consumed-pair tail + next chunk own pair: NO false bridge
//      (consumed-pair tail does not contaminate the next chunk's
//      independent boundary).
// ---------------------------------------------------------------------------

describe("forwardStream — M12.6 M2-NEW boundaryTail consumed-pair tracking", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("consumed-pair tail + next chunk own pair counts exactly 2 (no false bridge)", async () => {
    // chunkA = "data: x\n\n" (8 bytes after encoding "data: x\n\n";
    //   actually 9 bytes — the spec says 8 but the literal length is
    //   sizeof("data: x") + 2 = 7+2 = 9. The exact byteLength is
    //   immaterial; the invariant is that chunkA's `\n\n` pair ends at
    //   byteLength-1 so its tail `\n` was consumed.
    // chunkB = "\ndata: y\n\n" — leading `\n` MUST NOT bridge with
    //   chunkA's consumed tail; chunkB's own `\n\n` is a separate pair.
    // Total: 2 events (one in chunkA, one in chunkB).
    const enc = new TextEncoder();
    const chunkA = enc.encode("data: x\n\n");
    const chunkB = enc.encode("\ndata: y\n\n");

    const upstream = makeChunkedResponse([chunkA, chunkB]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await resp.text();

    expect(
      getValueForTests("copilot_proxy_stream_events_total", {
        route: "test",
      }),
    ).toBe(2);
  });

  it("dangling-tail `\\n` + next chunk leading `\\n` still bridges (legitimate case)", async () => {
    // chunkA = "data: x\n" (no full pair — single trailing dangling `\n`;
    //   lastConsumed remains false; boundaryTail = 1).
    // chunkB = "\ndata: y\n\n" (leading `\n` bridges with chunkA's tail
    //   to form one boundary; chunkB's own `\n\n` is a SECOND boundary).
    // Total: 2 events (bridge + chunkB internal pair).
    const enc = new TextEncoder();
    const chunkA = enc.encode("data: x\n");
    const chunkB = enc.encode("\ndata: y\n\n");

    const upstream = makeChunkedResponse([chunkA, chunkB]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await resp.text();

    expect(
      getValueForTests("copilot_proxy_stream_events_total", {
        route: "test",
      }),
    ).toBe(2);
  });

  it("consumed-pair tail + next chunk = `\\n\\n` counts exactly 2 (double-pair, no false bridge)", async () => {
    // chunkA = "data: x\n\n" (consumed-pair tail; boundaryTail=0 post-fix).
    // chunkB = "\n\n" (own internal pair only; leading `\n` would have
    //   been a bridge under the buggy pre-fix code, inflating to 3).
    // Total: 2 events (one per chunk).
    const enc = new TextEncoder();
    const chunkA = enc.encode("data: x\n\n");
    const chunkB = new Uint8Array([0x0a, 0x0a]); // "\n\n"

    const upstream = makeChunkedResponse([chunkA, chunkB]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await resp.text();

    expect(
      getValueForTests("copilot_proxy_stream_events_total", {
        route: "test",
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// M12.8 — abort-race + cancel-leak regression coverage (post-exec disc iter-4
// HIGH-1 + HIGH-2).
//
// HIGH-1 (already-aborted signal race): WHATWG AbortSignal does NOT replay
// past aborts to late listeners. If the client's signal was already aborted
// BEFORE forwardStream registers its `addEventListener("abort", onAbort)`,
// onAbort never fires; the loop parks at `await reader.read()` indefinitely
// (stalled upstream + no further chunks → indefinite hang + leaked upstream
// connection + leaked inflight gauge). The fix: synchronous
// `if (c.req.raw.signal.aborted) onAbort();` immediately after addEventListener
// in BOTH forwarders.
//
// HIGH-2 (stream.aborted cancel-leak): the `if (stream.aborted) return;`
// early-exit branches set outcome="client_abort" but do NOT call
// `reader.cancel()`. The outer finally only does `reader.releaseLock()` —
// which does NOT cancel the underlying ReadableStream or abort the upstream
// fetch body. The connection leaks until GC. The fix: explicit
// `void reader.cancel().catch(() => {})` BEFORE return in BOTH forwarders.
// ---------------------------------------------------------------------------

describe("forwardStream — M12.8 HIGH-1 already-aborted signal race", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("pre-aborted inbound signal is filtered; request completes normally (status=200)", async () => {
    // deriveUpstreamSignal filters spurious
    // pre-aborted signals from srvx + Node v24. Pre-aborted inbound signal
    // -> clientSignal.aborted=false at registration -> M12.8 H1 sync-check
    // does NOT fire onAbort (correctly, because the inbound abort is
    // assumed to be a srvx false-positive that we cannot distinguish from
    // a true pre-abort). Read loop proceeds normally -> request completes
    // with status="200" instead of hanging or recording "499".
    //
    // Original M12.8 H1 intent: prevent stream HANG on WHATWG-no-replay
    // pre-aborted signal. New architecture preserves that intent via a
    // different mechanism: filter ignores the pre-abort entirely so the
    // read loop never stalls. Upstream stream below now closes after one
    // chunk (no longer hangs forever) so we can assert clean completion.
    const ac = new AbortController();
    ac.abort(); // ABORT BEFORE the request (now filtered)

    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: x\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/test",
          model: "test-model",
          metricRoute: "pre-abort-route",
        }),
      ),
    );

    // Race the request against a 1s timeout. Without the fix, the request
    // would hang indefinitely; the timeout would win and the assertions
    // below would fail (status="499" never recorded).
    //
    // NOTE: Hono's `app.request` may throw synchronously OR return a
    // pre-rejected promise when the signal is already aborted (depends on
    // adapter). Wrap in an async IIFE so either failure mode flows into the
    // race as a "rejected" outcome rather than a synchronous throw escaping
    // the test. Either resolution is fine — the contract being tested is
    // "no hang"; the metric assertion below proves the forwarder reached
    // its outer finally with outcome=client_abort.
    const reqPromise = (async () =>
      app.request("/sse", { signal: ac.signal }))();
    const winner = await Promise.race([
      reqPromise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 1000)),
    ]);

    // PRIMARY assertion: request did NOT hang for >1s. Either resolution
    // path (resolved or rejected) is acceptable; a hung promise produces
    // "timeout" which fails the regression contract.
    // PRIMARY assertion: request did NOT hang. Either resolved or rejected
    // (depending on adapter behavior with pre-aborted signal at request layer).
    expect(["resolved", "rejected"]).toContain(winner);

    // Poll briefly for status=200 (proves filter let the loop complete
    // normally rather than spuriously cancelling).
    for (let i = 0; i < 20; i++) {
      const v = getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-route",
        status: "200",
      });
      if (v === 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // SECONDARY assertion: status="200" recorded (proves filter ignored
    // the spurious pre-abort and the read loop drained cleanly).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-route",
        status: "200",
      }),
    ).toBe(1);

    // Regression guard — status="499" must NOT be recorded (that would mean
    // the filter failed and the spurious pre-abort was honored).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-route",
        status: "499",
      }),
    ).toBeUndefined();
  });

  it("translated: pre-aborted inbound signal is filtered; request completes normally (status=200)", async () => {
    // A pre-aborted inbound signal is filtered symmetrically on this path.
    const ac = new AbortController();
    ac.abort();

    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: x\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          upstream,
          [],
          new Map(),
          "high1-translated-req-id",
          {
            route: "/test",
            model: "test-model",
            metricRoute: "pre-abort-translated-route",
          },
        ),
      ),
    );

    const reqPromise = (async () =>
      app.request("/sse", { signal: ac.signal }))();
    const winner = await Promise.race([
      reqPromise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 1000)),
    ]);

    expect(["resolved", "rejected"]).toContain(winner);

    for (let i = 0; i < 20; i++) {
      const v = getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-translated-route",
        status: "200",
      });
      if (v === 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-translated-route",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "pre-abort-translated-route",
        status: "499",
      }),
    ).toBeUndefined();
  });
});

describe("forwardStream — M12.8 HIGH-2 stream.aborted cancel-leak", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("HIGH-2: stream.aborted=true early-exit calls reader.cancel() (upstream cancel propagates, not GC-deferred)", async () => {
    // Spy via the underlying ReadableStream's `cancel` callback. When
    // forwardStream calls `reader.cancel()` (M12.8 HIGH-2 fix), the call
    // propagates to the underlying source's `cancel` method — that's how
    // we observe it without monkey-patching the Reader instance.
    let upstreamCancelled = false;
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel(): void {
        upstreamCancelled = true;
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Mock context with non-aborted signal so the early-exit branch is
    // reached via stream.aborted=true (not via signal.aborted).
    const mockCtx = {
      req: { raw: { signal: new AbortController().signal } },
    } as unknown as Parameters<typeof forwardStream>[0];

    // Mock SSEStreamingApi with aborted=true so the read loop bails on
    // the FIRST iteration into the line-253 stream.aborted branch.
    const mockStream = {
      aborted: true,
      write: async (_v: Uint8Array | string): Promise<void> => {
        /* no-op */
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "high2-cancel-route",
    });
    await cb(mockStream);

    // PRIMARY assertion: the underlying source's `cancel` fired, proving
    // forwardStream called `reader.cancel()` BEFORE return. Without the
    // M12.8 HIGH-2 fix, only `reader.releaseLock()` fires in the outer
    // finally — releaseLock does NOT propagate cancel; upstreamCancelled
    // would remain false (the connection would leak until GC).
    expect(upstreamCancelled).toBe(true);

    // SECONDARY assertion: status="499" still recorded (M12.7 line-247
    // outcome flip stays intact; HIGH-2 only adds the cancel call).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "high2-cancel-route",
        status: "499",
      }),
    ).toBe(1);
  });

  it("HIGH-2 (translated): stream.aborted=true early-exit calls reader.cancel()", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel(): void {
        upstreamCancelled = true;
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const mockCtx = {
      req: { raw: { signal: new AbortController().signal } },
    } as unknown as Parameters<typeof forwardStreamTranslated>[0];

    const mockStream = {
      aborted: true,
      write: async (_v: Uint8Array | string): Promise<void> => {
        /* no-op */
      },
    } as unknown as Parameters<
      Awaited<ReturnType<typeof forwardStreamTranslated>>
    >[0];

    const cb = forwardStreamTranslated(
      mockCtx,
      upstream,
      [],
      new Map(),
      "high2-translated-req-id",
      {
        route: "/test",
        model: "test-model",
        metricRoute: "high2-cancel-translated-route",
      },
    );
    await cb(mockStream);

    expect(upstreamCancelled).toBe(true);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "high2-cancel-translated-route",
        status: "499",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B3 / B4 — mid-stream upstream failure surfaced as an Anthropic SSE `error`
// event (BOTH forwarders). Previously a mid-stream upstream error closed the
// client stream silently (client saw a truncated response with no signal that
// the upstream had failed). Now the forwarder writes a terminal
// `event: error` frame with `error.type: "api_error"` so Claude Code's SDK
// surfaces the real cause. NEVER emitted on client_abort (nothing to surface
// to, and the client already knows it disconnected).
// ---------------------------------------------------------------------------

/**
 * Upstream Response that emits one SSE event, then fails its stream on the
 * NEXT read (mimicking a mid-stream socket reset). The 5ms defer guarantees
 * the first chunk is forwarded before the failure surfaces.
 */
function makeErroringResponse(): Response {
  const body = new ReadableStream({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      setTimeout(() => controller.error(new Error("upstream socket reset")), 5);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Upstream Response that emits a PARTIAL SSE event (an `event:`/`data:` prefix
 * with NO terminating `\n\n`), then fails on the next read. This is the H1
 * scenario: the injected `event: error` frame must survive the dangling
 * partial — its leading blank-line boundary (`\n\n`) closes the partial on the
 * wire so the error frame parses as its own SSE event instead of being glued
 * onto the partial's `data:` line.
 */
function makePartialThenErrorResponse(): Response {
  const body = new ReadableStream({
    start(controller): void {
      // Partial event: header + start of a `data:` JSON object, no `\n\n`.
      controller.enqueue(
        new TextEncoder().encode('event: message_delta\ndata: {"par'),
      );
      setTimeout(() => controller.error(new Error("upstream socket reset")), 5);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Split a client SSE byte string on `\n\n` event boundaries and return the
 * first frame whose `data:` line parses as a JSON object matching the injected
 * Anthropic error shape (`{type:"error", error:{type:"api_error"}}`), or null.
 * A `.toContain` substring check is INSUFFICIENT for H1 — it would pass even if
 * the error frame merged into a dangling partial's `data:` line. Parsing on
 * `\n\n` boundaries is what proves the frame is a standalone, well-formed event.
 */
function findParsedErrorFrame(
  text: string,
): { type?: string; error?: { type?: string; message?: string } } | null {
  for (const frame of text.split("\n\n")) {
    if (frame.trim().length === 0) continue;
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice("data:".length).trim());
    } catch {
      continue; // partial / non-JSON segment — not our clean error frame
    }
    if (parsed !== null && typeof parsed === "object") {
      const p = parsed as { type?: string; error?: { type?: string } };
      if (p.type === "error" && p.error?.type === "api_error") return p;
    }
  }
  return null;
}

/**
 * Drain a client Response body to a string, tolerating a mid-stream close.
 * Returns everything the forwarder wrote before the stream ended.
 */
async function collectClientBytes(resp: Response): Promise<string> {
  if (resp.body === null) return "";
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) out += dec.decode(value, { stream: true });
    }
  } catch {
    /* mid-stream close is acceptable — return what we captured */
  }
  out += dec.decode();
  return out;
}

describe("forwardStream / forwardStreamTranslated — B3/B4 mid-stream error frame", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("forwardStream error frame survives a dangling partial upstream event (H1 parse-boundary)", async () => {
    // Upstream emits a PARTIAL event (no terminating `\n\n`) then throws. The
    // injected error frame must be its OWN parseable SSE event — proven by
    // splitting client bytes on `\n\n` and JSON-parsing the frame. Without the
    // H1 leading `\n\n`, the error frame glues onto the partial's `data:` line
    // and NO frame parses as clean error JSON (this test would then fail).
    const app = buildAppFor(makePartialThenErrorResponse());
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    // Substring sanity — necessary but NOT sufficient.
    expect(text).toContain("event: error");
    // Parse-boundary proof: a standalone frame parses to the Anthropic error.
    const errorFrame = findParsedErrorFrame(text);
    expect(errorFrame).not.toBeNull();
    expect(errorFrame?.type).toBe("error");
    expect(errorFrame?.error?.type).toBe("api_error");
    // The dangling partial's data prefix is still on the wire, but as its OWN
    // (unparseable) segment — the error frame did NOT merge into it.
    expect(text).toContain('data: {"par');
  });

  it("forwardStreamTranslated surfaces an upstream mid-stream failure as an SSE error frame (client not aborted)", async () => {
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeErroringResponse(),
          [],
          new Map(),
          "err-frame-translated-req",
          {
            route: "/test",
            model: "test-model",
            metricRoute: "test",
          },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"type":"api_error"');
  });

  it("forwardStream does NOT emit an error frame on client abort (clientSignal aborted)", async () => {
    // Build the callback FIRST so deriveUpstreamSignal registers its listener
    // on a not-yet-aborted inbound signal, THEN abort — the late abort
    // propagates through the filter so clientSignal.aborted === true
    // (a pre-abort would instead be FILTERED to false).
    const ac = new AbortController();
    const mockCtx = {
      req: { raw: { signal: ac.signal } },
    } as unknown as Parameters<typeof forwardStream>[0];

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
        // stall — never close; the abort drives teardown.
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const writes: string[] = [];
    const dec = new TextDecoder();
    const mockStream = {
      aborted: false,
      write: async (v: Uint8Array | string): Promise<void> => {
        writes.push(typeof v === "string" ? v : dec.decode(v));
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "noframe-abort-route",
    });
    ac.abort();
    await cb(mockStream);

    expect(writes.join("")).not.toContain("event: error");
    // Sanity: classified as a client abort (499), not an upstream error (502).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "noframe-abort-route",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "noframe-abort-route",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("forwardStreamTranslated does NOT emit an error frame on client abort (clientSignal aborted)", async () => {
    const ac = new AbortController();
    const mockCtx = {
      req: { raw: { signal: ac.signal } },
    } as unknown as Parameters<typeof forwardStreamTranslated>[0];

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const writes: string[] = [];
    const dec = new TextDecoder();
    const mockStream = {
      aborted: false,
      write: async (v: Uint8Array | string): Promise<void> => {
        writes.push(typeof v === "string" ? v : dec.decode(v));
      },
    } as unknown as Parameters<
      Awaited<ReturnType<typeof forwardStreamTranslated>>
    >[0];

    const cb = forwardStreamTranslated(
      mockCtx,
      upstream,
      [],
      new Map(),
      "noframe-abort-translated-req",
      {
        route: "/test",
        model: "test-model",
        metricRoute: "noframe-abort-translated-route",
      },
    );
    ac.abort();
    await cb(mockStream);

    expect(writes.join("")).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "noframe-abort-translated-route",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "noframe-abort-translated-route",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M1 — clean-EOF truncation detection (verbatim path). A stream that ends with
// done:true (NO throw) but whose final bytes are NOT a complete blank-line
// event boundary means the upstream closed mid-event. The forwarder injects an
// `event: error` frame (surfacing the truncation) and records
// outcome=upstream_error (status 502) instead of a silent 200. The control
// cases (LF `\n\n` + CRLF `\r\n\r\n`) MUST NOT trip the detector.
// ---------------------------------------------------------------------------

describe("forwardStream — M1 clean-EOF truncation detection", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("clean EOF mid-event (no terminating \\n\\n) surfaces an error frame + status 502", async () => {
    // A complete-looking event but WITHOUT the terminating `\n\n`, then a clean
    // close (done:true, NO throw). M1 detects the missing final boundary.
    const app = buildAppFor(
      makeChunkedResponse([
        new TextEncoder().encode("data: partial-no-boundary"),
      ]),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    const errorFrame = findParsedErrorFrame(text);
    expect(errorFrame).not.toBeNull();
    expect(errorFrame?.error?.type).toBe("api_error");
    // outcome flipped success -> upstream_error -> requests_total status="502".
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("control: a well-formed stream ending in \\n\\n emits NO error frame (status 200)", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: complete\n\n")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("CRLF control: a stream ending in \\r\\n\\r\\n emits NO error frame (CRLF boundary tolerated)", async () => {
    // A valid CRLF-terminated SSE stream ends in `\r\n\r\n` (last two bytes
    // 0x0d 0x0a). An LF-only check would false-positive here; the CRLF-tolerant
    // check (prevByte === 0x0d || prevByte === 0x0a) treats it as terminated.
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: complete\r\n\r\n")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M4 — an injected error frame is folded into the response-bytes + stream-
// events metric counters (not just written to the socket). Reuses the H1
// partial-then-error stream: the partial chunk contributes 0 event boundaries
// (single `\n`, no `\n\n`), so stream_events_total reflects EXACTLY the one
// injected frame, and response_bytes_total = partial bytes + frame bytes.
// ---------------------------------------------------------------------------

describe("forwardStream — M4 injected-frame metric accounting", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("folds the injected frame's bytes + event into the metric counters", async () => {
    const app = buildAppFor(makePartialThenErrorResponse());
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    // The injected frame is deterministic: message = formatErrorChain(new
    // Error("upstream socket reset")) = "Error: upstream socket reset".
    const enc = new TextEncoder();
    const payload = JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Error: upstream socket reset" },
    });
    const frameLen = enc.encode(
      `\n\nevent: error\ndata: ${payload}\n\n`,
    ).byteLength;
    const partialLen = enc.encode(
      'event: message_delta\ndata: {"par',
    ).byteLength;

    // Exactly one event boundary counted — the injected frame (the partial
    // chunk has a single `\n`, no `\n\n`, so it counts 0).
    expect(
      getValueForTests("copilot_proxy_stream_events_total", { route: "test" }),
    ).toBe(1);
    // Response bytes = partial chunk bytes + injected frame bytes.
    expect(
      getValueForTests("copilot_proxy_response_bytes_total", { route: "test" }),
    ).toBe(partialLen + frameLen);
  });
});

// ---------------------------------------------------------------------------
// F1 — protocol-aware error frame. The injected mid-stream error frame is
// shaped for the client protocol derived from `ctxBase.metricRoute`:
//   messages          → Anthropic  `event: error` / `api_error`
//   responses         → OpenAI Responses `event: response.failed`
//   chat_completions  → OpenAI Chat  bare `data: {error:{...}}` (NO event line)
// Each test drives the clean-EOF truncation path (single chunk with no
// terminating boundary → F2 flags → writeUpstreamErrorFrame injects a
// protocol-shaped frame) and parses the client bytes on `\n\n` boundaries.
// ---------------------------------------------------------------------------

/**
 * Build a Hono app forwarding `upstream` via `forwardStream` with a caller-
 * chosen `metricRoute` (drives F1 protocol selection) and model "test-model".
 */
function buildAppForRoute(upstream: Response, metricRoute: string): Hono {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStream(c, upstream, {
        route: "/test",
        model: "test-model",
        metricRoute,
      }),
    ),
  );
  return app;
}

/**
 * Split client SSE bytes on `\n\n` boundaries and return the first frame whose
 * `data:` line parses to a JSON object satisfying `pred` (plus the raw frame
 * text so callers can assert the presence/absence of an `event:` line). Parsing
 * on boundaries — not substring matching — proves the frame is a standalone,
 * well-formed SSE event.
 */
function findFrameByData(
  text: string,
  pred: (data: Record<string, unknown>) => boolean,
): { raw: string; data: Record<string, unknown> } | null {
  for (const frame of text.split("\n\n")) {
    if (frame.trim().length === 0) continue;
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice("data:".length).trim());
    } catch {
      continue; // partial / non-JSON segment
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const obj = parsed as Record<string, unknown>;
      if (pred(obj)) return { raw: frame, data: obj };
    }
  }
  return null;
}

describe("forwardStream — F1 protocol-aware error frame", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("metricRoute 'responses' emits a parseable event: response.failed frame", async () => {
    const app = buildAppForRoute(
      makeChunkedResponse([new TextEncoder().encode("data: x")]),
      "responses",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: response.failed");

    const frame = findFrameByData(text, (d) => d.type === "response.failed");
    if (frame === null) throw new Error("no parseable response.failed frame");
    // The `event:` header line is present (Responses uses named events).
    expect(
      frame.raw.split("\n").some((l) => l === "event: response.failed"),
    ).toBe(true);
    const response = frame.data.response as Record<string, unknown>;
    expect(response.status).toBe("failed");
    expect(response.model).toBe("test-model");
    const error = response.error as Record<string, unknown>;
    expect(error.code).toBe("upstream_error");
    expect(typeof error.message).toBe("string");
    expect((error.message as string).length).toBeGreaterThan(0);

    // Truncation classifies as upstream_error → status 502 for this route.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "502",
      }),
    ).toBe(1);
  });

  it("metricRoute 'chat_completions' emits a bare data:{error} frame (no event: line)", async () => {
    const app = buildAppForRoute(
      makeChunkedResponse([new TextEncoder().encode("data: x")]),
      "chat_completions",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);

    const frame = findFrameByData(
      text,
      (d) =>
        d.type === undefined &&
        typeof (d.error as Record<string, unknown> | undefined)?.message ===
          "string",
    );
    if (frame === null) throw new Error("no parseable chat error frame");
    // Chat streaming errors are a bare `data:` frame — NO `event:` header line.
    const lines = frame.raw.split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.startsWith("event:"))).toBe(false);
    expect(lines[0]?.startsWith("data:")).toBe(true);
    const error = frame.data.error as Record<string, unknown>;
    expect(error.type).toBe("api_error");
    expect(error.code).toBeNull();
    expect(typeof error.message).toBe("string");

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "502",
      }),
    ).toBe(1);
  });

  it("metricRoute 'messages' emits the Anthropic event: error / api_error frame", async () => {
    const app = buildAppForRoute(
      makeChunkedResponse([new TextEncoder().encode("data: x")]),
      "messages",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: error");

    const frame = findParsedErrorFrame(text);
    expect(frame).not.toBeNull();
    expect(frame?.type).toBe("error");
    expect(frame?.error?.type).toBe("api_error");

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F2 — SSE-correct truncation detection (replaces the round-1 last-two-bytes
// heuristic). `trailingIsTruncatedEvent` runs on the trailing segment after the
// last event boundary (`(?:\r?\n){2}`), so a single `\r\n` line ending is NOT a
// boundary (truncation), a split `\r\n\r\n` across chunks IS a clean boundary,
// and a trailing `:comment` after a complete event is NOT a truncation.
// ---------------------------------------------------------------------------

describe("forwardStream — F2 SSE-correct truncation detection", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("single trailing \\r\\n (not a boundary) is a truncation → error frame + 502", async () => {
    // Round-1's last-two-bytes check saw 0x0d 0x0a and (wrongly) treated it as a
    // CRLF boundary → false negative. F2 correctly flags the dangling field line.
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x\r\n")]),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });

  it("\\r\\n\\r\\n boundary split across two chunks is clean → no frame + 200", async () => {
    const app = buildAppFor(
      makeChunkedResponse([
        new TextEncoder().encode("data: x\r\n"),
        new TextEncoder().encode("\r\n"),
      ]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("terminal event then a trailing :comment is clean → no frame + 200", async () => {
    // Round-1's last-two-bytes check saw `e\n` at EOF and (wrongly) flagged a
    // truncation → false positive. F2 sees the trailing segment is comment-only.
    const app = buildAppFor(
      makeChunkedResponse([
        new TextEncoder().encode("data: x\n\n:keepalive\n"),
      ]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("control: LF \\n\\n clean close → no frame + 200", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x\n\n")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
  });

  it("control: CRLF \\r\\n\\r\\n single-chunk clean close → no frame + 200", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x\r\n\r\n")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F3 — O(1) byte state-machine truncation detection (verbatim path). Replaces
// the per-chunk decode + `.split(EVENT_BOUNDARY_RE)` with a constant-space
// scanner. These pin the exact clean-vs-truncated verdict for the canonical
// byte sequences the F3 design was verified against — driven end-to-end through
// forwardStream so the cross-EOF `truncated = sinceBoundaryHasReal ||
// curLineKind === 2` decision is what actually gates the injected error frame.
// ---------------------------------------------------------------------------

describe("forwardStream — F3 byte state-machine truncation verdicts", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  // [name, chunk-strings, expectTruncated]
  const vectors: Array<[string, string[], boolean]> = [
    ["data: x\\n\\n → complete", ["data: x\n\n"], false],
    [
      "data: x\\n → truncated (real line, no blank-line boundary)",
      ["data: x\n"],
      true,
    ],
    [
      "data: x\\r\\n → truncated (single CRLF is one ending, not a boundary)",
      ["data: x\r\n"],
      true,
    ],
    ["data: x\\r\\n\\r\\n → complete", ["data: x\r\n\r\n"], false],
    [
      "data: x\\n\\n:keepalive\\n → complete (trailing comment is not a truncation)",
      ["data: x\n\n:keepalive\n"],
      false,
    ],
    ["data: x\\r\\r → complete (bare-CR blank line)", ["data: x\r\r"], false],
    ["empty stream → complete", [], false],
  ];

  for (const [name, chunks, expectTruncated] of vectors) {
    it(name, async () => {
      const app = buildAppFor(
        makeChunkedResponse(chunks.map((s) => new TextEncoder().encode(s))),
      );
      const resp = await app.request("/sse");
      expect(resp.status).toBe(200);
      const text = await collectClientBytes(resp);
      if (expectTruncated) {
        // Truncation → injected error frame + upstream_error (502).
        expect(findParsedErrorFrame(text)).not.toBeNull();
        expect(
          getValueForTests("copilot_proxy_requests_total", {
            route: "test",
            status: "502",
          }),
        ).toBe(1);
      } else {
        // Clean → no error frame + success (200).
        expect(text).not.toContain("event: error");
        expect(
          getValueForTests("copilot_proxy_requests_total", {
            route: "test",
            status: "200",
          }),
        ).toBe(1);
        expect(
          getValueForTests("copilot_proxy_requests_total", {
            route: "test",
            status: "502",
          }),
        ).toBeUndefined();
      }
    });
  }

  it("bare-CR blank line split across two chunks stays complete (prevWasCR carries across chunks)", async () => {
    // chunkA ends with a bare `\r` (real line terminated); chunkB is a second
    // bare `\r` (blank line → boundary). The scan's persistent state must treat
    // this as a clean close, not a truncation.
    const app = buildAppFor(
      makeChunkedResponse([
        new TextEncoder().encode("data: x\r"),
        new TextEncoder().encode("\r"),
      ]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
  });

  it("CRLF split across chunks (…\\r | \\n) is coalesced, not double-counted → truncated", async () => {
    // A single CRLF split as `data: x\r` | `\n`: the `\n` in chunkB must
    // coalesce with chunkA's trailing CR (one line ending, via prevWasCR), so
    // the event is left unterminated by a blank line → truncation. If prevWasCR
    // did NOT carry across chunks, the `\n` would be counted as a second ending
    // and the stream would be wrongly judged complete.
    const app = buildAppFor(
      makeChunkedResponse([
        new TextEncoder().encode("data: x\r"),
        new TextEncoder().encode("\n"),
      ]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F4 — the tiny terminal diagnostic frame is ALWAYS captured into the trace
// buffer, even after the byte cap was exceeded and upstream chunks were dropped.
// `body_truncated` then honestly reports the overflow. Pre-F4 the frame was
// dropped whenever `bytesAccumulated + frameLen > capBytes`, so a truncated
// trace lost its own terminal error marker.
// ---------------------------------------------------------------------------

describe("forwardStream — F4 injected frame always captured in trace buffer", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("captures the terminal error frame even after the cap is exceeded (body_truncated honest)", async () => {
    let capturedFlow: FlowRecord | null = null;
    let capturedRes: Uint8Array = new Uint8Array(0);
    const mockWriter = {
      write: async (
        flow: FlowRecord,
        _req: Uint8Array,
        res: Uint8Array,
      ): Promise<string> => {
        capturedFlow = flow;
        capturedRes = res;
        return "mock-manifest-path";
      },
    } as unknown as TraceWriter;

    const meta: TraceMeta = {
      requestId: "f4-req",
      method: "POST",
      url: "http://localhost/v1/messages",
      host: "localhost",
      path: "/v1/messages",
      inboundHeaders: {},
      inboundBody: null,
      inboundContentType: "application/json",
      startedAt: Date.now(),
    };

    // capBytes ≈ 5 (well under the 10-byte first chunk) so the first upstream
    // chunk overflows + is dropped (warnedOverflow=true), then the injected
    // error frame is still captured by F4's always-push path.
    const ctxBase: StreamCtxBase = {
      route: "/v1/messages",
      model: "test-model",
      metricRoute: "messages",
      traceWriter: mockWriter,
      traceMeta: meta,
      streamBufferMb: 5 / (1024 * 1024),
    };

    // makeErroringResponse emits "data: hi\n\n" (10 bytes) then errors mid-
    // stream → catch path → injected error frame.
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(c, forwardStream(c, makeErroringResponse(), ctxBase)),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    // Trace write is fire-and-forget — poll briefly for the mock to run.
    for (let i = 0; i < 20; i++) {
      if (capturedFlow !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (capturedFlow === null) throw new Error("trace flow was never written");

    // The injected error frame IS in the captured outbound bytes despite the
    // cap overflow (pre-F4 it would have been dropped → no "event: error").
    const resText = new TextDecoder().decode(capturedRes);
    expect(resText).toContain("event: error");
    // Honest truncation flag: the cap was exceeded so body_truncated is true.
    const flow: FlowRecord = capturedFlow;
    expect(flow.response.body_truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F5 — the translated forwarder's non-truncation upstream/transform failure
// (the catch `else` branch) now emits a `consola.error` operator log, parity
// with the verbatim forwarder. (The done-branch truncation path logs
// separately; that is covered by the F1/F2 tests above via the verbatim path.)
// ---------------------------------------------------------------------------

describe("forwardStreamTranslated — F5 operator log on mid-stream failure", () => {
  let origError: typeof consola.error;
  let captured: string[];

  beforeEach(() => {
    resetForTests();
    captured = [];
    origError = consola.error;
    consola.error = ((...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(" "));
    }) as typeof consola.error;
  });
  afterEach(() => {
    consola.error = origError;
    resetForTests();
  });

  it("emits consola.error when an upstream mid-stream failure fires the catch", async () => {
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeErroringResponse(),
          [],
          new Map(),
          "f5-req",
          {
            route: "/test",
            model: "test-model",
            metricRoute: "messages",
          },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    expect(
      captured.some((m) => m.includes("upstream mid-stream failure")),
    ).toBe(true);
    // F5 — tracing is OFF here (ctxBase has no traceMeta), so the pre-F5 log
    // (`ctxBase.traceMeta?.requestId ?? "<unknown>"`) would have printed
    // "<unknown>". The fix logs the `requestId` param directly.
    expect(captured.some((m) => m.includes("f5-req"))).toBe(true);
    expect(captured.some((m) => m.includes("<unknown>"))).toBe(false);
    // Classified as upstream_error → 502 (not a client abort).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F4 — internal-vs-upstream classification in the translated catch. A proxy-
// internal transform failure (EngineAbort500Error / UnregisteredRuleError /
// RuleSchemaInvalidError) is HTTP 500, NOT a 502 bad gateway. EngineAbort502Error
// and plain socket errors stay 502. Each test makes the upstream reader throw a
// specific error mid-stream and asserts the recorded requests_total status.
// ---------------------------------------------------------------------------

/**
 * Upstream Response that emits one valid SSE event, then errors its stream on
 * the next read with `err` (a reader.read() rejection mid-stream). The 5ms
 * defer lets the first chunk forward before the failure surfaces.
 */
function makeReaderThrowing(err: unknown): Response {
  const body = new ReadableStream({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n'));
      setTimeout(() => controller.error(err), 5);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("forwardStreamTranslated — F4 internal-vs-upstream classification", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  async function runWith(err: unknown): Promise<void> {
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeReaderThrowing(err),
          [],
          new Map(),
          "f4-req",
          {
            route: "/test",
            model: "test-model",
            metricRoute: "messages",
          },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);
  }

  it('EngineAbort500Error → internal_error → status "500" (NOT 502)', async () => {
    await runWith(new EngineAbort500Error("rule_x", new Error("boom")));
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it('EngineAbort502Error → upstream_error → status "502" (NOT 500)', async () => {
    await runWith(new EngineAbort502Error("rule_y", new Error("gateway")));
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBeUndefined();
  });

  it('plain socket error → upstream_error → status "502"', async () => {
    await runWith(new Error("upstream socket reset"));
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F6 — body_truncated reflects ONLY dropped upstream bytes. The tiny injected
// terminal error frame tipping the buffer cap must NOT flip body_truncated when
// no real upstream chunk was dropped; a real chunk dropped by the cap DOES.
// Mirrored in both forwarders.
// ---------------------------------------------------------------------------

describe("forwardStream / forwardStreamTranslated — F6 body_truncated reflects dropped upstream bytes", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  function mockCapture(): {
    writer: TraceWriter;
    get: () => FlowRecord | null;
    getRes: () => Uint8Array;
  } {
    let flow: FlowRecord | null = null;
    let res: Uint8Array = new Uint8Array(0);
    const writer = {
      write: async (
        f: FlowRecord,
        _req: Uint8Array,
        r: Uint8Array,
      ): Promise<string> => {
        flow = f;
        res = r;
        return "mock-manifest-path";
      },
    } as unknown as TraceWriter;
    return {
      writer,
      get: (): FlowRecord | null => flow,
      getRes: (): Uint8Array => res,
    };
  }

  const meta: TraceMeta = {
    requestId: "f6-req",
    method: "POST",
    url: "http://localhost/v1/messages",
    host: "localhost",
    path: "/v1/messages",
    inboundHeaders: {},
    inboundBody: null,
    inboundContentType: "application/json",
    startedAt: Date.now(),
  };

  async function waitForFlow(
    get: () => FlowRecord | null,
  ): Promise<FlowRecord> {
    for (let i = 0; i < 40; i++) {
      const f = get();
      if (f !== null) return f;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("trace flow was never written");
  }

  it("verbatim: injected frame alone tips the cap, no real chunk dropped → body_truncated=false", async () => {
    const cap = mockCapture();
    // Single real chunk "data: x" (7 bytes, no `\n\n` → clean-EOF truncation →
    // injected frame). Cap set EXACTLY to the chunk size so the real chunk fits
    // (<=) and only the larger injected frame overshoots. (7/2^20 * 2^20 = 7
    // exactly — power-of-two arithmetic, no float error.)
    const chunk = new TextEncoder().encode("data: x");
    const ctxBase: StreamCtxBase = {
      route: "/v1/messages",
      model: "test-model",
      metricRoute: "messages",
      traceWriter: cap.writer,
      traceMeta: meta,
      streamBufferMb: chunk.byteLength / (1024 * 1024),
    };
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(c, forwardStream(c, makeChunkedResponse([chunk]), ctxBase)),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    const flow = await waitForFlow(cap.get);
    // The injected error frame IS captured...
    expect(new TextDecoder().decode(cap.getRes())).toContain("event: error");
    // ...but body_truncated is FALSE — no REAL upstream chunk was dropped (the
    // real "data: x" fit; only the diagnostic frame overshot the cap).
    expect(flow.response.body_truncated).toBe(false);
  });

  it("verbatim: a real chunk dropped by the cap → body_truncated=true", async () => {
    const cap = mockCapture();
    // Cap (3 bytes) smaller than the 7-byte chunk → the real chunk is DROPPED.
    const chunk = new TextEncoder().encode("data: x");
    const ctxBase: StreamCtxBase = {
      route: "/v1/messages",
      model: "test-model",
      metricRoute: "messages",
      traceWriter: cap.writer,
      traceMeta: meta,
      streamBufferMb: 3 / (1024 * 1024),
    };
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(c, forwardStream(c, makeChunkedResponse([chunk]), ctxBase)),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    const flow = await waitForFlow(cap.get);
    expect(flow.response.body_truncated).toBe(true);
  });

  it("translated: injected frame alone tips the cap, no real chunk dropped → body_truncated=false", async () => {
    const cap = mockCapture();
    // Post-translation the passthrough emits `encodeSseEvent({type:"ping"})`;
    // set the cap to exactly that size so the real event fits and only the
    // larger injected error frame overshoots.
    const encodedPing = encodeSseEvent({ type: "ping" });
    const ctxBase: StreamCtxBase = {
      route: "/v1/messages",
      model: "test-model",
      metricRoute: "messages",
      traceWriter: cap.writer,
      traceMeta: meta,
      streamBufferMb: encodedPing.byteLength / (1024 * 1024),
    };
    // Emit one valid event (passed through), then error mid-stream → injected
    // frame. Empty rules → default passthrough re-emits the event unchanged.
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"ping"}\n\n'),
        );
        setTimeout(() => controller.error(new Error("socket reset")), 5);
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          upstream,
          [],
          new Map(),
          "f6-translated-req",
          ctxBase,
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    await collectClientBytes(resp);

    const flow = await waitForFlow(cap.get);
    expect(new TextDecoder().decode(cap.getRes())).toContain("event: error");
    expect(flow.response.body_truncated).toBe(false);
  });
});

// ===========================================================================
// REMEDIATION — the 6 discriminator findings (F1–F6) on the error-surfacing
// round. Named "remediation Finding N" to stay distinct from the pre-existing
// F1–F6 blocks above (which label the ORIGINAL error-surfacing features).
// ===========================================================================

/** Collect a client Response body as RAW bytes (no decode), tolerating a
 *  mid-stream close. Needed for verbatim-byte assertions where a `TextDecoder`
 *  would strip a leading BOM. */
async function collectClientBytesRaw(resp: Response): Promise<Uint8Array> {
  if (resp.body === null) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const parts: number[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) parts.push(...value);
    }
  } catch {
    /* mid-stream close is acceptable — return what we captured */
  }
  return new Uint8Array(parts);
}

/** Build a Response whose stream emits one complete event then errors its
 *  stream with an arbitrary (possibly non-Error) reason on the next read. */
function makeErroringResponseWith(reason: unknown): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      setTimeout(() => controller.error(reason), 5);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---- Finding 1 — formatErrorChain totality drives a terminal frame ---------

describe("forwardStream — remediation Finding 1: non-Error throw still emits a terminal frame", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("mid-stream error with a null-prototype (non-stringifiable) value → terminal error frame + 502", async () => {
    // `String(Object.create(null))` throws — pre-fix this crashed the stream
    // callback with NO terminal frame (silent truncation). formatErrorChain is
    // now total, so the frame is still emitted.
    const app = buildAppFor(makeErroringResponseWith(Object.create(null)));
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    const frame = findParsedErrorFrame(text);
    expect(frame).not.toBeNull();
    expect(frame?.error?.type).toBe("api_error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });

  it("mid-stream error with a thrown-toString object → terminal error frame (writer never escapes)", async () => {
    const hostile = {
      toString(): string {
        throw new Error("toString blew up");
      },
    };
    const app = buildAppFor(makeErroringResponseWith(hostile));
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---- Finding 2 / Finding 4 — transform/encode failure classified 500 -------

/** Register a stream-event rule that emits an event carrying a circular
 *  reference → `encodeSseEvent`'s `JSON.stringify` throws a `TypeError` during
 *  the transform/encode phase (whose name is NOT in INTERNAL_ERROR_NAMES). */
function registerCircularRule(): void {
  registerStreamEvent(
    "test_circular_emit",
    () => {
      const circular: AnyEvent = { type: "boom" };
      circular["self"] = circular; // circular ref → JSON.stringify throws
      return { events_out: [circular], applied: true };
    },
    z.unknown(),
    { allow_override: true },
  );
}

/** Build a Hono app that forwards `upstream` through `forwardStreamTranslated`
 *  running the circular-ref rule, with the chosen `metricRoute`. */
function buildCircularTranslatedApp(
  upstream: Response,
  metricRoute: string,
  requestId: string,
): Hono {
  registerCircularRule();
  const snap = registrySnapshot("stream_event");
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStreamTranslated(
        c,
        upstream,
        [{ name: "circular", use: "test_circular_emit" }],
        snap,
        requestId,
        { route: "/test", model: "test-model", metricRoute },
      ),
    ),
  );
  return app;
}

/** A single complete upstream SSE event (drives the per-chunk apply/encode
 *  path where the circular rule fires). */
function makeSingleEventResponse(): Response {
  return makeChunkedResponse([
    new TextEncoder().encode('event: a\ndata: {"type":"a"}\n\n'),
  ]);
}

describe("forwardStreamTranslated — remediation Finding 2: transform/encode throw is internal_error(500)", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("circular-ref transform output → encodeSseEvent TypeError → outcome internal_error(500), NOT 502", async () => {
    const app = buildCircularTranslatedApp(
      makeSingleEventResponse(),
      "messages",
      "f2-remediation-req",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    // A terminal error frame is still surfaced (no silent truncation).
    expect(findParsedErrorFrame(text)).not.toBeNull();
    // Phase classification: transform/encode TypeError → internal (500), not 502.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("EngineAbort502Error from a transform rule (abort_with_502) stays upstream_error(502) — brand does not over-capture", async () => {
    // A rule with on_error: "abort_with_502" throws EngineAbort502Error FROM the
    // transform phase (so it IS branded), but its explicit bad-gateway policy
    // must keep it at 502 — the phase brand must NOT flip it to 500.
    registerStreamEvent(
      "test_abort_502_rule",
      () => {
        throw new Error("rule detonated");
      },
      z.unknown(),
      { allow_override: true },
    );
    const snap = registrySnapshot("stream_event");
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeSingleEventResponse(),
          [
            {
              name: "b502",
              use: "test_abort_502_rule",
              on_error: "abort_with_502",
            },
          ],
          snap,
          "f2-abort502-req",
          { route: "/test", model: "test-model", metricRoute: "messages" },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBeUndefined();
  });

  it("EngineAbort500Error from a transform rule (abort_with_500) → internal_error(500)", async () => {
    registerStreamEvent(
      "test_abort_500_rule",
      () => {
        throw new Error("rule detonated");
      },
      z.unknown(),
      { allow_override: true },
    );
    const snap = registrySnapshot("stream_event");
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeSingleEventResponse(),
          [
            {
              name: "b500",
              use: "test_abort_500_rule",
              on_error: "abort_with_500",
            },
          ],
          snap,
          "f2-abort500-req",
          { route: "/test", model: "test-model", metricRoute: "messages" },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---- H3 — a non-brandable (primitive/frozen) transform throw is 500 ---------

/** Register a stream-event rule that emits an event whose `toJSON` throws
 *  `thrown` → `encodeSseEvent`'s `JSON.stringify` propagates that throw out of
 *  the transform/encode phase. Exercises H3: a PRIMITIVE or FROZEN throw cannot
 *  carry the transform-phase brand (markTransformPhase brands only extensible
 *  objects), so pre-H3 it fell through to upstream_error(502); it must classify
 *  internal_error(500). */
function registerToJSONThrowRule(thrown: unknown): void {
  registerStreamEvent(
    "test_tojson_throw",
    () => {
      const evt: AnyEvent = { type: "boom" };
      (evt as Record<string, unknown>)["toJSON"] = (): never => {
        throw thrown;
      };
      return { events_out: [evt], applied: true };
    },
    z.unknown(),
    { allow_override: true },
  );
}

/** Build a translated app whose single-event stream fires `registerToJSONThrowRule`
 *  → the encode phase throws `thrown`. */
function buildToJSONThrowApp(thrown: unknown, requestId: string): Hono {
  registerToJSONThrowRule(thrown);
  const snap = registrySnapshot("stream_event");
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStreamTranslated(
        c,
        makeSingleEventResponse(),
        [{ name: "tojson", use: "test_tojson_throw" }],
        snap,
        requestId,
        { route: "/test", model: "test-model", metricRoute: "messages" },
      ),
    ),
  );
  return app;
}

describe("forwardStreamTranslated — H3 non-brandable transform throw is internal_error(500)", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("a PRIMITIVE (string) thrown from the encode phase → internal_error(500), NOT 502", async () => {
    const app = buildToJSONThrowApp("boom", "h3-primitive-req");
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    // A terminal error frame is still surfaced (no silent truncation).
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("a FROZEN object thrown from the encode phase → internal_error(500), NOT 502", async () => {
    const app = buildToJSONThrowApp(
      Object.freeze({ frozen: true }),
      "h3-frozen-req",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

describe("forward-stream — remediation Finding 4: Responses error.code reflects the outcome", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("responses + internal(500) transform failure → error.code 'internal_error'", async () => {
    const app = buildCircularTranslatedApp(
      makeSingleEventResponse(),
      "responses",
      "f4-internal-req",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    const frame = findFrameByData(text, (d) => d.type === "response.failed");
    if (frame === null) throw new Error("no response.failed frame");
    const response = frame.data.response as Record<string, unknown>;
    const error = response.error as Record<string, unknown>;
    expect(error.code).toBe("internal_error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "500",
      }),
    ).toBe(1);
  });

  it("responses + upstream(502) mid-stream failure → error.code 'upstream_error'", async () => {
    // Verbatim path: a mid-stream socket reset is an upstream failure (502).
    const app = buildAppForRoute(makeErroringResponse(), "responses");
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    const frame = findFrameByData(text, (d) => d.type === "response.failed");
    if (frame === null) throw new Error("no response.failed frame");
    const response = frame.data.response as Record<string, unknown>;
    const error = response.error as Record<string, unknown>;
    expect(error.code).toBe("upstream_error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---- Finding 3 — diagnostic message hard cap + truncation marker -----------

describe("forwardStream — remediation Finding 3: diagnostic message hard cap", () => {
  // The upstream error message is ~1 MB — stub consola.error so the operator
  // log (which prints the FULL formatErrorChain message, uncapped by design)
  // doesn't flood the test output. The cap under test is on the FRAME, asserted
  // below via the parsed client frame.
  let origError: typeof consola.error;
  beforeEach(() => {
    resetForTests();
    origError = consola.error;
    consola.error = ((..._args: unknown[]): void => {}) as typeof consola.error;
  });
  afterEach(() => {
    consola.error = origError;
    resetForTests();
  });

  it("caps a ~1 MB upstream error message in the injected frame + states dropped bytes", async () => {
    const huge = "x".repeat(1_000_000); // ~1 MB message
    const originalBytes = new TextEncoder().encode(`Error: ${huge}`).byteLength;

    const app = buildAppFor(makeErroringResponseWith(new Error(huge)));
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);

    const frame = findParsedErrorFrame(text);
    expect(frame).not.toBeNull();
    const msg = frame?.error?.message ?? "";
    // M8 — the RETURNED string (kept head + `...[truncated N bytes]` marker) is
    // bounded to MAX_ERROR_MESSAGE_BYTES (8192): the marker length is reserved
    // FROM the budget, not added on top. Pre-M8 the total could reach 8192 +
    // marker; now the whole string fits inside the cap.
    expect(new TextEncoder().encode(msg).byteLength).toBeLessThanOrEqual(8192);
    // Explicit truncation marker stating the dropped byte count.
    const m = /\.\.\.\[truncated (\d+) bytes\]$/.exec(msg);
    expect(m).not.toBeNull();
    const droppedBytes = Number(m?.[1]);
    // Kept ~8 KiB, dropped the rest: dropped is close to (but < ) the original.
    expect(droppedBytes).toBeLessThan(originalBytes);
    expect(droppedBytes).toBeGreaterThan(originalBytes - 20_000);
    // The kept head is cut on a UTF-8 codepoint boundary → valid UTF-8, no
    // U+FFFD replacement char introduced by splitting a multibyte sequence.
    const head = msg.slice(0, msg.length - (m?.[0]?.length ?? 0));
    expect(head).not.toContain("�");
  });

  it("M8 — a multibyte-char message stays <= cap AND the head is codepoint-clean", async () => {
    // 4000 × € (3 bytes each) → the cap cut lands INSIDE a € sequence. `stream:
    // true` must hold the partial back (no U+FFFD) and the total (head + marker)
    // must still be <= 8192.
    const huge = "€".repeat(4000);
    const app = buildAppFor(makeErroringResponseWith(new Error(huge)));
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);

    const frame = findParsedErrorFrame(text);
    expect(frame).not.toBeNull();
    const msg = frame?.error?.message ?? "";
    // Total (head + marker) within the cap even with 3-byte codepoints.
    expect(new TextEncoder().encode(msg).byteLength).toBeLessThanOrEqual(8192);
    const m = /\.\.\.\[truncated (\d+) bytes\]$/.exec(msg);
    expect(m).not.toBeNull();
    // Head cut on a codepoint boundary → no replacement char, no split €.
    const head = msg.slice(0, msg.length - (m?.[0]?.length ?? 0));
    expect(head).not.toContain("�");
    expect(head.endsWith("€")).toBe(true);
  });
});

// ---- Finding 5 — whitespace-only trailer not truncated (byte scanner) ------

describe("forwardStream — remediation Finding 5: whitespace-only trailer not truncated", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("terminated event + trailing spaces at clean EOF → NOT truncated (200)", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x\n\n   ")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("terminated event + trailing tabs/spaces at clean EOF → NOT truncated (200)", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x\n\n \t \t")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
  });

  it("control: an unterminated real event still → truncated (502)", async () => {
    const app = buildAppFor(
      makeChunkedResponse([new TextEncoder().encode("data: x")]),
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---- Finding 6 — leading UTF-8 BOM not mistaken for a real field -----------

describe("forwardStream — remediation Finding 6: leading UTF-8 BOM not a field", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("BOM split [EF]|[BB]|[BF+event] then clean EOF → NOT truncated + bytes forwarded verbatim", async () => {
    const eventBytes = new TextEncoder().encode("data: hi\n\n");
    // chunk3 = 0xBF (last BOM byte) glued with the complete event.
    const chunk3 = new Uint8Array(1 + eventBytes.byteLength);
    chunk3[0] = 0xbf;
    chunk3.set(eventBytes, 1);
    const upstream = makeChunkedResponse([
      new Uint8Array([0xef]),
      new Uint8Array([0xbb]),
      chunk3,
    ]);
    const app = buildAppFor(upstream);
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);

    const raw = await collectClientBytesRaw(resp);
    // Verbatim: the BOM is forwarded, NOT stripped.
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    // NOT truncated: the BOM's 0xEF is not classified as a real field line.
    expect(new TextDecoder().decode(raw)).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("BOM (single chunk) then an UNTERMINATED real event → still truncated (502)", async () => {
    // The BOM must not MASK a genuine truncation that follows it.
    const partial = new TextEncoder().encode("data: x"); // no boundary
    const chunk = new Uint8Array(3 + partial.byteLength);
    chunk.set([0xef, 0xbb, 0xbf], 0);
    chunk.set(partial, 3);
    const app = buildAppFor(makeChunkedResponse([chunk]));
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "test",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P2 — client-disconnect-first + truncated trailing event reclassification.
//
// When the client disconnects FIRST (the harness times out waiting on a stalled
// or broken upstream mid-event), onAbort ALREADY set outcome=client_abort and
// cancelled the reader; the next read resolves done:true with a TRUNCATED
// trailing event. Pre-P2 the `outcome === "success"` truncation guard was now
// false, so the truncation was never surfaced and the outcome stayed
// client_abort(499) with no error frame. The reclassification applies to both
// forwarders rather than depending on which protocol lane carried the event.
// `truncated && (outcome === "success" || outcome === "client_abort")` so a
// truncated trailing event reclassifies to upstream_error(502) even after a
// client abort. PRESERVED: a clean-boundary abort (truncated=false /
// pendingPartial=false) STAYS client_abort(499) with no frame.
//
// The client abort is simulated the same way the existing onAbort/abort tests
// do (build the callback on a not-yet-aborted signal so deriveUpstreamSignal's
// filter propagates a LATE abort), but fired DURING the first write —
// i.e. AFTER a real upstream chunk/event was already forwarded — so the trailing
// event is genuinely truncated at the moment the client leaves.
// ---------------------------------------------------------------------------

/** P2 — a Response whose stream emits `chunk` then STALLS (never closes). A
 *  client abort (not a natural EOF) drives teardown: onAbort → reader.cancel()
 *  → the forwarder's next read resolves done:true with the trailing event still
 *  truncated. */
function makeStallingResponse(chunk: Uint8Array): Response {
  const body = new ReadableStream({
    start(controller): void {
      controller.enqueue(chunk);
      // stall — never enqueue again, never close.
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** P2 — a test-mock Hono Context carrying `signal` as the inbound request
 *  signal. Same shape both forwarders accept. */
function mockCtxFromSignal(
  signal: AbortSignal,
): Parameters<typeof forwardStream>[0] {
  return {
    req: { raw: { signal } },
  } as unknown as Parameters<typeof forwardStream>[0];
}

/** P2 — a mock SSEStreamingApi that records every write (decoded to a string)
 *  and invokes `onFirstWrite` EXACTLY once, right after the first write is
 *  recorded. Firing the client abort inside the first write reproduces the
 *  production sequence the P2 fix targets: a real chunk/event is forwarded, THEN
 *  the client disconnects → onAbort flips outcome to client_abort + cancels the
 *  reader → the next read resolves done:true with a truncated trailing event.
 *  `aborted` stays false so the read loop reaches the `if (done)` reclassification
 *  branch (NOT the `stream.aborted` early-return, which is a distinct path out of
 *  P2 scope). */
function makeAbortOnFirstWriteStream(onFirstWrite: () => void): {
  stream: Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];
  writes: string[];
} {
  const writes: string[] = [];
  const dec = new TextDecoder();
  let fired = false;
  const stream = {
    aborted: false,
    write: async (v: Uint8Array | string): Promise<void> => {
      writes.push(typeof v === "string" ? v : dec.decode(v));
      if (!fired) {
        fired = true;
        onFirstWrite();
      }
    },
  } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];
  return { stream, writes };
}

describe("forward-stream — P2 client-disconnect-first truncation reclassification", () => {
  // message_start + content_block_start (both complete) then a PARTIAL
  // content_block_delta line with NO terminating blank line → truncated.
  const PARTIAL_TRAILING =
    'event: message_start\ndata: {"type":"message_start"}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start"}\n\n' +
    'event: content_block_delta\ndata: {"par';

  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(a) verbatim: client aborts after a PARTIAL mid-event line → upstream_error(502) + error frame", async () => {
    const ac = new AbortController();
    const mockCtx = mockCtxFromSignal(ac.signal);
    const upstream = makeStallingResponse(
      new TextEncoder().encode(PARTIAL_TRAILING),
    );
    // Client disconnects mid-stream, AFTER the partial trailing event is
    // forwarded (fired inside the first write).
    const { stream, writes } = makeAbortOnFirstWriteStream(() => ac.abort());

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "messages",
    });
    await cb(stream);

    // Reclassified: truncated trailing event + client_abort → upstream_error(502).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    // NOT the pre-P2 mislabeled client_abort(499), and not success(200).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    // The error frame was attempted (anthropic shape for the messages route).
    expect(writes.join("")).toContain("event: error");
  });

  it("(a) translated: client aborts with a partial stranded in the decoder buffer → upstream_error(502) + error frame", async () => {
    const ac = new AbortController();
    const mockCtx = mockCtxFromSignal(ac.signal);
    // Two complete events (decoded + written; the first write fires the abort)
    // then a trailing partial that stays in the decoder buffer → pendingPartial.
    const upstream = makeStallingResponse(
      new TextEncoder().encode(PARTIAL_TRAILING),
    );
    const { stream, writes } = makeAbortOnFirstWriteStream(() => ac.abort());

    const cb = forwardStreamTranslated(
      mockCtx,
      upstream,
      [],
      new Map(),
      "p2-a-translated-req",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    expect(writes.join("")).toContain("event: error");
  });

  it("(b) verbatim: client aborts at a clean blank-line boundary → stays client_abort(499), no frame", async () => {
    const ac = new AbortController();
    const mockCtx = mockCtxFromSignal(ac.signal);
    // A COMPLETE event terminated by a blank line → truncated=false at the
    // abort-induced done. MUST stay client_abort(499); no reclassification.
    const upstream = makeStallingResponse(
      new TextEncoder().encode("data: complete\n\n"),
    );
    const { stream, writes } = makeAbortOnFirstWriteStream(() => ac.abort());

    const cb = forwardStream(mockCtx, upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "messages",
    });
    await cb(stream);

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    expect(writes.join("")).not.toContain("event: error");
  });

  it("(b) translated: client aborts after a complete event (empty decoder buffer) → stays client_abort(499), no frame", async () => {
    const ac = new AbortController();
    const mockCtx = mockCtxFromSignal(ac.signal);
    // A complete event → decoder buffer empty at the abort-induced done →
    // pendingPartial=false. MUST stay client_abort(499); no reclassification.
    const upstream = makeStallingResponse(
      new TextEncoder().encode('data: {"type":"ping"}\n\n'),
    );
    const { stream, writes } = makeAbortOnFirstWriteStream(() => ac.abort());

    const cb = forwardStreamTranslated(
      mockCtx,
      upstream,
      [],
      new Map(),
      "p2-b-translated-req",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);

    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    expect(writes.join("")).not.toContain("event: error");
  });

  it("(c) verbatim: clean successful drain (terminal event, natural EOF) → success(200), no frame", async () => {
    // Regression: a natural upstream close at a clean boundary is untouched by
    // P2 — no abort, truncated=false → success(200), no frame.
    const app = buildAppForRoute(
      makeChunkedResponse([new TextEncoder().encode("data: complete\n\n")]),
      "messages",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
  });

  it("(c) translated: clean successful drain (terminal event, natural EOF) → success(200), no frame", async () => {
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeChunkedResponse([
            new TextEncoder().encode('data: {"type":"ping"}\n\n'),
          ]),
          [],
          new Map(),
          "p2-c-translated-req",
          { route: "/test", model: "test-model", metricRoute: "messages" },
        ),
      ),
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H2 — the `stream.aborted` early-return (top-of-loop) now evaluates the SAME
// truncation signal the done-branch uses and reclassifies to upstream_error,
// so the "client left mid-event on a stalled/broken upstream" case is
// consistent across BOTH exit paths (early-return AND done-branch). No frame is
// written on this path (stream.aborted ⇒ client provably gone) — log-only.
// ---------------------------------------------------------------------------

/** H2 — a mock SSEStreamingApi that flips its OWN `stream.aborted` true right
 *  after the first write. The forwarder forwards/decodes the first chunk (the
 *  scanner / decoder state advances over it), then the NEXT top-of-loop check
 *  enters the `stream.aborted` early-return with that state in place. */
function makeSelfAbortOnFirstWriteStream(): {
  stream: Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];
  writes: string[];
} {
  const writes: string[] = [];
  const dec = new TextDecoder();
  let fired = false;
  const stream = {
    aborted: false,
    write(v: Uint8Array | string): Promise<void> {
      writes.push(typeof v === "string" ? v : dec.decode(v));
      if (!fired) {
        fired = true;
        stream.aborted = true;
      }
      return Promise.resolve();
    },
  };
  return {
    stream: stream as unknown as Parameters<
      Awaited<ReturnType<typeof forwardStream>>
    >[0],
    writes,
  };
}

describe("forward-stream — H2 stream.aborted early-return truncation reclassification", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(H2) verbatim: truncated trailing event at the stream.aborted early-return → upstream_error(502), no frame", async () => {
    // "data: x" (no boundary) → curLineKind===2 at the early-return.
    const upstream = makeStallingResponse(new TextEncoder().encode("data: x"));
    const { stream, writes } = makeSelfAbortOnFirstWriteStream();
    const cb = forwardStream(
      mockCtxFromSignal(new AbortController().signal),
      upstream,
      {
        route: "/test",
        model: "test-model",
        metricRoute: "messages",
      },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    // Log-only path — NO injected error frame (client provably gone).
    expect(writes.join("")).not.toContain("event: error");
  });

  it("(H2) verbatim: clean boundary at the stream.aborted early-return → stays client_abort(499), no frame", async () => {
    const upstream = makeStallingResponse(
      new TextEncoder().encode("data: x\n\n"),
    );
    const { stream, writes } = makeSelfAbortOnFirstWriteStream();
    const cb = forwardStream(
      mockCtxFromSignal(new AbortController().signal),
      upstream,
      {
        route: "/test",
        model: "test-model",
        metricRoute: "messages",
      },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(writes.join("")).not.toContain("event: error");
  });

  it("(H2) translated: partial stranded in the decoder buffer at the stream.aborted early-return → upstream_error(502), no frame", async () => {
    // One complete event (decoded + written → fires the self-abort) then a
    // trailing partial that stays in the decoder buffer → pendingPartial.
    const upstream = makeStallingResponse(
      new TextEncoder().encode(
        'event: a\ndata: {"type":"a"}\n\nevent: b\ndata: {"par',
      ),
    );
    const { stream, writes } = makeSelfAbortOnFirstWriteStream();
    const cb = forwardStreamTranslated(
      mockCtxFromSignal(new AbortController().signal),
      upstream,
      [],
      new Map(),
      "h2-translated-a",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(writes.join("")).not.toContain("event: error");
  });

  it("(H2) translated: empty decoder buffer at the stream.aborted early-return → stays client_abort(499), no frame", async () => {
    const upstream = makeStallingResponse(
      new TextEncoder().encode('event: a\ndata: {"type":"a"}\n\n'),
    );
    const { stream, writes } = makeSelfAbortOnFirstWriteStream();
    const cb = forwardStreamTranslated(
      mockCtxFromSignal(new AbortController().signal),
      upstream,
      [],
      new Map(),
      "h2-translated-b",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
    expect(writes.join("")).not.toContain("event: error");
  });
});

// ---------------------------------------------------------------------------
// H5 — a clean success-terminal (message_stop / response.completed / [DONE])
// already delivered by the upstream means a LATER read()/transform error is
// post-completion noise (socket RST after a completed message). The forwarders
// suppress the injected error frame in that case and record success(200). With
// NO terminal seen, the frame is still injected (existing behavior preserved).
// ---------------------------------------------------------------------------

/** Emit `sseBytes` verbatim then error the stream on the next read (the 5ms
 *  defer lets the first chunk forward before the failure surfaces). */
function makeEmitThenThrow(sseBytes: string, err: unknown): Response {
  const body = new ReadableStream({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode(sseBytes));
      setTimeout(() => controller.error(err), 5);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("forwardStream — H5 post-terminal RST suppresses injected frame (verbatim)", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("anthropic: message_stop then socket RST → no injected frame, success(200)", async () => {
    const app = buildAppForRoute(
      makeEmitThenThrow(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        new Error("socket RST after terminal"),
      ),
      "messages",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: message_stop"); // terminal forwarded
    expect(findParsedErrorFrame(text)).toBeNull(); // NO injected error frame
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("openai_responses: response.completed then socket RST → no injected frame, success(200)", async () => {
    const app = buildAppForRoute(
      makeEmitThenThrow(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        new Error("socket RST after terminal"),
      ),
      "responses",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: response.completed");
    expect(
      findFrameByData(text, (d) => d.type === "response.failed"),
    ).toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("openai_chat: data:[DONE] then socket RST → no injected frame, success(200)", async () => {
    const app = buildAppForRoute(
      makeEmitThenThrow(
        "data: [DONE]\n\n",
        new Error("socket RST after terminal"),
      ),
      "chat_completions",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"error"'); // no injected chat error frame
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("negative: NO terminal before the RST → still injects the error frame (502)", async () => {
    const app = buildAppForRoute(
      makeEmitThenThrow(
        'data: {"type":"content_block_delta"}\n\n',
        new Error("mid-stream RST, no terminal"),
      ),
      "messages",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });
});

describe("forwardStreamTranslated — H5 post-terminal throw suppresses injected frame", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  function runTranslated(
    upstream: Response,
    metricRoute: string,
    requestId: string,
  ): Hono {
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(c, upstream, [], new Map(), requestId, {
          route: "/test",
          model: "test-model",
          metricRoute,
        }),
      ),
    );
    return app;
  }

  it("anthropic: message_stop emitted then read throws → no injected frame, success(200)", async () => {
    const app = runTranslated(
      makeEmitThenThrow(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        new Error("socket RST after terminal"),
      ),
      "messages",
      "h5-translated-anthropic",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: message_stop");
    expect(findParsedErrorFrame(text)).toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("openai_responses: response.completed emitted then read throws → no injected frame, success(200)", async () => {
    const app = runTranslated(
      makeEmitThenThrow(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        new Error("socket RST after terminal"),
      ),
      "responses",
      "h5-translated-responses",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("event: response.completed");
    expect(
      findFrameByData(text, (d) => d.type === "response.failed"),
    ).toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "responses",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H6 — a partial/malformed leading BOM. The provisionally-skipped BOM bytes are
// real content: on a mid-prefix mismatch the current line is marked real, and an
// incomplete BOM sitting at EOF (bomIndex 1..2) counts toward truncation.
// ---------------------------------------------------------------------------

describe("forwardStream — H6 partial/malformed leading BOM truncation", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(H6) stream ends mid-BOM (EF BB then EOF) → truncation detected (502)", async () => {
    const app = buildAppForRoute(
      makeChunkedResponse([new Uint8Array([0xef, 0xbb])]),
      "messages",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });

  it("(H6) partial BOM then a bare LF then EOF (EF BB \\n) → skipped prefix is a real line → truncated (502)", async () => {
    const app = buildAppForRoute(
      makeChunkedResponse([new Uint8Array([0xef, 0xbb, 0x0a])]),
      "messages",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });

  it("(H6) full valid BOM (EF BB BF) + clean event + clean close → NOT truncated (200)", async () => {
    const eventBytes = new TextEncoder().encode("data: hi\n\n");
    const chunk = new Uint8Array(3 + eventBytes.byteLength);
    chunk.set([0xef, 0xbb, 0xbf], 0);
    chunk.set(eventBytes, 3);
    const app = buildAppForRoute(makeChunkedResponse([chunk]), "messages");
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).not.toContain("event: error");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ===========================================================================
// iter6 remediation — F2 (CRIT-2), F3 (H2), F4 (H4), F5 (H5), F6 (H5-chat).
// The overarching invariant: the terminal-error path must NEVER close a stream
// frameless for ANY thrown value, and must NEVER mislabel a proven upstream/
// internal failure as a clean client abort or success.
// ===========================================================================

/** An Error whose `name` getter throws — a hostile reflective read that a bare
 *  `?.name` in the terminal catch would PROPAGATE (pre-F2), escaping the catch
 *  before any error frame is written. */
function makeThrowingNameError(): Error {
  const e = new Error("hostile name");
  Object.defineProperty(e, "name", {
    get(): string {
      throw new Error("name getter blew up");
    },
  });
  return e;
}

/** A Proxy whose every `get` trap throws — models a hostile thrown value whose
 *  reflective reads (`.name`, the transform-phase brand symbol) throw. */
function makeThrowingGetProxy(): unknown {
  return new Proxy(
    { type: "boom" },
    {
      get(): never {
        throw new Error("get trap blew up");
      },
    },
  );
}

/** A revoked Proxy — EVERY operation (incl. the `instanceof` GetPrototypeOf and
 *  any property read) throws a TypeError. */
function makeRevokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({ type: "boom" }, {});
  revoke();
  return proxy;
}

/** A mock upstream whose reader emits `firstChunk` on the first read, then
 *  REJECTS the second read with `err`. Its `cancel()` is a no-op that does NOT
 *  resolve the pending read, so the second read's rejection reaches the terminal
 *  catch even though onAbort called cancel(). Reproduces the F3(b) production
 *  race: a non-abort upstream socket reset COINCIDENT with a client abort. */
function makeReaderRejectAfterFirst(
  firstChunk: Uint8Array,
  err: unknown,
): Response {
  let n = 0;
  const reader = {
    read(): Promise<{ value?: Uint8Array; done: boolean }> {
      n += 1;
      if (n === 1) return Promise.resolve({ value: firstChunk, done: false });
      return Promise.reject(err);
    },
    cancel(): Promise<void> {
      return Promise.resolve();
    },
    releaseLock(): void {
      /* no-op mock */
    },
  };
  return {
    body: { getReader: () => reader },
    headers: new Headers(),
  } as unknown as Response;
}

/** A mock SSE stream that fires `ac.abort()` DURING the injected-error-frame
 *  write (detected by the frame's marker text) — the exact F3(a) race where a
 *  client abort must NOT downgrade an already-classified upstream_error. The
 *  plain data chunk ("data: x") carries no marker so the abort fires only on the
 *  frame write, while `writeUpstreamErrorFrame` is awaited. */
function makeAbortWhenFrameWritten(ac: AbortController): {
  stream: Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];
  writes: string[];
} {
  const writes: string[] = [];
  const dec = new TextDecoder();
  const stream = {
    aborted: false,
    write(v: Uint8Array | string): Promise<void> {
      const s = typeof v === "string" ? v : dec.decode(v);
      writes.push(s);
      if (
        s.includes("event: error") ||
        s.includes("response.failed") ||
        s.includes('"error"')
      ) {
        ac.abort();
      }
      return Promise.resolve();
    },
  };
  return {
    stream: stream as unknown as Parameters<
      Awaited<ReturnType<typeof forwardStream>>
    >[0],
    writes,
  };
}

/** Build a Hono app forwarding `upstream` through `forwardStreamTranslated`
 *  with the given rules + registry snapshot + metricRoute. */
function buildTranslatedAppWith(
  upstream: Response,
  metricRoute: string,
  requestId: string,
  rules: Parameters<typeof forwardStreamTranslated>[2] = [],
  snap: Parameters<typeof forwardStreamTranslated>[3] = new Map(),
): Hono {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStreamTranslated(c, upstream, rules, snap, requestId, {
        route: "/test",
        model: "test-model",
        metricRoute,
      }),
    ),
  );
  return app;
}

/** Register a stream-event rule that emits an event whose `toJSON` THROWS
 *  `thrown` from `encodeSseEvent` — i.e. a transform/ENCODE-phase throw (a rule
 *  fn that throws directly is swallowed by applyEvent's on_error=continue). This
 *  drives the H3/F2 brand-and-classify path over a hostile thrown value. */
function registerEncodeThrowRule(thrown: unknown): void {
  registerStreamEvent(
    "test_encode_throw_value",
    () => {
      const evt: AnyEvent = { type: "boom" };
      (evt as Record<string, unknown>)["toJSON"] = (): never => {
        throw thrown;
      };
      return { events_out: [evt], applied: true };
    },
    z.unknown(),
    { allow_override: true },
  );
}

// ---- F2 (CRIT-2) — reflective reads in the terminal catch are total ---------

describe("forwardStream — F2: hostile thrown value still yields a terminal frame (verbatim)", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(a) Error whose name getter throws → upstream_error(502) + frame, never frameless", async () => {
    const app = buildAppForRoute(
      makeErroringResponseWith(makeThrowingNameError()),
      "messages",
    );
    const resp = await app.request("/sse");
    expect(resp.status).toBe(200);
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });

  it("(c) revoked Proxy → upstream_error(502) + frame, never frameless", async () => {
    const app = buildAppForRoute(
      makeErroringResponseWith(makeRevokedProxy()),
      "messages",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });
});

describe("forwardStreamTranslated — F2: hostile thrown value still yields a terminal frame", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(a) read-error Error whose name getter throws → upstream_error(502) + frame", async () => {
    const app = buildTranslatedAppWith(
      makeErroringResponseWith(makeThrowingNameError()),
      "messages",
      "f2-a-translated",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });

  it("(b) Proxy whose get trap throws, THROWN from the transform phase → internal_error(500) + frame", async () => {
    registerEncodeThrowRule(makeThrowingGetProxy());
    const snap = registrySnapshot("stream_event");
    const app = buildTranslatedAppWith(
      makeSingleEventResponse(),
      "messages",
      "f2-b-translated",
      [{ name: "t", use: "test_encode_throw_value" }],
      snap,
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    // isTransformPhaseError is now TOTAL: the hostile brand read no longer
    // escapes the catch — the throw is classified internal(500) with a frame.
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("(c) revoked Proxy read-error → upstream_error(502) + frame", async () => {
    const app = buildTranslatedAppWith(
      makeErroringResponseWith(makeRevokedProxy()),
      "messages",
      "f2-c-translated",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });
});

// ---- F3 (H2) — outcome monotonic for proven failures -----------------------

describe("forward-stream — F3: a later/coincident abort must not downgrade a proven failure", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(F3a) verbatim: abort DURING the injected-frame write keeps upstream_error(502), not 499", async () => {
    const ac = new AbortController();
    // "data: x" (no boundary) then clean EOF → done-branch truncation → the
    // done-branch sets upstream_error and writes the frame; the abort fires
    // inside that write.
    const upstream = makeChunkedResponse([new TextEncoder().encode("data: x")]);
    const { stream, writes } = makeAbortWhenFrameWritten(ac);
    const cb = forwardStream(mockCtxFromSignal(ac.signal), upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "messages",
    });
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(writes.join("")).toContain("event: error");
  });

  it("(F3a) translated: abort DURING the injected-frame write keeps upstream_error(502), not 499", async () => {
    const ac = new AbortController();
    const upstream = makeChunkedResponse([
      new TextEncoder().encode('event: a\ndata: {"par'),
    ]);
    const { stream, writes } = makeAbortWhenFrameWritten(ac);
    const cb = forwardStreamTranslated(
      mockCtxFromSignal(ac.signal),
      upstream,
      [],
      new Map(),
      "f3a-translated",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(writes.join("")).toContain("event: error");
  });

  it("(F3b) verbatim: a NON-abort throw coincident with a client abort → upstream_error(502), not masked as 499", async () => {
    const ac = new AbortController();
    const upstream = makeReaderRejectAfterFirst(
      new TextEncoder().encode("data: hi\n\n"),
      new Error("upstream socket reset"),
    );
    const { stream, writes } = makeAbortOnFirstWriteStream(() => ac.abort());
    const cb = forwardStream(mockCtxFromSignal(ac.signal), upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "messages",
    });
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    // The upstream failure IS surfaced (frame attempted) rather than swallowed.
    expect(writes.join("")).toContain("event: error");
  });

  it("(F3b) translated: a NON-abort throw coincident with a client abort → upstream_error(502), not masked as 499", async () => {
    const ac = new AbortController();
    const upstream = makeReaderRejectAfterFirst(
      new TextEncoder().encode('event: a\ndata: {"type":"a"}\n\n'),
      new Error("upstream socket reset"),
    );
    const { stream } = makeAbortOnFirstWriteStream(() => ac.abort());
    const cb = forwardStreamTranslated(
      mockCtxFromSignal(ac.signal),
      upstream,
      [],
      new Map(),
      "f3b-translated",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
  });

  it("(F3c) translated: a branded transform throw NAMED AbortError, coincident with a client abort, stays internal_error(500) — NOT masked as 499", async () => {
    // codex iter6 [3]'s exact trigger: during encode, `toJSON` aborts the client
    // signal AND throws an extensible Error whose `.name` is "AbortError". It is
    // brand-marked transform-phase (proven proxy-internal). The FIXED precedence
    // must classify it by its transform-phase BRAND (internal_error 500 + frame),
    // NOT by its abort-shaped name under the now-set abort flag. Pre-fix the abort
    // branch ran first → client_abort (499), frameless — a masked internal failure.
    const ac = new AbortController();
    registerStreamEvent(
      "test_abort_named_encode_throw",
      () => {
        const evt: AnyEvent = { type: "boom" };
        (evt as Record<string, unknown>)["toJSON"] = (): never => {
          ac.abort(); // client signal is aborted by the time the outer catch runs
          throw new DOMException("Aborted", "AbortError"); // extensible; name === "AbortError"
        };
        return { events_out: [evt], applied: true };
      },
      z.unknown(),
      { allow_override: true },
    );
    const snap = registrySnapshot("stream_event");
    const { stream, writes } = makeAbortOnFirstWriteStream(() => {});
    const cb = forwardStreamTranslated(
      mockCtxFromSignal(ac.signal),
      makeSingleEventResponse(),
      [{ name: "t", use: "test_abort_named_encode_throw" }],
      snap,
      "f3c-translated",
      { route: "/test", model: "test-model", metricRoute: "messages" },
    );
    await cb(stream);
    // Proven internal failure surfaced (frame written), NOT swallowed as 499.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBeUndefined();
    expect(writes.join("")).toContain("event: error");
  });

  it("(F3 control) verbatim: an ABORT-shaped throw coincident with a client abort stays client_abort(499)", async () => {
    const ac = new AbortController();
    const upstream = makeReaderRejectAfterFirst(
      new TextEncoder().encode("data: hi\n\n"),
      new DOMException("Aborted", "AbortError"),
    );
    const { stream } = makeAbortOnFirstWriteStream(() => ac.abort());
    const cb = forwardStream(mockCtxFromSignal(ac.signal), upstream, {
      route: "/test",
      model: "test-model",
      metricRoute: "messages",
    });
    await cb(stream);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---- F4 (H4) — EOF-held final multibyte surfaces as a truncation ------------

describe("forwardStreamTranslated — F4: EOF-held final multibyte surfaces as upstream_error", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("one complete event, then a lone 0xE2, then clean EOF → upstream_error(502) + frame", async () => {
    const app = buildTranslatedAppWith(
      makeChunkedResponse([
        new TextEncoder().encode('event: a\ndata: {"type":"a"}\n\n'),
        new Uint8Array([0xe2]), // start of a 3-byte codepoint; decoder holds it
      ]),
      "messages",
      "f4-multibyte",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
  });

  it("(control) healthy stream (complete final event, decoder drained) → NO frame, success(200)", async () => {
    const app = buildTranslatedAppWith(
      makeChunkedResponse([
        new TextEncoder().encode(
          'event: a\ndata: {"type":"a"}\n\nevent: b\ndata: {"type":"b"}\n\n',
        ),
      ]),
      "messages",
      "f4-healthy",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---- F5 (H5) — sawTerminal committed only after the terminal is delivered ---

describe("forward-stream — F5: an incomplete/failed terminal is NOT reported as success", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("(F5) verbatim: terminal MARKER line then read error BEFORE the boundary → upstream_error(502) + frame", async () => {
    // `event: message_stop\n` (marker, NO blank-line boundary) then a throw.
    // Pre-F5 the marker set sawTerminal → the read error was suppressed as
    // success(200). Now sawTerminal commits only at the boundary → 502 + frame.
    const app = buildAppForRoute(
      makeEmitThenThrow(
        "event: message_stop\n",
        new Error("socket died before the terminal boundary"),
      ),
      "messages",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("(F5) translated: terminal-event ENCODE failure → internal_error(500) + frame, NOT success(200)", async () => {
    registerStreamEvent(
      "test_terminal_encode_throw",
      () => {
        const evt: AnyEvent = { type: "message_stop" };
        (evt as Record<string, unknown>)["toJSON"] = (): never => {
          throw new Error("terminal encode boom");
        };
        return { events_out: [evt], applied: true };
      },
      z.unknown(),
      { allow_override: true },
    );
    const snap = registrySnapshot("stream_event");
    const app = buildTranslatedAppWith(
      makeSingleEventResponse(),
      "messages",
      "f5-encode-throw",
      [{ name: "t", use: "test_terminal_encode_throw" }],
      snap,
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    // sawTerminal is no longer set during .map() — the encode throw before the
    // write is surfaced as internal_error(500), not masked as success.
    expect(findParsedErrorFrame(text)).not.toBeNull();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "500",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "502",
      }),
    ).toBeUndefined();
  });
});

// ---- F6 (H5-chat) — translated chat [DONE] sentinel ------------------------

describe("forwardStreamTranslated — F6: chat [DONE] is forwarded + recognized as terminal", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("data:[DONE] on clean EOF is forwarded to the client + success(200), no error frame", async () => {
    const app = buildTranslatedAppWith(
      makeChunkedResponse([new TextEncoder().encode("data: [DONE]\n\n")]),
      "chat_completions",
      "f6-clean-done",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain('"error"');
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "502",
      }),
    ).toBeUndefined();
  });

  it("socket reset AFTER [DONE] → NO false chat error frame, success(200)", async () => {
    const app = buildTranslatedAppWith(
      makeEmitThenThrow(
        "data: [DONE]\n\n",
        new Error("socket reset after DONE"),
      ),
      "chat_completions",
      "f6-post-done-reset",
    );
    const resp = await app.request("/sse");
    const text = await collectClientBytes(resp);
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"error"');
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "200",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "chat_completions",
        status: "502",
      }),
    ).toBeUndefined();
  });
});
