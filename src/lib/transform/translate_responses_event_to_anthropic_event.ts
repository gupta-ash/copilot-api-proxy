/**
 * translate_responses_event_to_anthropic_event.ts — stream-event-engine
 * rule: rewrite a single OpenAI Responses SSE event into the Anthropic
 * `/v1/messages` SSE event shape.
 *
 * **M7b primitive (built-in).** Self-registers at module load via
 * `registerStreamEvent`. Naming convention
 * `translate_<source>_event_to_<target>_event` per D-LOCK-8 / O19.
 *
 * Lane: **CC→GPT-5.x — response side** (consumer); NOT
 * CC→Claude / Codex→Claude reverse / CC→GPT-4.x. CC sends a
 * `/v1/messages` request, the proxy rewrites the body to Responses
 * shape (M7a's `translate_anthropic_to_responses`), the upstream
 * GPT-5.x `/responses` server returns Responses SSE events. THIS rule
 * translates each one into an Anthropic SSE event so CC sees an
 * Anthropic-shaped stream.
 *
 *   - **NOT** consumed by CC→Claude (passthrough — M5's
 *     `forward-stream.ts` byte-loop).
 *   - **NOT** consumed by Codex→Claude reverse (forward direction; see
 *     `translate_anthropic_event_to_responses_event.ts`).
 *   - **NOT** consumed by CC→GPT-4.x (Chat Completions SSE shape, not
 *     Responses; M9/M10 may add a translator if needed).
 *
 * **Idempotent message_start (D-LOCK / spec item 27).** The Responses
 * stream opens with BOTH `response.created` and `response.in_progress`
 * (back-to-back). Anthropic's `message_start` should fire ONLY ONCE
 * per stream. `state.messageStartSent` is the idempotency guard:
 * checked on both event types, set to `true` after the first emit.
 *
 * **Block-open / block-close discipline.** Anthropic strictly requires
 * a `content_block_start` before `content_block_delta` and a matching
 * `content_block_stop` before the next `content_block_start`.
 * `state.contentBlockOpen` tracks this. For TEXT blocks the translator
 * opens lazily on the first `output_text.delta`. For TOOL_USE blocks
 * (M7b.5 F3) the translator opens EAGERLY on
 * `output_item.added(function_call)` so zero-delta function_calls
 * (parameterless tools — `get_current_time()`) still produce a tool_use
 * content block. `state.contentBlockIndex` increments on every close.
 *
 * **F3 fix (M7b.5 — D25 keystone gate).** M7b iter-1 deferred the
 * tool_use `content_block_start` to the first
 * `function_call_arguments.delta`. For zero-argument tools the
 * Responses stream emits `output_item.added(function_call)` →
 * `function_call_arguments.done(arguments="{}")` → `output_item.done`
 * with NO `*.delta` between them. M7b iter-1 emitted: nothing for
 * `output_item.added` (state-only), nothing for `arguments.done` (no
 * block open → no content_block_stop), nothing for `output_item.done`
 * (no block open → no defensive close). Then `response.completed` set
 * `stop_reason: "tool_use"` — protocol violation: tool_use stop_reason
 * with no preceding tool_use content block. Silent function-call loss.
 *
 * Fix: open `content_block_start` eagerly on
 * `output_item.added(function_call)`. Buffer `*.delta` chunks into
 * `state.toolArgsBuffer` so `arguments.done` can detect the
 * zero-delta case and synthesize a single `input_json_delta` from the
 * `event.arguments` field (Responses always provides the canonical
 * assembled args at done time). Then emit `content_block_stop`. This
 * preserves the Anthropic protocol invariant for zero-arg tool_use
 * AND preserves the streaming UX for non-zero-arg cases.
 *
 * **STREAM-EVENT scope only (D-LOCK-7).** This rule receives ONE
 * Responses SSE event (the parsed `data: {...}` JSON; the `event: ...`
 * header is informational only — `eventType = parsed.type` is the
 * discriminator). It returns 0..N Anthropic SSE events. NO body
 * translation.
 *
 * **Sync only (D-LOCK-10 / per types.ts).** No async work. No `await`.
 * The hot path is per-event with a <1ms budget per N8.
 *
 * **Empty-event safety (D-LOCK-12).** Defensive on `null` /
 * `undefined` events, missing `type`. Per M7b.6 D-LOCK-1: unknown
 * `type` returns `applied: false` so the engine default-passthrough
 * at `apply_event.ts:237-240` emits the original event unchanged.
 *
 * **M7b.6 default-passthrough refactor (D-LOCK-1 + D-LOCK-7).** UNMAPPABLE
 * events (no Anthropic-format equivalent — `response.content_part.added`,
 * `response.content_part.done`, unknown top-level event types) return
 * `{ events_out: [], applied: false }`. Engine default-passthrough then
 * forwards the original event unchanged. Sub-handler signatures promoted
 * from `AnyEvent[]` to `StreamEventResult` so each handler self-determines
 * its `applied` flag (Option A3 per iter-2 F1). The top-level switch's
 * hardcoded `applied: true` wrapper is removed.
 *
 * **M10 D-LOCK-9 reverse thinking translation.** The 4 reasoning_summary
 * event types are now TRANSLATED (not default-passthrough):
 *   - `response.reasoning_summary_part.added` → `content_block_start`
 *     with `content_block: { type: "thinking", thinking: "" }`. Eager-
 *     open per M7b.5 F3 pattern. State: `currentToolType = "thinking"`
 *     (M10-widened union per D-LOCK-10), `thinkingTextBuffer = ""`.
 *   - `response.reasoning_summary_text.delta` → `content_block_delta`
 *     with `delta: { type: "thinking_delta", thinking: <delta.delta> }`.
 *     Append to `thinkingTextBuffer`.
 *   - `response.reasoning_summary_text.done` → CONSUMED-INTO-STATE per
 *     D-LOCK-2(b); matching `part.done` will close.
 *   - `response.reasoning_summary_part.done` → `content_block_stop`,
 *     increment `contentBlockIndex`, clear `thinkingTextBuffer`.
 * Defensive guards: text.delta / part.done with no open thinking block
 * drop with debug log; do NOT crash.
 *
 * CONSUMED-INTO-STATE sites (idempotent guard for duplicate
 * `response.in_progress`; `output_item.added(message)` lazy-block-open
 * pattern) keep `applied: true, events_out: []` per D-LOCK-2(b).
 * DEFENSIVE NO-OP sites (no-block-open guards on output_text.done +
 * function_call_arguments.done; malformed-input guard on
 * output_item.added) keep `applied: true, events_out: []` per
 * D-LOCK-2(c)/(d). Defensive close-only path on `output_item.done` for
 * unknown item types AND `output_item.added` for unknown string item.type
 * (D30 symmetry — was applied:false UNMAPPABLE pre-D30) keep `applied:
 * true` per D-LOCK-2(e).
 *
 * **Web-search OUT OF SCOPE for M7b MVP.** The bundle's translator at
 * line 1683-1750 implements server-side `web_search_call` translation
 * (creating synthetic `srvtoolu_*` ids). v2's MVP M7b skips this —
 * web_search support is a Phase 3 enhancement (M9/M10 follow-up).
 * `state.webSearchIds` is reserved on `StreamState` for forward-compat
 * but the translator does NOT populate it.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js`:
 *   - `translateResponsesEventToAnthropicEvents` at line 1596
 *     (general structure + emit shapes; v2 mirrors per-event-type
 *     branches MINUS the web_search special-case).
 * Differences from bundle:
 *   - **Engine integration.** Registered as a stream-event rule
 *     (consumed by M2's `apply_event.ts`); bundle inlines the
 *     translator in its stream handler.
 *   - **Per-stream state.** v2 uses M7b's typed `StreamState`
 *     (with explicit `messageStartSent` + `contentBlockOpen` flags);
 *     bundle uses ad-hoc property bags on positional `streamState`.
 *   - **Web_search MVP omission.** v2 does NOT translate
 *     `response.output_item.added` for `web_search_call` items. Adding
 *     it back is a small lift (M9/M10).
 *   - **Defensive shape.** v2 explicitly handles `eventType === undefined`.
 *     Unknown event types AND UNMAPPABLE inline cases
 *     (`response.content_part.added/done`) return `applied: false` per
 *     M7b.6 D-LOCK-1; the engine forwards the original via
 *     default-passthrough. The `output_item.added(unknown string item.type)`
 *     branch is suppressed via D-LOCK-2(e) close-only per D30 (symmetry
 *     with `output_item.done(unknown)` — preserves Anthropic-shape
 *     downstream invariant per D9).
 *   - **M7b.5 F3 — eager tool_use block open.** v2 opens
 *     `content_block_start` for tool_use on
 *     `output_item.added(function_call)` (not lazily on first delta) so
 *     zero-delta function_calls still emit a complete tool_use block.
 *     The bundle has the same lazy-open bug; v2 fixes it.
 *
 * **Cross-references.**
 *   - `sse-state.ts` — concrete `StreamState` shape.
 *   - `translate_anthropic_event_to_responses_event.ts` — reverse direction.
 *   - decisions.md § D-LOCK-1 (M7b spec) — lane scoping.
 *   - M7b.5 spec § F3 — discriminator-driven hardening.
 */

