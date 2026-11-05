/**
 * registry.ts — two engine-rule registries (body + stream-event) with
 * co-located zod schemas and per-rule metadata.
 *
 * **Two registries (per O18).** A rule name (`use:`) resolves to exactly
 * one surface — a `redact_field` body rule cannot collide with a hypothetical
 * `redact_field` stream-event rule because they live in different
 * namespaces (`body_registry` vs `stream_event_registry`). M9's config
 * loader uses `get(surface, name)` to dispatch a parsed config rule to the
 * right surface; ambiguity is impossible by construction.
 *
 * **Co-located zod schemas (per X3 / O2).** `register()` REQUIRES a
 * `z.ZodTypeAny` schema as a positional argument. The schema is the
 * source-of-truth for the rule's option shape; the engine uses it
 * defensively at apply-time (`apply.ts` calls `schema.safeParse(rule)`)
 * AND M9's config loader uses it at load time. Co-location prevents the
 * "20 rule files, 0 schemas" sprawl scenario.
 *
 * **Per-stream snapshot semantics (per O4).** `snapshot(surface)` returns
 * a `ReadonlyMap<string, RegisteredRule>` — a frozen point-in-time copy.
 * M5's stream-handler takes a snapshot at stream-open and passes it to
 * `applyRules`/`applyEvent` for the duration of the stream. Mid-stream
 * `register()` calls do NOT affect already-open streams; new streams pick
 * up the new registration.
 *
 * **Per-rule opts contract.**
 *   - `allow_override?: boolean` — default `false`. Throws
 *     `RuleAlreadyRegisteredError` on duplicate name otherwise.
 *   - `mutate_in_place?: boolean` — default **`true` for built-in rules**
 *     (per O3 perf fix; avoids 45-180MB/min of structuredClone churn at
 *     production CC traffic). Custom-loaded plugins (M9) override the
 *     default to `false` for safety.
 *   - `reads?: string[]` / `writes?: string[]` — state-access manifest
 *     (per X6). Used by `apply_event` for AppliedRule observability and
 *     by M9 for cross-rule read-after-write conflict detection.
 *   - `response_shape?: string` — declared by `redirect_to_*` rules in M6
 *     (e.g. `"anthropic_v1_messages"`) per X2; M2 stores but does not
 *     enforce, M9 validates at config-load time.
 *
 * **Engine-version metadata.** Each registration optionally carries a
 * `version: string` (the rule's own engine_compat semver range). M2
 * stores it; M9's custom-loader is responsible for the actual semver
 * compatibility check (`semver` dep added at M4).
 */

import type { z } from "zod";

import { invariant } from "../assert.ts";

import type { StreamEventTransformFn, TransformFn } from "./types.ts";

/**
 * Surface label for ctx-read/ctx-write metadata (per F5/M6 D-LOCK-2). The
 * body engine has TWO mutable ctx surfaces a rule may interact with:
 *
 *   - `"body"` — `ctx.body` reads/writes. Default for every M3 day-1 rule
 *     (which never touch headers).
 *   - `"headers"` — `ctx.headers` reads/writes. Opt-in for M6 header-mutating
 *     rules (`inject_headers`, `passthrough_headers`, `filter_header_csv`,
 *     `strip_header_csv_token`, `strip_header`). Redirect rules that flip a
 *     marker header may declare `["body", "headers"]`.
 *
 * Lint extension (D-LOCK-3) consumes these to detect ctx_write_after_write +
 * ctx_read_without_writer findings on the `"headers"` surface only (`"body"`
 * is intentionally skipped — every rule writes/reads body in some sense and
 * the noise > signal ratio would be poor).
 */
export type CtxSurface = "body" | "headers";

/**
 * Per-rule metadata controlling engine behavior at apply time. All fields
 * are optional; defaults documented per-field.
 */
