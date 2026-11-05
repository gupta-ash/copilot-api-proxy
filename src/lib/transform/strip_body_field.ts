/**
 * strip_body_field.ts — body-engine rule: dot-path delete one or more
 * OBJECT fields (e.g. `output_config.effort`). Multiple paths per rule.
 *
 * **Day-1 rule (M3).** Self-registers at module load.
 *
 * **Behavior.**
 *   - For each path, walks `ctx.body` along dot-segments. If the final
 *     parent is an object that owns the final key, `delete parent[key]`.
 *   - NOT array-aware (no `[]` / `[N]` syntax). Use `strip_body_block` for
 *     array-aware removal.
 *   - Reports `before` = `Record<path, removedValue>`, `after` = `null`.
 *   - `applied: true` only if at least ONE path was actually deleted; if
 *     ALL paths missed, returns `applied: false`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: strip_output_config_effort
 *   use: strip_body_field
 *   when: { route: "/v1/messages" }
 *   paths:
 *     - "output_config.effort"
 *     - "thinking.type"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M3 — Day-1 body-content rules.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const StripBodyFieldSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("strip_body_field"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    paths: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

/**
 * Walk `body` along dot-segments to the parent of the final key. Returns
 * `{ parent, key }` if the final parent is a plain object that owns the
 * final key; returns `undefined` otherwise (path missed). The caller is
 * responsible for the actual delete.
 */
function resolveLeafParent(
  body: unknown,
  path: string,
): { parent: Record<string, unknown>; key: string } | undefined {
  if (path.length === 0) return undefined;
  const segments = path.split(".");
  if (segments.some((s) => s.length === 0)) return undefined;
  let node: unknown = body;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
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
  const finalKey = segments[segments.length - 1] as string;
  if (
    node === null ||
    typeof node !== "object" ||
    Array.isArray(node) ||
    !Object.prototype.hasOwnProperty.call(node, finalKey)
  ) {
    return undefined;
  }
  return { parent: node as Record<string, unknown>, key: finalKey };
}

const strip_body_field: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as z.infer<typeof StripBodyFieldSchema>;
  const before: Record<string, unknown> = {};
  let anyApplied = false;

  for (const path of opts.paths) {
    const located = resolveLeafParent(ctx.body, path);
    if (located === undefined) continue;
    before[path] = structuredClone(located.parent[located.key]);
    delete located.parent[located.key];
    anyApplied = true;
  }

  if (!anyApplied) {
    return { ctx, applied: false };
  }

  return { ctx, applied: true, before, after: null };
};

register("strip_body_field", strip_body_field, StripBodyFieldSchema);

export { strip_body_field, StripBodyFieldSchema };