import { z } from "zod";

import { LEVEL_ON, debug } from "../debug.ts";

import { releaseStreamState } from "./sse-state.ts";
import { registerStreamEvent } from "./registry.ts";
import type { StreamState } from "./sse-state.ts";
import type {
  AnyEvent,
  StreamEventContext,
  StreamEventResult,
  StreamEventTransformFn,
} from "./types.ts";

const TranslateResponsesEventToAnthropicEventSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_responses_event_to_anthropic_event"),
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

/** Read a string-typed field from an arbitrary object, default fallback. */
function strOr(obj: unknown, key: string, fallback: string): string {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return fallback;
  }
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : fallback;
}

/** Read an object-typed field, returning {} when missing. */
function objOr(obj: unknown, key: string): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return {};
  }
  const v = (obj as Record<string, unknown>)[key];
  if (v === null || v === undefined || typeof v !== "object") return {};
  return v as Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Per-event-type handlers
// -----------------------------------------------------------------------------

/**
 * Handle `response.created` / `response.in_progress` — emit
 * `message_start` ONLY ONCE per stream (idempotency via
 * `state.messageStartSent`). Mirrors bundle lines 1602-1620.
 *
 * **CONSUMED-INTO-STATE per M7b.6 D-LOCK-2(b):** the duplicate
 * `response.in_progress` (after `response.created` already fired
 * `message_start`) is intentionally consumed-into-state via the
 * `state.messageStartSent` flag. Emitting nothing here is correct —
 * Anthropic has no `message_in_progress` event; the data is already
 * captured in `message_start`. Returning `applied: true, events_out: []`
 * suppresses the duplicate; engine MUST NOT default-passthrough it
 * (would inject a spurious `response.in_progress` into the Anthropic
 * stream).
 */
