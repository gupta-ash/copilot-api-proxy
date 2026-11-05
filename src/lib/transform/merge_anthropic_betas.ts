/**
 * merge_anthropic_betas.ts — body-engine rule that merges client-supplied
 * `Anthropic-Beta` CSV header tokens with a baseline list under one of
 * three modes (`union` default, `intersect`, `replace`).
 *
 * **Lane:** Anthropic-upstream lanes (CC→Claude, Codex→Claude, omp→Claude)
 * — applied request-side after rename_model + before any
 * `redirect_to_anthropic_messages` hand-off, so the upstream Anthropic
 * call carries the merged header.
 *
 * **Cribbed-from:** copilot-api-pro@f4f9bbdb dist/main.js
 *   - Beta-header check at line 1309
 *     (`anthropicBeta?.startsWith("claude-code")` — count-tokens path uses
 *     this to decide MCP-tool injection; documents WHY default mode must
 *     be `union` so the client's `claude-code-*` token survives the merge).
 *   - `createAnthropicMessages` header injection site at line 2054 — the
 *     bundle REPLACES `Anthropic-Beta` with `advanced-tool-use-2025-11-20`
 *     wholesale (silent breakage of CC's billing display per H4). v2
 *     defaults to `union` to fix this; operators may opt back into the
 *     legacy REPLACE behavior with `mode: replace`.
 *
 * **Differences from bundle:**
 *   - Bundle: REPLACE `Anthropic-Beta` with `advanced-tool-use-2025-11-20`
 *     unconditionally → silently drops client tokens (CC's `claude-code-*`
 *     loses billing-display, etc.).
 *   - v2 default: `mode: union` preserves client tokens AND ensures the
 *     baseline beta is present.
 *   - v2 `mode: replace` reproduces bundle behavior for operators who want it.
 *   - v2 `mode: intersect` is new — keep only tokens both sides agree on.
 *   - v2 `append: string[]` option layers extra tokens on top of the merge
 *     result regardless of mode (useful for "preserve client betas via
 *     union AND ensure advanced-tool-use is present" — though with the
 *     default `baseline: ["advanced-tool-use-2025-11-20"]` this is
 *     redundant for the typical case).
 *
 * **D-LOCK-4 (M8 spec).** Schema + behavior frozen.
 * **D-LOCK-11 (M8 spec).** Empty-headers / missing-header semantics:
 *   - `union` / `replace` with missing client header: result = baseline.
 *   - `intersect` with missing client header: result = `""`, `applied:false`
 *     (no-op — emitting an empty Anthropic-Beta header would be
 *     semantically wrong; intersection with empty set is empty).
 *   - `intersect` with missing client + non-empty `append`: second
 *     `unionCsv` call appends to `""` → result = `serialized(append)`,
 *     `applied:true`.
 *
 * **Self-registers.** Per M3 D-LOCK-1 — body-engine surface (implicit from
 * calling `register()` vs `registerStreamEvent()`); no `engine_surface`
 * option exists on `RegisteredRuleOpts`.
 *
 * **Cross-references.**
 *   - `lib/headers.ts` § parseCsv/serializeCsv/unionCsv/intersectCsv/replaceCsv/getHeader/setHeader
 *   - `decisions.md` § M8 D-LOCK-4 + addendum §3 (`append:` option)
 *   - `verification/wiki41_to_v2_mapping.md` § H4 (silent-replace fix)
 */

import { z } from "zod";

import {
  getHeader,
  setHeader,
  serializeCsv,
  unionCsv,
  intersectCsv,
  replaceCsv,
} from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const MergeAnthropicBetasSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("merge_anthropic_betas"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    mode: z.enum(["replace", "union", "intersect"]).default("union"),
    /**
     * Betas to ADD to the merged result regardless of mode. Useful for
     * "preserve client betas via union AND ensure advanced-tool-use is
     * present". With default `mode: union` + default `baseline:
     * ["advanced-tool-use-2025-11-20"]`, this is redundant for the
     * typical case but available for operator override.
     */
    append: z.array(z.string()).optional(),
    /**
     * Betas to use as the baseline (proxy-side). For `replace` mode this
     * is (with `append`) the final value. For `union`/`intersect` this is
     * merged with the client value.
     *
     * Default `["advanced-tool-use-2025-11-20"]` ensures the proxy's
     * required beta is present even when the client doesn't supply it.
     */
    baseline: z.array(z.string()).default(["advanced-tool-use-2025-11-20"]),
  })
  .passthrough();

const merge_anthropic_betas: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = MergeAnthropicBetasSchema.parse(options);
  const before = getHeader(ctx.headers, "anthropic-beta") ?? "";
  const baselineCsv = serializeCsv(opts.baseline);

  let mergedCsv: string;
  switch (opts.mode) {
    case "replace":
      mergedCsv = replaceCsv(before, baselineCsv);
      break;
    case "union":
      // unionCsv preserves LEFT order — pass client first to preserve CC's
      // claude-code-* token preference.
      mergedCsv = unionCsv(before, baselineCsv);
      break;
    case "intersect":
      mergedCsv = intersectCsv(before, baselineCsv);
      break;
  }

  if (opts.append !== undefined && opts.append.length > 0) {
    // Append regardless of mode (per addendum §3 — operator opts to ENSURE
    // these tokens are present in the final value).
    mergedCsv = unionCsv(mergedCsv, serializeCsv(opts.append));
  }

  if (mergedCsv === before) {
    return { ctx, applied: false };
  }

  ctx.headers = setHeader(ctx.headers, "anthropic-beta", mergedCsv);
  return {
    ctx,
    applied: true,
    before: { "anthropic-beta": before },
    after: { "anthropic-beta": mergedCsv },
  };
};

register(
  "merge_anthropic_betas",
  merge_anthropic_betas,
  MergeAnthropicBetasSchema,
  {
    ctx_reads: ["headers"],
    ctx_writes: ["headers"],
  },
);

export { merge_anthropic_betas, MergeAnthropicBetasSchema };
