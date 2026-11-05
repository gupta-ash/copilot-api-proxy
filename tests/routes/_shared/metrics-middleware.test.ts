/**
 * metrics_middleware.test.ts — `withMetrics` wrapper coverage.
 *
 * Tests the wrapper in isolation against a fake handler — does NOT depend
 * on the /metrics endpoint mount (which lands with M12 D-LOCK-4). Asserts:
 *   - inflight gauge increments on entry, decrements on exit.
 *   - requests_total increments with status label.
 *   - response_bytes_total picks up content-length when present.
 *   - /metrics route short-circuits (per D38 iter-1 M2 mandate).
 *   - thrown handlers still record requests_total + decrement inflight.
 *   - (M12.5 H2) stream-Content-Type response DEFERS the inflight
 *     decrement + requests_total increment to forward-stream.ts (the
 *     middleware MUST NOT touch them in `finally` for streams).
 *   - (F159) the dispatch clock is stamped once, before the handler body,
 *     and never on the `/metrics` short-circuit.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { getValueForTests, resetForTests } from "../../../src/lib/metrics.ts";
import {
  dispatchStartedMsOf,
  withMetrics,
} from "../../../src/routes/_shared/metrics-middleware.ts";

beforeEach(() => {
  resetForTests();
});
afterEach(() => {
  resetForTests();
});

describe("withMetrics — basic accounting", () => {
  it("increments requests_total{route, status} on success", async () => {
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async (c) => c.json({ ok: true }, 200)),
    );
    const r = await app.request("/foo");
    expect(r.status).toBe(200);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
  });

  it("increments response_bytes_total when content-length present", async () => {
    const body = '{"ok":true}';
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async () => {
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
        });
      }),
    );
    const r = await app.request("/foo");
    expect(r.status).toBe(200);
    expect(
      getValueForTests("copilot_proxy_response_bytes_total", {
        route: "messages",
      }),
    ).toBe(body.length);
  });

  it("returns inflight to 0 after handler completes", async () => {
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async (c) => c.json({ ok: true }, 200)),
    );
    await app.request("/foo");
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(0);
  });

  it("status label captures non-200 codes (503)", async () => {
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async (c) => c.json({ error: "boom" }, 503)),
    );
    await app.request("/foo");
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "503",
      }),
    ).toBe(1);
  });
});

describe("withMetrics — thrown-handler resilience", () => {
  it("decrements inflight + records exception status when handler throws", async () => {
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async () => {
        throw new Error("boom");
      }),
    );
    // Hono surfaces handler throws as 500; we don't care about the
    // response here, only the metrics side effects.
    try {
      await Promise.resolve(app.request("/foo"));
    } catch {
      /* may throw via hono's onError — irrelevant */
    }
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "exception",
      }),
    ).toBe(1);
  });
});

describe("withMetrics — /metrics short-circuit", () => {
  it("does NOT touch requests_total{route='metrics'}", async () => {
    const app = new Hono();
    app.get(
      "/metrics",
      withMetrics(
        "metrics",
        async () =>
          new Response("metrics body", {
            status: 200,
            headers: { "content-type": "text/plain; version=0.0.4" },
          }),
      ),
    );
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/metrics");
      expect(r.status).toBe(200);
    }
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "metrics",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("does NOT touch inflight{route='metrics'}", async () => {
    const app = new Hono();
    app.get(
      "/metrics",
      withMetrics(
        "metrics",
        async () => new Response("metrics body", { status: 200 }),
      ),
    );
    await app.request("/metrics");
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "metrics",
      }),
    ).toBeUndefined();
  });
});

