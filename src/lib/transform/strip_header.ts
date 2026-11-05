/**
 * strip_header.ts — body-engine rule: drop entire header(s) by name from
 * `ctx.headers`. Deny-list peer of `inject_headers`.
 *
 * Self-registers on the body engine surface.
 *
 * **NEW — no upstream cribbing.** The legacy bundle's header
 * forwarding/stripping is implicit; this primitive declarativizes the
 * "drop entire header" semantic for default.yaml authors.
 *
 * **Context surfaces.**
 *   - `ctx_reads: ["headers"]`.
 *   - `ctx_writes: ["headers"]`.
 *
 * **Behavior.**
 *   - For each name in `opts.headers`: case-insensitive lookup; if present,
 *     omit from the new headers dict.
 *   - The new dict uses lowercased canonical keys (matches `setHeader`
 *     convention).
 *   - `applied: true` if at least ONE header was removed; else `applied: false`.
 *
 * **Provenance fields.**
 *   - `headers_dropped: string[]` — list of lowercased names of headers
 *     that were actually dropped.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: drop_client_telemetry_headers
 *   use: strip_header
 *   headers:
 *     - x-stainless-arch
 *     - x-stainless-os
 *     - x-stainless-runtime
 * ```
 *
 * **Cross-references.**
 *   - `lib/headers.ts` — header dict helpers.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const StripHeaderSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("strip_header"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    headers: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

type StripHeaderOpts = z.infer<typeof StripHeaderSchema>;

const strip_header: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as StripHeaderOpts;
  const denySet = new Set<string>(opts.headers.map((s) => s.toLowerCase()));
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(ctx.headers)) {
    const lk = k.toLowerCase();
    if (denySet.has(lk)) {
      dropped.push(lk);
    } else {
      out[lk] = v;
    }
  }
  if (dropped.length === 0) {
    return { ctx, applied: false };
  }
  ctx.headers = out;
  return {
    ctx,
    applied: true,
    before: { headers_dropped: [] as string[] }, // placeholder — semantically `before` lists "what would be dropped"
    after: { headers_dropped: dropped },
  };
};

register("strip_header", strip_header, StripHeaderSchema, {
  ctx_reads: ["headers"],
  ctx_writes: ["headers"],
});

export { strip_header, StripHeaderSchema };
