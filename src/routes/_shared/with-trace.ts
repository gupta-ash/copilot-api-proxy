/**
 * with-trace.ts — Phase 5 v3.1 Group B middleware (non-streaming side).
 *
 * Wraps a per-route handler such that:
 *   1. **Before handler:** capture inbound (method/url/host/path/headers/
 *      content-type/startedAt) and stash a `TraceMeta` plus the active
 *      `TraceWriter` on the Hono per-request context (`c.set("traceMeta",
 *      ...)`, `c.set("traceWriter", ...)`). The handler reads them back via
 *      `c.get("traceMeta")` / `c.get("traceWriter")` and threads them into
 *      `forward-stream.ts`'s `StreamCtxBase` so streaming responses also
 *      pick up the writer.
 *   2. **After handler (streaming case):** if `c.get("traceStreaming") === true`
 *      OR `response.headers.get("content-type")?.includes("event-stream") ===
 *      true` (F-DISC-7 "lite" content-type fallback), skip — the streaming
 *      forwarders own the trace write.
 *   3. **After handler (non-streaming case):** if `response.body?.locked` is
 *      true (F-DISC-6 — body already drained by the framework), log a
 *      `consola.warn` and skip (do NOT throw). Otherwise `response.clone()`,
 *      await `arrayBuffer()`, classify via `classifyBody`, build a
 *      metadata-only `FlowRecord`, and fire-and-forget
 *      `traceWriter.write(flow, inboundBody, outBytes)` — the writer
 *      serializes the manifest .json plus the raw .req + .res sidecar
 *      files (Phase 6). Success ticks
 *      `bumpTraceWrites("success", manifestBytes + reqBytes + resBytes)`;
 *      failure ticks `bumpTraceWrites("error", undefined,
 *      classifyTraceError(err))` plus surfaces a `consola.warn` ONCE per
 *      process (subsequent failures are silent at log level — the
 *      Prometheus counter still ticks).
 *
 * **Body-stash pattern (F-DISC-5).** The middleware NEVER calls
 * `c.req.raw.clone()` — under Bun + Node v24 the streaming-body clone is
 * unreliable (drops bytes / locks unpredictably; see plan § F-DISC-5). Each
 * of the 5 protected handlers MUST call `c.set("inboundBody", bytes)` plus
 * `c.set("inboundContentType", ct)` AFTER it parses the body. The middleware
 * reads from `c.get(...)`. For GET routes (e.g. /v1/models) the handler
 * leaves the body unset; the middleware emits `kind: "empty"`.
 *
 * **Failure throttle.** A module-private `firstFailureReported` flag gates
 * the first `consola.warn` per process. `_resetFirstFailureForTests()` is
 * exported for test isolation (mirrors the same pattern in
 * `forward-stream.ts`). Production code MUST NOT call the reset.
 *
 * **Type safety / Hono Variables.** The codebase has no central `declare
 * module "hono"` augmentation today (see derive-upstream-signal.ts +
 * request-id.ts which both use `as` casts at the read site). We follow the
 * same pattern here so this group does not perturb every other consumer of
 * `c.get`. Future consolidation can lift the keys into a shared `Variables`
 * augmentation.
 */

import type { Context } from "hono";
import consola from "consola";

import { LEVEL_RAW, debug } from "~/lib/debug.ts";
import { bumpTraceWrites, classifyTraceError } from "~/lib/metrics.ts";
import {
  classifyBody,
  type FlowRecord,
  type TraceWriter,
} from "~/lib/trace.ts";
import type { TraceMeta } from "~/routes/_shared/forward-stream.ts";

// ---------------------------------------------------------------------------
// First-failure throttle (mirrors forward-stream.ts).
// ---------------------------------------------------------------------------

let firstFailureReported = false;

function reportFirstFailure(err: unknown, requestId: string): void {
  if (firstFailureReported) return;
  firstFailureReported = true;
  consola.warn(
    `trace: first write failure (request ${requestId}); subsequent failures will be silent — see copilot_proxy_trace_errors_total: ${String(err)}`,
  );
}

