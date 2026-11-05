/**
 * translate_anthropic_event_to_responses_event.ts — stream-event-engine
 * rule: rewrite a single Anthropic SSE event into the OpenAI Responses
 * SSE event shape.
 *
 * **M7b primitive (built-in).** Self-registers at module load via
 * `registerStreamEvent`. Naming convention
 * `translate_<source>_event_to_<target>_event` per D-LOCK-8 / O19.
 *
 * Lane: **Codex→Claude reverse — response side** (consumer); NOT
 * CC→Claude / CC→GPT-5.x / CC→GPT-4.x. Codex sends a `/responses`
 * request, the proxy rewrites the body to Anthropic shape (M7a's
 * `translate_responses_to_anthropic`), the upstream Anthropic
 * `/v1/messages` server returns Anthropic SSE events. THIS rule
 * translates each one into a Responses SSE event so Codex sees a
 * Responses-shaped stream.
 *
 *   - **NOT** consumed by CC→Claude (passthrough — M5's
 *     `forward-stream.ts` byte-loop).
 *   - **NOT** consumed by CC→GPT-5.x (forward direction; see
 *     `translate_responses_event_to_anthropic_event.ts`).
 *   - **NOT** consumed by CC→GPT-4.x (Chat Completions SSE shape, not
 *     Responses; M9/M10 may add a translator if needed).
 *
 * **F26 / R34 / OQ-PROXY-EMPTY-TOOL-ARGS — fix LANDS HERE (D-LOCK-4).**
 * The bundle's translator at line 2356 emits `arguments: ""` on every
 * `content_block_stop` for a tool_use block (and `item.arguments: ""`
 * at line 2370). The cause: it never accumulated the
 * `input_json_delta.partial_json` chunks. v2's fix (M7b iter-1):
 *
 *   - On `content_block_start` (tool_use), initialize an arg buffer.
 *   - On `content_block_delta` (input_json_delta), APPEND
 *     `delta.partial_json` to the buffer; emit per-chunk delta event.
 *   - On `content_block_stop`, read the assembled string from the
 *     buffer, default to `"{}"` when empty, emit BOTH
 *     `response.function_call_arguments.done` AND
 *     `response.output_item.done` with the assembled `arguments`.
 *
 * **M7b.5 F1 hardening — per-block metadata map (D25 keystone fix).**
 * M7b iter-1 used a stream-wide scalar trio (`currentBlockType`,
 * `currentToolId`, `currentToolName`) plus a separate
 * `Map<number, string>` for arg buffers. The cross-model discriminator
 * caught a silent-corruption bug: in the spec-required interleaved
 * sequence (b0-start, b1-start, b0-delta, b1-delta, b1-stop, b0-stop),
 * b1-start clobbered b0's id/name and b0-stop emitted b1's metadata
 * (or, after b1-stop reset `currentBlockType = null`, emitted nothing
 * at all — silent function-call loss).
 *
 * Fix: promote the trio + arg buffer INTO a per-block
 * `Map<number, ContentBlockMeta>` keyed by Anthropic
 * `content_block.index`. Each block carries its own `type`, `toolId`,
 * `toolName`, allocated `outputIndex`, and `argBuffer`. Stop reads from
 * the per-index entry — out-of-order stops can no longer see the wrong
 * tool's metadata. See `sse-state.ts § interface ContentBlockMeta`.
 *
 * **`outputIndex` semantics.** Stays as a stream-wide allocator counter
 * — `content_block_start` reads the current value into the new block's
 * meta and increments; `content_block_stop` reads the per-block
 * captured value (NOT the live counter) so out-of-order stops emit
 * the correct allocated index.
 *
 * **Why keyed by `content_block.index` and not by tool call_id?**
 * Anthropic's stream addresses tool blocks by block index per its
 * interleaving model. The call_id is stamped on `content_block_start`
 * but absent from `content_block_delta` / `content_block_stop`. Block
 * index is the only invariant available on each event.
 *
 * **F21 fix preserved (D-LOCK-9).** `_toResponsesUsage` computes
 * `total_tokens = input_tokens + output_tokens` and populates
 * `input_tokens_details.cached_tokens` from `cache_read_input_tokens`
 * (bundle Phase 1.6 patch at line 2219). `state.finalUsage` is MERGED
 * (not replaced) on `message_delta` (bundle line 2380):
 * `state.finalUsage = { ...(state.finalUsage || {}), ...(parsed.usage || {}) }`.
 * Anthropic puts `input_tokens` in `message_start.usage` and only
 * `output_tokens` in `message_delta.usage`; replacing instead of
 * merging would clobber the input count.
 *
 * **STREAM-EVENT scope only (D-LOCK-7).** This rule receives ONE
 * Anthropic SSE event (the parsed `data: {...}` JSON; the `event: ...`
 * header is informational only — `parsed.type` is the discriminator).
 * It returns 0..N Responses SSE events. NO body translation; that
 * happened in M7a's body translator before the upstream call.
 *
 * **Sync only (D-LOCK-10 / per types.ts).** No async work. No `await`.
 * The hot path is per-event with a <1ms budget per N8.
 *
 * **Empty-event safety (D-LOCK-12).** Defensive on:
 *   - `parsed === null | undefined` → `events_out: []`, `applied: false`.
 *   - `parsed.type === undefined` → same.
 *   - Unknown `parsed.type` → returns `applied: false` (engine
 *     default-passthrough at `apply_event.ts:237-240` emits the original
 *     event unchanged). Per M7b.6 D-LOCK-1: operator can opt-in to drop
 *     via future `drop_stream_event` rule (deferred to M7b.7 / M9 per
 *     iter-1 F2 engine-fan-out concern).
 *
 * **M7b.6 default-passthrough refactor (D-LOCK-1 + D-LOCK-7).** UNMAPPABLE
 * events (no Responses-format equivalent) return `{ events_out: [],
 * applied: false }`. The engine's existing `!anyFired → emit ctx.event`
 * default-passthrough then forwards the original event unchanged. Honors
 * the user's "default → passthrough" principle. Sub-handler signatures
 * promoted from `AnyEvent[]` to `StreamEventResult` so each handler self-
 * determines its `applied` flag (Option A3 per iter-2 F1). The top-level
 * rule fn no longer wraps with a hardcoded `applied: true` — switch cases
 * return sub-handler results directly. Per-block metadata lifecycle
 * (`state.contentBlocks.set/delete`) preserved INDEPENDENTLY of the
 * `applied` return value.
 *
 * **Error semantics (D-LOCK-11 / per D26 default).** Throws are
 * caught by the engine's `apply_event.ts`. Default `on_error: "continue"`
 * means: log, record AppliedRule with error, AND suppress the original
 * event (a rule that claimed this event_type AND threw indicates
 * unsafe-to-passthrough state). Operators wanting fail-open semantics
 * pass `on_error: "continue_passthrough"` (rare for a translator).
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js`:
 *   - `translateAnthropicEventToResponsesEvents` at line 2232
 *     (general structure + emit shapes; v2 mirrors per-event-type
 *     branches).
 *   - `_toResponsesUsage` at line 2219 (Phase 1.6 helper; direct port).
 * Differences from bundle:
 *   - **F26 fix.** v2 buffers `input_json_delta.partial_json` chunks
 *     and emits assembled args on `content_block_stop`; bundle emits
 *     `arguments: ""` always (lines 2356 + 2370). v2 defaults to
 *     `"{}"` when buffer is empty.
 *   - **M7b.5 F1.** v2 uses per-block `ContentBlockMeta` map (not
 *     stream-wide scalars) so parallel/interleaved tool_use blocks
 *     emit each block's own correct metadata at stop time.
 *   - **Engine integration.** Registered as a stream-event rule
 *     (consumed by M2's `apply_event.ts`); bundle inlines the
 *     translator in its stream handler.
 *   - **Per-stream state.** v2 uses M7b's typed `StreamState`; bundle
 *     uses ad-hoc property bags on a positional `streamState` argument.
 *   - **Defensive shape.** v2 explicitly handles
 *     `parsed.type === undefined` (returns empty events) instead of
 *     silently relying on the if-chain to fall through.
 *   - **Default-passthrough (M7b.6).** Unknown event types AND
 *     UNMAPPABLE events (unknown delta types, content_block_start/stop
 *     for unknown content blocks) return `applied: false`; the engine
 *     forwards the original via default-passthrough.
 *   - **M10 thinking translation (D-LOCK-9).** thinking content blocks +
 *     thinking_delta are TRANSLATED to the
 *     `response.reasoning_summary_part.added/done` +
 *     `response.reasoning_summary_text.delta/done` event family on the
 *     Responses side. signature_delta is DROPPED with a debug log
 *     (no Responses equivalent). Per H3 LOCKED: BOTH `done` events emit
 *     `text: ""` regardless of upstream's accumulated text — v2 does NOT
 *     accumulate thinking text client-side.
 *   - **Safe id fallback.** v2 generates `responseId` /
 *     `currentToolId` fallbacks via `Date.now()` when missing,
 *     mirroring bundle behavior.
 *
 * **Cross-references.**
 *   - `sse-state.ts` — concrete `StreamState` shape + `ContentBlockMeta`.
 *   - `translate_responses_event_to_anthropic_event.ts` — reverse direction.
 *   - decisions.md § F26 / R34 — bug history.
 *   - open_questions.md § OQ-PROXY-EMPTY-TOOL-ARGS — fix landed in M7b.
 *   - M7b.5 spec § F1 — discriminator-driven hardening.
 */

