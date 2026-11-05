/**
 * Synthetic parallel-tool replay through the event transformation engine.
 * State transitions belong to the translator: tests never mutate state
 * between events. Interleaved arguments, reverse stop order and usage totals
 * are checked independently of the documented expected event prefix.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { applyEvent } from "~/lib/transform/apply_event";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  registerStreamEvent,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import {
  _resetStreamStates,
  acquireStreamState,
} from "~/lib/transform/sse-state";
import "~/lib/transform/translate_anthropic_event_to_responses_event";
import {
  TranslateAnthropicEventToResponsesEventSchema,
  translate_anthropic_event_to_responses_event,
} from "~/lib/transform/translate_anthropic_event_to_responses_event";
import type {
  AnyEvent,
  Rule,
  StreamEventContext,
  StreamState,
} from "~/lib/transform/types";

const FIXTURE_DIR = resolve(import.meta.dir, "..", "fixtures");

afterEach(() => {
  resetRegistry();
  resetPredicate();
  _resetStreamStates();
});

/**
 * Re-register the M7b translator on the stream-event registry. The
 * `afterEach` resets clear it; this test re-registers per test so the
 * `registerStreamEvent` side-effect import has effect.
 */
function registerTranslator(): void {
  registerStreamEvent(
    "translate_anthropic_event_to_responses_event",
    translate_anthropic_event_to_responses_event,
    TranslateAnthropicEventToResponsesEventSchema,
    {
      reads: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "requestId",
        "responseId",
      ],
      writes: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "responseId",
        "stopReason",
      ],
      allow_override: true,
    },
  );
}

/**
 * Replay one Anthropic SSE event through the M7b translator + return
 * the accumulated outgoing Responses events.
 *
 * Uses `applyEvent` (the canonical engine API per D-LOCK-9; NOT invented
 * `applyStreamEventRules`).
 */
function replay(
  event: AnyEvent,
  state: StreamState,
  rules: Rule[],
): AnyEvent[] {
  const ctx: StreamEventContext = {
    event,
    state,
    route: "/responses",
    model: "claude-test",
  };
  const result = applyEvent(ctx, rules, snapshot("stream_event"));
  return result.events_out;
}

interface ParallelToolsFixture {
  name: string;
  provenance: string;
  leg2_anthropic_sse_events: AnyEvent[];
  expected_responses_sse_events: AnyEvent[];
  expected_invariants: {
    block_0_id: string;
    block_0_name: string;
    block_0_assembled_args: string;
    block_1_id: string;
    block_1_name: string;
    block_1_assembled_args: string;
    stop_order: string;
    expected_total_tokens: number;
    [k: string]: unknown;
  };
}