export interface RegisteredRuleOpts {
  /** Allow `register()` to overwrite an existing entry. Default `false`. */
  allow_override?: boolean;
  /** Mutate ctx in place vs structuredClone first. Default `true` for built-ins. */
  mutate_in_place?: boolean;
  /** State fields the rule reads (per X6 manifest). */
  reads?: string[];
  /** State fields the rule writes (per X6 manifest). */
  writes?: string[];
  /** Declared response shape for `redirect_to_*` rules (per X2; M9 validates). */
  response_shape?: string;
  /** Engine_compat semver range from rule metadata; M9 validates at load. */
  version?: string;
  /**
   * Ctx surfaces this rule **reads** (per F5/M6 D-LOCK-2). Default
   * `["body"]` — matches existing M3 rules' implicit behavior. Header-
   * mutating M6 rules opt-in to `["headers"]`. Stream-event rules ignore
   * this field (they have no ctx-surface concept; they read/write `state`
   * per X6 — captured by `reads`/`writes` above).
   */
  ctx_reads?: ReadonlyArray<CtxSurface>;
  /**
   * Ctx surfaces this rule **writes** (per F5/M6 D-LOCK-2). Default
   * `["body"]` — matches existing M3 rules' implicit behavior. Header-
   * mutating M6 rules opt-in to `["headers"]`; assertion-only rules
   * (`assert_endpoint`) declare `[]` (read-only, no writes).
   */
  ctx_writes?: ReadonlyArray<CtxSurface>;
}

/**
 * A registered body rule: the fn + its option schema + per-rule metadata.
 *
 * The schema is `z.ZodTypeAny` (the most permissive concrete zod type)
 * so consumers can register narrower schemas (`z.object({...})`,
 * `z.discriminatedUnion(...)`) without TypeScript variance complaints.
 *
 * **Resolved opts shape (per F5/M6 D-LOCK-2).** `allow_override` and
 * `mutate_in_place` resolve to non-undefined (default `false` / `true`).
 * `ctx_reads` and `ctx_writes` resolve to non-undefined arrays as well —
 * `["body"]` when the rule didn't declare them — so the lint module can
 * treat `reg.opts.ctx_reads` / `reg.opts.ctx_writes` as always-present.
 */
export interface RegisteredBodyRule {
  fn: TransformFn;
  schema: z.ZodTypeAny;
  opts: Required<
    Pick<
      RegisteredRuleOpts,
      "allow_override" | "mutate_in_place" | "ctx_reads" | "ctx_writes"
    >
  > &
    Omit<
      RegisteredRuleOpts,
      "allow_override" | "mutate_in_place" | "ctx_reads" | "ctx_writes"
    >;
}

/**
 * A registered stream-event rule. Same shape as `RegisteredBodyRule` but
 * with the sync-only `StreamEventTransformFn` signature.
 *
 * Note: stream-event rules ignore `ctx_reads` / `ctx_writes` semantically
 * (they have no body/headers ctx — their state-access surface is the
 * per-stream `StreamState` captured by `reads` / `writes`). The fields are
 * resolved to defaults here purely for type-shape symmetry with body rules.
 */
export interface RegisteredStreamEventRule {
  fn: StreamEventTransformFn;
  schema: z.ZodTypeAny;
  opts: Required<
    Pick<
      RegisteredRuleOpts,
      "allow_override" | "mutate_in_place" | "ctx_reads" | "ctx_writes"
    >
  > &
    Omit<
      RegisteredRuleOpts,
      "allow_override" | "mutate_in_place" | "ctx_reads" | "ctx_writes"
    >;
}

/**
 * Discriminated union over the two registered-rule shapes; returned by
 * `get(surface, name)` so callers can type-narrow on `surface`.
 */
export type RegisteredRule = RegisteredBodyRule | RegisteredStreamEventRule;

/**
 * Thrown by `register()` / `registerStreamEvent()` when a name is already
 * present and `opts.allow_override` is not `true`. Carries both the rule
 * name and a hint pointing at the previous registration so M9's
 * custom-loader can surface a friendly diagnostic to the operator.
 */
export class RuleAlreadyRegisteredError extends Error {
  constructor(
    public readonly ruleName: string,
    public readonly surface: "body" | "stream_event",
  ) {
    super(
      `Rule "${ruleName}" is already registered on the "${surface}" engine. ` +
        `Pass { allow_override: true } to replace.`,
    );
    this.name = "RuleAlreadyRegisteredError";
  }
}

const body_registry: Map<string, RegisteredBodyRule> = new Map();
const stream_event_registry: Map<string, RegisteredStreamEventRule> = new Map();

/**
 * Resolve `RegisteredRuleOpts` defaults. Centralizes the "built-in rules
 * default to `mutate_in_place: true` per O3" decision so it's not
 * duplicated across `register()` and `registerStreamEvent()`.
 *
 * **Ctx-surface defaults (per F5/M6 D-LOCK-2).** `ctx_reads` and
 * `ctx_writes` default to `["body"]` when not provided — that matches
 * every M3 day-1 rule's implicit behavior (they only touch `ctx.body`)
 * and lets the lint module read directly without undefined checks.
 * Header-mutating M6 rules opt-in to `["headers"]` (or `["body","headers"]`).
 */
