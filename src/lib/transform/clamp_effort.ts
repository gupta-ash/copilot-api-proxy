/**
 * clamp_effort.ts — body-engine rule: clamp `output_config.effort` (or any
 * configured target path) to a per-model maximum effort level. Mirrors the
 * legacy bundle's per-model clamp for Claude reasoning effort.
 *
 * **M6 primitive (built-in).** Self-registers at module load. Naming
 * convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § clampEffortForModel` (line 2075). Bundle's behavior:
 *
 *   ```js
 *   function clampEffortForModel(model, effort) {
 *     const m = translateModelName(model);
 *     if (/claude-opus-4\.7/.test(m)) return 'medium';
 *     if (/^claude/i.test(m) && effort === 'xhigh') return 'high';
 *     return effort;
 *   }
 *   ```
 *
 * **M6 declarative shape.** The bundle hard-codes regex predicates +
 * targets; v2 makes both config-driven so default.yaml authors can clamp
 * any model with any cap. Two predicate styles supported (mutually
 * exclusive at a single rule):
 *
 *   - `model_glob: string` — glob match against `ctx.model` (`*` = any
 *     chars, `?` = single char; anchored). Same grammar as `When.model_glob`.
 *   - `model: string` — exact match against `ctx.model`.
 *
 * If neither is provided, the rule applies to ALL models (caller is expected
 * to use `when:` for finer scoping per the engine's predicate contract).
 *
 * **Effort levels.** `low` < `medium` < `high` < `xhigh` ordered ordinal.
 * Clamp is "set effort to min(current, max_effort)" — values already at or
 * below the cap pass through.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]` — reads `ctx.body.output_config.effort`.
 *   - `ctx_writes: ["body"]` — mutates the same path.
 *
 * **Behavior.**
 *   - Predicate: if `model_glob` or `model` set, evaluate against `ctx.model`.
 *     No match → `applied: false`.
 *   - Find effort at `output_config.effort` OR `reasoning_effort` OR
 *     `reasoning.effort` (in that priority — the bundle reads multiple
 *     surfaces per `deriveReasoningEffort`).
 *   - If effort is unset OR not one of the 4 known levels → `applied: false`.
 *   - If effort > max_effort → set to max_effort, emit `before`/`after`.
 *   - Else → `applied: false`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: cap_opus47_effort
 *   use: clamp_effort
 *   when: { route: "/v1/messages" }
 *   model_glob: "claude-opus-4.7*"
 *   max_effort: medium
 *
 * - name: cap_claude_xhigh
 *   use: clamp_effort
 *   model_glob: "claude-*"
 *   max_effort: high
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/transform/registry.ts § register` — registration API.
 *   - `lib/predicate.ts § evaluate` — model_glob grammar reference.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

const ClampEffortSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("clamp_effort"),
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
    max_effort: z.enum(EFFORT_LEVELS),
  })
  .passthrough();

type ClampEffortOpts = z.infer<typeof ClampEffortSchema>;

/**
 * Compile a glob (`*`, `?`) against an entire string (anchored). Same
 * grammar `predicate.ts § evaluate` uses for `When.model_glob`. Inlined
 * here to avoid coupling clamp_effort to predicate.ts internals.
 */
function compileGlob(glob: string): RegExp {
  // Escape regex meta-chars EXCEPT `*` and `?`, then convert.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

/**
 * Locate the effort field on the body. Returns `{ parent, key, value }` for
 * the FIRST matching path in priority order, or `undefined` if none of the
 * paths resolve to a known effort level.
 *
 * Priority mirrors the legacy bundle's `deriveReasoningEffort` read order:
 *   1. `reasoning_effort` (top-level)
 *   2. `output_config.effort`
 *   3. `reasoning.effort`
 */
function findEffortField(body: Record<string, unknown>):
  | {
      parent: Record<string, unknown>;
      key: string;
      value: EffortLevel;
    }
  | undefined {
  const candidates: Array<[Record<string, unknown>, string]> = [];
  candidates.push([body, "reasoning_effort"]);
  if (
    body.output_config !== null &&
    typeof body.output_config === "object" &&
    !Array.isArray(body.output_config)
  ) {
    candidates.push([body.output_config as Record<string, unknown>, "effort"]);
  }
  if (
    body.reasoning !== null &&
    typeof body.reasoning === "object" &&
    !Array.isArray(body.reasoning)
  ) {
    candidates.push([body.reasoning as Record<string, unknown>, "effort"]);
  }
  for (const [parent, key] of candidates) {
    const v = parent[key];
    if (
      typeof v === "string" &&
      (EFFORT_LEVELS as readonly string[]).includes(v)
    ) {
      return { parent, key, value: v as EffortLevel };
    }
  }
  return undefined;
}

const clamp_effort: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as ClampEffortOpts;

  // Predicate: model match (if specified)
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
  const located = findEffortField(body);
  if (located === undefined) {
    return { ctx, applied: false };
  }

  const cap = opts.max_effort;
  const capIdx = EFFORT_LEVELS.indexOf(cap);
  const curIdx = EFFORT_LEVELS.indexOf(located.value);
  if (curIdx <= capIdx) {
    return { ctx, applied: false };
  }
  const before = located.value;
  located.parent[located.key] = cap;
  return { ctx, applied: true, before, after: cap };
};

register("clamp_effort", clamp_effort, ClampEffortSchema, {
  ctx_reads: ["body"],
  ctx_writes: ["body"],
});

export { clamp_effort, ClampEffortSchema };
