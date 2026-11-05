/**
 * filter_header_csv.ts — body-engine rule: filter the value of a CSV
 * header (e.g. `anthropic-beta`) to retain only tokens present in the
 * configured allowlist (case-sensitive token match, case-insensitive
 * header name lookup).
 *
 * **M6 primitive (built-in).** Self-registers on the **body engine surface**
 * per D-LOCK-1. Naming convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **NEW — no upstream cribbing.** The legacy bundle handles `anthropic-beta`
 * filtering ad-hoc. This primitive declarativizes the strict-allowlist
 * semantic per F14.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["headers"]` — reads the configured CSV header value.
 *   - `ctx_writes: ["headers"]` — writes the filtered CSV header value.
 *
 * **Behavior.**
 *   - Read `ctx.headers[opts.header]` (case-insensitive). If absent →
 *     `applied: false`.
 *   - Apply `filterCsv(value, allowSet)` (case-sensitive token match per
 *     `lib/headers.ts` semantics).
 *   - If filtered === original → `applied: false` (no-op).
 *   - Else → write back via `setHeader` and emit `before/after` provenance
 *     including the dropped tokens for trace.
 *
 * **Note vs `strip_header_csv_token`.** This rule is the **allowlist** side
 * of the same coin. Use `filter_header_csv` when you know exactly which
 * tokens to keep; use `strip_header_csv_token` when you know exactly which
 * tokens to remove (per F5 deny-list addendum).
 *
 * **Example config.**
 *
 * ```yaml
 * - name: anthropic_beta_strict_allowlist
 *   use: filter_header_csv
 *   when: { route: "/v1/messages" }
 *   header: anthropic-beta
 *   allow:
 *     - claude-code-20250219
 *     - prompt-caching-2024-07-31
 *     - advanced-tool-use-2025-11-20
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/headers.ts § filterCsv` / `parseCsv` / `serializeCsv`.
 *   - Sister project F14 — Anthropic-Beta strict allowlist semantic.
 */

import { z } from "zod";

import { filterCsv, getHeader, parseCsv, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const FilterHeaderCsvSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("filter_header_csv"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    header: z.string().min(1),
    allow: z.array(z.string().min(1)),
  })
  .passthrough();

type FilterHeaderCsvOpts = z.infer<typeof FilterHeaderCsvSchema>;

const filter_header_csv: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as FilterHeaderCsvOpts;
  const value = getHeader(ctx.headers, opts.header);
  if (value === undefined) {
    return { ctx, applied: false };
  }
  const allowSet = new Set<string>(opts.allow);
  const filtered = filterCsv(value, allowSet);
  if (filtered === value) {
    return { ctx, applied: false };
  }
  // Compute dropped tokens for provenance.
  const beforeTokens = parseCsv(value);
  const afterTokens = new Set(parseCsv(filtered));
  const dropped = beforeTokens.filter((t) => !afterTokens.has(t));
  ctx.headers = setHeader(ctx.headers, opts.header, filtered);
  return {
    ctx,
    applied: true,
    before: { header_name: opts.header.toLowerCase(), value },
    after: { header_name: opts.header.toLowerCase(), value: filtered, dropped },
  };
};

register("filter_header_csv", filter_header_csv, FilterHeaderCsvSchema, {
  ctx_reads: ["headers"],
  ctx_writes: ["headers"],
});

export { filter_header_csv, FilterHeaderCsvSchema };
