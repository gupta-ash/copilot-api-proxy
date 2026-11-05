/**
 * models/handler.ts — GET /v1/models (and /models alias) straight passthrough.
 *
 * Subject to D-LOCK-2 stage-1 auth_pending gate per iter-4 M4 option A —
 * no cached static-catalog exception.
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
import { getModels } from "~/services/copilot/get-models.ts";
import type { Config } from "~/types/config-schema.ts";

export interface ModelsHandlerDeps {
  config: Config;
  tokenManager: TokenManager;
  /** D37: endpoint family name from `config.endpoints`. */
  endpointName: string;
}

export function makeModelsHandler(
  deps: ModelsHandlerDeps,
): (c: Context) => Promise<Response> {
  const { config, tokenManager, endpointName } = deps;
  // D37: models is a straight passthrough — no findMatchingRoute, no canonical
  // path normalization needed. We only need the upstream path from config.
  const upstreamPath =
    config.upstreams["copilot_enterprise"]?.paths[endpointName];
  if (upstreamPath === undefined) {
    throw new Error(
      `models handler: config.upstreams.copilot_enterprise.paths.${endpointName} is undefined`,
    );
  }

  return async (c: Context): Promise<Response> => {
    const gateResp = checkAuthGate(c, tokenManager);
    if (gateResp !== null) return gateResp;

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
      const upstream = await getModels({
        headers: inboundHeaders,
        copilotToken: tokenSnapshot.token,
        accountType: config.auth.account_type,
        vsCodeVersion: config.auth.vs_code_version,
        signal: deriveUpstreamSignal(c),
        tokenManager,
        upstreamPath,
      });
      return forwardUpstreamResponse(c, upstream);
    } catch (err) {
      return forwardError(c, err);
    }
  };
}