function handleResponseCreated(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  if (state.messageStartSent === true) {
    return { events_out: [], applied: true };
  }
  state.messageStartSent = true;
  const response = objOr(parsed, "response");
  const id = strOr(response, "id", `msg_${Date.now()}`);
  const model = strOr(response, "model", state.model ?? "");
  state.responseId = id;
  state.model = model;
  return {
    events_out: [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ],
    applied: true,
  };
}

/**
 * Handle `response.output_text.delta` — emit a `text_delta` content
 * block delta. Lazily opens a `text` content_block_start when the
 * stream's first text delta arrives. Mirrors bundle lines 1622-1636.
 */
function handleOutputTextDelta(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const events: AnyEvent[] = [];
  const idx = state.contentBlockIndex ?? 0;
  if (state.contentBlockOpen !== true) {
    state.contentBlockOpen = true;
    state.currentToolType = "text";
    events.push({
      type: "content_block_start",
      index: idx,
      content_block: { type: "text", text: "" },
    });
  }
  const delta = typeof parsed.delta === "string" ? parsed.delta : "";
  events.push({
    type: "content_block_delta",
    index: idx,
    delta: { type: "text_delta", text: delta },
  });
  return { events_out: events, applied: true };
}

/**
 * Handle `response.output_text.done` — emit `content_block_stop` if a
 * text block is open. Mirrors bundle lines 1638-1647.
 *
 * **DEFENSIVE NO-OP per M7b.6 D-LOCK-2(d) (no-block-open guard, per
 * iter-3 H1):** when no block is open, the `output_text.done` arrived
 * without a matching open (out-of-order or already-closed stream).
 * Returning `applied: true, events_out: []` suppresses it; engine MUST
 * NOT default-passthrough an Anthropic-irrelevant event that has no
 * matching content block.
 */
