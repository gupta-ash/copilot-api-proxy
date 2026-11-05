/**
 * response_passthrough_openai_chat_completions.ts — body-engine rule (response
 * side; same registry as request-side body rules per `_validate_response_shape.ts`'s
 * shared `bodyRegistrySnapshot` argument). MINIMAL pass-through.
 *
 * Lane: legacy GPT-4.x lanes (Codex→GPT-4 via /chat/completions). Pairs
 * with `redirect_to_chat_completions` (M6) on the body side.
 *
 * **NEW per M9 (D-LOCK-7).** One of three response-side consumer stubs
 * Group C ships so `_validate_response_shape.ts` (wired into `lib/config.ts`
 * post-zod-parse per D-LOCK-13/14) recognizes the
 * `openai_chat_completions` shape as offered by the operator's response
 * pipeline.
 *
 * **No upstream cribbing.** Wholly v2-internal; the upstream bundle has no
 * declarative response-rule contract.
 *
 * **Why pass-through stub.** Per D-LOCK-8 stream-deferral, stream-side
 * translation pipeline (decode → applyEvent → re-encode) is dormant on the
 * wire in M9. M9 ships the declarative-config contract; M10 wires the
 * actual per-event translation pipeline.
 *
 * **Ctx surfaces.**
 *   - `ctx_reads: []` / `ctx_writes: []` — pure no-op.
 *
 * **Behavior.** Returns `{ctx, applied: false}` unconditionally.
 *
 * **D-LOCK-18 default materialization.** TransformFn opens with
 * `Schema.parse(options)` per `merge_anthropic_betas.ts:112`.
 *
 * **Cross-references.**
 *   - `decisions.md` § D31.
 *   - `redirect_to_chat_completions.ts` — body-side declarer.
 *   - `_validate_response_shape.ts` — config-load validator.
 *   - M9 task spec § D-LOCK-7 / D-LOCK-13 / D-LOCK-18.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const ResponsePassthroughOpenaiChatCompletionsSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("response_passthrough_openai_chat_completions"),
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

const response_passthrough_openai_chat_completions: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  // D-LOCK-18: materialize zod defaults at runtime.
  ResponsePassthroughOpenaiChatCompletionsSchema.parse(options);
  // Pure pass-through; stream-side translation deferred to M10 per D-LOCK-8.
  return { ctx, applied: false };
};

register(
  "response_passthrough_openai_chat_completions",
  response_passthrough_openai_chat_completions,
  ResponsePassthroughOpenaiChatCompletionsSchema,
  {
    response_shape: "openai_chat_completions",
    ctx_reads: [],
    ctx_writes: [],
  },
);

export {
  response_passthrough_openai_chat_completions,
  ResponsePassthroughOpenaiChatCompletionsSchema,
};
