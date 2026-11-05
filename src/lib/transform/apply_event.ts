/**
 * apply_event.ts — stream-event apply loop (per-event hot path).
 *
 * **Sync only.** Per-event budget is <1ms (per N8). The
 * `StreamEventTransformFn` signature is sync; this module never `await`s.
 *
 * **Default passthrough.** When NO rule fires (all predicates false),
 * the engine emits `[ctx.event]` so the original event flows through. If
 * at least one rule fires but emits no events (`events_out: []`), the
 * suppression is honored — the original event is dropped.
 *
 * **State semantics.** `ctx.state` is the per-stream mutable state
 * object. Rules may mutate it in place; later rules in the chain
 * immediately see the writes. The engine ALSO collects each rule's
 * `result.state_changes` into a cumulative `state_changes` accumulator
 * so the M5 route handler has an explicit changelog for trace + persist.
 *
 * **State-access manifest (per X6).** Each registered rule declares
 * `reads: string[]` and `writes: string[]` at registration. `apply_event`
 * propagates these into `AppliedRule.{reads, writes}` so M9 can run
 * cross-rule read-after-write conflict detection at config-load time.
 * **`apply_event` itself does NOT enforce the manifest at apply time** —
 * the data flow exists end-to-end so M7b/M8 can consume it; M9 is the
 * conflict detector. M2.5 adds DIAGNOSTIC detection via `lint.ts`
 * (see § Pre-loop lint hook below).
 *
 * **Error semantics — fail-closed by default (per F2 fix, M2.5; see
 * decisions.md § D26 (post-M2.5)).**
 *   - `on_error: "continue"` (DEFAULT) — log via `debug.on(LEVEL_ON)`,
 *     push an `AppliedRule` with `error` set, AND **flip `anyFired = true`
 *     so the original event is suppressed**. Rationale: a rule that
 *     declared a `when:` matching this event AND threw indicates the
 *     event was claimed by a transformer that failed. Passing the
 *     unredacted/unprocessed original through is unsafe (silent leak).
 *     The fail-closed default trades ONE missing event over zero PII
 *     leaks. The body engine has no `events_out` concept so its
 *     symmetric path simply continues with the prior `workingCtx` (see
 *     `apply.ts` § F1 / F2 notes).
 *   - `on_error: "continue_passthrough"` (NEW in M2.5) — fail-open
 *     opt-in. Log + record AppliedRule with `error` set, but DO NOT flip
 *     `anyFired`. The original event is preserved in `events_out`
 *     (default-passthrough fires when no other rule actively suppresses
 *     it). Use sparingly — only appropriate for pure logger/observer
 *     rules that explicitly must never block the stream. Naming is
 *     intentionally explicit so an audit grep `on_error.*passthrough`
 *     finds every fail-open rule in the codebase.
 *   - `on_error: "abort_with_500"` / `"abort_with_502"` — throw the
 *     corresponding `EngineAbort{500,502}Error`; M5 maps to HTTP 500/502.
 *
 * **Pre-loop lint hook (per F4 in M2.5).** `lintRules` is invoked once
 * per `applyEvent` call to surface state-collision warnings via
 * `debug.on(LEVEL_ON)`. Diagnostic only — never throws. Cost is O(n) per
 * call (n = rule list length, 10-20). M9 layers enforcement on top.
 *
 * **Performance discipline.** No `structuredClone` of state. No
 * unnecessary Map allocations per event. Predicate-skipped rules do
 * NOT cost more than a hash lookup + an O(set-fields) check.
 */

import { LEVEL_ON, debug } from "../debug.ts";
import { invariant } from "../assert.ts";

import {
  EngineAbort500Error,
  EngineAbort502Error,
  RuleSchemaInvalidError,
  UnregisteredRuleError,
} from "./apply.ts";
import { lintRules } from "./lint.ts";
import { evaluate } from "./predicate.ts";
import type { RegisteredStreamEventRule } from "./registry.ts";
import type {
  AnyEvent,
  AppliedRule,
  Rule,
  StreamEventContext,
  StreamEventResult,
  StreamState,
} from "./types.ts";

/**
 * Apply a list of stream-event rules to a single incoming event. Returns
 * the cumulative outgoing events, the AppliedRule observability list, and
 * an aggregated state-changes accumulator.
 *
 * Iteration is in declared rule order. Default passthrough: if no rule
 * fires, returns `[ctx.event]` so the event flows through unchanged.
 */