/**
 * TEST-ONLY reset for the first-failure throttle. Mirrors
 * `forward-stream.ts § _resetFirstFailureForTests` so test files that
 * exercise both surfaces can clear both throttles between tests. Production
 * code MUST NOT call this.
 */
export function _resetFirstFailureForTests(): void {
  firstFailureReported = false;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Wrap a Hono handler so non-streaming responses are persisted as flow
 * records. Streaming responses pass through untouched (their forwarders own
 * the write per Group C). Failure paths are throttled at the first
 * `consola.warn` per process; the Prometheus counter still ticks via
 * `bumpTraceWrites("error", ...)`.
 *
 * Composition order (per spec § server.ts wiring): callers should compose
 * `withTrace` INSIDE `withMetrics` so metrics see all requests AND trace
 * runs in the same scope:
 *
 *   const wrapped = withMetrics(routeLabel, withTrace(writer, route, handler));
 */
export function withTrace(
  traceWriter: TraceWriter,
  routeLabel: string,
  handler: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c: Context): Promise<Response> => {
    // ── Dynamic logging toggle — live gate. Read the level ONCE at request
    // start (snapshot semantics: an in-flight request keeps this decision even
    // if the level flips mid-flight). Only at >= raw do we set the trace
    // context vars + run the non-streaming clone+write below. Below raw this
    // middleware is a pure passthrough: it sets NO context vars (not even
    // requestId), so the handler threads `undefined` into the streaming
    // forwarder → `traceEnabled` stays false → no per-chunk buffering, no
    // write. Byte-identical to the pre-toggle behavior where withTrace was not
    // composed at all below raw.
    const active = debug.getLevel() >= LEVEL_RAW;

    // TraceMeta is built + stashed on the context ONLY when active. Declared in
    // the outer scope so the non-streaming write path (reached only when
    // active) can read it back; the `meta === undefined` guard below both
    // enforces the gate and narrows the type for that path.
    let meta: TraceMeta | undefined;
    if (active) {
      // Build TraceMeta with the SAME shape forward-stream.ts consumes so
      // streaming + non-streaming paths align (Group C owns the canonical type).
      const startedAt = Date.now();
      const cachedRequestId = c.get("requestId") as string | undefined;
      const requestId =
        typeof cachedRequestId === "string" && cachedRequestId.length > 0
          ? cachedRequestId
          : crypto.randomUUID();
      // Cache the resolved id so getRequestId() inside the handler returns
      // the same value (avoids drift between stream/trace/state lookups).
      if (cachedRequestId === undefined) {
        c.set("requestId", requestId);
      }

      const url = c.req.url;
      let host: string;
      let urlPath: string;
      try {
        const u = new URL(url);
        host = u.host;
        urlPath = u.pathname;
      } catch {
        host = "";
        urlPath = c.req.path;
      }
      const inboundHeaders = Object.fromEntries(c.req.raw.headers.entries());
      const inboundContentType = c.req.header("content-type") ?? "";
      meta = {
        requestId,
        method: c.req.method,
        url,
        host,
        path: urlPath,
        inboundHeaders,
        inboundBody: null, // handler will replace via c.set("inboundBody", ...)
        inboundContentType,
        startedAt,
      };
      c.set("traceWriter", traceWriter);
      c.set("traceMeta", meta);
    }

    const response = await handler(c);

    // F-DISC-7 "lite": skip the non-streaming write path when EITHER the
    // handler explicitly flagged the response as a stream (`traceStreaming`),
    // OR the response Content-Type advertises an event-stream. The
    // forwarders own the write in that case.
    const traceStreamingFlag = c.get("traceStreaming");
    const ctHeader = response.headers.get("content-type") ?? "";
    const isStreaming =
      traceStreamingFlag === true ||
      ctHeader.toLowerCase().includes("event-stream");
    if (isStreaming) return response;

    // ── Dynamic logging toggle — below raw this middleware is a passthrough:
    // no trace context was set, so skip the non-streaming clone+write. (`meta`
    // is defined iff `active`; the `=== undefined` check also narrows the type
    // so the write path below can dereference it.)
    if (!active || meta === undefined) return response;

    // F-DISC-6 defensive guard: if the response body is already locked
    // (some other consumer is draining it — should never happen for a
    // non-stream response in this codebase, but defense-in-depth), log a
    // warn and skip rather than throwing into the request path.
    if (response.body !== null && response.body.locked) {
      consola.warn(
        `trace: response body locked at trace-write time; skip route=${routeLabel} requestId=${meta.requestId}`,
      );
      return response;
    }

    // Pull the inbound body that the handler stashed. GET routes leave it
    // unset; we emit kind: "empty" in that case.
    const inboundBody = c.get("inboundBody") as Uint8Array | undefined;
    const inboundCt =
      (c.get("inboundContentType") as string | undefined) ??
      meta.inboundContentType;

    // Clone + drain the response body. For a JSON / text 200 the body is
    // small; for an empty body (204 etc.) arrayBuffer() resolves with a
    // zero-length buffer.
    let outBytes: Uint8Array;
    try {
      const cloned = response.clone();
      outBytes = new Uint8Array(await cloned.arrayBuffer());
    } catch (err) {
      // Defense-in-depth: if clone() or arrayBuffer() throws (Bun-on-Node
      // edge case), surface via the standard error path so the metric
      // counter ticks and the operator sees the first warn — but do NOT
      // re-throw into the request path.
      bumpTraceWrites("error", undefined, classifyTraceError(err));
      reportFirstFailure(err, meta.requestId);
      return response;
    }

    // Phase 6: classifyBody returns kind only (no body inlining); raw bytes
    // go to the .req/.res sidecar via TraceWriter.write. SSE detection logic
    // is preserved verbatim from Phase 5's summarizeBody.
    const inboundBytesForWrite = inboundBody ?? new Uint8Array(0);
    const inClassified = classifyBody(inboundBytesForWrite, inboundCt);
    const outClassified = classifyBody(outBytes, ctHeader);

    const flow: FlowRecord = {
      captured_at: meta.startedAt / 1000,
      request: {
        method: meta.method,
        url: meta.url,
        host: meta.host,
        path: meta.path,
        headers: meta.inboundHeaders,
        body_kind: inClassified.kind,
        // body_path overwritten by TraceWriter.write to the sidecar basename.
        body_path: null,
        body_bytes: inboundBytesForWrite.length,
        // Non-streaming path: handlers stash the FULL inbound body via the
        // body-stash pattern (no cap), and we drained the FULL outBytes via
        // response.clone().arrayBuffer() — both bodies are byte-complete.
        body_truncated: false,
      },
      response: {
        status: response.status,
        // Hono's Response doesn't expose statusText reliably across the srvx
        // wrap; leave empty (matches the verification capture-addon expected
        // shape — `reason` is allowed to be empty).
        reason: "",
        headers: Object.fromEntries(response.headers.entries()),
        body_kind: outClassified.kind,
        body_path: null,
        body_bytes: outBytes.length,
        body_truncated: false,
        ...(outClassified.summary !== undefined
          ? { body_summary: outClassified.summary }
          : {}),
      },
    };

    // Pre-compute the bytes-to-disk count so the success metric reflects
    // actual disk usage = manifest + .req + .res sidecars. The manifest is
    // small (metadata only); sidecars dominate for SSE / large JSON payloads.
    const manifestBytes = JSON.stringify(flow).length;
    const approxBytes =
      manifestBytes + inboundBytesForWrite.length + outBytes.length;

    // Capture the request id in a const for the fire-and-forget .catch closure
    // below (a closure does not inherit the `let meta` non-undefined narrowing).
    const traceRequestId = meta.requestId;

    // Fire-and-forget: the writer's promise resolves async. We never await
    // it so trace I/O cannot block the response path that already returned
    // headers + body to the client.
    traceWriter
      .write(flow, inboundBytesForWrite, outBytes)
      .then(() => {
        bumpTraceWrites("success", approxBytes);
      })
      .catch((err: unknown) => {
        bumpTraceWrites("error", undefined, classifyTraceError(err));
        reportFirstFailure(err, traceRequestId);
      });

    return response;
  };
}
