/**
 * types.ts — engine-core type surface for the v2 transformation engine.
 *
 * **Two engine surfaces (per O1 / D23).** This file defines the public type
 * vocabulary for BOTH transformation surfaces:
 *
 *   1. **Body engine** — request/response body transforms, consumed by M3
 *      (day-1 body-content rules), M6 (built-in primitives), M7a (body
 *      translators). Async-allowed (`TransformFn` may return a `Promise`)
 *      because some translators may need to read auxiliary files / call zod
 *      / etc. on the rare slow path.
 *   2. **Stream-event engine** — per-SSE-event transforms, consumed by M7b
 *      (SSE state machine) and M8 (Phase 1.6 fold-in). **Sync only**
 *      (`StreamEventTransformFn` returns directly, never a Promise) because
 *      the per-event hot path has a hard <1ms budget per N8 — an `await`
 *      per rule would compound across 6+ rules per event.
 *
 * **Discriminator field.** `Rule.use: string` names the rule; the registry
 * resolves it to a single body OR stream-event surface (a single `use:`
 * cannot collide across registries — that's a config error per O18). The
 * optional `engine_surface` field on `Rule` is a forward-compat hint that
 * M2 does not act on; M9's config loader may use it for diagnostics.
 *
 * **Anti-pattern.** No `any` anywhere in this file — `unknown` is the right
 * choice for `body` and `options`, and rule authors narrow with their own
 * zod schemas (registered alongside the rule fn per X3/O2).
 *
 * **Versioning (per O21 + F3 fix).** `ENGINE_VERSION` is re-exported from
 * `./version.ts`, which is **build-time generated** by
 * `scripts/gen_version.ts` from `package.json.version`. The generator runs
 * via the `prebuild` script in `package.json` (bun runs `prebuild` before
 * `build` automatically). This avoids two M5-bundle pitfalls of the
 * previous `import pkg from "../../../package.json"` approach:
 *   1. tsdown inlining the entire ~2KB package.json (deps, scripts,
 *      description) into `dist/main.js` for a single semver string.
 *   2. JSON-import-at-bundle-time fragility (worked at dev/test, was
 *      never exercised through tsdown's bundler before M2.5).
 *
 * `version.ts` is gitignored — regenerate locally with `bun run prebuild`
 * (or any `bun run build`).
 */

import type { Level } from "../debug.ts";

import { ENGINE_VERSION as ENGINE_VERSION_LITERAL } from "./version.ts";
import type { StreamState as StreamStateConcrete } from "./sse-state.ts";

/**
 * The engine version string (sourced from `package.json`'s `version` field
 * via the build-time generator, per F3). Bumped automatically with every
 * package release; rule authors compare their own `engine_compat` semver
 * range against this at config-load time (M9 enforces; M2 only stores).
 *
 * Widened from the generated literal type to `string` so consumers (tests,
 * downstream code) can compare against arbitrary strings without TS literal
 * narrowing complaints. The runtime value is identical.
 */
export const ENGINE_VERSION: string = ENGINE_VERSION_LITERAL;

/**
 * Re-export `Level` purely as a convenience so downstream rule code that
 * already imports from `lib/transform/types` doesn't need a second
 * `lib/debug` import for `setLevel`-style helpers. Not used by the engine
 * core itself.
 */
export type { Level };

// -----------------------------------------------------------------------------
// Body engine surface
// -----------------------------------------------------------------------------

/**
 * Per-call context for **body** rules (request OR response transforms).
 *
 * Rule authors may freely mutate `body` and `headers` when the rule was
 * registered with `mutate_in_place: true` (the default for built-in rules
 * per O3). When `mutate_in_place: false`, the engine `structuredClone`s the
 * context BEFORE handing it to the rule, so the original is preserved.
 *
 * `body` is `unknown` because rule authors are expected to narrow with
 * their own zod schemas. `headers` is a lowercase-canonical
 * `Record<string, string>` matching the `lib/headers.ts § getHeader`
 * convention; rules that need multi-value semantics should use
 * `lib/headers.ts § parseCsv` / `serializeCsv`.
 */
export interface TransformContext {
  /** The request OR response body (unknown shape — rules narrow). */
  body: unknown;
  /** Lowercase-canonical header dict (per `lib/headers.ts`). */
  headers: Record<string, string>;
  /** The request route (e.g. `/v1/messages`). */
  route: string;
  /** The model id at the moment of the call (e.g. `claude-opus-4.7`). */
  model: string;
  /** The detected harness (`cc` | `codex` | `omp` | etc.) when known. */
  harness?: string;
  /** For RESPONSE rules — what was the request endpoint? */
  request_endpoint?: string;
  /** For RESPONSE rules — what was the request model? */
  request_model?: string;
  /** For RESPONSE rules — the request model_glob predicate, if any. */
  request_model_glob?: string;
}

/**
 * Result of a body-rule invocation.
 *
 * `applied: true` means the rule actually mutated state (or would have, in
 * `mutate_in_place: false` mode). `applied: false` is for the case where
 * the predicate matched but the rule chose not to fire (e.g. selector
 * matched no leaves) — the engine does NOT emit an `AppliedRule` record in
 * that case.
 *
 * `before` / `after` snapshots are optional and intended for trace + debug
 * (the engine forwards them into `AppliedRule` when present). `error` is
 * set by the engine itself when `on_error: "continue"` swallowed a throw.
 */
