/**
 * sse-state.ts — concrete `StreamState` shape + per-stream lifecycle for
 * M7b's two cross-vendor SSE event translators.
 *
 * **M7b primitive (built-in).** Pure data + lifecycle module. Does NOT
 * self-register with the rule registry — only the two translator files
 * (`translate_anthropic_event_to_responses_event.ts` /
 * `translate_responses_event_to_anthropic_event.ts`) do that.
 *
 * **Refines M2's permissive `StreamState`.** M2 (per `types.ts` line 156)
 * declared `StreamState = Record<string, unknown>` with the explicit note
 * "M7b will refine concrete fields". This module owns that refinement.
 * `types.ts` re-exports `StreamState` from here so the engine surface
 * stays unified — body rules and apply_event continue to import from
 * `types.ts`; M7b translators import directly from `sse-state.ts`.
 *
 * **Lifecycle (D-LOCK-3).** A module-scope `Map<string, StreamState>`
 * keyed by request id holds one entry per in-flight stream. Three
 * helpers manage the map:
 *
 *   - `acquireStreamState(requestId)` — get-or-create. Bumps
 *     `lastTouchedAt = Date.now()` on every call so the GC's age check is
 *     accurate. Idempotent: same id → same StreamState reference. ALSO
 *     lazy-schedules the disconnect-GC `setInterval` on first call (per
 *     M7b.5 / F2 fix — was previously the caller's responsibility but no
 *     caller scheduled it; now self-scheduled on first acquire).
 *   - `releaseStreamState(requestId)` — explicit delete. Called by each
 *     translator on its terminal event (`message_stop` for A→R;
 *     `response.completed` for R→A).
 *   - `gcStaleStreamStates(maxAgeMs?)` — sweep entries whose
 *     `lastTouchedAt` is older than `maxAgeMs` (default 60_000). Called
 *     automatically by the lazy-scheduled timer; also exported for
 *     manual sweeps + tests.
 *   - `shutdownSseState()` — clears the timer + map. Called by tests
 *     (afterEach via `_resetStreamStates`) and (eventually) by M5's
 *     SIGTERM graceful-shutdown handler.
 *
 * **Why `Map<string, StreamState>` and not `WeakMap`?** Per plan v4 C1
 * review fix: WeakMap requires its keys to be objects, throwing
 * TypeError on string keys. The request id is a string (per M5's request
 * lifecycle), so a strong Map is the only option. Memory leakage is
 * controlled by the explicit release on terminal events PLUS the GC
 * sweep on the socket-close path (now actually scheduled, per F2).
 *
 * **Concurrency.** Single-threaded JS event loop — no locking needed
 * for individual `acquire`/`release`. Multiple in-flight streams each
 * get their own `StreamState` reference; rules mutate `state` in place
 * within a single event's apply loop, so cross-stream interference is
 * impossible by construction.
 *
 * **Per-content-block metadata (D-LOCK-4 / F26 / M7b.5 F1).**
 * `contentBlocks` is `Map<number, ContentBlockMeta>` keyed by Anthropic
 * `content_block.index`. Each entry stores everything needed to emit
 * the correct terminal events for THAT specific block at stop time:
 *
 *   - `type`            — original block type (`text` / `tool_use` / `thinking` / ...).
 *   - `toolId` / `toolName` — captured at start; restored at stop. CRUCIAL
 *                         for parallel/interleaved tool_use blocks where
 *                         block-N's start clobbers a single-scalar
 *                         `currentToolId` before block-(N-1)'s stop arrives.
 *   - `outputIndex`     — the Responses-side `output_index` allocated at
 *                         start. Used at stop so each block's done events
 *                         carry the correct allocated index regardless of
 *                         arrival order.
 *   - `argBuffer`       — accumulated `input_json_delta.partial_json`
 *                         chunks for tool_use blocks. Empty / non-existent
 *                         for non-tool blocks.
 *
 * The previous M7b iter-1 design used a single scalar trio
 * (`currentBlockType`, `currentToolId`, `currentToolName`) plus a
 * separate `Map<number, string>` for arg buffers. That created the
 * silent-corruption bug surfaced by D25 keystone discriminator: parallel
 * tool_use blocks with out-of-order stops would emit b1's id/name on
 * b0's stop event (the scalars were last-write-wins). Fix: promote the
 * scalars INTO the per-block map so each block carries its own metadata.
 *
 * **`outputIndex` semantics.** Stays as a stream-wide ALLOCATOR counter
 * — `acquireStreamState` initializes it to 0; each `content_block_start`
 * captures the current value into the new block's `ContentBlockMeta`
 * AND increments the counter. Each `content_block_stop` reads back the
 * captured value from the map (NOT the live counter), so out-of-order
 * stops emit the correct `output_index`.
 *
 * **Cribbed-from.** No direct cribbing — bundle inlined per-stream
 * state as ad-hoc property bags on a single `streamState` object passed
 * positionally to `translateAnthropicEventToResponsesEvents` (line
 * 2232) and `translateResponsesEventToAnthropicEvents` (line 1596).
 * v2's M7b refactors that into a typed module-scope Map so the engine
 * can manage lifecycle (release + GC) explicitly. M7b.5 hardens the
 * per-block metadata into its own typed sub-map.
 *
 * **Cross-references.**
 *   - `types.ts` — re-exports `StreamState` from this file.
 *   - `apply_event.ts` — consumes `ctx.state: StreamState` per event.
 *   - `translate_anthropic_event_to_responses_event.ts` — owns
 *     `contentBlocks`; F26/F1 fix lives there.
 *   - `translate_responses_event_to_anthropic_event.ts` — uses
 *     `messageStartSent`, `contentBlockOpen`, etc.
 *   - decisions.md § D-LOCK-3 (M7b spec) — Map vs WeakMap rationale.
 */