export function applyEvent(
  ctx: StreamEventContext,
  rules: Rule[],
  registrySnapshot: ReadonlyMap<string, RegisteredStreamEventRule>,
): {
  events_out: AnyEvent[];
  applied: AppliedRule[];
  state_changes: Partial<StreamState>;
} {
  invariant(Array.isArray(rules), "applyEvent: rules must be an array");
  invariant(
    typeof ctx.event === "object" && ctx.event !== null,
    "applyEvent: ctx.event must be an object",
  );

  const applied: AppliedRule[] = [];
  const events_out: AnyEvent[] = [];
  const state_changes: Partial<StreamState> = {};
  let anyFired = false;

  // Pre-loop diagnostic lint (per F4 in M2.5). Fires once per call;
  // never throws; production-OFF debug means silent.
  for (const finding of lintRules(rules, registrySnapshot, "stream_event")) {
    debug.on(
      LEVEL_ON,
      () =>
        `apply_event: lint[${finding.severity}/${finding.code}] (${finding.ruleNames.join(", ")}): ${finding.message}`,
    );
  }

  for (const rule of rules) {
    // 1. Lookup
    const reg = registrySnapshot.get(rule.use);
    if (reg === undefined) {
      throw new UnregisteredRuleError(rule.use);
    }

    // 2. Predicate (includes event_types check via predicate.ts)
    if (!evaluate(rule.when, ctx)) {
      continue;
    }

    // 3. Schema validation (per F7 fix in M3, schema-invalid is now in the
    // SAME bucket as a thrown rule body — honored by `rule.on_error`).
    // Default-continue is fail-closed per D26 (the rule claimed this
    // event_type AND failed validation; we suppress the original event).
    const parsed = reg.schema.safeParse(rule);
    if (!parsed.success) {
      const policy = rule.on_error ?? "continue";
      const zodErr = parsed.error;
      const message = `schema validation failed: ${zodErr.message}`;
      if (policy === "abort_with_500") {
        throw new EngineAbort500Error(
          rule.name,
          new RuleSchemaInvalidError(rule.name, zodErr),
        );
      }
      if (policy === "abort_with_502") {
        throw new EngineAbort502Error(
          rule.name,
          new RuleSchemaInvalidError(rule.name, zodErr),
        );
      }
      debug.on(
        LEVEL_ON,
        () =>
          `apply_event: rule "${rule.name}" failed schema validation under on_error=${policy} — ${message}`,
      );
      applied.push({
        name: rule.name,
        error: message,
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
      // D26 fail-closed default: schema-invalid under "continue" suppresses
      // the original event (same logic as a thrown rule body — the rule
      // claimed this event_type AND failed). "continue_passthrough" leaves
      // anyFired untouched so default-passthrough preserves the event.
      if (policy === "continue") {
        anyFired = true;
      }
      continue;
    }

    // 4. Invoke (sync, no await)
    let result: StreamEventResult;
    try {
      result = reg.fn(ctx, rule);
    } catch (err) {
      const policy = rule.on_error ?? "continue";
      if (policy === "abort_with_500") {
        throw new EngineAbort500Error(rule.name, err);
      }
      if (policy === "abort_with_502") {
        throw new EngineAbort502Error(rule.name, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      debug.on(
        LEVEL_ON,
        () =>
          `apply_event: rule "${rule.name}" threw under on_error=${policy} — ${message}`,
      );
      applied.push({
        name: rule.name,
        error: message,
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
      // F2 fail-closed default (per M2.5; see decisions.md § D26
      // (post-M2.5)). A throw under "continue" indicates the rule
      // claimed this event_type AND failed — passing the original
      // through unprocessed could leak unredacted content. Flip
      // anyFired so default-passthrough does NOT re-emit ctx.event.
      // Opt out via on_error: "continue_passthrough" for pure
      // logger/observer rules that must never block the stream.
      if (policy === "continue") {
        anyFired = true;
      }
      // policy === "continue_passthrough" — leave anyFired untouched so
      // default-passthrough preserves the original event when no other
      // rule actively suppresses it.
      continue;
    }

    // 5. Result accumulation
    if (result.applied) {
      anyFired = true;
      for (const ev of result.events_out) {
        events_out.push(ev);
      }
      if (result.state_changes !== undefined) {
        for (const [k, v] of Object.entries(result.state_changes)) {
          state_changes[k] = v;
        }
      }
      applied.push({
        name: rule.name,
        ...(result.state_changes !== undefined
          ? { state_changes: result.state_changes }
          : {}),
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
    }
    // result.applied: false means predicate matched but rule chose not to
    // fire — no AppliedRule, no event accumulation, anyFired untouched.
  }

  // Default passthrough: if NO rule actively fired, emit the original.
  if (!anyFired) {
    return { events_out: [ctx.event], applied, state_changes };
  }

  return { events_out, applied, state_changes };
}