export interface TransformResult {
  /** Possibly-mutated context (same reference as input when mutate_in_place). */
  ctx: TransformContext;
  /** Did this rule actually fire? */
  applied: boolean;
  /** Optional pre-mutation snapshot (for trace). */
  before?: unknown;
  /** Optional post-mutation snapshot (for trace). */
  after?: unknown;
  /** Set by the engine when on_error swallowed a throw. */
  error?: string;
}

/**
 * The body-rule function signature. **Async-allowed** — the engine
 * `await`s the result, so both sync and async returns are fine.
 *
 * `options` is `unknown` and rule authors are REQUIRED to validate it
 * against their registered zod schema before reading any field.
 */
export type TransformFn = (
  ctx: TransformContext,
  options: unknown,
) => TransformResult | Promise<TransformResult>;

// -----------------------------------------------------------------------------
// Stream-event engine surface
// -----------------------------------------------------------------------------

/**
 * Per-stream mutable state. Refined by M7b — the concrete shape lives
 * in `./sse-state.ts` (the source of truth), re-exported here so the
 * engine surface (apply_event.ts, registry.ts) and downstream rules
 * continue to import from `./types`.
 *
 * Rules declare reads/writes through the registry's state-access
 * manifest (per X6) so M9 can detect read-after-write conflicts at
 * config-load time.
 *
 * Pre-M7b history: M2 declared this as `Record<string, unknown>`
 * anticipating M7b would refine it. M7b's translators
 * (`translate_anthropic_event_to_responses_event.ts` /
 * `translate_responses_event_to_anthropic_event.ts`) consume this
 * concrete shape; M8/M9 rules that need additional fields should add
 * them to `sse-state.ts § interface StreamState` directly. The interface
 * carries an open index signature `[k: string]: unknown` purely to
 * preserve the M2 contract for the engine's apply_event.ts dynamic
 * `state_changes` accumulator — translators and tests use the named
 * fields directly.
 */
export type StreamState = StreamStateConcrete;

/**
 * Base SSE event shape — every concrete event has at minimum a `type`
 * string. M7b will refine this into a discriminated union over concrete
 * event-type names (`response.created`, `response.completed`, etc.); M2
 * keeps it open so the engine compiles against any event shape.
 *
 * The index signature (`[k: string]: unknown`) intentionally allows
 * arbitrary fields so rules can add / read provider-specific event data
 * without the type system getting in the way.
 */
export interface BaseEvent {
  /** SSE event-type name (e.g. `response.created`, `message_delta`). */
  type: string;
  /** Optional payload — rules may carry arbitrary structured data. */
  data?: unknown;
  /** Open extension — rule authors freely add provider-specific fields. */
  [k: string]: unknown;
}

/**
 * Discriminated-union skeleton for SSE events. M7b will refine
 * `AnyEvent` to a real union over concrete event types; for M2 it is the
 * permissive `BaseEvent`. Downstream code should always type its
 * outgoing events as `AnyEvent` so the M7b refinement is non-breaking.
 */
export type AnyEvent = BaseEvent;

/**
 * Per-call context for **stream-event** rules.
 *
 * `state` is the per-stream mutable state object; rules may mutate it in
 * place (later rules in the chain see updates immediately). `event` is
 * the single incoming SSE event; rules return a (possibly-empty,
 * possibly-multi) array of outgoing events via `StreamEventResult.events_out`.
 */
export interface StreamEventContext {
  /** The single incoming SSE event. */
  event: AnyEvent;
  /** Per-stream mutable state (refined by M7b). */
  state: StreamState;
  /** The route this stream is bound to (e.g. `/v1/messages`). */
  route: string;
  /** The model this stream is bound to. */
  model: string;
  /** For RESPONSE-side rules — original request endpoint. */
  request_endpoint?: string;
  /** For RESPONSE-side rules — original request model. */
  request_model?: string;
}

/**
 * Result of a stream-event-rule invocation.
 *
 * `events_out` is the rule's outgoing event list. The engine collects all
 * `events_out` arrays in declared rule order to produce the final output.
 * If NO rule fires for an incoming event, the engine emits the original
 * event unchanged (default passthrough). If at least one rule fires but
 * emits no events, the engine respects the suppression — the original
 * event is dropped.
 *
 * `state_changes` is a bag of writes the rule made; the engine merges
 * these so M5's route handler can persist them into the per-stream state
 * map. (For M2, `state_changes` is informational — `ctx.state` is mutated
 * in place and is the live source of truth.)
 */
export interface StreamEventResult {
  /** Outgoing events (0..N) in emit order. */
  events_out: AnyEvent[];
  /** Optional bag of state-field writes (informational at M2). */
  state_changes?: Partial<StreamState>;
  /** Did this rule fire? Mirrors `TransformResult.applied`. */
  applied: boolean;
  /** Set by the engine when on_error swallowed a throw. */
  error?: string;
}

