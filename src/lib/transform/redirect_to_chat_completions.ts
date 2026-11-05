/**
 * redirect_to_chat_completions.ts — body-engine rule: marks the request
 * for redirect to `/v1/chat/completions` (OpenAI Chat Completions route).
 * Defers the actual body-shape translation to M7a's translator primitive.
 *
 * **M6 primitive (built-in).** Self-registers on the **body engine surface**
 * per D-LOCK-1. Naming convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **D-LOCK-4 — declares `response_shape: "openai_chat_completions"`.** Per
 * X2 redirect_response_shape contract: M9's config loader (via
 * `_validate_response_shape.ts`) will refuse a config that includes this
 * rule on the body side WITHOUT a matching response-side rule that
 * consumes the `openai_chat_completions` shape.
 *
 * **NEW — no upstream cribbing.** Same rationale as
 * `redirect_to_anthropic_messages.ts`: legacy bundle's redirect lives in
 * route-level dispatch; v2 declarativizes for default.yaml authors.
 *
 * **Mechanism.** Sets a marker header
 * `x-proxy-redirect-to: /v1/chat/completions` on `ctx.headers`. M5's
 * dispatcher (or M9's wired equivalent) reads this marker and re-routes
 * the request through the chat-completions response-side rule chain.
 * Internal contract — not a wire-level header.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["body", "headers"]` — sets the marker header AND may
 *     mutate body in M7a (this rule's M6 stub is headers-only).
 *
 * **Behavior (M6 STUB).**
 *   - Sets `ctx.headers["x-proxy-redirect-to"] = "/v1/chat/completions"`.
 *   - Returns `applied: true` with `before/after` snapshots.
 *   - Body translation is M7a's responsibility.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: anthropic_to_chat_completions
 *   use: redirect_to_chat_completions
 *   when:
 *     route: /v1/messages
 *     model_glob: "gpt-*"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - X2 redirect_response_shape contract.
 *   - `lib/transform/_validate_response_shape.ts` — config-load validator.
 *   - `redirect_to_anthropic_messages.ts § REDIRECT_MARKER_HEADER`.
 */

import { z } from "zod";

import { getHeader, setHeader } from "../headers.ts";

import { REDIRECT_MARKER_HEADER } from "./redirect_to_anthropic_messages.ts";
import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const REDIRECT_TARGET = "/v1/chat/completions";

const RedirectToChatCompletionsSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("redirect_to_chat_completions"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
  })
  .passthrough();

const redirect_to_chat_completions: TransformFn = (
  ctx: TransformContext,
): TransformResult => {
  const before = getHeader(ctx.headers, REDIRECT_MARKER_HEADER) ?? null;
  if (before === REDIRECT_TARGET) {
    return { ctx, applied: false };
  }
  ctx.headers = setHeader(ctx.headers, REDIRECT_MARKER_HEADER, REDIRECT_TARGET);
  return {
    ctx,
    applied: true,
    before: { [REDIRECT_MARKER_HEADER]: before },
    after: { [REDIRECT_MARKER_HEADER]: REDIRECT_TARGET },
  };
};

register(
  "redirect_to_chat_completions",
  redirect_to_chat_completions,
  RedirectToChatCompletionsSchema,
  {
    response_shape: "openai_chat_completions",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
);

export { redirect_to_chat_completions, RedirectToChatCompletionsSchema };
