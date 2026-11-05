/**
 * Public synthetic reasoning/thinking lifecycle replay through the production
 * stream pipeline. Both directions cover multiple segments and complete
 * start/delta/stop lifecycles; reverse replay also drops signature deltas.
 */

import { resolve } from "node:path";

import { beforeEach, describe, test, expect } from "bun:test";

import { replayLane } from "./_replay_helpers.ts";

import { decodeSseChunk } from "~/lib/sse-codec.ts";
import { register, registerStreamEvent } from "~/lib/transform/registry.ts";
import type { AnyEvent } from "~/lib/transform/types.ts";

const FIXTURE_ROOT = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "stream-replay",
);

function decodeAll(bytes: Uint8Array): AnyEvent[] {
  const state = { buffer: "" };
  const events: AnyEvent[] = [];
  events.push(...decodeSseChunk(bytes, state));
  events.push(...decodeSseChunk(undefined, state));
  return events;
}

async function ensureRulesRegistered(): Promise<void> {
  // 3 redirects (per M9 redirect_to_responses_dispatch.test.ts pattern)
  const m1 = await import("~/lib/transform/redirect_to_anthropic_messages.ts");
  register(
    "redirect_to_anthropic_messages",
    m1.redirect_to_anthropic_messages,
    m1.RedirectToAnthropicMessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m2 = await import("~/lib/transform/redirect_to_chat_completions.ts");
  register(
    "redirect_to_chat_completions",
    m2.redirect_to_chat_completions,
    m2.RedirectToChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m3 = await import("~/lib/transform/redirect_to_responses.ts");
  register(
    "redirect_to_responses",
    m3.redirect_to_responses,
    m3.RedirectToResponsesSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  // 3 response passthroughs
  const m4 =
    await import("~/lib/transform/response_passthrough_anthropic_v1_messages.ts");
  register(
    "response_passthrough_anthropic_v1_messages",
    m4.response_passthrough_anthropic_v1_messages,
    m4.ResponsePassthroughAnthropicV1MessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
  const m5 =
    await import("~/lib/transform/response_passthrough_openai_chat_completions.ts");
  register(
    "response_passthrough_openai_chat_completions",
    m5.response_passthrough_openai_chat_completions,
    m5.ResponsePassthroughOpenaiChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
  const m6 =
    await import("~/lib/transform/response_passthrough_openai_responses.ts");
  register(
    "response_passthrough_openai_responses",
    m6.response_passthrough_openai_responses,
    m6.ResponsePassthroughOpenaiResponsesSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
  // 2 body translators (M7a)
  const m7 =
    await import("~/lib/transform/translate_anthropic_to_responses.ts");
  register(
    "translate_anthropic_to_responses",
    m7.translate_anthropic_to_responses,
    m7.TranslateAnthropicToResponsesSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
  const m8 =
    await import("~/lib/transform/translate_responses_to_anthropic.ts");
  register(
    "translate_responses_to_anthropic",
    m8.translate_responses_to_anthropic,
    m8.TranslateResponsesToAnthropicSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
  // 2 stream translators (M7b + M10 thinking extension)
  const m9 =
    await import("~/lib/transform/translate_anthropic_event_to_responses_event.ts");
  registerStreamEvent(
    "translate_anthropic_event_to_responses_event",
    m9.translate_anthropic_event_to_responses_event,
    m9.TranslateAnthropicEventToResponsesEventSchema,
    {
      reads: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "requestId",
        "responseId",
        "summaryIndex",
      ],
      writes: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "responseId",
        "stopReason",
        "summaryIndex",
      ],
      allow_override: true,
    },
  );
  const m10 =
    await import("~/lib/transform/translate_responses_event_to_anthropic_event.ts");
  registerStreamEvent(
    "translate_responses_event_to_anthropic_event",
    m10.translate_responses_event_to_anthropic_event,
    m10.TranslateResponsesEventToAnthropicEventSchema,
    {
      reads: [
        "contentBlockIndex",
        "contentBlockOpen",
        "currentToolCallId",
        "currentToolName",
        "currentToolType",
        "messageStartSent",
        "model",
        "requestId",
        "responseId",
        "thinkingTextBuffer",
        "toolArgsBuffer",
      ],
      writes: [
        "contentBlockIndex",
        "contentBlockOpen",
        "currentToolCallId",
        "currentToolName",
        "currentToolType",
        "messageStartSent",
        "model",
        "responseId",
        "thinkingTextBuffer",
        "toolArgsBuffer",
      ],
      allow_override: true,
    },
  );
}

beforeEach(async () => {
  await ensureRulesRegistered();
});

// ============================================================================
// Lane 4 — cc_gpt55_thinking (reasoning_summary → thinking_delta on emit)
// ============================================================================

describe("thinking_event_translation — Lane 4 (reasoning_summary → thinking_delta)", () => {
  test("[M10 C2] reasoning_summary_part.added → content_block_start(type=thinking)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const thinkingStarts = events.filter((e) => {
      const ev = e as { type?: string; content_block?: { type?: string } };
      return (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "thinking"
      );
    });
    expect(thinkingStarts.length).toBeGreaterThanOrEqual(1);
  });

  test("[M10 C2] reasoning_summary_text.delta → content_block_delta(thinking_delta) (≥ 1 emitted)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const thinkingDeltas = events.filter((e) => {
      const ev = e as { type?: string; delta?: { type?: string } };
      return (
        ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta"
      );
    });
    // Three independently authored summaries each contain two fragments.
    expect(thinkingDeltas.length).toBe(6);
  });

  test("[M10 C2] reasoning_summary_part.done → content_block_stop on thinking blocks", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    // For each content_block_start with type=thinking at index N, expect
    // a matching content_block_stop with index N somewhere later.
    const thinkingIdxs = new Set<number>();
    const stoppedIdxs = new Set<number>();
    for (const e of events) {
      const ev = e as {
        type?: string;
        index?: number;
        content_block?: { type?: string };
      };
      if (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "thinking" &&
        typeof ev.index === "number"
      ) {
        thinkingIdxs.add(ev.index);
      }
      if (ev.type === "content_block_stop" && typeof ev.index === "number") {
        stoppedIdxs.add(ev.index);
      }
    }
    for (const idx of thinkingIdxs) {
      expect(stoppedIdxs.has(idx)).toBe(true);
    }
    expect(thinkingIdxs.size).toBeGreaterThanOrEqual(1);
  });

  test("[M10 C2] reasoning_summary_text.done DROPPED on emit (consumed-into-state per D-LOCK-2(b))", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const types = decodeAll(result.emittedBytes).map(
      (e) => (e as { type?: string }).type,
    );
    // The reverse translator consumes reasoning_summary_text.done into
    // state (no emit); closure happens via reasoning_summary_part.done.
    // After translation, NO emitted event should have the Responses-shape
    // type prefix — the lane is Anthropic-shape downstream.
    const responseShapeLeaks = types.filter(
      (t) =>
        typeof t === "string" && t.startsWith("response.reasoning_summary"),
    );
    expect(responseShapeLeaks).toEqual([]);
  });

  test("[M10 C2] multi-segment reasoning → multiple thinking blocks in emit", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const thinkingStarts = events.filter((e) => {
      const ev = e as { type?: string; content_block?: { type?: string } };
      return (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "thinking"
      );
    });
    // Every synthetic summary must open its own downstream thinking block.
    expect(thinkingStarts.length).toBe(3);
  });
});