function handleOutputTextDone(state: StreamState): StreamEventResult {
  if (state.contentBlockOpen !== true) {
    return { events_out: [], applied: true };
  }
  const idx = state.contentBlockIndex ?? 0;
  state.contentBlockOpen = false;
  state.contentBlockIndex = idx + 1;
  state.currentToolType = null;
  return {
    events_out: [{ type: "content_block_stop", index: idx }],
    applied: true,
  };
}

/**
 * Handle `response.function_call_arguments.delta` — emit
 * `input_json_delta` content_block_delta. The `tool_use`
 * content_block_start was already opened EAGERLY on
 * `response.output_item.added(function_call)` (M7b.5 F3), so the
 * delta path no longer opens a block — it only emits the chunk and
 * appends to the buffer for the F3 zero-delta detection at
 * `function_call_arguments.done` time.
 *
 * Defensive lazy-open: if for some reason no `output_item.added`
 * preceded this delta (out-of-spec stream from upstream), fall back
 * to opening the block here with whatever id/name we have. This
 * preserves the M7b iter-1 robustness for malformed inputs.
 *
 * Mirrors bundle lines 1649-1668 with the lazy-open kept as a
 * fallback (eager-open is the new primary path).
 */
function handleFunctionCallArgsDelta(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const events: AnyEvent[] = [];
  const idx = state.contentBlockIndex ?? 0;
  if (state.contentBlockOpen !== true) {
    // Defensive lazy-open — should not happen on well-formed Responses
    // streams (output_item.added comes first per F3), but preserve the
    // M7b iter-1 path so malformed inputs don't lose data.
    state.contentBlockOpen = true;
    state.currentToolType = "tool_use";
    const fallbackId = strOr(parsed, "item_id", "");
    const id =
      state.currentToolCallId !== undefined && state.currentToolCallId !== null
        ? state.currentToolCallId
        : fallbackId.length > 0
          ? fallbackId
          : `toolu_${Date.now()}`;
    const name = state.currentToolName ?? "";
    events.push({
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id, name, input: {} },
    });
  }
  const delta = typeof parsed.delta === "string" ? parsed.delta : "";
  // M7b.5 F3: append to toolArgsBuffer so arguments.done can detect
  // the zero-delta case and synthesize a single input_json_delta from
  // event.arguments.
  state.toolArgsBuffer = (state.toolArgsBuffer ?? "") + delta;
  events.push({
    type: "content_block_delta",
    index: idx,
    delta: { type: "input_json_delta", partial_json: delta },
  });
  return { events_out: events, applied: true };
}

/**
 * Handle `response.function_call_arguments.done` — close the eagerly-
 * opened tool_use block (M7b.5 F3).
 *
 * Zero-delta synthesis: if no `*.delta` events arrived
 * (`state.toolArgsBuffer === ""`), the block was opened with no
 * `content_block_delta` after it. The Anthropic spec requires that
 * the tool_use block carry the assembled args — so synthesize a
 * single `input_json_delta` from `event.arguments` (Responses always
 * provides the canonical assembled args at done time) BEFORE the
 * `content_block_stop`. Empty / missing `event.arguments` falls back
 * to `"{}"` for parity with the forward translator's empty-args
 * handling.
 *
 * Resets `state.toolArgsBuffer` after emit so the next function_call
 * starts fresh.
 *
 * Mirrors bundle lines 1670-1680 with the F3 zero-delta synthesis
 * added.
 *
 * **DEFENSIVE NO-OP per M7b.6 D-LOCK-2(d) (no-block-open guard, per
 * iter-3 H1):** when no block is open, the `function_call_arguments.done`
 * arrived without a matching open. Returning `applied: true,
 * events_out: []` suppresses; engine MUST NOT default-passthrough.
 */
