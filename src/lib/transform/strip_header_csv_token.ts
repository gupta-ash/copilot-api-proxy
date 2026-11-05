/**
 * strip_header_csv_token.ts — body-engine rule: drop specified tokens from
 * a CSV header value (deny-list peer of `filter_header_csv`).
 *
 * Self-registers on the body engine surface.
 *
 * **Production-driver use case.** The Claude lanes deny `advisor-tool-2026-03-01`
 * from `anthropic-beta` (Copilot 400s "unsupported beta header(s)" on it). This
 * primitive is the canonical mechanism; `applyBetaPolicy` injects it as the
 * trailing `beta_policy_deny` rule in both denylist and allowlist modes.
 *
 * `context-1m-2025-08-07` is not denied by the default policy; see
 * `anthropic_beta.deny` in `config/default.yaml`.
 *
 * **NEW — no upstream cribbing.** The legacy bundle handles this case
 * inline in `_stripBetaSet` per-request logic; this primitive declarativizes
 * it for default.yaml authors.
 *
 * **Context surfaces.**
 *   - `ctx_reads: ["headers"]`.
 *   - `ctx_writes: ["headers"]`.
 *
 * **Behavior.**
 *   - Read `ctx.headers[opts.header]` (case-insensitive). If absent →
 *     `applied: false`.
 *   - Parse CSV via `parseCsv`, drop tokens whose value is in `opts.deny`
 *     (case-sensitive token match — same convention as `filter_header_csv`).
 *   - Re-serialize via `serializeCsv` and write back via `setHeader`.
 *   - `applied: true` if at least one token was dropped; else `applied: false`.
 *
 * **Provenance fields.**
 *   - Always emit `header_name` (lowercased), `before` (original CSV
 *     value), `after` (post-drop CSV value), `dropped` (string[] of
 *     dropped tokens).
 *   - **When** `opts.header.toLowerCase() === "anthropic-beta"`: ALSO
 *     emit `beta_in/beta_out/beta_dropped` aliases in the structured
 *     before/after objects, which the applied-rule trace preserves.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: beta_policy_deny
 *   use: strip_header_csv_token
 *   when: { route: "/v1/messages" }
 *   header: anthropic-beta
 *   deny:
 *     - advisor-tool-2026-03-01
 * ```
 *
 * **Cross-references.**
 *   - `lib/headers.ts § parseCsv` / `serializeCsv` / `setHeader`.
 */

import { z } from "zod";

import { getHeader, parseCsv, serializeCsv, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const StripHeaderCsvTokenSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("strip_header_csv_token"),
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
    deny: z.array(z.string().min(1)),
  })
  .passthrough();

type StripHeaderCsvTokenOpts = z.infer<typeof StripHeaderCsvTokenSchema>;

const strip_header_csv_token: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as StripHeaderCsvTokenOpts;
  const value = getHeader(ctx.headers, opts.header);
  if (value === undefined) {
    return { ctx, applied: false };
  }
  const denySet = new Set<string>(opts.deny);
  const beforeTokens = parseCsv(value);
  const keptTokens: string[] = [];
  const droppedTokens: string[] = [];
  for (const t of beforeTokens) {
    if (denySet.has(t)) droppedTokens.push(t);
    else keptTokens.push(t);
  }
  if (droppedTokens.length === 0) {
    return { ctx, applied: false };
  }
  const afterValue = serializeCsv(keptTokens);
  ctx.headers = setHeader(ctx.headers, opts.header, afterValue);

  const lname = opts.header.toLowerCase();
  const beforeRecord: Record<string, unknown> = {
    header_name: lname,
    value,
  };
  const afterRecord: Record<string, unknown> = {
    header_name: lname,
    value: afterValue,
    dropped: droppedTokens,
  };
  if (lname === "anthropic-beta") {
    // Sister project D5 diagnosability aliases.
    beforeRecord.beta_in = value;
    afterRecord.beta_out = afterValue;
    afterRecord.beta_dropped = droppedTokens;
  }
  return {
    ctx,
    applied: true,
    before: beforeRecord,
    after: afterRecord,
  };
};

register(
  "strip_header_csv_token",
  strip_header_csv_token,
  StripHeaderCsvTokenSchema,
  {
    ctx_reads: ["headers"],
    ctx_writes: ["headers"],
  },
);

export { strip_header_csv_token, StripHeaderCsvTokenSchema };
