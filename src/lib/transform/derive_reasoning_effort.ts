/**
 * derive_reasoning_effort.ts — body-engine rule: derive a reasoning_effort
 * value from one or more source paths on the body and write it to a
 * configured target path. Mirrors the legacy bundle's
 * `deriveReasoningEffort` + `applyEffortOverride` chain.
 *
 * **M6 primitive (built-in).** Self-registers at module load. Naming
 * convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § deriveReasoningEffort` (line 1078) +
 * `dist/main.js § applyEffortOverride` (line 149). Bundle's behavior:
 *
 *   - Derive: read `payload.reasoning_effort`, then `output_config.effort`,
 *     then `thinking.budget_tokens` mapped to low/medium/high, then
 *     `thinking.type === "adaptive"` → medium, else default high.
 *   - Override: caller-supplied per-model effort table OR a single override
 *     value (e.g. `"medium"`). Bundle's `_effortByModel` map can also map
 *     to `"passthrough"` to skip override.
 *
 * **M6 declarative shape.** v2 makes derivation data-driven via a single
 * `source_path` (with optional fallbacks via additional rules — chain
 * multiple `derive_reasoning_effort` rules in priority order in the config):
 *
 *   - `source_path: string` — dot-path to read from `ctx.body` (e.g.
 *     `"reasoning_effort"`, `"output_config.effort"`,
 *     `"thinking.budget_tokens"`).
 *   - `target_path: string` — dot-path to write to on `ctx.body` (e.g.
 *     `"reasoning.effort"`).
 *   - `override?: "low"|"medium"|"high"|"xhigh"` — when set, ALWAYS write
 *     this value, ignoring source. Equivalent to the bundle's per-model
 *     effort override.
 *
 * If `source_path` resolves to a number, it's interpreted as
 * `thinking.budget_tokens` per the bundle's mapping:
 *   `<= 1024 → low`, `<= 8192 → medium`, `> 8192 → high`.
 *
 * If `source_path` resolves to one of the 4 effort levels (string), it's
 * used directly.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["body"]`.
 *
 * **Behavior.**
 *   - If `override` is set: always write `target_path = override`.
 *     `applied: true` (with `before` = previous value at target_path,
 *     `after` = override). If target was already that value, still
 *     `applied: false` (no-op semantics).
 *   - Else: read source_path. If unresolved → `applied: false`. Map to
 *     effort level. If mapped value === current target value → `applied: false`.
 *     Else → write + emit before/after.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: derive_effort_from_thinking_budget
 *   use: derive_reasoning_effort
 *   when: { route: "/v1/messages" }
 *   source_path: "thinking.budget_tokens"
 *   target_path: "reasoning.effort"
 *
 * - name: force_medium_for_opus47
 *   use: derive_reasoning_effort
 *   when: { route: "/v1/messages" }
 *   model_glob: "claude-opus-4.7*"
 *   source_path: "reasoning_effort"
 *   target_path: "reasoning.effort"
 *   override: medium
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

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

const DeriveReasoningEffortSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("derive_reasoning_effort"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    source_path: z.string().min(1),
    target_path: z.string().min(1),
    override: z.enum(EFFORT_LEVELS).optional(),
  })
  .passthrough();

type DeriveReasoningEffortOpts = z.infer<typeof DeriveReasoningEffortSchema>;

/**
 * Walk a dot-path on `body` and return the resolved leaf value (or
 * `undefined` if any segment is missing). Read-only (does not mutate).
 */
function readPath(body: unknown, path: string): unknown {
  if (path.length === 0) return undefined;
  const segments = path.split(".");
  let node: unknown = body;
  for (const seg of segments) {
    if (
      node === null ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !Object.prototype.hasOwnProperty.call(node, seg)
    ) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/**
 * Walk a dot-path on `body` and write `value` at the leaf. CREATES
 * intermediate objects as needed (`reasoning.effort` writes through an
 * empty body to `{ reasoning: { effort: ... } }`). Returns `{ before }`
 * carrying the prior leaf value (or `undefined` if not present).
 */
function writePath(
  body: Record<string, unknown>,
  path: string,
  value: unknown,
): { before: unknown } {
  const segments = path.split(".");
  let node: Record<string, unknown> = body;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const existing = node[seg];
    if (
      existing === null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      const fresh: Record<string, unknown> = {};
      node[seg] = fresh;
      node = fresh;
    } else {
      node = existing as Record<string, unknown>;
    }
  }
  const finalKey = segments[segments.length - 1] as string;
  const before = node[finalKey];
  node[finalKey] = value;
  return { before };
}

/**
 * Map a source value to an effort level. Strings already in the 4-level
 * enum pass through. Numbers are mapped per the bundle's
 * `thinking.budget_tokens` table. Anything else returns `undefined`.
 */
function deriveEffort(source: unknown): EffortLevel | undefined {
  if (typeof source === "string") {
    if ((EFFORT_LEVELS as readonly string[]).includes(source)) {
      return source as EffortLevel;
    }
    return undefined;
  }
  if (typeof source === "number" && Number.isFinite(source) && source > 0) {
    if (source <= 1024) return "low";
    if (source <= 8192) return "medium";
    return "high";
  }
  return undefined;
}

const derive_reasoning_effort: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as DeriveReasoningEffortOpts;
  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const body = ctx.body as Record<string, unknown>;

  let derived: EffortLevel | undefined;
  if (opts.override !== undefined) {
    derived = opts.override;
  } else {
    const source = readPath(body, opts.source_path);
    derived = deriveEffort(source);
  }
  if (derived === undefined) {
    return { ctx, applied: false };
  }

  const currentTarget = readPath(body, opts.target_path);
  if (currentTarget === derived) {
    return { ctx, applied: false };
  }

  const { before } = writePath(body, opts.target_path, derived);
  return { ctx, applied: true, before, after: derived };
};

register(
  "derive_reasoning_effort",
  derive_reasoning_effort,
  DeriveReasoningEffortSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
  },
);

export { derive_reasoning_effort, DeriveReasoningEffortSchema };
