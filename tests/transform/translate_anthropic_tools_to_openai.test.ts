/**
 * translate_anthropic_tools_to_openai.test.ts — per-rule unit tests for
 * `translate_anthropic_tools_to_openai` (M7a).
 *
 * Lane covered: **CC→GPT-4.x legacy** (per addendum §7). Tools-only
 * shape — no full messages-shape translation.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/translate_anthropic_tools_to_openai";
import { TranslateAnthropicToolsToOpenaiSchema } from "~/lib/transform/translate_anthropic_tools_to_openai";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod =
    await import("~/lib/transform/translate_anthropic_tools_to_openai");
  const { register } = await import("~/lib/transform/registry");
  register(
    "translate_anthropic_tools_to_openai",
    mod.translate_anthropic_tools_to_openai,
    mod.TranslateAnthropicToolsToOpenaiSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

function makeCtx(body: unknown, model = "gpt-4o"): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model,
  };
}

describe("translate_anthropic_tools_to_openai — schema validation", () => {
  test("minimal valid config", () => {
    const r = TranslateAnthropicToolsToOpenaiSchema.safeParse({
      name: "x",
      use: "translate_anthropic_tools_to_openai",
    });
    expect(r.success).toBe(true);
  });

  test("translate_tool_choice opt-out is valid", () => {
    const r = TranslateAnthropicToolsToOpenaiSchema.safeParse({
      name: "x",
      use: "translate_anthropic_tools_to_openai",
      translate_tool_choice: false,
    });
    expect(r.success).toBe(true);
  });

  test("wrong use literal is rejected", () => {
    const r = TranslateAnthropicToolsToOpenaiSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

describe("translate_anthropic_tools_to_openai — behavior", () => {
  test("(a) basic tools array conversion", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o",
      tools: [
        {
          name: "get_weather",
          description: "Get the weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { tools: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ]);
  });

  test("(b) tool_choice mapping: auto → 'auto'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [], tool_choice: { type: "auto" } };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { tool_choice: unknown }).tool_choice).toBe(
      "auto",
    );
  });

  test("(b) tool_choice mapping: any → 'required'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [], tool_choice: { type: "any" } };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { tool_choice: unknown }).tool_choice).toBe(
      "required",
    );
  });

  test("(b) tool_choice mapping: specific tool → function-shape", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [],
      tool_choice: { type: "tool", name: "get_weather" },
    };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { tool_choice: unknown }).tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  test("(b) tool_choice mapping: none → 'none'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [], tool_choice: { type: "none" } };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { tool_choice: unknown }).tool_choice).toBe(
      "none",
    );
  });

  test("(b) tool_choice unmappable → field DELETED", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Unknown type — bundle returns undefined; we DROP the field.
    const body = { tools: [], tool_choice: { type: "weirdo" } };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect("tool_choice" in (result.ctx.body as object)).toBe(false);
  });

  test("(b) tool_choice tool without name → field DELETED", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [], tool_choice: { type: "tool" } };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect("tool_choice" in (result.ctx.body as object)).toBe(false);
  });

  test("(c) empty tools array → empty output, applied: true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [] };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as { tools: unknown[] }).tools).toEqual([]);
  });

  test("(d) tool with no input_schema → parameters: undefined (passes through)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [{ name: "ping", description: "no args" }],
    };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    const tools = (
      result.ctx.body as { tools: Array<{ function: { parameters: unknown } }> }
    ).tools;
    expect(tools[0]?.function.parameters).toBeUndefined();
  });

  test("(e) multiple tools preserved in order", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        { name: "a", description: "A", input_schema: { type: "object" } },
        { name: "b", description: "B", input_schema: { type: "object" } },
        { name: "c", description: "C", input_schema: { type: "object" } },
      ],
    };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    const tools = (
      result.ctx.body as { tools: Array<{ function: { name: string } }> }
    ).tools;
    expect(tools.map((t) => t.function.name)).toEqual(["a", "b", "c"]);
  });

  test("(f) name/description preservation across translation", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          name: "complex_name_with_underscores",
          description: 'Multi-line\ndescription with special chars: < > & "',
          input_schema: { type: "object" },
        },
      ],
    };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    const t = (
      result.ctx.body as {
        tools: Array<{ function: { name: string; description: string } }>;
      }
    ).tools[0];
    expect(t?.function.name).toBe("complex_name_with_underscores");
    expect(t?.function.description).toBe(
      'Multi-line\ndescription with special chars: < > & "',
    );
  });

  test("translate_tool_choice: false → tool_choice left alone", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [],
      tool_choice: { type: "auto" },
    };
    const rules: Rule[] = [
      {
        name: "t",
        use: "translate_anthropic_tools_to_openai",
        translate_tool_choice: false,
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect((result.ctx.body as { tool_choice: unknown }).tool_choice).toEqual({
      type: "auto",
    });
  });

  test("ctx.body without tools array → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "gpt-4o" };
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
    // body.tools never created
    expect("tools" in (result.ctx.body as object)).toBe(false);
  });

  test("ctx.body is null → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "t", use: "translate_anthropic_tools_to_openai" },
    ];
    const result = await applyRules(makeCtx(null), rules, snap);
    expect(result.applied).toEqual([]);
  });
});