import type { ResponsesOutputItem } from "../../types/openai-responses.ts";

/**
 * Per-content-block metadata for the Anthropic→Responses translator
 * (F1 / D25 fix). One entry per Anthropic `content_block.index`,
 * lifecycle bounded by `content_block_start` (insert) →
 * `content_block_stop` (read + delete).
 *
 * Holding identity (toolId / toolName) and the allocated outputIndex
 * INSIDE the per-block entry is what fixes the parallel-tool-use silent
 * corruption: out-of-order stops can no longer be served the wrong
 * tool's metadata via stream-wide scalars.
 */
export interface ContentBlockMeta {
  /**
   * Original Anthropic block `type` field (`text` / `tool_use` /
   * `thinking` / `server_tool_use` / `web_search_call` / unknown).
   * Read at stop to dispatch the right terminal events.
   *
   * **M10 D-LOCK-9 / D-LOCK-10.** When `type === "thinking"`, the
   * forward translator (`translate_anthropic_event_to_responses_event`)
   * emits the `response.reasoning_summary_part.added/done` +
   * `response.reasoning_summary_text.delta/done` event family on the
   * Responses side; the reverse translator
   * (`translate_responses_event_to_anthropic_event`) accepts those
   * events and emits Anthropic-shape `content_block_*` events back.
   * Per H3 LOCKED, BOTH `done` events on the Responses side carry
   * `text: ""` regardless of the upstream's accumulated text.
   */
  type: string;
  /** tool_use blocks: the tool's `id` (Anthropic call_id). Optional for non-tool blocks. */
  toolId?: string;
  /** tool_use blocks: the tool's `name`. Optional for non-tool blocks. */
  toolName?: string;
  /**
   * The Responses-side `output_index` allocated at block start. Captured
   * here so out-of-order stops emit the correct index. NOT a live read
   * of the stream-wide allocator (which would race for parallel blocks).
   */
  outputIndex: number;
  /**
   * Accumulated `input_json_delta.partial_json` chunks for tool_use
   * blocks. Stays empty for non-tool blocks. Read at
   * `content_block_stop` and emitted as
   * `response.function_call_arguments.done.arguments` /
   * `response.output_item.done.item.arguments`. Empty buffer →
   * `"{}"` default at emit time (some models emit zero-argument tool
   * calls — F26 OQ-PROXY-EMPTY-TOOL-ARGS).
   *
   * **M10 D-LOCK-9 / D-LOCK-10.** For thinking blocks, `argBuffer` is
   * UNUSED — thinking content is delta-only on the Responses side
   * (each `reasoning_summary_text.delta` is emitted independently;
   * v2 does NOT accumulate the streamed thinking text into a single
   * argument string). The field stays empty for thinking blocks.
   */
  argBuffer: string;
}