import { z } from "zod";

import { LEVEL_ON, debug } from "../debug.ts";
import type {
  ResponsesFunctionCallItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
} from "../../types/openai-responses.ts";

import { releaseStreamState } from "./sse-state.ts";
import { registerStreamEvent } from "./registry.ts";
import { toResponsesUsage } from "./usage.ts";
import type { ContentBlockMeta, StreamState } from "./sse-state.ts";
import type {
  AnyEvent,
  StreamEventContext,
  StreamEventResult,
  StreamEventTransformFn,
} from "./types.ts";

const TranslateAnthropicEventToResponsesEventSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_anthropic_event_to_responses_event"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Read a string-typed field from an arbitrary object, returning a
 * fallback when missing or wrong-typed. Used pervasively below to
 * narrow `parsed.message?.id` etc. without sprinkling `as` casts.
 */
function strOr(obj: unknown, key: string, fallback: string): string {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return fallback;
  }
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : fallback;
}

/**
 * Lazy-init the per-block content meta map on `state`. Called on the
 * first per-block-aware handler that runs before any block_start (tests
 * may construct ad-hoc states without going through `initStreamState`).
 */
function ensureContentBlocks(
  state: StreamState,
): Map<number, ContentBlockMeta> {
  if (state.contentBlocks === undefined) {
    state.contentBlocks = new Map<number, ContentBlockMeta>();
  }
  return state.contentBlocks;
}

