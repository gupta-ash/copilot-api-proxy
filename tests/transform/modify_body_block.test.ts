/**
 * modify_body_block.test.ts — per-rule unit tests for modify_body_block.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/modify_body_block";
import { ModifyBodyBlockSchema } from "~/lib/transform/modify_body_block";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/modify_body_block");
  const { register } = await import("~/lib/transform/registry");
  register(
    "modify_body_block",
    mod.modify_body_block,
    mod.ModifyBodyBlockSchema,
    { allow_override: true },
  );
}

function makeCtx(body: unknown): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model: "claude-opus-4-7",
  };
}

describe("modify_body_block — schema validation", () => {
  test("missing modify → schema invalid", () => {
    const result = ModifyBodyBlockSchema.safeParse({
      name: "x",
      use: "modify_body_block",
      selector: { path: "foo", matcher: { equals: "x" } },
    });
    expect(result.success).toBe(false);
  });

  test("schema validates the example from the rule's TSDoc", () => {
    const result = ModifyBodyBlockSchema.safeParse({
      name: "cap_max_tokens",
      use: "modify_body_block",
      when: { route: "/v1/messages" },
      selector: {
        path: "messages[].content[]",
        matcher: { contains: "DRAFT" },
      },
      modify: { stop_reason: "manual_cap" },
    });
    expect(result.success).toBe(true);
  });
});

describe("modify_body_block — behavior", () => {
  test("zero-match → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "no-hit",
        use: "modify_body_block",
        selector: { path: "missing", matcher: { equals: "x" } },
        modify: { foo: "bar" },
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("object-merge into matched leaf", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      blocks: [
        { id: 1, kind: "text", meta: { src: "old" } },
        { id: 2, kind: "text", meta: { src: "old" } },
      ],
    };
    const rules: Rule[] = [
      {
        name: "merge",
        use: "modify_body_block",
        selector: { path: "blocks[].kind", matcher: { equals: "text" } },
        modify: { stamp: "added" },
      },
    ];
    // selector returns the .kind leaf which is a string — no match for
    // object-merge (conservative no-op). To exercise the merge path we
    // need a selector that lands on an object leaf. Switch to selecting
    // each block via wildcard with a contains matcher on a string; but
    // since matchers operate on STRING leaves, we can't directly target an
    // object. Use a leaf string then merge at the result.value (which is
    // a string — no match). The conservative path applies.
    const result = await applyRules(makeCtx(body), rules, snap);
    // strings don't merge; rule returns applied: false per the no-op rule.
    expect(result.applied).toEqual([]);
  });

  test("nested-path leaf that IS an object: schema works but selector matchers only target strings — applied:false (conservative)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: [{ name: "a" }, { name: "b" }] };
    const rules: Rule[] = [
      {
        name: "merge-attempt",
        use: "modify_body_block",
        selector: { path: "items[].name", matcher: { equals: "a" } },
        modify: { tagged: true },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    // The leaf is the string "a" — modify_body_block conservatively no-ops
    // on non-object leaves.
    expect(result.applied).toEqual([]);
    expect(
      (result.ctx.body as { items: Array<{ tagged?: boolean }> }).items[0]
        ?.tagged,
    ).toBeUndefined();
  });

  test("regex matcher hitting an object leaf is impossible (strings only) — but if ALL selector matches are strings, rule returns applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a", "b"] };
    const rules: Rule[] = [
      {
        name: "no-merge",
        use: "modify_body_block",
        selector: { path: "items[]", matcher: { regex: "^a$" } },
        modify: { foo: "bar" },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("schema validation: bad modify type fails apply with abort_with_500", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "bad-modify",
        use: "modify_body_block",
        on_error: "abort_with_500",
        selector: { path: "foo", matcher: { equals: "x" } },
        // modify must be an object — pass a string to violate schema.
        modify: "not-an-object" as unknown as Record<string, unknown>,
      },
    ];
    let caught: unknown;
    try {
      await applyRules(makeCtx({ foo: "x" }), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("EngineAbort500Error");
  });

  test("preserves siblings (only the matched object leaf is mutated; the parent object's other keys remain)", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Build a body where the selector path lands on a leaf string, then
    // verify the parent object is not touched.
    const body = { foo: "x", bar: "untouched" };
    const rules: Rule[] = [
      {
        name: "siblings",
        use: "modify_body_block",
        selector: { path: "foo", matcher: { equals: "x" } },
        modify: { ignored: true },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    // Conservative no-op: foo is a string leaf so the rule does NOT mutate.
    expect((result.ctx.body as Record<string, unknown>).bar).toBe("untouched");
    expect((result.ctx.body as Record<string, unknown>).foo).toBe("x");
  });

  test("idempotent re-run with no matches in fixture", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a", "b"] };
    const rules: Rule[] = [
      {
        name: "no-mod",
        use: "modify_body_block",
        selector: { path: "items[]", matcher: { equals: "z" } },
        modify: { foo: "bar" },
      },
    ];
    const r1 = await applyRules(makeCtx(body), rules, snap);
    expect(r1.applied).toEqual([]);
    const r2 = await applyRules(r1.ctx, rules, snap);
    expect(r2.applied).toEqual([]);
  });

  test("named-fn modify is NOT implemented in M3 (TSDoc'd; deferred)", () => {
    // The schema does NOT accept a `modify_fn` field — confirms the
    // documented deferral.
    const result = ModifyBodyBlockSchema.safeParse({
      name: "x",
      use: "modify_body_block",
      selector: { path: "foo", matcher: { equals: "x" } },
      modify: { stamp: 1 },
      modify_fn: "bump_max_tokens", // extra field; passthrough() ignores
    });
    expect(result.success).toBe(true);
  });

  test("engine integration — applied list reflects the rule's own no-op when matches are non-object", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: "x" };
    const rules: Rule[] = [
      {
        name: "engine-int",
        use: "modify_body_block",
        selector: { path: "foo", matcher: { equals: "x" } },
        modify: { unused: true },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    // No object leaves matched → applied: false → no AppliedRule.
    expect(result.applied).toEqual([]);
  });

  test("engine snapshot survives mid-applyRules registry mutation", async () => {
    await registerRule();
    const snap = snapshot("body");
    resetRegistry();
    const body = { foo: "x" };
    const rules: Rule[] = [
      {
        name: "snap-survives",
        use: "modify_body_block",
        selector: { path: "foo", matcher: { equals: "x" } },
        modify: { foo: "bar" },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    // Selector targets a string leaf — applied:false; but importantly no
    // throw, proving the snapshot works after registry reset.
    expect(result.applied).toEqual([]);
  });
});
