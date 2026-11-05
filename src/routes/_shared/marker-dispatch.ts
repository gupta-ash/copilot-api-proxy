/**
 * marker-dispatch.ts — shared marker-driven dispatch helper invoked from
 * all 3 protected route handlers (messages, responses, chat-completions)
 * BEFORE their non-marker dispatch (`dispatchRoute` in messages + responses;
 * the unconditional `createChatCompletions` in chat-completions).
 *
 * **NEW per M9 (D-LOCK-8).** Closes the loop opened by M6/M8 redirect
 * primitives (`redirect_to_anthropic_messages`, `redirect_to_chat_completions`,
 * `redirect_to_responses`) which set the `x-proxy-redirect-to` marker
 * header on `ctx.headers` after body+header rules apply. When no marker is
 * set, the handler dispatches without it (messages + responses follow the
 * matched route via `dispatchRoute`); M9 makes dispatch marker-aware so a
 * declarative redirect rule actually re-routes the upstream call.
 *
 * **D37 (M9-FIX-PATHS-CONFIG): marker tokens are INTERNAL ROUTING TOKENS,
 * NOT URLs.** The valid marker values (`/v1/messages`, `/v1/chat/completions`,
 * `/v1/responses`) intentionally use `/v1/*` form per Anti-Pattern #4 — they
 * are sentinels chosen for backwards compat with the bundle's wire-level
 * paths. The actual upstream URL is resolved via `MARKER_TO_ENDPOINT[target]`
 * → `config.upstreams.copilot_enterprise.paths[endpointName]`. Renaming
 * marker values would widen scope without architectural benefit.
 *
 * **No upstream cribbing.** Wholly v2-internal — the bundle dispatches
 * imperatively in route handlers; v2 declarativizes via the marker pattern.
 *
 * **Mechanism.**
 *
 *   1. Read `getHeader(ctx.headers, REDIRECT_MARKER_HEADER)`.
 *   2. If `null/undefined` → return `null` (caller falls through to its
 *      existing dispatch logic).
 *   3. Map the marker token → endpoint family name via `MARKER_TO_ENDPOINT`.
 *   4. Resolve `upstreamPath` from `deps.config.upstreams.copilot_enterprise.paths[endpointName]`.
 *   5. If `"/v1/messages"` → invoke `createAnthropicMessages` service with the resolved upstreamPath.
 *   6. If `"/v1/chat/completions"` → invoke `createChatCompletions`.
 *   7. If `"/v1/responses"` → invoke `createResponses`.
 *   8. Anything else → throw `UnknownRedirectTargetError` (caller forwards
 *      via `forwardError` for a 500 with clear error message).
 *
 * **Marker dispatch is BODY-side routing only.** It picks the upstream
 * service and returns its Response; it does nothing to the stream. The
 * caller (handler) decides JSON vs SSE via `isStreamingResponse`, and for SSE
 * chooses per route: a route with `stream_event_rules` (Lanes 4 and 5) goes
 * through `forwardStreamTranslated`, any other through the verbatim
 * `forwardStream` (M10 D-LOCK-7).
 *
 * **Cross-references.**
 *   - M9 task spec § D-LOCK-8 (marker-driven routing; body-side ONLY).
 *   - M9-FIX-PATHS-CONFIG task spec § marker-dispatch (D37 endpoint resolution).
 *   - `decisions.md` § D8 (endpoint routing by model family).
 *   - `redirect_to_anthropic_messages.ts § REDIRECT_MARKER_HEADER` (single
 *     source of truth for the marker constant).
 *   - `routes/_shared/dispatcher.ts` — route-driven dispatch the marker
 *     dispatch OVERRIDES.
 */

import type { TokenManager } from "~/auth/token-manager.ts";
import type { AccountType } from "~/auth/api-config.ts";
import { getHeader } from "~/lib/headers.ts";
import { REDIRECT_MARKER_HEADER } from "~/lib/transform/redirect_to_anthropic_messages.ts";
import type { TransformContext } from "~/lib/transform/types.ts";
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages.ts";
import { createChatCompletions } from "~/services/copilot/create-chat-completions.ts";
import { createResponses } from "~/services/copilot/create-responses.ts";
import type { Config } from "~/types/config-schema.ts";

/** Valid redirect target literals (per interface-contracts.md § 2). */
export const VALID_REDIRECT_TARGETS = [
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/responses",
] as const;

export type RedirectTarget = (typeof VALID_REDIRECT_TARGETS)[number];