// -----------------------------------------------------------------------------
// Per-event-type handlers
// -----------------------------------------------------------------------------

/**
 * Handle `message_start` — emit `response.created` + `response.in_progress`.
 * Captures responseId, model, and initial usage into state.
 */
function handleMessageStart(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const msg =
    typeof parsed.message === "object" && parsed.message !== null
      ? (parsed.message as Record<string, unknown>)
      : {};
  const id = strOr(msg, "id", `resp_${Date.now()}`);
  const model = strOr(msg, "model", "");
  state.responseId = id;
  state.model = model;
  state.outputIndex = 0;
  // F21 / D-LOCK-9: capture initial usage so input_tokens /
  // cache_read_input_tokens survive to message_stop. Anthropic puts
  // input_tokens in message_start; message_delta typically only
  // updates output_tokens (which we MERGE in below).
  const usage =
    msg.usage !== null &&
    msg.usage !== undefined &&
    typeof msg.usage === "object"
      ? (msg.usage as Record<string, unknown>)
      : {};
  state.finalUsage = { ...usage };
  return {
    events_out: [
      {
        type: "response.created",
        response: {
          id,
          object: "response",
          model,
          status: "in_progress",
          output: [],
          usage: toResponsesUsage(usage),
        },
      },
      {
        type: "response.in_progress",
        response: {
          id,
          object: "response",
          model,
          status: "in_progress",
        },
      },
    ],
    applied: true,
  };
}

/**
 * Handle `content_block_start` for `text` / `tool_use` / `thinking`.
 * Mirrors bundle lines 2269-2310.
 *
 * **M7b.5 F1.** Allocates the next `outputIndex` from the stream-wide
 * counter, then writes a per-block `ContentBlockMeta` entry to
 * `state.contentBlocks` keyed by `parsed.index`. Each block now carries
 * its own captured `outputIndex`, `toolId`, `toolName`, and `argBuffer`
 * — out-of-order `content_block_stop` events read back the right
 * metadata for the right block.
 *
 * **M10 D-LOCK-9 forward thinking.** For thinking blocks, allocate BOTH
 * a fresh `output_index` AND a fresh `summary_index` (from
 * `state.summaryIndex`, lazy-init to 0). Emit
 * `response.reasoning_summary_part.added` with the allocated indices.
 * Per-block meta is recorded so the matching `content_block_stop` can
 * find + delete it.
 */
function handleContentBlockStart(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const block =
    typeof parsed.content_block === "object" && parsed.content_block !== null
      ? (parsed.content_block as Record<string, unknown>)
      : {};
  const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
  const allocatedOutputIndex = state.outputIndex ?? 0;
  // Allocate the next output_index for the NEXT block's start; THIS
  // block keeps `allocatedOutputIndex` captured in its meta entry so a
  // later out-of-order stop reads back the correct value.
  state.outputIndex = allocatedOutputIndex + 1;
  const blocks = ensureContentBlocks(state);

  const blockType = typeof block.type === "string" ? block.type : "unknown";

  if (blockType === "text") {
    blocks.set(blockIndex, {
      type: "text",
      outputIndex: allocatedOutputIndex,
      argBuffer: "",
    });
    // M17 R7 + R14 — capture FIRST text block's allocated msg id into
    // the per-stream aggregator. Subsequent text blocks within the
    // same message_start..message_stop boundary leave the builder
    // alone (no-overwrite invariant) so the aggregated message item
    // keeps the FIRST block's id at message_stop flush time.
    if (
      state.assistantMessageBuilder === null ||
      state.assistantMessageBuilder === undefined
    ) {
      state.assistantMessageBuilder = {
        id: `msg_${allocatedOutputIndex}`,
        text: "",
      };
    }
    // M17.5 F-M17-Discrim-3 (MEDIUM, user choice option a) — align
    // the per-block `output_item.added.item.id` to the FIRST builder
    // id (NOT this block's `msg_${allocatedOutputIndex}`). For the
    // FIRST text block within a message, builder.id was just
    // initialized to `msg_${allocatedOutputIndex}` above, so
    // builder.id === `msg_${allocatedOutputIndex}` (no observable
    // change). For SUBSEQUENT text blocks within the same message,
    // builder.id sticks at the FIRST block's id; the per-block added
    // event's `item.id` now matches the per-block done event's
    // `item.id` (both use builder.id) AND matches the terminal
    // `output[]` aggregation (also builder.id per R7). Codex CLI
    // can still distinguish individual text-block boundaries via
    // `output_index` (which IS this block's allocatedOutputIndex —
    // not muted by the id alignment).
    return {
      events_out: [
        {
          type: "response.output_item.added",
          output_index: allocatedOutputIndex,
          item: {
            type: "message",
            id: state.assistantMessageBuilder.id,
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: "", annotations: [] }],
          },
        },
        {
          type: "response.content_part.added",
          output_index: allocatedOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      ],
      applied: true,
    };
  }
  if (blockType === "tool_use") {
    const id = strOr(block, "id", `call_${allocatedOutputIndex}`);
    const name = strOr(block, "name", "");
    blocks.set(blockIndex, {
      type: "tool_use",
      toolId: id,
      toolName: name,
      outputIndex: allocatedOutputIndex,
      argBuffer: "",
    });
    return {
      events_out: [
        {
          type: "response.output_item.added",
          output_index: allocatedOutputIndex,
          item: {
            type: "function_call",
            id,
            call_id: id,
            name,
            arguments: "",
            status: "in_progress",
          },
        },
      ],
      applied: true,
    };
  }
  if (blockType === "thinking") {
    // Emit reasoning_summary_part.added and allocate a fresh summary_index per
    // Anthropic thinking block: each block on the Anthropic side is a
    // self-contained reasoning unit, so it maps to one Responses-side
    // reasoning_summary segment with its own (output_index, summary_index)
    // pair. Multi-segment upstream (3+ summary_index values inside a single
    // output_index in the captured GPT-5.5 stream) collapses to one segment
    // per Anthropic thinking block on the forward path — the parallel
    // structure exists Anthropic-side via distinct content_block.index
    // values rather than via per-output sub-segments.
    const allocatedSummaryIndex =
      typeof state.summaryIndex === "number" ? state.summaryIndex : 0;
    state.summaryIndex = allocatedSummaryIndex + 1;
    blocks.set(blockIndex, {
      type: "thinking",
      outputIndex: allocatedOutputIndex,
      argBuffer: "",
    });
    return {
      events_out: [
        {
          type: "response.reasoning_summary_part.added",
          output_index: allocatedOutputIndex,
          summary_index: allocatedSummaryIndex,
          part: { type: "summary_text", text: "" },
        },
      ],
      applied: true,
    };
  }
  // UNMAPPABLE per M7b.6 D-LOCK-2(a) — unknown block type. Record meta
  // with the original type string for symmetry (so the matching stop
  // can find + delete it, per iter-1 F5 lifecycle preservation), then
  // return applied:false so the engine default-passthrough emits the
  // original content_block_start unchanged.
  blocks.set(blockIndex, {
    type: blockType,
    outputIndex: allocatedOutputIndex,
    argBuffer: "",
  });
  return { events_out: [], applied: false };
}

