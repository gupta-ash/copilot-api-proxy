/**
 * add_body_block.test.ts — per-rule unit tests for add_body_block.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/add_body_block";
import { AddBodyBlockSchema } from "~/lib/transform/add_body_block";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/add_body_block");
  const { register } = await import("~/lib/transform/registry");
  register("add_body_block", mod.add_body_block, mod.AddBodyBlockSchema, {
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

describe("add_body_block — schema validation", () => {
  test("missing path → schema invalid", () => {
    const result = AddBodyBlockSchema.safeParse({
      name: "x",
      use: "add_body_block",
      value: { foo: "bar" },
    });
    expect(result.success).toBe(false);
  });

  test("schema validates the example from the rule's TSDoc", () => {
    const result = AddBodyBlockSchema.safeParse({
      name: "append_safety_tool",
      use: "add_body_block",
      when: { route: "/v1/messages" },
      path: "tools",
      value: { name: "safety_check", description: "Check for unsafe content" },
      position: "end",
    });
    expect(result.success).toBe(true);
  });

  test("invalid position → schema invalid", () => {
    const result = AddBodyBlockSchema.safeParse({
      name: "x",
      use: "add_body_block",
      path: "items",
      value: 1,
      position: "middle",
    });
    expect(result.success).toBe(false);
  });
});

describe("add_body_block — behavior", () => {
  test("append (default position)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a", "b"] };
    const rules: Rule[] = [
      {
        name: "append",
        use: "add_body_block",
        path: "items",
        value: "c",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { items: string[] }).items).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("prepend (position: 'start')", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["b", "c"] };
    const rules: Rule[] = [
      {
        name: "prepend",
        use: "add_body_block",
        path: "items",
        value: "a",
        position: "start",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { items: string[] }).items).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("path resolves to non-array → applied: false (no-op, no throw)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: "not-an-array" };
    const rules: Rule[] = [
      {
        name: "non-array",
        use: "add_body_block",
        path: "items",
        value: "x",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("empty-array append", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: [] as string[] };
    const rules: Rule[] = [
      {
        name: "empty-append",
        use: "add_body_block",
        path: "items",
        value: "first",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { items: string[] }).items).toEqual(["first"]);
  });

  test("deep-nested target (foo.bar.baz)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: { bar: { baz: ["x"] } } };
    const rules: Rule[] = [
      {
        name: "deep",
        use: "add_body_block",
        path: "foo.bar.baz",
        value: "y",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(
      (result.ctx.body as { foo: { bar: { baz: string[] } } }).foo.bar.baz,
    ).toEqual(["x", "y"]);
  });

  test("missing path → applied: false (selector optimism)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {} as Record<string, unknown>;
    const rules: Rule[] = [
      {
        name: "missing",
        use: "add_body_block",
        path: "items",
        value: "x",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("before/after — before is null, after is the added value (deep-cloned)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: [] as unknown[] };
    const rules: Rule[] = [
      {
        name: "before-after",
        use: "add_body_block",
        path: "items",
        value: { id: 1 },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied[0]?.before).toBeNull();
    expect(result.applied[0]?.after).toEqual({ id: 1 });
  });

  test("engine integration — applied[0].name set", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: [1, 2] };
    const rules: Rule[] = [
      {
        name: "engine-int",
        use: "add_body_block",
        path: "items",
        value: 3,
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied[0]?.name).toBe("engine-int");
  });

  test("preserves siblings — adding to one array doesn't touch other body keys", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a"], other: "untouched", flag: true };
    const rules: Rule[] = [
      {
        name: "siblings",
        use: "add_body_block",
        path: "items",
        value: "b",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as Record<string, unknown>).other).toBe(
      "untouched",
    );
    expect((result.ctx.body as Record<string, unknown>).flag).toBe(true);
  });

  test("idempotent re-run doubles the array", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: [] as string[] };
    const rules: Rule[] = [
      {
        name: "double",
        use: "add_body_block",
        path: "items",
        value: "x",
      },
    ];
    let r = await applyRules(makeCtx(body), rules, snap);
    expect((r.ctx.body as { items: string[] }).items).toEqual(["x"]);
    r = await applyRules(r.ctx, rules, snap);
    expect((r.ctx.body as { items: string[] }).items).toEqual(["x", "x"]);
  });
});
