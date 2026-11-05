/**
 * derive_context_management_beta.ts — body-engine rule: ensures the
 * `anthropic-beta: context-management-2025-06-27` token is present when
 * the request body carries `context_management.edits` (CC's microcompact
 * pathway).
 *
 * **D33 — OPT-IN BUT CONDITIONALLY REQUIRED.**  Per `decisions.md § D33`,
 * this rule ships as opt-in (NOT wired in `config/default.yaml`).
 * **HOWEVER**, per `research.md § F15`, Copilot Ent's `/v1/messages`
 * endpoint will return HTTP 400 if `context_management.edits` is sent in
 * the body WITHOUT the matching beta token in the header. Operators using
 * harnesses that send `context_management.edits` (CC's microcompact
 * pathway) MUST enable this rule, OR the request will fail upstream with:
 *
 *   400 "context_management: Extra inputs are not permitted"
 *
 * Recommended posture: if you operate a Claude lane that may receive CC's
 * `/v1/messages` traffic with microcompact enabled, wire this rule on the
 * Claude lane.  Other operators may leave it disabled.
 *
 * Cross-references: research.md § F15, decisions.md § D33,
 * release_questions.md § RQ1 sub-question 1.3.
 *
 * **Lane:** Anthropic-shape lanes accepting CC traffic. The rule reads
 * the request body's `context_management` field and merges the beta token
 * into the existing `anthropic-beta` CSV header via `unionCsv` (preserving
 * any client-supplied tokens).
 *
 * **Logic** (per spec D-LOCK-4):
 *   - If `ctx.body` is not an object OR `ctx.body[body_field]` is
 *     undefined → `applied: false`.
 *   - Else: read current `anthropic-beta` header (via `getHeader`). Use
 *     `unionCsv(currentValue, beta_token)` to merge. If result equals
 *     current → `applied: false`. Else: set header via `setHeader`,
 *     return `applied: true` with `before/after`.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body", "headers"]` — reads body to detect the field;
 *     reads existing anthropic-beta header for union-merge.
 *   - `ctx_writes: ["headers"]` — mutates anthropic-beta CSV.
 *
 * **D-LOCK-18 (M9 spec):** the rule fn opens with
 * `const opts = DeriveContextManagementBetaSchema.parse(options);` to
 * materialize the `beta_token` / `body_field` zod defaults at runtime.
 * Reference pattern: M8's `merge_anthropic_betas.ts:112`.
 *
 * **No upstream cribbing** — F15 evidence is operator-side observation;
 * no copilot-api-pro bundle equivalent.
 *
 * **Cross-references.**
 *   - `research.md § F15` — empirical evidence of HTTP 400 without beta.
 *   - `decisions.md § D33` — opt-in default rationale + 9 caveats.
 *   - `release_questions.md § RQ1` — operator-facing FAQ.
 *   - `lib/headers.ts § getHeader/setHeader/unionCsv` — header dict + CSV.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { getHeader, setHeader, unionCsv, serializeCsv } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const DeriveContextManagementBetaSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("derive_context_management_beta"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    /**
     * Beta token to inject when body field is present (default
     * `"context-management-2025-06-27"`). Forward-compat: operators may
     * point this at a future beta version when Anthropic ships one.
     */
    beta_token: z.string().default("context-management-2025-06-27"),
    /**
     * Body field whose presence triggers injection (default
     * `"context_management"`). Operators may override if a harness uses
     * an alternate top-level field name for the same payload.
     */
    body_field: z.string().default("context_management"),
  })
  .passthrough();

const derive_context_management_beta: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = DeriveContextManagementBetaSchema.parse(options);
  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const body = ctx.body as Record<string, unknown>;
  if (body[opts.body_field] === undefined) {
    return { ctx, applied: false };
  }

  const before = getHeader(ctx.headers, "anthropic-beta") ?? "";
  const merged = unionCsv(before, serializeCsv([opts.beta_token]));
  if (merged === before) {
    return { ctx, applied: false };
  }
  ctx.headers = setHeader(ctx.headers, "anthropic-beta", merged);
  return {
    ctx,
    applied: true,
    before: { "anthropic-beta": before },
    after: { "anthropic-beta": merged },
  };
};

register(
  "derive_context_management_beta",
  derive_context_management_beta,
  DeriveContextManagementBetaSchema,
  {
    ctx_reads: ["body", "headers"],
    ctx_writes: ["headers"],
  },
);

export { derive_context_management_beta, DeriveContextManagementBetaSchema };
