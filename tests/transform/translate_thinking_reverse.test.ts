/**
 * translate_thinking_reverse.test.ts — M10 D-LOCK-9 dedicated reverse
 * thinking-event translation coverage + round-trip + multi-segment +
 * malformed-input.
 *
 * Lane covered:
 *   - Reverse (Responses → Anthropic) for the 4 reasoning_summary event types.
 *   - Round-trip: Anthropic thinking sequence → forward translator →
 *     Responses events → reverse translator → recovered Anthropic
 *     sequence (modulo signature_delta which has no Responses equivalent
 *     and cannot round-trip).
 *   - Multi-segment: 2 thinking blocks back-to-back round-trip with
 *     correct contentBlockIndex increments.
 *   - Out-of-order: text.delta without preceding part.added drops with
 *     debug log; no crash.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry } from "~/lib/transform/registry";
import { _resetStreamStates, initStreamState } from "~/lib/transform/sse-state";
import "~/lib/transform/translate_anthropic_event_to_responses_event";
import "~/lib/transform/translate_responses_event_to_anthropic_event";
import { translate_anthropic_event_to_responses_event } from "~/lib/transform/translate_anthropic_event_to_responses_event";
import { translate_responses_event_to_anthropic_event } from "~/lib/transform/translate_responses_event_to_anthropic_event";
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

function makeReverseCtx(
  event: AnyEvent,
  state: StreamState,
): StreamEventContext {
  return {
    event,
    state,
    route: "/v1/messages",
    model: "gpt-5.5-2026-04-23",
  };
}

function makeForwardCtx(
  event: AnyEvent,
  state: StreamState,
): StreamEventContext {
  return {
    event,
    state,
    route: "/responses",
    model: "claude-opus-4.7",
  };
}

function runReverse(
  event: AnyEvent,
  state: StreamState,
): { events_out: AnyEvent[]; applied: boolean } {
  const ctx = makeReverseCtx(event, state);
  const r = translate_responses_event_to_anthropic_event(ctx, {
    name: "t",
    use: "translate_responses_event_to_anthropic_event",
  });
  return { events_out: r.events_out, applied: r.applied };
}

function runForward(
  event: AnyEvent,
  state: StreamState,
): { events_out: AnyEvent[]; applied: boolean } {
  const ctx = makeForwardCtx(event, state);
  const r = translate_anthropic_event_to_responses_event(ctx, {
    name: "t",
    use: "translate_anthropic_event_to_responses_event",
  });
  return { events_out: r.events_out, applied: r.applied };
}

// -----------------------------------------------------------------------------
// Reverse: 4 unit tests (one per Responses input event family)
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 reverse thinking — per-event-type", () => {
  test("reasoning_summary_part.added → eager-opens content_block_start(thinking) at current contentBlockIndex", () => {
    const state = initStreamState();
    const r = runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    expect(r.applied).toBe(true);
    expect(r.events_out).toHaveLength(1);
    const ev = r.events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("content_block_start");
    expect(ev.index).toBe(0);
    expect(ev.content_block).toEqual({ type: "thinking", thinking: "" });
    // State writes per D-LOCK-9.
    expect(state.contentBlockOpen).toBe(true);
    expect(state.currentToolType).toBe("thinking");
    expect(state.thinkingTextBuffer).toBe("");
  });

  test("reasoning_summary_text.delta → emits content_block_delta(thinking_delta) + appends to thinkingTextBuffer", () => {
    const state = initStreamState();
    runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    const r = runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "Step 1.",
      },
      state,
    );
    expect(r.applied).toBe(true);
    expect(r.events_out).toHaveLength(1);
    const ev = r.events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("content_block_delta");
    expect(ev.index).toBe(0);
    expect(ev.delta).toEqual({ type: "thinking_delta", thinking: "Step 1." });
    expect(state.thinkingTextBuffer).toBe("Step 1.");

    // Append a second delta.
    runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: " Step 2.",
      },
      state,
    );
    expect(state.thinkingTextBuffer).toBe("Step 1. Step 2.");
  });

  test("reasoning_summary_text.done → CONSUMED-INTO-STATE; no Anthropic emit; no state change", () => {
    const state = initStreamState();
    runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "buffered",
      },
      state,
    );
    const idxBefore = state.contentBlockIndex;
    const bufferBefore = state.thinkingTextBuffer;
    const openBefore = state.contentBlockOpen;
    const r = runReverse(
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "<accumulated upstream text — IRRELEVANT per H3>",
      },
      state,
    );
    // CONSUMED-INTO-STATE per D-LOCK-2(b): applied:true so engine does
    // NOT default-passthrough; events_out empty (matching part.done closes).
    expect(r.applied).toBe(true);
    expect(r.events_out).toEqual([]);
    // No state change — state machine waits for matching part.done.
    expect(state.contentBlockIndex).toBe(idxBefore);
    expect(state.thinkingTextBuffer).toBe(bufferBefore);
    expect(state.contentBlockOpen).toBe(openBefore);
  });

  test("reasoning_summary_part.done → emits content_block_stop + increments contentBlockIndex + clears buffer", () => {
    const state = initStreamState();
    runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "buffered",
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "<irrelevant per H3>",
      },
      state,
    );
    const r = runReverse(
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "<irrelevant per H3>" },
      },
      state,
    );
    expect(r.applied).toBe(true);
    expect(r.events_out).toHaveLength(1);
    const ev = r.events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("content_block_stop");
    expect(ev.index).toBe(0);
    // State: contentBlockIndex incremented; flags reset.
    expect(state.contentBlockIndex).toBe(1);
    expect(state.contentBlockOpen).toBe(false);
    expect(state.currentToolType).toBeNull();
    expect(state.thinkingTextBuffer).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Round-trip: Anthropic thinking sequence → forward → reverse → recovered
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 round-trip Anthropic ↔ Responses thinking", () => {
  test("forward then reverse recovers original Anthropic sequence + intermediate Responses done events carry text:''", () => {
    const forwardState = initStreamState();
    const reverseState = initStreamState();

    // Original Anthropic sequence (excluding signature_delta which has
    // no Responses equivalent and cannot round-trip).
    const originalAnthropic: AnyEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Part A" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " then Part B" },
      },
      { type: "content_block_stop", index: 0 },
    ];

    // Forward: Anthropic → Responses.
    const responsesEvents: AnyEvent[] = [];
    for (const ev of originalAnthropic) {
      const r = runForward(ev, forwardState);
      responsesEvents.push(...r.events_out);
    }
    // Should produce: part.added, text.delta, text.delta, text.done, part.done.
    expect(responsesEvents).toHaveLength(5);
    const r0 = responsesEvents[0] as Record<string, unknown>;
    expect(r0.type).toBe("response.reasoning_summary_part.added");
    expect((responsesEvents[1] as Record<string, unknown>).type).toBe(
      "response.reasoning_summary_text.delta",
    );
    expect((responsesEvents[2] as Record<string, unknown>).type).toBe(
      "response.reasoning_summary_text.delta",
    );
    const r3 = responsesEvents[3] as Record<string, unknown>;
    expect(r3.type).toBe("response.reasoning_summary_text.done");
    // H3 LOCKED: text:"" on done.
    expect(r3.text).toBe("");
    const r4 = responsesEvents[4] as Record<string, unknown>;
    expect(r4.type).toBe("response.reasoning_summary_part.done");
    // H3 LOCKED: part.text:"" on part.done.
    expect((r4.part as Record<string, unknown>).text).toBe("");

    // Reverse: Responses → Anthropic.
    const recoveredAnthropic: AnyEvent[] = [];
    for (const ev of responsesEvents) {
      const r = runReverse(ev, reverseState);
      recoveredAnthropic.push(...r.events_out);
    }
    // Recovered sequence: start, delta, delta, stop (text.done is
    // CONSUMED-INTO-STATE; emits nothing).
    expect(recoveredAnthropic).toHaveLength(4);
    const a0 = recoveredAnthropic[0] as Record<string, unknown>;
    expect(a0.type).toBe("content_block_start");
    expect(a0.index).toBe(0);
    expect(a0.content_block).toEqual({ type: "thinking", thinking: "" });
    const a1 = recoveredAnthropic[1] as Record<string, unknown>;
    expect(a1.type).toBe("content_block_delta");
    expect(a1.delta).toEqual({ type: "thinking_delta", thinking: "Part A" });
    const a2 = recoveredAnthropic[2] as Record<string, unknown>;
    expect(a2.type).toBe("content_block_delta");
    expect(a2.delta).toEqual({
      type: "thinking_delta",
      thinking: " then Part B",
    });
    const a3 = recoveredAnthropic[3] as Record<string, unknown>;
    expect(a3.type).toBe("content_block_stop");
    expect(a3.index).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Multi-segment: 2 thinking blocks back-to-back round-trip
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 reverse thinking — multi-segment", () => {
  test("2 reasoning_summary segments → contentBlockIndex 0→1→2 increments correctly", () => {
    const state = initStreamState();
    // Segment 1.
    runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "seg1",
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "<irrelevant>",
      },
      state,
    );
    const stop1 = runReverse(
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "<irrelevant>" },
      },
      state,
    );
    expect((stop1.events_out[0] as Record<string, unknown>).index).toBe(0);
    expect(state.contentBlockIndex).toBe(1);

    // Segment 2 — note Responses upstream keeps output_index=0 across
    // multi-segment within a single reasoning item; summary_index
    // increments. The Anthropic-side index is allocated by the reverse
    // translator's contentBlockIndex (not from upstream's indices).
    const start2 = runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 1,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    expect((start2.events_out[0] as Record<string, unknown>).index).toBe(1);
    runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 1,
        delta: "seg2",
      },
      state,
    );
    runReverse(
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 1,
        text: "<irrelevant>",
      },
      state,
    );
    const stop2 = runReverse(
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 1,
        part: { type: "summary_text", text: "<irrelevant>" },
      },
      state,
    );
    expect((stop2.events_out[0] as Record<string, unknown>).index).toBe(1);
    expect(state.contentBlockIndex).toBe(2);
  });

  test("part.added arriving while a prior thinking block is open closes prior + opens new (defensive)", () => {
    const state = initStreamState();
    runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    expect(state.contentBlockIndex).toBe(0);
    expect(state.contentBlockOpen).toBe(true);
    // Without an intervening part.done, a NEW part.added arrives.
    const r = runReverse(
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 1,
        part: { type: "summary_text", text: "" },
      },
      state,
    );
    // Defensive: emit content_block_stop for prior + content_block_start
    // for new. Anthropic strict alternation invariant preserved.
    expect(r.events_out).toHaveLength(2);
    const e0 = r.events_out[0] as Record<string, unknown>;
    const e1 = r.events_out[1] as Record<string, unknown>;
    expect(e0.type).toBe("content_block_stop");
    expect(e0.index).toBe(0);
    expect(e1.type).toBe("content_block_start");
    expect(e1.index).toBe(1);
    expect(state.contentBlockIndex).toBe(1);
    expect(state.contentBlockOpen).toBe(true);
    expect(state.currentToolType).toBe("thinking");
  });
});

// -----------------------------------------------------------------------------
// Out-of-order / malformed input
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 reverse thinking — defensive malformed input", () => {
  test("text.delta arriving without preceding part.added drops with debug log; no crash", () => {
    const state = initStreamState();
    // No part.added — inject text.delta directly.
    const r = runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "stray",
      },
      state,
    );
    // Defensive no-op — applied:true so engine does NOT default-passthrough.
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true);
    // State NOT corrupted.
    expect(state.contentBlockOpen).toBe(false);
    expect(state.currentToolType).toBeNull();
    expect(state.thinkingTextBuffer).toBe("");
  });

  test("text.delta arriving while a non-thinking block is open (text via output_text.delta) drops; no crash", () => {
    const state = initStreamState();
    // Open a text block via the existing output_text.delta path.
    runReverse(
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: "hello",
      },
      state,
    );
    expect(state.currentToolType).toBe("text");
    // Now stray reasoning_summary_text.delta arrives.
    const r = runReverse(
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "stray on text",
      },
      state,
    );
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true);
    // Text block state unaffected.
    expect(state.currentToolType).toBe("text");
  });

  test("part.done arriving without an open thinking block drops; no crash", () => {
    const state = initStreamState();
    const r = runReverse(
      {
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "<irrelevant>" },
      },
      state,
    );
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true);
    expect(state.contentBlockIndex).toBe(0);
    expect(state.contentBlockOpen).toBe(false);
  });
});
