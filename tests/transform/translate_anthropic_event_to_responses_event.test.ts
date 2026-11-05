/**
 * translate_anthropic_event_to_responses_event.test.ts — per-event-type
 * unit tests + F26 regression tests + small fixture replay.
 *
 * Lane covered: **Codex→Claude reverse — response side** (per
 * addendum §7).
 *
 * Tests are scoped per-event-type: schema, message_start,
 * content_block_start (text + tool_use + thinking),
 * content_block_delta (text_delta + input_json_delta + thinking_delta),
 * content_block_stop (text + tool_use), message_delta, message_stop,
 * unknown / null / empty events, F26 regression (parallel tool_use
 * blocks + empty-args edge case), F21 usage-merge correctness.
 *
 * **M7b.5 F1 update.** The translator now uses a per-block
 * `state.contentBlocks: Map<number, ContentBlockMeta>` instead of the
 * scalar trio (`currentBlockType` + `currentToolId` + `currentToolName`)
 * + separate `toolArgBuffers` map. Tests that previously seeded the
 * scalars now drive the translator with real `content_block_start`
 * events first; the F26 parallel-blocks regression test no longer needs
 * any manual state mutation between events (proving the translator
 * itself preserves per-block identity).
 *
 * **M7b.6 default-passthrough refactor (D-LOCK-1 / D-LOCK-7 / D-LOCK-11).**
 * UNMAPPABLE events (no Responses equivalent — thinking_delta, unknown
 * delta types, content_block_start/stop for thinking|unknown content
 * blocks, unknown top-level event types) now return `applied: false` at
 * the translator level. Engine `apply_event.ts:237-240` default-
 * passthrough then forwards the original event unchanged.
 *   - Pattern A tests (translator-level): assert `result.applied === false`
 *     AND `result.events_out === []`.
 *   - Pattern B tests (engine-level via applyEvent): assert
 *     `events_out === [originalEvent]` — proves engine forwards.
 * CONSUMED-INTO-STATE (D-LOCK-2(b), e.g., `handleMessageDelta`) and
 * DEFENSIVE NO-OP (D-LOCK-2(c)/(d), e.g., type-mismatch on text_delta,
 * no-meta on content_block_stop) sites continue to return
 * `applied: true, events_out: []` — they intentionally suppress events
 * that should NOT be passed through.
 *
 * Tests drive emitted events without mutating state between events; state
 * transitions belong to the translator.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry } from "~/lib/transform/registry";
import {
  _resetStreamStates,
  acquireStreamState,
  initStreamState,
} from "~/lib/transform/sse-state";
import "~/lib/transform/translate_anthropic_event_to_responses_event";
import {
  _toResponsesUsage,
  TranslateAnthropicEventToResponsesEventSchema,
  translate_anthropic_event_to_responses_event,
} from "~/lib/transform/translate_anthropic_event_to_responses_event";
import type {
  AnyEvent,
  StreamEventContext,
  StreamState,
} from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
  _resetStreamStates();
});

function makeCtx(
  event: AnyEvent,
  state: StreamState = initStreamState(),
): StreamEventContext {
  return {
    event,
    state,
    route: "/responses",
    model: "claude-opus-4.7",
  };
}

function run(
  event: AnyEvent,
  state?: StreamState,
): {
  events_out: AnyEvent[];
  applied: boolean;
  state: StreamState;
} {
  const s = state ?? initStreamState();
  const ctx = makeCtx(event, s);
  const r = translate_anthropic_event_to_responses_event(ctx, {
    name: "t",
    use: "translate_anthropic_event_to_responses_event",
  });
  return { events_out: r.events_out, applied: r.applied, state: s };
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — schema", () => {
  test("minimal valid config", () => {
    const r = TranslateAnthropicEventToResponsesEventSchema.safeParse({
      name: "x",
      use: "translate_anthropic_event_to_responses_event",
    });
    expect(r.success).toBe(true);
  });

  test("on_error variants accepted", () => {
    for (const oe of [
      "continue",
      "continue_passthrough",
      "abort_with_500",
      "abort_with_502",
    ]) {
      const r = TranslateAnthropicEventToResponsesEventSchema.safeParse({
        name: "x",
        use: "translate_anthropic_event_to_responses_event",
        on_error: oe,
      });
      expect(r.success).toBe(true);
    }
  });

  test("invalid use literal rejected", () => {
    const r = TranslateAnthropicEventToResponsesEventSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Empty-event safety (D-LOCK-12)
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — empty-event safety", () => {
  test("null event returns empty events_out", () => {
    const ctx = makeCtx(null as unknown as AnyEvent);
    const r = translate_anthropic_event_to_responses_event(ctx, {});
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(false);
  });

  test("event without type returns empty events_out", () => {
    const ctx = makeCtx({} as AnyEvent);
    const r = translate_anthropic_event_to_responses_event(ctx, {});
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(false);
  });

  test("unknown event type returns applied:false (M7b.6 D-LOCK-1 default-passthrough — Pattern A)", () => {
    // M7b.6 refactor: translator returns applied:false for unknown event
    // types so the engine default-passthrough at apply_event.ts:237-240
    // forwards the original event unchanged. Pattern B test below
    // verifies the engine-level forwarding.
    const event: AnyEvent = { type: "future_event_type", foo: "bar" };
    const { events_out, applied } = run(event);
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// message_start
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — message_start", () => {
  test("emits response.created + response.in_progress", () => {
    const event: AnyEvent = {
      type: "message_start",
      message: {
        id: "msg_123",
        model: "claude-opus-4.7",
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 10,
        },
      },
    };
    const { events_out, state } = run(event);
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("response.created");
    expect(events_out[1]?.type).toBe("response.in_progress");
    const r0 = events_out[0] as Record<string, unknown>;
    const resp0 = r0.response as Record<string, unknown>;
    expect(resp0.id).toBe("msg_123");
    expect(resp0.model).toBe("claude-opus-4.7");
    expect(resp0.status).toBe("in_progress");
    expect(resp0.object).toBe("response");
    expect(resp0.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 101,
    });
    // State captured.
    expect(state.responseId).toBe("msg_123");
    expect(state.model).toBe("claude-opus-4.7");
    expect(state.outputIndex).toBe(0);
    // F21 / D-LOCK-9: finalUsage seeded from message_start usage.
    expect(state.finalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 10,
    });
  });

  test("missing message.id falls back to resp_<ts>", () => {
    const { events_out, state } = run({
      type: "message_start",
      message: { model: "x" },
    });
    const r0 = events_out[0] as Record<string, unknown>;
    const resp0 = r0.response as Record<string, unknown>;
    expect(typeof resp0.id).toBe("string");
    expect((resp0.id as string).startsWith("resp_")).toBe(true);
    expect(state.responseId).toBe(resp0.id as string);
  });

  test("missing usage produces zero-filled toResponsesUsage", () => {
    const { events_out } = run({
      type: "message_start",
      message: { id: "m", model: "claude-opus-4.7" },
    });
    const r0 = events_out[0] as Record<string, unknown>;
    const resp0 = r0.response as Record<string, unknown>;
    expect(resp0.usage).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });
});

// -----------------------------------------------------------------------------
// content_block_start
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — content_block_start", () => {
  test("text block emits output_item.added + content_part.added; meta captured", () => {
    const { events_out, state } = run({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("response.output_item.added");
    expect(events_out[1]?.type).toBe("response.content_part.added");
    const e0 = events_out[0] as Record<string, unknown>;
    expect(e0.output_index).toBe(0);
    const item = e0.item as Record<string, unknown>;
    expect(item.type).toBe("message");
    expect(item.role).toBe("assistant");
    // M7b.5 F1: per-block meta carries type + outputIndex.
    const meta = state.contentBlocks?.get(0);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe("text");
    expect(meta?.outputIndex).toBe(0);
    // Stream-wide outputIndex allocator advanced for the NEXT block.
    expect(state.outputIndex).toBe(1);
  });

  test("tool_use block emits output_item.added (function_call) + initializes per-block meta with toolId/toolName/argBuffer", () => {
    const { events_out, state } = run({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_abc", name: "WebSearch" },
    });
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("response.output_item.added");
    const e0 = events_out[0] as Record<string, unknown>;
    const item = e0.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.id).toBe("toolu_abc");
    expect(item.call_id).toBe("toolu_abc");
    expect(item.name).toBe("WebSearch");
    expect(item.arguments).toBe("");
    // M7b.5 F1: per-block meta keyed by content_block.index = 1.
    const meta = state.contentBlocks?.get(1);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe("tool_use");
    expect(meta?.toolId).toBe("toolu_abc");
    expect(meta?.toolName).toBe("WebSearch");
    expect(meta?.argBuffer).toBe("");
  });

  test("M10 D-LOCK-9 thinking block emits reasoning_summary_part.added + records meta", () => {
    const { events_out, applied, state } = run({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    // M10 D-LOCK-9: forward thinking translation. Was M7b.6 D-LOCK-1
    // UNMAPPABLE → applied:false (engine default-passthrough); now
    // TRANSLATED → applied:true emitting reasoning_summary_part.added.
    expect(applied).toBe(true);
    expect(events_out).toHaveLength(1);
    const ev = events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("response.reasoning_summary_part.added");
    expect(ev.output_index).toBe(0);
    expect(ev.summary_index).toBe(0);
    expect(ev.part).toEqual({ type: "summary_text", text: "" });
    // Per-block metadata lifecycle preserved (iter-1 F5 + M10 D-LOCK-9):
    // matching content_block_stop will find + delete this entry.
    const meta = state.contentBlocks?.get(0);
    expect(meta?.type).toBe("thinking");
    expect(meta?.outputIndex).toBe(0);
    // Forward translator allocated summary_index 0 and incremented to 1
    // for the next thinking block.
    expect(state.summaryIndex).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// content_block_delta
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — content_block_delta", () => {
  test("text_delta when text block is open emits output_text.delta with that block's outputIndex", () => {
    const state = initStreamState();
    // Drive a real text-block start so the per-block meta is populated.
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const { events_out } = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      state,
    );
    expect(events_out).toHaveLength(1);
    const e0 = events_out[0] as Record<string, unknown>;
    expect(e0.type).toBe("response.output_text.delta");
    expect(e0.delta).toBe("Hello");
    expect(e0.content_index).toBe(0);
    expect(e0.output_index).toBe(0);
  });

  test("input_json_delta when tool_use block is open APPENDS to per-block argBuffer + emits delta", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "Tool" },
      },
      state,
    );
    const r1 = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q' },
      },
      state,
    );
    expect(r1.events_out).toHaveLength(1);
    const ev1 = r1.events_out[0] as Record<string, unknown>;
    expect(ev1.type).toBe("response.function_call_arguments.delta");
    expect(ev1.delta).toBe('{"q');
    expect(state.contentBlocks?.get(0)?.argBuffer).toBe('{"q');
    // Append more — concatenation MUST be byte-exact (no normalization).
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'uery":"py"}' },
      },
      state,
    );
    expect(state.contentBlocks?.get(0)?.argBuffer).toBe('{"query":"py"}');
  });

  test("input_json_delta on a non-existent meta entry initializes a tool_use meta defensively (preserves M7b iter-1 behavior)", () => {
    const state = initStreamState();
    // Note: no content_block_start was sent for index 5.
    run(
      {
        type: "content_block_delta",
        index: 5,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      state,
    );
    const meta = state.contentBlocks?.get(5);
    expect(meta?.type).toBe("tool_use");
    expect(meta?.argBuffer).toBe("{}");
  });

  test("input_json_delta when block at this index is TEXT type is DEFENSIVE NO-OP (M7b.6 D-LOCK-2(c) — applied:true, events_out: [])", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const { events_out, applied } = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      state,
    );
    expect(events_out).toEqual([]);
    // M7b.6 D-LOCK-2(c): type-mismatch DEFENSIVE NO-OP. Suppressed
    // with applied:true so engine does NOT default-passthrough a
    // malformed event that would corrupt downstream parser state.
    expect(applied).toBe(true);
  });

  test("M10 D-LOCK-9 thinking_delta emits reasoning_summary_text.delta", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const { events_out, applied } = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hello reasoning" },
      },
      state,
    );
    // M10 D-LOCK-9: forward thinking_delta translation. Was M7b.6 D-LOCK-1
    // UNMAPPABLE → applied:false (engine default-passthrough); now
    // TRANSLATED → applied:true emitting reasoning_summary_text.delta.
    expect(applied).toBe(true);
    expect(events_out).toHaveLength(1);
    const ev = events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("response.reasoning_summary_text.delta");
    expect(ev.output_index).toBe(0);
    expect(ev.summary_index).toBe(0);
    expect(ev.delta).toBe("hello reasoning");
  });

  test("M10 D-LOCK-9 signature_delta dropped with debug log (no Responses equivalent)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const { events_out, applied } = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc123" },
      },
      state,
    );
    // M10 D-LOCK-9: signature_delta is DROPPED. applied:true so engine
    // does NOT default-passthrough (would be a protocol-pair leak D9).
    expect(events_out).toEqual([]);
    expect(applied).toBe(true);
  });

  test("unknown delta type is UNMAPPABLE → returns applied:false (M7b.6 D-LOCK-1 — Pattern A)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const { events_out, applied } = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "future_delta_type", payload: "x" },
      },
      state,
    );
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// content_block_stop
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — content_block_stop", () => {
  test("text block emits text.done + content_part.done + output_item.done; per-block meta freed", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const { events_out } = run({ type: "content_block_stop", index: 0 }, state);
    expect(events_out).toHaveLength(3);
    expect(events_out[0]?.type).toBe("response.output_text.done");
    expect(events_out[1]?.type).toBe("response.content_part.done");
    expect(events_out[2]?.type).toBe("response.output_item.done");
    // M17.5 F-M17-Discrim-2 (MEDIUM) — strengthen the assertion to
    // require the FULL ResponsesMessageItem shape on the per-block
    // output_item.done event, not just the type field. Pre-M17.5 the
    // test asserted only `events_out[2]?.type === "response.output_item.done"`,
    // which would silently pass a regression that reverts to the
    // pre-M17 buggy {type, role, status} shape (missing the closed-
    // type-required `id` + `content[]` fields). The 13 NEW M17 tests
    // assert the terminal `output[]` shape but NOT the per-block
    // `output_item.done.item` shape — this strengthening closes that
    // gap. No text_delta fires in this test → accumulated text is "".
    const evt2 = events_out[2] as Record<string, unknown>;
    expect(evt2.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    expect(state.contentBlocks?.has(0)).toBe(false);
  });

  test("tool_use block emits function_call_arguments.done + output_item.done with assembled args (F26 happy path)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_xyz", name: "WebSearch" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"query":"hello"}' },
      },
      state,
    );
    const { events_out } = run({ type: "content_block_stop", index: 2 }, state);
    expect(events_out).toHaveLength(2);
    const e0 = events_out[0] as Record<string, unknown>;
    expect(e0.type).toBe("response.function_call_arguments.done");
    expect(e0.arguments).toBe('{"query":"hello"}');
    // outputIndex captured at start was 0 (first block).
    expect(e0.output_index).toBe(0);
    const e1 = events_out[1] as Record<string, unknown>;
    expect(e1.type).toBe("response.output_item.done");
    const item = e1.item as Record<string, unknown>;
    expect(item.arguments).toBe('{"query":"hello"}');
    expect(item.id).toBe("toolu_xyz");
    expect(item.call_id).toBe("toolu_xyz");
    expect(item.name).toBe("WebSearch");
    expect(item.status).toBe("completed");
    // F26 buffer freed after emit.
    expect(state.contentBlocks?.has(2)).toBe(false);
  });

  test('F26 regression — empty-args edge case: tool_use block with ZERO input_json_delta events emits arguments: "{}" (not "")', () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_zero", name: "Now" },
      },
      state,
    );
    // No deltas emitted — straight to stop.
    const { events_out } = run({ type: "content_block_stop", index: 0 }, state);
    const e0 = events_out[0] as Record<string, unknown>;
    expect(e0.arguments).toBe("{}");
    const item = (events_out[1] as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(item.arguments).toBe("{}");
    // CRUCIALLY NOT "":
    expect(e0.arguments).not.toBe("");
    expect(item.arguments).not.toBe("");
  });

  test("content_block_stop on an unknown index is DEFENSIVE NO-OP (M7b.6 D-LOCK-2(d) — applied:true)", () => {
    const state = initStreamState();
    // No start was ever sent.
    const { events_out, applied } = run(
      { type: "content_block_stop", index: 99 },
      state,
    );
    expect(events_out).toEqual([]);
    // M7b.6 D-LOCK-2(d): no-meta DEFENSIVE NO-OP. Suppressed with
    // applied:true so engine does NOT default-passthrough an event
    // whose matching open the downstream parser never saw.
    expect(applied).toBe(true);
  });

  test("M10 D-LOCK-9 content_block_stop(thinking) emits reasoning_summary_text.done + part.done (text:'' per H3 LOCKED)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    expect(state.contentBlocks?.has(0)).toBe(true);
    const { events_out, applied } = run(
      { type: "content_block_stop", index: 0 },
      state,
    );
    // M10 D-LOCK-9: forward thinking translation. Was M7b.6 D-LOCK-1
    // UNMAPPABLE → applied:false; now TRANSLATED → applied:true emitting
    // reasoning_summary_text.done + reasoning_summary_part.done.
    expect(applied).toBe(true);
    expect(events_out).toHaveLength(2);
    const e0 = events_out[0] as Record<string, unknown>;
    const e1 = events_out[1] as Record<string, unknown>;
    expect(e0.type).toBe("response.reasoning_summary_text.done");
    expect(e0.output_index).toBe(0);
    expect(e0.summary_index).toBe(0);
    // H3 LOCKED: text:"" regardless of upstream's accumulated text.
    expect(e0.text).toBe("");
    expect(e1.type).toBe("response.reasoning_summary_part.done");
    expect(e1.output_index).toBe(0);
    expect(e1.summary_index).toBe(0);
    expect(e1.part).toEqual({ type: "summary_text", text: "" });
    // Per-block metadata lifecycle preserved (iter-1 F5): meta deleted.
    expect(state.contentBlocks?.has(0)).toBe(false);
  });

  test("content_block_stop(unknown_type) UNMAPPABLE → applied:false + meta deleted (M7b.6 D-LOCK-1)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "future_content_block_type" },
      },
      state,
    );
    expect(state.contentBlocks?.has(0)).toBe(true);
    const { events_out, applied } = run(
      { type: "content_block_stop", index: 0 },
      state,
    );
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
    expect(state.contentBlocks?.has(0)).toBe(false);
  });

  test("content_block_start(unknown_type) UNMAPPABLE → applied:false + meta written (M7b.6 D-LOCK-1)", () => {
    const { events_out, applied, state } = run({
      type: "content_block_start",
      index: 0,
      content_block: { type: "future_content_block_type" },
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
    // Per-block metadata lifecycle preserved INDEPENDENTLY of applied
    // flag (iter-1 F5).
    expect(state.contentBlocks?.get(0)?.type).toBe("future_content_block_type");
  });

  test("STRENGTHENED LIFECYCLE — thinking content_block_start/stop pair: meta size 1→0 (M7b.6 mini-audit 27)", () => {
    // Catches "executor forgot to write meta" + "executor forgot to
    // delete meta" bugs at the same time. Spec §27 requires assertions
    // ordered IN ORDER per iter-2 F8 + iter-3 M3.
    const state = initStreamState();
    // After start: contentBlocks.size === 1 AND get(blockIndex).type === "thinking".
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    expect(state.contentBlocks?.size).toBe(1);
    expect(state.contentBlocks?.get(0)?.type).toBe("thinking");
    // After stop: contentBlocks.size === 0.
    run({ type: "content_block_stop", index: 0 }, state);
    expect(state.contentBlocks?.size).toBe(0);
  });

  test("STRENGTHENED LIFECYCLE — unknown content_block_start/stop pair: meta size 1→0 (M7b.6 mini-audit 27)", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "unknown_type_x" },
      },
      state,
    );
    expect(state.contentBlocks?.size).toBe(1);
    expect(state.contentBlocks?.get(0)?.type).toBe("unknown_type_x");
    run({ type: "content_block_stop", index: 0 }, state);
    expect(state.contentBlocks?.size).toBe(0);
  });

  test("F26 / M7b.5 F1 regression — PARALLEL tool_use blocks with INTERLEAVED deltas + OUT-OF-ORDER stops (no manual state mutation)", () => {
    // Sequence per M7b.5 spec § F1:
    //   b0-start, b1-start, b0-delta, b1-delta, b0-delta, b1-delta,
    //   b1-stop FIRST, b0-stop SECOND.
    // Each stop MUST emit ITS OWN tool's args/id/name. The translator
    // does this WITHOUT any test-side mutation of state.* between events
    // (proves that per-block meta — not stream-wide scalars — preserves
    // identity). M7b iter-1's masked test re-seeded scalars between
    // events to mask exactly this bug.
    const state = acquireStreamState("test-parallel-tools");

    // message_start
    run(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-test",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      state,
    );

    // b0-start (tool A)
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_b0", name: "ToolA" },
      },
      state,
    );
    expect(state.contentBlocks?.has(0)).toBe(true);

    // b1-start (tool B) — does NOT clobber b0's metadata.
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_b1", name: "ToolB" },
      },
      state,
    );
    expect(state.contentBlocks?.has(1)).toBe(true);
    // b0's meta is intact (not overwritten).
    expect(state.contentBlocks?.get(0)?.toolId).toBe("toolu_b0");
    expect(state.contentBlocks?.get(0)?.toolName).toBe("ToolA");

    // Interleaved deltas — b0-delta then b1-delta then b0-delta then b1-delta.
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"b":' },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "1}" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "2}" },
      },
      state,
    );
    expect(state.contentBlocks?.get(0)?.argBuffer).toBe('{"a":1}');
    expect(state.contentBlocks?.get(1)?.argBuffer).toBe('{"b":2}');

    // b1-stop FIRST (out of order — b1 finished before b0).
    // NO state.* mutation between events — translator must read from
    // per-block meta map keyed by content_block.index.
    const r1 = run({ type: "content_block_stop", index: 1 }, state);
    expect(r1.events_out).toHaveLength(2);
    const r1FuncDone = r1.events_out[0] as Record<string, unknown>;
    expect(r1FuncDone.type).toBe("response.function_call_arguments.done");
    expect(r1FuncDone.arguments).toBe('{"b":2}');
    const r1ItemDone = r1.events_out[1] as Record<string, unknown>;
    expect(r1ItemDone.type).toBe("response.output_item.done");
    const r1Item = r1ItemDone.item as Record<string, unknown>;
    expect(r1Item.arguments).toBe('{"b":2}');
    expect(r1Item.id).toBe("toolu_b1");
    expect(r1Item.call_id).toBe("toolu_b1");
    expect(r1Item.name).toBe("ToolB");

    // b0-stop SECOND — must STILL emit b0's correct args + id + name
    // (NOT b1's, NOT empty/dropped).
    const r0 = run({ type: "content_block_stop", index: 0 }, state);
    expect(r0.events_out).toHaveLength(2);
    const r0FuncDone = r0.events_out[0] as Record<string, unknown>;
    expect(r0FuncDone.arguments).toBe('{"a":1}');
    expect(r0FuncDone.arguments).not.toBe("");
    expect(r0FuncDone.arguments).not.toBe('{"b":2}');
    const r0Item = (r0.events_out[1] as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(r0Item.arguments).toBe('{"a":1}');
    expect(r0Item.id).toBe("toolu_b0");
    expect(r0Item.call_id).toBe("toolu_b0");
    expect(r0Item.name).toBe("ToolA");

    // All buffers freed.
    expect(state.contentBlocks?.size).toBe(0);
  });

  test("F26 / M7b.5 F1 regression — 3 PARALLEL tool_use blocks with stop order (b2, b0, b1) — each emits its own correct args + id + name", () => {
    // Spec §F1 mini-audit item 4: 3 blocks (b0, b1, b2) start in order,
    // stop in order (2, 0, 1). All must emit their own correct args + ids.
    const state = acquireStreamState("test-3-blocks");
    run(
      {
        type: "message_start",
        message: {
          id: "msg_3",
          model: "claude-test",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      state,
    );
    // Three starts in order.
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_0", name: "ToolZero" },
      },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "ToolOne" },
      },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_2", name: "ToolTwo" },
      },
      state,
    );
    // Different args per block.
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":0}' },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"y":1}' },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"z":2}' },
      },
      state,
    );

    // Stop in order: b2, b0, b1.
    const r2 = run({ type: "content_block_stop", index: 2 }, state);
    const r2Item = (r2.events_out[1] as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(r2Item.id).toBe("toolu_2");
    expect(r2Item.name).toBe("ToolTwo");
    expect(r2Item.arguments).toBe('{"z":2}');

    const r0 = run({ type: "content_block_stop", index: 0 }, state);
    const r0Item = (r0.events_out[1] as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(r0Item.id).toBe("toolu_0");
    expect(r0Item.name).toBe("ToolZero");
    expect(r0Item.arguments).toBe('{"x":0}');

    const r1 = run({ type: "content_block_stop", index: 1 }, state);
    const r1Item = (r1.events_out[1] as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(r1Item.id).toBe("toolu_1");
    expect(r1Item.name).toBe("ToolOne");
    expect(r1Item.arguments).toBe('{"y":1}');

    // All meta freed; allocator advanced 3 times.
    expect(state.contentBlocks?.size).toBe(0);
    expect(state.outputIndex).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// message_delta
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — message_delta", () => {
  test("emits no events but mutates state.stopReason + MERGES finalUsage (F21 / D-LOCK-9)", () => {
    const state = initStreamState();
    state.finalUsage = {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 10,
    };
    const { events_out } = run(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 50 },
      },
      state,
    );
    expect(events_out).toEqual([]);
    expect(state.stopReason).toBe("end_turn");
    // input_tokens / cache_read_input_tokens preserved; output_tokens replaced.
    expect(state.finalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
    });
  });

  test("missing usage in message_delta does not clobber prior finalUsage", () => {
    const state = initStreamState();
    state.finalUsage = { input_tokens: 100, output_tokens: 1 };
    run(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      },
      state,
    );
    expect(state.finalUsage).toEqual({ input_tokens: 100, output_tokens: 1 });
  });
});

// -----------------------------------------------------------------------------
// message_stop
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — message_stop", () => {
  test("emits response.completed with assembled usage", () => {
    const state = initStreamState();
    state.responseId = "resp_42";
    state.model = "claude-opus-4.7";
    state.finalUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
    };
    const { events_out } = run({ type: "message_stop" }, state);
    expect(events_out).toHaveLength(1);
    const e0 = events_out[0] as Record<string, unknown>;
    expect(e0.type).toBe("response.completed");
    const resp = e0.response as Record<string, unknown>;
    expect(resp.id).toBe("resp_42");
    expect(resp.model).toBe("claude-opus-4.7");
    expect(resp.status).toBe("completed");
    expect(resp.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    });
  });

  test("missing responseId falls back to resp_<ts>", () => {
    const state = initStreamState();
    const { events_out } = run({ type: "message_stop" }, state);
    const e0 = events_out[0] as Record<string, unknown>;
    const resp = e0.response as Record<string, unknown>;
    expect(typeof resp.id).toBe("string");
    expect((resp.id as string).startsWith("resp_")).toBe(true);
  });

  test("calls releaseStreamState when state.requestId is set (D-LOCK-3 lifecycle)", () => {
    const state = acquireStreamState("req-stop");
    state.responseId = "resp_x";
    // Run message_stop on this acquired state.
    const ctx = makeCtx({ type: "message_stop" }, state);
    translate_anthropic_event_to_responses_event(ctx, {});
    // After release, the map should NOT contain req-stop.
    // We verify via re-acquire returning a NEW instance.
    const reacquired = acquireStreamState("req-stop");
    expect(reacquired).not.toBe(state);
  });

  test("missing requestId is a no-op for release (defensive — for tests)", () => {
    const state = initStreamState();
    // No state.requestId set.
    const ctx = makeCtx({ type: "message_stop" }, state);
    expect(() =>
      translate_anthropic_event_to_responses_event(ctx, {}),
    ).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// Full event sequence (fixture-style — text-only happy path)
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — full text-only sequence", () => {
  test("end-to-end: message_start → content_block_start(text) → 3 deltas → content_block_stop → message_delta → message_stop", () => {
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "message_start",
        message: {
          id: "msg_seq",
          model: "claude-opus-4.7",
          usage: { input_tokens: 6, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ", " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 6 },
      },
      { type: "message_stop" },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    // Required event types present, in order.
    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      // message_delta emits no events.
      "response.completed",
    ]);
    // Final usage merged correctly per F21.
    expect(state.finalUsage).toEqual({ input_tokens: 6, output_tokens: 6 });
  });
});

// -----------------------------------------------------------------------------
// Engine integration via applyEvent (mini-audit 35)
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — engine integration", () => {
  test("apply_event pipes a hand-crafted event through the registered rule and returns the translated output", async () => {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    // Re-register defensively (other tests' afterEach may have reset).
    registerStreamEvent(
      "translate_anthropic_event_to_responses_event",
      translate_anthropic_event_to_responses_event,
      TranslateAnthropicEventToResponsesEventSchema,
      {
        allow_override: true,
        reads: ["contentBlocks"],
        writes: ["responseId", "model", "outputIndex", "finalUsage"],
      },
    );
    const reg = snapshot("stream_event");
    const state = initStreamState();
    const ctx: StreamEventContext = {
      event: {
        type: "message_start",
        message: {
          id: "msg_int",
          model: "claude-opus-4.7",
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      state,
      route: "/responses",
      model: "claude-opus-4.7",
    };
    const result = applyEvent(
      ctx,
      [
        {
          name: "t",
          use: "translate_anthropic_event_to_responses_event",
        },
      ],
      reg,
    );
    expect(result.events_out).toHaveLength(2);
    expect(result.events_out[0]?.type).toBe("response.created");
    expect(result.events_out[1]?.type).toBe("response.in_progress");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.name).toBe("t");
    // X6 manifest propagated to AppliedRule.
    expect(result.applied[0]?.writes).toContain("responseId");
  });

  test("apply_event default-passthrough fires when the rule returns events_out: [] AND applied: false (M7b.6 D-LOCK-1 — Pattern B for unknown event type)", async () => {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_anthropic_event_to_responses_event",
      translate_anthropic_event_to_responses_event,
      TranslateAnthropicEventToResponsesEventSchema,
      { allow_override: true },
    );
    const reg = snapshot("stream_event");
    const originalEvent: AnyEvent = { type: "totally_unknown_event_type" };
    const ctx: StreamEventContext = {
      event: originalEvent,
      state: initStreamState(),
      route: "/responses",
      model: "claude-opus-4.7",
    };
    const result = applyEvent(
      ctx,
      [
        {
          name: "t",
          use: "translate_anthropic_event_to_responses_event",
        },
      ],
      reg,
    );
    // M7b.6 D-LOCK-1: translator returns applied:false; engine
    // default-passthrough at apply_event.ts:237-240 emits the original
    // event unchanged.
    expect(result.events_out).toEqual([originalEvent]);
    // No AppliedRule recorded — applied:false skips the push.
    expect(result.applied).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// M7b.6 default-passthrough — Pattern B (engine-level) tests
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — M7b.6 Pattern B engine default-passthrough", () => {
  // Per D-LOCK-11: NEW Pattern B test per UNMAPPABLE event type. Each
  // test fires the rule via applyEvent + registry snapshot and asserts
  // the engine forwards the original event unchanged when the
  // translator returns applied:false.

  async function pipeThroughEngine(
    event: AnyEvent,
    state: StreamState,
  ): Promise<{ events_out: AnyEvent[]; applied_count: number }> {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_anthropic_event_to_responses_event",
      translate_anthropic_event_to_responses_event,
      TranslateAnthropicEventToResponsesEventSchema,
      { allow_override: true },
    );
    const reg = snapshot("stream_event");
    const ctx: StreamEventContext = {
      event,
      state,
      route: "/responses",
      model: "claude-opus-4.7",
    };
    const result = applyEvent(
      ctx,
      [{ name: "t", use: "translate_anthropic_event_to_responses_event" }],
      reg,
    );
    return {
      events_out: result.events_out,
      applied_count: result.applied.length,
    };
  }

  test("M10 D-LOCK-9 Pattern B: thinking_delta → engine emits TRANSLATED reasoning_summary_text.delta", async () => {
    const state = acquireStreamState("test-engine-passthrough-thinking-delta");
    // Drive a real content_block_start(thinking) so the meta is populated
    // through the engine. This exercises Pattern B for that case too.
    await pipeThroughEngine(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const ev: AnyEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "abc" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    // M10 D-LOCK-9: TRANSLATED. applied_count > 0 because translator
    // claimed the event. Engine emits the translated event(s); does NOT
    // default-passthrough the original.
    expect(applied_count).toBe(1);
    expect(events_out).toHaveLength(1);
    const out0 = events_out[0] as Record<string, unknown>;
    expect(out0.type).toBe("response.reasoning_summary_text.delta");
    expect(out0.delta).toBe("abc");
  });

  test("M10 D-LOCK-9 Pattern B: content_block_start(thinking) → engine emits TRANSLATED reasoning_summary_part.added", async () => {
    const state = acquireStreamState(
      "test-engine-passthrough-cb-start-thinking",
    );
    const ev: AnyEvent = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(applied_count).toBe(1);
    expect(events_out).toHaveLength(1);
    const out0 = events_out[0] as Record<string, unknown>;
    expect(out0.type).toBe("response.reasoning_summary_part.added");
    // Meta lifecycle preserved (iter-1 F5).
    expect(state.contentBlocks?.get(0)?.type).toBe("thinking");
  });

  test("M10 D-LOCK-9 Pattern B: content_block_stop(thinking) → engine emits TRANSLATED done events; meta deleted", async () => {
    const state = acquireStreamState(
      "test-engine-passthrough-cb-stop-thinking",
    );
    await pipeThroughEngine(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    expect(state.contentBlocks?.has(0)).toBe(true);
    const ev: AnyEvent = { type: "content_block_stop", index: 0 };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(applied_count).toBe(1);
    expect(events_out).toHaveLength(2);
    const out0 = events_out[0] as Record<string, unknown>;
    const out1 = events_out[1] as Record<string, unknown>;
    expect(out0.type).toBe("response.reasoning_summary_text.done");
    expect(out0.text).toBe("");
    expect(out1.type).toBe("response.reasoning_summary_part.done");
    expect((out1.part as Record<string, unknown>).text).toBe("");
    expect(state.contentBlocks?.has(0)).toBe(false);
  });

  test("Pattern B: unknown delta type → engine emits original (default-passthrough)", async () => {
    const state = acquireStreamState("test-engine-passthrough-unknown-delta");
    await pipeThroughEngine(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const ev: AnyEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "future_delta_type", payload: "x" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
  });

  test("Pattern B: unknown content_block.type at start → engine emits original", async () => {
    const state = acquireStreamState("test-engine-passthrough-unknown-cb-type");
    const ev: AnyEvent = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "future_block_type" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
    expect(state.contentBlocks?.get(0)?.type).toBe("future_block_type");
  });

  test("Pattern B: unknown top-level event type → engine emits original (default-passthrough)", async () => {
    const state = acquireStreamState(
      "test-engine-passthrough-unknown-toplevel",
    );
    const ev: AnyEvent = { type: "totally_unknown_top_level", x: 1 };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Lifecycle — multi-stream parity (mini-audit 14)
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — lifecycle", () => {
  test("100 streams run to completion → map is empty afterwards", async () => {
    const { _streamStateCount } = await import("~/lib/transform/sse-state");
    for (let i = 0; i < 100; i++) {
      const state = acquireStreamState(`req-loop-${i}`);
      const ctx = makeCtx(
        {
          type: "message_start",
          message: {
            id: `msg_${i}`,
            model: "claude-opus-4.7",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        state,
      );
      translate_anthropic_event_to_responses_event(ctx, {});
      const stopCtx = makeCtx({ type: "message_stop" }, state);
      translate_anthropic_event_to_responses_event(stopCtx, {});
    }
    expect(_streamStateCount()).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// _toResponsesUsage helper (D-LOCK-9 direct verification)
// -----------------------------------------------------------------------------

describe("translate_anthropic_event_to_responses_event — _toResponsesUsage (F21)", () => {
  test("computes total_tokens = input + output", () => {
    expect(_toResponsesUsage({ input_tokens: 100, output_tokens: 50 })).toEqual(
      {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 150,
      },
    );
  });

  test("populates cached_tokens from cache_read_input_tokens", () => {
    expect(
      _toResponsesUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
      }),
    ).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    });
  });

  test("null / undefined / non-object input → all zeros", () => {
    expect(_toResponsesUsage(null)).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
    expect(_toResponsesUsage(undefined)).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
    expect(_toResponsesUsage("nope")).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });

  test("non-number fields are treated as missing (not coerced)", () => {
    expect(
      _toResponsesUsage({
        input_tokens: "100",
        output_tokens: null,
        cache_read_input_tokens: undefined,
      }),
    ).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });
});

// -----------------------------------------------------------------------------
// M17: response.completed.response.output[] assembly
// -----------------------------------------------------------------------------
//
// Lane 5 (codex/claude reverse-rendering): codex CLI consumes the
// `response.completed.response.output[]` array to render the assistant's
// reply. Pre-M17 the forward translator hardcoded `output: []`, so codex
// rendered nothing visible. M17 populates the array with assembled
// {message, function_call, reasoning} items so codex can render.
//
// Per spec § Acceptance Criteria + Requirements R1-R15. Each test asserts
// the EXACT structural shape (R12 / M-iter2-5) — type, id, role, status,
// content[].type for messages; type, id, call_id, name, arguments, status
// for function_calls; type, id, summary for reasoning.
//
// Test feed pattern matches existing F36-discipline: events go through the
// SUT; test code never mutates state.* between events. The aggregated
// outputItems is read at the END (after message_stop) from the final
// state to assert the assembled shape.

describe("M17: response.completed.response.output[] assembly", () => {
  test("text-only message → output has exactly one message item with full text", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_1", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Hello world",
          annotations: [],
        },
      ],
    });
  });

  test("multi-delta text accumulation matches concatenated deltas", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_2", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    for (const piece of ["a", "b", "c", "d", "e"]) {
      run(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        },
        state,
      );
    }
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    const message = output[0] as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[0]?.text).toBe("abcde");
  });

  test("tool_use call → function_call item with correct id/call_id/name/arguments", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_3", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_abc",
          name: "get_weather",
        },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"city":"NYC"}',
        },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual({
      type: "function_call",
      id: "toolu_abc",
      call_id: "toolu_abc",
      name: "get_weather",
      arguments: '{"city":"NYC"}',
      status: "completed",
    });
  });

  test("tool_use with empty args → arguments defaults to '{}' (OQ-PROXY-EMPTY-TOOL-ARGS)", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_4", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_xyz",
          name: "noop",
        },
      },
      state,
    );
    // No input_json_delta events.
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    const item = output[0] as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.arguments).toBe("{}");
  });

  test("thinking block → reasoning item with EMPTY summary array (R3 H3-LOCKED)", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_5", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    // Even with thinking_delta events, the summary stays empty per R3.
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I'm thinking..." },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual({
      type: "reasoning",
      id: "rs_0",
      summary: [],
    });
  });

  test("mixed: thinking + text + tool_use → 3 items in correct order", () => {
    // Stream order: thinking_stop (b0) → tool_use_stop (b1) → text_stop (b2)
    // → message_stop. Per R8 message-item-LAST: outputItems is
    // [reasoning, function_call, message].
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_6", model: "x" } },
      state,
    );
    // b0: thinking
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    // b1: tool_use
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_q", name: "search" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      },
      state,
    );
    run({ type: "content_block_stop", index: 1 }, state);
    // b2: text
    run(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Done." },
      },
      state,
    );
    run({ type: "content_block_stop", index: 2 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(3);
    expect((output[0] as Record<string, unknown>).type).toBe("reasoning");
    expect((output[1] as Record<string, unknown>).type).toBe("function_call");
    expect((output[2] as Record<string, unknown>).type).toBe("message");
    // Structural assertion on each item (R12 / M-iter2-5).
    expect(output[0]).toEqual({ type: "reasoning", id: "rs_0", summary: [] });
    expect(output[1]).toEqual({
      type: "function_call",
      id: "toolu_q",
      call_id: "toolu_q",
      name: "search",
      arguments: '{"q":"x"}',
      status: "completed",
    });
    expect(output[2]).toEqual({
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    });
  });

  test("empty stream (message_start → message_stop with no content_block_*) → output is []", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_7", model: "x" } },
      state,
    );
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([]);
  });

  test("REGRESSION: canonical Lane 5 e2e body shape ('hi' prompt) → output[0] is message with text", () => {
    // Mirrors the actual sequence v2 receives from upstream Anthropic
    // for a "hi" prompt: message_start → text block_start →
    // text_delta * N → text block_stop → message_delta (stop_reason)
    // → message_stop.
    const state = initStreamState();
    run(
      {
        type: "message_start",
        message: { id: "resp_e2e", model: "claude-test" },
      },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    for (const t of ["Hi", "!", " How", " can", " I", " help", "?"]) {
      run(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: t },
        },
        state,
      );
    }
    run({ type: "content_block_stop", index: 0 }, state);
    run(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      },
      state,
    );
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output.length).toBeGreaterThan(0);
    expect(output[0]?.type).toBe("message");
    const messageItem = output[0] as Record<string, unknown>;
    const content = messageItem.content as Array<Record<string, unknown>>;
    const textPart = content[0] as Record<string, unknown>;
    expect(textPart.text).toBe("Hi! How can I help?");
  });

  test("PARALLEL-INTERLEAVED tool blocks: outputItems order matches STOP order [b1, b0]", () => {
    // F26 / D-LOCK-4 critical invariant: parallel tool_use blocks may
    // interleave their input_json_delta events; outputItems order is the
    // STOP order, NOT the start order or content_block.index order.
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_par", model: "x" } },
      state,
    );
    // b0-start
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_b0", name: "tool_a" },
      },
      state,
    );
    // b1-start
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_b1", name: "tool_b" },
      },
      state,
    );
    // b1-delta
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"k":"b"}' },
      },
      state,
    );
    // b0-delta
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"k":"a"}' },
      },
      state,
    );
    // b1-stop FIRST
    run({ type: "content_block_stop", index: 1 }, state);
    // b0-stop
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(2);
    // STOP order: b1 first, b0 second.
    expect((output[0] as Record<string, unknown>).id).toBe("toolu_b1");
    expect((output[0] as Record<string, unknown>).name).toBe("tool_b");
    expect((output[0] as Record<string, unknown>).arguments).toBe('{"k":"b"}');
    expect((output[1] as Record<string, unknown>).id).toBe("toolu_b0");
    expect((output[1] as Record<string, unknown>).name).toBe("tool_a");
    expect((output[1] as Record<string, unknown>).arguments).toBe('{"k":"a"}');
  });

  test("NON-EMITTING blocks: server_tool_use produces NO outputItems entry (R13)", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_noop", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use" },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([]);
    // Also assert outputItems is empty before message_stop fires.
    // (After message_stop the state has been cleared via release if
    // requestId set; here we just observe the final emit.)
  });

  test("MULTIPLE TEXT BLOCKS aggregate into SINGLE message item (R7) + flush-at-message-stop semantics (H-iter2-5)", () => {
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_multi", model: "x" } },
      state,
    );
    // First text block
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Part one." },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    // FLUSH SEMANTICS: after the FIRST text block's stop but BEFORE
    // the second block's start, outputItems must remain [] (the
    // message item is NOT yet pushed; flush is deferred to
    // message_stop). Asserts R7 flush-at-message-stop semantics, not
    // just text concatenation. Avoids F36/F49/F51 test-masking.
    const after1stStop = state.outputItems;
    expect(after1stStop).toEqual([]);
    // Second text block
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " Part two." },
      },
      state,
    );
    run({ type: "content_block_stop", index: 1 }, state);
    expect(state.outputItems).toEqual([]);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual({
      type: "message",
      id: "msg_0", // FIRST text block's id; second block does NOT overwrite.
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Part one. Part two.",
          annotations: [],
        },
      ],
    });
  });

  test("MIXED-CONTENT ORDER (#13): outputItems is [reasoning, function_call, message] regardless of text_delta timing", () => {
    // text_delta fires BEFORE reasoning/function_call stops, but the
    // message item still lands LAST per R8 message-item-LAST.
    // Sequence:
    //   text-start (b0) → text-delta → reasoning-start (b1) → reasoning-stop
    //   → tool-start (b2) → tool-delta → tool-stop → text-stop (b0)
    //   → message_stop
    // Expected outputItems order: [reasoning(b1), function_call(b2), message(b0)]
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_mix", model: "x" } },
      state,
    );
    // b0: text-start (allocates msg_0)
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    // text_delta fires EARLY in the stream
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Result: " },
      },
      state,
    );
    // b1: reasoning
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking" },
      },
      state,
    );
    run({ type: "content_block_stop", index: 1 }, state);
    // b2: tool_use
    run(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_z", name: "fetch" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"u":"x"}' },
      },
      state,
    );
    run({ type: "content_block_stop", index: 2 }, state);
    // b0: text-stop NOW (after reasoning + tool stops)
    run({ type: "content_block_stop", index: 0 }, state);
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(3);
    // Reasoning + function_call land in their content_block_stop order
    // (reasoning first, function_call second).
    expect((output[0] as Record<string, unknown>).type).toBe("reasoning");
    expect((output[1] as Record<string, unknown>).type).toBe("function_call");
    // Message item lands LAST regardless of where text_delta fired.
    expect((output[2] as Record<string, unknown>).type).toBe("message");
    expect((output[2] as Record<string, unknown>).id).toBe("msg_0");
  });

  // -----------------------------------------------------------------------------
  // M17.5 post-exec discriminator iter-1 remediation tests.
  // -----------------------------------------------------------------------------
  // F-M17-Discrim-1 (HIGH) coverage — empty-text content_block must NOT
  // synthesize an empty message item in the terminal output[]. Two
  // variants: zero text_delta events, and a single empty-string
  // text_delta. Both leave builder.text === "" → message_stop omits.
  //
  // F-M17-Discrim-3 (MEDIUM) coverage — multi-text-block streams: per-
  // block added.id, per-block done.id, and terminal output[].id are ALL
  // aligned to the FIRST builder id (msg_0). Single source of truth.
  //
  // F-M17-Discrim-2 (MEDIUM, second variant) coverage — per-block
  // output_item.done emits the FULL ResponsesMessageItem shape with
  // multi-delta accumulated text (non-empty case).

  test("M17: empty text content_block (no text_delta) flushes EMPTY output[] (no message item synthesized)", () => {
    // F-M17-Discrim-1 HIGH coverage: structurally-valid empty text
    // block from upstream Anthropic must NOT produce an empty message
    // item in response.completed.output[]. Same bug class as F36/F49/
    // F51 silent-blank-render — gate flush on text.length > 0.
    //
    // M17.5.1 F-M17.5-Discrim-1 (MEDIUM, EID `a0513d00e1dd234ef`)
    // strengthening: capture the content_block_stop result and assert
    // ALL 3 per-block done events fire with full shape. Pre-M17.5.1
    // this test discarded the stop result — a regression suppressing
    // per-block done events on empty-text blocks would silently pass
    // (codex CLI requires per-block lifecycle events regardless of
    // content payload).
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_empty1", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    // NO text_delta events.
    const stopResult = run({ type: "content_block_stop", index: 0 }, state);
    // M17.5.1 strengthening: assert all 3 per-block done events fire
    // with full shape. handleContentBlockStop text branch emits:
    // [output_text.done, content_part.done, output_item.done] in that
    // order (production code lines ~707-756).
    expect(stopResult.events_out).toHaveLength(3);
    const textDone = stopResult.events_out[0] as Record<string, unknown>;
    expect(textDone.type).toBe("response.output_text.done");
    expect(textDone.text).toBe("");
    expect(textDone.output_index).toBe(0);
    expect(textDone.content_index).toBe(0);
    const partDone = stopResult.events_out[1] as Record<string, unknown>;
    expect(partDone.type).toBe("response.content_part.done");
    expect(partDone.output_index).toBe(0);
    expect(partDone.content_index).toBe(0);
    expect(partDone.part).toEqual({ type: "output_text", text: "" });
    const itemDone = stopResult.events_out[2] as Record<string, unknown>;
    expect(itemDone.type).toBe("response.output_item.done");
    expect(itemDone.output_index).toBe(0);
    // F-M17-Discrim-3 alignment: per-block done emits FIRST builder id.
    expect(itemDone.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([]);
    // Builder is unconditionally reset to null at message_stop —
    // verifies the M17.5 unconditional-reset invariant.
    expect(state.assistantMessageBuilder).toBeNull();
  });

  test("M17: empty text content_block (single empty-string text_delta) flushes EMPTY output[]", () => {
    // F-M17-Discrim-1 HIGH coverage variant: a text_delta whose `text`
    // is the empty string still leaves builder.text === "". Same gate
    // applies — message_stop omits the empty message item.
    //
    // M17.5.1 F-M17.5-Discrim-1 (MEDIUM, EID `a0513d00e1dd234ef`)
    // strengthening: capture content_block_stop result and assert all
    // 3 per-block done events fire with full shape (mirror of test
    // above). The empty-string text_delta path should be observably
    // identical to the no-text_delta path at the per-block done layer.
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_empty2", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "" },
      },
      state,
    );
    const stopResult = run({ type: "content_block_stop", index: 0 }, state);
    // M17.5.1 strengthening: assert all 3 per-block done events fire
    // with full shape (must match no-text_delta variant — empty-string
    // delta is observably equivalent at the done layer).
    expect(stopResult.events_out).toHaveLength(3);
    const textDone = stopResult.events_out[0] as Record<string, unknown>;
    expect(textDone.type).toBe("response.output_text.done");
    expect(textDone.text).toBe("");
    expect(textDone.output_index).toBe(0);
    expect(textDone.content_index).toBe(0);
    const partDone = stopResult.events_out[1] as Record<string, unknown>;
    expect(partDone.type).toBe("response.content_part.done");
    expect(partDone.output_index).toBe(0);
    expect(partDone.content_index).toBe(0);
    expect(partDone.part).toEqual({ type: "output_text", text: "" });
    const itemDone = stopResult.events_out[2] as Record<string, unknown>;
    expect(itemDone.type).toBe("response.output_item.done");
    expect(itemDone.output_index).toBe(0);
    expect(itemDone.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([]);
    expect(state.assistantMessageBuilder).toBeNull();
  });

  test("M17: multi-text-block streams emit aligned ids (per-block added + done + terminal output[] all use FIRST builder id)", () => {
    // F-M17-Discrim-3 MEDIUM coverage (user choice option a): for a
    // multi-text-block stream, all three id surfaces — per-block
    // output_item.added.item.id, per-block output_item.done.item.id,
    // and the terminal response.completed.response.output[].id —
    // unify on the FIRST text block's allocated msg id (msg_0).
    // Codex CLI distinguishes blocks via output_index (which DOES
    // vary per block); item.id reflects the aggregation intent of R7.
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_multi_id", model: "x" } },
      state,
    );
    // First text block (idx=0 → output_index=0 → builder.id=msg_0).
    const start0 = run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    const added0 = start0.events_out[0] as Record<string, unknown>;
    const added0Item = added0.item as Record<string, unknown>;
    expect(added0.type).toBe("response.output_item.added");
    expect(added0Item.id).toBe("msg_0");
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Part one." },
      },
      state,
    );
    const stop0 = run({ type: "content_block_stop", index: 0 }, state);
    const done0 = stop0.events_out[2] as Record<string, unknown>;
    const done0Item = done0.item as Record<string, unknown>;
    expect(done0.type).toBe("response.output_item.done");
    expect(done0Item.id).toBe("msg_0");
    // Second text block (idx=1 → output_index=1, but builder.id
    // stays at msg_0 per no-overwrite invariant).
    const start1 = run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      state,
    );
    const added1 = start1.events_out[0] as Record<string, unknown>;
    const added1Item = added1.item as Record<string, unknown>;
    expect(added1.type).toBe("response.output_item.added");
    // M17.5 F-M17-Discrim-3: both text blocks' added events emit
    // msg_0 (NOT msg_1 — that would be the pre-M17.5 behavior).
    expect(added1Item.id).toBe("msg_0");
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " Part two." },
      },
      state,
    );
    const stop1 = run({ type: "content_block_stop", index: 1 }, state);
    const done1 = stop1.events_out[2] as Record<string, unknown>;
    const done1Item = done1.item as Record<string, unknown>;
    expect(done1.type).toBe("response.output_item.done");
    // M17.5 F-M17-Discrim-3: both text blocks' done events emit
    // msg_0 (NOT msg_1).
    expect(done1Item.id).toBe("msg_0");
    // Terminal output[] aggregation also uses msg_0 (R7).
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Part one. Part two.",
          annotations: [],
        },
      ],
    });
    // output_index per block is independent of item.id — verify the
    // codex-CLI block-boundary discriminator survives id alignment.
    expect(added0.output_index).toBe(0);
    expect(added1.output_index).toBe(1);
    expect(done0.output_index).toBe(0);
    expect(done1.output_index).toBe(1);
  });

  test("M17: per-block output_item.done emits full ResponsesMessageItem shape with multi-delta accumulated text", () => {
    // F-M17-Discrim-2 MEDIUM (second variant): the strengthened pre-
    // M17 unit test at lines 515-547 covers the empty-text case
    // (no text_delta). This test covers the multi-delta non-empty
    // case — per-block done event must carry the full closed
    // ResponsesMessageItem shape (id + role + status + content[])
    // with the accumulated text from multiple text_delta events.
    const state = initStreamState();
    run(
      { type: "message_start", message: { id: "resp_done_shape", model: "x" } },
      state,
    );
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      state,
    );
    const { events_out } = run({ type: "content_block_stop", index: 0 }, state);
    const doneEvt = events_out[2] as Record<string, unknown>;
    expect(doneEvt.type).toBe("response.output_item.done");
    expect(doneEvt.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello world", annotations: [] }],
    });
  });

  // -----------------------------------------------------------------------------
  // M17.5.1 post-exec discriminator iter-2 remediation tests.
  // -----------------------------------------------------------------------------
  // F-M17.5-Discrim-1 (MEDIUM, EID `a0513d00e1dd234ef`) coverage —
  // multi-text-block streams that include EMPTY text blocks. The two
  // existing M17.5 empty-text tests cover the single-block case; these
  // tests cover the multi-block variants where empty + non-empty
  // blocks interleave (variant a) and where ALL blocks are empty
  // (variant b). Per-block done events MUST fire for every block
  // regardless of payload — codex CLI requires per-block lifecycle
  // events to maintain its streaming state machine. Terminal output[]
  // aggregation is gated by total-text.length > 0 (F-M17-Discrim-1
  // fix from M17.5).

  test("M17.5.1: multi-text-block stream (first empty + second non-empty) — terminal output[] aggregates ONLY non-empty text under FIRST builder id", () => {
    // F-M17.5-Discrim-1 multi-block variant a: empty first block does
    // NOT suppress per-block done events for either block; terminal
    // output[] aggregates '' + 'hello' = 'hello' under msg_0 (FIRST
    // builder id per F-M17-Discrim-3 alignment + R7 aggregation).
    const state = initStreamState();
    run(
      {
        type: "message_start",
        message: { id: "resp_multi_empty_first", model: "x" },
      },
      state,
    );
    // First text block (idx=0) — EMPTY (no text_delta).
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    const stop0 = run({ type: "content_block_stop", index: 0 }, state);
    // Per-block done events fire for EMPTY first block.
    expect(stop0.events_out).toHaveLength(3);
    // M17.5.2 F-M17.5.1-Discrim-1 — deep-equal FULL event shape on
    // output_text.done + content_part.done (locks index fields against
    // silent regression that flips content_index / output_index).
    expect(stop0.events_out[0]).toEqual({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "",
    });
    expect(stop0.events_out[1]).toEqual({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    const itemDone0 = stop0.events_out[2] as Record<string, unknown>;
    expect(itemDone0.type).toBe("response.output_item.done");
    expect(itemDone0.output_index).toBe(0);
    expect(itemDone0.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    // Second text block (idx=1) — NON-EMPTY ('hello').
    run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      state,
    );
    run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "hello" },
      },
      state,
    );
    const stop1 = run({ type: "content_block_stop", index: 1 }, state);
    // Per-block done events fire for NON-EMPTY second block. item.id
    // is still msg_0 (FIRST builder id per F-M17-Discrim-3 alignment).
    expect(stop1.events_out).toHaveLength(3);
    // M17.5.2 F-M17.5.1-Discrim-1 — deep-equal FULL event shape on
    // output_text.done + content_part.done (locks output_index=1 +
    // content_index=0 against silent regression).
    expect(stop1.events_out[0]).toEqual({
      type: "response.output_text.done",
      output_index: 1,
      content_index: 0,
      text: "hello",
    });
    expect(stop1.events_out[1]).toEqual({
      type: "response.content_part.done",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "hello" },
    });
    const itemDone1 = stop1.events_out[2] as Record<string, unknown>;
    expect(itemDone1.type).toBe("response.output_item.done");
    expect(itemDone1.output_index).toBe(1);
    expect(itemDone1.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    });
    // Terminal output[] aggregates '' + 'hello' = 'hello' under msg_0.
    // Message item IS emitted because text.length > 0 after appending
    // the second block (the F-M17-Discrim-1 gate is satisfied by the
    // aggregator total, NOT by any individual block).
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([
      {
        type: "message",
        id: "msg_0",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ]);
    expect(state.assistantMessageBuilder).toBeNull();
  });

  test("M17.5.1: multi-text-block stream (both empty) — terminal output[] is [] but per-block done events still fire for both blocks", () => {
    // F-M17.5-Discrim-1 multi-block variant b: BOTH text blocks empty.
    // Per-block done events fire for both regardless (codex CLI state-
    // machine requirement); terminal output[] is [] because '' + '' =
    // '' fails the F-M17-Discrim-1 length gate. Per-block added events
    // for BOTH blocks use msg_0 as item.id (FIRST builder id alignment).
    const state = initStreamState();
    run(
      {
        type: "message_start",
        message: { id: "resp_multi_both_empty", model: "x" },
      },
      state,
    );
    // First text block (idx=0) — EMPTY. Capture added event.
    const start0 = run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      state,
    );
    const added0 = start0.events_out[0] as Record<string, unknown>;
    const added0Item = added0.item as Record<string, unknown>;
    expect(added0.type).toBe("response.output_item.added");
    expect(added0Item.id).toBe("msg_0");
    expect(added0.output_index).toBe(0);
    const stop0 = run({ type: "content_block_stop", index: 0 }, state);
    expect(stop0.events_out).toHaveLength(3);
    // M17.5.2 F-M17.5.1-Discrim-1 — deep-equal FULL event shape on
    // output_text.done + content_part.done (locks index fields against
    // silent regression; mirrors first-test stop0).
    expect(stop0.events_out[0]).toEqual({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "",
    });
    expect(stop0.events_out[1]).toEqual({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    const itemDone0 = stop0.events_out[2] as Record<string, unknown>;
    expect(itemDone0.type).toBe("response.output_item.done");
    expect(itemDone0.output_index).toBe(0);
    expect(itemDone0.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    // Second text block (idx=1) — EMPTY. Capture added event.
    const start1 = run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      state,
    );
    const added1 = start1.events_out[0] as Record<string, unknown>;
    const added1Item = added1.item as Record<string, unknown>;
    expect(added1.type).toBe("response.output_item.added");
    // F-M17-Discrim-3 alignment: second-block added.id is msg_0 (NOT
    // msg_1 — that would be the pre-M17.5 behavior).
    expect(added1Item.id).toBe("msg_0");
    expect(added1.output_index).toBe(1);
    const stop1 = run({ type: "content_block_stop", index: 1 }, state);
    expect(stop1.events_out).toHaveLength(3);
    // M17.5.2 F-M17.5.1-Discrim-1 — deep-equal FULL event shape on
    // output_text.done + content_part.done (locks output_index=1 +
    // content_index=0 against silent regression even when text is "").
    expect(stop1.events_out[0]).toEqual({
      type: "response.output_text.done",
      output_index: 1,
      content_index: 0,
      text: "",
    });
    expect(stop1.events_out[1]).toEqual({
      type: "response.content_part.done",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    const itemDone1 = stop1.events_out[2] as Record<string, unknown>;
    expect(itemDone1.type).toBe("response.output_item.done");
    expect(itemDone1.output_index).toBe(1);
    expect(itemDone1.item).toEqual({
      type: "message",
      id: "msg_0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
    // Terminal output[] is [] — '' + '' = '' fails the length gate.
    const { events_out } = run({ type: "message_stop" }, state);
    const completed = events_out[0] as Record<string, unknown>;
    const resp = completed.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toEqual([]);
    expect(state.assistantMessageBuilder).toBeNull();
  });
});