/**
 * Per-stream mutable state. Both M7b translators read and write fields
 * here; the field set is the union of both translators' needs (so a
 * single state object travels with the stream regardless of which
 * translator owns it on a given lane).
 *
 * **Field grouping.**
 *   - **Identity.** `responseId`, `model`. Captured at the first event
 *     (`message_start` for A→R; `response.created`/`response.in_progress`
 *     for R→A) and read at the terminal event so the closing event
 *     (`response.completed` / `message_stop`) can echo them.
 *   - **Anthropic→Responses (forward).** `outputIndex` (allocator),
 *     `contentBlocks` (per-block metadata + arg buffers — F1 fix),
 *     `finalUsage`, `stopReason`. The previous-iter scalars
 *     (`currentBlockType` / `currentToolId` / `currentToolName` /
 *     `toolArgBuffers`) are GONE — folded into `contentBlocks`.
 *   - **Responses→Anthropic (reverse).** `messageStartSent` (idempotency
 *     guard for the duplicate `response.created` + `response.in_progress`
 *     pair), `contentBlockOpen` (tracks whether a block_start has been
 *     emitted), `contentBlockIndex`, `currentToolType`,
 *     `currentToolCallId`, `currentToolName`, `webSearchIds` (per-server-tool
 *     id mapping for the bundle's web_search support).
 *   - **Lifecycle.** `lastTouchedAt` — wall-clock ms since epoch,
 *     bumped by every `acquireStreamState` call. Used by
 *     `gcStaleStreamStates` to decide whether to evict.
 *
 * **Why one shape for both translators?** Each request has exactly one
 * lane (forward OR reverse), so only one translator's fields are
 * meaningfully populated per request. The unused fields stay at their
 * initial values. Keeping a single shape avoids a discriminated union
 * (with its `if state.kind === "..."` boilerplate) at every read site.
 *
 * **Reverse-translator scalars retained.** `currentToolCallId` /
 * `currentToolName` on the reverse path are SAFE because Responses
 * serializes function_calls one at a time (each `output_item.added`
 * for `function_call` is followed by its own `*.delta*` and
 * `*.done` before any next `output_item.added`). No interleaving on the
 * Responses side, so single scalars are correct there. M7b.5 audit
 * confirmed this — no analogous bug to fix on the reverse path.
 *
 * **Index signature.** Open extension preserves M2's
 * `Record<string, unknown>` engine contract for apply_event.ts dynamic
 * `state_changes` writes. M7b translators stick to named fields.
 */
export interface StreamState {
  // Identity (set at first event, read at terminal event).
  responseId?: string | null;
  model?: string | null;

  // Anthropic → Responses (forward).
  /**
   * Stream-wide allocator counter for Responses-side `output_index`.
   * `content_block_start` reads the current value into the new block's
   * `ContentBlockMeta.outputIndex` AND increments. `content_block_stop`
   * does NOT touch this — it reads the captured per-block value.
   */
  outputIndex?: number;
  /**
   * Per-Anthropic-content-block metadata, keyed by `content_block.index`
   * (NOT by tool call_id — Anthropic addresses tool blocks by block
   * index; multiple parallel tool_use blocks have distinct indices and
   * may interleave their `input_json_delta` events). Lifecycle: insert
   * on `content_block_start`, read+delete on `content_block_stop`.
   *
   * Replaces M7b iter-1's scalar trio (`currentBlockType`,
   * `currentToolId`, `currentToolName`) and `toolArgBuffers` map. See
   * D25 keystone finding F1 / M7b.5 spec for the bug history.
   */
  contentBlocks?: Map<number, ContentBlockMeta>;
  /**
   * **M17 — output[] accumulator for `response.completed`.**
   * Stream-wide list of fully-assembled Responses-side output items
   * (message / function_call / reasoning) accumulated during the
   * forward translation. `handleMessageStop` reads this and assigns it
   * to `response.completed.response.output` so codex CLI receives a
   * non-empty `output[]` array (the upstream invariant the CLI uses
   * to render the assistant reply on Lane 5 — `POST /responses` ×
   * `^claude-`).
   *
   * **Lifecycle.** Initialized to `[]` in `initStreamState()`. Tool_use
   * + thinking blocks PUSH at `content_block_stop`. Text blocks
   * AGGREGATE through `assistantMessageBuilder` and FLUSH a single
   * message item at `message_stop` time (see R7 / R8 — message item
   * lands LAST in `outputItems`). Cleared via the standard release at
   * `message_stop` (the whole `StreamState` is deleted from the map).
   *
   * **Why typed `ResponsesOutputItem[]` (NOT index-signature)?** Per
   * M17 R1: an explicit named field forces type-safe construction at
   * push sites; routing through the catch-all `[k:string]: unknown`
   * extension would push the executor toward `as any` casts (FORBIDDEN
   * per the M17 anti-pattern list).
   */
  outputItems?: Array<ResponsesOutputItem>;
  /**
   * **M17 — text-block aggregator for the single message item.**
   * Per Lane 2 curl evidence + the non-stream body translator pattern,
   * multiple `text` content blocks within a single `message_start..
   * message_stop` boundary aggregate into ONE Responses-side
   * `{type:"message", ...}` output item (NOT one per text block).
   * This builder captures the FIRST text block's allocated
   * `msg_${outputIndex}` id and the running concatenated text; the
   * aggregated message item is flushed into `outputItems` at
   * `message_stop` time.
   *
   * **Lifecycle.** Initialized to `null` in `initStreamState()`. The
   * FIRST `content_block_start` for a text block within a message
   * captures `{id: msg_${outputIndex}, text: ""}` (see R7 + R14).
   * Subsequent text blocks within the same message MUST NOT overwrite
   * the captured id (no-overwrite invariant) — they leave the builder
   * alone at `content_block_start`. Each text block's
   * `content_block_stop` APPENDS `meta.argBuffer` to `builder.text`.
   * `message_stop` reads + flushes a single `{type:"message", ...}`
   * item into `outputItems`, then resets the builder to `null`.
   *
   * **Why typed `{id; text} | null`?** Per M17 R1: explicit named
   * fields avoid `as any`. The discriminated null is the "no text
   * blocks seen yet" sentinel — empty stream paths (`message_start`
   * → `message_stop` with no text) leave it null and emit
   * `output: []` (R7 + AC test #7).
   */
  assistantMessageBuilder?: { id: string; text: string } | null;
  /**
   * Merged usage object — initial values from `message_start`, output
   * tokens MERGED in (not replaced) on `message_delta`. Mirrors bundle
   * line 2380 pattern. Read by `_toResponsesUsage` at `message_stop`.
   *
   * Typed as `unknown` rather than `Record<string, unknown>` to preserve
   * compatibility with existing M2 tests that wrote `finalUsage: 42` (a
   * number) into the state bag; M7b translators always treat the field
   * as a `Record<string, unknown>` and narrow at read time.
   */
  finalUsage?: unknown;
  stopReason?: string | null;

