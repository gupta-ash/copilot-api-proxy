/**
 * apply.ts — body-engine apply loop.
 *
 * **Per-stream registry snapshot (per O4).** Callers pass a frozen
 * `ReadonlyMap<string, RegisteredBodyRule>` taken at stream-open time.
 * Mid-stream `register()` calls do NOT affect this run — the snapshot is
 * the source of truth.
 *
 * **Mutate-in-place default (per O3).** Built-in rules default to
 * `mutate_in_place: true` (set at registration). `apply.ts` honors this
 * by passing `ctx` directly to the rule fn. When a rule was registered
 * with `mutate_in_place: false` (M9 custom-loaded plugins typically), the
 * engine `structuredClone`s the context before handing it over so the
 * caller's original is preserved.
 *
 * **Engine adopts `result.ctx` after each rule (per F1 fix, M2.5).** After
 * each rule returns, the engine re-binds its loop variable
 * `ctx ← result.ctx`. This is a no-op when `mutate_in_place: true`
 * (`ctxForCall === ctx`, so `result.ctx` is the same reference). When
 * `mutate_in_place: false`, the engine handed the rule a `structuredClone`
 * of the original; the rule mutated the clone; the engine adopts the
 * clone (via `result.ctx`) as the canonical context for downstream rules
 * and for the final return. Rule authors may also return a brand-new
 * object (clone-and-replace OR full-body-swap) — `TransformResult.ctx` is
 * load-bearing and the engine respects whatever the rule returned.
 *
 * Symmetry with `apply_event.ts`: that surface has no `mutate_in_place`
 * concept (state is always mutated in place per N8 perf budget), but it
 * mirrors `apply.ts`'s continue-error policy — see § Error semantics
 * below and `apply_event.ts` § F2 (M2.5) note.
 *
 * **Error semantics (per R30-R32, refined per F2 in M2.5).** Each rule
 * may declare `on_error: "continue" | "continue_passthrough" |
 * "abort_with_500" | "abort_with_502"` (default `"continue"`):
 *   - `"continue"` — log via `debug.on(LEVEL_ON)`, push an `AppliedRule`
 *     with the `error` field set, continue to the next rule. Body engine
 *     has no `events_out` concept, so the symmetric "fail-closed"
 *     behavior of `apply_event` does not apply here — the body context
 *     simply stays at whatever the prior rule left it (or the original
 *     input ctx if this was rule-1).
 *   - `"continue_passthrough"` — same as `"continue"` for the body
 *     engine (no semantic difference because there is no event suppression
 *     to opt out of). Accepted for cross-surface config symmetry; see
 *     decisions.md § D26 (post-M2.5).
 *   - `"abort_with_500"` — throw `EngineAbort500Error` wrapping the
 *     original error. Caller (M5 route handler) maps to HTTP 500.
 *   - `"abort_with_502"` — throw `EngineAbort502Error`. M5 maps to 502.
 *
 * **Defensive schema validation.** Every rule's options are
 * zod-validated against the schema registered alongside its fn (per
 * X3/O2). Validation failure is treated under the SAME `on_error` policy
 * as a thrown rule body (per F7 fix in M3) — `continue` /
 * `continue_passthrough` log + push AppliedRule with `error` set + advance;
 * `abort_with_500` / `abort_with_502` throw `EngineAbort{500,502}Error`
 * wrapping the zod error. The historical `RuleSchemaInvalidError` symbol
 * is retained and exported so legacy call sites keep compiling, but the
 * engine itself only constructs it as the `originalError` cause inside
 * `EngineAbort{500,502}Error` under abort policies. M9 will also validate
 * at config-load time so this apply-time check is defense-in-depth — but
 * it's mandatory because M2's smoke tests have to exercise the same code
 * path real rules use.
 *
 * **Async-allowed.** The body-rule fn signature returns
 * `TransformResult | Promise<TransformResult>`; `apply.ts` `await`s
 * uniformly. Stream-event rules are sync only (see `apply_event.ts`).
 *
 * **Pre-loop lint hook (per F4 in M2.5).** `lintRules` is invoked once
 * per `applyRules` call to surface state-collision warnings via
 * `debug.on(LEVEL_ON)`. Diagnostic only — never throws. M9 layers
 * enforcement on top.
 */

