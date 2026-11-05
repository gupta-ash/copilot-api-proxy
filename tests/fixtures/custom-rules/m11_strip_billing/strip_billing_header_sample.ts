// Synthetic drop-in custom-rule example, not production transformation policy.
//
// Strips Anthropic system blocks whose text starts with
// `x-anthropic-billing-header:` (case-insensitive). Demonstrates a
// targeted system-block removal. This is not a conversation privacy filter.
//
// **Self-registers on import** via `register("strip_billing_header_sample", ...)`.
// The boot-time custom-rule loader picks this up
// automatically when the file lives under
// `${transforms.custom_dir}` (default `~/.local/share/copilot-proxy/transforms/`).
// Tests load it via `loadCustomRules(<fixture-dir>)` in a beforeAll hook.

import { z } from "zod";

import {
  register,
  type TransformContext,
  type TransformResult,
} from "~/lib/transform/plugin"; // Use the supported plugin API boundary.

/**
 * Schema for the rule's options. The standard rule envelope (`name`, `use`)
 * plus `when` predicate. `passthrough()` permits extra YAML keys without
 * failing validation (operators may add custom annotations).
 */
const StripBillingHeaderSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("strip_billing_header_sample"),
    when: z.unknown().optional(),
  })
  .passthrough();

/**
 * The body-rule transform. Mutates `ctx.body.system` in place when the
 * body has a `system: Array<{type, text}>` shape (Anthropic Messages
 * convention). Rules are predicate-gated by the engine so this fn is
 * only invoked on matched routes.
 */
function stripBillingHeader(ctx: TransformContext): TransformResult {
  const body = ctx.body as
    | { system?: Array<{ type: string; text: string }> }
    | undefined;
  if (body?.system === undefined || !Array.isArray(body.system)) {
    return { ctx, applied: false };
  }
  const before = body.system.length;
  body.system = body.system.filter(
    (block) => !/^x-anthropic-billing-header:/i.test(block.text ?? ""),
  );
  const after = body.system.length;
  return { ctx, applied: after !== before, before, after };
}

// Self-register at module load. Version metadata is advisory.
register(
  "strip_billing_header_sample",
  stripBillingHeader,
  StripBillingHeaderSchema,
  { ctx_reads: ["body"], ctx_writes: ["body"], version: ">=1.0.0" },
);

// Export after registration so tests can explicitly re-register after reset.
export { stripBillingHeader, StripBillingHeaderSchema };
