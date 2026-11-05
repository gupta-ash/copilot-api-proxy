/**
 * translate_thinking_forward.test.ts — M10 D-LOCK-9 dedicated forward
 * thinking-event translation coverage.
 *
 * Lane covered: Anthropic → Responses (forward) for thinking content
 * blocks. Mirrors the per-event-type tests already added to
 * `translate_anthropic_event_to_responses_event.test.ts` (the in-place
 * M10 D-LOCK-9 replacements for the superseded M7b.6 default-passthrough
 * thinking tests) AND adds:
 *   - multi-segment (2 thinking blocks back-to-back) coverage
 *   - signature_delta drop (drop semantics + state untouched)
 *   - out-of-order thinking_delta arriving before content_block_start
 *
 * The round-trip + reverse-direction coverage lives in
 * `translate_thinking_reverse.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry } from "~/lib/transform/registry";
import { _resetStreamStates, initStreamState } from "~/lib/transform/sse-state";
import "~/lib/transform/translate_anthropic_event_to_responses_event";
import { translate_anthropic_event_to_responses_event } from "~/lib/transform/translate_anthropic_event_to_responses_event";
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
// Forward: 4 unit tests (one per Anthropic input event + signature_delta)
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 forward thinking — per-event-type", () => {
  test("content_block_start(thinking) emits reasoning_summary_part.added with allocated indices", () => {
    const { events_out, applied, state } = run({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    expect(applied).toBe(true);
    expect(events_out).toHaveLength(1);
    const ev = events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("response.reasoning_summary_part.added");
    expect(ev.output_index).toBe(0);
    expect(ev.summary_index).toBe(0);
    expect(ev.part).toEqual({ type: "summary_text", text: "" });
    // Allocator increments.
    expect(state.outputIndex).toBe(1);
    expect(state.summaryIndex).toBe(1);
  });

  test("content_block_delta(thinking_delta) emits reasoning_summary_text.delta", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const r = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Step 1: factor 1000." },
      },
      state,
    );
    expect(r.applied).toBe(true);
    expect(r.events_out).toHaveLength(1);
    const ev = r.events_out[0] as Record<string, unknown>;
    expect(ev.type).toBe("response.reasoning_summary_text.delta");
    expect(ev.output_index).toBe(0);
    expect(ev.summary_index).toBe(0);
    expect(ev.delta).toBe("Step 1: factor 1000.");
  });

  test("content_block_delta(signature_delta) DROPPED with debug log; applied:true; no events", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    // Capture state snapshot to assert NOT mutated (besides possible
    // already-applied state from the start).
    const summaryIndexBefore = state.summaryIndex;
    const r = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc-123" },
      },
      state,
    );
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true); // suppressed; engine MUST NOT default-passthrough
    // signature_delta does NOT touch summaryIndex.
    expect(state.summaryIndex).toBe(summaryIndexBefore);
  });

  test("content_block_stop(thinking) emits reasoning_summary_text.done + part.done; both text:'' per H3 LOCKED", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const r = run({ type: "content_block_stop", index: 0 }, state);
    expect(r.applied).toBe(true);
    expect(r.events_out).toHaveLength(2);
    const e0 = r.events_out[0] as Record<string, unknown>;
    const e1 = r.events_out[1] as Record<string, unknown>;
    expect(e0.type).toBe("response.reasoning_summary_text.done");
    expect(e0.output_index).toBe(0);
    expect(e0.summary_index).toBe(0);
    // H3 LOCKED: text:"" regardless of upstream's accumulated text.
    expect(e0.text).toBe("");
    expect(e1.type).toBe("response.reasoning_summary_part.done");
    expect(e1.output_index).toBe(0);
    expect(e1.summary_index).toBe(0);
    // H3 LOCKED: part.text:"" regardless of upstream's accumulated text.
    expect((e1.part as Record<string, unknown>).text).toBe("");
    expect((e1.part as Record<string, unknown>).type).toBe("summary_text");
    // Lifecycle: meta deleted on stop.
    expect(state.contentBlocks?.has(0)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Forward: multi-segment (2 back-to-back thinking blocks)
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 forward thinking — multi-segment", () => {
  test("2 thinking blocks back-to-back → summary_index + outputIndex both increment", () => {
    const state = initStreamState();
    // Block 1 — index 0.
    const r1Start = run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      state,
    );
    const e1Start = r1Start.events_out[0] as Record<string, unknown>;
    expect(e1Start.output_index).toBe(0);
    expect(e1Start.summary_index).toBe(0);
    run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "block-1 reasoning" },
      },
      state,
    );
    run({ type: "content_block_stop", index: 0 }, state);
    expect(state.contentBlocks?.has(0)).toBe(false);

    // Block 2 — index 1 (Anthropic increments content_block.index per
    // distinct block per its strict alternation invariant).
    const r2Start = run(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking" },
      },
      state,
    );
    const e2Start = r2Start.events_out[0] as Record<string, unknown>;
    expect(e2Start.output_index).toBe(1);
    expect(e2Start.summary_index).toBe(1);
    const r2Delta = run(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "block-2 reasoning" },
      },
      state,
    );
    const e2Delta = r2Delta.events_out[0] as Record<string, unknown>;
    expect(e2Delta.output_index).toBe(1);
    expect(e2Delta.summary_index).toBe(1);
    const r2Stop = run({ type: "content_block_stop", index: 1 }, state);
    expect(r2Stop.events_out).toHaveLength(2);
    const e2Done0 = r2Stop.events_out[0] as Record<string, unknown>;
    const e2Done1 = r2Stop.events_out[1] as Record<string, unknown>;
    expect(e2Done0.summary_index).toBe(1);
    expect(e2Done1.summary_index).toBe(1);
    // After both blocks: outputIndex = 2, summaryIndex = 2.
    expect(state.outputIndex).toBe(2);
    expect(state.summaryIndex).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Forward: out-of-order / malformed input
// -----------------------------------------------------------------------------

describe("M10 D-LOCK-9 forward thinking — defensive malformed input", () => {
  test("thinking_delta arriving without preceding content_block_start drops with debug log; no crash", () => {
    const state = initStreamState();
    // No start event — inject thinking_delta directly.
    const r = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "stray reasoning" },
      },
      state,
    );
    // Defensive no-op — applied:true so engine does NOT default-passthrough.
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true);
  });

  test("thinking_delta on a non-thinking block (text block open) drops with debug log; no crash", () => {
    const state = initStreamState();
    run(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      state,
    );
    const r = run(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "stray on text block" },
      },
      state,
    );
    expect(r.events_out).toEqual([]);
    expect(r.applied).toBe(true);
  });
});
