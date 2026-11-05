/**
 * Synthetic per-field tests for Anthropic-to-Responses body conversion.
 * These examples assert protocol mappings, not captured-traffic parity.
 * End-to-end synthetic SSE replay lives in tests/integration/.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/translate_anthropic_to_responses";
import { TranslateAnthropicToResponsesSchema } from "~/lib/transform/translate_anthropic_to_responses";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/translate_anthropic_to_responses");
  const { register } = await import("~/lib/transform/registry");
  register(
    "translate_anthropic_to_responses",
    mod.translate_anthropic_to_responses,
    mod.TranslateAnthropicToResponsesSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

function makeCtx(body: unknown, model = "gpt-5.4"): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model,
  };
}

const baseRule: Rule = {
  name: "t",
  use: "translate_anthropic_to_responses",
};

describe("translate_anthropic_to_responses — schema validation", () => {
  test("minimal valid config", () => {
    const r = TranslateAnthropicToResponsesSchema.safeParse({
      name: "x",
      use: "translate_anthropic_to_responses",
    });
    expect(r.success).toBe(true);
  });

  test("default_effort accepts the 4 effort levels", () => {
    for (const eff of ["minimal", "low", "medium", "high"]) {
      const r = TranslateAnthropicToResponsesSchema.safeParse({
        name: "x",
        use: "translate_anthropic_to_responses",
        default_effort: eff,
      });
      expect(r.success).toBe(true);
    }
  });

  test("invalid default_effort is rejected", () => {
    const r = TranslateAnthropicToResponsesSchema.safeParse({
      name: "x",
      use: "translate_anthropic_to_responses",
      default_effort: "extreme",
    });
    expect(r.success).toBe(false);
  });

  test("default_max_output_tokens must be positive int", () => {
    const r = TranslateAnthropicToResponsesSchema.safeParse({
      name: "x",
      use: "translate_anthropic_to_responses",
      default_max_output_tokens: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe("translate_anthropic_to_responses — behavior", () => {
  test("(a) basic message conversion: simple user text", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi there" }],
      max_tokens: 1024,
      stream: true,
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    expect(result.applied).toHaveLength(1);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi there" }],
      },
    ]);
    expect(out.max_output_tokens).toBe(1024);
    expect(out.stream).toBe(true);
  });

  test("(b) system as string → developer message at start of input[]", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-5.4",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "You are helpful." }],
    });
  });

  test("(b) system as Anthropic blocks array → developer message with N input_text parts", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-5.4",
      system: [
        { type: "text", text: "block A" },
        { type: "text", text: "block B" },
        { type: "text", text: "block C", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    // cache_control is dropped (Responses doesn't have a direct equivalent at body translation; M9 handles separately)
    expect(input[0]).toEqual({
      type: "message",
      role: "developer",
      content: [
        { type: "input_text", text: "block A" },
        { type: "input_text", text: "block B" },
        { type: "input_text", text: "block C" },
      ],
    });
  });

  test("(c) tool_use block → function_call item", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-5.4",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "function_call",
      id: "fc_abc123",
      call_id: "toolu_abc123",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
  });

  test("(c) tool_use with empty input{} → arguments: '{}'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_xyz",
              name: "ping",
              input: {},
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]?.arguments).toBe("{}");
  });

  test("(c) tool_use with missing input → arguments: '{}'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_xyz", name: "ping" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]?.arguments).toBe("{}");
  });

  test("(c) tool_result block → function_call_output item", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: "65 F, sunny",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "toolu_abc",
      output: "65 F, sunny",
    });
  });

  test("(c) tool_result with array content → joined text", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: [
                { type: "text", text: "Part A. " },
                { type: "text", text: "Part B." },
              ],
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]?.output).toBe("Part A. Part B.");
  });

  test("(d) assistant thinking + text blocks combined into single output_text", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "Let me think... " },
            { type: "text", text: "Answer." },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me think... Answer." }],
    });
  });

  test("(e) cache_control marker on system blocks is silently dropped", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      system: [
        { type: "text", text: "marked", cache_control: { type: "ephemeral" } },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    const dev = input[0]?.content as Array<Record<string, unknown>>;
    expect(dev[0]).toEqual({ type: "input_text", text: "marked" });
    // Verify cache_control did NOT leak into the output content.
    expect(dev[0]?.cache_control).toBeUndefined();
  });

  test("(f) max_tokens → max_output_tokens (renamed, value preserved)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-5.4",
      messages: [],
      max_tokens: 32000,
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_output_tokens).toBe(32000);
    expect("max_tokens" in out).toBe(false);
  });

  test("(f) missing max_tokens → opts.default_max_output_tokens, else 128000", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { messages: [] };
    const result = await applyRules(
      makeCtx(body),
      [
        {
          ...baseRule,
          default_max_output_tokens: 4096,
        },
      ],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_output_tokens).toBe(4096);

    // Without the opt → 128000
    await registerRule();
    const snap2 = snapshot("body");
    const result2 = await applyRules(
      makeCtx({ messages: [] }),
      [baseRule],
      snap2,
    );
    expect(
      (result2.ctx.body as Record<string, unknown>).max_output_tokens,
    ).toBe(128000);
  });

  test("(g) default_effort opt → reasoning.effort default seed", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { messages: [] };
    const result = await applyRules(
      makeCtx(body),
      [{ ...baseRule, default_effort: "high" }],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  test("(g) absent default_effort → reasoning.effort = 'medium'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ messages: [] }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  test("tools: function-shape Anthropic tool → Responses function tool with strict:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object" },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
  });

  test("tools: web_search_20250305 → OpenAI web_search type", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tools).toEqual([
      { type: "web_search", search_context_size: "medium" },
    ]);
  });

  test("tools: web_search_20250305 with allowed_domains → filters", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          type: "web_search_20250305",
          allowed_domains: ["example.com", "wikipedia.org"],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tools).toEqual([
      {
        type: "web_search",
        search_context_size: "medium",
        filters: { allowed_domains: ["example.com", "wikipedia.org"] },
      },
    ]);
  });

  test("tools: empty tools[] → tools field NOT emitted", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [] };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("tools" in out).toBe(false);
  });

  test("(h) image content block → input_image with data URL", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    const content = input[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
    });
  });

  test("(i) empty messages[] → input[] still has system if present, else empty", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ messages: [] }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.input).toEqual([]);
  });

  test("(i) absent messages and no system → input: []", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.input).toEqual([]);
    expect(result.applied).toHaveLength(1);
  });

  test("(j) unknown content_block type → JSON-stringified into input_text (preserved per D9)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "valid" },
            { type: "future_block_v999", payload: { foo: "bar" } },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    const content = input[0]?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "input_text", text: "valid" });
    // Unknown block preserved as JSON-stringified text — caller can debug.
    expect(content[1]?.type).toBe("input_text");
    expect(content[1]?.text).toContain("future_block_v999");
  });

  test("call-id shortening: long tool_use.id (>64 chars) → fc_proxy_<random>", async () => {
    await registerRule();
    const snap = snapshot("body");
    const longId = "toolu_" + "x".repeat(80); // 86 chars total
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: longId,
              name: "long_tool",
              input: { a: 1 },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    const callId = input[0]?.call_id as string;
    expect(callId.length).toBeLessThanOrEqual(64);
    expect(callId.startsWith("fc_proxy_")).toBe(true);
  });

  test("call-id shortening: same long id used twice → same short id", async () => {
    await registerRule();
    const snap = snapshot("body");
    const longId = "toolu_" + "x".repeat(80);
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: longId, name: "tA", input: {} },
            { type: "tool_use", id: longId, name: "tB", input: {} },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]?.call_id).toBe(input[1]?.call_id as string);
  });

  test("ctx.body fixed defaults: store, truncation, include", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.store).toBe(false);
    expect(out.truncation).toBe("disabled");
    expect(out.include).toEqual([
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ]);
  });

  test("stream default: absent → true; stream: false → false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const r1 = await applyRules(makeCtx({}), [baseRule], snap);
    expect((r1.ctx.body as Record<string, unknown>).stream).toBe(true);
    await registerRule();
    const snap2 = snapshot("body");
    const r2 = await applyRules(makeCtx({ stream: false }), [baseRule], snap2);
    expect((r2.ctx.body as Record<string, unknown>).stream).toBe(false);
  });

  test("ctx.body is null → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx(null), [baseRule], snap);
    expect(result.applied).toEqual([]);
  });

  test("ctx.body is array → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx([]), [baseRule], snap);
    expect(result.applied).toEqual([]);
  });

  test("model field is preserved verbatim (rename is M6's job, not ours)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-opus-4.7", messages: [] };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.model).toBe("claude-opus-4.7");
  });
});
