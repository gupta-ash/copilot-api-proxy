/**
 * sse-codec.ts — pure SSE byte ↔ event-object codec for the M10 stream
 * pipeline (per D-LOCK-5 + interface-contracts.md § 2).
 *
 * **Pure functions; caller owns state.** `decodeSseChunk` accepts a
 * `SseDecoderState` argument so the caller (`forwardStreamTranslated`)
 * controls lifecycle. No module-scope state; safe to call concurrently
 * across distinct streams (each stream owns its own `SseDecoderState`
 * object).
 *
 * **Boundary handling (M2 fix — CRLF; F2 — bare CR).** A line ending is any
 * of a bare `\r`, a bare `\n`, or a `\r\n` pair — all three are SSE-legal per
 * the WHATWG SSE grammar. An event boundary is two consecutive line endings
 * (see `EVENT_BOUNDARY_RE`): `\n\n`, `\r\n\r\n`, AND a bare-CR `\r\r` all
 * terminate an event, while a single `\r\n` is NOT a boundary (a CRLF is one
 * atomic ending). Per-line split inside an event tolerates the same three
 * endings. Some upstreams + intermediate proxies emit CR-only or CRLF; SSE
 * spec permits any of them.
 *
 * **Multi-line `data:` lines.** Joined with LF (`\n`) per the SSE spec
 * regardless of the source line ending. The joined payload is JSON.parse'd
 * once per event.
 *
 * **Malformed JSON.** Silently dropped + logged via `debug.on(LEVEL_ON)`.
 * Upstream MAY send `:keepalive` comments or other non-JSON SSE events; we
 * never throw on malformed JSON.
 *
 * **Comment lines.** Lines starting with `:` (e.g., `:keepalive`) are
 * SSE comments per spec — silently ignored.
 *
 * **Final-flush rule.** `decodeSseChunk(undefined, state)` flushes the
 * decoder. If the buffer holds a complete trailing event (terminating
 * blank line was the LAST thing in the buffer), it is emitted. Any
 * partial event still in the buffer is DROPPED + logged via
 * `debug.on(LEVEL_ON, () => "sse-codec: partial-event-dropped")`. The
 * buffer is cleared regardless. Rationale: an incomplete event is
 * malformed by definition; emitting half-formed JSON to the client would
 * break Anthropic/Responses SDKs. Upstream proxies always end streams
 * with complete events; partial-at-flush indicates upstream-side abort
 * or a bug — drop is safer than emit.
 *
 * **Encoder.** `encodeSseEvent` produces `event: {type}\ndata: {JSON}\n\n`.
 * `event.type` is stripped of newlines defensively. Throws on circular
 * references (caller's existing try/catch handles).
 */

import { LEVEL_ON, debug } from "./debug.ts";
import type { AnyEvent } from "./transform/types.ts";

/**
 * Mutable buffer state for the SSE decoder. One instance per stream.
 * Caller (`forwardStreamTranslated`) owns the object; passes by reference
 * across `decodeSseChunk` calls for the lifetime of the stream.
 */
export interface SseDecoderState {
  buffer: string;
  /**
   * Per-stream UTF-8 decoder (H4). Lazily created in `decodeSseChunk`; holds
   * partial-multibyte state across `{ stream: true }` decodes so a codepoint
   * split at a chunk boundary is reassembled on the next call. Living in the
   * per-stream state (NOT a module global) is what keeps that held state from
   * leaking between concurrently-decoding streams — a module-global decoder
   * would corrupt a codepoint split at stream A's boundary into stream B.
   * Flushed on the final `decodeSseChunk(undefined, state)` call. Optional so
   * existing `{ buffer: "" }` constructors keep compiling (the `??=` in
   * `decodeSseChunk` initializes it).
   */
  decoder?: TextDecoder;
  /**
   * H4 (F4) — set to `true` by the final flush (`decodeSseChunk(undefined,
   * state)`) IFF it dropped a NON-EMPTY trailing partial (the `last !== ""`
   * case that logs `"sse-codec: partial-event-dropped"`). The translated
   * forwarder folds this into `pendingPartial` so a final multibyte codepoint
   * the `TextDecoder` was still holding at EOF (buffer empty pre-flush, U+FFFD
   * materialized only DURING the flush) surfaces as a 502 error frame instead
   * of a silent 200. Optional + left `undefined` on a clean flush, so existing
   * `{ buffer: "" }` constructors keep compiling and a healthy stream never
   * trips a false positive.
   */
  droppedPartialAtFlush?: boolean;
}

