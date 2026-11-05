/**
 * add_body_block.ts — body-engine rule: append (default) or prepend a value
 * to the array at `opts.path`.
 *
 * **Day-1 rule (M3).** Self-registers at module load.
 *
 * **Behavior.**
 *   - `opts.path` is a dotted/bracketed path (same syntax as
 *     `lib/selector.ts § parsePath`, but with a focused subset — no
 *     wildcards, no matchers; we are RESOLVING a single container, not
 *     filtering leaves). M3 implements its own minimal resolver inline to
 *     avoid coupling to selector.ts internals; if more rules need
 *     path-resolution, M5+ may factor a shared helper.
 *   - If the resolved value is NOT an array, returns `applied: false`
 *     (selectors are optimistic about real-world bodies).
 *   - If `position: "start"`, prepends; otherwise (default `"end"`),
 *     appends.
 *   - Reports `before` = `null`, `after` = the added value.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: append_safety_tool
 *   use: add_body_block
 *   when: { route: "/v1/messages" }
 *   path: "tools"
 *   value:
 *     name: "safety_check"
 *     description: "Check for unsafe content"
 *   position: "end"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M3 — Day-1 body-content rules.
 *   - `lib/selector.ts § parsePath` — pattern reference for the path
 *     resolver shape (this rule replicates a focused subset).
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const AddBodyBlockSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("add_body_block"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    path: z.string().min(1),
    value: z.unknown(),
    position: z.enum(["start", "end"]).optional(),
  })
  .passthrough();

/**
 * Resolve a dotted/bracketed path to a single container. Returns the
 * container if it exists at the given path AND is an array; returns
 * `undefined` otherwise. Supports `field`, `field.sub`, `field[0]`,
 * `field[0].sub`. Wildcards (`[]`) are not supported (the rule resolves a
 * SINGLE container, not multiple).
 */
function resolveArrayContainer(
  body: unknown,
  path: string,
): unknown[] | undefined {
  if (path.length === 0) return undefined;
  const SEG_RE = /^([a-zA-Z_$][a-zA-Z_$0-9]*)|^\[(\d+)\]/;
  let node: unknown = body;
  let rest = path;
  let first = true;
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      if (first) return undefined;
      rest = rest.slice(1);
      const m = /^([a-zA-Z_$][a-zA-Z_$0-9]*)/.exec(rest);
      if (!m) return undefined;
      const fieldName = m[1] as string;
      if (
        node === null ||
        typeof node !== "object" ||
        Array.isArray(node) ||
        !Object.prototype.hasOwnProperty.call(node, fieldName)
      ) {
        return undefined;
      }
      node = (node as Record<string, unknown>)[fieldName];
      rest = rest.slice(m[0].length);
      first = false;
      continue;
    }
    const m = SEG_RE.exec(rest);
    if (!m) return undefined;
    if (m[1] !== undefined) {
      const fieldName = m[1];
      if (
        node === null ||
        typeof node !== "object" ||
        Array.isArray(node) ||
        !Object.prototype.hasOwnProperty.call(node, fieldName)
      ) {
        return undefined;
      }
      node = (node as Record<string, unknown>)[fieldName];
    } else if (m[2] !== undefined) {
      const idx = Number(m[2]);
      if (!Array.isArray(node) || idx < 0 || idx >= node.length) {
        return undefined;
      }
      node = node[idx];
    }
    rest = rest.slice(m[0].length);
    first = false;
  }
  return Array.isArray(node) ? node : undefined;
}

const add_body_block: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as z.infer<typeof AddBodyBlockSchema>;
  const container = resolveArrayContainer(ctx.body, opts.path);
  if (container === undefined) {
    return { ctx, applied: false };
  }

  const value = opts.value;
  const position = opts.position ?? "end";
  if (position === "start") {
    container.unshift(value);
  } else {
    container.push(value);
  }

  return {
    ctx,
    applied: true,
    before: null,
    after: structuredClone(value),
  };
};

register("add_body_block", add_body_block, AddBodyBlockSchema);

export { add_body_block, AddBodyBlockSchema };
