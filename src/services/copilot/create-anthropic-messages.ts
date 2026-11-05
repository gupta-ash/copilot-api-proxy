// Adapted from xianml/copilot-api-pro@f212832 src/services/copilot/create-anthropic-messages.ts
// Modifications:
//   - No `state` singleton (D17 P3); inputs are explicit args.
//   - Headers built via canonicalHeaders + setAuthorization (D-LOCK-10) — kills the
//     case-collision bug between mixed-case `Authorization` and lowercase
//     `authorization`.
//   - 401 retry uses tokenManager.refresh() (Layer B per D-LOCK-2). Bounded at
//     ONE retry. setAuthorization on the retry path defends against custom-rule
//     authorization overrides (per discriminator iter-2 M4).
//   - buildUpstreamRequest factory ensures method/body/signal are identical
//     across the original + retry fetches (per discriminator M-retry-replay).
//   - Any non-OK upstream response throws HTTPError (incl. streaming-shaped),
//     so an initial error status is never masked as a successful SSE stream.

/**
 * create-anthropic-messages.ts — POST /v1/messages upstream caller.
 *
 * Translates an Anthropic-shape request body + headers (already mutated by
 * the M2 transform pipeline) into a Copilot-Ent fetch. Returns the raw
 * Response — the route handler decides forward-as-JSON vs stream-via-SSE
 * based on `isStreamingResponse(response)`.
 */

import {
  copilotBaseUrl,
  copilotHeaders,
  type AccountType,
} from "~/auth/api-config.ts";
import type { TokenManager } from "~/auth/token-manager.ts";
import { HTTPError } from "~/lib/error.ts";
import { getHeader, parseCsv, serializeCsv, setHeader } from "~/lib/headers.ts";
import {
  canonicalHeaders,
  dropOutboundHopHeaders,
  setAuthorization,
} from "~/routes/_shared/headers.ts";
import { fetchWithLayerBRetry } from "~/services/copilot/_retry.ts";

export interface CreateAnthropicMessagesArgs {
  /** Already-mutated by transform pipeline. */
  body: unknown;
  /** Already-mutated header dict (lowercase canonical from lib/headers.ts). */
  headers: Record<string, string>;
  /** The Copilot-Ent token STRING — extract `.token` from `tokenManager.getTokenForRequest()`. */
  copilotToken: string;
  accountType: AccountType;
  vsCodeVersion: string;
  /** Client-disconnect propagation. */
  signal?: AbortSignal;
  /** OPTIONAL — present for Layer B 401-retry per D-LOCK-2. */
  tokenManager?: TokenManager;
  /** D37: upstream URL path suffix, resolved by the caller: `dispatchRoute` from the matched route's `upstreams[via].paths[via_endpoint]`, or `dispatchMarker` from the redirect target. */
  upstreamPath: string;
  /**
   * Feature D1 (Option 1) — tokens to strip from the outbound `anthropic-beta`
   * header at egress, INDEPENDENT of route classification (see
   * `stripDeniedBetas`). Threaded from `config.anthropic_beta.deny` by both
   * callers (`dispatchRoute` in `routes/_shared/dispatcher.ts` and
   * `dispatchMarker`). Optional:
   * when omitted the guard is a no-op — used only by focused unit tests that do
   * not exercise the deny path.
   */
  betaDeny?: readonly string[];
}

/**
 * Feature D1 (Option 1) — classification-INDEPENDENT egress deny guard.
 *
 * Strips every token in `deny` from the outbound `anthropic-beta` CSV header at
 * the single choke-point through which BOTH Anthropic-upstream lanes egress:
 * Lane 1 (native `POST /v1/messages × claude-*`) and Lane 5 (`POST /responses`
 * cross-vendor-translated to the Anthropic shape, redirected here by the marker
 * dispatcher). Because it runs HERE — not per-lane, not gated on route
 * classification — a denied token can never reach the Copilot Anthropic upstream
 * no matter how (or whether) the route was classified upstream.
 *
 * Relationship to the boot-time `applyBetaPolicy` denyTail (`lib/apply-beta-policy.ts`):
 *   - Correctly-classified beta lane: the injected `beta_policy_deny`
 *     (`strip_header_csv_token`) already removed `deny` post-merge during the
 *     transform pipeline, so by the time the header arrives here it carries no
 *     denied token → this guard is a redundant no-op (dict returned unchanged).
 *   - MISclassified / never-classified claude lane (`isBetaLane` did not match
 *     it, so NO denyTail was injected): this guard is the ONLY place `deny` is
 *     applied — denied tokens are still stripped, so the security invariant
 *     HOLDS. (Such a lane also gets no `merge_append`; that is acceptable — the
 *     invariant is "never SEND a denied token", not "always ensure feature betas".)
 *
 * Edge cases: no `anthropic-beta` header → no-op; no denied token present (and
 * ≥1 token remains) → no-op (dict returned unchanged, so the original value +
 * spacing is preserved byte-for-byte); EMPTY header → DROPPED entirely,
 * INDEPENDENT of the deny list (never send an empty `anthropic-beta`). The empty
 * case covers a header that ARRIVED already-empty — an upstream denyTail
 * (`strip_header_csv_token`) strips every token and serializes `[]` to `""`,
 * writing it back rather than dropping; OR an allowlist filter reduced it to
 * `""` even with an EMPTY deny list — AND a header that becomes empty here after
 * all its tokens are denied. Token match is case-sensitive and order-preserving,
 * matching the `strip_header_csv_token` / `filter_header_csv` convention. Input
 * dict is never mutated.
 */