const textEncoder = new TextEncoder();

/**
 * **H5-chat (F6)** — the OpenAI Chat Completions stream terminator is the
 * literal line `data: [DONE]`, whose payload is NOT JSON. `parseEventSegment`
 * therefore cannot represent it as a normal parsed event (JSON.parse('[DONE]')
 * throws → the line was silently dropped, so a translated chat lane neither
 * forwarded `[DONE]` on clean EOF nor recognized it as the terminal → a
 * post-`[DONE]` reset injected a FALSE error frame). We model it as a branded
 * sentinel event that round-trips through the translate pipeline:
 *   - `parseEventSegment` emits it for a `data: [DONE]` segment,
 *   - `encodeSseEvent` renders it back to EXACTLY `data: [DONE]\n\n`,
 *   - `isChatDoneSentinel` lets the forwarder recognize it as the chat terminal
 *     (so `sawTerminal` is set and a post-`[DONE]` reset stays a clean success).
 * The brand is a NON-ENUMERABLE symbol key, so it never appears in
 * `JSON.stringify` output and cannot collide with a real `data` field. Its
 * `type` is the human-readable `"[DONE]"` for logs; detection is by brand, not
 * `type`, so it is NOT mistaken for the anthropic/responses terminals.
 */
const CHAT_DONE_BRAND = Symbol("copilot-proxy.chatDoneSentinel");

/** Build a fresh chat `[DONE]` sentinel event (F6). */
export function chatDoneSentinel(): AnyEvent {
  const event: AnyEvent = { type: "[DONE]" };
  Object.defineProperty(event, CHAT_DONE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return event;
}

/** True iff `event` is the branded chat `[DONE]` sentinel (F6). Total — safe on
 *  any input (guards null / non-object before the symbol read). */
export function isChatDoneSentinel(event: unknown): boolean {
  if (event === null || typeof event !== "object") return false;
  // iter7 [5] — the brand read can throw for a hostile Proxy whose `get` / symbol
  // trap throws (or a revoked Proxy). Guard it so this predicate is TOTAL: a
  // throwing input is simply "not the sentinel", never an escaped exception that
  // would crash the translated forwarder mid-stream (parity with the totality of
  // safeErrorName / isTransformPhaseError).
  try {
    return (event as Record<PropertyKey, unknown>)[CHAT_DONE_BRAND] === true;
  } catch {
    return false;
  }
}

/**
 * Event-boundary regex — matches two consecutive line endings, where a single
 * line ending is a `\r\n` pair, a bare `\r`, or a bare `\n` (F2). So `\n\n`,
 * `\r\n\r\n`, and `\r\r` are all boundaries, while a lone `\r\n` is NOT.
 *
 * **Why two spelled-out groups instead of `{2}`, and why the `(?!\n)` guard.**
 * A CRLF must be consumed as ONE atomic ending; otherwise a single `\r\n` reads
 * as `\r`+`\n` (two endings) and every CRLF line ending looks like an event
 * boundary — shattering CRLF streams. Two engine subtleties force this exact
 * shape:
 *   - The naive `(?:\r\n|\r|\n){2}` lets `{2}` backtrack a lone CRLF into
 *     `\r`+`\n`, so a single `\r\n` wrongly matches (verified in V8 AND JSC).
 *   - The `(?!\n)` guard on the bare-`\r` alternative blocks that split, but
 *     JavaScriptCore (bun's engine) mis-evaluates the guard under a `{2}`
 *     quantifier and matches a lone `\r` as if it were two endings. Spelling
 *     the ending out as two separate groups sidesteps the JSC quirk while
 *     keeping CRLF atomic in both engines.
 * Lazy-compiled once at module-load to avoid per-call allocation.
 */
export const EVENT_BOUNDARY_RE = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/;

/**
 * Per-line split regex — tolerates bare `\r`, bare `\n`, and `\r\n` line
 * endings (F2). The `\r\n` alternative is first so a CRLF splits as one break
 * (no `{2}` quantifier here, so no atomicity guard is needed).
 */
const LINE_SPLIT_RE = /\r\n|\r|\n/;

/**
 * Truncation check for a trailing SSE segment (the bytes after the last event
 * boundary). Returns true iff the segment began a REAL event — it holds a
 * non-empty, non-comment line — meaning the upstream stream ended mid-event (a
 * field line started but was never terminated by a blank line). A segment that
 * is empty, whitespace-only, or comment-only (`:keepalive`) is NOT a truncation.
 *
 * SSE-correct by construction: callers split the stream on `EVENT_BOUNDARY_RE`
 * (two consecutive line endings, where a bare `\r`, a bare `\n`, or a `\r\n`
 * pair each count as ONE ending, so `\n\n`, `\r\n\r\n`, and `\r\r` are all
 * boundaries while a SINGLE `\r\n` is NOT), so a clean close leaves an empty
 * trailing segment → false, while a mid-event close leaves the partial field
 * line → true. Both stream forwarders use this to distinguish a clean upstream
 * EOF from a truncated one.
 */
/**
 * True for an empty line OR a line consisting solely of spaces (0x20) and/or
 * tabs (0x09). Such a trailing line at clean EOF is whitespace padding, not a
 * real SSE field, so it must not be classified as a mid-event truncation (F5).
 */
function isBlankOrWhitespaceLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 0x20 && ch !== 0x09) return false;
  }
  return true;
}

