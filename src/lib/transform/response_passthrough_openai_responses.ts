/**
 * response_passthrough_openai_responses.ts — body-engine rule (response side;
 * same registry as request-side body rules per `_validate_response_shape.ts`'s
 * shared `bodyRegistrySnapshot` argument). MINIMAL pass-through.
 *
 * Lane: gpt-5.x lanes (CC→GPT-5, omp→GPT-5 via /v1/responses). Pairs with
 * `redirect_to_responses` (M8) on the body side.
 *
 * **NEW per M9 (D-LOCK-7).** One of three response-side consumer stubs
 * Group C ships so `_validate_response_shape.ts` (wired into `lib/config.ts`
 * post-zod-parse per D-LOCK-13/14) recognizes the `openai_responses` shape
 * as offered by the operator's response pipeline. CLOSES the M8 D-LOCK-13
 * gate (M8's `redirect_to_responses` declared the shape but no consumer
 * existed; M9's default.yaml gpt-5.x route would otherwise hard-fail at
 * config load).
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
 *   - `decisions.md` § D31 (M8 scope reconciliation, NEW ADR).
 *   - `redirect_to_responses.ts` — body-side declarer of `openai_responses`.
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

const ResponsePassthroughOpenaiResponsesSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("response_passthrough_openai_responses"),
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

const response_passthrough_openai_responses: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  // D-LOCK-18: materialize zod defaults at runtime.
  ResponsePassthroughOpenaiResponsesSchema.parse(options);
  // Pure pass-through; stream-side translation deferred to M10 per D-LOCK-8.
  return { ctx, applied: false };
};

register(
  "response_passthrough_openai_responses",
  response_passthrough_openai_responses,
  ResponsePassthroughOpenaiResponsesSchema,
  {
    response_shape: "openai_responses",
    ctx_reads: [],
    ctx_writes: [],
  },
);

export {
  response_passthrough_openai_responses,
  ResponsePassthroughOpenaiResponsesSchema,
};