describe("phase16_replay — parallel-tool fixture (mini-audit 29-32)", () => {
  test("fixture file exists and follows D-LOCK-6 schema (mini-audit 29)", () => {
    const fixturePath = resolve(FIXTURE_DIR, "parallel_tools_codex.json");
    const raw = readFileSync(fixturePath, "utf-8");
    const fixture: ParallelToolsFixture = JSON.parse(raw);
    expect(fixture.name).toBeDefined();
    expect(fixture.provenance).toBe("synthetic");
    expect(Array.isArray(fixture.leg2_anthropic_sse_events)).toBe(true);
    expect(fixture.leg2_anthropic_sse_events.length).toBeGreaterThan(0);
    expect(Array.isArray(fixture.expected_responses_sse_events)).toBe(true);
    expect(fixture.expected_invariants).toBeDefined();
  });

  test("replay through M7b translator preserves per-block identity (F26 + mini-audit 30 + 31)", () => {
    registerTranslator();
    const fixturePath = resolve(FIXTURE_DIR, "parallel_tools_codex.json");
    const fixture: ParallelToolsFixture = JSON.parse(
      readFileSync(fixturePath, "utf-8"),
    );

    const state = acquireStreamState("phase16-replay-parallel");
    const rules: Rule[] = [
      {
        name: "translator",
        use: "translate_anthropic_event_to_responses_event",
      },
    ];

    const allOut: AnyEvent[] = [];
    for (const ev of fixture.leg2_anthropic_sse_events) {
      const out = replay(ev, state, rules);
      for (const o of out) {
        allOut.push(o);
      }
    }

    // Locate the function_call output_item.added events for blocks 0 + 1.
    const added0 = allOut.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown> | undefined)?.id ===
          fixture.expected_invariants.block_0_id,
    );
    const added1 = allOut.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown> | undefined)?.id ===
          fixture.expected_invariants.block_1_id,
    );
    expect(added0).toBeDefined();
    expect(added1).toBeDefined();
    expect((added0?.item as Record<string, unknown>).name).toBe(
      fixture.expected_invariants.block_0_name,
    );
    expect((added1?.item as Record<string, unknown>).name).toBe(
      fixture.expected_invariants.block_1_name,
    );

    // Locate output_item.done events for blocks 0+1 — assert assembled
    // arguments are correct PER BLOCK (the F26 / M7b.5 F1 contract:
    // out-of-order stops must read back the right per-block meta).
    const done0 = allOut.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown> | undefined)?.id ===
          fixture.expected_invariants.block_0_id,
    );
    const done1 = allOut.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown> | undefined)?.id ===
          fixture.expected_invariants.block_1_id,
    );
    expect(done0).toBeDefined();
    expect(done1).toBeDefined();
    expect((done0?.item as Record<string, unknown>).arguments).toBe(
      fixture.expected_invariants.block_0_assembled_args,
    );
    expect((done1?.item as Record<string, unknown>).arguments).toBe(
      fixture.expected_invariants.block_1_assembled_args,
    );

    // Verify out-of-order semantics: in the fixture, b1 stops first then b0.
    // So done1 must appear BEFORE done0 in the replay output.
    const idxDone0 = allOut.indexOf(done0 as AnyEvent);
    const idxDone1 = allOut.indexOf(done1 as AnyEvent);
    expect(idxDone1).toBeLessThan(idxDone0);

    // total_tokens at message_stop should equal input + output per
    // _toResponsesUsage (input from message_start, output from message_delta MERGE).
    const completed = allOut.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    const usage = ((completed?.response as Record<string, unknown>) ?? {})
      .usage as Record<string, unknown> | undefined;
    expect(usage?.total_tokens).toBe(
      fixture.expected_invariants.expected_total_tokens,
    );
  });

  test("expected_responses_sse_events prefix matches translator output for early events", () => {
    registerTranslator();
    const fixturePath = resolve(FIXTURE_DIR, "parallel_tools_codex.json");
    const fixture: ParallelToolsFixture = JSON.parse(
      readFileSync(fixturePath, "utf-8"),
    );

    const state = acquireStreamState("phase16-replay-prefix");
    const rules: Rule[] = [
      {
        name: "translator",
        use: "translate_anthropic_event_to_responses_event",
      },
    ];

    const allOut: AnyEvent[] = [];
    for (const ev of fixture.leg2_anthropic_sse_events) {
      const out = replay(ev, state, rules);
      for (const o of out) {
        allOut.push(o);
      }
    }

    // The first 4 expected events (response.created, response.in_progress,
    // 2x response.output_item.added) should appear in the replay output in
    // matching shape. We check by `type` equality since deeper field-level
    // matches are covered by the per-block identity test above.
    for (let i = 0; i < fixture.expected_responses_sse_events.length; i++) {
      const expected = fixture.expected_responses_sse_events[i];
      const found = allOut.find((e) => {
        if (e.type !== expected?.type) return false;
        // For output_item.added, also match the item.id.
        if (e.type === "response.output_item.added") {
          const eItem = e.item as Record<string, unknown> | undefined;
          const expItem = expected?.item as Record<string, unknown> | undefined;
          return eItem?.id === expItem?.id;
        }
        return true;
      });
      expect(found).toBeDefined();
    }
  });
});

// -----------------------------------------------------------------------------
// 2nd replay: D-LOCK-2 extraction sanity (toResponsesUsage end-to-end)
// -----------------------------------------------------------------------------

describe("phase16_replay — toResponsesUsage extraction sanity (D-LOCK-2)", () => {
  test("end-to-end total_tokens matches input + output per F21 fix", () => {
    registerTranslator();

    const state = acquireStreamState("phase16-replay-usage");
    const rules: Rule[] = [
      {
        name: "translator",
        use: "translate_anthropic_event_to_responses_event",
      },
    ];

    // Representative Anthropic SSE sequence: message_start with
    // input_tokens=1234 + cache_read=800, then a content block, then
    // message_delta with output_tokens=87, then message_stop.
    const events: AnyEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_phase16_usage_1",
          model: "claude-test",
          usage: {
            input_tokens: 1234,
            cache_read_input_tokens: 800,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world." },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 87 },
      },
      {
        type: "message_stop",
      },
    ];

    const allOut: AnyEvent[] = [];
    for (const ev of events) {
      const out = replay(ev, state, rules);
      for (const o of out) {
        allOut.push(o);
      }
    }

    // F21 fix verifies: total_tokens = input + output (not just output).
    // Pre-fix, total_tokens would have been 87. Post-fix: 1234 + 87 = 1321.
    const completed = allOut.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    const usage = ((completed?.response as Record<string, unknown>) ?? {})
      .usage as Record<string, unknown> | undefined;
    expect(usage?.input_tokens).toBe(1234);
    expect(usage?.output_tokens).toBe(87);
    expect(usage?.total_tokens).toBe(1321);
    const inDetails = usage?.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    expect(inDetails?.cached_tokens).toBe(800);
    const outDetails = usage?.output_tokens_details as
      | Record<string, unknown>
      | undefined;
    // M7b D-LOCK-9: reasoning_tokens stays 0 (Phase 3 enhancement).
    expect(outDetails?.reasoning_tokens).toBe(0);
  });
});