  // Responses → Anthropic (reverse).
  /** Idempotency guard — bundle emits both `response.created` and
   * `response.in_progress` at stream open; only ONE `message_start` should
   * fire. */
  messageStartSent?: boolean;
  /** True when a `content_block_start` has been emitted with no matching
   * `content_block_stop` yet. */
  contentBlockOpen?: boolean;
  /** Anthropic block index — incremented on every `content_block_stop`
   * the R→A translator emits. */
  contentBlockIndex?: number;
  /** Tracks the type of currently-open block in the R→A path.
   *
   * **M10 D-LOCK-10.** Union widened to include `"thinking"` (the third
   * value) so the reverse translator can mark thinking-block lifecycle
   * during reasoning_summary_part.added/done sequences. Reverse-direction
   * thinking handlers gate on `currentToolType === "thinking"` to detect
   * out-of-order text.delta / part.done events. */
  currentToolType?: "text" | "tool_use" | "thinking" | null;
  /** Cached call_id from the current `response.output_item.added`
   * (function_call), used to fill `tool_use.id` on the matching
   * `content_block_start`. */
  currentToolCallId?: string | null;
  /** Cached tool name from the current `response.output_item.added`
   * (function_call), used to fill `tool_use.name` on the matching
   * `content_block_start`. (Reverse-path scalar — safe per M7b.5 audit;
   * Responses serializes function_calls so no interleaving.) */
  currentToolName?: string | null;
  /**
   * Buffered assembled args for the current reverse-path function_call
   * (M7b.5 F3). `function_call_arguments.delta` events append into here
   * so `function_call_arguments.done` can detect the zero-delta case
   * (buffer === "" → fall back to `event.arguments` from the done
   * event). Cleared at `content_block_stop` time and on
   * `output_item.added(function_call)`.
   */
  toolArgsBuffer?: string;
  /** Map from upstream Responses item id → synthetic
   * `srvtoolu_*` id for the Anthropic-side `server_tool_use` block.
   * Used by the R→A translator's web_search special-case (out-of-scope
   * for M7b's MVP but the field exists for forward-compat with the
   * bundle's behavior; M7b's translator does NOT emit web_search blocks). */
  webSearchIds?: Record<string, string>;

