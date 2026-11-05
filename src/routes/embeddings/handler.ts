/**
 * embeddings/handler.ts — POST /embeddings straight passthrough.
 *
 * No transform engine — embeddings have no use-case for body transformations
 * today (per F26 wiki).
 */

import type { Context } from "hono";

import type { TokenManager } from "~/auth/token-manager.ts";
import { checkAuthGate } from "~/routes/_shared/auth-gate.ts";
import { canonicalHeaders } from "~/routes/_shared/headers.ts";
import { deriveUpstreamSignal } from "~/routes/_shared/derive-upstream-signal.ts";
import {
  forwardError,
  forwardUpstreamResponse,
} from "~/routes/_shared/error-helpers.ts";
import { findMatchingRoute } from "~/routes/_shared/route-match.ts";
import { stashInboundBody } from "~/routes/_shared/stash-inbound-body.ts";
import { createEmbeddings } from "~/services/copilot/create-embeddings.ts";
import type { Config } from "~/types/config-schema.ts";

export interface EmbeddingsHandlerDeps {
  config: Config;
  tokenManager: TokenManager;
  /** D37: endpoint family name from `config.endpoints`. */
  endpointName: string;
}

export function makeEmbeddingsHandler(
  deps: EmbeddingsHandlerDeps,
): (c: Context) => Promise<Response> {
  const { config, tokenManager, endpointName } = deps;
  const canonicalPath = config.endpoints[endpointName]?.inbound_paths[0];
  if (canonicalPath === undefined) {
    throw new Error(
      `embeddings handler: config.endpoints.${endpointName} is undefined or has no inbound_paths`,
    );
  }
  const upstreamPath =
    config.upstreams["copilot_enterprise"]?.paths[endpointName];
  if (upstreamPath === undefined) {
    throw new Error(
      `embeddings handler: config.upstreams.copilot_enterprise.paths.${endpointName} is undefined`,
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
    // by forward-stream.ts emitTraceFlow). Embeddings has no streaming path
    // so the meta mutation is a no-op here; the helper is used for symmetry
    // with the other 3 body-stashing handlers (messages, responses,
    // chat-completions) and to future-proof against an embeddings stream
    // path being added later. No-op when raw mode off.
    if (c.get("traceWriter") !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      stashInboundBody(c, bytes, "application/json");
    }

    // Extract model from the request body so routes with `model_pattern`
    // can match (per discriminator iter-1 M5). The OpenAI Embeddings API
    // body schema includes `model: string`; we treat absent / non-string
    // as undefined and let findMatchingRoute fall back to the path-only
    // match.
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
      const inboundHeaders = canonicalHeaders(
        Object.fromEntries(c.req.raw.headers.entries()),
      );
      upstream = await createEmbeddings({
        body,
        headers: inboundHeaders,
        copilotToken: tokenSnapshot.token,
        accountType: config.auth.account_type,
        vsCodeVersion: config.auth.vs_code_version,
        signal: deriveUpstreamSignal(c),
        tokenManager,
        upstreamPath,
      });
    } catch (err) {
      return forwardError(c, err);
    }

    return forwardUpstreamResponse(c, upstream);
  };
}
