/**
 * translate_responses_to_chat_completions.test.ts — per-rule unit
 * tests for `translate_responses_to_chat_completions` (M16).
 *
 * Lane covered: **Codex → GPT-4 defensive** (Lane 6 per
 * config/default.yaml) — `POST /responses` × `^gpt-4`.
 *
 * **NEW translator — designed from first principles per D45 + D44.**
 * No production cribbing reference exists (verified at session start by
 * grep + handler read of `dist/main.js:2477 handleResponseEndpoint`).
 * These tests verify the per-field shape rules from M16 spec R2/R3/R4
 * directly against the M16 spec, NOT a captured-fixture round-trip.
 * Real captured-fixture parity for this lane lands in a future
 * integration replay milestone.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/translate_responses_to_chat_completions";
import { TranslateResponsesToChatCompletionsSchema } from "~/lib/transform/translate_responses_to_chat_completions";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod =
    await import("~/lib/transform/translate_responses_to_chat_completions");
  const { register } = await import("~/lib/transform/registry");
  register(
    "translate_responses_to_chat_completions",
    mod.translate_responses_to_chat_completions,
    mod.TranslateResponsesToChatCompletionsSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

function makeCtx(body: unknown, model = "gpt-4o-mini"): TransformContext {
  return {
    body,
    headers: {},
    route: "/responses",
    model,
  };
}

const baseRule: Rule = {
  name: "t",
  use: "translate_responses_to_chat_completions",
};

// ---------------------------------------------------------------------------
// Schema validation block
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — schema validation", () => {
  test("minimal valid config", () => {
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "translate_responses_to_chat_completions",
    });
    expect(r.success).toBe(true);
  });

  test("all 4 on_error values accepted", () => {
    for (const oe of [
      "continue",
      "continue_passthrough",
      "abort_with_500",
      "abort_with_502",
    ]) {
      const r = TranslateResponsesToChatCompletionsSchema.safeParse({
        name: "x",
        use: "translate_responses_to_chat_completions",
        on_error: oe,
      });
      expect(r.success).toBe(true);
    }
  });

  test("default_max_tokens must be positive int (zero rejected)", () => {
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "translate_responses_to_chat_completions",
      default_max_tokens: 0,
    });
    expect(r.success).toBe(false);
  });

  test("default_max_tokens must be positive int (negative rejected)", () => {
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "translate_responses_to_chat_completions",
      default_max_tokens: -100,
    });
    expect(r.success).toBe(false);
  });

  test("drop_reasoning accepts boolean", () => {
    for (const v of [true, false]) {
      const r = TranslateResponsesToChatCompletionsSchema.safeParse({
        name: "x",
        use: "translate_responses_to_chat_completions",
        drop_reasoning: v,
      });
      expect(r.success).toBe(true);
    }
  });

  test("invalid use literal rejected", () => {
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });

  test("extra fields permitted via passthrough", () => {
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "translate_responses_to_chat_completions",
      future_field: "anything",
    });
    expect(r.success).toBe(true);
  });

  test("drop_reasoning omission yields parsed undefined (no zod default)", () => {
    // Per R6 + MEDIUM-C iter-2: schema has NO `.default(true)` for
    // drop_reasoning. Default-true semantics live in body code via
    // `opts.drop_reasoning !== false`. This test pins that the schema
    // genuinely treats the field as optional.
    const r = TranslateResponsesToChatCompletionsSchema.safeParse({
      name: "x",
      use: "translate_responses_to_chat_completions",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.drop_reasoning).toBe(undefined);
      expect(r.data.drop_previous_response_id).toBe(undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior — instructions
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — instructions", () => {
  test("string instructions → leading system message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      instructions: "You are helpful.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("missing instructions → no system message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  test("empty-array instructions → no system message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      instructions: [],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  test("instructions AND developer-role item → instructions first, developer second", async () => {
    // Per R2.1 conflict resolution (M-3 iter-1): emit instructions-derived
    // system message FIRST (index 0), then walk input[] in document order
    // — the developer-role becomes a SECOND system message.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      instructions: "Top-level instructions.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Inline developer message." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "Top-level instructions.",
    });
    expect(messages[1]).toEqual({
      role: "system",
      content: "Inline developer message.",
    });
    expect(messages[2]?.role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Behavior — basic message conversion
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — basic messages", () => {
  test("simple user text item → user Chat message with string content", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
  });

  test("assistant text item (output_text) → assistant Chat message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "the answer is 42" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "the answer is 42",
    });
  });

  test("mixed text + image content → array-form Chat content with image_url block", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe this image:" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "describe this image:" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  test("input_image with object-shaped image_url extracts url", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look:" },
            {
              type: "input_image",
              image_url: { url: "https://example.com/x.png" },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/x.png" },
    });
  });

  test("developer-role item → system-role Chat message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "be terse" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  test("system-role item passes through as system Chat message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "be helpful" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be helpful" });
  });

  test("unknown content part type → JSON-stringified text block (per D9)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "valid" },
            { type: "future_audio_v999", payload: { foo: "bar" } },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "valid" });
    expect(content[1]?.type).toBe("text");
    expect(content[1]?.text).toContain("future_audio_v999");
  });

  test("string content on a message item passes through directly", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: "plain string content",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "user",
      content: "plain string content",
    });
  });
});

// ---------------------------------------------------------------------------
// Behavior — function_call (tool_use)
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — function_call (tool_use)", () => {
  test("single function_call → assistant message with one tool_call", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          id: "fc_internal_id",
          call_id: "call_abc123",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        },
      ],
    });
  });

  test("function_call uses call_id (not id) for tool_calls[].id", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          id: "fc_INTERNAL_BOOKKEEPING",
          call_id: "call_THE_CORRECT_ID",
          name: "tool",
          arguments: "{}",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.id).toBe("call_THE_CORRECT_ID");
  });

  test("parallel function_calls (consecutive items) → ONE assistant message with N tool_calls", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_A",
          name: "tool_A",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "call_B",
          name: "tool_B",
          arguments: '{"x":1}',
        },
        {
          type: "function_call",
          call_id: "call_C",
          name: "tool_C",
          arguments: "{}",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("assistant");
    const toolCalls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls.length).toBe(3);
    expect(toolCalls[0]?.id).toBe("call_A");
    expect(toolCalls[1]?.id).toBe("call_B");
    expect(toolCalls[2]?.id).toBe("call_C");
  });

  test("function_call with object arguments → JSON-stringified arguments string", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_x",
          name: "tool",
          arguments: { nested: { key: "value" }, n: 42 },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]?.function as Record<string, unknown>;
    expect(typeof fn.arguments).toBe("string");
    expect(fn.arguments).toBe('{"nested":{"key":"value"},"n":42}');
  });

  test("function_call with missing arguments → '{}' string", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_x",
          name: "tool",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]?.function as Record<string, unknown>;
    expect(fn.arguments).toBe("{}");
  });

  test("function_call interleaved with other items → coalescing breaks at non-function_call", async () => {
    // R2.4 / M-7 iter-1: STRICTLY POSITIONAL. `[fc X, fco X, fc Y]` →
    // three separate Chat messages, NOT a coalesced two-tool-call run.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_X",
          name: "tool_X",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_X",
          output: "result X",
        },
        {
          type: "function_call",
          call_id: "call_Y",
          name: "tool_Y",
          arguments: "{}",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(3);
    expect(messages[0]?.role).toBe("assistant");
    const tc0 = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    expect(tc0.length).toBe(1);
    expect(tc0[0]?.id).toBe("call_X");
    expect(messages[1]?.role).toBe("tool");
    expect(messages[1]?.tool_call_id).toBe("call_X");
    expect(messages[2]?.role).toBe("assistant");
    const tc2 = messages[2]?.tool_calls as Array<Record<string, unknown>>;
    expect(tc2.length).toBe(1);
    expect(tc2[0]?.id).toBe("call_Y");
  });

  test("function_call interleaved with assistant text → separate messages", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Calling tool A:" }],
        },
        {
          type: "function_call",
          call_id: "call_A",
          name: "tool_A",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "call_B",
          name: "tool_B",
          arguments: "{}",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(3);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "Calling tool A:",
    });
    // Two consecutive function_calls coalesce.
    expect(messages[1]?.role).toBe("assistant");
    const tc = messages[1]?.tool_calls as Array<Record<string, unknown>>;
    expect(tc.length).toBe(2);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "Done.",
    });
  });
});

// ---------------------------------------------------------------------------
// Behavior — function_call_output (tool_result)
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — function_call_output", () => {
  test("single function_call_output → tool-role Chat message with tool_call_id", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_abc123",
          output: "Sunny, 72F",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_abc123",
      content: "Sunny, 72F",
    });
  });

  test("non-string output → JSON-stringified content", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_x",
          output: { data: [1, 2, 3] },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe('{"data":[1,2,3]}');
  });

  test("null output → empty string (NOT 'null' literal per R2.5 / M-4 iter-1)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_x",
          output: null,
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("");
  });

  test("undefined/missing output → empty string", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_x",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("");
  });

  test("multiple function_call_outputs → multiple tool messages preserved in order", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_A",
          output: "result A",
        },
        {
          type: "function_call_output",
          call_id: "call_B",
          output: "result B",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_A",
      content: "result A",
    });
    expect(messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_B",
      content: "result B",
    });
  });

  test("out-of-order function_call_output before its function_call → emitted in document order (no reordering)", async () => {
    // R5 / M-2 iter-1: don't silently fix client bugs (D9).
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_X",
          output: "ahead-of-time result",
        },
        {
          type: "function_call",
          call_id: "call_X",
          name: "tool_X",
          arguments: "{}",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    // Output FIRST (document order preserved); upstream rejects the
    // malformed sequence — that's correct D9 behavior.
    expect(messages[0]?.role).toBe("tool");
    expect(messages[1]?.role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// Behavior — reasoning items
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — reasoning items", () => {
  test("default drop_reasoning: true → reasoning item dropped from output", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Q" }],
        },
        { type: "reasoning", summary: [{ text: "thinking..." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "A" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    // Reasoning is dropped — only user + assistant remain.
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
  });

  test("reasoning items still dropped when drop_reasoning: false (executor's choice per file header R2.6)", async () => {
    // Per R2.6 + file header documentation: even with drop_reasoning:false,
    // reasoning items remain dropped — Chat has no place for them, and
    // emitting as system messages could confuse the model. Documented
    // executor's choice; this test pins the documented behavior.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        { type: "reasoning", summary: [{ text: "thinking..." }] },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(
      makeCtx(body),
      [{ ...baseRule, drop_reasoning: false }],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  test("reasoning visible in `before` snapshot (D9 — drop is traceable)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [{ type: "reasoning", summary: "x" }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    expect(result.applied.length).toBe(1);
    const before = result.applied[0]?.before as Record<string, unknown>;
    const beforeInput = before.input as Array<Record<string, unknown>>;
    expect(beforeInput[0]?.type).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// Behavior — tool definitions
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — tool definitions", () => {
  test("function tool → Chat function shape with nested function:{...}", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  test("function tool with strict field → strict dropped (per R3)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        {
          type: "function",
          name: "x",
          description: "y",
          parameters: { type: "object" },
          strict: true,
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const tools = out.tools as Array<Record<string, unknown>>;
    const fn = tools[0]?.function as Record<string, unknown>;
    expect("strict" in fn).toBe(false);
  });

  test("empty tools[] → tools field omitted from output", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { tools: [] };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("tools" in out).toBe(false);
  });

  test("web_search tool DROPPED with snapshot visibility", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        { type: "web_search", search_context_size: "medium" },
        {
          type: "function",
          name: "x",
          description: "y",
          parameters: {},
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]?.type).toBe("function");
    // Snapshot visibility: original web_search is in `before`.
    const before = result.applied[0]?.before as Record<string, unknown>;
    const beforeTools = before.tools as Array<Record<string, unknown>>;
    expect(beforeTools.find((t) => t.type === "web_search")).toBeDefined();
  });

  test("unknown tool type DROPPED", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tools: [
        { type: "code_interpreter" },
        { type: "file_search" },
        { type: "image_generation" },
        { type: "mcp", name: "..." },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("tools" in out).toBe(false);
  });

  test("tool_choice 'auto' / 'required' / 'none' passthrough", async () => {
    for (const tc of ["auto", "required", "none"]) {
      await registerRule();
      const snap = snapshot("body");
      const body = { tool_choice: tc };
      const result = await applyRules(makeCtx(body), [baseRule], snap);
      const out = result.ctx.body as Record<string, unknown>;
      expect(out.tool_choice).toBe(tc);
    }
  });

  test("tool_choice {type:'function', name:'x'} → wrapped Chat shape", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      tool_choice: { type: "function", name: "get_weather" },
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });
});

// ---------------------------------------------------------------------------
// Behavior — top-level fields
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — top-level fields", () => {
  test("max_output_tokens → max_tokens (renamed, value preserved)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { max_output_tokens: 32000 };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_tokens).toBe(32000);
    expect("max_output_tokens" in out).toBe(false);
  });

  test("missing max_output_tokens uses opts.default_max_tokens", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {};
    const result = await applyRules(
      makeCtx(body),
      [{ ...baseRule, default_max_tokens: 8192 }],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_tokens).toBe(8192);
  });

  test("missing max_output_tokens AND no opts default → fallback 4096", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_tokens).toBe(4096);
  });

  test("stream omitted in source → stream omitted in output (M16.5 M-1: OpenAI default false)", async () => {
    // Per M16.5 M-1 (post-exec discriminator iter-1): the translator
    // no longer auto-defaults `stream: true` when the source body
    // omits the field. OpenAI Chat Completions documents `stream:
    // false` as the default; preserving client intent (i.e., omitting
    // when the client omitted) is the correct behavior. See additional
    // M-1 coverage in the dedicated M16.5 describe block below.
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("stream" in out).toBe(false);
  });

  test("stream:false preserved", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ stream: false }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.stream).toBe(false);
  });

  test("reasoning field dropped from top level", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      reasoning: { effort: "high", summary: "detailed" },
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("reasoning" in out).toBe(false);
  });

  test("previous_response_id dropped by default", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { previous_response_id: "resp_xxx" };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("previous_response_id" in out).toBe(false);
  });

  test("previous_response_id preserved when drop_previous_response_id:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { previous_response_id: "resp_xxx" };
    const result = await applyRules(
      makeCtx(body),
      [{ ...baseRule, drop_previous_response_id: false }],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.previous_response_id).toBe("resp_xxx");
  });

  test("store/truncation/text/include all dropped", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      store: false,
      truncation: "disabled",
      text: { something: true },
      include: ["x", "y"],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("store" in out).toBe(false);
    expect("truncation" in out).toBe(false);
    expect("text" in out).toBe(false);
    expect("include" in out).toBe(false);
  });

  test("unknown top-level field dropped (D9 defensive whitelist)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      unknown_future_field: "anything",
      another_one: { nested: true },
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("unknown_future_field" in out).toBe(false);
    expect("another_one" in out).toBe(false);
  });

  test("temperature / top_p / n / seed / parallel_tool_calls / response_format / metadata / top_logprobs all passthrough", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      temperature: 0.7,
      top_p: 0.95,
      n: 2,
      seed: 42,
      parallel_tool_calls: true,
      response_format: { type: "json_object" },
      metadata: { user: "abc" },
      top_logprobs: 5,
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBe(0.95);
    expect(out.n).toBe(2);
    expect(out.seed).toBe(42);
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.metadata).toEqual({ user: "abc" });
    expect(out.top_logprobs).toBe(5);
  });

  test("model field is preserved verbatim", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "gpt-4o-mini" };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.model).toBe("gpt-4o-mini");
  });
});

// ---------------------------------------------------------------------------
// Behavior — edge cases / negatives
// ---------------------------------------------------------------------------

describe("translate_responses_to_chat_completions — edge cases", () => {
  test("ctx.body null → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx(null), [baseRule], snap);
    expect(result.applied).toEqual([]);
  });

  test("ctx.body array → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx([]), [baseRule], snap);
    expect(result.applied).toEqual([]);
  });

  test("ctx.body missing input AND instructions → empty messages, applied: true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    expect(result.applied.length).toBe(1);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([]);
  });

  test("empty input:[] → empty messages, applied: true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    expect(result.applied.length).toBe(1);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([]);
  });

  test("src.input is a STRING (Responses shorthand) → wrapped as single user message (R5 / M-1 iter-1)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { input: "hello world" };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ role: "user", content: "hello world" });
  });

  test("unknown item type → JSON-stringified into a user message (R2.7)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [{ type: "web_search_call", query: "anything" }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as string;
    expect(typeof content).toBe("string");
    expect(content).toContain("web_search_call");
    expect(content).toContain("[unmapped responses item:");
  });

  test("mutate-in-place: src body's keys are replaced (delete + Object.assign)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body: Record<string, unknown> = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "x" }],
        },
      ],
      // Pre-existing field that should NOT survive the translation.
      previous_response_id: "resp_xxx",
    };
    const ctx = makeCtx(body);
    const sameRef = ctx.body;
    await applyRules(ctx, [baseRule], snap);
    // Same object reference — mutate-in-place semantics.
    expect(ctx.body).toBe(sameRef);
    // previous_response_id was DROPPED (default), confirming keys are
    // REPLACED (not merged).
    expect(
      "previous_response_id" in (ctx.body as Record<string, unknown>),
    ).toBe(false);
    expect("messages" in (ctx.body as Record<string, unknown>)).toBe(true);
  });
});

// Regression coverage for no-type messages, explicit stream defaults and
// missing image sources. Assertions inspect translated requests, not merely
// successful upstream responses.

describe("translate_responses_to_chat_completions — M16.5 H-1 (no-type message normalization)", () => {
  test("canonical no-type user item (with role + content) → user Chat message with correct content", async () => {
    // Per OpenAI Responses spec: `type` is OPTIONAL on input[] items;
    // when omitted but `role` + `content` are present, default is
    // `type: "message"`. Pre-fix: this fell through to the unmapped
    // branch and was JSON-stringified (F36 test-masking).
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      input: [
        {
          // NOTE: no `type` field — this is the canonical OpenAI
          // Responses shorthand sent by real Codex CLI clients.
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
    // Critical: must NOT be the unmapped fallback.
    expect(JSON.stringify(messages[0])).not.toContain("unmapped");
  });

  test("canonical no-type assistant item → assistant Chat message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "the answer is 42" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "the answer is 42",
    });
  });

  test("canonical no-type developer-role item → system Chat message", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "be terse" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  test("REGRESSION (M16.5 H-1): canonical Lane 6 e2e request body shape produces correct chat user message", async () => {
    // This is the structural defense against F36-class test-masking
    // recommended by the post-exec discriminator. Feeds the exact
    // request body that the Lane 6 e2e sends (no top-level `type` on
    // the input item — what real Codex CLI clients send) through the
    // translator and asserts the OUTPUT (not the upstream response).
    //
    // Pre-fix: this test would FAIL because messages[0].content would
    // be `"[unmapped responses item: {...}]"` rather than `"hi"`. The
    // Lane 6 e2e was passing only because gpt-4o-mini happens to reply
    // coherently to the corrupted marker prompt.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      input: [
        {
          // NO `type` — exactly what the Lane 6 e2e sends.
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages).toBeDefined();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe("user");
    // Content can be a string OR an array of content parts; handle both.
    const content = messages[0]?.content;
    const userText =
      typeof content === "string"
        ? content
        : Array.isArray(content) &&
            content[0] !== undefined &&
            typeof (content[0] as { text?: unknown }).text === "string"
          ? (content[0] as { text: string }).text
          : "";
    expect(userText).toBe("hi");
    expect(userText).not.toContain("unmapped responses item");
  });

  test("no-type item WITHOUT role/content → still falls through to unmapped (function_call / function_call_output / reasoning need explicit type)", async () => {
    // Per spec caveat: only the {role, content} shape gets the implicit
    // type:"message" default. A no-type item that LOOKS like a
    // function_call (has name + arguments but missing type) is
    // genuinely malformed input per spec — it goes to D9 fallback.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        // No type, no role, no content — pure unknown shape.
        { name: "tool_x", arguments: "{}", call_id: "call_x" },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content as string).toContain(
      "[unmapped responses item:",
    );
  });
});

describe("translate_responses_to_chat_completions — M16.5 M-1 (stream default semantics)", () => {
  test("omitted stream → output omits stream field (NOT stream:true)", async () => {
    // Per M16.5 M-1: OpenAI Chat Completions defaults `stream: false`
    // when absent. The translator should preserve client intent and
    // NOT inject any default. Pre-fix: M16 inherited M7a's
    // `src.stream !== false` pattern → auto-set `stream: true`.
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("stream" in out).toBe(false);
  });

  test("explicit stream:true → output has stream:true (passthrough)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ stream: true }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.stream).toBe(true);
  });

  test("explicit stream:false → output has stream:false (passthrough)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ stream: false }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.stream).toBe(false);
  });
});

describe("translate_responses_to_chat_completions — M16.5 M-2 (input_image validation)", () => {
  test("input_image with image_url string (data URL) → image_url with that URL", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look:" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  test("input_image with image_url object containing url → image_url with that URL", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look:" },
            {
              type: "input_image",
              image_url: { url: "https://example.com/x.png" },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/x.png" },
    });
  });

  test("input_image with file_id only (no URL) → falls through to D9 text JSON fallback (NOT empty image_url)", async () => {
    // Per M16.5 M-2: file_id has no Chat Completions equivalent;
    // emit as text JSON so the trace surfaces the dropped reference.
    // Pre-fix: emitted invalid `{type:"image_url", image_url:{url:""}}`.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "see:" },
            { type: "input_image", file_id: "file-abc123" },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]?.type).toBe("text");
    const text = content[1]?.text as string;
    expect(text).toContain("file-abc123");
    expect(text).toContain("input_image");
    // Critical: must NOT have produced an empty/invalid image_url.
    expect(content[1]?.type).not.toBe("image_url");
  });

  test("input_image with no source fields → falls through to D9 text JSON fallback (NOT empty image_url)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "see:" },
            { type: "input_image" },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]?.type).toBe("text");
    expect(content[1]?.type).not.toBe("image_url");
    // Body of the text part contains the JSON-stringified original.
    const text = content[1]?.text as string;
    expect(text).toContain("input_image");
  });

  test("input_image with `data` + `media_type` → image_url with data URL (M16.5.1 N-3)", async () => {
    // Per M16.5.1 N-3 + M16.5 spec R3: when a Responses input_image
    // carries inline base64 `data` + explicit `media_type`, the
    // translator must synthesize a Chat data URL of the form
    // `data:<mediatype>;base64,<data>` as the FIRST priority (before
    // image_url string/object handling). Pre-M16.5.1: this branch was
    // missing, so well-formed base64 inline images fell through to the
    // text-JSON fallback (M-2 path) and corrupted the request.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "see:" },
            {
              type: "input_image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
              media_type: "image/png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      },
    });
  });

  test("M16.5.3 D-2: empty inline data + valid image_url → URL fallback wins (not malformed data URL)", async () => {
    // Per M16.5.3 D-2 (post-exec discriminator iter-4): same pattern as
    // sibling translator's D-1; empty-string inline carriers used to
    // short-circuit to a malformed `data:;base64,` URL. The tightened
    // guard now rejects empty inline carriers; the URL string branch
    // fires.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              data: "",
              media_type: "",
              image_url: "https://example.com/dog.png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    const block = content[0] as {
      type: string;
      image_url?: { url: string };
    };
    expect(block.type).toBe("image_url");
    expect(block.image_url?.url).toBe("https://example.com/dog.png");
    // Critical: must NOT emit malformed empty data URL.
    expect(JSON.stringify(block)).not.toContain("data:;base64,");
    expect(JSON.stringify(block)).not.toContain('"url":"data:;');
  });

  test("M16.5.4 D-3: empty image_url + valid legacy url → URL fallback wins (not text fallback)", async () => {
    // Per M16.5.4 D-3 (post-exec discriminator iter-5): pre-fix, the
    // chat-side URL cascade used a single shared `url` variable that
    // first-matching-branch-assigns-even-if-empty, blocking subsequent
    // fallbacks. Mirroring the sibling Anthropic translator's per-priority
    // `length > 0` pattern (introduced M16.5.2 N-5): empty `image_url`
    // now correctly falls through to the legacy `url` field, which
    // contains a valid URL. Cross-translator URL-cascade symmetry.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "",
              url: "https://example.com/legacy.png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    const block = content[0] as {
      type: string;
      image_url?: { url: string };
    };
    expect(block.type).toBe("image_url");
    expect(block.image_url?.url).toBe("https://example.com/legacy.png");
    // Critical: must NOT fall through to text fallback when a valid URL
    // is available in any priority slot.
    expect(JSON.stringify(block)).not.toContain('"type":"text"');
  });
});

// Only string/array content identifies a no-type message. Malformed content
// must use the visible fallback rather than silently discarding sibling fields.

describe("translate_responses_to_chat_completions — M16.5.1 N-1 (predicate tightening)", () => {
  test("{role:'user', content: null} → unmapped fallback (NOT blank message)", async () => {
    // Per M16.5.1 N-1: `content: null` is malformed input per OpenAI
    // Responses spec; the predicate must reject it. Pre-fix: this
    // produced `{role:"user", content:""}` (blank message) and
    // silently dropped any sibling fields. Post-fix: falls through to
    // the D9 unmapped-text path so the trace surfaces the malformed
    // input.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          role: "user",
          content: null,
          // Sibling fields that the pre-fix would silently drop.
          call_id: "call_x",
          name: "tool",
          arguments: "{}",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as string;
    expect(typeof content).toBe("string");
    expect(content).toContain("[unmapped responses item:");
    // Critical: the sibling fields are surfaced in the JSON dump
    // (NOT silently dropped).
    expect(content).toContain("call_x");
  });

  test("{role:'user', content: 42} → unmapped fallback (number content rejected)", async () => {
    // Per M16.5.1 N-1: `content` must be string OR array. A number is
    // malformed; falls through to the D9 unmapped path.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          role: "user",
          content: 42,
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as string;
    expect(content).toContain("[unmapped responses item:");
  });

  test("function-call-shape WITHOUT type AND WITHOUT role → unmapped fallback", async () => {
    // Per M16.5.1 N-1: the H-1 predicate REQUIRES `role` to normalize
    // to type:"message". A no-type item that LOOKS like a function_call
    // (call_id + name + arguments but no role + no type) is malformed
    // input per the OpenAI Responses spec — function_call items MUST
    // carry an explicit `type` field. Pre-fix: this confirms the
    // predicate's `role` requirement correctly rejects malformed
    // function-call shapes.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        // No type, no role, no content — looks like a function_call but
        // missing the required `type: "function_call"`.
        { call_id: "call_x", name: "tool", arguments: "{}" },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as string;
    expect(content).toContain("[unmapped responses item:");
    expect(content).toContain("call_x");
    expect(content).toContain("tool");
  });
});
