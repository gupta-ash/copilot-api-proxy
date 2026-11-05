/**
 * modify_body_block.ts — body-engine rule: for each leaf the selector
 * matches, deep-merge `opts.modify` (a plain object) into the leaf.
 *
 * **Day-1 rule (M3).** Self-registers at module load.
 *
 * **Behavior.**
 *   - If the matched leaf is itself a plain object, deep-merge `opts.modify`
 *     in place (later writes win; arrays are replaced wholesale rather than
 *     element-merged).
 *   - If the matched leaf is NOT a plain object (string, array, number,
 *     null), the rule treats it as `applied: false` for that match —
 *     replacing in place would change the leaf TYPE silently and surprise
 *     downstream rules. M3 chooses the conservative no-op; M3.1 may add a
 *     `modify_body_value` primitive for type-replacing semantics if needed.
 *   - Reports `before` = pre-merge leaf snapshots, `after` = post-merge
 *     snapshots.
 *
 * **Named-fn-modify extension point (deferred to M3.1).** A future
 * extension may accept `opts.modify_fn: string` resolving to a registered
 * named modifier function (e.g. `bump_max_tokens`). This shape would let
 * config authors express more than static merges. M3 deliberately skips
 * implementation but documents the slot here so the schema can be extended
 * without a breaking change.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: cap_max_tokens
 *   use: modify_body_block
 *   when: { route: "/v1/messages" }
 *   selector:
 *     path: "messages[].content[]"
 *     matcher: { contains: "DRAFT" }
 *   modify:
 *     stop_reason: "manual_cap"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M3 — Day-1 body-content rules.
 *   - `lib/selector.ts § select` — selector grammar + matcher contract.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { select, type Selector } from "../selector.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const SelectorSchema = z.object({
  path: z.string().min(1),
  matcher: z
    .object({
      equals: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      contains: z.string().optional(),
      regex: z.string().optional(),
      jsonpath: z.string().optional(),
    })
    .refine(
      (m) =>
        m.equals !== undefined ||
        m.startsWith !== undefined ||
        m.endsWith !== undefined ||
        m.contains !== undefined ||
        m.regex !== undefined ||
        m.jsonpath !== undefined,
      {
        message:
          "matcher must specify exactly one of equals/startsWith/endsWith/contains/regex/jsonpath",
      },
    ),
});

const ModifyBodyBlockSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("modify_body_block"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    selector: SelectorSchema,
    modify: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/**
 * Recursive deep-merge: for each top-level key in `patch`, if both source
 * and target carry a plain-object value, recurse; otherwise the patch
 * value wins. Arrays are NOT element-merged (last-writer wins). Mutates
 * `target` in place; returns it for ergonomics.
 */
function deepMergeInto(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    const existing = target[k];
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      deepMergeInto(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      target[k] = v;
    }
  }
  return target;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const modify_body_block: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as z.infer<typeof ModifyBodyBlockSchema>;
  const matches = select(ctx.body, opts.selector as Selector);
  if (matches.length === 0) {
    return { ctx, applied: false };
  }

  const before: unknown[] = [];
  const after: unknown[] = [];
  let anyApplied = false;

  for (const m of matches) {
    // Only deep-merge into plain-object leaves; non-objects are conservative
    // no-ops (would otherwise silently change the leaf type).
    if (!isPlainObject(m.value)) continue;

    before.push(structuredClone(m.value));
    deepMergeInto(m.value, opts.modify);
    after.push(structuredClone(m.value));
    anyApplied = true;
  }

  if (!anyApplied) {
    return { ctx, applied: false };
  }

  return { ctx, applied: true, before, after };
};

register("modify_body_block", modify_body_block, ModifyBodyBlockSchema);

export { modify_body_block, ModifyBodyBlockSchema };