function resolveOpts<T extends RegisteredRuleOpts | undefined>(
  opts: T,
): RegisteredBodyRule["opts"] {
  return {
    allow_override: opts?.allow_override ?? false,
    mutate_in_place: opts?.mutate_in_place ?? true,
    reads: opts?.reads,
    writes: opts?.writes,
    response_shape: opts?.response_shape,
    version: opts?.version,
    ctx_reads: opts?.ctx_reads ?? ["body"],
    ctx_writes: opts?.ctx_writes ?? ["body"],
  };
}

/**
 * Register a **body** rule. Throws `RuleAlreadyRegisteredError` on
 * duplicate name unless `opts.allow_override === true`.
 *
 * @param name   — rule name (the `use:` value in config)
 * @param fn     — the body-transform fn (sync OR async)
 * @param schema — zod schema validating the rule's options at apply time
 * @param opts   — per-rule metadata (see `RegisteredRuleOpts`)
 */
export function register(
  name: string,
  fn: TransformFn,
  schema: z.ZodTypeAny,
  opts?: RegisteredRuleOpts,
): void {
  invariant(typeof name === "string" && name.length > 0, "rule name required");
  const resolved = resolveOpts(opts);
  if (body_registry.has(name) && !resolved.allow_override) {
    throw new RuleAlreadyRegisteredError(name, "body");
  }
  body_registry.set(name, { fn, schema, opts: resolved });
}

/**
 * Register a **stream-event** rule. Same contract as `register` but for
 * the sync stream-event surface.
 */
export function registerStreamEvent(
  name: string,
  fn: StreamEventTransformFn,
  schema: z.ZodTypeAny,
  opts?: RegisteredRuleOpts,
): void {
  invariant(typeof name === "string" && name.length > 0, "rule name required");
  const resolved = resolveOpts(opts);
  if (stream_event_registry.has(name) && !resolved.allow_override) {
    throw new RuleAlreadyRegisteredError(name, "stream_event");
  }
  stream_event_registry.set(name, { fn, schema, opts: resolved });
}

/**
 * Look up a registered rule by surface + name. Returns `undefined` when
 * the name is not present in the requested surface's registry.
 */
export function get(
  surface: "body",
  name: string,
): RegisteredBodyRule | undefined;
export function get(
  surface: "stream_event",
  name: string,
): RegisteredStreamEventRule | undefined;
export function get(
  surface: "body" | "stream_event",
  name: string,
): RegisteredRule | undefined {
  return surface === "body"
    ? body_registry.get(name)
    : stream_event_registry.get(name);
}

/**
 * List all registered rule names on the given surface (insertion order).
 * Useful for diagnostics ("here's what M9 loaded").
 */
export function list(surface: "body" | "stream_event"): string[] {
  const reg = surface === "body" ? body_registry : stream_event_registry;
  return Array.from(reg.keys());
}

/**
 * Take a frozen point-in-time snapshot of the requested surface's
 * registry. The returned `ReadonlyMap` is what M5's stream handler hands
 * to `applyRules` / `applyEvent` for the duration of a stream — mid-stream
 * `register()` calls cannot affect an already-open stream.
 *
 * Implementation: copy entries into a fresh Map, then return it typed as
 * `ReadonlyMap`. The Map itself is mutable JS, but the type prevents
 * accidental writes by consumers; rule-registration races therefore can't
 * corrupt an in-flight stream.
 */
export function snapshot(
  surface: "body",
): ReadonlyMap<string, RegisteredBodyRule>;
export function snapshot(
  surface: "stream_event",
): ReadonlyMap<string, RegisteredStreamEventRule>;
export function snapshot(
  surface: "body" | "stream_event",
): ReadonlyMap<string, RegisteredRule> {
  if (surface === "body") {
    return new Map<string, RegisteredBodyRule>(body_registry);
  }
  return new Map<string, RegisteredStreamEventRule>(stream_event_registry);
}

/**
 * Clear both registries. **For tests only** — production code never
 * resets registries (live streams hold their own snapshots; resetting
 * the master maps doesn't affect them, but it does affect future
 * `snapshot()` calls).
 */
export function reset(): void {
  body_registry.clear();
  stream_event_registry.clear();
}
