/**
 * strip_body_block.test.ts — per-rule unit tests + R10 acceptance test
 * (the headline M3 demo). The rule registers itself on import.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyRules, RuleSchemaInvalidError } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/strip_body_block";
import { StripBodyBlockSchema } from "~/lib/transform/strip_body_block";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

beforeEach(() => {
  // Re-import the rule to re-register after the reset()s above.
  // Side-effect import of the same module path is idempotent for ES module
  // graphs; the rule's top-level register() call only fires on the first
  // load. To be safe in this isolated suite we re-run the registration
  // explicitly via a require-style refresh.
  // Simpler: import the schema + fn from the rule module and call register
  // again ourselves.
});

// Re-register helper — call at the start of each test that needs the rule.
async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/strip_body_block");
  const { register } = await import("~/lib/transform/registry");
  register("strip_body_block", mod.strip_body_block, mod.StripBodyBlockSchema, {
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

describe("strip_body_block — schema validation", () => {
  test("missing selector → schema invalid", () => {
    const result = StripBodyBlockSchema.safeParse({
      name: "x",
      use: "strip_body_block",
    });
    expect(result.success).toBe(false);
  });

  test("empty matcher → schema invalid (refine() rejects)", () => {
    const result = StripBodyBlockSchema.safeParse({
      name: "x",
      use: "strip_body_block",
      selector: { path: "foo", matcher: {} },
    });
    expect(result.success).toBe(false);
  });

  test("schema validates the example from the rule's TSDoc", () => {
    const result = StripBodyBlockSchema.safeParse({
      name: "strip_cc_billing_header",
      use: "strip_body_block",
      when: { route: "/v1/messages" },
      selector: {
        path: "system[].text",
        matcher: { startsWith: "x-anthropic-billing-header:" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("schema-invalid under apply → throws RuleSchemaInvalidError on abort_with_500", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "bad",
        use: "strip_body_block",
        on_error: "abort_with_500",
        // No selector — schema validation fails.
      },
    ];
    let caught: unknown;
    try {
      await applyRules(makeCtx({}), rules, snap);
    } catch (e) {
      caught = e;
    }
    // The engine wraps RuleSchemaInvalidError inside EngineAbort500Error
    // under abort policies (per F7 in M3).
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("EngineAbort500Error");
    const original = (caught as { originalError?: unknown }).originalError;
    expect(original).toBeInstanceOf(RuleSchemaInvalidError);
  });
});

describe("strip_body_block — single & multi removal", () => {
  test("zero-match → applied: false; no AppliedRule emitted by engine", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "no-hit",
        use: "strip_body_block",
        selector: { path: "missing", matcher: { equals: "x" } },
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("single-match removal from array (splice)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a", "b", "c"] };
    const rules: Rule[] = [
      {
        name: "strip-b",
        use: "strip_body_block",
        selector: { path: "items[]", matcher: { equals: "b" } },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { items: string[] }).items).toEqual(["a", "c"]);
  });

  test("multi-match removal from same array — reverse-index splice keeps siblings intact", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Strip every "x" — result must be ["a", "b"] (siblings preserved).
    const body = { items: ["x", "a", "x", "b", "x"] };
    const rules: Rule[] = [
      {
        name: "strip-x",
        use: "strip_body_block",
        selector: { path: "items[]", matcher: { equals: "x" } },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { items: string[] }).items).toEqual(["a", "b"]);
    // before snapshot has 3 entries (the three x's).
    expect(result.applied[0]?.before).toEqual(["x", "x", "x"]);
  });

  test("nested-path match (messages[].content[].text) — splices the enclosing content[i] block", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          content: [
            { type: "text", text: "keep" },
            { type: "text", text: "drop" },
          ],
        },
      ],
    };
    const rules: Rule[] = [
      {
        name: "nested",
        use: "strip_body_block",
        selector: {
          path: "messages[].content[].text",
          matcher: { equals: "drop" },
        },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    // The enclosing array of the .text leaf is content; the index 1 block
    // (the whole { type, text: "drop" } object) is spliced.
    const inner = (
      result.ctx.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      }
    ).messages[0]!.content;
    expect(inner).toHaveLength(1);
    expect(inner[0]?.text).toBe("keep");
  });

  test("object-parent removal (top-level scalar; no enclosing array → delete the key)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { foo: "bye", bar: "stay" };
    const rules: Rule[] = [
      {
        name: "drop-foo",
        use: "strip_body_block",
        selector: { path: "foo", matcher: { equals: "bye" } },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as Record<string, unknown>).foo).toBeUndefined();
    expect((result.ctx.body as Record<string, unknown>).bar).toBe("stay");
  });

  test("before snapshot deep-copies — captures the BLOCK that gets spliced (an items[i] object)", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Selector matches a string leaf inside an enclosing array; the rule
    // splices the enclosing array element (the whole {mutable: ...} obj).
    const body = { items: [{ mutable: "original", other: "kept" }] };
    const rules: Rule[] = [
      {
        name: "drop-by-ref",
        use: "strip_body_block",
        selector: {
          path: "items[].mutable",
          matcher: { equals: "original" },
        },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { items: unknown[] }).items).toEqual([]);
    expect(result.applied[0]?.before).toEqual([
      { mutable: "original", other: "kept" },
    ]);
  });

  test("idempotent re-run with no matches in fixture", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["a", "b"] };
    const rules: Rule[] = [
      {
        name: "drop-z",
        use: "strip_body_block",
        selector: { path: "items[]", matcher: { equals: "z" } },
      },
    ];
    const r1 = await applyRules(makeCtx(body), rules, snap);
    expect(r1.applied).toEqual([]);
    const r2 = await applyRules(r1.ctx, rules, snap);
    expect(r2.applied).toEqual([]);
    expect((r2.ctx.body as { items: string[] }).items).toEqual(["a", "b"]);
  });
});

describe("strip_body_block — engine integration & snapshot semantics", () => {
  test("engine integration: applyRules + this rule mutates body + applied[0].name", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { items: ["keep", "drop", "keep"] };
    const rules: Rule[] = [
      {
        name: "engine-int",
        use: "strip_body_block",
        selector: { path: "items[]", matcher: { equals: "drop" } },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied[0]?.name).toBe("engine-int");
    expect((result.ctx.body as { items: string[] }).items).toEqual([
      "keep",
      "keep",
    ]);
  });

  test("engine snapshot survives mid-applyRules registry mutation (M2 contract holds)", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Now mutate the live registry — should not affect `snap`.
    resetRegistry();
    const body = { items: ["keep", "drop"] };
    const rules: Rule[] = [
      {
        name: "still-works",
        use: "strip_body_block",
        selector: { path: "items[]", matcher: { equals: "drop" } },
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { items: string[] }).items).toEqual(["keep"]);
  });
});

describe("strip_body_block — synthetic billing-header example", () => {
  test("synthetic CC body: two strips preserve the remaining system block and body", async () => {
    await registerRule();
    const fixturePath = resolve(
      import.meta.dir,
      "..",
      "fixtures",
      "cc_opus_billing_header.json",
    );
    const expectedPath = resolve(
      import.meta.dir,
      "..",
      "fixtures",
      "cc_opus_billing_header.expected.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
    const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as unknown;

    const ctx: TransformContext = {
      body: fixture,
      headers: {},
      route: "/v1/messages",
      model: "claude-opus-4-7",
    };

    const rules: Rule[] = [
      {
        name: "strip_cc_billing_header",
        use: "strip_body_block",
        when: { route: "/v1/messages" },
        selector: {
          path: "system[].text",
          matcher: { startsWith: "x-anthropic-billing-header:" },
        },
      },
      {
        name: "strip_cc_agent_identity",
        use: "strip_body_block",
        when: { route: "/v1/messages" },
        selector: {
          path: "system[].text",
          matcher: {
            equals:
              "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
          },
        },
      },
    ];

    const snap = snapshot("body");
    const result = await applyRules(ctx, rules, snap);

    // Both rules fired.
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]?.name).toBe("strip_cc_billing_header");
    expect(Array.isArray(result.applied[0]?.before)).toBe(true);
    expect((result.applied[0]?.before as unknown[]).length).toBeGreaterThan(0);
    expect(result.applied[1]?.name).toBe("strip_cc_agent_identity");
    expect(Array.isArray(result.applied[1]?.before)).toBe(true);
    expect((result.applied[1]?.before as unknown[]).length).toBeGreaterThan(0);

    // Byte-equivalent to the hand-authored expected fixture (after strip).
    expect(JSON.stringify(result.ctx.body)).toBe(JSON.stringify(expected));
  });
});
