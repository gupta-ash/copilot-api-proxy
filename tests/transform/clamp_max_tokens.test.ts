/**
 * clamp_max_tokens.test.ts — per-rule unit tests for clamp_max_tokens (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { ClampMaxTokensSchema } from "~/lib/transform/clamp_max_tokens";
import "~/lib/transform/clamp_max_tokens";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/clamp_max_tokens");
  const { register } = await import("~/lib/transform/registry");
  register("clamp_max_tokens", mod.clamp_max_tokens, mod.ClampMaxTokensSchema, {
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

describe("clamp_max_tokens — schema validation", () => {
  test("missing max → invalid", () => {
    const r = ClampMaxTokensSchema.safeParse({
      name: "x",
      use: "clamp_max_tokens",
    });
    expect(r.success).toBe(false);
  });

  test("max must be positive integer", () => {
    expect(
      ClampMaxTokensSchema.safeParse({
        name: "x",
        use: "clamp_max_tokens",
        max: 0,
      }).success,
    ).toBe(false);
    expect(
      ClampMaxTokensSchema.safeParse({
        name: "x",
        use: "clamp_max_tokens",
        max: 1.5,
      }).success,
    ).toBe(false);
    expect(
      ClampMaxTokensSchema.safeParse({
        name: "x",
        use: "clamp_max_tokens",
        max: 32000,
      }).success,
    ).toBe(true);
  });
});

describe("clamp_max_tokens — behavior", () => {
  test("clamps overage down to cap (claude-opus-4.7 case)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_tokens: 100000 };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-*",
        max: 32000,
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { max_tokens: number }).max_tokens).toBe(32000);
    expect(result.applied[0]?.before).toBe(100000);
    expect(result.applied[0]?.after).toBe(32000);
  });

  test("value already at cap → no-op", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_tokens: 32000 };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-*",
        max: 32000,
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("value already under cap → no-op", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_tokens: 5000 };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-*",
        max: 32000,
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("model mismatch → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_tokens: 100000 };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-*",
        max: 32000,
      },
    ];
    const result = await applyRules(makeCtx(body, "gpt-5"), rules, snap);
    expect(result.applied).toEqual([]);
    expect((result.ctx.body as { max_tokens: number }).max_tokens).toBe(100000);
  });

  test("missing max_tokens field → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-*",
        max: 32000,
      },
    ];
    const result = await applyRules(makeCtx({ messages: [] }), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("opus-4.6-1m exact glob (per bundle parity)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_tokens: 200000 };
    const rules: Rule[] = [
      {
        name: "clamp",
        use: "clamp_max_tokens",
        model_glob: "claude-opus-4.6-1m*",
        max: 64000,
      },
    ];
    const result = await applyRules(
      makeCtx(body, "claude-opus-4.6-1m"),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { max_tokens: number }).max_tokens).toBe(64000);
  });
});