/**
 * **D37 — internal marker token → endpoint family name.** The marker tokens
 * are INTERNAL routing sentinels (per Anti-Pattern #4); the upstream URL is
 * resolved via `config.upstreams.copilot_enterprise.paths[endpointName]`.
 */
const MARKER_TO_ENDPOINT: Readonly<Record<RedirectTarget, string>> = {
  "/v1/messages": "anthropic_messages",
  "/v1/chat/completions": "openai_chat_completions",
  "/v1/responses": "openai_responses",
};

/**
 * Thrown by `dispatchMarker` when the marker carries a value that does not
 * match any known redirect target. The handler's catch-and-`forwardError`
 * path maps this to a 500 with a clear error message.
 */
export class UnknownRedirectTargetError extends Error {
  constructor(public readonly target: string) {
    super(
      `unknown redirect target: ${target}; valid targets are ${VALID_REDIRECT_TARGETS.join(", ")}`,
    );
    this.name = "UnknownRedirectTargetError";
  }
}

/**
 * Per-call dependencies for `dispatchMarker`. The handler supplies these
 * at call time so the helper itself remains decoupled from Hono.
 */
export interface MarkerDispatchDeps {
  /**
   * D37: full Config — marker-dispatch resolves `upstreamPath` from
   * `config.upstreams.copilot_enterprise.paths[endpointName]` per call.
   */
  config: Config;
  /** Already-extracted Copilot token (caller checks for null first). */
  copilotToken: string;
  accountType: AccountType;
  vsCodeVersion: string;
  /** Client-disconnect propagation. */
  signal?: AbortSignal;
  tokenManager: TokenManager;
}

/**
 * Marker-driven dispatch. Returns the upstream `Response` if the marker
 * fires; returns `null` if the marker is absent (caller proceeds with its
 * existing dispatch logic). Throws `UnknownRedirectTargetError` on
 * unrecognized marker values.
 *
 * Body-side only per D-LOCK-8 stream-deferral — streaming-vs-JSON decision
 * is the caller's responsibility (typically `isStreamingResponse(upstream)
 * ? streamSSE(c, forwardStream(c, upstream, { route, model, metricRoute }))
 * : forwardUpstreamResponse(c, upstream)`). The `forwardStream` ctxBase arg
 * was added in M12 D-LOCK-3 (route + model for predicate evaluation) and
 * extended in M12.5 D-LOCK-1 (`metricRoute` for clean Prometheus labels).
 */
export async function dispatchMarker(
  ctx: TransformContext,
  deps: MarkerDispatchDeps,
): Promise<Response | null> {
  const target = getHeader(ctx.headers, REDIRECT_MARKER_HEADER);
  if (target === undefined || target === null) return null;

  // Validate the marker BEFORE resolving — bogus markers throw the typed
  // error so the handler's forwardError can map to a 500 with the diagnostic.
  if (
    target !== "/v1/messages" &&
    target !== "/v1/chat/completions" &&
    target !== "/v1/responses"
  ) {
    throw new UnknownRedirectTargetError(target);
  }

  // D37: resolve the upstream path from config.
  const endpointName = MARKER_TO_ENDPOINT[target];
  const upstream = deps.config.upstreams["copilot_enterprise"];
  if (upstream === undefined) {
    throw new Error(
      "marker-dispatch: 'copilot_enterprise' upstream not defined in config",
    );
  }
  const upstreamPath = upstream.paths[endpointName];
  if (upstreamPath === undefined) {
    throw new Error(
      `marker-dispatch: upstream path for endpoint '${endpointName}' not defined`,
    );
  }

  // Build the shared service args; all 3 services accept the same shape
  // (verified in services/copilot/create-{anthropic-messages,chat-completions,responses}.ts).
  const args = {
    body: ctx.body,
    headers: ctx.headers,
    copilotToken: deps.copilotToken,
    accountType: deps.accountType,
    vsCodeVersion: deps.vsCodeVersion,
    signal: deps.signal,
    tokenManager: deps.tokenManager,
    upstreamPath,
  };

  switch (target) {
    case "/v1/messages":
      // Feature D1 (Option 1): thread the deny list to the Anthropic egress
      // guard. Only createAnthropicMessages reaches the Anthropic upstream, so
      // betaDeny is added HERE rather than on the shared `args` — the other two
      // services target OpenAI-shape upstreams where `anthropic-beta` is moot.
      return createAnthropicMessages({
        ...args,
        betaDeny: deps.config.anthropic_beta.deny,
      });
    case "/v1/chat/completions":
      return createChatCompletions(args);
    case "/v1/responses":
      return createResponses(args);
  }
}