function handleFunctionCallArgsDone(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  if (state.contentBlockOpen !== true) {
    // No eager-open happened (e.g., reset flow). Defensive no-op.
    return { events_out: [], applied: true };
  }
  const idx = state.contentBlockIndex ?? 0;
  const events: AnyEvent[] = [];
  // M7b.5 F3 zero-delta synthesis.
  const buffered = state.toolArgsBuffer ?? "";
  if (buffered.length === 0) {
    const eventArgs =
      typeof parsed.arguments === "string" ? parsed.arguments : "";
    const synthesized = eventArgs.length > 0 ? eventArgs : "{}";
    events.push({
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: synthesized },
    });
  }
  events.push({ type: "content_block_stop", index: idx });
  state.contentBlockOpen = false;
  state.contentBlockIndex = idx + 1;
  state.currentToolType = null;
  state.toolArgsBuffer = "";
  return { events_out: events, applied: true };
}

/**
 * Handle `response.output_item.added` — for `function_call` items,
 * cache the call_id + name into state AND **eagerly open** the
 * Anthropic `content_block_start` for tool_use (M7b.5 F3). The eager
 * open ensures zero-delta function_calls (parameterless tools) still
 * produce a complete tool_use block (start + at least one delta + stop)
 * so the Anthropic protocol invariant `stop_reason: "tool_use"` →
 * preceding tool_use content_block holds.
 *
 * Mirrors bundle lines 1682-1686 (state caching) PLUS adds the eager
 * `content_block_start` emission.
 *
 * **MVP omission.** Bundle also handles `web_search_call` here
 * (lines 1687-1712); v2 skips for M7b MVP.
 *
 * **Branch order per M7b.6 D-LOCK-3 (iter-3 M1) + D30 (iter-3 followup):**
 *   1. `function_call` — F3 eager-open logic; `applied: true`.
 *   2. `message` — CONSUMED-INTO-STATE per D-LOCK-2(b); Anthropic block
 *      opens lazily via `handleOutputTextDelta`. `applied: true,
 *      events_out: []` so engine does NOT default-passthrough (Anthropic
 *      has no `output_item.added(message)` event; data is consumed
 *      into the lazy text-block-open mechanic).
 *   3. malformed (`typeof item?.type !== "string"`) — DEFENSIVE NO-OP per
 *      D-LOCK-2(d); applied:true so engine does NOT default-passthrough
 *      a malformed event.
 *   4. else (known string `item.type` with no Anthropic translation, e.g.,
 *      `web_search_call`) — close-only per D-LOCK-2(e) + D30; `applied:
 *      true, events_out: []` so engine does NOT default-passthrough a
 *      Responses-shaped `output_item.added` event into an Anthropic-shape
 *      downstream parser (which would be a protocol-pair leak — D9). This
 *      symmetrically matches `handleOutputItemDone(unknown)` per D30 (was
 *      iter-3 finding 1 MEDIUM; flipped from `applied: false` UNMAPPABLE
 *      passthrough → `applied: true` close-only).
 */
