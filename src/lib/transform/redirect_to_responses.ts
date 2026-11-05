/**
 * Mark a request for the Responses route using the internal
 * `x-proxy-redirect-to: /v1/responses` header. The dispatcher consumes this
 * marker; it is not an upstream wire header. Body conversion belongs to
 * `translate_anthropic_to_responses`, and event conversion is configured
 * separately. This declarative rule is independent of the legacy bundle's
 * imperative redirect implementation.
 *
 * Declares response_shape="openai_responses"; configuration validation
 * requires a matching response consumer. The rule reads body and writes
 * body/headers to match the redirect family manifest, but directly changes
 * only the marker. It always reports applied with before/after marker values.
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

// Internal redirect marker uses the same /v1/* convention as sibling rules.
const REDIRECT_TARGET = "/v1/responses";

const RedirectToResponsesSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("redirect_to_responses"),
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

const redirect_to_responses: TransformFn = (
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
  "redirect_to_responses",
  redirect_to_responses,
  RedirectToResponsesSchema,
  {
    response_shape: "openai_responses",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
);

export { redirect_to_responses, RedirectToResponsesSchema };