export function stripDeniedBetas(
  headers: Record<string, string>,
  deny: readonly string[],
): Record<string, string> {
  const value = getHeader(headers, "anthropic-beta");
  if (value === undefined) return headers;
  // Return a clone WITHOUT the anthropic-beta header. Shared by every
  // "no surviving tokens" branch below so an empty header is NEVER forwarded.
  const dropBeta = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "anthropic-beta") continue;
      out[k] = v;
    }
    return out;
  };
  const before = parseCsv(value);
  // Never send an EMPTY anthropic-beta — INDEPENDENT of the deny list. A
  // present-but-empty header reaches here either already-empty (an upstream
  // denyTail `strip_header_csv_token` strips every token and serializes [] to
  // "", writing it back rather than dropping the header; or an allowlist filter
  // reduced it to "") or as whitespace/comma-only that `parseCsv` reduces to [].
  // This MUST precede the `deny.length === 0` fast-path below: with an empty
  // deny list an allowlist filter can still have emptied the header, and that
  // empty header must not be forwarded verbatim as `anthropic-beta: ""`.
  if (before.length === 0) return dropBeta();
  if (deny.length === 0) return headers; // nothing to strip; ≥1 token present → keep as-is (same ref)
  const denySet = new Set<string>(deny);
  const kept = before.filter((t) => !denySet.has(t));
  if (kept.length === 0) return dropBeta(); // every token denied → drop (never send "")
  if (kept.length === before.length) return headers; // no denied token → no-op (same ref; kept.length > 0)
  return setHeader(headers, "anthropic-beta", serializeCsv(kept));
}

/**
 * Build the upstream fetch from immutable args. Used twice on a 401-retry
 * (once with original token, once with refreshed). The shared factory
 * ensures method/body/signal are identical across the two calls — only the
 * Authorization header differs.
 */
function buildUpstreamRequest(
  args: CreateAnthropicMessagesArgs,
  copilotToken: string,
): { url: string; init: RequestInit } {
  const url = `${copilotBaseUrl(args.accountType)}${args.upstreamPath}`;
  const baseHeaders = copilotHeaders({
    token: copilotToken,
    vsCodeVersion: args.vsCodeVersion,
  });
  // canonicalHeaders lowercases ALL keys + lets transform headers override
  // base on collision. This kills the H10 case-collision bug.
  const finalHeaders = setAuthorization(
    dropOutboundHopHeaders(canonicalHeaders(baseHeaders, args.headers)),
    copilotToken,
  );
  // Feature D1 (Option 1) egress deny guard — the LAST header mutation before
  // the request leaves for the Anthropic upstream. Applied inside the shared
  // factory so it runs identically on the original AND the Layer-B 401-retry
  // fetch. Classification-INDEPENDENT: even a claude lane misclassified by
  // isBetaLane (so no boot-time denyTail was injected) still gets denied tokens
  // stripped here, upholding the invariant. See `stripDeniedBetas`.
  const guardedHeaders = stripDeniedBetas(finalHeaders, args.betaDeny ?? []);
  return {
    url,
    init: {
      method: "POST",
      headers: guardedHeaders,
      body: JSON.stringify(args.body),
      signal: args.signal,
    },
  };
}

export async function createAnthropicMessages(
  args: CreateAnthropicMessagesArgs,
): Promise<Response> {
  const response = await fetchWithLayerBRetry({
    buildRequest: (token) => buildUpstreamRequest(args, token),
    initialToken: args.copilotToken,
    tokenManager: args.tokenManager,
  });

  // Any non-OK upstream response becomes an HTTPError that the route handler
  // maps via forwardError (which logs status + parsed message + remediation
  // hint). This includes responses shaped as text/event-stream: an initial
  // non-2xx is always an error, never a forwardable stream, so it must not be
  // masked as a successful stream. Mid-stream errors arrive as 200 + an SSE
  // error event and are handled by the stream forwarder, not this gate.
  if (!response.ok) {
    throw new HTTPError(`Copilot ${response.status}`, response);
  }

  return response;
}