function handleOutputItemAdded(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const item = objOr(parsed, "item");
  if (item.type === "function_call") {
    // call_id PREFERRED over id (bundle line 1684 fallbacks call_id || id).
    const callId =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : `toolu_${Date.now()}`;
    state.currentToolCallId = callId;
    const name = typeof item.name === "string" ? item.name : "unknown";
    state.currentToolName = name;
    // Reset the args buffer for this function_call (F3 zero-delta detection).
    state.toolArgsBuffer = "";
    // M7b.5 F3 eager open. If a prior block is still open (defensive —
    // shouldn't happen on well-formed streams), close it first to
    // preserve Anthropic's strict alternation invariant.
    const events: AnyEvent[] = [];
    if (state.contentBlockOpen === true) {
      const priorIdx = state.contentBlockIndex ?? 0;
      events.push({ type: "content_block_stop", index: priorIdx });
      state.contentBlockIndex = priorIdx + 1;
    }
    const idx = state.contentBlockIndex ?? 0;
    events.push({
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id: callId, name, input: {} },
    });
    state.contentBlockOpen = true;
    state.currentToolType = "tool_use";
    return { events_out: events, applied: true };
  }
  if (item.type === "message") {
    // CONSUMED-INTO-STATE per M7b.6 D-LOCK-2(b): message item type is
    // intentional no-op; handleOutputTextDelta opens the text block
    // lazily on first delta. Suppress with applied:true so engine does
    // NOT default-passthrough an Anthropic-irrelevant event.
    return { events_out: [], applied: true };
  }
  if (typeof item.type !== "string") {
    // DEFENSIVE NO-OP per M7b.6 D-LOCK-2(d): malformed input —
    // item is missing/non-object OR item.type is undefined / non-string.
    // Suppress with applied:true so engine does NOT default-passthrough
    // a malformed event.
    return { events_out: [], applied: true };
  }
  // Close-only per M7b.6 D-LOCK-2(e) + D30 (iter-3 followup) — known
  // string item.type with no Anthropic translation (e.g.,
  // `web_search_call`, future server-tool types). Suppressed with
  // applied:true so engine does NOT default-passthrough a Responses-
  // shaped `output_item.added` event into an Anthropic-shape downstream
  // parser (would be a protocol-pair leak — D9 don't-leak-foreign-
  // protocol). Symmetrically matches `handleOutputItemDone(unknown)`
  // per D30; the matching `output_item.done` is also suppressed, so the
  // pair is jointly invisible to the Anthropic-shape downstream.
  // Operator opt-in to forward to a Responses-shape observer is a
  // future `forward_stream_event` rule (M7b.7 / M9).
  return { events_out: [], applied: true };
}

/**
 * Handle `response.output_item.done` — for `function_call` items,
 * close any lingering open block (defensive) and clear the cached
 * tool fields. For `message` items, also a defensive close.
 *
 * Bundle line 1723 implements `web_search_call` translation here too;
 * v2 MVP skips.
 *
 * **DEFENSIVE NO-OP — close-only per M7b.6 D-LOCK-2(e) (per iter-2 F4
 * final decision):** for unknown `item.type`, the defensive close
 * (when a block is open) IS emitted with `applied: true`. The original
 * `output_item.done` event is INTENTIONALLY suppressed because the
 * defensive close conveys the intent — Anthropic has no
 * `output_item.done` event; the `content_block_stop` IS the equivalent.
 * Returning `applied: true` (whether events_out is the close array or
 * empty) ensures the engine does NOT default-passthrough the original.
 */
function handleOutputItemDone(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const item = objOr(parsed, "item");
  const events: AnyEvent[] = [];
  // Defensive close — most streams close via the explicit `*.done`
  // events, but if we land here with a still-open block, ensure
  // Anthropic's strict alternation invariant holds.
  if (state.contentBlockOpen === true) {
    const idx = state.contentBlockIndex ?? 0;
    events.push({ type: "content_block_stop", index: idx });
    state.contentBlockIndex = idx + 1;
    state.contentBlockOpen = false;
    state.currentToolType = null;
  }
  if (item.type === "function_call") {
    state.currentToolCallId = null;
    state.currentToolName = null;
    state.toolArgsBuffer = "";
  }
  return { events_out: events, applied: true };
}

/**
 * Handle `response.completed` — close any lingering open block, emit
 * `message_delta` (with stop_reason + usage) + `message_stop`, then
 * `releaseStreamState(state.requestId)` if seeded. Mirrors bundle
 * lines 1752-1775.
 *
 * stop_reason determination: if any `function_call` items appear in
 * `response.output[]`, stop_reason = `tool_use`; else `end_turn`.
 * Bundle's logic at line 1767. v2 mirrors.
 */