export function trailingIsTruncatedEvent(trailing: string): boolean {
  for (const line of trailing.split(LINE_SPLIT_RE)) {
    // F5 — a blank OR whitespace-only line (spaces/tabs) is NOT a real field
    // line; a whitespace-only trailer at clean EOF (e.g. `data:{...}\n\n   `)
    // must not be classified as truncated (matches this function's own doc).
    if (isBlankOrWhitespaceLine(line)) continue;
    if (line.startsWith(":")) continue; // SSE comment
    return true; // a real field line began but was not terminated
  }
  return false;
}

/**
 * Decode a chunk of SSE bytes (or `undefined` for final flush) into 0..N
 * parsed event objects. Buffers cross-chunk-boundary events in `state.buffer`.
 *
 * @param chunk — `Uint8Array` of UTF-8 SSE bytes from upstream, OR
 *   `undefined` to signal final flush (upstream closed; emit any complete
 *   trailing event; drop any partial — see § Final-flush rule).
 * @param state — Mutable decoder state; caller creates one per stream.
 *
 * @returns Array of parsed JSON event objects in arrival order.
 */
export function decodeSseChunk(
  chunk: Uint8Array | undefined,
  state: SseDecoderState,
): AnyEvent[] {
  // H4 — per-stream decoder, lazily created. Holds partial-multibyte state
  // across `{ stream: true }` chunk decodes WITHOUT the cross-stream leak of
  // the former module-global decoder. `??=` keeps existing `{ buffer: "" }`
  // constructors (src + tests) working — the field is optional.
  state.decoder ??= new TextDecoder("utf-8");
  // Final-flush path. The boundary regex requires a terminating blank line;
  // if the buffer ends in one, the split below would emit an empty trailing
  // segment that we want to ignore. If the buffer is non-empty AND has no
  // terminator, we DROP the partial per D-LOCK-5.
  if (chunk === undefined) {
    const out: AnyEvent[] = [];
    // H4 — flush any partial multibyte sequence the decoder is still holding
    // from the last `{ stream: true }` decode, so a codepoint split across the
    // FINAL chunk boundary surfaces here instead of being silently dropped.
    // `decode()` (no arg) ends the stream and returns any stranded bytes as
    // U+FFFD replacement char(s).
    const flushed = state.decoder.decode();
    // A non-empty no-arg `decode()` means the decoder was holding a partial
    // multibyte at EOF and just materialized it as U+FFFD. That is a GENUINE
    // truncation REGARDLESS of what buffered text it lands after — tracked
    // separately because `trailingIsTruncatedEvent` skips comment/whitespace lines
    // and would otherwise MASK a stranded multibyte appended to a `:keepalive`
    // comment tail (iter7 re-gate [4] false-negative).
    const strandedMultibyte = flushed.length > 0;
    if (flushed) state.buffer += flushed;
    if (state.buffer.length === 0) {
      return out;
    }
    // The buffer may legitimately hold a trailing complete event when the
    // last bytes received were `event: ...\ndata: {...}\n\n` followed by
    // nothing — in which case a final blank line makes the split emit
    // ["...event...", ""]. Equally, the buffer might hold a partial event
    // (no terminating blank line yet). Distinguish by re-running the split.
    const segments = state.buffer.split(EVENT_BOUNDARY_RE);
    // The LAST segment is always either:
    //   - "" if the buffer ends with `\n\n` (last event was complete)
    //   - a partial event otherwise (DROP it)
    const last = segments[segments.length - 1];
    const completeSegments =
      last === "" ? segments.slice(0, -1) : segments.slice(0, -1);
    for (const segment of completeSegments) {
      const event = parseEventSegment(segment);
      if (event !== null) out.push(event);
    }
    // H4 (F4) — signal the caller that a genuinely TRUNCATED partial was dropped
    // at the final flush so the forwarder ORs it into `pendingPartial` and
    // surfaces a 502 rather than a silent 200. TWO independent truncation
    // signals, EITHER of which flags:
    //   1. `strandedMultibyte` — the decoder finalization materialized held bytes
    //      (an EOF-stranded codepoint). ALWAYS a truncation, even when it lands on
    //      a comment/whitespace tail.
    //   2. `trailingIsTruncatedEvent(last)` — the trailing buffered segment is a
    //      real unterminated field line (comment-only / whitespace-only / empty
    //      tails are excluded — those are legal clean-EOF padding, not truncation).
    //
    // iter7 [4] (v2) — the first cut gated ONLY on (2), which fixed the healthy-
    // keepalive false-POSITIVE but introduced a false-NEGATIVE: a stranded
    // multibyte appended to a `:keepalive` tail (`":keepalive�"`) is skipped
    // by `trailingIsTruncatedEvent` (a `:`-line) and silently lost. Signal (1)
    // closes that: the decoder-finalization evidence is authoritative regardless
    // of the trailing text.
    if (
      last !== undefined &&
      last !== "" &&
      (strandedMultibyte || trailingIsTruncatedEvent(last))
    ) {
      debug.on(LEVEL_ON, () => "sse-codec: partial-event-dropped");
      state.droppedPartialAtFlush = true;
    }
    state.buffer = "";
    return out;
  }

  // Append decoded chunk text to the buffer via the PER-STREAM decoder with
  // `{ stream: true }` (H4). Streaming-decode holds back a trailing partial
  // multibyte sequence so a codepoint split across a chunk boundary is
  // reassembled on the next call; because the decoder lives in `state` (not a
  // module global), that held state can never bleed into another stream
  // decoding concurrently. The held partial is flushed on the final
  // `decodeSseChunk(undefined, state)` call.
  state.buffer += state.decoder.decode(chunk, { stream: true });

  // Split into segments on `EVENT_BOUNDARY_RE` (two consecutive line endings).
  // The LAST segment is the partial event (incomplete; no terminating blank
  // line yet) — keep it in the buffer for the next call. Everything before it
  // is complete.
  const segments = state.buffer.split(EVENT_BOUNDARY_RE);
  state.buffer = segments[segments.length - 1] ?? "";
  const completeSegments = segments.slice(0, -1);

  const out: AnyEvent[] = [];
  for (const segment of completeSegments) {
    const event = parseEventSegment(segment);
    if (event !== null) out.push(event);
  }
  return out;
}