import { LEVEL_ON, debug } from "../debug.ts";
import { invariant } from "../assert.ts";

import { lintRules } from "./lint.ts";
import { evaluate } from "./predicate.ts";
import type { RegisteredBodyRule } from "./registry.ts";
import type {
  AppliedRule,
  Rule,
  TransformContext,
  TransformResult,
} from "./types.ts";

/**
 * Thrown when a rule's `use:` doesn't resolve in the registry snapshot.
 * Should normally have been caught at config-load time by M9; defensive
 * throw at apply time.
 */
export class UnregisteredRuleError extends Error {
  constructor(public readonly ruleName: string) {
    super(
      `Rule "${ruleName}" is not registered on the body engine. ` +
        `(Was the snapshot taken from the wrong surface, or the rule mis-named?)`,
    );
    this.name = "UnregisteredRuleError";
  }
}

/**
 * Thrown when a rule's options fail zod validation against the registered
 * schema. Carries the rule name AND the raw zod error so M5's handler can
 * map to a friendly diagnostic.
 */
export class RuleSchemaInvalidError extends Error {
  public readonly originalError: unknown;
  constructor(
    public readonly ruleName: string,
    originalError: unknown,
  ) {
    super(
      `Rule "${ruleName}" failed schema validation: ${
        originalError instanceof Error
          ? originalError.message
          : String(originalError)
      }`,
    );
    this.name = "RuleSchemaInvalidError";
    this.originalError = originalError;
  }
}

/**
 * Base class for engine-abort errors. Carries the rule name and the
 * original throw so M5 can preserve the cause chain.
 */
export class EngineAbortError extends Error {
  public readonly originalError: unknown;
  constructor(
    public readonly ruleName: string,
    originalError: unknown,
    httpStatus: 500 | 502,
  ) {
    super(
      `Engine aborted at rule "${ruleName}" (HTTP ${httpStatus}): ${
        originalError instanceof Error
          ? originalError.message
          : String(originalError)
      }`,
    );
    this.name = "EngineAbortError";
    this.originalError = originalError;
  }
}

/** Aborts with HTTP 500. Rule-config opt-in via `on_error: "abort_with_500"`. */
export class EngineAbort500Error extends EngineAbortError {
  constructor(ruleName: string, cause: unknown) {
    super(ruleName, cause, 500);
    this.name = "EngineAbort500Error";
  }
}

/** Aborts with HTTP 502. Rule-config opt-in via `on_error: "abort_with_502"`. */
export class EngineAbort502Error extends EngineAbortError {
  constructor(ruleName: string, cause: unknown) {
    super(ruleName, cause, 502);
    this.name = "EngineAbort502Error";
  }
}

/**
 * Apply a list of body rules to a context. Iterates `rules` in declared
 * order; for each rule:
 *   1. Look up in `registrySnapshot`. If missing, throw
 *      `UnregisteredRuleError`.
 *   2. Evaluate predicate via `predicate.evaluate(rule.when, ctx)`. If
 *      false, skip — no `AppliedRule` emitted.
 *   3. Validate `rule` against the registered schema. Failure is treated
 *      under `rule.on_error` (per F7, M3): `continue` /
 *      `continue_passthrough` log + record + advance; `abort_with_500` /
 *      `abort_with_502` throw `EngineAbort{500,502}Error` wrapping a
 *      `RuleSchemaInvalidError`.
 *   4. If `mutate_in_place: false`, `structuredClone(ctx)` first.
 *   5. `await fn(ctxForCall, rule)`.
 *   6. On throw: per `rule.on_error` (default `"continue"`), log + push
 *      AppliedRule with error, OR throw `EngineAbort{500,502}Error`.
 *   6b. **Adopt `result.ctx`** as the working context for downstream
 *       rules (per F1 fix, M2.5).
 *   7. On `applied: true` success, push AppliedRule with optional
 *      before/after.
 *   8. On `applied: false`, do NOT push AppliedRule (predicate matched
 *      but rule chose not to fire).
 *
 * Returns the (possibly mutated) `ctx` and the accumulated `applied`
 * list. When all rules were `mutate_in_place: true` AND every rule
 * returned its input ref via `result.ctx`, the returned `ctx` is the
 * same reference as the input parameter. When any rule was
 * `mutate_in_place: false` OR returned a different `ctx`, the returned
 * `ctx` is the post-adoption context — distinct from the original input
 * parameter.
 */