/**
 * The stream-event-rule function signature. **Sync only** — per-event hot
 * path budget is <1ms per N8; `await` per rule would compound across
 * many rules per event.
 */
export type StreamEventTransformFn = (
  ctx: StreamEventContext,
  options: unknown,
) => StreamEventResult;

// -----------------------------------------------------------------------------
// Predicate (`when` clause)
// -----------------------------------------------------------------------------

/**
 * The `when` predicate (per R3). All set fields are AND'd — there is no
 * OR semantics; an empty `When` matches everything.
 *
 * `event_types` is meaningful only on stream-event rules (a `When`
 * applied against a `TransformContext` ignores it for body rules — the
 * predicate evaluator returns `false` if the context lacks the
 * required `event` field).
 *
 * `model_glob` and `model_regex` are cached per-string in `predicate.ts`'s
 * compile cache so repeated evaluation across many requests is cheap.
 * The cache is cleared by `predicate.reset()` (used by tests).
 */
export interface When {
  /** Exact route match (e.g. `/v1/messages`). */
  route?: string;
  /** Exact HTTP method match. */
  method?: "GET" | "POST" | string;
  /** Exact model id match. */
  model?: string;
  /** Glob over model id (`*` = any chars, `?` = single char; anchored). */
  model_glob?: string;
  /** Raw regex source over model id. Compiled lazily; invalid → `false`. */
  model_regex?: string;
  /** Exact-match list — `model_in.includes(ctx.model)`. */
  model_in?: string[];
  /** Exact harness match (`cc` | `codex` | `omp` | ...). */
  harness?: string;
  /** For RESPONSE rules — what was the request endpoint? */
  request_endpoint?: string;
  /** For RESPONSE rules — glob over request model. */
  request_model_glob?: string;
  /** Stream-event rules ONLY — list of SSE event-type names to fire on. */
  event_types?: string[];
}

/**
 * The shared rule shape. `use` names the rule (the registry key); `when`
 * is the predicate; `on_error` controls error semantics; any extra fields
 * become the rule's `options` (passed unchanged to the rule fn).
 *
 * `engine_surface` is an OPTIONAL forward-compat hint that M2 ignores —
 * the registry already implies the surface (a single `use:` resolves to
 * exactly one surface). M9's config loader may use this hint for
 * diagnostics ("you said body but `use:` resolves to stream_event").
 */
export interface Rule {
  /** Display name (used for trace + diagnostics). */
  name: string;
  /** Registry key — names the rule fn. */
  use: string;
  /** Optional predicate; empty `when: {}` matches everything. */
  when?: When;
  /**
   * Error-handling policy (default `"continue"` per R30-R32; M2.5 added
   * `"continue_passthrough"` per F2).
   *
   *  - `"continue"` — fail-closed default. Log + record + advance to the
   *    next rule. On the **stream-event** surface, a throw under this
   *    policy ALSO suppresses the original event (the rule attempted to
   *    handle this `event_type` and failed; passing the unprocessed
   *    event through would be unsafe — see decisions.md § D26
   *    (post-M2.5)).
   *  - `"continue_passthrough"` — fail-open opt-in. Same as `"continue"`
   *    on the body surface (no event suppression to opt out of). On the
   *    **stream-event** surface, the original event is preserved in
   *    `events_out` even though the rule threw. Use sparingly: only
   *    appropriate for pure logger/observer rules that explicitly should
   *    never block the stream.
   *  - `"abort_with_500"` / `"abort_with_502"` — throw the corresponding
   *    `EngineAbort{500,502}Error`; M5 maps to HTTP 500/502.
   */
  on_error?:
    | "continue"
    | "continue_passthrough"
    | "abort_with_500"
    | "abort_with_502";
  /** Forward-compat hint; M2 ignores. */
  engine_surface?: "body" | "stream_event";
  /** Open extension — extra fields become the rule's options. */
  [k: string]: unknown;
}

// -----------------------------------------------------------------------------
// Observability
// -----------------------------------------------------------------------------

/**
 * Per-rule observability record emitted by the engine for trace + debug.
 *
 * `before` / `after` are optional and only present when the rule's result
 * carried them. `error` is set when `on_error: "continue"` swallowed a
 * throw (otherwise the engine has rethrown an `EngineAbort{500,502}Error`).
 *
 * `reads` / `writes` come from the rule's registration manifest (X6); M9
 * uses these at config-load time for read-after-write conflict detection.
 * `state_changes` is the actual write payload from a stream-event rule's
 * result.
 */
export interface AppliedRule {
  /** The rule's display name (`Rule.name`). */
  name: string;
  /** Pre-mutation snapshot (when the rule supplied one). */
  before?: unknown;
  /** Post-mutation snapshot (when the rule supplied one). */
  after?: unknown;
  /** Engine-set when on_error continued past a throw. */
  error?: string;
  /** Stream-event rules only — actual writes the rule emitted. */
  state_changes?: Partial<StreamState>;
  /** State fields the rule reads (manifest, X6). */
  reads?: string[];
  /** State fields the rule writes (manifest, X6). */
  writes?: string[];
}