/**
 * Handle `content_block_delta` for `text_delta` / `input_json_delta` /
 * `thinking_delta`. Mirrors bundle lines 2313-2330.
 *
 * **M7b.5 F1.** Looks up the per-block meta by `content_block.index`
 * to determine block TYPE (was: a stream-wide scalar that races for
 * interleaved blocks) AND to pull the captured `outputIndex` for emit.
 *
 * For `input_json_delta`: APPENDS to that block's `argBuffer` AND emits
 * the per-chunk `response.function_call_arguments.delta` (preserves
 * streaming UX for clients consuming deltas).
 *
 * **Defensive lazy-init.** Tests sometimes inject deltas without a
 * preceding start event. To preserve the M7b iter-1 "buffer
 * initializes on first delta" defensiveness, when no meta exists for
 * the index AND the delta is `input_json_delta`, we conservatively
 * create a `tool_use` meta with empty id/name (the test that exercises
 * this path doesn't inspect those fields). Other delta types on a
 * missing meta keep the M7b.5 DEFENSIVE NO-OP behavior (D-LOCK-2(c)
 * type-mismatch / no-meta — `applied: true, events_out: []`).
 *
 * **M7b.6 default-passthrough (D-LOCK-1).** `thinking_delta` and
 * unknown delta types on a valid meta return `applied: false`; engine
 * default-passthrough emits the original event unchanged.
 *
 * **M10 D-LOCK-9 forward thinking.** `thinking_delta` is now TRANSLATED
 * to `response.reasoning_summary_text.delta` (NOT default-passthrough).
 * `signature_delta` for thinking blocks is DROPPED with a debug log —
 * Responses has no signature_delta equivalent and forwarding the raw
 * Anthropic-shape signature_delta into a Responses-shape consumer is a
 * protocol-pair leak (D9). Unknown delta types continue to return
 * `applied: false` for engine default-passthrough.
 */
