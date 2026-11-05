/**
 * messages/handler.ts — POST /v1/messages keystone route.
 *
 * Anthropic-shape inbound. The thin handler per R39: auth gate → parse → route
 * match → applyRules(body_rules) → applyRules(header_rules) → token snapshot →
 * dispatch → forward / stream → catch-and-forward errors. The rules run BEFORE
 * dispatch because they are what may set the redirect marker.
 *
 * **Stage-1 auth gate (D-LOCK-2).** If `tokenManager.getStatus()` is not
 * `"ready"`, return 503 with the appropriate error type. The handler never
 * proceeds past this point unless the auth subsystem is ready.
 *
 * **Pipeline (in code order):**
 *   1. Auth gate: `getStatus()` not ready → 503.
 *   2. Parse JSON body; extract model.
 *   3. Find matching route by exact method + path + model_pattern.
 *   4. Build TransformContext { body, headers, route, model, harness: undefined }.
 *   5. If a route matched: take registry snapshot via snapshot("body"), apply
 *      BODY rules FIRST (D-LOCK-1), then HEADER rules. No route → 404 no_route.
 *   6. Snapshot the token; null → 503 auth_pending.
 *   7. Dispatch: a redirect marker set by the rules wins (dispatchMarker,
 *      D-LOCK-8; Lane 4 CC→GPT-5.x → /responses); otherwise dispatchRoute
 *      follows the matched route's `upstream` (Lane 1 CC→Claude →
 *      createAnthropicMessages with the beta deny list).
 *   8. Detect streaming via isStreamingResponse; non-stream → forwardUpstreamResponse.
 *   9. Streaming → pipe via Hono streamSSE (chosen pattern from D-LOCK-6 spike).
 *  10. Errors → forwardError.
 *
 * Mid-stream auth-error wire spec: per D-LOCK-7, upstream error frames are
 * forwarded VERBATIM and connection closes. Pre-stream 401-retry is handled
 * inside the service caller (Layer B).
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { TokenManager } from "~/auth/token-manager.ts";
import type { TraceWriter } from "~/lib/trace.ts";
import { bumpDispatchNoUpstream } from "~/lib/metrics.ts";
import { makeIncidentConfig } from "~/lib/incident-log.ts";
import { snapshot } from "~/lib/transform/registry.ts";
import { applyRules } from "~/lib/transform/apply.ts";
import type { TransformContext } from "~/lib/transform/types.ts";
import { checkAuthGate } from "~/routes/_shared/auth-gate.ts";
import { canonicalHeaders } from "~/routes/_shared/headers.ts";
import { deriveUpstreamSignal } from "~/routes/_shared/derive-upstream-signal.ts";
import {
  forwardError,
  forwardUpstreamResponse,
} from "~/routes/_shared/error-helpers.ts";
import { findMatchingRoute } from "~/routes/_shared/route-match.ts";
import {
  forwardStream,
  forwardStreamTranslated,
  requestBytesOf,
  type StreamCtxBase,
  type TraceMeta,
} from "~/routes/_shared/forward-stream.ts";
import {
  makeKeepAliveConfig,
  makeStallConfig,
} from "~/routes/_shared/stall-detect.ts";
import { dispatchStartedMsOf } from "~/routes/_shared/metrics-middleware.ts";
import { getRequestId } from "~/routes/_shared/request-id.ts";
import { stashInboundBody } from "~/routes/_shared/stash-inbound-body.ts";
import { isStreamingResponse } from "~/routes/_shared/streaming.ts";
import { dispatchRoute } from "~/routes/_shared/dispatcher.ts";
import { dispatchMarker } from "~/routes/_shared/marker-dispatch.ts";
import type { Config, Rule } from "~/types/config-schema.ts";

export interface MessagesHandlerDeps {
  config: Config;
  tokenManager: TokenManager;
  /** D37: endpoint family name from `config.endpoints`. */
  endpointName: string;
  /**
   * M12.5 H1: clean canonical Prometheus route label
   * (e.g. `messages`) used by stream metric emissions in forward-stream.
   * Distinct from `workingCtx.route` (which is the inbound HTTP path
   * `/v1/messages` consumed by stream-event predicates). server.ts wires
   * this from `ROUTE_LABEL_MAP[endpointName]`.
   */
  metricRoute: string;
}

