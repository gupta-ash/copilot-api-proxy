/**
 * derive_reasoning_effort.test.ts — per-rule unit tests for
 * derive_reasoning_effort (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { DeriveReasoningEffortSchema } from "~/lib/transform/derive_reasoning_effort";
import "~/lib/transform/derive_reasoning_effort";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/derive_reasoning_effort");
  const { register } = await import("~/lib/transform/registry");
  register(
    "derive_reasoning_effort",
    mod.derive_reasoning_effort,
    mod.DeriveReasoningEffortSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

function makeCtx(body: unknown): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("derive_reasoning_effort — schema validation", () => {
  test("missing source_path → invalid", () => {
    const r = DeriveReasoningEffortSchema.safeParse({
      name: "x",
      use: "derive_reasoning_effort",
      target_path: "reasoning.effort",
    });
    expect(r.success).toBe(false);
  });

  test("missing target_path → invalid", () => {
    const r = DeriveReasoningEffortSchema.safeParse({
      name: "x",
      use: "derive_reasoning_effort",
      source_path: "reasoning_effort",
    });
    expect(r.success).toBe(false);
  });

  test("invalid override enum value → invalid", () => {
    const r = DeriveReasoningEffortSchema.safeParse({
      name: "x",
      use: "derive_reasoning_effort",
      source_path: "a",
      target_path: "b",
      override: "ultra",
    });
    expect(r.success).toBe(false);
  });

  test("valid config", () => {
    const r = DeriveReasoningEffortSchema.safeParse({
      name: "x",
      use: "derive_reasoning_effort",
      source_path: "thinking.budget_tokens",
      target_path: "reasoning.effort",
    });
    expect(r.success).toBe(true);
  });
});

describe("derive_reasoning_effort — behavior", () => {
  test("source = thinking.budget_tokens (1024) → low at target", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {
      thinking: { budget_tokens: 1024 },
    };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "thinking.budget_tokens",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("low");
    expect(result.applied[0]?.before).toBeUndefined();
    expect(result.applied[0]?.after).toBe("low");
  });

  test("source = thinking.budget_tokens (8192) → medium", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {
      thinking: { budget_tokens: 8192 },
    };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "thinking.budget_tokens",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("medium");
  });

  test("source = thinking.budget_tokens (16384) → high", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {
      thinking: { budget_tokens: 16384 },
    };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "thinking.budget_tokens",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("high");
  });

  test("source = reasoning_effort (string passthrough)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = { reasoning_effort: "high" };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "reasoning_effort",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("high");
  });

  test("override: writes override regardless of source", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = { reasoning_effort: "low" };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "reasoning_effort",
        target_path: "reasoning.effort",
        override: "medium",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("medium");
  });

  test("source unresolved → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {};
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "thinking.budget_tokens",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("target already at derived value → applied: false (no-op)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {
      reasoning_effort: "medium",
      reasoning: { effort: "medium" },
    };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "reasoning_effort",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("creates intermediate objects on target_path", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = { reasoning_effort: "high" };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "reasoning_effort",
        target_path: "deeply.nested.reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (
        result.ctx.body as {
          deeply: { nested: { reasoning: { effort: string } } };
        }
      ).deeply.nested.reasoning.effort,
    ).toBe("high");
  });

  test("source = invalid string (not in enum) → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = { reasoning_effort: "weird" };
    const rules: Rule[] = [
      {
        name: "d",
        use: "derive_reasoning_effort",
        source_path: "reasoning_effort",
        target_path: "reasoning.effort",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });
});