function handleContentBlockDelta(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const delta =
    typeof parsed.delta === "object" && parsed.delta !== null
      ? (parsed.delta as Record<string, unknown>)
      : {};
  const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
  const blocks = ensureContentBlocks(state);
  const meta = blocks.get(blockIndex);

  if (delta.type === "text_delta") {
    if (meta === undefined || meta.type !== "text") {
      // DEFENSIVE NO-OP per M7b.6 D-LOCK-2(c): malformed-stream defense.
      // text_delta on a missing or non-text meta — passing the original
      // event through could corrupt a downstream Anthropic parser
      // (it would see a text_delta against a non-text/missing block).
      // Suppress with applied:true so the engine does NOT default-passthrough.
      return { events_out: [], applied: true };
    }
    const text = typeof delta.text === "string" ? delta.text : "";
    // Accumulate text deltas into the per-block
    // buffer so `content_block_stop` can emit the FULL accumulated text in
    // `response.output_text.done.text` + `response.content_part.done.part.text`.
    // OpenAI Responses spec requires the `done` events' text field to carry
    // the final accumulated string; Codex relies on this to render the
    // assistant message. Empty `done.text` (the previous bug) made Codex
    // render nothing for Codex→Claude (Lane 5). The existing `argBuffer`
    // field is reused — for text blocks it now serves as the textBuffer
    // (single-purpose-per-block-type usage; thinking blocks intentionally
    // leave this empty per H3 LOCKED).
    meta.argBuffer = meta.argBuffer + text;
    return {
      events_out: [
        {
          type: "response.output_text.delta",
          output_index: meta.outputIndex,
          content_index: 0,
          delta: text,
        },
      ],
      applied: true,
    };
  }
  if (delta.type === "input_json_delta") {
    let effective = meta;
    if (effective === undefined) {
      // Defensive lazy-init — preserve the M7b iter-1 contract that a
      // delta with no prior start still appends to a fresh buffer at
      // that index. Stop on this index later will emit "{}" with empty
      // id/name; this matches the iter-1 defensive test.
      effective = {
        type: "tool_use",
        outputIndex: state.outputIndex ?? 0,
        argBuffer: "",
      };
      blocks.set(blockIndex, effective);
    }
    if (effective.type !== "tool_use") {
      // DEFENSIVE NO-OP per M7b.6 D-LOCK-2(c): malformed-stream defense.
      // input_json_delta on a non-tool_use meta (block at this index is
      // text/thinking/unknown). Suppress with applied:true so the
      // engine does NOT default-passthrough a malformed event.
      return { events_out: [], applied: true };
    }
    const partial =
      typeof delta.partial_json === "string" ? delta.partial_json : "";
    effective.argBuffer = effective.argBuffer + partial;
    // Emit the streaming delta so clients consuming
    // `response.function_call_arguments.delta` events still see chunks.
    return {
      events_out: [
        {
          type: "response.function_call_arguments.delta",
          output_index: effective.outputIndex,
          delta: partial,
        },
      ],
      applied: true,
    };
  }
  if (delta.type === "thinking_delta") {
    // M10 D-LOCK-9 forward thinking — emit reasoning_summary_text.delta.
    // Lookup the per-block meta to confirm this delta belongs to a thinking
    // block AND to recover the captured outputIndex (matches the index
    // allocated at content_block_start time).
    if (meta === undefined || meta.type !== "thinking") {
      // DEFENSIVE NO-OP per M7b.6 D-LOCK-2(c): malformed-stream defense.
      // thinking_delta on a missing or non-thinking meta — passing the
      // original event through could corrupt a downstream Responses
      // parser. Suppress with applied:true so the engine does NOT
      // default-passthrough.
      debug.on(
        LEVEL_ON,
        () =>
          `translate_anthropic_event_to_responses_event: thinking_delta on missing/non-thinking meta at index ${blockIndex} (meta.type=${meta?.type ?? "<undefined>"}) — DROPPED`,
      );
      return { events_out: [], applied: true };
    }
    const text = typeof delta.thinking === "string" ? delta.thinking : "";
    // summaryIndex was allocated at content_block_start time and
    // INCREMENTED there. The block's emit-time summary_index is
    // (state.summaryIndex - 1) — but more correctly, it's the value
    // captured at start. We don't store it on ContentBlockMeta (per
    // D-LOCK-10 NO new explicit fields constraint), so we recover it as
    // (state.summaryIndex ?? 1) - 1. Tests + production wire have
    // exactly one in-flight thinking block at a time on the forward path
    // (Anthropic emits content_block_stop before content_block_start
    // for the next block per its strict alternation invariant), so this
    // recovery is unambiguous.
    const summaryIndex = ((state.summaryIndex as number | undefined) ?? 1) - 1;
    return {
      events_out: [
        {
          type: "response.reasoning_summary_text.delta",
          output_index: meta.outputIndex,
          summary_index: summaryIndex,
          delta: text,
        },
      ],
      applied: true,
    };
  }
  if (delta.type === "signature_delta") {
    // M10 D-LOCK-9 forward thinking — DROP. Responses has no
    // signature_delta equivalent (Anthropic's signature_delta carries an
    // opaque cryptographic signature that travels with thinking blocks
    // for downstream verification; Responses-shape consumers have no
    // notion of this). Forwarding the raw event would be a protocol-pair
    // leak (D9 don't-leak-foreign-protocol). Suppress with applied:true
    // so the engine does NOT default-passthrough.
    debug.on(
      LEVEL_ON,
      () =>
        `translate_anthropic_event_to_responses_event: signature_delta at index ${blockIndex} — DROPPED (no Responses equivalent)`,
    );
    return { events_out: [], applied: true };
  }
  // UNMAPPABLE per M7b.6 D-LOCK-2(a) — unknown delta types have no
  // Responses equivalent. Return applied:false so the engine
  // default-passthrough at apply_event.ts:237-240 emits the original
  // content_block_delta event unchanged. Operator can opt-in to drop via
  // future `drop_stream_event` rule (M7b.7 / M9).
  return { events_out: [], applied: false };
}

/**
 * Handle `content_block_stop` for text / tool_use blocks. Mirrors
 * bundle lines 2332-2373.
 *
 * **M7b.5 F1.** Looks up the per-block meta by `content_block.index`
 * (NOT a stream-wide scalar). Uses THAT block's captured `outputIndex`,
 * `toolId`, `toolName`, and `argBuffer` for the terminal events. Out-of-
 * order stops therefore emit each block's own correct metadata. Deletes
 * the meta entry after emit so a stale entry never leaks.
 *
 * For tool_use: empty buffer → `"{}"` default (F26).
 *
 * **M7b.6 default-passthrough (D-LOCK-1).** For unknown blocks with valid
 * meta, return `applied: false` so the engine forwards the original
 * `content_block_stop`. The per-block meta delete (lifecycle) is
 * INDEPENDENT of the `applied` return — runs unconditionally per
 * iter-1 F5 / iter-2 F8.
 *
 * **M10 D-LOCK-9 forward thinking.** For thinking blocks, emit
 * `response.reasoning_summary_text.done` followed by
 * `response.reasoning_summary_part.done` (BOTH carry `text: ""` per H3
 * LOCKED — v2 does NOT accumulate the streamed thinking text). Delete
 * meta entry per F1 lifecycle.
 *
 * No-meta path stays DEFENSIVE NO-OP per D-LOCK-2(d) (out-of-order or
 * malformed stream — passing the original through could confuse a
 * downstream parser that didn't see the matching start).
 */
