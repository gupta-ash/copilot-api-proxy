/**
 * strip_body_field.test.ts — per-rule unit tests for strip_body_field.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/strip_body_field";
import { StripBodyFieldSchema } from "~/lib/transform/strip_body_field";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/strip_body_field");
  const { register } = await import("~/lib/transform/registry");
  register("strip_body_field", mod.strip_body_field, mod.StripBodyFieldSchema, {
    allow_override: true,
  });
}

function makeCtx(body: unknown): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model: "claude-opus-4-7",
  };
}

describe("strip_body_field — schema validation", () => {
  test("missing paths → schema invalid", () => {
    const result = StripBodyFieldSchema.safeParse({
      name: "x",
      use: "strip_body_field",
    });
    expect(result.success).toBe(false);
  });

  test("empty paths array → schema invalid", () => {
    const result = StripBodyFieldSchema.safeParse({
      name: "x",
      use: "strip_body_field",
      paths: [],
    });
    expect(result.success).toBe(false);
  });

  test("schema validates the example from the rule's TSDoc", () => {
    const result = StripBodyFieldSchema.safeParse({
      name: "strip_output_config_effort",
      use: "strip_body_field",
      when: { route: "/v1/messages" },
      paths: ["output_config.effort", "thinking.type"],
    });
    expect(result.success).toBe(true);
  });
});

describe("strip_body_field — behavior", () => {
  test("single-path strip (top-level)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: "drop", bar: "keep" };
    const rules: Rule[] = [
      {
        name: "single",
        use: "strip_body_field",
        paths: ["foo"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as Record<string, unknown>).foo).toBeUndefined();
    expect((result.ctx.body as Record<string, unknown>).bar).toBe("keep");
    expect(result.applied[0]?.before).toEqual({ foo: "drop" });
  });

  test("multi-path strip (top + nested)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      output_config: { effort: "high", quality: "max" },
      thinking: { type: "adaptive", budget: 100 },
    };
    const rules: Rule[] = [
      {
        name: "multi",
        use: "strip_body_field",
        paths: ["output_config.effort", "thinking.type"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    const b = result.ctx.body as {
      output_config: { effort?: string; quality: string };
      thinking: { type?: string; budget: number };
    };
    expect(b.output_config.effort).toBeUndefined();
    expect(b.output_config.quality).toBe("max");
    expect(b.thinking.type).toBeUndefined();
    expect(b.thinking.budget).toBe(100);
  });

  test("non-existent path → applied: false (when ALL paths miss)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: "x" };
    const rules: Rule[] = [
      {
        name: "miss",
        use: "strip_body_field",
        paths: ["missing.path"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("deep nested (a.b.c.d)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { a: { b: { c: { d: "drop", other: "keep" } } } };
    const rules: Rule[] = [
      {
        name: "deep",
        use: "strip_body_field",
        paths: ["a.b.c.d"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    const inner = (
      result.ctx.body as { a: { b: { c: { d?: string; other: string } } } }
    ).a.b.c;
    expect(inner.d).toBeUndefined();
    expect(inner.other).toBe("keep");
  });

  test("mixed (some paths exist, some don't) → applied: true if at least one deleted", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { existing: "drop" };
    const rules: Rule[] = [
      {
        name: "mixed",
        use: "strip_body_field",
        paths: ["existing", "ghost"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(
      (result.ctx.body as Record<string, unknown>).existing,
    ).toBeUndefined();
    expect(result.applied[0]?.before).toEqual({ existing: "drop" });
  });

  test("preserves sibling fields", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      keep: { a: 1, b: 2 },
      drop_me: "x",
    };
    const rules: Rule[] = [
      {
        name: "siblings",
        use: "strip_body_field",
        paths: ["drop_me"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as Record<string, unknown>).keep).toEqual({
      a: 1,
      b: 2,
    });
  });

  test("engine integration — applied[0].name set", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: "bar" };
    const rules: Rule[] = [
      {
        name: "engine-int",
        use: "strip_body_field",
        paths: ["foo"],
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied[0]?.name).toBe("engine-int");
  });
});
