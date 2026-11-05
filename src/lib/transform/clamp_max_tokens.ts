/**
 * clamp_max_tokens.ts — body-engine rule: clamp `max_tokens` to a per-model
 * maximum. Mirrors the legacy bundle's per-model max_tokens cap.
 *
 * **M6 primitive (built-in).** Self-registers at module load. Naming
 * convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § clampMaxTokensForModel` (line 2082). Bundle's behavior:
 *
 *   ```js
 *   function clampMaxTokensForModel(model, maxTokens) {
 *     const m = translateModelName(model);
 *     if (/claude-opus-4\.6-1m/.test(m)) return Math.min(maxTokens || 64000, 64000);
 *     if (/^claude/i.test(m)) return Math.min(maxTokens || 32000, 32000);
 *     return maxTokens;
 *   }
 *   ```
 *
 * **M6 declarative shape.** Bundle hard-codes regex predicates + caps; v2
 * makes both config-driven. Two predicate styles supported (mutually
 * exclusive at a single rule):
 *
 *   - `model_glob: string` — glob match against `ctx.model`.
 *   - `model: string` — exact match against `ctx.model`.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]` — reads `ctx.body.max_tokens`.
 *   - `ctx_writes: ["body"]` — mutates the same path.
 *
 * **Behavior.**
 *   - Predicate: model match (if specified). No match → `applied: false`.
 *   - Read `ctx.body.max_tokens`. If unset OR not a positive integer →
 *     `applied: false` (we don't synthesize a default — that's the
 *     bundle's `|| 64000` fallback which is route-specific concern).
 *   - If max_tokens > opts.max → set to opts.max + emit `before`/`after`.
 *   - Else → `applied: false`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: cap_opus46_1m_max_tokens
 *   use: clamp_max_tokens
 *   model_glob: "claude-opus-4.6-1m*"
 *   max: 64000
 *
 * - name: cap_claude_max_tokens
 *   use: clamp_max_tokens
 *   model_glob: "claude-*"
 *   max: 32000
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const ClampMaxTokensSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("clamp_max_tokens"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    model: z.string().min(1).optional(),
    model_glob: z.string().min(1).optional(),
    max: z.number().int().positive(),
  })
  .passthrough();

type ClampMaxTokensOpts = z.infer<typeof ClampMaxTokensSchema>;

function compileGlob(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

const clamp_max_tokens: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as ClampMaxTokensOpts;

  if (opts.model !== undefined && ctx.model !== opts.model) {
    return { ctx, applied: false };
  }
  if (
    opts.model_glob !== undefined &&
    !compileGlob(opts.model_glob).test(ctx.model)
  ) {
    return { ctx, applied: false };
  }

  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const body = ctx.body as Record<string, unknown>;
  const current = body.max_tokens;
  if (
    typeof current !== "number" ||
    !Number.isInteger(current) ||
    current <= 0
  ) {
    return { ctx, applied: false };
  }
  if (current <= opts.max) {
    return { ctx, applied: false };
  }
  body.max_tokens = opts.max;
  return { ctx, applied: true, before: current, after: opts.max };
};

register("clamp_max_tokens", clamp_max_tokens, ClampMaxTokensSchema, {
  ctx_reads: ["body"],
  ctx_writes: ["body"],
});

export { clamp_max_tokens, ClampMaxTokensSchema };