function handleContentBlockStop(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
  const blocks = ensureContentBlocks(state);
  const meta = blocks.get(blockIndex);
  if (meta === undefined) {
    // DEFENSIVE NO-OP per M7b.6 D-LOCK-2(d): no-meta — the
    // content_block_stop arrived without a matching content_block_start
    // (out-of-order or malformed stream). Suppress with applied:true so
    // the engine does NOT default-passthrough an event that would
    // confuse a downstream parser missing the corresponding open.
    return { events_out: [], applied: true };
  }
  const events: AnyEvent[] = [];
  if (meta.type === "text") {
    // Emit accumulated text deltas in BOTH
    // `done` events. Previously hardcoded `text: ""` left Codex with no
    // visible assistant message on the Codex→Claude lane (Lane 5).
    // Per OpenAI Responses spec the `done` events' text field carries the
    // FINAL accumulated text. The `argBuffer` field on this block's meta
    // was repurposed as the textBuffer in handleContentBlockDelta's
    // text_delta branch; read it back here.
    const accumulatedText = meta.argBuffer;
    // M17 R7 — APPEND this text block's accumulated text to the
    // per-message aggregator. The aggregated message item is FLUSHED
    // at message_stop (NOT here) so multiple text blocks within a
    // single message_start..message_stop boundary collapse into one
    // {type:"message", ...} output item. Defensive: if the builder is
    // missing (e.g. ad-hoc test that injects text content_block_stop
    // without going through content_block_start), seed it now using
    // this block's outputIndex as a fallback msg id.
    if (
      state.assistantMessageBuilder === null ||
      state.assistantMessageBuilder === undefined
    ) {
      state.assistantMessageBuilder = {
        id: `msg_${meta.outputIndex}`,
        text: "",
      };
    }
    state.assistantMessageBuilder.text =
      state.assistantMessageBuilder.text + accumulatedText;
    events.push({
      type: "response.output_text.done",
      output_index: meta.outputIndex,
      content_index: 0,
      text: accumulatedText,
    });
    events.push({
      type: "response.content_part.done",
      output_index: meta.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: accumulatedText },
    });
    events.push({
      type: "response.output_item.done",
      output_index: meta.outputIndex,
      // M17 D42 — codex CLI's `codex_api::sse::responses` parser
      // calls `ResponseItem::parse(item)` on output_item.done; the
      // pre-M17 shape (only {type, role, status}) failed parsing
      // because ResponsesMessageItem REQUIRES `id` and `content[]`
      // (verified at src/types/openai-responses.ts:136-146 closed
      // type). Without these fields codex never recognized the
      // message item — the visible-text-rendering bug. Include the
      // full shape: id matches the streamed output_item.added.item.id;
      // content carries this text-block's accumulated text (NOT the
      // aggregated message — multi-text-block aggregation lands in
      // response.completed.output[] per R7, not in per-block
      // output_item.done).
      //
      // **M17.5 F-M17-Discrim-3 (MEDIUM, user choice option a) —
      // align per-block done.id to FIRST-builder id.** Pre-M17.5 used
      // `msg_${meta.outputIndex}`, which for multi-text-block streams
      // diverged from the terminal `output[]` aggregation (which uses
      // FIRST builder id per R7). The aggregation IS one logical
      // message; per-block emits should reflect that. Trade-off: codex
      // CLI cannot distinguish individual text-block boundaries via
      // id alone (sees same msg_N for both blocks), but CAN
      // distinguish via `output_index` (independent of `item.id`).
      // The builder is guaranteed non-null here — handleContentBlockStart
      // text branch initializes it; the defensive seed above (lines
      // 682-690) reseeds it for ad-hoc test paths that skip start.
      item: {
        type: "message",
        id: state.assistantMessageBuilder.id,
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: accumulatedText, annotations: [] },
        ],
      },
    });
    blocks.delete(blockIndex);
    return { events_out: events, applied: true };
  }
  if (meta.type === "tool_use") {
    // F26 fix: assemble args from the per-block buffer; default to "{}".
    const assembled = meta.argBuffer.length > 0 ? meta.argBuffer : "{}";
    const toolId = meta.toolId ?? "";
    const toolName = meta.toolName ?? "";
    // M17 R4 + R14 — push the completed function_call output item into
    // the stream-wide accumulator. id MUST match the streamed
    // response.output_item.added.item.id (toolId per handleContentBlockStart
    // line 353, falls back to call_${outputIndex}). Construct as the
    // narrow ResponsesFunctionCallItem type (M-iter2-2) so the type
    // system catches drift through the catch-all variant.
    const functionCallItem: ResponsesFunctionCallItem = {
      type: "function_call",
      id: toolId,
      call_id: toolId,
      name: toolName,
      arguments: assembled,
      status: "completed",
    };
    if (state.outputItems === undefined) {
      state.outputItems = [];
    }
    state.outputItems.push(functionCallItem);
    events.push({
      type: "response.function_call_arguments.done",
      output_index: meta.outputIndex,
      arguments: assembled,
    });
    events.push({
      type: "response.output_item.done",
      output_index: meta.outputIndex,
      item: {
        type: "function_call",
        id: toolId,
        call_id: toolId,
        name: toolName,
        arguments: assembled,
        status: "completed",
      },
    });
    blocks.delete(blockIndex);
    return { events_out: events, applied: true };
  }
  if (meta.type === "thinking") {
    // M10 D-LOCK-9 forward thinking — emit reasoning_summary_text.done
    // followed by reasoning_summary_part.done. BOTH events carry text:""
    // (LOCKED emit shape per H3 — v2 does NOT accumulate the streamed
    // thinking text client-side; the assembled text is the consumer's
    // responsibility to reconstruct from the deltas if it needs it).
    // Recovers summary_index the same way handleContentBlockDelta does
    // (no per-block storage of summary_index per D-LOCK-10 NO-new-fields
    // constraint; alternation invariant makes lookup unambiguous).
    const summaryIndex = ((state.summaryIndex as number | undefined) ?? 1) - 1;
    // M17 R3 + R14 — push the completed reasoning output item with
    // EMPTY summary array. id is SYNTHESIZED as `rs_${outputIndex}`
    // (the forward translator does not emit response.output_item.added
    // for thinking blocks today — only reasoning_summary_part.added
    // events; adding output_item.added(reasoning) is OUT OF M17 SCOPE).
    const reasoningItem: ResponsesReasoningItem = {
      type: "reasoning",
      id: `rs_${meta.outputIndex}`,
      summary: [],
    };
    if (state.outputItems === undefined) {
      state.outputItems = [];
    }
    state.outputItems.push(reasoningItem);
    events.push({
      type: "response.reasoning_summary_text.done",
      output_index: meta.outputIndex,
      summary_index: summaryIndex,
      text: "",
    });
    events.push({
      type: "response.reasoning_summary_part.done",
      output_index: meta.outputIndex,
      summary_index: summaryIndex,
      part: { type: "summary_text", text: "" },
    });
    blocks.delete(blockIndex);
    return { events_out: events, applied: true };
  }
  // UNMAPPABLE per M7b.6 D-LOCK-2(a) — unknown blocks have no
  // Responses terminal events. Per-block meta delete (lifecycle) is
  // INDEPENDENT of the `applied` return — runs unconditionally per
  // iter-1 F5 / iter-2 F8 so a stale entry never leaks. Engine
  // default-passthrough emits the original content_block_stop unchanged.
  blocks.delete(blockIndex);
  return { events_out: [], applied: false };
}

