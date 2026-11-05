/**
 * rename_model.ts — body-engine rule: rewrite `ctx.body.model` per a config-
 * driven mapping (exact case-insensitive override map AND/OR a regex-based
 * default fallback).
 *
 * **M6 primitive (built-in).** Self-registers at module load. Naming
 * convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § translateModelName` (line 1111). Bundle's behavior:
 *   1. If a config override map exists AND the input model (lowercased)
 *      matches a key, return the mapped value.
 *   2. Otherwise apply the regex `^(claude-(?:opus|sonnet|haiku)-\d+)-(\d{1,2})\b`
 *      to convert CC hyphenated minor versions (`claude-opus-4-6`) to Copilot
 *      dotted versions (`claude-opus-4.6`). Dotted names pass through.
 *
 * **M6 declarative shape.** The bundle's regex is a *hardcoded fallback*; v2
 * makes it OPT-IN via config so default.yaml authors can pick any combination:
 *
 *   - `{ map: Record<string,string> }` — exact case-insensitive lookup
 *     ONLY. Unmatched models pass through unchanged. Mirrors the bundle's
 *     primary path (its `_modelMap` override).
 *   - `{ from: string|regex, to: string }` — regex-based replace. The
 *     `from` field is interpreted as a regex source (no `/` delimiters,
 *     no flags); `to` is a String.prototype.replace replacement string
 *     (so `$1`, `$2` backrefs work).
 *   - Both `map` and `from`+`to` may coexist — `map` wins on exact match;
 *     `from` is the fallback.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]` — reads `ctx.body.model`.
 *   - `ctx_writes: ["body"]` — mutates `ctx.body.model`.
 *
 * **Behavior.**
 *   - If `ctx.body` is not a plain object OR `ctx.body.model` is not a
 *     string → `applied: false` (predicate matched but rule chose not to
 *     fire). M3 day-1 convention.
 *   - If `map` resolves a value → mutate in place + emit `before`/`after`.
 *   - Else if `from`+`to` rewrite changes the value → mutate + emit.
 *   - Else (no-op rewrite) → `applied: false`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: rename_cc_minor_to_dotted
 *   use: rename_model
 *   when: { route: "/v1/messages" }
 *   from: "^(claude-(?:opus|sonnet|haiku)-\\d+)-(\\d{1,2})\\b"
 *   to: "$1.$2"
 *
 * - name: rename_o3mini_to_o3
 *   use: rename_model
 *   when: { route: "/v1/chat/completions" }
 *   map:
 *     "o3-mini": "o3"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/transform/registry.ts § register` — registration API.
 *   - Sister project D6 / F33 — Claude lane production verification.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const RenameModelSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("rename_model"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    map: z.record(z.string(), z.string()).optional(),
    from: z.string().min(1).optional(),
    to: z.string().optional(),
  })
  .passthrough()
  .refine(
    (o) => o.map !== undefined || o.from !== undefined,
    "rename_model: must specify at least one of `map` or `from`+`to`",
  )
  .refine(
    (o) => (o.from === undefined) === (o.to === undefined),
    "rename_model: `from` and `to` must be specified together",
  );

type RenameModelOpts = z.infer<typeof RenameModelSchema>;

/**
 * Lower-case all keys of a `Record<string,string>` so case-insensitive
 * lookups are O(1). The original object is never mutated.
 */
function lowercaseKeys(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k.toLowerCase()] = v;
  return out;
}

const rename_model: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as RenameModelOpts;
  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const body = ctx.body as Record<string, unknown>;
  const before = body.model;
  if (typeof before !== "string") {
    return { ctx, applied: false };
  }

  // 1. Exact-match override map (case-insensitive).
  if (opts.map !== undefined) {
    const lookup = lowercaseKeys(opts.map);
    const hit = lookup[before.toLowerCase()];
    if (hit !== undefined && hit !== before) {
      body.model = hit;
      return { ctx, applied: true, before, after: hit };
    }
  }

  // 2. Regex fallback.
  if (opts.from !== undefined && opts.to !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(opts.from);
    } catch {
      // Schema accepts any string for `from`; an invalid regex at apply
      // time is a config error. Treat as no-op rather than throw — the
      // operator will see the rule did nothing and check their config.
      return { ctx, applied: false };
    }
    const after = before.replace(re, opts.to);
    if (after !== before) {
      body.model = after;
      return { ctx, applied: true, before, after };
    }
  }

  return { ctx, applied: false };
};

register("rename_model", rename_model, RenameModelSchema, {
  ctx_reads: ["body"],
  ctx_writes: ["body"],
});

export { rename_model, RenameModelSchema };
