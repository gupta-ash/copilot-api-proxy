/**
 * apply.test.ts — verifies the body-engine apply loop:
 *   - happy path (single + multi-rule)
 *   - declared order
 *   - on_error: continue / abort_with_500 / abort_with_502
 *   - mutate_in_place: true (default for built-ins) vs false
 *   - O4 snapshot survives mid-stream register()
 *   - predicate match + result.applied: false → no AppliedRule
 *   - async rules awaited
 *   - schema-validation failure → RuleSchemaInvalidError
 *   - missing rule.use → UnregisteredRuleError
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  EngineAbort500Error,
  EngineAbort502Error,
  RuleSchemaInvalidError,
  UnregisteredRuleError,
  applyRules,
} from "~/lib/transform/apply";
import {
  register,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import type {
  Rule,
  TransformContext,
  TransformResult,
} from "~/lib/transform/types";

const noopSchema = z
  .object({
    name: z.string(),
    use: z.string(),
  })
  .passthrough();

function makeCtx(overrides: Partial<TransformContext> = {}): TransformContext {
  return {
    body: { foo: "bar" },
    headers: {},
    route: "/v1/messages",
    model: "claude-opus-4.7",
    ...overrides,
  };
}

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

describe("applyRules — happy path", () => {
  test("single noop rule fires; AppliedRule emitted", async () => {
    register(
      "noop",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "noop", use: "noop" }];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("noop");
    expect(applied[0]?.before).toBeUndefined();
    expect(applied[0]?.after).toBeUndefined();
    expect(applied[0]?.error).toBeUndefined();
  });

  test("AppliedRule carries before/after when result supplies them", async () => {
    register(
      "snap",
      (ctx): TransformResult => ({
        ctx,
        applied: true,
        before: { foo: "bar" },
        after: { foo: "baz" },
      }),
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "snap", use: "snap" }];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied[0]?.before).toEqual({ foo: "bar" });
    expect(applied[0]?.after).toEqual({ foo: "baz" });
  });

  test("multiple rules fire in declared order", async () => {
    const order: string[] = [];
    register(
      "a",
      (ctx): TransformResult => {
        order.push("a");
        return { ctx, applied: true };
      },
      noopSchema,
    );
    register(
      "b",
      (ctx): TransformResult => {
        order.push("b");
        return { ctx, applied: true };
      },
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "a", use: "a" },
      { name: "b", use: "b" },
    ];
    await applyRules(makeCtx(), rules, snap);
    expect(order).toEqual(["a", "b"]);
  });

  test("predicate fail → rule skipped silently (no AppliedRule)", async () => {
    register(
      "skip",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "skip", use: "skip", when: { route: "/responses" } },
    ];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toEqual([]);
  });

  test("predicate match but result.applied: false → no AppliedRule emitted", async () => {
    register(
      "no-match",
      (ctx): TransformResult => ({ ctx, applied: false }),
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "no-match", use: "no-match" }];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toEqual([]);
  });
});

describe("applyRules — error semantics (R30-R32)", () => {
  test("on_error: continue (default) — log + record + next rule fires", async () => {
    register(
      "boom",
      (): TransformResult => {
        throw new Error("kaboom");
      },
      noopSchema,
    );
    register(
      "after",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "boom", use: "boom" }, // default on_error
      { name: "after", use: "after" },
    ];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toHaveLength(2);
    expect(applied[0]?.name).toBe("boom");
    expect(applied[0]?.error).toBe("kaboom");
    expect(applied[1]?.name).toBe("after");
    expect(applied[1]?.error).toBeUndefined();
  });

  test("on_error: abort_with_500 → throws EngineAbort500Error", async () => {
    register(
      "boom-500",
      (): TransformResult => {
        throw new Error("five hundred");
      },
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "boom-500", use: "boom-500", on_error: "abort_with_500" },
    ];
    let caught: unknown;
    try {
      await applyRules(makeCtx(), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineAbort500Error);
    expect((caught as EngineAbort500Error).ruleName).toBe("boom-500");
    expect(
      ((caught as EngineAbort500Error).originalError as Error).message,
    ).toBe("five hundred");
  });

  test("on_error: abort_with_502 → throws EngineAbort502Error", async () => {
    register(
      "boom-502",
      (): TransformResult => {
        throw new Error("five oh two");
      },
      noopSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "boom-502", use: "boom-502", on_error: "abort_with_502" },
    ];
    let caught: unknown;
    try {
      await applyRules(makeCtx(), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineAbort502Error);
    expect((caught as EngineAbort502Error).ruleName).toBe("boom-502");
  });
});

describe("applyRules — mutate_in_place semantics (per O3)", () => {
  test("mutate_in_place: true (built-in default) — original ctx is mutated", async () => {
    register(
      "mutator",
      (ctx): TransformResult => {
        (ctx.body as { foo: string }).foo = "MUTATED";
        return { ctx, applied: true };
      },
      noopSchema,
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [{ name: "mutator", use: "mutator" }];
    const result = await applyRules(ctx, rules, snap);
    expect((result.ctx.body as { foo: string }).foo).toBe("MUTATED");
    expect((ctx.body as { foo: string }).foo).toBe("MUTATED");
  });

  test("mutate_in_place: false — original ctx UNCHANGED", async () => {
    register(
      "isolated",
      (ctx): TransformResult => {
        (ctx.body as { foo: string }).foo = "INSIDE-CLONE";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: false },
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [{ name: "isolated", use: "isolated" }];
    await applyRules(ctx, rules, snap);
    // Original ctx body should still have its initial value because the
    // rule operated on a structuredClone'd copy.
    expect((ctx.body as { foo: string }).foo).toBe("bar");
  });
});

describe("applyRules — O4 per-stream registry snapshot", () => {
  test("snapshot taken before mid-stream register() resolves to OLD fn", async () => {
    const fired: { which: "OLD" | "NEW" | null } = { which: null };
    register(
      "swap",
      (ctx): TransformResult => {
        fired.which = "OLD";
        return { ctx, applied: true };
      },
      noopSchema,
    );

    // Take snapshot — this freezes the registry view for this run.
    const snap = snapshot("body");

    // Mid-stream re-register with a NEW fn under the same name.
    register(
      "swap",
      (ctx): TransformResult => {
        fired.which = "NEW";
        return { ctx, applied: true };
      },
      noopSchema,
      { allow_override: true },
    );

    // Apply against the OLD snapshot — must invoke the OLD fn.
    const rules: Rule[] = [{ name: "swap", use: "swap" }];
    await applyRules(makeCtx(), rules, snap);
    expect(fired.which).toBe("OLD");
  });
});

describe("applyRules — async rules", () => {
  test("Promise-returning rule is awaited", async () => {
    register(
      "async-rule",
      async (ctx): Promise<TransformResult> => {
        await new Promise((res) => setTimeout(res, 5));
        (ctx.body as { foo: string }).foo = "ASYNC-DONE";
        return { ctx, applied: true };
      },
      noopSchema,
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [{ name: "async-rule", use: "async-rule" }];
    await applyRules(ctx, rules, snap);
    expect((ctx.body as { foo: string }).foo).toBe("ASYNC-DONE");
  });
});

describe("applyRules — defensive validation", () => {
  test("schema validation failure under default on_error: continue → AppliedRule with error (per F7 fix in M3)", async () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        // Strict typing of an extra option that the test rule violates.
        max_count: z.number().int().min(1),
      })
      .passthrough();
    register(
      "strict",
      (ctx): TransformResult => ({ ctx, applied: true }),
      strictSchema,
    );
    const snap = snapshot("body");
    // Pass `max_count: "not-a-number"` to violate the schema.
    // Default on_error is "continue" — engine records error + advances
    // (per F7 fix in M3). To reach a thrown RuleSchemaInvalidError caller
    // must opt in via on_error: "abort_with_500" (covered by the F7
    // describe block below).
    const rules: Rule[] = [
      { name: "strict", use: "strict", max_count: "not-a-number" },
    ];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("strict");
    expect(applied[0]?.error).toContain("schema validation failed");
  });

  test("unregistered rule.use → UnregisteredRuleError", async () => {
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "ghost", use: "ghost" }];
    let caught: unknown;
    try {
      await applyRules(makeCtx(), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnregisteredRuleError);
    expect((caught as UnregisteredRuleError).ruleName).toBe("ghost");
  });
});

describe("applyRules — manifest propagation (per X6)", () => {
  test("AppliedRule carries reads/writes from registration manifest", async () => {
    register(
      "with-manifest",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
      { reads: ["finalUsage"], writes: ["finalUsage", "delta_count"] },
    );
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "with-manifest", use: "with-manifest" }];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied[0]?.reads).toEqual(["finalUsage"]);
    expect(applied[0]?.writes).toEqual(["finalUsage", "delta_count"]);
  });
});

describe("applyRules — F7 fix (M3): schema-invalid honors on_error policy", () => {
  test("F7 — schema-invalid + on_error: 'continue' (default) → AppliedRule with error + workingCtx unchanged + no throw", async () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    register(
      "strict-continue",
      (ctx): TransformResult => ({ ctx, applied: true }),
      strictSchema,
    );
    register(
      "after-strict",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [
      {
        name: "strict-continue",
        use: "strict-continue",
        // No on_error → defaults to "continue"
        max_count: "not-a-number",
      },
      { name: "after-strict", use: "after-strict" },
    ];
    const { applied } = await applyRules(ctx, rules, snap);
    expect(applied).toHaveLength(2);
    expect(applied[0]?.name).toBe("strict-continue");
    expect(applied[0]?.error).toContain("schema validation failed");
    // Next rule still fires.
    expect(applied[1]?.name).toBe("after-strict");
    expect(applied[1]?.error).toBeUndefined();
    // workingCtx body unchanged by the failed rule.
    expect((ctx.body as { foo: string }).foo).toBe("bar");
  });

  test("F7 — schema-invalid + on_error: 'continue_passthrough' → AppliedRule with error + no throw (body engine: same as continue)", async () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    register(
      "strict-passthrough",
      (ctx): TransformResult => ({ ctx, applied: true }),
      strictSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "strict-passthrough",
        use: "strict-passthrough",
        on_error: "continue_passthrough",
        max_count: -1,
      },
    ];
    const { applied } = await applyRules(makeCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.error).toContain("schema validation failed");
  });

  test("F7 — schema-invalid + on_error: 'abort_with_500' → throws EngineAbort500Error wrapping RuleSchemaInvalidError", async () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    register(
      "strict-abort",
      (ctx): TransformResult => ({ ctx, applied: true }),
      strictSchema,
    );
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "strict-abort",
        use: "strict-abort",
        on_error: "abort_with_500",
        max_count: "not-a-number",
      },
    ];
    let caught: unknown;
    try {
      await applyRules(makeCtx(), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineAbort500Error);
    expect((caught as EngineAbort500Error).ruleName).toBe("strict-abort");
    expect((caught as EngineAbort500Error).originalError).toBeInstanceOf(
      RuleSchemaInvalidError,
    );
  });
});

describe("applyRules — F1 fix (M2.5): engine adopts result.ctx after each rule", () => {
  test("F1 — chained mutate_in_place:false rules see prior mutations", async () => {
    register(
      "set-A",
      (ctx): TransformResult => {
        (ctx.body as { foo: string }).foo = "A";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: false },
    );
    register(
      "read-A",
      (ctx): TransformResult => {
        const seen = (ctx.body as { foo: string }).foo;
        (ctx.body as { foo: string; seen: string }).seen = seen;
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: false },
    );
    const snap = snapshot("body");
    const ctx = makeCtx(); // ctx.body.foo === "bar" initially
    const rules: Rule[] = [
      { name: "set-A", use: "set-A" },
      { name: "read-A", use: "read-A" },
    ];
    const result = await applyRules(ctx, rules, snap);

    // Rule-2 must have seen rule-1's mutation (proves engine adopted result.ctx).
    expect((result.ctx.body as { seen: string }).seen).toBe("A");
    expect((result.ctx.body as { foo: string }).foo).toBe("A");
    // Original parameter ctx still UNCHANGED (clone semantics preserved).
    expect((ctx.body as { foo: string; seen?: string }).foo).toBe("bar");
    expect((ctx.body as { foo: string; seen?: string }).seen).toBeUndefined();
  });

  test("F1 — single mutate_in_place:false rule, caller observes mutation via result.ctx", async () => {
    register(
      "isolated-observable",
      (ctx): TransformResult => {
        (ctx.body as { foo: string }).foo = "INSIDE-CLONE";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: false },
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [
      { name: "isolated-observable", use: "isolated-observable" },
    ];
    const result = await applyRules(ctx, rules, snap);

    // Caller MUST be able to see the mutation via result.ctx (this is the
    // F1 contract — the mutate_in_place:false rule's work is not silently
    // dropped on the floor).
    expect((result.ctx.body as { foo: string }).foo).toBe("INSIDE-CLONE");
    // Original ctx still untouched (clone semantics preserved — companion
    // assertion to the existing "mutate_in_place: false — original ctx
    // UNCHANGED" test).
    expect((ctx.body as { foo: string }).foo).toBe("bar");
  });

  test("F1 — mixed chain: true → false → true, all 3 mutations visible via result.ctx; original ctx reflects only the leading true-rule mutation", async () => {
    register(
      "mip-true-1",
      (ctx): TransformResult => {
        (ctx.body as Record<string, unknown>).step1 = "true-1";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: true },
    );
    register(
      "mip-false",
      (ctx): TransformResult => {
        (ctx.body as Record<string, unknown>).step2 = "false";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: false },
    );
    register(
      "mip-true-2",
      (ctx): TransformResult => {
        (ctx.body as Record<string, unknown>).step3 = "true-2";
        return { ctx, applied: true };
      },
      noopSchema,
      { mutate_in_place: true },
    );
    const snap = snapshot("body");
    const ctx = makeCtx();
    const rules: Rule[] = [
      { name: "mip-true-1", use: "mip-true-1" },
      { name: "mip-false", use: "mip-false" },
      { name: "mip-true-2", use: "mip-true-2" },
    ];
    const result = await applyRules(ctx, rules, snap);
    const resBody = result.ctx.body as Record<string, unknown>;

    // All 3 rules' mutations visible on the engine-returned ctx.
    expect(resBody.step1).toBe("true-1");
    expect(resBody.step2).toBe("false");
    expect(resBody.step3).toBe("true-2");

    // Original parameter ctx mutation history:
    //  - rule-1 (true) mutated the original directly → step1 visible.
    //  - rule-2 (false) cloned BEFORE mutating → step2 NOT on original.
    //  - rule-3 (true) mutated the CLONE (which the engine adopted), so
    //    step3 also NOT on original.
    const origBody = ctx.body as Record<string, unknown>;
    expect(origBody.step1).toBe("true-1");
    expect(origBody.step2).toBeUndefined();
    expect(origBody.step3).toBeUndefined();
  });
});