describe("withMetrics — M12.5 H2 stream lifecycle deferral", () => {
  it("DEFERS inflight decrement + requests_total when response is text/event-stream", async () => {
    const app = new Hono();
    app.get(
      "/sse",
      withMetrics(
        "messages",
        async () =>
          new Response("data: hello\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const r = await app.request("/sse");
    expect(r.status).toBe(200);
    // Drain the body so the wrapper's `finally` runs.
    await r.text();
    // The middleware INCREMENTED inflight on entry to 1, but MUST NOT
    // decrement it back on exit (forward-stream.ts owns the decrement
    // when the handler is a real streamSSE flow). In this synthetic test
    // there is no forward-stream consumer, so inflight stays at 1 — that
    // is exactly the point: the middleware proved it deferred ownership.
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(1);
    // requests_total MUST be absent (forward-stream owns it for streams).
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("treats text/event-stream with charset suffix as a stream", async () => {
    const app = new Hono();
    app.get(
      "/sse",
      withMetrics(
        "messages",
        async () =>
          new Response("data: hello\n\n", {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
            },
          }),
      ),
    );
    const r = await app.request("/sse");
    await r.text();
    // Inflight stays at 1 (deferred); requests_total absent.
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBeUndefined();
  });

  it("non-stream Content-Type still owns the lifecycle (regression guard)", async () => {
    const app = new Hono();
    app.get(
      "/json",
      withMetrics(
        "messages",
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await app.request("/json");
    // Non-stream: middleware owns lifecycle — inflight returns to 0 +
    // requests_total recorded.
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
  });
});

/**
 * F159 — the dispatch clock.
 *
 * `copilot_proxy_dispatch_first_byte_seconds` is only end-to-end if its origin
 * is stamped BEFORE the handler body runs. The stamp lives in this wrapper for
 * exactly that reason: the handler body already contains `checkAuthGate` and
 * `await c.req.json()`, so an origin taken inside it would exclude the upload
 * of a multi-megabyte request body — which is the retry-spiral hypothesis the
 * new series exists to test.
 */
describe("withMetrics — F159 dispatch clock", () => {
  it("stamps the clock BEFORE the wrapped handler body runs", async () => {
    const HANDLER_WORK_MS = 40;
    let stamp: number | undefined;
    let afterHandlerWork = 0;

    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async (c) => {
        await new Promise((resolve) => setTimeout(resolve, HANDLER_WORK_MS));
        stamp = dispatchStartedMsOf(c);
        afterHandlerWork = performance.now();
        return c.json({ ok: true }, 200);
      }),
    );
    await app.request("/foo");

    expect(typeof stamp).toBe("number");
    // The 40 ms the handler spent is INSIDE the measured interval. Moving the
    // `c.set` into the handler body collapses this delta to ~0; moving it below
    // `await handler(c)` makes the read `undefined` and the assert above fails.
    expect(afterHandlerWork - (stamp ?? 0)).toBeGreaterThanOrEqual(
      HANDLER_WORK_MS - 5,
    );
  });

  it("reads the SAME value on both sides of an await — it is never re-stamped", async () => {
    let first: number | undefined;
    let second: number | undefined;
    const app = new Hono();
    app.get(
      "/foo",
      withMetrics("messages", async (c) => {
        first = dispatchStartedMsOf(c);
        await new Promise((resolve) => setTimeout(resolve, 10));
        second = dispatchStartedMsOf(c);
        return c.json({ ok: true }, 200);
      }),
    );
    await app.request("/foo");

    expect(first).toBeDefined();
    // A reader that stamped lazily on first read, or re-stamped per read, would
    // make these differ — and the histogram's origin would then depend on which
    // handler line happened to read it.
    expect(second).toBe(first);
  });

  it("does NOT stamp on the /metrics short-circuit", async () => {
    let stamp: number | undefined;
    const app = new Hono();
    app.get(
      "/metrics",
      withMetrics("metrics", async (c) => {
        stamp = dispatchStartedMsOf(c);
        return c.text("ok", 200);
      }),
    );
    await app.request("/metrics");
    // The short-circuit's contract is that a scrape touches NOTHING. Hoisting
    // the stamp above it would be invisible to every other test in this file.
    expect(stamp).toBeUndefined();
  });
});
