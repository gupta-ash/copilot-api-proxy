/**
 * passthrough_headers.ts — body-engine rule: allowlist filter on
 * `ctx.headers`. Drops any header NOT in `opts.allow` (case-insensitive
 * name match). Preserves the value of allowed headers untouched.
 *
 * **M6 primitive (built-in).** Self-registers on the **body engine surface**
 * per D-LOCK-1. Naming convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **NEW — no upstream cribbing.** The legacy bundle's header forwarding is
 * implicit (everything passes through unless explicitly stripped). This
 * primitive lets default.yaml authors declare a STRICT allowlist for
 * security-sensitive lanes (e.g., "only forward auth + content-type +
 * anthropic-beta to upstream").
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["headers"]`.
 *   - `ctx_writes: ["headers"]`.
 *
 * **Behavior.**
 *   - Build a lowercased allowlist set. Walk `ctx.headers`, copy entries
 *     whose lowercased key is in the allowlist. The output uses
 *     lowercased canonical keys (matching the `setHeader` convention).
 *   - If at least one entry was dropped → `applied: true`, `before` =
 *     prior headers dict snapshot, `after` = new headers dict.
 *   - If nothing was dropped (input was already a subset) → `applied: false`.
 *   - Empty allowlist → drops EVERYTHING; `applied: true` if there was
 *     anything to drop, else `false`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: strict_upstream_passthrough
 *   use: passthrough_headers
 *   when: { route: "/v1/messages" }
 *   allow:
 *     - authorization
 *     - content-type
 *     - anthropic-beta
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/headers.ts` — header dict helpers (case-insensitive convention).
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const PassthroughHeadersSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("passthrough_headers"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    allow: z.array(z.string().min(1)),
  })
  .passthrough();

type PassthroughHeadersOpts = z.infer<typeof PassthroughHeadersSchema>;

const passthrough_headers: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as PassthroughHeadersOpts;
  const allowSet = new Set<string>(opts.allow.map((s) => s.toLowerCase()));
  const beforeHeaders: Record<string, string> = {};
  const afterHeaders: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(ctx.headers)) {
    const lk = k.toLowerCase();
    beforeHeaders[lk] = v;
    if (allowSet.has(lk)) {
      afterHeaders[lk] = v;
    } else {
      dropped.push(lk);
    }
  }
  if (dropped.length === 0) {
    return { ctx, applied: false };
  }
  ctx.headers = afterHeaders;
  // Provenance: emit prior + new headers + the dropped name list as
  // structured before/after objects. Trace consumers can inspect dropped
  // for diagnostics.
  return {
    ctx,
    applied: true,
    before: beforeHeaders,
    after: { headers: afterHeaders, headers_dropped: dropped },
  };
};

register("passthrough_headers", passthrough_headers, PassthroughHeadersSchema, {
  ctx_reads: ["headers"],
  ctx_writes: ["headers"],
});

export { passthrough_headers, PassthroughHeadersSchema };