export async function applyRules(
  ctx: TransformContext,
  rules: Rule[],
  registrySnapshot: ReadonlyMap<string, RegisteredBodyRule>,
): Promise<{ ctx: TransformContext; applied: AppliedRule[] }> {
  invariant(Array.isArray(rules), "applyRules: rules must be an array");
  const applied: AppliedRule[] = [];

  // Working ctx — re-bound after each rule per F1 fix (M2.5). The function
  // parameter is left untouched so call-site references remain valid.
  let workingCtx: TransformContext = ctx;

  // Pre-loop diagnostic lint (per F4 in M2.5). Fires once per call;
  // never throws; production-OFF debug means silent.
  for (const finding of lintRules(rules, registrySnapshot, "body")) {
    debug.on(
      LEVEL_ON,
      () =>
        `apply: lint[${finding.severity}/${finding.code}] (${finding.ruleNames.join(", ")}): ${finding.message}`,
    );
  }

  for (const rule of rules) {
    // 1. Lookup
    const reg = registrySnapshot.get(rule.use);
    if (reg === undefined) {
      throw new UnregisteredRuleError(rule.use);
    }

    // 2. Predicate
    if (!evaluate(rule.when, workingCtx)) {
      continue;
    }

    // 3. Schema validation (per F7 fix in M3, schema-invalid is now in the
    // SAME bucket as a thrown rule body — honored by `rule.on_error`).
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
      // "continue" or "continue_passthrough" — log + record + advance.
      debug.on(
        LEVEL_ON,
        () =>
          `apply: rule "${rule.name}" failed schema validation under on_error=${policy} — ${message}`,
      );
      applied.push({
        name: rule.name,
        error: message,
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
      continue;
    }

    // 4. Choose context (clone vs mutate-in-place)
    const ctxForCall: TransformContext = reg.opts.mutate_in_place
      ? workingCtx
      : (structuredClone(workingCtx) as TransformContext);

    // 5. Invoke the rule fn (await handles sync + async returns)
    let result: TransformResult;
    try {
      result = await reg.fn(ctxForCall, rule);
    } catch (err) {
      // 6. Error handling per on_error policy
      const policy = rule.on_error ?? "continue";
      if (policy === "abort_with_500") {
        throw new EngineAbort500Error(rule.name, err);
      }
      if (policy === "abort_with_502") {
        throw new EngineAbort502Error(rule.name, err);
      }
      // "continue" or "continue_passthrough" — log + record + continue.
      // Body engine has no event suppression so the two policies are
      // semantically identical here; the union exists for cross-surface
      // config symmetry with apply_event.ts (see decisions.md § D26
      // (post-M2.5)).
      const message = err instanceof Error ? err.message : String(err);
      debug.on(
        LEVEL_ON,
        () =>
          `apply: rule "${rule.name}" threw under on_error=${policy} — ${message}`,
      );
      applied.push({
        name: rule.name,
        error: message,
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
      continue;
    }

    // 6b. Adopt the rule's returned ctx for the next iteration (per F1
    // fix, M2.5). When mutate_in_place was true, ctxForCall === workingCtx
    // so result.ctx is the same reference and this is a no-op. When
    // mutate_in_place was false, ctxForCall was a structuredClone; the
    // rule mutated the clone; we adopt the clone (via result.ctx) as the
    // canonical ctx for downstream rules and the final return. Rule
    // authors may also return a brand-new object (clone-and-replace OR
    // full-body-swap) — TransformResult.ctx is load-bearing.
    workingCtx = result.ctx;

    // 7 / 8. Record only when the rule actually fired
    if (result.applied) {
      applied.push({
        name: rule.name,
        ...(result.before !== undefined ? { before: result.before } : {}),
        ...(result.after !== undefined ? { after: result.after } : {}),
        ...(reg.opts.reads !== undefined ? { reads: reg.opts.reads } : {}),
        ...(reg.opts.writes !== undefined ? { writes: reg.opts.writes } : {}),
      });
    }
  }

  return { ctx: workingCtx, applied };
}