// ============================================================================
// Lane 5 — codex_claude_reverse (thinking_delta → reasoning_summary on emit)
// ============================================================================

describe("thinking_event_translation — Lane 5 (thinking → reasoning_summary)", () => {
  test("[M10 C2] content_block_start(thinking) → response.reasoning_summary_part.added", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const types = decodeAll(result.emittedBytes).map(
      (e) => (e as { type?: string }).type,
    );
    // Per synthesized fixture v2: 2 thinking blocks → 2 reasoning_summary_part.added.
    const partAddeds = types.filter(
      (t) => t === "response.reasoning_summary_part.added",
    );
    expect(partAddeds.length).toBeGreaterThanOrEqual(2);
  });

  test("[M10 C2] content_block_delta(thinking_delta) → response.reasoning_summary_text.delta", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const types = decodeAll(result.emittedBytes).map(
      (e) => (e as { type?: string }).type,
    );
    // Per synthesized fixture v2: 3 thinking_delta events (block 0: 2, block 1: 1)
    // → 3 reasoning_summary_text.delta on emit (signature_delta DROPPED).
    const deltas = types.filter(
      (t) => t === "response.reasoning_summary_text.delta",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(3);
  });

  test("[M10 C2] content_block_delta(signature_delta) DROPPED (no Responses equivalent)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    // No emitted event should carry signature_delta or any signature
    // field (per D-LOCK-9 forward table: signature_delta on a thinking
    // block emits []).
    for (const e of events) {
      const ev = e as { delta?: { type?: string } };
      expect(ev.delta?.type === "signature_delta").toBe(false);
    }
  });

  test("[M10 C2] content_block_stop(thinking) → text.done + part.done both with text=''", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    // Per D-LOCK-9 / H3 LOCKED: both reasoning_summary_text.done AND
    // reasoning_summary_part.done MUST carry text="" (NOT accumulated).
    const textDones = events.filter(
      (e) =>
        (e as { type?: string }).type ===
        "response.reasoning_summary_text.done",
    );
    const partDones = events.filter(
      (e) =>
        (e as { type?: string }).type ===
        "response.reasoning_summary_part.done",
    );
    expect(textDones.length).toBeGreaterThanOrEqual(2);
    expect(partDones.length).toBeGreaterThanOrEqual(2);
    for (const e of textDones) {
      const ev = e as { text?: string };
      expect(ev.text).toBe("");
    }
    for (const e of partDones) {
      const ev = e as { part?: { text?: string } };
      expect(ev.part?.text).toBe("");
    }
  });

  test("[M10 C2] state.summaryIndex allocator increments per thinking_block_start (multi-segment)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    // Collect summary_index values from reasoning_summary_part.added
    // events; should be sequential from 0 (per D-LOCK-10 + interface-
    // contracts § 5: state.summaryIndex incremented per thinking_block_start).
    const summaryIdxs: number[] = [];
    for (const e of events) {
      const ev = e as { type?: string; summary_index?: number };
      if (
        ev.type === "response.reasoning_summary_part.added" &&
        typeof ev.summary_index === "number"
      ) {
        summaryIdxs.push(ev.summary_index);
      }
    }
    expect(summaryIdxs.length).toBeGreaterThanOrEqual(2);
    // First two summary_indexes must be 0 and 1 (multi-segment increment).
    expect(summaryIdxs[0]).toBe(0);
    expect(summaryIdxs[1]).toBe(1);
  });
});