export function makeMessagesHandler(
  deps: MessagesHandlerDeps,
): (c: Context) => Promise<Response> {
  const { config, tokenManager, endpointName, metricRoute } = deps;
  // D37: canonical inbound path = first entry in inbound_paths. Used as the
  // findMatchingRoute lookup key (handler normalizes alias paths to canonical
  // BEFORE route-match per D-LOCK-1 spec). For messages, only `/v1/messages`
  // is registered (no aliases); canonicalPath = "/v1/messages".
  const canonicalPath = config.endpoints[endpointName]?.inbound_paths[0];
  if (canonicalPath === undefined) {
    throw new Error(
      `messages handler: config.endpoints.${endpointName} is undefined or has no inbound_paths`,
    );
  }

  return async (c: Context): Promise<Response> => {
    // Stage-1 auth gate (D-LOCK-2). Extracted to a shared helper per
    // discriminator iter-1 M7 — same gate lives in all 5 protected handlers.
    const gateResp = checkAuthGate(c, tokenManager);
    if (gateResp !== null) return gateResp;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(
        {
          error: {
            type: "invalid_json",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        400,
      );
    }

    // Phase 5 v3.1 Group B (F-DISC-5) — stash inbound bytes for trace.
    // Helper handles BOTH the c.set indirection (consumed by with-trace.ts
    // for non-streaming) AND the streaming-side TraceMeta mutation (consumed
    // by forward-stream.ts emitTraceFlow). Without the helper's meta update,
    // streaming flows trace `body_kind: "empty"`. No-op when raw mode off.
    if (c.get("traceWriter") !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      stashInboundBody(c, bytes, "application/json");
    }

    const model =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : "";

    // Find matching route in config.
    const route = findMatchingRoute(
      config.routes,
      "POST",
      canonicalPath,
      model.length > 0 ? model : undefined,
    );

    // Build transform context.
    const inboundHeaders = canonicalHeaders(
      Object.fromEntries(c.req.raw.headers.entries()),
    );
    const ctx: TransformContext = {
      body,
      headers: inboundHeaders,
      route: canonicalPath,
      model,
      // harness detection deferred to M6+ (per D-LOCK-2 / spec H6).
      harness: undefined,
    };

    // Apply transform pipeline (only when a route matched + had rules).
    let workingCtx = ctx;
    if (route !== undefined) {
      try {
        const snap = snapshot("body");
        const bodyRules = (route.body_rules as ReadonlyArray<Rule>) ?? [];
        const headerRules = (route.header_rules as ReadonlyArray<Rule>) ?? [];
        // Body rules FIRST (D-LOCK-1, matches architecture.md:444-446).
        const afterBody = await applyRules(
          workingCtx,
          bodyRules as Rule[],
          snap,
        );
        workingCtx = afterBody.ctx;
        // Header rules SECOND.
        const afterHeader = await applyRules(
          workingCtx,
          headerRules as Rule[],
          snap,
        );
        workingCtx = afterHeader.ctx;
      } catch (err) {
        return forwardError(c, err);
      }
    }

    // No route configured → 404 no_route per spec § route-matching.
    if (route === undefined) {
      return c.json(
        {
          error: {
            type: "no_route",
            message: `No configured route for POST ${canonicalPath}${model.length > 0 ? ` model=${model}` : ""}`,
          },
        },
        404,
      );
    }

    // Dispatch.
    let upstream: Response;
    try {
      const tokenSnapshot = tokenManager.getTokenForRequest();
      if (tokenSnapshot === null) {
        return c.json(
          {
            error: {
              type: "auth_pending",
              message: "TokenManager initializing",
            },
          },
          503,
        );
      }

      // M9 D-LOCK-8: marker-driven dispatch runs FIRST. If body+header rules
      // set the `x-proxy-redirect-to` marker (M6/M8 redirect_to_* primitives),
      // the marker dispatcher selects the upstream service. If no marker,
      // `dispatchRoute` follows the matched route's `upstream` (shape + path);
      // for an `anthropic_messages` route it threads `config.anthropic_beta.deny`
      // to the classification-independent egress guard (Feature D1, Option 1).
      // Stream-side translation deferred to M10 per D-LOCK-8 stream-deferral.
      const dispatchDeps = {
        config,
        copilotToken: tokenSnapshot.token,
        accountType: config.auth.account_type,
        vsCodeVersion: config.auth.vs_code_version,
        signal: deriveUpstreamSignal(c),
        tokenManager,
      };
      const markerUpstream = await dispatchMarker(workingCtx, dispatchDeps);
      upstream =
        markerUpstream ??
        (await dispatchRoute(route, workingCtx, dispatchDeps));
    } catch (err) {
      // F159 — this arm is where a HEADER-PHASE failure lands, and it is the
      // only place that population is observable. `createAnthropicMessages`
      // throws `HTTPError` on any non-OK upstream, and `fetchWithLayerBRetry`
      // aborts on `AbortSignal.any([reqSignal, AbortSignal.timeout(…)])`, so
      // both the non-OK case and the 20-minute hang arrive here — never
      // reaching `forwardStream`, hence contributing to NEITHER first-byte
      // histogram nor `copilot_proxy_stream_no_first_byte_total`.
      // Deliberately NOT added to the pre-dispatch returns (400 invalid_json,
      // 404 no_route, 503 auth gate / auth_pending):
      // those never opened an upstream connection, so counting them would
      // inflate the denominator with requests that never attempted a stream.
      // They stay visible via `copilot_proxy_requests_total{route,status}`.
      bumpDispatchNoUpstream(metricRoute, workingCtx.model, err);
      return forwardError(c, err);
    }

    // Streaming detection (UPSTREAM is source of truth per iter-3 M1).
    if (isStreamingResponse(upstream)) {
      // Phase 5 v3.1 Group B — pull trace context off the per-request scope.
      // When level < raw the middleware never set these; the values are
      // undefined and forward-stream's emitTraceFlow no-ops.
      const traceWriter = c.get("traceWriter") as TraceWriter | undefined;
      const traceMeta = c.get("traceMeta") as TraceMeta | undefined;
      const streamBufferMb = config.logging.stream_buffer_mb;
      const stall = makeStallConfig(config.logging.stall_detection);
      // F165 — the keep-alive. `stall` is passed as the SECOND argument so the
      // D96 refusal (no keep-alive without a detector behind it) is structural
      // rather than a convention each of the three handlers has to remember.
      const keepAlive = makeKeepAliveConfig(config.logging.keep_alive, stall);
      // D96 Phase 1 — always-on incident log. A SIBLING of `logging.level`,
      // never a child of it: the fleet runs at the default level, so a record
      // gated behind `raw` is blind exactly when it is needed (F138).
      const incident = makeIncidentConfig(config.logging.incident_log);
      // Read from `content-length`, not by re-serializing the body — see
      // `requestBytesOf`. Absent header → field omitted, never guessed.
      const requestBytes = requestBytesOf(c);
      // F159 — the end-to-end clock stamped by `withMetrics` at request entry.
      // Read through the exported helper, never by spelling the context key:
      // `c.get` is untyped here, so a typo would yield `undefined` and the
      // sample would vanish silently.
      const dispatchStartedMs = dispatchStartedMsOf(c);
      // (F-DISC-7) flag the response as streaming so the non-streaming
      // middleware path skips the second write attempt.
      c.set("traceStreaming", true);

      // M10 D-LOCK-7 — choose forwarder per-route. Non-empty
      // `stream_event_rules` → translated path (decode → applyEvent →
      // re-encode); empty → verbatim byte path (forwardStream, M5 H1).
      // Snapshot the stream-event registry at request time (NOT at module
      // load) so config hot-reload picks up rule changes mid-process.
      // Join key — resolved ONCE, for BOTH forwarder paths, and threaded into
      // ctxBase regardless of `logging.level`. This previously lived inside the
      // translated branch only, so the VERBATIM path — Lane 1, i.e. every Claude
      // Code session — carried no id and every diagnostic in forward-stream.ts
      // degraded to the literal `<unknown>`, making proxy logs unjoinable to
      // anything client-side. `getRequestId` adopts an inbound `x-request-id`
      // when present, so a client that sets one gets an exact join for free.
      const requestId = getRequestId(c);

      // M2 (D100) — ONE `StreamCtxBase` per handler, shared by both forwarder
      // branches. This was two byte-identical ten-field literals, and the same
      // duplication existed in all three handlers: six copies of one shape, i.e.
      // six chances for the Phase 2 edit to add a field to five of them.
      // The `: StreamCtxBase` annotation is LOAD-BEARING, not decoration — see
      // the interface's own docblock in `forward-stream.ts` for why.
      //
      // C1 fix: `route` + `model` come from the matched route so per-event
      // predicates (`when: { route: "..." }`) match correctly.
      // M12.5 H1: `metricRoute` is the clean Prometheus label; `route` stays the
      // inbound HTTP path those predicates consume.
      // Phase 5 v3.1 Group B: trace ctx + buffer cap, so the streaming forwarder
      // owns the trace write.
      const streamCtx: StreamCtxBase = {
        route: workingCtx.route,
        model: workingCtx.model,
        metricRoute,
        traceWriter,
        traceMeta,
        streamBufferMb,
        stall,
        keepAlive,
        requestId,
        incident,
        requestBytes,
        dispatchStartedMs,
      };

      if (route.stream_event_rules.length > 0) {
        const streamEventSnap = snapshot("stream_event");
        return streamSSE(
          c,
          forwardStreamTranslated(
            c,
            upstream,
            route.stream_event_rules as Rule[],
            streamEventSnap,
            requestId,
            streamCtx,
          ),
        );
      }
      // forwardStream forwards bytes verbatim (D-LOCK-7) with proper reader
      // cleanup on client abort (per iter-1 H1).
      return streamSSE(c, forwardStream(c, upstream, streamCtx));
    }

    return forwardUpstreamResponse(c, upstream);
  };
}
