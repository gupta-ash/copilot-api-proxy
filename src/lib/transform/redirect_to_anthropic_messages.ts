/**
 * redirect_to_anthropic_messages.ts — body-engine rule: marks the request
 * for redirect to `/v1/messages` (Anthropic Messages route). Defers the
 * actual body-shape translation to M7a's `translate_responses_to_anthropic`
 * primitive.
 *
 * **M6 primitive (built-in).** Self-registers on the **body engine surface**
 * per D-LOCK-1. Naming convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **D-LOCK-4 — declares `response_shape: "anthropic_v1_messages"`.** Per
 * X2 redirect_response_shape contract: M9's config loader (via
 * `_validate_response_shape.ts`) will refuse a config that includes this
 * rule on the body side WITHOUT a matching response-side rule that
 * consumes the `anthropic_v1_messages` shape. M6 ships the metadata + the
 * validator; M9 wires it into config-load.
 *
 * **NEW — no upstream cribbing.** The legacy bundle's redirect lives in
 * `src/routes/responses/cross-vendor-anthropic.ts § translateResponsesToAnthropic`
 * (line 2089) — that's a route-level dispatch decision, not a config-driven
 * rule. v2 declarativizes routing for default.yaml authors.
 *
 * **Mechanism.** Sets a marker header `x-proxy-redirect-to: /v1/messages`
 * on `ctx.headers`. M5's dispatcher (or M9's wired equivalent) reads this
 * marker and re-routes the request through the corresponding response-side
 * rule chain. The marker is internal — it's a contract between this rule
 * and the dispatcher, not a wire-level header.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["body", "headers"]` — sets the marker header AND may
 *     mutate body in M7a (this rule's M6 stub is headers-only).
 *
 * **Behavior (M6 STUB).**
 *   - Sets `ctx.headers["x-proxy-redirect-to"] = "/v1/messages"`.
 *   - Returns `applied: true` with `before/after` snapshots of the marker
 *     header (`before` = prior value or `null`, `after` = `/v1/messages`).
 *   - Body translation is M7a's responsibility — this rule does NOT touch
 *     `ctx.body`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: codex_to_claude
 *   use: redirect_to_anthropic_messages
 *   when:
 *     route: /v1/responses
 *     model_glob: "claude-*"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - X2 redirect_response_shape contract.
 *   - `lib/transform/_validate_response_shape.ts` — config-load validator.
 *   - `lib/headers.ts § setHeader`.
 */

import { z } from "zod";

import { getHeader, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

/**
 * The internal marker header read by the dispatcher to decide redirect.
 * Lives at the body-rule layer because the redirect decision is part of
 * request-side rule application; the actual route swap happens after
 * `applyRules` returns and the dispatcher inspects `ctx.headers`.
 */
export const REDIRECT_MARKER_HEADER = "x-proxy-redirect-to";
const REDIRECT_TARGET = "/v1/messages";

const RedirectToAnthropicMessagesSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("redirect_to_anthropic_messages"),
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

const redirect_to_anthropic_messages: TransformFn = (
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
  "redirect_to_anthropic_messages",
  redirect_to_anthropic_messages,
  RedirectToAnthropicMessagesSchema,
  {
    response_shape: "anthropic_v1_messages",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
);

export { redirect_to_anthropic_messages, RedirectToAnthropicMessagesSchema };
