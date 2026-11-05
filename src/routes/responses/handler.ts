/**
 * responses/handler.ts — POST /responses Codex inbound.
 *
 * Same dispatch pattern as the messages handler: a redirect marker set by the
 * matched route's rules wins (Lane 5, Codex→Claude → /v1/messages); otherwise
 * `dispatchRoute` sends the request where the matched route's `upstream` says
 * (Lane 2, Codex→GPT-5 / GPT-6 → /responses passthrough).
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

export interface ResponsesHandlerDeps {
  config: Config;
  tokenManager: TokenManager;
  /** D37: endpoint family name from `config.endpoints`. */
  endpointName: string;
  /**
   * M12.5 H1: clean canonical Prometheus route label
   * (e.g. `responses`) used by stream metric emissions in forward-stream.
   * Distinct from `workingCtx.route` (inbound HTTP path consumed by
   * predicates). server.ts wires from `ROUTE_LABEL_MAP[endpointName]`.
   */
  metricRoute: string;
}

export function makeResponsesHandler(
  deps: ResponsesHandlerDeps,
): (c: Context) => Promise<Response> {
  const { config, tokenManager, endpointName, metricRoute } = deps;
  // D37: canonical = first inbound_paths entry; alias `/v1/responses` resolves
  // to `/responses` BEFORE findMatchingRoute (D-LOCK-1).
  const canonicalPath = config.endpoints[endpointName]?.inbound_paths[0];
  if (canonicalPath === undefined) {
    throw new Error(
      `responses handler: config.endpoints.${endpointName} is undefined or has no inbound_paths`,
    );
  }

  return async (c: Context): Promise<Response> => {
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

    const route = findMatchingRoute(
      config.routes,
      "POST",
      canonicalPath,
      model.length > 0 ? model : undefined,
    );

    const inboundHeaders = canonicalHeaders(
      Object.fromEntries(c.req.raw.headers.entries()),
    );
    let workingCtx: TransformContext = {
      body,
      headers: inboundHeaders,
      route: canonicalPath,
      model,
      harness: undefined,
    };

    if (route !== undefined) {
      try {
        const snap = snapshot("body");
        const bodyRules = (route.body_rules as ReadonlyArray<Rule>) ?? [];
        const headerRules = (route.header_rules as ReadonlyArray<Rule>) ?? [];
        const afterBody = await applyRules(
          workingCtx,
          bodyRules as Rule[],
          snap,
        );
        workingCtx = afterBody.ctx;
        const afterHeader = await applyRules(
          workingCtx,
          headerRules as Rule[],
          snap,
        );
        workingCtx = afterHeader.ctx;
      } catch (err) {
        return forwardError(c, err);
      }
    } else {
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
      // `dispatchRoute` follows the matched route's `upstream` (shape + path).
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
      // F159 — the header-phase population, observable only here. See the
      // matching arm in `messages/handler.ts` for why the pre-dispatch returns
      // (400 / 404 / 503) are deliberately NOT counted.
      bumpDispatchNoUpstream(metricRoute, workingCtx.model, err);
      return forwardError(c, err);
    }

    if (isStreamingResponse(upstream)) {
      // Phase 5 v3.1 Group B — pull trace context off the per-request scope.
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
      // F159 — end-to-end clock stamped by `withMetrics` at request entry, read
      // through the exported helper rather than by spelling the context key.
      const dispatchStartedMs = dispatchStartedMsOf(c);
      c.set("traceStreaming", true);

      // M10 D-LOCK-7 — choose forwarder per-route. Non-empty
      // `stream_event_rules` → translated path; empty → verbatim byte
      // path. Snapshot taken at request time so config hot-reload picks
      // up rule changes mid-process.
      // Join key — resolved ONCE, for BOTH forwarder paths, and threaded into
      // ctxBase regardless of `logging.level`, so forward-stream diagnostics
      // are joinable at the default level instead of degrading to `<unknown>`.
      const requestId = getRequestId(c);

      // M2 (D100) — ONE `StreamCtxBase` per handler, shared by both forwarder
      // branches; this was two byte-identical ten-field literals. The
      // `: StreamCtxBase` annotation is LOAD-BEARING, not decoration — see the
      // interface's own docblock in `forward-stream.ts` for why.
      // M12.5 H1: `metricRoute` is the clean Prometheus label for stream metrics.
      // Phase 5 v3.1 Group B: trace ctx threaded for the streaming write.
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
      return streamSSE(c, forwardStream(c, upstream, streamCtx));
    }

    return forwardUpstreamResponse(c, upstream);
  };
}
