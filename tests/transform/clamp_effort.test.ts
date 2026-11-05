/**
 * clamp_effort.test.ts — per-rule unit tests for clamp_effort (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { ClampEffortSchema } from "~/lib/transform/clamp_effort";
import "~/lib/transform/clamp_effort";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/clamp_effort");
  const { register } = await import("~/lib/transform/registry");
  register("clamp_effort", mod.clamp_effort, mod.ClampEffortSchema, {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
    allow_override: true,
  });
}

function makeCtx(body: unknown, model = "claude-opus-4.7"): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model,
  };
}

describe("clamp_effort — schema validation", () => {
  test("missing max_effort → invalid", () => {
    const r = ClampEffortSchema.safeParse({
      name: "x",
      use: "clamp_effort",
    });
    expect(r.success).toBe(false);
  });

  test("invalid max_effort enum value → invalid", () => {
    const r = ClampEffortSchema.safeParse({
      name: "x",
      use: "clamp_effort",
      max_effort: "ultra",
    });
    expect(r.success).toBe(false);
  });

  test("valid config (model_glob + max_effort)", () => {
    const r = ClampEffortSchema.safeParse({
      name: "x",
      use: "clamp_effort",
      model_glob: "claude-opus-4.7*",
      max_effort: "medium",
    });
    expect(r.success).toBe(true);
  });
});

describe("clamp_effort — behavior", () => {
  test("clamps xhigh down to medium for opus47 (output_config.effort path)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { output_config: { effort: "xhigh" } };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-opus-4.7*",
        max_effort: "medium",
      },
    ];
    const result = await applyRules(
      makeCtx(body, "claude-opus-4.7"),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as { output_config: { effort: string } }).output_config
        .effort,
    ).toBe("medium");
    expect(result.applied[0]?.before).toBe("xhigh");
    expect(result.applied[0]?.after).toBe("medium");
  });

  test("model mismatch (model_glob doesn't match) → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { output_config: { effort: "xhigh" } };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-opus-4.7*",
        max_effort: "medium",
      },
    ];
    const result = await applyRules(makeCtx(body, "gpt-5"), rules, snap);
    expect(result.applied).toEqual([]);
    expect(
      (result.ctx.body as { output_config: { effort: string } }).output_config
        .effort,
    ).toBe("xhigh");
  });

  test("missing effort field → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { messages: [] };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-*",
        max_effort: "medium",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("effort already at or below cap → no-op (applied: false)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { reasoning_effort: "low" };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-*",
        max_effort: "medium",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
    expect(
      (result.ctx.body as { reasoning_effort: string }).reasoning_effort,
    ).toBe("low");
  });

  test("clamps via reasoning_effort top-level path (priority 1)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { reasoning_effort: "high" };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-*",
        max_effort: "medium",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as { reasoning_effort: string }).reasoning_effort,
    ).toBe("medium");
  });

  test("clamps via reasoning.effort nested path (priority 3)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { reasoning: { effort: "xhigh" } };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_effort",
        model_glob: "claude-*",
        max_effort: "high",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as { reasoning: { effort: string } }).reasoning.effort,
    ).toBe("high");
  });

  test("all 4 effort levels clamp correctly", async () => {
    await registerRule();
    const snap = snapshot("body");
    // xhigh → medium
    const r1 = await applyRules(
      makeCtx({ reasoning_effort: "xhigh" }),
      [
        {
          name: "c",
          use: "clamp_effort",
          model_glob: "claude-*",
          max_effort: "medium",
        },
      ],
      snap,
    );
    expect((r1.ctx.body as { reasoning_effort: string }).reasoning_effort).toBe(
      "medium",
    );

    // high → medium
    const r2 = await applyRules(
      makeCtx({ reasoning_effort: "high" }),
      [
        {
          name: "c",
          use: "clamp_effort",
          model_glob: "claude-*",
          max_effort: "medium",
        },
      ],
      snap,
    );
    expect((r2.ctx.body as { reasoning_effort: string }).reasoning_effort).toBe(
      "medium",
    );

    // medium ≤ medium → no-op
    const r3 = await applyRules(
      makeCtx({ reasoning_effort: "medium" }),
      [
        {
          name: "c",
          use: "clamp_effort",
          model_glob: "claude-*",
          max_effort: "medium",
        },
      ],
      snap,
    );
    expect(r3.applied).toEqual([]);

    // low ≤ low → no-op
    const r4 = await applyRules(
      makeCtx({ reasoning_effort: "low" }),
      [
        {
          name: "c",
          use: "clamp_effort",
          model_glob: "claude-*",
          max_effort: "low",
        },
      ],
      snap,
    );
    expect(r4.applied).toEqual([]);
  });
});