  // Lifecycle.
  /** ms since epoch. Bumped on every `acquireStreamState` call;
   * `gcStaleStreamStates` evicts entries older than `maxAgeMs`. */
  lastTouchedAt?: number;
  /**
   * The request id the engine bound this state to. Set by
   * `acquireStreamState` to mirror the map key inside the state object,
   * so translators can call `releaseStreamState(state.requestId)` on
   * terminal events without needing the engine to thread requestId
   * through `StreamEventContext` (preserves M2's contract per the M7b
   * spec's note on `Files NOT to touch — types.ts (special case)`).
   */
  requestId?: string;

  /**
   * Open extension — preserves M2's `Record<string, unknown>` contract
   * for the engine surface (apply_event.ts uses dynamic key access on
   * `result.state_changes` per types.ts's `Partial<StreamState>` shape;
   * existing tests reference fields like `delta_count` that are not in
   * the M7b named field set). Translators stick to the named fields
   * above; the index signature is the engine-side compatibility shim.
   *
   * **M10 D-LOCK-10 — thinking-translation fields land here (NOT as
   * new explicit fields on the StreamState interface):**
   *   - `summaryIndex: number` — forward-translator allocator counter for
   *     `response.reasoning_summary_part.added` events. Lazy-init to 0;
   *     incremented on each thinking content_block_start.
   *   - `thinkingTextBuffer: string` — reverse-translator delta accumulator
   *     for `response.reasoning_summary_text.delta` events. Cleared on
   *     each `reasoning_summary_part.added/done` boundary.
   *
   * `initStreamState` seeds both fields; the open extension typing keeps
   * them off the explicit interface to avoid M9-test interface churn
   * while still allowing translators to read+write via property access.
   */
  [k: string]: unknown;
}

/**
 * Module-scope per-stream state map. Keyed by request id (a string per
 * M5's request lifecycle). NOT a WeakMap — see file-header rationale.
 *
 * Exported (read-only) for tests that want to assert lifecycle
 * correctness ("after running 100 streams to completion, the map is
 * empty"). Production code MUST use the helpers below; direct mutation
 * of this map is undefined behavior.
 */
const streamStates: Map<string, StreamState> = new Map();

/**
 * Lazy-scheduled GC interval handle. Initially null — first
 * `acquireStreamState` call schedules `setInterval(60_000)`; subsequent
 * acquires are no-ops. `shutdownSseState` clears + nulls.
 *
 * Per M7b.5 F2 fix — M7b iter-1 defined `gcStaleStreamStates` but never
 * scheduled it, leaking state for client-disconnect-mid-stream cases.
 */
let gcInterval: ReturnType<typeof setInterval> | null = null;

/**
 * GC sweep cadence (ms). 60s matches the default `gcStaleStreamStates`
 * `maxAgeMs` so a disconnected stream gets evicted within ~60-120s of
 * its last activity. Exported as a constant so tests can reference the
 * exact value if needed.
 */
export const GC_INTERVAL_MS = 60_000;

/**
 * Schedule the disconnect-GC `setInterval` if not already scheduled.
 * Idempotent — safe to call on every `acquireStreamState`. The first
 * call installs the timer; subsequent calls are O(1) no-ops.
 *
 * `unref()` is called when available so the timer does NOT block
 * Node/Bun process exit. Critical for graceful shutdown + test suites
 * (without it, the test runner would hang waiting for the interval).
 */
function ensureGcScheduled(): void {
  if (gcInterval !== null) return;
  gcInterval = setInterval(() => {
    gcStaleStreamStates(GC_INTERVAL_MS);
  }, GC_INTERVAL_MS);
  // Don't keep the process alive just for this timer.
  // `unref` is a Node/Bun method on the timer; check before calling so
  // the code stays portable to environments that don't expose it.
  const t = gcInterval as unknown as { unref?: () => void };
  if (typeof t.unref === "function") {
    t.unref();
  }
}

/**
 * Construct a fresh `StreamState`. Exported for tests + for callers
 * that want to seed a state with custom field values; production code
 * should use `acquireStreamState` instead so the map and lifecycle stay
 * in sync.
 */
