/**
 * translate_responses_event_to_anthropic_event.test.ts — per-event-type
 * unit tests + idempotency + lifecycle + small fixture replay.
 *
 * Lane covered: **CC→GPT-5.x — response side** (per addendum §7).
 *
 * Tests are scoped per-event-type: schema, response.created /
 * response.in_progress (idempotent message_start), output_text delta /
 * done, function_call_arguments delta / done,
 * output_item.added (function_call), output_item.done (defensive close),
 * content_part.added/done (drops), response.completed (with/without
 * tool_calls), unknown / null / empty events, full sequence parity.
 *
 * **M7b.6 default-passthrough refactor (D-LOCK-1 / D-LOCK-7 / D-LOCK-11) +
 * D30 (iter-3 followup symmetry).** UNMAPPABLE events
 * (no Anthropic equivalent — `response.content_part.added`,
 * `response.content_part.done`, unknown top-level event types) return
 * `applied: false`. Engine `apply_event.ts:237-240` default-passthrough
 * then forwards the original event unchanged.
 *   - Pattern A (translator-level): assert `result.applied === false`
 *     AND `result.events_out === []`.
 *   - Pattern B (engine-level via applyEvent): assert
 *     `events_out === [originalEvent]`.
 * CONSUMED-INTO-STATE (D-LOCK-2(b), e.g., idempotent
 * `response.in_progress` guard; `output_item.added(message)`) and
 * DEFENSIVE NO-OP (D-LOCK-2(c)/(d)/(e), e.g., no-block-open guards,
 * malformed-input guard, close-only on unknown item.type — including
 * `output_item.added(unknown string item.type)` per D30, symmetric with
 * `output_item.done(unknown)`)
 * sites continue to return `applied: true`.
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
import "~/lib/transform/translate_responses_event_to_anthropic_event";
import {
  TranslateResponsesEventToAnthropicEventSchema,
  translate_responses_event_to_anthropic_event,
} from "~/lib/transform/translate_responses_event_to_anthropic_event";
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
    route: "/v1/messages",
    model: "gpt-5.5-2026-04-23",
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
  const r = translate_responses_event_to_anthropic_event(ctx, {
    name: "t",
    use: "translate_responses_event_to_anthropic_event",
  });
  return { events_out: r.events_out, applied: r.applied, state: s };
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — schema", () => {
  test("minimal valid config", () => {
    const r = TranslateResponsesEventToAnthropicEventSchema.safeParse({
      name: "x",
      use: "translate_responses_event_to_anthropic_event",
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
      const r = TranslateResponsesEventToAnthropicEventSchema.safeParse({
        name: "x",
        use: "translate_responses_event_to_anthropic_event",
        on_error: oe,
      });
      expect(r.success).toBe(true);
    }
  });

  test("invalid use literal rejected", () => {
    const r = TranslateResponsesEventToAnthropicEventSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Empty-event safety (D-LOCK-12)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — empty-event safety", () => {
  test("null event returns empty events_out", () => {
    const ctx = makeCtx(null as unknown as AnyEvent);
    const r = translate_responses_event_to_anthropic_event(ctx, {});
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(false);
  });

  test("event without type returns empty events_out", () => {
    const ctx = makeCtx({} as AnyEvent);
    const r = translate_responses_event_to_anthropic_event(ctx, {});
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(false);
  });

  test("unknown event type returns applied:false (M7b.6 D-LOCK-1 default-passthrough — Pattern A)", () => {
    // M7b.6 refactor: translator returns applied:false; engine
    // default-passthrough at apply_event.ts:237-240 forwards the
    // original event unchanged. Pattern B test below verifies engine.
    const event: AnyEvent = { type: "response.future_event", foo: "bar" };
    const { events_out, applied } = run(event);
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
  });

  test("response.content_part.added is UNMAPPABLE → applied:false (M7b.6 D-LOCK-1 — Pattern A)", () => {
    const { events_out, applied } = run({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text" },
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
  });

  test("response.content_part.done is UNMAPPABLE → applied:false (M7b.6 D-LOCK-1 — Pattern A)", () => {
    const { events_out, applied } = run({
      type: "response.content_part.done",
      output_index: 0,
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// response.created / response.in_progress (idempotent message_start)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — response.created (idempotent message_start)", () => {
  test("first response.created emits message_start", () => {
    const { events_out, state } = run({
      type: "response.created",
      response: { id: "resp_abc", model: "gpt-5.5" },
    });
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("message_start");
    const msg = (events_out[0] as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(msg.id).toBe("resp_abc");
    expect(msg.model).toBe("gpt-5.5");
    expect(msg.role).toBe("assistant");
    expect(msg.type).toBe("message");
    expect(msg.content).toEqual([]);
    expect(state.messageStartSent).toBe(true);
    expect(state.responseId).toBe("resp_abc");
    expect(state.model).toBe("gpt-5.5");
  });

  test("response.in_progress emits message_start when not already sent", () => {
    const { events_out, state } = run({
      type: "response.in_progress",
      response: { id: "resp_q", model: "gpt-5.5" },
    });
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("message_start");
    expect(state.messageStartSent).toBe(true);
  });

  test("BACK-TO-BACK response.created + response.in_progress emits message_start ONLY ONCE (idempotency); duplicate is CONSUMED-INTO-STATE per M7b.6 D-LOCK-2(b) — applied:true", () => {
    const state = initStreamState();
    const r1 = run(
      {
        type: "response.created",
        response: { id: "resp_x", model: "gpt-5.5" },
      },
      state,
    );
    const r2 = run(
      {
        type: "response.in_progress",
        response: { id: "resp_x", model: "gpt-5.5" },
      },
      state,
    );
    expect(r1.events_out).toHaveLength(1);
    expect(r2.events_out).toEqual([]);
    // M7b.6 D-LOCK-2(b): duplicate suppressed with applied:true so
    // engine does NOT default-passthrough an Anthropic-irrelevant event.
    expect(r2.applied).toBe(true);
    expect(state.messageStartSent).toBe(true);
  });

  test("missing response.id falls back to msg_<ts>", () => {
    const { events_out } = run({
      type: "response.created",
      response: { model: "gpt-5.5" },
    });
    const msg = (events_out[0] as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(typeof msg.id).toBe("string");
    expect((msg.id as string).startsWith("msg_")).toBe(true);
  });

  test("missing response field at all still emits message_start (defensive)", () => {
    const { events_out, state } = run({ type: "response.created" });
    expect(events_out).toHaveLength(1);
    expect(state.messageStartSent).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// response.output_text.delta / done
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — output_text.delta", () => {
  test("first delta emits content_block_start (text) + content_block_delta", () => {
    const { events_out, state } = run({
      type: "response.output_text.delta",
      output_index: 0,
      delta: "Hello",
    });
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("content_block_start");
    const cb = (events_out[0] as Record<string, unknown>)
      .content_block as Record<string, unknown>;
    expect(cb.type).toBe("text");
    expect(events_out[1]?.type).toBe("content_block_delta");
    const d = (events_out[1] as Record<string, unknown>).delta as Record<
      string,
      unknown
    >;
    expect(d.type).toBe("text_delta");
    expect(d.text).toBe("Hello");
    expect(state.contentBlockOpen).toBe(true);
    expect(state.currentToolType).toBe("text");
  });

  test("subsequent deltas only emit content_block_delta (block already open)", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.currentToolType = "text";
    const { events_out } = run(
      { type: "response.output_text.delta", delta: " world" },
      state,
    );
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_delta");
  });

  test("output_text.done emits content_block_stop and bumps contentBlockIndex", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.currentToolType = "text";
    state.contentBlockIndex = 2;
    const { events_out } = run({ type: "response.output_text.done" }, state);
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_stop");
    expect((events_out[0] as Record<string, unknown>).index).toBe(2);
    expect(state.contentBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBe(3);
  });

  test("output_text.done is DEFENSIVE NO-OP when no block is open (M7b.6 D-LOCK-2(d) per iter-3 H1) — applied:true", () => {
    const { events_out, applied } = run({ type: "response.output_text.done" });
    expect(events_out).toEqual([]);
    // M7b.6 D-LOCK-2(d): no-block-open guard suppressed with applied:true
    // so engine does NOT default-passthrough an Anthropic-irrelevant event.
    expect(applied).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// response.output_item.added / .done (function_call)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — output_item (function_call)", () => {
  test("output_item.added (function_call) caches call_id + name AND eagerly emits content_block_start (M7b.5 F3)", () => {
    const { events_out, state } = run({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_abc",
        call_id: "call_abc",
        name: "WebSearch",
      },
    });
    // M7b.5 F3 eager open.
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_start");
    const cb = (events_out[0] as Record<string, unknown>)
      .content_block as Record<string, unknown>;
    expect(cb.type).toBe("tool_use");
    expect(cb.id).toBe("call_abc");
    expect(cb.name).toBe("WebSearch");
    expect(cb.input).toEqual({});
    expect(state.currentToolCallId).toBe("call_abc");
    expect(state.currentToolName).toBe("WebSearch");
    expect(state.contentBlockOpen).toBe(true);
    expect(state.currentToolType).toBe("tool_use");
    expect(state.toolArgsBuffer).toBe("");
  });

  test("output_item.added (function_call) prefers call_id over id", () => {
    const { events_out: e, state } = run({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_a", call_id: "ci_b", name: "X" },
    });
    expect(state.currentToolCallId).toBe("ci_b");
    const cb = (e[0] as Record<string, unknown>).content_block as Record<
      string,
      unknown
    >;
    expect(cb.id).toBe("ci_b");
  });

  test("output_item.added (function_call) falls back to id when call_id missing", () => {
    const { state } = run({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_only", name: "X" },
    });
    expect(state.currentToolCallId).toBe("fc_only");
  });

  test("output_item.added (function_call) with NO id and NO call_id falls back to toolu_<ts>", () => {
    const { state } = run({
      type: "response.output_item.added",
      item: { type: "function_call", name: "X" },
    });
    expect(typeof state.currentToolCallId).toBe("string");
    expect((state.currentToolCallId as string).startsWith("toolu_")).toBe(true);
  });

  test("output_item.added (function_call) with NO name falls back to 'unknown'", () => {
    const { state } = run({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_x" },
    });
    expect(state.currentToolName).toBe("unknown");
  });

  test("output_item.added (message) is CONSUMED-INTO-STATE (M7b.6 D-LOCK-2(b)) — applied:true, no events; text path is lazy on first delta", () => {
    const { events_out, applied, state } = run({
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1", role: "assistant" },
    });
    expect(events_out).toEqual([]);
    // M7b.6 D-LOCK-2(b): CONSUMED-INTO-STATE; suppressed with
    // applied:true so engine does NOT default-passthrough. The
    // Anthropic block opens lazily via handleOutputTextDelta.
    expect(applied).toBe(true);
    expect(state.currentToolCallId).toBeNull();
  });

  test("output_item.added (malformed item — non-object item.type) is DEFENSIVE NO-OP (M7b.6 D-LOCK-2(d)) — applied:true", () => {
    const { events_out, applied } = run({
      type: "response.output_item.added",
      item: { id: "x" }, // no .type field at all → undefined
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(true);
  });

  test("output_item.added (malformed item — numeric item.type) is DEFENSIVE NO-OP (M7b.6 D-LOCK-2(d)) — applied:true", () => {
    const { events_out, applied } = run({
      type: "response.output_item.added",
      item: { type: 42 },
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(true);
  });

  test("output_item.added (known string item.type, e.g. web_search_call) is close-only suppressed (M7b.6 D-LOCK-2(e) per D30 — symmetric with output_item.done(unknown)) — applied:true, no events", () => {
    const { events_out, applied } = run({
      type: "response.output_item.added",
      item: { type: "web_search_call", id: "ws_1" },
    });
    expect(events_out).toEqual([]);
    // D30 (iter-3 followup): was applied:false UNMAPPABLE pre-D30; now
    // close-only per D-LOCK-2(e). Suppression preserves Anthropic-shape
    // downstream invariant per D9 (don't-leak-foreign-protocol).
    expect(applied).toBe(true);
  });

  test("output_item.done (function_call) clears cached tool fields + toolArgsBuffer", () => {
    const state = initStreamState();
    state.currentToolCallId = "ci_x";
    state.currentToolName = "Tool";
    state.toolArgsBuffer = '{"a":1}';
    const { events_out } = run(
      { type: "response.output_item.done", item: { type: "function_call" } },
      state,
    );
    expect(events_out).toEqual([]);
    expect(state.currentToolCallId).toBeNull();
    expect(state.currentToolName).toBeNull();
    expect(state.toolArgsBuffer).toBe("");
  });

  test("output_item.done DEFENSIVELY closes a still-open block", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 1;
    const { events_out } = run(
      { type: "response.output_item.done", item: { type: "message" } },
      state,
    );
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_stop");
    expect(state.contentBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBe(2);
  });

  test("output_item.added (function_call) defensively closes a still-open prior block (rare malformed-stream guard)", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 0;
    const { events_out } = run(
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_x", name: "X" },
      },
      state,
    );
    // Defensive close + new open = 2 events.
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("content_block_stop");
    expect((events_out[0] as Record<string, unknown>).index).toBe(0);
    expect(events_out[1]?.type).toBe("content_block_start");
    expect((events_out[1] as Record<string, unknown>).index).toBe(1);
    expect(state.contentBlockOpen).toBe(true);
    expect(state.contentBlockIndex).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// response.function_call_arguments.delta / .done
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — function_call_arguments", () => {
  test("first arg delta after eager-open emits content_block_delta only (block already opened in output_item.added)", () => {
    const state = initStreamState();
    // Drive a real output_item.added first (eager-open per F3).
    run(
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_abc",
          call_id: "call_abc",
          name: "WebSearch",
        },
      },
      state,
    );
    expect(state.contentBlockOpen).toBe(true);
    const { events_out } = run(
      {
        type: "response.function_call_arguments.delta",
        delta: '{"q',
      },
      state,
    );
    // Eager-open already happened — only the delta is emitted now.
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_delta");
    const d = (events_out[0] as Record<string, unknown>).delta as Record<
      string,
      unknown
    >;
    expect(d.type).toBe("input_json_delta");
    expect(d.partial_json).toBe('{"q');
    // toolArgsBuffer was appended (F3 zero-delta detection support).
    expect(state.toolArgsBuffer).toBe('{"q');
  });

  test("subsequent arg deltas only emit content_block_delta (passthrough partial_json) AND append to buffer", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.currentToolType = "tool_use";
    state.toolArgsBuffer = '{"q';
    const { events_out } = run(
      {
        type: "response.function_call_arguments.delta",
        delta: 'uery":"py"}',
      },
      state,
    );
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_delta");
    expect(state.toolArgsBuffer).toBe('{"query":"py"}');
  });

  test("function_call_arguments.done with non-empty buffer emits ONLY content_block_stop", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 0;
    state.toolArgsBuffer = '{"q":"x"}';
    const { events_out } = run(
      { type: "response.function_call_arguments.done", arguments: '{"q":"x"}' },
      state,
    );
    expect(events_out).toHaveLength(1);
    expect(events_out[0]?.type).toBe("content_block_stop");
    expect(state.contentBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBe(1);
    expect(state.toolArgsBuffer).toBe("");
  });

  test("function_call_arguments.done with EMPTY buffer SYNTHESIZES input_json_delta from event.arguments (M7b.5 F3)", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 0;
    state.toolArgsBuffer = "";
    const { events_out } = run(
      {
        type: "response.function_call_arguments.done",
        arguments: '{"a":1}',
      },
      state,
    );
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("content_block_delta");
    const d = (events_out[0] as Record<string, unknown>).delta as Record<
      string,
      unknown
    >;
    expect(d.type).toBe("input_json_delta");
    expect(d.partial_json).toBe('{"a":1}');
    expect(events_out[1]?.type).toBe("content_block_stop");
  });

  test("function_call_arguments.done with EMPTY buffer AND missing event.arguments synthesizes '{}' (M7b.5 F3)", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 0;
    state.toolArgsBuffer = "";
    const { events_out } = run(
      { type: "response.function_call_arguments.done" },
      state,
    );
    expect(events_out).toHaveLength(2);
    const d = (events_out[0] as Record<string, unknown>).delta as Record<
      string,
      unknown
    >;
    expect(d.partial_json).toBe("{}");
    expect(events_out[1]?.type).toBe("content_block_stop");
  });

  test("function_call_arguments.done is DEFENSIVE NO-OP when no block is open (M7b.6 D-LOCK-2(d) per iter-3 H1) — applied:true", () => {
    const { events_out, applied } = run({
      type: "response.function_call_arguments.done",
    });
    expect(events_out).toEqual([]);
    expect(applied).toBe(true);
  });

  test("first arg delta with NO state.currentToolCallId (defensive lazy-open) falls back to item_id then to toolu_<ts>", () => {
    const { events_out: e1 } = run({
      type: "response.function_call_arguments.delta",
      item_id: "itm_xyz",
      delta: "{}",
    });
    // Defensive lazy-open path emits start + delta.
    expect(e1).toHaveLength(2);
    const cb1 = (e1[0] as Record<string, unknown>).content_block as Record<
      string,
      unknown
    >;
    expect(cb1.id).toBe("itm_xyz");

    const { events_out: e2 } = run({
      type: "response.function_call_arguments.delta",
      delta: "{}",
    });
    expect(e2).toHaveLength(2);
    const cb2 = (e2[0] as Record<string, unknown>).content_block as Record<
      string,
      unknown
    >;
    expect(typeof cb2.id).toBe("string");
    expect((cb2.id as string).startsWith("toolu_")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// response.completed
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — response.completed", () => {
  test("emits message_delta + message_stop (text-only stop_reason: end_turn)", () => {
    const { events_out } = run({
      type: "response.completed",
      response: { usage: { output_tokens: 25 }, output: [] },
    });
    expect(events_out).toHaveLength(2);
    expect(events_out[0]?.type).toBe("message_delta");
    const md = events_out[0] as Record<string, unknown>;
    expect(md.usage).toEqual({ output_tokens: 25 });
    const delta = md.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("end_turn");
    expect(delta.stop_sequence).toBeNull();
    expect(events_out[1]?.type).toBe("message_stop");
  });

  test("emits stop_reason: tool_use when output[] contains a function_call", () => {
    const { events_out } = run({
      type: "response.completed",
      response: {
        usage: { output_tokens: 10 },
        output: [
          { type: "message", id: "msg_1" },
          { type: "function_call", id: "fc_1", call_id: "ci_1", name: "X" },
        ],
      },
    });
    const md = events_out[0] as Record<string, unknown>;
    const delta = md.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("tool_use");
  });

  test("DEFENSIVELY closes any still-open block before emitting message_delta", () => {
    const state = initStreamState();
    state.contentBlockOpen = true;
    state.contentBlockIndex = 0;
    const { events_out } = run(
      {
        type: "response.completed",
        response: { usage: { output_tokens: 1 }, output: [] },
      },
      state,
    );
    // content_block_stop, message_delta, message_stop = 3 events.
    expect(events_out).toHaveLength(3);
    expect(events_out[0]?.type).toBe("content_block_stop");
    expect(events_out[1]?.type).toBe("message_delta");
    expect(events_out[2]?.type).toBe("message_stop");
    expect(state.contentBlockOpen).toBe(false);
  });

  test("missing usage → output_tokens defaults to 0", () => {
    const { events_out } = run({
      type: "response.completed",
      response: {},
    });
    const md = events_out[0] as Record<string, unknown>;
    expect(md.usage).toEqual({ output_tokens: 0 });
  });

  test("calls releaseStreamState when state.requestId is set (D-LOCK-3 lifecycle)", () => {
    const state = acquireStreamState("req-rsp-stop");
    const ctx = makeCtx({ type: "response.completed", response: {} }, state);
    translate_responses_event_to_anthropic_event(ctx, {});
    // Re-acquire returns NEW instance.
    const reacquired = acquireStreamState("req-rsp-stop");
    expect(reacquired).not.toBe(state);
  });
});

// -----------------------------------------------------------------------------
// Full sequence (text-only happy path)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — full text-only sequence", () => {
  test("end-to-end: response.created → in_progress → output_item.added(message) → text.delta(x3) → text.done → output_item.done(message) → response.completed", () => {
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_seq", model: "gpt-5.5" },
      },
      {
        type: "response.in_progress",
        response: { id: "resp_seq", model: "gpt-5.5" },
      },
      {
        type: "response.output_item.added",
        item: { type: "message", id: "msg_0" },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: "Hello",
      },
      { type: "response.output_text.delta", output_index: 0, delta: ", " },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: "world!",
      },
      { type: "response.output_text.done", output_index: 0 },
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
      },
      {
        type: "response.output_item.done",
        item: { type: "message", id: "msg_0" },
      },
      {
        type: "response.completed",
        response: { usage: { output_tokens: 6 }, output: [] },
      },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    // Expect (in order):
    //   message_start, content_block_start, 3 content_block_delta,
    //   content_block_stop, message_delta, message_stop.
    // Note: response.in_progress emits NOTHING (idempotent guard).
    // Note: output_item.added(message) is a no-op (lazy text-block open).
    // Note: content_part.added/done are UNMAPPABLE per D-LOCK-2(a) —
    //   translator returns applied:false; engine default-passthrough at
    //   apply_event.ts:237-240 emits the original event downstream. This
    //   `run()` helper bypasses the engine and asserts ONLY translator
    //   output (events_out from the rule itself), so the passthrough does
    //   NOT appear here. See the Pattern B engine-level full-sequence
    //   test below for the post-engine verification (mixed translated +
    //   passthrough output).
    // Note: output_item.done(message) is a no-op (block already closed
    //   by output_text.done above).
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(state.contentBlockIndex).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Full sequence (tool_use happy path)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — full tool_use sequence", () => {
  test("end-to-end: response.created → output_item.added(function_call) → fn_args.delta(x2) → fn_args.done → output_item.done → response.completed (with function_call in output)", () => {
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_tool", model: "gpt-5.5" },
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "ci_1",
          name: "Search",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        delta: '{"q":"',
      },
      {
        type: "response.function_call_arguments.delta",
        delta: 'hello"}',
      },
      {
        type: "response.function_call_arguments.done",
        arguments: '{"q":"hello"}',
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "ci_1",
          name: "Search",
        },
      },
      {
        type: "response.completed",
        response: {
          usage: { output_tokens: 8 },
          output: [
            {
              type: "function_call",
              id: "fc_1",
              call_id: "ci_1",
              name: "Search",
            },
          ],
        },
      },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    // M7b.5 F3: content_block_start now fires on output_item.added
    // (eager-open) instead of on the first delta.
    expect(types).toEqual([
      "message_start",
      // output_item.added(function_call) emits the eager content_block_start (F3)
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      // output_item.done is a no-op now (block already closed by args.done)
      "message_delta",
      "message_stop",
    ]);
    // stop_reason should be tool_use because output[] has a function_call.
    const md = allEvents.find(
      (e) => (e as Record<string, unknown>).type === "message_delta",
    ) as Record<string, unknown>;
    const delta = md.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("tool_use");
    // Block index advanced.
    expect(state.contentBlockIndex).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// M7b.5 F3 — zero-delta function_call regression
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — M7b.5 F3 zero-delta function_call", () => {
  test("zero-delta function_call (parameterless tool) STILL emits a complete tool_use block with synthesized input_json_delta", () => {
    // Spec § F3 test 1. Stream: created → output_item.added(function_call) →
    // function_call_arguments.done(arguments="{}") → output_item.done →
    // completed. NO *.delta in between (parameterless tool like
    // get_current_time()).
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_zero", model: "gpt-5.5" },
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "tc_1",
          call_id: "tc_1",
          name: "now",
        },
      },
      // NO function_call_arguments.delta events.
      {
        type: "response.function_call_arguments.done",
        arguments: "{}",
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "tc_1",
          call_id: "tc_1",
          name: "now",
        },
      },
      {
        type: "response.completed",
        response: {
          usage: { output_tokens: 1 },
          output: [
            {
              type: "function_call",
              id: "tc_1",
              call_id: "tc_1",
              name: "now",
            },
          ],
        },
      },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    // F3 fix: must contain message_start, content_block_start (tool_use, tc_1, now),
    // content_block_delta (input_json_delta, "{}"), content_block_stop,
    // message_delta, message_stop — IN THAT ORDER.
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Verify the content_block_start carries the right tool_use shape.
    const cbStart = allEvents[1] as Record<string, unknown>;
    const cb = cbStart.content_block as Record<string, unknown>;
    expect(cb.type).toBe("tool_use");
    expect(cb.id).toBe("tc_1");
    expect(cb.name).toBe("now");
    expect(cb.input).toEqual({});
    // Verify the synthesized input_json_delta carries "{}" (from event.arguments).
    const cbDelta = allEvents[2] as Record<string, unknown>;
    const d = cbDelta.delta as Record<string, unknown>;
    expect(d.type).toBe("input_json_delta");
    expect(d.partial_json).toBe("{}");
    // Verify message_delta has stop_reason: tool_use AND the preceding
    // tool_use block was actually emitted (no protocol violation).
    const md = allEvents[4] as Record<string, unknown>;
    const mdDelta = md.delta as Record<string, unknown>;
    expect(mdDelta.stop_reason).toBe("tool_use");
  });

  test("nonzero-delta function_call STILL works (regression check on F3 fix)", () => {
    // Same as the full tool_use sequence test above; this test is the
    // F3 spec § test 2 marker — explicit guard against regression on
    // the existing path.
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_norm", model: "gpt-5.5" },
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_n",
          call_id: "ci_n",
          name: "Search",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        delta: '{"q":1}',
      },
      {
        type: "response.function_call_arguments.done",
        arguments: '{"q":1}',
      },
      { type: "response.output_item.done", item: { type: "function_call" } },
      {
        type: "response.completed",
        response: {
          usage: { output_tokens: 5 },
          output: [{ type: "function_call", id: "fc_n", name: "Search" }],
        },
      },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    // No synthesized delta (buffer was non-empty); just one delta.
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("zero-delta function_call with NON-EMPTY arguments at done time → those args reach the client (M7b.5 F3 spec test 3)", () => {
    const state = initStreamState();
    const allEvents: AnyEvent[] = [];
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_arg", model: "gpt-5.5" },
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "fc_a",
          name: "Compute",
        },
      },
      // No deltas.
      {
        type: "response.function_call_arguments.done",
        arguments: '{"a":1,"b":2}',
      },
      { type: "response.output_item.done", item: { type: "function_call" } },
      {
        type: "response.completed",
        response: {
          usage: { output_tokens: 1 },
          output: [{ type: "function_call", id: "fc_a", name: "Compute" }],
        },
      },
    ] as AnyEvent[]) {
      const r = run(event, state);
      allEvents.push(...r.events_out);
    }
    // Find the synthesized input_json_delta and assert its payload matches
    // event.arguments.
    const delta = allEvents.find((e) => {
      const r = e as Record<string, unknown>;
      if (r.type !== "content_block_delta") return false;
      const d = r.delta as Record<string, unknown>;
      return d.type === "input_json_delta";
    }) as Record<string, unknown>;
    expect(delta).toBeDefined();
    const d = delta.delta as Record<string, unknown>;
    expect(d.partial_json).toBe('{"a":1,"b":2}');
  });
});

// -----------------------------------------------------------------------------
// Engine integration via applyEvent (mini-audit 35)
// -----------------------------------------------------------------------------

describe("translate_responses_event_to_anthropic_event — engine integration", () => {
  test("apply_event pipes a hand-crafted response.created through the registered rule and returns the translated message_start", async () => {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      translate_responses_event_to_anthropic_event,
      TranslateResponsesEventToAnthropicEventSchema,
      {
        allow_override: true,
        reads: ["messageStartSent"],
        writes: ["messageStartSent", "responseId", "model"],
      },
    );
    const reg = snapshot("stream_event");
    const state = initStreamState();
    const ctx: StreamEventContext = {
      event: {
        type: "response.created",
        response: { id: "resp_int", model: "gpt-5.5" },
      },
      state,
      route: "/v1/messages",
      model: "gpt-5.5",
    };
    const result = applyEvent(
      ctx,
      [
        {
          name: "t",
          use: "translate_responses_event_to_anthropic_event",
        },
      ],
      reg,
    );
    expect(result.events_out).toHaveLength(1);
    expect(result.events_out[0]?.type).toBe("message_start");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.writes).toContain("messageStartSent");
  });

  test("apply_event default-passthrough fires when the rule returns events_out: [] AND applied: false (M7b.6 D-LOCK-1 — Pattern B for unknown event type)", async () => {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      translate_responses_event_to_anthropic_event,
      TranslateResponsesEventToAnthropicEventSchema,
      { allow_override: true },
    );
    const reg = snapshot("stream_event");
    const originalEvent: AnyEvent = {
      type: "response.future_event",
      payload: 1,
    };
    const ctx: StreamEventContext = {
      event: originalEvent,
      state: initStreamState(),
      route: "/v1/messages",
      model: "gpt-5.5",
    };
    const result = applyEvent(
      ctx,
      [
        {
          name: "t",
          use: "translate_responses_event_to_anthropic_event",
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

describe("translate_responses_event_to_anthropic_event — M7b.6 Pattern B engine default-passthrough", () => {
  // Per D-LOCK-11: NEW Pattern B test per UNMAPPABLE event type.

  async function pipeThroughEngine(
    event: AnyEvent,
    state: StreamState,
  ): Promise<{ events_out: AnyEvent[]; applied_count: number }> {
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      translate_responses_event_to_anthropic_event,
      TranslateResponsesEventToAnthropicEventSchema,
      { allow_override: true },
    );
    const reg = snapshot("stream_event");
    const ctx: StreamEventContext = {
      event,
      state,
      route: "/v1/messages",
      model: "gpt-5.5",
    };
    const result = applyEvent(
      ctx,
      [{ name: "t", use: "translate_responses_event_to_anthropic_event" }],
      reg,
    );
    return {
      events_out: result.events_out,
      applied_count: result.applied.length,
    };
  }

  test("Pattern B: response.content_part.added → engine emits original (default-passthrough)", async () => {
    const state = acquireStreamState("test-rev-engine-passthrough-cp-added");
    const ev: AnyEvent = {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
  });

  test("Pattern B: response.content_part.done → engine emits original (default-passthrough)", async () => {
    const state = acquireStreamState("test-rev-engine-passthrough-cp-done");
    const ev: AnyEvent = {
      type: "response.content_part.done",
      output_index: 0,
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
  });

  test("Pattern B: output_item.added(known string item.type — web_search_call) → engine SUPPRESSES (close-only per D30; NO default-passthrough)", async () => {
    const state = acquireStreamState(
      "test-rev-engine-suppressed-unknown-item-type",
    );
    const ev: AnyEvent = {
      type: "response.output_item.added",
      item: { type: "web_search_call", id: "ws_1" },
    };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    // D30 (iter-3 followup): rule returns applied:true with events_out:[]
    // (close-only per D-LOCK-2(e)). Engine sees anyFired=true and does
    // NOT default-passthrough. The original Responses-shaped event is
    // jointly invisible with the matching output_item.done(unknown).
    expect(events_out).toEqual([]);
    expect(applied_count).toBe(1);
  });

  test("Pattern B: unknown top-level event type → engine emits original (default-passthrough)", async () => {
    const state = acquireStreamState(
      "test-rev-engine-passthrough-unknown-toplevel",
    );
    const ev: AnyEvent = { type: "response.totally_unknown", x: 1 };
    const { events_out, applied_count } = await pipeThroughEngine(ev, state);
    expect(events_out).toEqual([ev]);
    expect(applied_count).toBe(0);
  });

  test("Pattern B FULL-SEQUENCE: mixed translator-emit + UNMAPPABLE passthrough through applyEvent (NOT run()) — verifies real translated+passthrough output sequence per D-LOCK-11", async () => {
    // F36 discipline (D-LOCK-9): acquire StreamState ONCE for the whole
    // sequence. State transitions are the SUT's job (translator + engine);
    // tests MUST NOT mutate state between events.
    const { applyEvent } = await import("~/lib/transform/apply_event");
    const { snapshot, registerStreamEvent } =
      await import("~/lib/transform/registry");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      translate_responses_event_to_anthropic_event,
      TranslateResponsesEventToAnthropicEventSchema,
      { allow_override: true },
    );
    const reg = snapshot("stream_event");
    const state = acquireStreamState("test-rev-engine-fullseq-mixed");

    // Mix translator-emitting events (response.created, output_text.delta,
    // output_text.done, response.completed) with UNMAPPABLE events
    // (content_part.added/done) that exercise the engine
    // default-passthrough path. The output must contain BOTH the
    // translated Anthropic-shape events AND the original Responses-shape
    // content_part.* events (interleaved per stream order).
    const cpAdded: AnyEvent = {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text" },
    };
    const cpDone: AnyEvent = {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
    };
    const sequence: AnyEvent[] = [
      {
        type: "response.created",
        response: { id: "resp_mix", model: "gpt-5.5" },
      },
      cpAdded,
      { type: "response.output_text.delta", output_index: 0, delta: "Hi" },
      cpDone,
      { type: "response.output_text.done", output_index: 0 },
      {
        type: "response.completed",
        response: { usage: { output_tokens: 1 }, output: [] },
      },
    ];

    const allEvents: AnyEvent[] = [];
    for (const event of sequence) {
      const ctx: StreamEventContext = {
        event,
        state,
        route: "/v1/messages",
        model: "gpt-5.5",
      };
      const result = applyEvent(
        ctx,
        [{ name: "t", use: "translate_responses_event_to_anthropic_event" }],
        reg,
      );
      for (const ev of result.events_out) allEvents.push(ev);
    }

    const types = allEvents.map((e) => (e as Record<string, unknown>).type);
    // Expected interleave (per stream order):
    //   1. response.created → message_start (translated)
    //   2. content_part.added → response.content_part.added (passthrough)
    //   3. output_text.delta → content_block_start + content_block_delta (translated)
    //   4. content_part.done → response.content_part.done (passthrough)
    //   5. output_text.done → content_block_stop (translated)
    //   6. response.completed → message_delta + message_stop (translated)
    expect(types).toEqual([
      "message_start",
      "response.content_part.added",
      "content_block_start",
      "content_block_delta",
      "response.content_part.done",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Verify the passthrough events are the exact original objects
    // (not mutated, not deep-copied to a different shape) — guards
    // against a future regression where someone changes the inline
    // switch case to fall through to a wrapping default that applies
    // `true` (which would suppress the passthrough).
    expect(allEvents[1]).toBe(cpAdded);
    expect(allEvents[4]).toBe(cpDone);
  });
});

describe("translate_responses_event_to_anthropic_event — lifecycle (mini-audit 14)", () => {
  test("100 streams run to completion → map is empty afterwards", async () => {
    const { _streamStateCount } = await import("~/lib/transform/sse-state");
    for (let i = 0; i < 100; i++) {
      const state = acquireStreamState(`req-rev-${i}`);
      const c1 = makeCtx(
        {
          type: "response.created",
          response: { id: `resp_${i}`, model: "gpt-5.5" },
        },
        state,
      );
      translate_responses_event_to_anthropic_event(c1, {});
      const c2 = makeCtx(
        {
          type: "response.completed",
          response: { usage: { output_tokens: 1 }, output: [] },
        },
        state,
      );
      translate_responses_event_to_anthropic_event(c2, {});
    }
    expect(_streamStateCount()).toBe(0);
  });
});