/**
 * Handle `message_delta` — capture stop_reason and MERGE usage into
 * `state.finalUsage`. NEVER emits an event (bundle line 2375 just
 * mutates state).
 *
 * Merge (not replace) per D-LOCK-9 / bundle line 2380. Anthropic
 * sends only `output_tokens` in `message_delta.usage`; replacing
 * would clobber the `input_tokens` set in `message_start`.
 *
 * **CONSUMED-INTO-STATE per M7b.6 D-LOCK-2(b):** the `message_delta`
 * carries `stop_reason` and incremental `usage` that this translator
 * folds into `state.stopReason` + `state.finalUsage`. The data is
 * subsequently emitted as part of `response.completed` at message_stop
 * time. Returning `applied: true, events_out: []` here is correct —
 * the original `message_delta` MUST be suppressed (engine default-
 * passthrough would forward it, but Responses has no `message_delta`
 * event; the data is already consumed into state for the terminal
 * `response.completed` event).
 */
function handleMessageDelta(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const delta =
    typeof parsed.delta === "object" && parsed.delta !== null
      ? (parsed.delta as Record<string, unknown>)
      : {};
  const stopReason =
    typeof delta.stop_reason === "string" ? delta.stop_reason : null;
  state.stopReason = stopReason;
  const incoming =
    parsed.usage !== null &&
    parsed.usage !== undefined &&
    typeof parsed.usage === "object"
      ? (parsed.usage as Record<string, unknown>)
      : {};
  const prior =
    state.finalUsage !== null &&
    state.finalUsage !== undefined &&
    typeof state.finalUsage === "object"
      ? (state.finalUsage as Record<string, unknown>)
      : {};
  state.finalUsage = { ...prior, ...incoming };
  return { events_out: [], applied: true };
}

/**
 * Handle `message_stop` — emit `response.completed` with assembled
 * usage, then call `releaseStreamState(state.requestId)` if the engine
 * seeded it (D-LOCK-3 / D-LOCK-12). When `state.requestId` is missing
 * (e.g., test that doesn't go through `acquireStreamState`), the
 * release is a no-op — production lifecycle relies on M5's stream
 * handler having seeded the field.
 */
