/**
 * metrics-middleware.ts — `withMetrics(routeName, handler)` wrapper.
 *
 * **M12 Group A § 2.** Wraps every route handler in a thin observability
 * shim that:
 *   - On entry: stamps the F159 dispatch clock into the per-request context
 *     (`DISPATCH_STARTED_MS_KEY`) and increments the
 *     `copilot_proxy_inflight_requests{route}` gauge.
 *   - On exit (success OR throw, NON-STREAM only): decrements the inflight
 *     gauge, increments `copilot_proxy_requests_total{route, status}`, and
 *     adds the response `content-length` (when present + numeric) to
 *     `copilot_proxy_response_bytes_total{route}`.
 *
 * **The dispatch clock is WRITTEN here and never read here.** This middleware
 * observes no histogram. The stamp exists so a handler can thread it into
 * `StreamCtxBase.dispatchStartedMs`, where `forward-stream.ts` turns it into a
 * `copilot_proxy_dispatch_first_byte_seconds` sample at stream completion —
 * an end-to-end origin that, unlike the forwarder's own, includes the upstream
 * header phase.
 *
 * **Stream byte counts are NOT wired here.** The middleware sees the
 * `Response` object but not the streamed body — `forward-stream.ts` owns
 * per-chunk byte counting + per-event SSE counting.
 *
 * **`/metrics` short-circuit (per D38 iter-1 M2 fix MANDATE).** When
 * `routeName === "metrics"`, the middleware passes through to the inner
 * handler WITHOUT touching any metric. Rationale: Prometheus scrapes are
 * constant-rate background traffic; counting them inflates noise + creates
 * a feedback loop with `/metrics` body size.
 *
 * **M12.5 H2 — stream-lifecycle ownership split.** The handler returns a
 * `Response` synchronously (Hono's `streamSSE` resolves the Response after
 * headers are flushed; the async stream callback continues writing in the
 * background). For NON-stream responses, the wrapper's `finally` block has
 * the right lifecycle (handler resolved => response complete => decrement
 * + record). For STREAM responses, the `finally` block fires within
 * milliseconds of stream start — the inflight gauge would decrement
 * immediately, undercounting in-flight streams by orders of magnitude.
 *
 * Detection: `response.headers["content-type"]` includes
 * `text/event-stream` (case-insensitive substring match to handle
 * `text/event-stream; charset=utf-8`).
 *
 * For streams: the wrapper SKIPS the inflight decrement + requests_total
 * increment in `finally`. `forward-stream.ts`'s `finally` (which fires
 * only after the stream actually completes — client drains, abort, or
 * upstream close) owns those updates instead. The entry-side inflight
 * INCREMENT stays here so a stream that errors before
 * forward-stream.ts's finally runs still has a non-orphaned baseline
 * (forward-stream.ts uses `Math.max(0, prior - 1)` so a double-decrement
 * also stays non-negative).
 */

import type { Context } from "hono";

import { getValueForTests, incCounter, setGauge } from "~/lib/metrics.ts";

const INFLIGHT = "copilot_proxy_inflight_requests";
const REQUESTS_TOTAL = "copilot_proxy_requests_total";
const RESPONSE_BYTES_TOTAL = "copilot_proxy_response_bytes_total";

/**
 * Per-request context key holding the dispatch clock (F159).
 *
 * EXPORTED, and the reader below with it, so no handler ever spells the string.
 * `c.set`/`c.get` are untyped in this repo — there is no `ContextVariableMap`
 * augmentation, and every read is a bare cast — so a key typo yields
 * `undefined` silently and the sample simply vanishes. Making the mistake
 * unavailable is the same lesson D100/M2 recorded about the load-bearing
 * `: StreamCtxBase` annotation. `requestBytesOf(c)` in `forward-stream.ts` is
 * the existing precedent for a shared context-reader helper.
 */
export const DISPATCH_STARTED_MS_KEY = "dispatchStartedMs";

/**
 * Read the dispatch clock stamped by {@link withMetrics}, or `undefined` when
 * it is absent or not a usable number. Handlers thread the result into
 * `StreamCtxBase.dispatchStartedMs`; `forward-stream.ts` treats an absent
 * value as a DEFECT (counted by `copilot_proxy_dispatch_anchor_missing_total`),
 * never as a supported mode.
 */
