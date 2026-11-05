/**
 * response_passthrough_anthropic_v1_messages.ts — body-engine rule (response
 * side; same registry as request-side body rules per `_validate_response_shape.ts`'s
 * shared `bodyRegistrySnapshot` argument). MINIMAL pass-through.
 *
 * Lane: Anthropic-upstream lanes (CC→Claude, Codex→Claude). Pairs with
 * `redirect_to_anthropic_messages` (M6) on the body side.
 *
 * **NEW per M9 (D-LOCK-7).** This is one of three response-side consumer
 * stubs Group C ships so `_validate_response_shape.ts` (wired into
 * `lib/config.ts` post-zod-parse per D-LOCK-13/14) recognizes the
 * `anthropic_v1_messages` shape as offered by the operator's response
 * pipeline. Without this declarative consumer the validator would reject
 * any default.yaml route that uses `redirect_to_anthropic_messages`.
 *
 * **No upstream cribbing.** Wholly v2-internal — the upstream bundle has no
 * declarative response-rule contract; this is the v2-side adapter point.
 *
 * **Why pass-through stub (not full translator).** The actual response-side
 * translation work (stream-event decode → applyEvent → re-encode) lives in
 * M7a/M7b translators that the M5 dispatcher would invoke after upstream
 * returns — but per M9 D-LOCK-8 stream-deferral, that pipeline is DORMANT
 * on the wire (`forward-stream.ts` is byte passthrough; `applyEvent` is
 * never called). M9 ships the declarative-config contract (validator
 * recognizes the 3 shapes); M10 wires the actual per-event translation
 * pipeline + may flesh out these rules with real response post-processing.
 *
 * **Ctx surfaces.**
 *   - `ctx_reads: []` — pure no-op; reads nothing.
 *   - `ctx_writes: []` — pure no-op; writes nothing.
 *
 * **Behavior.** Returns `{ctx, applied: false}` unconditionally. The
 * registry entry's `response_shape: "anthropic_v1_messages"` is the
 * load-bearing semantic — it lets `validateResponseShape` count this
 * rule as offering the matching shape.
 *
 * **D-LOCK-18 default materialization.** TransformFn opens with
 * `Schema.parse(options)` per the canonical pattern from
 * `merge_anthropic_betas.ts:112` so any future schema defaults materialize
 * at runtime (currently the schema has none beyond `name`/`use`/`when`/
 * `on_error`, but the discipline is enforced for forward-compat).
 *
 * **Cross-references.**
 *   - `decisions.md` § D31 (M8 scope reconciliation; declarative-config
 *     contract for response shapes).
 *   - `redirect_to_anthropic_messages.ts` — body-side declarer of
 *     `response_shape: "anthropic_v1_messages"`.
 *   - `_validate_response_shape.ts` — config-load validator that pairs
 *     body declarers with response consumers.
 *   - M9 task spec § D-LOCK-7 (template), § D-LOCK-13 (RouteSchema
 *     extension), § D-LOCK-18 (zod default materialization).
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const ResponsePassthroughAnthropicV1MessagesSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("response_passthrough_anthropic_v1_messages"),
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

const response_passthrough_anthropic_v1_messages: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  // D-LOCK-18: materialize zod defaults at runtime via Schema.parse(options).
  // No defaults today; the discipline guards against future schema growth.
  ResponsePassthroughAnthropicV1MessagesSchema.parse(options);
  // Pure pass-through. The actual stream-side translation is DEFERRED to M10
  // per D-LOCK-8 (forward-stream.ts is byte passthrough; no per-event apply
  // pipeline exists). This rule's role is purely the response_shape
  // declaration so the validator recognizes the anthropic_v1_messages shape
  // as offered.
  return { ctx, applied: false };
};

register(
  "response_passthrough_anthropic_v1_messages",
  response_passthrough_anthropic_v1_messages,
  ResponsePassthroughAnthropicV1MessagesSchema,
  {
    response_shape: "anthropic_v1_messages",
    ctx_reads: [],
    ctx_writes: [],
  },
);

export {
  response_passthrough_anthropic_v1_messages,
  ResponsePassthroughAnthropicV1MessagesSchema,
};
