/**
 * strip_body_block.ts — body-engine rule: remove the BLOCK containing every
 * leaf the selector matches.
 *
 * **Day-1 rule (M3)** consumed by the R10 acceptance demo (strip CC's
 * billing-header system block + identity system block from an opus inner
 * call). Self-registers at module load.
 *
 * **What "block" means.** A "block" is the natural structural unit at the
 * nearest enclosing array on the match path. Examples:
 *   - selector `items[]` matching string leaves → splice items[i] (the
 *     leaf IS the array element).
 *   - selector `system[].text` matching a leaf string → splice
 *     system[i] (the array ancestor) — i.e. the WHOLE system[i] object
 *     is removed, not just its `.text` field. This is the R10 demo
 *     use case.
 *   - selector `foo` matching a top-level scalar → no array ancestor;
 *     fall back to deleting the `foo` key from the body object.
 *   - selector `messages[].content[].text` matching → splice the inner
 *     `content[i]` block from `messages[j].content`.
 *
 * **Algorithm.**
 *   1. Run `select()` to get every match.
 *   2. For each match, parse the canonical `match.path` to find the
 *      nearest enclosing `[N]` bracket. The path PREFIX up to that bracket
 *      identifies the array; the bracket's `N` is the index to splice.
 *   3. If no `[N]` exists, the leaf is in a plain object — delete the key
 *      from `match.parent` (the M2 fallback semantics).
 *   4. Group splices by their (array-ref, index) so duplicate selector
 *      matches inside the same block (e.g. multiple matching fields on
 *      one system[i]) collapse to one splice.
 *   5. Splice each array in DESCENDING index order so prior indices stay
 *      valid for sibling deletions.
 *
 * **Example config (also exercised by the rule's smoke test).**
 *
 * ```yaml
 * - name: strip_cc_billing_header
 *   use: strip_body_block
 *   when: { route: "/v1/messages" }
 *   selector:
 *     path: "system[].text"
 *     matcher: { startsWith: "x-anthropic-billing-header:" }
 * ```
 *
 * **R10 acceptance use case.** Two rules of this shape applied against a
 * captured CC opus inner-call body shrink `system[]` from 3 elements to 1
 * (just the behavioral instructions); see
 * `tests/transform/strip_body_block.test.ts` § R10 acceptance test.
 *
 * **Cross-references.**
 *   - Plan v4 § M3 — Day-1 body-content rules.
 *   - `decisions.md § D23` — two-engine architecture (body surface).
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

const StripBodyBlockSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("strip_body_block"),
    // engine validates `when` via predicate; rule schema stays loose.
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
  })
  .passthrough();

/**
 * Parse the canonical match path to find the nearest enclosing `[N]`
 * bracket. Returns `{ arrayPathPrefix, index }` if found, `undefined`
 * otherwise (no array ancestor — the leaf is in a plain object).
 *
 * Examples:
 *   "system[0].text"           → { arrayPathPrefix: "system", index: 0 }
 *   "messages[1].content[2].text" → { arrayPathPrefix: "messages[1].content", index: 2 }
 *   "items[3]"                 → { arrayPathPrefix: "items", index: 3 }
 *   "foo.bar"                  → undefined
 */
function findEnclosingArray(
  matchPath: string,
): { arrayPathPrefix: string; index: number } | undefined {
  // Find the LAST `[N]` in the path string.
  const re = /\[(\d+)\]/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(matchPath)) !== null) {
    lastMatch = m;
  }
  if (lastMatch === null) return undefined;
  const idx = Number(lastMatch[1]);
  const arrayPathPrefix = matchPath.slice(0, lastMatch.index);
  return { arrayPathPrefix, index: idx };
}

/**
 * Resolve the array container at the given dotted path (no brackets in
 * the path). Returns `undefined` if the path is empty (top-level array
 * body, where the body itself IS the array).
 */
