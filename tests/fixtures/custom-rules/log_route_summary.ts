/**
 * log_route_summary.ts — public drop-in custom-rule example.
 *
 * **Purpose.** Operators cribbing a first drop-in rule see a complete,
 * runnable example. The body of the rule sets `x-route-summary` on
 * `ctx.headers` to a one-line digest ({route} {model} {bytes}) so the
 * operator can confirm the rule fired by inspecting forwarded request
 * headers in their upstream observability pipeline.
 *
 * **Where this lives in production.** Drop a copy into
 * `~/.local/share/copilot-proxy/transforms/log_route_summary.ts` (the
 * default `transforms.custom_dir`) and the boot-time loader will pick
 * it up automatically. The rule will then be available under
 * `use: log_route_summary` in any `body_rules:` / `header_rules:`
 * block in `config.yaml`.
 *
 * **Imports from `~/lib/transform/plugin` only.**
 * Operators MUST NOT reach into `registry.ts` / `types.ts` / `headers.ts`
 * directly — those are engine-private. The `plugin` re-export module
 * is the stable API contract.
 *
 * **Default materialization.** Parse options inside the rule so the default
 * summary header exists at runtime as well as during configuration loading.
 */

import { z } from "zod";

import {
  register,
  setHeader,
  type TransformContext,
  type TransformFn,
  type TransformResult,
} from "~/lib/transform/plugin";

const LogRouteSummarySchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("log_route_summary"),
    when: z.unknown().optional(),
    /**
     * Header name to write the summary to. Default `x-route-summary`.
     * Operators may override per-route to namespace summaries.
     */
    summary_header: z.string().default("x-route-summary"),
  })
  .passthrough();

const log_route_summary: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  // Materialize schema defaults at runtime.
  const opts = LogRouteSummarySchema.parse(options);
  const bodyBytes = JSON.stringify(ctx.body ?? {}).length;
  const summary = `${ctx.route} ${ctx.model} ${bodyBytes}b`;
  ctx.headers = setHeader(ctx.headers, opts.summary_header, summary);
  return {
    ctx,
    applied: true,
    before: { [opts.summary_header]: ctx.headers[opts.summary_header] ?? null },
    after: { [opts.summary_header]: summary },
  };
};

register("log_route_summary", log_route_summary, LogRouteSummarySchema, {
  ctx_reads: ["body"],
  ctx_writes: ["headers"],
});

export { log_route_summary, LogRouteSummarySchema };
