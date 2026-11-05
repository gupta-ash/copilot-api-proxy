/**
 * dispatcher.ts — route-driven upstream dispatch.
 *
 * When no redirect marker fires (`dispatchMarker` returned null; markers still
 * override per D-LOCK-8), the `/responses` and `/v1/messages` handlers call
 * `dispatchRoute` with the route they matched. The route alone decides the
 * upstream: the service is picked by `route.upstream.shape`, and the path is
 * `config.upstreams[via].paths[via_endpoint]`.
 *
 *   - `anthropic_messages` → `createAnthropicMessages` (with `anthropic_beta.deny`)
 *   - `openai_responses`   → `createResponses`
 *   - `openai_chat`        → `createChatCompletions`
 *
 * **What this replaced.** `dispatchByModel` chose the service from the model
 * name: `isResponsesModel` was a hardcoded `/^gpt-5\./i`, `isClaudeModel` was
 * `/^claude/i`, and every other model fell to `chat_completions_translate`,
 * which the handlers answered with `501 ... deferred to M7a`. That was a second
 * gate duplicating the route table, so a family whose route matched (gpt-6,
 * gpt-5-mini — no dot after the 5) still 501'd unless its route also set a
 * redirect marker. Project `architecture.md` § "A new model family must pass
 * TWO gates" records the measurement.
 *
 * Shape ↔ endpoint coherence is validated at config load (`ConfigSchema`
 * superRefine check #5), so `upstream.shape` is trusted here as-is.
 */

import type { MarkerDispatchDeps } from "./marker-dispatch.ts";

import type { TransformContext } from "~/lib/transform/types.ts";
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages.ts";
import { createChatCompletions } from "~/services/copilot/create-chat-completions.ts";
import { createResponses } from "~/services/copilot/create-responses.ts";
import type { Route } from "~/types/config-schema.ts";

/**
 * Send `ctx` to the upstream named by `route.upstream`. Throws when
 * `upstreams[via].paths[via_endpoint]` does not resolve; the handler's catch
 * maps that to a 500 via `forwardError`.
 */
export async function dispatchRoute(
  route: Route,
  ctx: TransformContext,
  deps: MarkerDispatchDeps,
): Promise<Response> {
  const { via, via_endpoint: viaEndpoint, shape } = route.upstream;
  const upstreamPath = deps.config.upstreams[via]?.paths[viaEndpoint];
  if (upstreamPath === undefined) {
    throw new Error(
      `dispatchRoute: no upstream path for via='${via}' via_endpoint='${viaEndpoint}'`,
    );
  }

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

  switch (shape) {
    case "anthropic_messages":
      return createAnthropicMessages({
        ...args,
        betaDeny: deps.config.anthropic_beta.deny,
      });
    case "openai_responses":
      return createResponses(args);
    case "openai_chat":
      return createChatCompletions(args);
    default: {
      const unreachable: never = shape;
      throw new Error(
        `dispatchRoute: unknown upstream shape '${String(unreachable)}'`,
      );
    }
  }
}