/**
 * Parse a single complete SSE event segment (no trailing blank line) into
 * an event object. Returns `null` when the segment yields no event (all
 * comments, no `data:` lines, malformed JSON).
 *
 * Per SSE spec:
 *   - `event: NAME` — informational (we capture into `event.type` if the
 *     parsed JSON didn't already supply one, else ignore).
 *   - `data: VALUE` — payload; multi-line `data:` joined with LF.
 *   - `id: ...` — ignored (not relevant to upstream-to-client SSE forwarding).
 *   - `retry: ...` — ignored (we don't honor upstream reconnect hints).
 *   - `:` (comment) — ignored.
 */
function parseEventSegment(segment: string): AnyEvent | null {
  if (segment.length === 0) return null;
  const lines = segment.split(LINE_SPLIT_RE);
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment
    // SSE field syntax is `field: value` with optional space after colon;
    // we tolerate either.
    if (line.startsWith("event:")) {
      eventName = line.slice(6).replace(/^ /, "");
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
    // `id:` and `retry:` (and any unknown field) are silently ignored.
  }
  if (dataLines.length === 0) return null;

  // Join multi-line data with LF per SSE spec.
  const json = dataLines.join("\n");
  // H5-chat (F6) — the OpenAI Chat Completions terminator is the literal,
  // non-JSON line `data: [DONE]`. Represent it as the branded sentinel so it
  // round-trips through the translated pipeline (forwarded to the client,
  // recognized as the chat terminal) instead of being dropped as malformed
  // JSON. The anthropic/responses upstreams never emit `[DONE]`, so the live
  // Lane 4/5 translated paths are unaffected.
  if (json === "[DONE]") {
    return chatDoneSentinel();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    debug.on(
      LEVEL_ON,
      () =>
        `sse-codec: malformed JSON in data: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    debug.on(
      LEVEL_ON,
      () => `sse-codec: data payload is not an object: ${json}`,
    );
    return null;
  }
  const event = parsed as AnyEvent;
  // If the JSON payload didn't supply a `type` field but the SSE event
  // header did, fill it in. Most Anthropic / Responses streams supply
  // `type` inside the JSON itself.
  if (eventName !== null && typeof event.type !== "string") {
    event.type = eventName;
  }
  return event;
}

/**
 * Encode a parsed SSE event object back to wire bytes.
 *
 * Output format: `event: {type}\ndata: {JSON}\n\n`. The `event.type`
 * is emitted as the `event:` header line; if the `type` field is missing
 * the header line is omitted (caller's invariant — translators always
 * carry `type`).
 *
 * **Defensive newline strip.** Newlines inside `event.type` would break
 * SSE framing (split a single event into N partial events on the wire);
 * we strip them.
 *
 * **Throws on circular references.** `JSON.stringify` throws on cycles;
 * the caller (`forwardStreamTranslated`) catches via its try/catch.
 */
export function encodeSseEvent(event: AnyEvent): Uint8Array {
  // H5-chat (F6) — the chat `[DONE]` sentinel round-trips back to EXACTLY the
  // literal terminator line (no `event:` header, no JSON `data:` object). Kept
  // first so the branded sentinel is never JSON.stringify'd (its `type` of
  // `"[DONE]"` would otherwise emit `event: [DONE]\ndata: {"type":"[DONE]"}`).
  if (isChatDoneSentinel(event)) {
    return textEncoder.encode("data: [DONE]\n\n");
  }
  const json = JSON.stringify(event);
  const parts: string[] = [];
  if (typeof event.type === "string" && event.type.length > 0) {
    // Strip newlines defensively to preserve SSE framing.
    const safeType = event.type.replace(/[\r\n]/g, "");
    parts.push(`event: ${safeType}`);
  }
  parts.push(`data: ${json}`);
  // Terminating `\n\n` per SSE spec.
  const wire = parts.join("\n") + "\n\n";
  return textEncoder.encode(wire);
}