export function initStreamState(): StreamState {
  return {
    responseId: null,
    model: null,
    outputIndex: 0,
    contentBlocks: new Map<number, ContentBlockMeta>(),
    // M17 — output[] accumulator for response.completed + per-message
    // text-aggregator. See StreamState TSDoc for lifecycle.
    outputItems: [],
    assistantMessageBuilder: null,
    finalUsage: {},
    stopReason: null,
    messageStartSent: false,
    contentBlockOpen: false,
    contentBlockIndex: 0,
    currentToolType: null,
    currentToolCallId: null,
    currentToolName: null,
    toolArgsBuffer: "",
    webSearchIds: {},
    lastTouchedAt: Date.now(),
    // M10 D-LOCK-10 — thinking-translation per-stream fields. Land via
    // the `[k: string]: unknown` index signature (NOT new explicit
    // fields on the StreamState interface — avoids interface churn
    // breaking M9-shipped tests).
    summaryIndex: 0,
    thinkingTextBuffer: "",
  };
}

/**
 * Get-or-create the per-stream state for `requestId`. Bumps
 * `lastTouchedAt` to `Date.now()` on every call so the GC's age check
 * reflects the most recent activity. Idempotent: same id → same
 * `StreamState` reference, so callers may assume `===` equality across
 * acquires within a single stream.
 *
 * **Lazy GC scheduling (M7b.5 F2).** First call schedules the
 * 60s disconnect-GC `setInterval`; subsequent calls are no-ops. The
 * timer is `unref()`'d so it doesn't block process exit.
 *
 * @param requestId — the request id this stream is bound to (M5's
 *   request lifecycle assigns it).
 */
export function acquireStreamState(requestId: string): StreamState {
  ensureGcScheduled();
  let state = streamStates.get(requestId);
  if (state === undefined) {
    state = initStreamState();
    state.requestId = requestId;
    streamStates.set(requestId, state);
  }
  state.lastTouchedAt = Date.now();
  return state;
}

/**
 * Explicitly release the per-stream state for `requestId`. Called by
 * each translator on its terminal event:
 *   - Anthropic→Responses translator: `message_stop`.
 *   - Responses→Anthropic translator: `response.completed`.
 *
 * No-op if the id was never acquired (defensive — terminal events on
 * an unknown stream just return).
 */
export function releaseStreamState(requestId: string): void {
  streamStates.delete(requestId);
}

/**
 * Sweep stream states whose `lastTouchedAt` is older than `maxAgeMs`
 * (default 60_000 = 60s). Intended for the socket-close path, where the
 * terminal event never arrived because the client disconnected mid-stream.
 *
 * The lazy-scheduled timer (per `ensureGcScheduled`) calls this every
 * `GC_INTERVAL_MS`; tests + ops tooling may invoke directly with a
 * custom `maxAgeMs`. Stays exported as a public helper.
 *
 * Returns the number of evictions for caller observability.
 */
export function gcStaleStreamStates(maxAgeMs: number = 60_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;
  for (const [id, state] of streamStates.entries()) {
    // `lastTouchedAt` is set by `acquireStreamState` on every acquire;
    // a state in the map without it is unreachable in production but
    // the optional field type forces the narrowing here.
    const last = state.lastTouchedAt ?? 0;
    if (last < cutoff) {
      streamStates.delete(id);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Shut down the SSE state subsystem — clears the lazy-scheduled GC
 * interval AND the per-stream state map. Idempotent.
 *
 * Use cases:
 *   - Test cleanup (`afterEach` via `_resetStreamStates` already calls
 *     this transitively).
 *   - M5's SIGTERM graceful-shutdown handler (future) — ensures the
 *     timer doesn't fire after the server has begun draining.
 *
 * Per M7b.5 F2 fix.
 */
export function shutdownSseState(): void {
  if (gcInterval !== null) {
    clearInterval(gcInterval);
    gcInterval = null;
  }
  streamStates.clear();
}

/**
 * Test-only helper — returns the current stream count without exposing
 * the map itself. Used by lifecycle tests to assert "the map is empty
 * after 100 completed streams".
 */
export function _streamStateCount(): number {
  return streamStates.size;
}

/**
 * Test-only helper — clears the map AND tears down the GC interval.
 * Production code never calls this; tests use it in `afterEach` to keep
 * the module-scope state from leaking across cases. Delegates to
 * `shutdownSseState` so the timer is also cleared (otherwise the next
 * test's `acquireStreamState` would see a stale `gcInterval !== null`
 * and skip rescheduling — but since the previous interval was never
 * cleared, it would keep firing across tests).
 */
export function _resetStreamStates(): void {
  shutdownSseState();
}

/**
 * Test-only helper — peek at the current GC interval handle. Returns
 * `null` when not scheduled. Used by F2 tests to assert
 * single-schedule-per-process behavior without exposing the module-scope
 * binding to production callers.
 */
export function _gcIntervalHandle(): ReturnType<typeof setInterval> | null {
  return gcInterval;
}
