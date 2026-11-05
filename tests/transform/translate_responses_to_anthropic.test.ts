/**
 * Responses-to-Anthropic body translation tests. All fixture content is
 * synthetic and available in this repository; no external capture is needed.
 * Tool argument streaming is covered separately by event-translator tests.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/translate_responses_to_anthropic";
import { TranslateResponsesToAnthropicSchema } from "~/lib/transform/translate_responses_to_anthropic";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/translate_responses_to_anthropic");
  const { register } = await import("~/lib/transform/registry");
  register(
    "translate_responses_to_anthropic",
    mod.translate_responses_to_anthropic,
    mod.TranslateResponsesToAnthropicSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

function makeCtx(body: unknown, model = "claude-opus-4.7"): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/responses",
    model,
  };
}

const baseRule: Rule = {
  name: "t",
  use: "translate_responses_to_anthropic",
};

describe("translate_responses_to_anthropic — schema validation", () => {
  test("minimal valid config", () => {
    const r = TranslateResponsesToAnthropicSchema.safeParse({
      name: "x",
      use: "translate_responses_to_anthropic",
    });
    expect(r.success).toBe(true);
  });

  test("all opts valid together", () => {
    const r = TranslateResponsesToAnthropicSchema.safeParse({
      name: "x",
      use: "translate_responses_to_anthropic",
      default_max_tokens: 16000,
      default_effort: "low",
      emit_thinking: false,
      cache_control_last_system: false,
    });
    expect(r.success).toBe(true);
  });

  test("invalid effort rejected", () => {
    const r = TranslateResponsesToAnthropicSchema.safeParse({
      name: "x",
      use: "translate_responses_to_anthropic",
      default_effort: "extreme",
    });
    expect(r.success).toBe(false);
  });
});

describe("translate_responses_to_anthropic — behavior (per-field shape)", () => {
  test("(a) basic input message conversion", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-opus-4.7",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    expect(result.applied).toHaveLength(1);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("(b) developer-role message → system[] entries", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "system block A" },
            { type: "input_text", text: "system block B" },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.system).toEqual([
      { type: "text", text: "system block A" },
      // last block gets cache_control by default
      {
        type: "text",
        text: "system block B",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("(b) system-role message also routed to system[]", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "system",
          content: "you are helpful",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.system).toEqual([
      {
        type: "text",
        text: "you are helpful",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("(c) function_call → assistant tool_use block", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          id: "fc_abc",
          call_id: "toolu_call_xyz",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_call_xyz",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
    ]);
  });

  test("(c) function_call with empty arguments string → input: {}", async () => {
    // Note: this is the BODY-translator behavior. The SSE-side empty-args
    // bug (F26) is a separate concern in M7b's stream translator.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "toolu_x",
          name: "ping",
          arguments: "",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const msg = (out.messages as Array<Record<string, unknown>>)[0];
    const tu = (msg?.content as Array<Record<string, unknown>>)[0];
    expect(tu?.input).toEqual({});
  });

  test("(c) function_call with malformed JSON arguments → input: {}", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "toolu_x",
          name: "ping",
          arguments: "{not_json",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const msg = (out.messages as Array<Record<string, unknown>>)[0];
    const tu = (msg?.content as Array<Record<string, unknown>>)[0];
    expect(tu?.input).toEqual({});
  });

  test("(c) function_call_output → user tool_result block", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "toolu_call_xyz",
          output: "65 F, sunny",
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_call_xyz",
            content: "65 F, sunny",
          },
        ],
      },
    ]);
  });

  test("(c) function_call_output with object output → JSON-stringified", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "toolu_x",
          output: { result: 42, ok: true },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const msg = (out.messages as Array<Record<string, unknown>>)[0];
    const tr = (msg?.content as Array<Record<string, unknown>>)[0];
    expect(tr?.content).toBe('{"result":42,"ok":true}');
  });

  test("(d) reasoning.effort preserved when present", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [],
      reasoning: { effort: "high" },
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.output_config).toEqual({ effort: "high" });
  });

  test("(d) reasoning.effort missing → default 'medium' (or opt override)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  test("(d) effort 'none' → output_config NOT emitted", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { input: [], reasoning: { effort: "none" } };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect("output_config" in out).toBe(false);
  });

  test("(e) cache_control auto-added to LAST system block by default", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "A" },
            { type: "input_text", text: "B" },
            { type: "input_text", text: "C" },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0]?.cache_control).toBeUndefined();
    expect(sys[1]?.cache_control).toBeUndefined();
    expect(sys[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("(e) cache_control_last_system: false → NO marker added", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "A" }],
        },
      ],
    };
    const rule = { ...baseRule, cache_control_last_system: false };
    const result = await applyRules(makeCtx(body), [rule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0]?.cache_control).toBeUndefined();
  });

  test("(f) max_output_tokens → max_tokens (renamed)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { input: [], max_output_tokens: 8000 };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.max_tokens).toBe(8000);
    expect("max_output_tokens" in out).toBe(false);
  });

  test("(f) missing max_output_tokens → default_max_tokens, else 32000", async () => {
    await registerRule();
    const snap = snapshot("body");
    const r1 = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    expect((r1.ctx.body as Record<string, unknown>).max_tokens).toBe(32000);
    await registerRule();
    const snap2 = snapshot("body");
    const r2 = await applyRules(
      makeCtx({ input: [] }),
      [{ ...baseRule, default_max_tokens: 4096 }],
      snap2,
    );
    expect((r2.ctx.body as Record<string, unknown>).max_tokens).toBe(4096);
  });

  test("tools: function-shape preserved with input_schema; non-function STRIPPED (per F25)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [],
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run shell",
          parameters: { type: "object" },
        },
        // Codex emits this — must be stripped (would 400 from Anthropic).
        { type: "web_search", external_web_access: false },
        {
          type: "function",
          name: "ping",
          description: "ping",
          parameters: { type: "object" },
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.tools).toEqual([
      {
        name: "shell",
        description: "Run shell",
        input_schema: { type: "object" },
      },
      {
        name: "ping",
        description: "ping",
        input_schema: { type: "object" },
      },
    ]);
  });

  test("tools: function with no parameters → input_schema: {}", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [],
      tools: [{ type: "function", name: "noop", description: "no args" }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect((out.tools as Array<Record<string, unknown>>)[0]).toEqual({
      name: "noop",
      description: "no args",
      input_schema: {},
    });
  });

  test("tools: empty tools[] → tools field NOT emitted", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx({ input: [], tools: [] }),
      [baseRule],
      snap,
    );
    const out = result.ctx.body as Record<string, unknown>;
    expect("tools" in out).toBe(false);
  });

  test("(g) thinking: emitted by default; suppressed via emit_thinking: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const r1 = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    expect((r1.ctx.body as Record<string, unknown>).thinking).toEqual({
      type: "adaptive",
    });
    await registerRule();
    const snap2 = snapshot("body");
    const r2 = await applyRules(
      makeCtx({ input: [] }),
      [{ ...baseRule, emit_thinking: false }],
      snap2,
    );
    expect("thinking" in (r2.ctx.body as Record<string, unknown>)).toBe(false);
  });

  test("input_image content part → Anthropic image block with source.url", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/img.png" },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const msg = (out.messages as Array<Record<string, unknown>>)[0];
    const block = (msg?.content as Array<Record<string, unknown>>)[0];
    expect(block).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    });
  });

  test("(h) consecutive same-role messages MERGED into one (Anthropic alternation requirement)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "A" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "B" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    ]);
  });

  test("(h) function_call followed by tool_result MERGED (assistant then user — different roles, NOT merged)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "tu1",
          name: "ping",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "tu1", output: "pong" },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toHaveLength(2);
    expect((out.messages as Array<Record<string, unknown>>)[0]?.role).toBe(
      "assistant",
    );
    expect((out.messages as Array<Record<string, unknown>>)[1]?.role).toBe(
      "user",
    );
  });

  test("(i) empty input[] → empty messages[], no system, no tools", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([]);
    expect("system" in out).toBe(false);
  });

  test("(i) absent input → empty messages[]", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx({}), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.messages).toEqual([]);
  });

  test("(j) unknown input item type → preserved as user text block (per D9)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [{ type: "future_item_v999", payload: { foo: "bar" } }],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const msg = (out.messages as Array<Record<string, unknown>>)[0];
    expect(msg?.role).toBe("user");
    const content = (msg?.content as Array<Record<string, unknown>>)[0];
    expect(content?.type).toBe("text");
    expect(content?.text).toContain("future_item_v999");
  });

  test("instructions field at top level is IGNORED (mirrors bundle)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      instructions:
        "this should be dropped by the body translator since the bundle ignores it",
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
    // instructions should NOT appear anywhere in the output payload.
    expect(JSON.stringify(out)).not.toContain("this should be dropped");
  });

  test("model field preserved verbatim", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-test", input: [] };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    expect(out.model).toBe("claude-test");
  });

  test("stream default: absent → true; stream: false → false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const r1 = await applyRules(makeCtx({ input: [] }), [baseRule], snap);
    expect((r1.ctx.body as Record<string, unknown>).stream).toBe(true);
    await registerRule();
    const snap2 = snapshot("body");
    const r2 = await applyRules(
      makeCtx({ input: [], stream: false }),
      [baseRule],
      snap2,
    );
    expect((r2.ctx.body as Record<string, unknown>).stream).toBe(false);
  });

  test("ctx.body is null → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(makeCtx(null), [baseRule], snap);
    expect(result.applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M16.5.1 N-2 — no-type message normalization on sibling translator
// ---------------------------------------------------------------------------
//
// Message items may omit `type` when role and string/array content identify
// them. Malformed content and untyped tool calls must retain their fallback.

describe("translate_responses_to_anthropic — M16.5.1 N-2 (no-type message normalization)", () => {
  test("canonical no-type user item (with role + content) → user message in Anthropic output", async () => {
    // Per OpenAI Responses spec: `type` is OPTIONAL on input[] items;
    // when omitted but `role` + `content` are present, default is
    // `type: "message"`. Pre-fix: this fell through to the unmapped
    // branch (`else`) and was JSON-stringified into a user `[text]`
    // block — silently corrupting Lane 5 (Codex→Claude) requests.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          // NO `type` — the canonical shorthand sent by real Codex CLI.
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    // Critical: must NOT be the unmapped fallback (which would have a
    // text block whose content includes JSON-stringified item).
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    const firstBlock = content[0] as Record<string, unknown>;
    expect(firstBlock?.text).toBe("hi");
    expect(firstBlock?.text as string).not.toContain('"role"');
  });

  test("canonical no-type assistant item → assistant message in Anthropic output", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          // NO `type` — canonical shorthand.
          role: "assistant",
          content: [{ type: "output_text", text: "the answer is 42" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("assistant");
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "the answer is 42" });
  });

  test("{role:'user', content: null} → unmapped fallback (over-promotion negative)", async () => {
    // Per M16.5.1 N-1 tightened predicate: `content` must be string OR
    // array. `null` is malformed; falls through to the D9 unmapped path
    // (the `else` branch) — emitted as a user `[text: <json-dump>]`
    // block so the trace surfaces the malformed input.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      input: [
        {
          role: "user",
          content: null,
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
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("text");
    const text = content[0]?.text as string;
    // Critical: malformed item is JSON-dumped into the text block (NOT
    // silently turned into a blank user message that drops sibling
    // fields). The dump preserves `call_id` for trace visibility.
    expect(text).toContain("call_x");
  });

  test("REGRESSION (M16.5.1 N-2): canonical Lane 5 e2e request body shape produces real assistant content", async () => {
    // Structural defense against F36-class test-masking on Lane 5
    // (Codex → Claude). This mirrors the Lane 5 e2e's canonical request
    // body shape — no top-level `type` on the input item — and asserts
    // the OUTPUT (not the upstream response).
    //
    // Pre-fix: messages[0].content[0] would be a `text` block whose
    // text is `{"role":"user","content":[{"type":"input_text",...}]}`
    // (JSON dump of the malformed-looking item). The Lane 5 e2e was
    // passing the structural assertions only because the upstream
    // happens to reply coherently to the corrupted prompt — same
    // F36 pattern.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          // NO `type` — exactly what the Lane 5 e2e sends.
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages).toBeDefined();
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({ type: "text", text: "hi" });
    // Critical: must NOT be the unmapped fallback dump.
    const firstText = content[0]?.text as string;
    expect(firstText).toBe("hi");
    expect(firstText).not.toContain('"role"');
    expect(firstText).not.toContain("input_text");
  });
});

// ---------------------------------------------------------------------------
// M16.5.2 N-5 — image-content normalization on sibling translator
// ---------------------------------------------------------------------------
//
// Image normalization must support inline data, object-form URLs and a
// visible text fallback when no usable source is supplied.
//
// Same meta-defect propagation pattern (per D39) as the iter-2 N-2 finding:
// M16.5.1 propagated the no-`type`-message normalization (N-2) to the sibling
// but missed propagating the image-content fix (N-3) — closed here.
//
// Fix mirrors M16.5.1 N-3 logic adapted to Anthropic image source shape
// (`{type:"base64", media_type, data}` for inline; `{type:"url", url}` for
// URL forms; D9 text fallback otherwise). Defensive field-name handling
// (`data`/`image_data`, `media_type`/`image_mediatype`).

describe("translate_responses_to_anthropic — M16.5.2 N-5 (image-content normalization)", () => {
  // Canonical 1x1 PNG (transparent) base64 — small, well-known, avoids
  // surprising the eye when the assertion text is read.
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  test("M16.5.2 N-5 (FIRST priority): input_image with data + media_type → base64 source", async () => {
    // Pre-fix: this fell through to `url: ""` and emitted
    // `{type:"image", source:{type:"url", url:""}}` (invalid).
    // Post-fix: emits Anthropic base64 image source per spec.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              data: PNG_1x1,
              media_type: "image/png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_1x1 },
    });
  });

  test("M16.5.2 N-5 (THIRD priority): input_image with object-form image_url → url source", async () => {
    // Pre-fix: bare `c.image_url ?? c.url` returned the OBJECT verbatim
    // and type-corrupted the output's `source.url` to be an object
    // instead of a string. Post-fix: extracts the inner `url` string.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    });
    // Defensive: the source.url MUST be a string, not the object.
    const block = content[0] as { source: { url: unknown } };
    expect(typeof block.source.url).toBe("string");
  });

  test("M16.5.2 N-5 (FALLTHROUGH): input_image with no source fields → D9 text fallback", async () => {
    // Pre-fix: emitted invalid `{type:"image", source:{type:"url",
    // url:""}}` for missing-URL items (Anthropic upstream rejects).
    // Post-fix: surfaces as text block per D9 (mirror of chat-side
    // M16.5.1 N-3 fallthrough). Confirm NO invalid image emitted.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              file_id: "file_abc",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe("text");
    const text = content[0]?.text as string;
    // The dump preserves `file_id` for trace visibility.
    expect(text).toContain("file_abc");
    // Critical: must NOT emit any image block (no invalid empty source).
    expect(JSON.stringify(out)).not.toContain('"image"');
  });

  test("M16.5.2 N-5 (defensive field names): input_image with image_data + image_mediatype → base64 source", async () => {
    // Same as the FIRST-priority test but using the older field-name
    // convention (`image_data` + `image_mediatype`) seen in some
    // Responses clients. Defensive handling per spec § R1.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_data: PNG_1x1,
              image_mediatype: "image/png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_1x1 },
    });
  });

  test("M16.5.3 D-1: empty inline data + valid image_url → URL fallback wins (not empty base64 source)", async () => {
    // Per M16.5.3 D-1 (post-exec discriminator iter-4): empty-string
    // inline carriers used to short-circuit the FIRST-priority branch,
    // producing `{type:"image", source:{type:"base64", media_type:"",
    // data:""}}` and starving the valid URL fallback. The tightened
    // guard now rejects empty inline carriers; the SECOND-priority URL
    // string branch fires.
    await registerRule();
    const snap = snapshot("body");
    const body = {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              data: "",
              media_type: "",
              image_url: "https://example.com/cat.png",
            },
          ],
        },
      ],
    };
    const result = await applyRules(makeCtx(body), [baseRule], snap);
    const out = result.ctx.body as Record<string, unknown>;
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    const block = content[0] as {
      type: string;
      source: { type: string; url?: string; data?: string };
    };
    expect(block.type).toBe("image");
    expect(block.source.type).toBe("url");
    expect(block.source.url).toBe("https://example.com/cat.png");
    // Critical: must NOT emit empty base64 source.
    expect(JSON.stringify(block)).not.toContain('"base64"');
    expect(JSON.stringify(block)).not.toContain('"data":""');
  });
});

describe("translate_responses_to_anthropic — public synthetic fixture parity", () => {
  test("compares complete messages, system blocks, tool schema and scalar policy", async () => {
    await registerRule();
    const fixtures = resolve(import.meta.dir, "..", "fixtures");
    const input = JSON.parse(
      readFileSync(resolve(fixtures, "responses_to_anthropic.json"), "utf-8"),
    ) as Record<string, unknown>;
    const expected = JSON.parse(
      readFileSync(
        resolve(fixtures, "responses_to_anthropic.expected.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    const result = await applyRules(makeCtx(input), [baseRule], snapshot("body"));
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.body).toEqual(expected);
  });
});
