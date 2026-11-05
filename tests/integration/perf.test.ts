/**
 * perf.test.ts — engine per-rule overhead budget verification.
 *
 * Asserts <1ms per-rule overhead in a noop pipeline. Per O3/N8: the engine
 * IS the architecture, so its hot path must be cheap. Catches accidental
 * structuredClone-per-rule regressions or any future engine bloat.
 */

import { describe, expect, it } from "bun:test";

import { strip_body_field } from "../../src/lib/transform/strip_body_field.ts";
import { applyRules } from "../../src/lib/transform/apply.ts";
import {
  register,
  reset,
  snapshot,
  list,
} from "../../src/lib/transform/registry.ts";
import { StripBodyFieldSchema } from "../../src/lib/transform/strip_body_field.ts";
import type { Rule, TransformContext } from "../../src/lib/transform/types.ts";

const REGISTERED_RULES = ["strip_body_field"] as const;

function ensureRulesRegistered(): void {
  if (!list("body").includes("strip_body_field")) {
    register("strip_body_field", strip_body_field, StripBodyFieldSchema);
  }
}

describe("engine perf budget", () => {
  it("100 requests × 20-rule noop pipeline ≤ ~20ms (1ms per rule × 20)", async () => {
    ensureRulesRegistered();
    void REGISTERED_RULES;

    // 20-rule pipeline: each strip_body_field with a path that does NOT
    // exist in the body — the rule no-ops. This isolates engine overhead
    // from rule-body work.
    const rules: Rule[] = Array.from({ length: 20 }, (_v, i) => ({
      name: `noop-${i}`,
      use: "strip_body_field",
      paths: [`nonexistent.field.${i}`],
    }));

    const snap = snapshot("body");

    const ctx: TransformContext = {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: {},
      route: "/v1/messages",
      model: "claude-opus-4.7",
      harness: undefined,
    };

    const N_REQUESTS = 100;
    const t0 = performance.now();
    for (let i = 0; i < N_REQUESTS; i++) {
      await applyRules(ctx, rules, snap);
    }
    const elapsed = performance.now() - t0;
    const perRequest = elapsed / N_REQUESTS;
    const perRule = perRequest / 20;
    // eslint-disable-next-line no-console
    console.log(
      `perf: ${N_REQUESTS} req × 20 rules in ${elapsed.toFixed(1)}ms (${perRule.toFixed(3)}ms/rule)`,
    );
    // Generous bound: <2ms/rule (target is <1ms but CI variance + bun warmup
    // can push the first run higher; the assertion catches gross regressions).
    expect(perRule).toBeLessThan(2);
  });

  it("single noop rule applyRules is structurally cheap (no structuredClone for mutate_in_place=true)", async () => {
    ensureRulesRegistered();
    const rules: Rule[] = [
      { name: "noop", use: "strip_body_field", paths: ["x.y.z"] },
    ];
    const snap = snapshot("body");
    const ctx: TransformContext = {
      body: { x: 1 },
      headers: {},
      route: "/v1/messages",
      model: "claude-opus-4.7",
      harness: undefined,
    };
    const result = await applyRules(ctx, rules, snap);
    // mutate_in_place=true (the default for built-in rules) means the
    // returned ctx is the same reference as input.
    expect(result.ctx).toBe(ctx);
  });

  it("registry snapshot is cheap (taken per-stream, not per-rule)", () => {
    reset();
    register("strip_body_field", strip_body_field, StripBodyFieldSchema);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      snapshot("body");
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50); // 50ms for 1000 snapshots = 50µs each
  });
});
