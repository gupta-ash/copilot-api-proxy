/**
 * assert_endpoint.ts — body-engine rule: refuse to forward unless
 * `ctx.route` matches the configured endpoint. Throws an
 * `EngineAbort500Error` when the assertion fails (per spec § Bucket A
 * row 5: assertion only — does not write).
 *
 * **M6 primitive (built-in).** Self-registers at module load. Naming
 * convention `<verb>_<scope>` per D-LOCK-8 / O19.
 *
 * **NEW — no upstream cribbing.** The legacy bundle has no equivalent;
 * routing is hard-coded there. This primitive lets default.yaml authors
 * declare an endpoint invariant (e.g., "this rule chain must only run
 * against /v1/messages — anything else is a config-load error or
 * misconfigured route handler").
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]` — actually reads `ctx.route`, but `ctx.route`
 *     is part of the body-engine surface (no separate "route" surface).
 *     Defaulting to `["body"]` keeps lint quiet for the body case.
 *   - `ctx_writes: []` — pure assertion; never mutates ctx.
 *
 * **Behavior.**
 *   - When `ctx.route === opts.ensure_endpoint` → `applied: false` (silent
 *     pass; nothing was mutated, nothing recorded).
 *   - Otherwise → throw `EngineAbort500Error` with an explanatory message
 *     identifying the rule name, the actual route, and the expected route.
 *
 * **Error policy interaction.** This rule throws unconditionally on
 * mismatch. The engine's `apply.ts` handles the throw under the rule's
 * `on_error` policy:
 *   - `on_error: "continue"` (default) — log + push AppliedRule with
 *     `error` set + advance. The proxy DOES forward the request — fail-soft.
 *   - `on_error: "abort_with_500"` — engine wraps in EngineAbort500Error
 *     and the route handler returns HTTP 500 to the client. Recommended
 *     setting for production assertions.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: ensure_messages_endpoint
 *   use: assert_endpoint
 *   on_error: abort_with_500
 *   ensure_endpoint: "/v1/messages"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M6 — built-in primitives.
 *   - `lib/transform/apply.ts § EngineAbort500Error` — error wrapping.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const AssertEndpointSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("assert_endpoint"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    ensure_endpoint: z.string().min(1),
  })
  .passthrough();

type AssertEndpointOpts = z.infer<typeof AssertEndpointSchema>;

/**
 * Plain Error sentinel thrown by `assert_endpoint`. The engine wraps it in
 * an `EngineAbort{500,502}Error` per `on_error`; the wrap preserves the
 * message and `originalError` chain.
 */
export class AssertEndpointFailedError extends Error {
  constructor(
    public readonly ruleName: string,
    public readonly actualRoute: string,
    public readonly expectedRoute: string,
  ) {
    super(
      `assert_endpoint: rule "${ruleName}" requires route "${expectedRoute}" but got "${actualRoute}".`,
    );
    this.name = "AssertEndpointFailedError";
  }
}

const assert_endpoint: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as AssertEndpointOpts;
  if (ctx.route !== opts.ensure_endpoint) {
    throw new AssertEndpointFailedError(
      opts.name,
      ctx.route,
      opts.ensure_endpoint,
    );
  }
  // Match → silent pass. Nothing mutated, no AppliedRule emitted.
  return { ctx, applied: false };
};

register("assert_endpoint", assert_endpoint, AssertEndpointSchema, {
  ctx_reads: ["body"],
  ctx_writes: [],
});

export { assert_endpoint, AssertEndpointSchema };
