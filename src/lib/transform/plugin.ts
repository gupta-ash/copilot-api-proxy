/**
 * plugin.ts — public API surface for drop-in plugin authors (D-LOCK-6).
 *
 * **Lane:** ALL lanes — operators wire custom rules via
 * `transforms.custom_dir/*.ts` files; M9's `custom-loader.ts` lazy-imports
 * each at boot and the file's `register()` / `registerStreamEvent()`
 * side-effect populates the rule registry. Operators import EXCLUSIVELY
 * from `~/lib/transform/plugin` to keep their rule files insulated from
 * the engine's internal module layout.
 *
 * **NEW per M9 (D-LOCK-6 — public API surface).** No upstream cribbing
 * (this is v2-native; the bundle has no plugin concept). Cribs the
 * structural decision from `decisions.md § D15 req 6` (modularity by
 * structure) + `decisions.md § D16` (P2 hybrid pattern: hand-maintained
 * surface for the public API; auto-gen for the engine-private barrel).
 *
 * **The locked export set (per interface-contracts.md § 5).** The
 * following names MAY appear in operator code that imports from this
 * module. Adding to this list = expanding the public API. Removing from
 * it = breaking change for plugin authors. `tests/transform/plugin.test.ts`
 * pins the surface so accidental drift fails CI.
 *
 *   Registration:   register, registerStreamEvent
 *   Reg metadata:   RegisteredRuleOpts, CtxSurface
 *   Body contract:  TransformContext, TransformFn, TransformResult,
 *                   Rule, When, AppliedRule
 *   Event contract: StreamEventContext, StreamEventTransformFn,
 *                   StreamEventResult, AnyEvent, BaseEvent, StreamState
 *   Engine ver:     ENGINE_VERSION
 *   Header utils:   getHeader, setHeader, parseCsv, serializeCsv,
 *                   unionCsv, intersectCsv, replaceCsv, filterCsv
 *
 * **Anti-export (per D-LOCK-6).** The engine internals below MUST NOT
 * be re-exported from this module. They are engine-private surface — if
 * a plugin needs them, the plugin is reaching past the API and the
 * engine should grow a proper extension point instead:
 *
 *   apply, applyEvent, snapshot, reset, get, list,
 *   RegisteredBodyRule, RegisteredStreamEventRule,
 *   RuleAlreadyRegisteredError, validateResponseShape, ValidationFailure
 *
 * The plugin.test.ts assertion enforces both lists.
 *
 * **Worked example — what an operator's custom rule looks like.** Save
 * the following as `~/.local/share/copilot-proxy/transforms/log_route_summary.ts`
 * (the default `transforms.custom_dir`); the boot-time loader will pick
 * it up automatically. The rule logs once per body application showing
 * `{route, model, body_size_bytes}` — useful for operators inventorying
 * upstream traffic shapes during onboarding.
 *
 * ```typescript
 * import { z } from "zod";
 * import {
 *   register,
 *   setHeader,
 *   type TransformContext,
 *   type TransformFn,
 *   type TransformResult,
 * } from "~/lib/transform/plugin";
 *
 * const LogRouteSummarySchema = z
 *   .object({
 *     name: z.string().min(1),
 *     use: z.literal("log_route_summary"),
 *     when: z.unknown().optional(),
 *     // operator-tunable: where to write the summary (header name)
 *     summary_header: z.string().default("x-route-summary"),
 *   })
 *   .passthrough();
 *
 * const log_route_summary: TransformFn = (
 *   ctx: TransformContext,
 *   options: unknown,
 * ): TransformResult => {
 *   // D-LOCK-18: materialize zod defaults via .parse(options).
 *   const opts = LogRouteSummarySchema.parse(options);
 *   const bodyBytes = JSON.stringify(ctx.body ?? {}).length;
 *   const summary = `${ctx.route} ${ctx.model} ${bodyBytes}b`;
 *   ctx.headers = setHeader(ctx.headers, opts.summary_header, summary);
 *   return { ctx, applied: true };
 * };
 *
 * register("log_route_summary", log_route_summary, LogRouteSummarySchema, {
 *   ctx_reads: ["body"],
 *   ctx_writes: ["headers"],
 * });
 * ```
 *
 * Reference the rule from a route's `body_rules:` (or `header_rules:`)
 * with `use: log_route_summary`. The `when:` predicate works as for
 * built-in rules.
 *
 * **Engine-version compat (deferred — per D-LOCK-5).** Plugin authors
 * MAY tag their registration with `version: "<semver-range>"` (the
 * field already exists on `RegisteredRuleOpts`). M9's loader stores the
 * field but does NOT enforce semver compatibility against
 * `ENGINE_VERSION`; M10 / M11 may add the check. Forward-compat: write
 * the field today and the future check will pick it up.
 *
 * **Cross-references.**
 *   - `decisions.md § D15 req 6` (modularity by structure)
 *   - `decisions.md § D16` (P2 hybrid pattern)
 *   - `interface-contracts.md § 5` (M9 LOCKED export surface)
 *   - `custom-loader.ts` (boot-time lazy-import counterpart, D-LOCK-5)
 *   - `tests/transform/plugin.test.ts` (export-surface drift detector)
 *   - `tests/fixtures/custom-rules/log_route_summary.ts` (worked example)
 */

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export { register, registerStreamEvent } from "./registry.ts";

// -----------------------------------------------------------------------------
// Per-rule metadata
// -----------------------------------------------------------------------------

export type { RegisteredRuleOpts, CtxSurface } from "./registry.ts";

// -----------------------------------------------------------------------------
// Body-rule contract
// -----------------------------------------------------------------------------

export type {
  TransformContext,
  TransformFn,
  TransformResult,
  Rule,
  When,
  AppliedRule,
} from "./types.ts";

// -----------------------------------------------------------------------------
// Stream-event contract
// -----------------------------------------------------------------------------

export type {
  StreamEventContext,
  StreamEventTransformFn,
  StreamEventResult,
  AnyEvent,
  BaseEvent,
  StreamState,
} from "./types.ts";

// -----------------------------------------------------------------------------
// Engine version (semver-compat reference for plugin authors)
// -----------------------------------------------------------------------------

export { ENGINE_VERSION } from "./types.ts";

// -----------------------------------------------------------------------------
// Header utilities (pre-built helpers for plugin authors)
// -----------------------------------------------------------------------------

export {
  getHeader,
  setHeader,
  parseCsv,
  serializeCsv,
  unionCsv,
  intersectCsv,
  replaceCsv,
  filterCsv,
} from "../headers.ts";