export function dispatchStartedMsOf(c: Context): number | undefined {
  const v: unknown = c.get(DISPATCH_STARTED_MS_KEY);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** True only for a *live* SSE stream whose inflight-decrement +
 * requests_total are deferred to `forward-stream.ts`'s completion
 * `finally`. Requires BOTH a 2xx status AND a `text/event-stream`
 * content-type (case-insensitive substring match, handling
 * `text/event-stream; charset=utf-8` and similar variants).
 *
 * The status gate is load-bearing: a NON-OK response carrying
 * `text/event-stream` is a fully-buffered error body produced by
 * `forwardError`, not a live stream. The service layer throws `HTTPError`
 * on any non-OK upstream, so the live-stream lane is never entered for
 * non-2xx — there is no `forward-stream.ts` `finally` to own the
 * decrement. Treating such a buffered error as a stream would defer the
 * decrement to a callback that never runs, permanently leaking the
 * inflight gauge (+1 per non-OK SSE error) and dropping its
 * `requests_total` sample. The wrapper must own those updates here. */
function isStreamResponse(response: Response | undefined): boolean {
  if (response === undefined) return false;
  if (!response.ok) return false;
  const ct = response.headers.get("content-type") ?? "";
  return ct.toLowerCase().includes("text/event-stream");
}

/**
 * Wrap a Hono handler in observability instrumentation. Returns a new
 * handler with identical behavior plus metric side effects.
 *
 * Per spec: routeName MUST be a clean canonical name (no underscores in
 * the route label value); call sites map endpoint family names like
 * `anthropic_messages` → `messages`.
 */
export function withMetrics(
  routeName: string,
  handler: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c: Context): Promise<Response> => {
    // `/metrics` short-circuit: no inflight gauge, no requests_total, no
    // response_bytes_total. (Per D38 iter-1 M2 fix MANDATE.)
    if (routeName === "metrics") {
      return handler(c);
    }

    // F159 — the dispatch clock. This is the EARLIEST instant at which a
    // request is observable in this process: it precedes `checkAuthGate` and
    // `await c.req.json()`, so the upload time of a 250 KB-5 MB body is inside
    // the measurement (request size is the retry-spiral hypothesis). Stamped
    // ONCE here rather than in three handlers, and read by whichever handler
    // goes on to open a stream; the two non-streaming families (embeddings,
    // models) get a stamp nobody reads, which costs one `performance.now()`
    // and one map write per request. Placed AFTER the short-circuit so
    // `/metrics` scrapes pay nothing. This middleware WRITES the value and
    // never reads it — see `dispatchStartedMsOf`.
    c.set(DISPATCH_STARTED_MS_KEY, performance.now());

    // Increment inflight gauge.
    const priorInflight = getValueForTests(INFLIGHT, { route: routeName }) ?? 0;
    setGauge(INFLIGHT, priorInflight + 1, { route: routeName });

    let response: Response | undefined;
    let status = "0"; // sentinel for thrown-before-response
    try {
      response = await handler(c);
      status = String(response.status);
      // Response body byte count from content-length header (non-stream
      // path; streams are counted separately in forward-stream.ts).
      const cl = response.headers.get("content-length");
      if (cl !== null) {
        const n = Number.parseInt(cl, 10);
        if (Number.isFinite(n) && n >= 0) {
          incCounter(RESPONSE_BYTES_TOTAL, n, { route: routeName });
        }
      }
      return response;
    } catch (err) {
      // Re-throw after recording the error in metrics. Handlers in this
      // codebase rarely throw (they `return forwardError(c, err)`), but
      // the wrapper is defense-in-depth.
      status = "exception";
      throw err;
    } finally {
      // M12.5 H2 — defer inflight decrement + requests_total to
      // forward-stream.ts when the response is an SSE stream. The handler
      // returned the Response synchronously after `streamSSE` flushed
      // headers, but the async stream callback is still writing — running
      // the decrement here would set inflight back to zero within ms of
      // stream start (the bug the discriminator caught). For non-stream
      // (and for thrown-before-response cases where status === "exception"
      // and response is undefined), the wrapper still owns the lifecycle.
      const isStream = isStreamResponse(response);
      if (!isStream) {
        const inflight = getValueForTests(INFLIGHT, { route: routeName }) ?? 1;
        setGauge(INFLIGHT, Math.max(0, inflight - 1), { route: routeName });
        incCounter(REQUESTS_TOTAL, 1, { route: routeName, status });
      }
      // For streams: forward-stream.ts owns inflight decrement +
      // requests_total in its `finally` (where it has the actual stream-
      // completion lifecycle).
    }
  };
}
