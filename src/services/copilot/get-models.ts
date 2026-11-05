// Adapted from xianml/copilot-api-pro@f212832 src/services/copilot/get-models.ts
// Modifications: D17 P3 (no state singleton), D-LOCK-10 (canonicalHeaders), D-LOCK-2 retry.

/**
 * get-models.ts — GET /models upstream caller.
 *
 * No request body. Returns the 46-model upstream catalog. Same Layer B
 * 401-retry topology.
 */

import {
  copilotBaseUrl,
  copilotHeaders,
  type AccountType,
} from "~/auth/api-config.ts";
import type { TokenManager } from "~/auth/token-manager.ts";
import { HTTPError } from "~/lib/error.ts";
import {
  canonicalHeaders,
  dropOutboundHopHeaders,
  setAuthorization,
} from "~/routes/_shared/headers.ts";
import { fetchWithLayerBRetry } from "~/services/copilot/_retry.ts";

export interface GetModelsArgs {
  /** Headers from the inbound request — passed through after canonicalization. */
  headers: Record<string, string>;
  copilotToken: string;
  accountType: AccountType;
  vsCodeVersion: string;
  signal?: AbortSignal;
  tokenManager?: TokenManager;
  /** D37: upstream URL path suffix (resolved by handler from `config.upstreams.copilot_enterprise.paths[endpointName]`). */
  upstreamPath: string;
}

function buildUpstreamRequest(
  args: GetModelsArgs,
  copilotToken: string,
): { url: string; init: RequestInit } {
  const url = `${copilotBaseUrl(args.accountType)}${args.upstreamPath}`;
  const baseHeaders = copilotHeaders({
    token: copilotToken,
    vsCodeVersion: args.vsCodeVersion,
  });
  const finalHeaders = setAuthorization(
    dropOutboundHopHeaders(canonicalHeaders(baseHeaders, args.headers)),
    copilotToken,
  );
  return {
    url,
    init: {
      method: "GET",
      headers: finalHeaders,
      signal: args.signal,
    },
  };
}

export async function getModels(args: GetModelsArgs): Promise<Response> {
  const response = await fetchWithLayerBRetry({
    buildRequest: (token) => buildUpstreamRequest(args, token),
    initialToken: args.copilotToken,
    tokenManager: args.tokenManager,
  });

  if (!response.ok) {
    throw new HTTPError(`Copilot ${response.status}`, response);
  }

  return response;
}