function resolveArrayAt(
  body: unknown,
  arrayPath: string,
): unknown[] | undefined {
  if (arrayPath.length === 0) {
    // Top-level array body, e.g. selector path "[0].text" → arrayPath "".
    return Array.isArray(body) ? body : undefined;
  }
  // arrayPath may contain dots AND further `[N]` segments (nested arrays).
  // We need a focused walker that handles both. We re-use a small
  // tokenizer here rather than couple to selector.ts internals.
  const SEG_RE = /^([a-zA-Z_$][a-zA-Z_$0-9]*)|^\[(\d+)\]/;
  let node: unknown = body;
  let rest = arrayPath;
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      const fm = /^([a-zA-Z_$][a-zA-Z_$0-9]*)/.exec(rest);
      if (!fm) return undefined;
      const fieldName = fm[1] as string;
      if (
        node === null ||
        typeof node !== "object" ||
        Array.isArray(node) ||
        !Object.prototype.hasOwnProperty.call(node, fieldName)
      ) {
        return undefined;
      }
      node = (node as Record<string, unknown>)[fieldName];
      rest = rest.slice(fm[0].length);
      continue;
    }
    const sm = SEG_RE.exec(rest);
    if (!sm) return undefined;
    if (sm[1] !== undefined) {
      const fieldName = sm[1];
      if (
        node === null ||
        typeof node !== "object" ||
        Array.isArray(node) ||
        !Object.prototype.hasOwnProperty.call(node, fieldName)
      ) {
        return undefined;
      }
      node = (node as Record<string, unknown>)[fieldName];
    } else if (sm[2] !== undefined) {
      const idx = Number(sm[2]);
      if (!Array.isArray(node) || idx < 0 || idx >= node.length) {
        return undefined;
      }
      node = node[idx];
    }
    rest = rest.slice(sm[0].length);
  }
  return Array.isArray(node) ? node : undefined;
}

const strip_body_block: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  // options is already validated by apply.ts BEFORE this fn fires (per the
  // M2 registry contract). We can safely cast to the inferred schema type.
  const opts = options as z.infer<typeof StripBodyBlockSchema>;
  const matches = select(ctx.body, opts.selector as Selector);
  if (matches.length === 0) {
    return { ctx, applied: false };
  }

  // Group splices by (array-ref, index) so duplicate selector matches
  // inside the same block collapse to one splice. Object-parent fallbacks
  // collected separately.
  const arraySplices = new Map<unknown[], Set<number>>();
  const objectDeletes = new Map<Record<string, unknown>, Set<string>>();
  // Capture removed values BEFORE mutation. Deep-clone so callers (trace
  // consumers) can mutate the original body later without surprising the
  // captured snapshot. structuredClone is fine here because match.value
  // came from a JSON tree (no functions / cycles).
  const before: unknown[] = [];

  for (const m of matches) {
    const enclosing = findEnclosingArray(m.path);
    if (enclosing !== undefined) {
      const arr = resolveArrayAt(ctx.body, enclosing.arrayPathPrefix);
      if (arr !== undefined) {
        // Splice the BLOCK at this index from the enclosing array.
        const set = arraySplices.get(arr) ?? new Set<number>();
        if (!set.has(enclosing.index)) {
          // Capture the block snapshot once per (array, index) pair.
          before.push(structuredClone(arr[enclosing.index]));
        }
        set.add(enclosing.index);
        arraySplices.set(arr, set);
        continue;
      }
    }
    // Fallback: object-parent → delete the key.
    if (!Array.isArray(m.parent)) {
      const set = objectDeletes.get(m.parent) ?? new Set<string>();
      if (!set.has(m.index as string)) {
        before.push(structuredClone(m.value));
      }
      set.add(m.index as string);
      objectDeletes.set(m.parent, set);
    } else {
      // Match's immediate parent is an array but findEnclosingArray
      // returned undefined (shouldn't happen — defensive). Splice index.
      const set = arraySplices.get(m.parent) ?? new Set<number>();
      if (!set.has(m.index as number)) {
        before.push(structuredClone(m.value));
      }
      set.add(m.index as number);
      arraySplices.set(m.parent, set);
    }
  }

  // Array splices — DESCENDING index order so prior indices stay valid
  // for sibling deletions in the same array.
  for (const [arr, indices] of arraySplices) {
    const sorted = Array.from(indices).sort((a, b) => b - a);
    for (const i of sorted) {
      arr.splice(i, 1);
    }
  }

  // Object deletes — order doesn't matter.
  for (const [parent, keys] of objectDeletes) {
    for (const k of keys) {
      delete parent[k];
    }
  }

  return { ctx, applied: true, before, after: null };
};

register("strip_body_block", strip_body_block, StripBodyBlockSchema);

export { strip_body_block, StripBodyBlockSchema };
