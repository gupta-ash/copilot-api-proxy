// Adapted from xianml/copilot-api-pro@f212832 src/services/copilot/create-responses.ts
// Modifications: same as create-anthropic-messages.ts (D17 P3, D-LOCK-10, D-LOCK-2 retry).

/**
 * create-responses.ts — POST /responses upstream caller.
 *
 * Codex inbound. Same Layer B 401-retry topology as create-anthropic-messages.
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

export interface CreateResponsesArgs {
  body: unknown;
  headers: Record<string, string>;
  copilotToken: string;
  accountType: AccountType;
  vsCodeVersion: string;
  signal?: AbortSignal;
  tokenManager?: TokenManager;
  /** D37: upstream URL path suffix, resolved by the caller: `dispatchRoute` from the matched route's `upstreams[via].paths[via_endpoint]`, or `dispatchMarker` from the redirect target. */
  upstreamPath: string;
}

function buildUpstreamRequest(
  args: CreateResponsesArgs,
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
      method: "POST",
      headers: finalHeaders,
      body: JSON.stringify(args.body),
      signal: args.signal,
    },
  };
}

export async function createResponses(
  args: CreateResponsesArgs,
): Promise<Response> {
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
