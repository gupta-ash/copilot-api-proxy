/**
 * derive_copilot_vision_request.ts — body-engine rule: derives the
 * `copilot-vision-request: true` header by walking the request body's
 * message content blocks looking for image content (Anthropic, OpenAI
 * Responses, OR OpenAI Chat shapes).
 *
 * **Lane:** any lane that may carry image content upstream to Copilot Ent.
 * Copilot Ent's vision-aware models gate on this header — without it,
 * vision content is silently ignored.
 *
 * **D33 — OPT-IN.** Per `decisions.md § D33`, this rule ships as opt-in
 * (NOT wired in `config/default.yaml`). Operators add it to their own YAML
 * if they observe a need (e.g. a harness that sends image content but
 * doesn't set the header itself). See
 * `verification/wiki41_to_v2_mapping.md § GAP-2` for the gap surfacing.
 *
 * **Logic** (per spec D-LOCK-3):
 *   - Walk `ctx.body.messages[].content[]` looking for any block that
 *     matches one of the 3 image shapes:
 *     - Anthropic shape: `{type: "image", source: {type: "base64", ...}}`
 *     - OpenAI Responses shape: `{type: "input_image", image_url: {...}}`
 *     - OpenAI Chat shape: `{image_url: {...}}` (with or without `type`)
 *   - If FOUND: set header to `value_when_present` (default `"true"`).
 *     `applied: true` (or `false` if header is already that value).
 *   - If NOT FOUND AND `value_when_absent !== null`: set header to
 *     `value_when_absent`. `applied: true` / `false` per existing value.
 *   - If NOT FOUND AND `value_when_absent === null` (default): do not
 *     touch the header. `applied: false`.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["headers"]`.
 *
 * **D-LOCK-18 (M9 spec):** the rule fn opens with
 * `const opts = DeriveCopilotVisionRequestSchema.parse(options);` to
 * materialize the `header_name` / `value_when_present` /
 * `value_when_absent` zod defaults at runtime. Reference pattern: M8's
 * `merge_anthropic_betas.ts:112`.
 *
 * **No upstream cribbing** — image-shape walking inferred from Anthropic,
 * OpenAI Responses, and OpenAI Chat schemas; no copilot-api-pro bundle
 * equivalent.
 *
 * **Cross-references.**
 *   - `decisions.md § D33` — opt-in default rationale.
 *   - `verification/wiki41_to_v2_mapping.md § GAP-2` — gap surfacing.
 *   - `lib/headers.ts § getHeader/setHeader` — header dict helpers.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { getHeader, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const DeriveCopilotVisionRequestSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("derive_copilot_vision_request"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    /** Header name to write (default `"copilot-vision-request"`). */
    header_name: z.string().default("copilot-vision-request"),
    /** Header value when image content found (default `"true"`). */
    value_when_present: z.string().default("true"),
    /**
     * Header value when no image content found. When `null` (default),
     * the rule omits the header rather than setting it. Operators may
     * supply `"false"` (or any explicit string) to force a negative
     * marker on every request.
     */
    value_when_absent: z.string().nullable().default(null),
  })
  .passthrough();

/**
 * Detect whether a single content block is an image, across the 3
 * shapes documented in the module head. Pure read.
 */
function isImageBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  const b = block as Record<string, unknown>;
  // Anthropic shape: {type: "image", source: {...}}
  if (b.type === "image") return true;
  // OpenAI Responses shape: {type: "input_image", image_url: {...}}
  if (b.type === "input_image") return true;
  // OpenAI Chat shape: {image_url: {...}} (type may be "image_url" or omitted)
  if (b.image_url !== undefined) return true;
  return false;
}

/**
 * Walk all messages and return true on the first image block found.
 * Returns false for non-object body, missing/empty messages, or no
 * image content anywhere.
 */
function hasImageContent(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isImageBlock(block)) return true;
    }
  }
  return false;
}

const derive_copilot_vision_request: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = DeriveCopilotVisionRequestSchema.parse(options);
  const headerName = opts.header_name;
  const lname = headerName.toLowerCase();
  const found = hasImageContent(ctx.body);

  let target: string | null;
  if (found) {
    target = opts.value_when_present;
  } else if (opts.value_when_absent !== null) {
    target = opts.value_when_absent;
  } else {
    target = null;
  }

  if (target === null) {
    return { ctx, applied: false };
  }

  const before = getHeader(ctx.headers, headerName);
  if (before === target) {
    return { ctx, applied: false };
  }
  ctx.headers = setHeader(ctx.headers, headerName, target);
  return {
    ctx,
    applied: true,
    before: { [lname]: before ?? null },
    after: { [lname]: target },
  };
};

register(
  "derive_copilot_vision_request",
  derive_copilot_vision_request,
  DeriveCopilotVisionRequestSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["headers"],
  },
);

export { derive_copilot_vision_request, DeriveCopilotVisionRequestSchema };