function handleMessageStop(
  _parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  // M17 R7 — FLUSH the per-message text aggregator into a single
  // {type:"message", ...} output item AT MESSAGE_STOP TIME (NOT at
  // text content_block_stop). Multiple text blocks within one
  // message_start..message_stop boundary collapse to ONE message item
  // whose `content[0].text` is the concatenation of every text
  // block's accumulated argBuffer. Per R8, this message item is
  // appended LAST to outputItems regardless of where text_delta
  // events fired in the stream. Per R6 Option B, NO `logprobs` field
  // (omit; the closed ResponsesMessageItem.content[] type does not
  // declare it; codex CLI tolerates absence per Lane 5 evidence).
  //
  // **M17.5 F-M17-Discrim-1 (HIGH) — empty-text flush guard.** Gate
  // the flush on `builder.text.length > 0`. An Anthropic upstream
  // emitting `content_block_start(text)` → `content_block_stop` (no
  // text_delta) or with a single empty-string text_delta is
  // structurally valid but the resulting message item would carry an
  // empty `content[0].text`. Per F36/F49/F51 lessons (silent-blank-
  // render is the same bug class M17 was meant to defeat), we OMIT
  // the empty message item from `output[]` rather than synthesize it.
  // The `state.assistantMessageBuilder = null` reset is UNCONDITIONAL
  // — once message_stop fires, the builder is always cleared,
  // regardless of whether a non-empty flush occurred.
  if (
    state.assistantMessageBuilder !== null &&
    state.assistantMessageBuilder !== undefined &&
    state.assistantMessageBuilder.text.length > 0
  ) {
    const messageItem: ResponsesMessageItem = {
      type: "message",
      id: state.assistantMessageBuilder.id,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: state.assistantMessageBuilder.text,
          annotations: [],
        },
      ],
    };
    if (state.outputItems === undefined) {
      state.outputItems = [];
    }
    state.outputItems.push(messageItem);
  }
  // M17.5 F-M17-Discrim-1 — unconditional reset; the builder is
  // consumed at message_stop regardless of whether a flush happened.
  state.assistantMessageBuilder = null;
  const events: AnyEvent[] = [
    {
      type: "response.completed",
      response: {
        id: state.responseId ?? `resp_${Date.now()}`,
        object: "response",
        model: state.model,
        status: "completed",
        // M17 — replace the historic hardcoded `[]` with the assembled
        // accumulator. Defensive against undefined for backward-compat
        // with tests that don't go through `acquireStreamState` /
        // `initStreamState` (the index-signature open extension lets
        // such tests construct ad-hoc states without outputItems).
        output: state.outputItems ?? [],
        usage: toResponsesUsage(state.finalUsage),
      },
    },
  ];
  if (typeof state.requestId === "string") {
    releaseStreamState(state.requestId);
  }
  return { events_out: events, applied: true };
}

// -----------------------------------------------------------------------------
// Rule fn
// -----------------------------------------------------------------------------

const translate_anthropic_event_to_responses_event: StreamEventTransformFn = (
  ctx: StreamEventContext,
  _options: unknown,
): StreamEventResult => {
  const event = ctx.event;
  // Empty-event safety (D-LOCK-12).
  if (event === null || event === undefined || typeof event !== "object") {
    return { events_out: [], applied: false };
  }
  const parsed = event as Record<string, unknown>;
  const t = parsed.type;
  if (typeof t !== "string") {
    return { events_out: [], applied: false };
  }
  const state = ctx.state;
  switch (t) {
    case "message_start":
      return handleMessageStart(parsed, state);
    case "content_block_start":
      return handleContentBlockStart(parsed, state);
    case "content_block_delta":
      return handleContentBlockDelta(parsed, state);
    case "content_block_stop":
      return handleContentBlockStop(parsed, state);
    case "message_delta":
      return handleMessageDelta(parsed, state);
    case "message_stop":
      return handleMessageStop(parsed, state);
    default:
      // UNMAPPABLE per M7b.6 D-LOCK-2(a) + iter-2 F7 — unknown event
      // types have no Responses equivalent. Return applied:false so
      // the engine default-passthrough at apply_event.ts:237-240 emits
      // the original event unchanged. Operator can opt-in to drop via
      // future `drop_stream_event` rule (deferred to M7b.7 / M9 per
      // iter-1 F2 engine fan-out concern).
      return { events_out: [], applied: false };
  }
};

registerStreamEvent(
  "translate_anthropic_event_to_responses_event",
  translate_anthropic_event_to_responses_event,
  TranslateAnthropicEventToResponsesEventSchema,
  {
    // X6 manifest — every state field this rule reads/writes. M9 uses
    // these for cross-rule read-after-write conflict detection;
    // apply_event.ts surfaces them in AppliedRule.{reads, writes}.
    // M10 D-LOCK-10: summaryIndex added (lazy-allocated counter for
    // reasoning_summary_part.added events on thinking content blocks).
    // M17 R15 + H-iter2-4: outputItems + assistantMessageBuilder added
    // (output[] accumulator + per-message text aggregator for the
    // forward translator's response.completed event).
    reads: [
      "assistantMessageBuilder",
      "contentBlocks",
      "finalUsage",
      "model",
      "outputIndex",
      "outputItems",
      "requestId",
      "responseId",
      "summaryIndex",
    ],
    writes: [
      "assistantMessageBuilder",
      "contentBlocks",
      "finalUsage",
      "model",
      "outputIndex",
      "outputItems",
      "responseId",
      "stopReason",
      "summaryIndex",
    ],
  },
);

export {
  translate_anthropic_event_to_responses_event,
  TranslateAnthropicEventToResponsesEventSchema,
  // Test-only re-export so unit tests can call helpers without going
  // through the full apply_event pipeline.
  toResponsesUsage as _toResponsesUsage,
};
