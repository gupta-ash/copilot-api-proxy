/**
 * inject_headers.ts — body-engine rule: set one or more headers on
 * `ctx.headers`. Default behavior: set ONLY when not present (idempotent
 * additions); opt-in `force: true` overwrites existing values.
 *
 * **M6 primitive (built-in).** Self-registers on the **body engine surface**
 * per D-LOCK-1 (no separate "headers" engine — body rules can mutate both
 * `ctx.body` AND `ctx.headers`). Naming convention `<verb>_<scope>` per
 * D-LOCK-8 / O19.
 *
 * **NEW — no upstream cribbing.** The legacy bundle hard-codes header
 * injection in `copilotHeaders` (line 199); this primitive declarativizes
 * that for default.yaml authors. Operationally the production-verified
 * Claude lane (sister project D6 / F33) injects `advanced-tool-use-2025-11-20`
 * via this rule.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["headers"]` — reads existing header presence to decide
 *     idempotent set-or-skip semantics.
 *   - `ctx_writes: ["headers"]` — mutates `ctx.headers`.
 *
 * **Behavior.**
 *   - For each `[name, value]` in `opts.set`:
 *       - If `force: true` OR header is not present (case-insensitive
 *         lookup via `getHeader`), call `setHeader(ctx.headers, name, value)`.
 *       - Else: skip this entry (already present, force off).
 *   - The new headers dict (lowercase canonical) is assigned back to
 *     `ctx.headers`. Under `mutate_in_place: true` (default), this mutates
 *     the same ctx ref. Under `mutate_in_place: false`, the engine handed
 *     us a clone; our assignment lands on the clone; engine adopts via
 *     `result.ctx` (per F1 fix in M2.5 / `apply.ts § 6b`).
 *   - `applied: true` if at least ONE header was written; else `applied: false`.
 *   - `before` = `Record<lowercased_name, prior_value | null>` for each
 *     written header (null when key wasn't present); `after` =
 *     `Record<lowercased_name, new_value>`.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: ensure_advanced_tool_use_beta
 *   use: inject_headers
 *   when: { route: "/v1/messages" }
 *   force: false
 *   set:
 *     anthropic-beta: "advanced-tool-use-2025-11-20"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/headers.ts § setHeader` / `getHeader` — header dict helpers.
 *   - Sister project F33 — Claude lane production verification.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { getHeader, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const InjectHeadersSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("inject_headers"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    set: z.record(z.string().min(1), z.string()),
    force: z.boolean().optional(),
  })
  .passthrough();

type InjectHeadersOpts = z.infer<typeof InjectHeadersSchema>;

const inject_headers: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as InjectHeadersOpts;
  const force = opts.force ?? false;
  const before: Record<string, string | null> = {};
  const after: Record<string, string> = {};
  let working = ctx.headers;
  let anyApplied = false;
  for (const [name, value] of Object.entries(opts.set)) {
    const lname = name.toLowerCase();
    const existing = getHeader(working, name);
    if (!force && existing !== undefined) {
      continue;
    }
    before[lname] = existing ?? null;
    working = setHeader(working, name, value);
    after[lname] = value;
    anyApplied = true;
  }
  if (!anyApplied) {
    return { ctx, applied: false };
  }
  ctx.headers = working;
  return { ctx, applied: true, before, after };
};

register("inject_headers", inject_headers, InjectHeadersSchema, {
  ctx_reads: ["headers"],
  ctx_writes: ["headers"],
});

export { inject_headers, InjectHeadersSchema };