function handleResponseCompleted(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const events: AnyEvent[] = [];
  if (state.contentBlockOpen === true) {
    const idx = state.contentBlockIndex ?? 0;
    events.push({ type: "content_block_stop", index: idx });
    state.contentBlockIndex = idx + 1;
    state.contentBlockOpen = false;
  }
  const response = objOr(parsed, "response");
  const usage = objOr(response, "usage");
  const output = Array.isArray(response.output) ? response.output : [];
  const hasToolCalls = output.some(
    (o) =>
      typeof o === "object" &&
      o !== null &&
      (o as Record<string, unknown>).type === "function_call",
  );
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  events.push({
    type: "message_delta",
    usage: { output_tokens: outputTokens },
    delta: {
      stop_reason: hasToolCalls ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
  });
  events.push({ type: "message_stop" });
  if (typeof state.requestId === "string") {
    releaseStreamState(state.requestId);
  }
  return { events_out: events, applied: true };
}

// -----------------------------------------------------------------------------
// M10 D-LOCK-9 reverse thinking handlers
// -----------------------------------------------------------------------------

/**
 * Handle `response.reasoning_summary_part.added` (M10 D-LOCK-9 reverse).
 * Eager-open a thinking content_block_start (per M7b.5 F3 pattern —
 * matches the eager-open used for tool_use blocks). If a prior block is
 * still open (defensive — should not happen on well-formed streams),
 * close it first to preserve Anthropic's strict alternation invariant.
 *
 * State writes: `contentBlockOpen = true`, `currentToolType = "thinking"`
 * (M10 widened union per D-LOCK-10), `thinkingTextBuffer = ""` (delta
 * accumulator reset for the new segment).
 */
function handleReasoningSummaryPartAdded(
  _parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  const events: AnyEvent[] = [];
  if (state.contentBlockOpen === true) {
    const priorIdx = state.contentBlockIndex ?? 0;
    events.push({ type: "content_block_stop", index: priorIdx });
    state.contentBlockIndex = priorIdx + 1;
    state.contentBlockOpen = false;
    state.currentToolType = null;
  }
  const idx = state.contentBlockIndex ?? 0;
  events.push({
    type: "content_block_start",
    index: idx,
    content_block: { type: "thinking", thinking: "" },
  });
  state.contentBlockOpen = true;
  state.currentToolType = "thinking";
  state.thinkingTextBuffer = "";
  return { events_out: events, applied: true };
}

/**
 * Handle `response.reasoning_summary_text.delta` (M10 D-LOCK-9 reverse).
 * Emit `content_block_delta` with `thinking_delta` payload. Append the
 * delta text to `state.thinkingTextBuffer` (consumer-side accumulator —
 * mirrors the forward translator's pattern of NOT echoing accumulated
 * text on `done` events).
 *
 * **DEFENSIVE NO-OP per D-LOCK-9 / iter-3 H1:** if no thinking block is
 * open (out-of-order or malformed input), drop with debug log; do NOT
 * crash. This guards against:
 *   - text.delta arriving before its matching part.added (out-of-order)
 *   - text.delta arriving after part.done (already-closed segment)
 *   - text.delta with the wrong currentToolType (e.g., a text block was
 *     somehow open via output_text.delta)
 */
function handleReasoningSummaryTextDelta(
  parsed: Record<string, unknown>,
  state: StreamState,
): StreamEventResult {
  if (state.contentBlockOpen !== true || state.currentToolType !== "thinking") {
    debug.on(
      LEVEL_ON,
      () =>
        `translate_responses_event_to_anthropic_event: reasoning_summary_text.delta with no open thinking block (contentBlockOpen=${state.contentBlockOpen}, currentToolType=${state.currentToolType}) — DROPPED`,
    );
    return { events_out: [], applied: true };
  }
  const idx = state.contentBlockIndex ?? 0;
  const delta = typeof parsed.delta === "string" ? parsed.delta : "";
  state.thinkingTextBuffer = (state.thinkingTextBuffer ?? "") + delta;
  return {
    events_out: [
      {
        type: "content_block_delta",
        index: idx,
        delta: { type: "thinking_delta", thinking: delta },
      },
    ],
    applied: true,
  };
}

/**
 * Handle `response.reasoning_summary_text.done` (M10 D-LOCK-9 reverse).
 * CONSUMED-INTO-STATE per D-LOCK-2(b) of M7b.6 — emits NO Anthropic
 * event because the matching `reasoning_summary_part.done` will close
 * the content block. The accumulated text in `state.thinkingTextBuffer`
 * is available for inspection by debug tooling but is NOT emitted.
 * Returning `applied: true, events_out: []` suppresses the original;
 * engine MUST NOT default-passthrough (Anthropic has no
 * `reasoning_summary_text.done` event; the data is captured into the
 * thinking content block via the `*.delta` events).
 */
function handleReasoningSummaryTextDone(
  _state: StreamState,
): StreamEventResult {
  return { events_out: [], applied: true };
}

/**
 * Handle `response.reasoning_summary_part.done` (M10 D-LOCK-9 reverse).
 * Close the eagerly-opened thinking content block. Mirrors the
 * `function_call_arguments.done` close pattern.
 *
 * State writes: increment `contentBlockIndex`, clear `contentBlockOpen`
 * + `currentToolType` + `thinkingTextBuffer`.
 *
 * **DEFENSIVE NO-OP** if no thinking block is open (defensive against
 * upstream emitting part.done without part.added — drop with debug log;
 * do NOT crash).
 */
function handleReasoningSummaryPartDone(state: StreamState): StreamEventResult {
  if (state.contentBlockOpen !== true || state.currentToolType !== "thinking") {
    debug.on(
      LEVEL_ON,
      () =>
        `translate_responses_event_to_anthropic_event: reasoning_summary_part.done with no open thinking block (contentBlockOpen=${state.contentBlockOpen}, currentToolType=${state.currentToolType}) — DROPPED`,
    );
    return { events_out: [], applied: true };
  }
  const idx = state.contentBlockIndex ?? 0;
  state.contentBlockIndex = idx + 1;
  state.contentBlockOpen = false;
  state.currentToolType = null;
  state.thinkingTextBuffer = "";
  return {
    events_out: [{ type: "content_block_stop", index: idx }],
    applied: true,
  };
}

// -----------------------------------------------------------------------------
// Rule fn
// -----------------------------------------------------------------------------

const translate_responses_event_to_anthropic_event: StreamEventTransformFn = (
  ctx: StreamEventContext,
  _options: unknown,
): StreamEventResult => {
  const event = ctx.event;
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
    case "response.created":
    case "response.in_progress":
      return handleResponseCreated(parsed, state);
    case "response.output_text.delta":
      return handleOutputTextDelta(parsed, state);
    case "response.output_text.done":
      return handleOutputTextDone(state);
    case "response.function_call_arguments.delta":
      return handleFunctionCallArgsDelta(parsed, state);
    case "response.function_call_arguments.done":
      return handleFunctionCallArgsDone(parsed, state);
    case "response.output_item.added":
      return handleOutputItemAdded(parsed, state);
    case "response.output_item.done":
      return handleOutputItemDone(parsed, state);
    case "response.content_part.added":
    case "response.content_part.done":
      // UNMAPPABLE per M7b.6 D-LOCK-2(a) + D-LOCK-3 reverse-translator
      // audit: pure structural events on the Responses side; Anthropic
      // has no direct equivalent (its content blocks ARE the equivalent,
      // and they're already managed by the *.delta / *.done handlers).
      // Return applied:false so engine default-passthrough at
      // apply_event.ts:237-240 emits the original event unchanged.
      // Operator can opt-in to drop via future `drop_stream_event` rule
      // (deferred to M7b.7 / M9 per iter-1 F2 engine fan-out concern).
      return { events_out: [], applied: false };
    case "response.reasoning_summary_part.added":
      return handleReasoningSummaryPartAdded(parsed, state);
    case "response.reasoning_summary_text.delta":
      return handleReasoningSummaryTextDelta(parsed, state);
    case "response.reasoning_summary_text.done":
      return handleReasoningSummaryTextDone(state);
    case "response.reasoning_summary_part.done":
      return handleReasoningSummaryPartDone(state);
    case "response.completed":
      return handleResponseCompleted(parsed, state);
    default:
      // UNMAPPABLE per M7b.6 D-LOCK-2(a) + iter-2 F7 — unknown event
      // types have no Anthropic equivalent. Engine default-passthrough
      // emits the original event unchanged.
      return { events_out: [], applied: false };
  }
};

registerStreamEvent(
  "translate_responses_event_to_anthropic_event",
  translate_responses_event_to_anthropic_event,
  TranslateResponsesEventToAnthropicEventSchema,
  {
    // X6 manifest — every state field this rule reads/writes.
    // M10 D-LOCK-10: thinkingTextBuffer added (delta accumulator for
    // reasoning_summary_text.delta on the reverse path). currentToolType
    // is already in both lists (M7b.5).
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
  },
);

export {
  translate_responses_event_to_anthropic_event,
  TranslateResponsesEventToAnthropicEventSchema,
};
