/**
 * sse-codec.test.ts — unit tests for `src/lib/sse-codec.ts` (M10 D-LOCK-5).
 *
 * Covers all 13 cases enumerated in the spec:
 *   1. Single-chunk single-event happy path → 1 event.
 *   2. Single-chunk multi-event → N events in order.
 *   3. Cross-chunk single event (split across 3 chunks) → buffer reassembly.
 *   4. Multi-line `data:` event → joined with LF, parsed once.
 *   5. Comment line `:keepalive` → ignored.
 *   6. Malformed JSON → dropped + debug log; subsequent valid event still emits.
 *   7. Final-flush of empty state → returns [].
 *   8. Final-flush of partial event → returns [], logs "partial-event-dropped".
 *   9. Encode round-trip: encodeSseEvent(decode(...)[0]) decodes back identically.
 *   10. Encode of event with newline in `type` field → newline stripped.
 *   11. CRLF dispatch (M2 fix) — `\r\n\r\n` boundaries → identical to LF stream.
 *   12. Mixed LF/CRLF in single stream — both emit correctly.
 *   13. CRLF on chunk boundary — split CRLF reassembled correctly.
 *   14. Bare-CR (F2 fix) — `\r`-delimited event decodes identically to LF.
 *   15. Bare-CR (F2 fix) — `\r\r`-terminated event complete; lone `\r` partial.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";

import {
  chatDoneSentinel,
  decodeSseChunk,
  encodeSseEvent,
  isChatDoneSentinel,
  trailingIsTruncatedEvent,
  type SseDecoderState,
} from "../../src/lib/sse-codec.ts";
import { LEVEL_ON, debug } from "../../src/lib/debug.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ---- consola.debug capture helpers --------------------------------------

let capturedDebugMessages: string[] = [];
let originalDebugFn: typeof consola.debug;

beforeEach(() => {
  // Ensure debug.on emits to consola at LEVEL_ON.
  debug.setLevel(LEVEL_ON);
  capturedDebugMessages = [];
  originalDebugFn = consola.debug;
  consola.debug = ((msg: unknown): void => {
    capturedDebugMessages.push(typeof msg === "string" ? msg : String(msg));
  }) as typeof consola.debug;
});

afterEach(() => {
  consola.debug = originalDebugFn;
  debug.setLevel(LEVEL_ON);
});

// ---- 1. Single-chunk single-event ----------------------------------------

describe("decodeSseChunk", () => {
  it("(1) single-chunk single-event happy path emits 1 event", () => {
    const state: SseDecoderState = { buffer: "" };
    const chunk = enc(
      `event: message_start\ndata: {"type":"message_start","id":"abc"}\n\n`,
    );
    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("message_start");
    expect((events[0] as unknown as { id?: string }).id).toBe("abc");
    expect(state.buffer).toBe("");
  });

  // ---- 2. Single-chunk multi-event ---------------------------------------

  it("(2) single-chunk multi-event emits N events in order", () => {
    const state: SseDecoderState = { buffer: "" };
    const chunk = enc(
      `event: a\ndata: {"type":"a","i":0}\n\n` +
        `event: b\ndata: {"type":"b","i":1}\n\n` +
        `event: c\ndata: {"type":"c","i":2}\n\n`,
    );
    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(3);
    expect(events[0]?.type).toBe("a");
    expect(events[1]?.type).toBe("b");
    expect(events[2]?.type).toBe("c");
    expect((events[0] as unknown as { i: number }).i).toBe(0);
    expect((events[1] as unknown as { i: number }).i).toBe(1);
    expect((events[2] as unknown as { i: number }).i).toBe(2);
  });

  // ---- 3. Cross-chunk single event ---------------------------------------

  it("(3) cross-chunk single event (split across 3 chunks) reassembles + emits once", () => {
    const state: SseDecoderState = { buffer: "" };
    const full = `event: message_delta\ndata: {"type":"message_delta","delta":{"text":"hello world"}}\n\n`;
    // Split arbitrarily: chunk1="event: message_de", chunk2="lta\ndata: {\"type\":\"message_delta\"", chunk3=remainder
    const c1 = enc(full.slice(0, 17));
    const c2 = enc(full.slice(17, 50));
    const c3 = enc(full.slice(50));
    const e1 = decodeSseChunk(c1, state);
    expect(e1.length).toBe(0);
    const e2 = decodeSseChunk(c2, state);
    expect(e2.length).toBe(0);
    const e3 = decodeSseChunk(c3, state);
    expect(e3.length).toBe(1);
    expect(e3[0]?.type).toBe("message_delta");
    expect((e3[0] as unknown as { delta: { text: string } }).delta.text).toBe(
      "hello world",
    );
    expect(state.buffer).toBe("");
  });

  // ---- 4. Multi-line data: per SSE spec ----------------------------------

  it("(4) multi-line data: joined with LF before JSON.parse", () => {
    const state: SseDecoderState = { buffer: "" };
    // Each `data:` line carries one piece; SSE spec says join with LF.
    // The full payload after join is `{"type":"x","msg":"line1\nline2"}`
    // which parses to the object below (because the LF is between
    // separate JSON tokens, not inside a string).
    // Simpler: emit a JSON object split across two data: lines.
    const chunk = enc(`event: x\ndata: {"type":"x",\ndata: "msg":"hello"}\n\n`);
    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("x");
    expect((events[0] as unknown as { msg: string }).msg).toBe("hello");
  });

  // ---- 5. Comment line :keepalive ----------------------------------------

  it("(5) comment line :keepalive is ignored, no event emitted", () => {
    const state: SseDecoderState = { buffer: "" };
    const chunk = enc(`:keepalive\n\n`);
    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(0);
    // A subsequent real event still works in the same state.
    const next = decodeSseChunk(
      enc(`event: ping\ndata: {"type":"ping"}\n\n`),
      state,
    );
    expect(next.length).toBe(1);
    expect(next[0]?.type).toBe("ping");
  });

  // ---- 6. Malformed JSON dropped + debug log -----------------------------

  it("(6) malformed JSON is dropped + debug-logged; subsequent valid event still emits", () => {
    const state: SseDecoderState = { buffer: "" };
    const chunk = enc(
      `event: bad\ndata: {not valid json}\n\n` +
        `event: good\ndata: {"type":"good","ok":true}\n\n`,
    );
    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("good");
    expect((events[0] as unknown as { ok: boolean }).ok).toBe(true);
    // Debug log fired for the malformed event.
    const matched = capturedDebugMessages.some((m) =>
      m.includes("malformed JSON"),
    );
    expect(matched).toBe(true);
  });

  // ---- 7. Final-flush of empty state -------------------------------------

  it("(7) final-flush of empty state returns []", () => {
    const state: SseDecoderState = { buffer: "" };
    const events = decodeSseChunk(undefined, state);
    expect(events.length).toBe(0);
    expect(state.buffer).toBe("");
  });

  // ---- 8. Final-flush of partial event -----------------------------------

  it("(8) final-flush of partial event returns [], logs partial-event-dropped, clears buffer", () => {
    const state: SseDecoderState = { buffer: "" };
    // Feed a partial event (no terminating blank line).
    decodeSseChunk(enc(`event: partial\ndata: {"type":"partial"`), state);
    expect(state.buffer.length).toBeGreaterThan(0);
    const events = decodeSseChunk(undefined, state);
    expect(events.length).toBe(0);
    expect(state.buffer).toBe("");
    const matched = capturedDebugMessages.some(
      (m) => m === "sse-codec: partial-event-dropped",
    );
    expect(matched).toBe(true);
  });
});

// ---- 9. Encoder round-trip ----------------------------------------------

describe("encodeSseEvent", () => {
  it("(9) round-trip: encode(decode(x)[0]) decodes back to the same object", () => {
    const state1: SseDecoderState = { buffer: "" };
    const wire = enc(
      `event: response.created\ndata: {"type":"response.created","id":"resp_abc"}\n\n`,
    );
    const events = decodeSseChunk(wire, state1);
    expect(events.length).toBe(1);
    const reEncoded = encodeSseEvent(events[0]!);
    const state2: SseDecoderState = { buffer: "" };
    const reDecoded = decodeSseChunk(reEncoded, state2);
    expect(reDecoded.length).toBe(1);
    expect(reDecoded[0]?.type).toBe("response.created");
    expect((reDecoded[0] as unknown as { id: string }).id).toBe("resp_abc");
  });

  // ---- 10. Encode strips newlines from event.type ------------------------

  it("(10) encode of event with newline in type field strips newline from event: header", () => {
    const event = { type: "evil\nname", payload: 1 };
    const wire = encodeSseEvent(event);
    const text = dec(wire);
    // The event: line must be a single line (no embedded newline).
    expect(text.startsWith("event: evilname\n")).toBe(true);
    // The full wire still terminates correctly.
    expect(text.endsWith("\n\n")).toBe(true);
    // The data: payload still contains the original (escaped) newline in
    // the JSON string — JSON.stringify encodes \n as the two-char escape.
    expect(text.includes(`"type":"evil\\nname"`)).toBe(true);
  });
});

// ---- 11. CRLF dispatch (M2 fix) -----------------------------------------

describe("decodeSseChunk CRLF (M2 fix)", () => {
  it("(11) CRLF event boundaries emit identically to LF stream", () => {
    const stateLf: SseDecoderState = { buffer: "" };
    const stateCrlf: SseDecoderState = { buffer: "" };
    const lf = enc(
      `event: a\ndata: {"type":"a","i":0}\n\n` +
        `event: b\ndata: {"type":"b","i":1}\n\n`,
    );
    const crlf = enc(
      `event: a\r\ndata: {"type":"a","i":0}\r\n\r\n` +
        `event: b\r\ndata: {"type":"b","i":1}\r\n\r\n`,
    );
    const lfEvents = decodeSseChunk(lf, stateLf);
    const crlfEvents = decodeSseChunk(crlf, stateCrlf);
    expect(crlfEvents.length).toBe(lfEvents.length);
    expect(crlfEvents.length).toBe(2);
    expect(crlfEvents[0]?.type).toBe("a");
    expect(crlfEvents[1]?.type).toBe("b");
    expect((crlfEvents[0] as unknown as { i: number }).i).toBe(0);
    expect((crlfEvents[1] as unknown as { i: number }).i).toBe(1);
  });

  // ---- 12. Mixed LF/CRLF in single stream --------------------------------

  it("(12) mixed LF and CRLF boundaries in one stream both emit correctly", () => {
    const state: SseDecoderState = { buffer: "" };
    const mixed = enc(
      `event: a\ndata: {"type":"a"}\n\n` +
        `event: b\r\ndata: {"type":"b"}\r\n\r\n`,
    );
    const events = decodeSseChunk(mixed, state);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("a");
    expect(events[1]?.type).toBe("b");
  });

  // ---- 13. CRLF split across chunk boundary ------------------------------

  it("(13) CRLF split across chunk boundary reassembles correctly (F2 bare-CR semantics)", () => {
    const state: SseDecoderState = { buffer: "" };
    // Build a 2-event CRLF stream then split the boundary between events 1
    // and 2 mid-sequence, so chunk 1 ends in `\r\n\r` and the trailing `\n`
    // lands in chunk 2.
    const full =
      `event: a\r\ndata: {"type":"a"}\r\n\r\n` +
      `event: b\r\ndata: {"type":"b"}\r\n\r\n`;
    const splitAt = full.indexOf(`\r\n\r\n`) + 3; // chunk 1 ends in `\r\n\r`
    const c1 = enc(full.slice(0, splitAt));
    const c2 = enc(full.slice(splitAt));
    // F2 bare-CR semantics: `\r\n\r` is a COMPLETE boundary — a CRLF ending the
    // `data:` line, then a bare-CR blank line that dispatches the event — so
    // event a is emittable at the end of chunk 1. (Under the old LF/CRLF-only
    // regex a bare CR was not a line ending, so event a dispatched one chunk
    // later, after the `\n`.) The leftover `\n` at the head of chunk 2 is a
    // harmless stray empty line.
    const e1 = decodeSseChunk(c1, state);
    expect(e1.length).toBe(1);
    expect(e1[0]?.type).toBe("a");
    const e2 = decodeSseChunk(c2, state);
    expect(e2.length).toBe(1);
    expect(e2[0]?.type).toBe("b");
    // Robust reassembly invariant: exactly 2 events across both chunks, in
    // order, regardless of where the chunk split fell.
    expect([...e1, ...e2].map((e) => e.type)).toEqual(["a", "b"]);
    expect(state.buffer).toBe("");
  });
});

// ---- 14/15. Bare-CR line endings (F2 fix) -------------------------------

describe("decodeSseChunk bare-CR (F2 fix)", () => {
  it("(14) a bare-\\r-delimited event decodes identically to an LF event", () => {
    // SSE permits a bare `\r` as a line ending. `event: a\rdata: {...}\r\r`
    // has CR line endings between fields and a `\r\r` blank-line boundary.
    const stateLf: SseDecoderState = { buffer: "" };
    const stateCr: SseDecoderState = { buffer: "" };
    const lf = enc(`event: a\ndata: {"type":"a","i":0}\n\n`);
    const cr = enc(`event: a\rdata: {"type":"a","i":0}\r\r`);
    const lfEvents = decodeSseChunk(lf, stateLf);
    const crEvents = decodeSseChunk(cr, stateCr);
    expect(crEvents.length).toBe(lfEvents.length);
    expect(crEvents.length).toBe(1);
    expect(crEvents[0]?.type).toBe("a");
    expect((crEvents[0] as unknown as { i: number }).i).toBe(0);
    // The `\r\r` boundary was consumed — nothing stranded in the buffer.
    expect(stateCr.buffer).toBe("");
  });

  it("(15) a `\\r\\r`-terminated event is treated as complete; a lone trailing `\\r` is held as partial", () => {
    // `\r\r` = two line endings = one event boundary → the event is complete
    // and emitted, buffer cleared.
    const state: SseDecoderState = { buffer: "" };
    const events = decodeSseChunk(enc(`data: {"type":"ping"}\r\r`), state);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("ping");
    expect(state.buffer).toBe("");

    // Contrast: a SINGLE trailing `\r` (one line ending, NOT a boundary) leaves
    // the event incomplete — held in the buffer, not emitted.
    const partialState: SseDecoderState = { buffer: "" };
    const partial = decodeSseChunk(enc(`data: {"type":"x"}\r`), partialState);
    expect(partial.length).toBe(0);
    expect(partialState.buffer.length).toBeGreaterThan(0);

    // A subsequent bare-CR event still decodes cleanly in a fresh state.
    const next = decodeSseChunk(enc(`data: {"type":"pong"}\r\r`), state);
    expect(next.length).toBe(1);
    expect(next[0]?.type).toBe("pong");
  });
});

// ---------------------------------------------------------------------------
// F5 (remediation) — `trailingIsTruncatedEvent` must treat a trailing line of
// only spaces/tabs as blank (not a real field line), matching its own doc. A
// whitespace-only trailer at clean EOF (e.g. `data:{...}\n\n   `) is NOT a
// truncation; an unterminated REAL field line still IS.
// ---------------------------------------------------------------------------

describe("trailingIsTruncatedEvent — F5 whitespace-only trailer", () => {
  it("empty trailing segment → not truncated (clean close after a boundary)", () => {
    expect(trailingIsTruncatedEvent("")).toBe(false);
  });

  it("whitespace-only trailer (spaces) → NOT truncated", () => {
    // The trailing segment after the last `\n\n` boundary is "   " (3 spaces).
    expect(trailingIsTruncatedEvent("   ")).toBe(false);
  });

  it("whitespace-only trailer (tabs + spaces) → NOT truncated", () => {
    expect(trailingIsTruncatedEvent("\t \t ")).toBe(false);
  });

  it("comment-only trailer (`:keepalive`) → NOT truncated", () => {
    expect(trailingIsTruncatedEvent(":keepalive")).toBe(false);
  });

  it("unterminated real field line → truncated", () => {
    expect(trailingIsTruncatedEvent('data: {"par')).toBe(true);
  });

  it("real field line after a whitespace line → truncated", () => {
    // A whitespace line is skipped, but a subsequent real field line is still a
    // dangling (unterminated) event.
    expect(trailingIsTruncatedEvent("   \ndata: x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H4 (remediation) — the UTF-8 decoder is PER-STREAM (lives in SseDecoderState),
// not a module global. `{ stream: true }` holds partial-multibyte state across
// chunk decodes; a module-global decoder leaked that state between concurrent
// streams (a codepoint split at stream A's boundary corrupted stream B). The
// final flush now surfaces any stranded partial rather than silently dropping it.
// ---------------------------------------------------------------------------

describe("decodeSseChunk — H4 per-stream decoder", () => {
  it("(H4) a multibyte codepoint split across two chunks on ONE state decodes correctly", () => {
    const state: SseDecoderState = { buffer: "" };
    // € = E2 82 AC (3 bytes). Split so chunk1 ends after the FIRST byte of €.
    const full = enc('data: {"type":"msg","v":"€"}\n\n');
    const prefixLen = enc('data: {"type":"msg","v":"').length;
    const chunk1 = full.subarray(0, prefixLen + 1); // …"v":" + first byte of €
    const chunk2 = full.subarray(prefixLen + 1); // rest of € + `"}\n\n`
    // chunk1 ends mid-codepoint → nothing complete yet.
    expect(decodeSseChunk(chunk1, state).length).toBe(0);
    const events = decodeSseChunk(chunk2, state);
    expect(events.length).toBe(1);
    expect((events[0] as { v?: string }).v).toBe("€");
  });

  it("(H4) two independent states holding mid-codepoint partials do not cross-contaminate", () => {
    const stateA: SseDecoderState = { buffer: "" };
    const stateB: SseDecoderState = { buffer: "" };
    // A holds the first byte of € (E2 82 AC); B holds the first byte of 😀
    // (F0 9F 98 80). A module-global decoder would splice A's held byte onto B.
    const aFull = enc('data: {"s":"A€"}\n\n');
    const bFull = enc('data: {"s":"B😀"}\n\n');
    const aPrefix = enc('data: {"s":"A').length;
    const bPrefix = enc('data: {"s":"B').length;
    // Interleave the mid-codepoint chunks: A1, then B1 (both hold a partial).
    expect(decodeSseChunk(aFull.subarray(0, aPrefix + 1), stateA).length).toBe(
      0,
    );
    expect(decodeSseChunk(bFull.subarray(0, bPrefix + 1), stateB).length).toBe(
      0,
    );
    // Then the remainders, still interleaved.
    const aEvents = decodeSseChunk(aFull.subarray(aPrefix + 1), stateA);
    const bEvents = decodeSseChunk(bFull.subarray(bPrefix + 1), stateB);
    expect(aEvents.length).toBe(1);
    expect(bEvents.length).toBe(1);
    // Each state decoded ONLY its own codepoint — no cross-stream corruption.
    expect((aEvents[0] as { s?: string }).s).toBe("A€");
    expect((bEvents[0] as { s?: string }).s).toBe("B😀");
  });

  it("(H4) final flush surfaces a partial multibyte held after a clean boundary (no silent byte loss)", () => {
    const state: SseDecoderState = { buffer: "" };
    // A complete event terminated by `\n\n`, then the FIRST byte of a 3-byte €.
    // The chunk decode emits the event and leaves buffer="" (clean boundary),
    // but the decoder HOLDS the stray 0xE2. Pre-H4 the final flush returned
    // early on the empty buffer and the held byte was silently lost.
    const complete = enc('data: {"type":"a"}\n\n');
    const strayFirstByte = enc("€").subarray(0, 1); // 0xE2, held mid-codepoint
    const chunk = new Uint8Array(complete.byteLength + 1);
    chunk.set(complete, 0);
    chunk.set(strayFirstByte, complete.byteLength);

    const events = decodeSseChunk(chunk, state);
    expect(events.length).toBe(1);
    expect(state.buffer).toBe(""); // clean boundary — held byte is in the decoder

    capturedDebugMessages = [];
    const flushed = decodeSseChunk(undefined, state);
    expect(flushed.length).toBe(0);
    // H4 — the flush surfaced the stranded partial (as U+FFFD) into the buffer,
    // now reported as a dropped partial rather than silently vanishing. Pre-H4
    // the empty-buffer early-return meant NO partial-event-dropped log fired.
    expect(
      capturedDebugMessages.some((m) => m.includes("partial-event-dropped")),
    ).toBe(true);
    // F4 (iter6) — the flush ALSO sets the machine-readable signal the
    // translated forwarder folds into `pendingPartial`, so the EOF-stranded
    // final multibyte surfaces to the client as a 502 (not a silent 200).
    expect(state.droppedPartialAtFlush).toBe(true);
  });

  it("(F4) final flush sets droppedPartialAtFlush on a stranded partial, leaves it unset on a clean flush", () => {
    // Stranded buffered partial (no trailing boundary) → flag set.
    const stranded: SseDecoderState = { buffer: "" };
    expect(decodeSseChunk(enc('data: {"a":1'), stranded).length).toBe(0);
    expect(stranded.buffer).toBe('data: {"a":1'); // held, no boundary yet
    decodeSseChunk(undefined, stranded);
    expect(stranded.droppedPartialAtFlush).toBe(true);

    // Clean flush (complete event + boundary, buffer drained) → flag stays unset.
    const clean: SseDecoderState = { buffer: "" };
    expect(decodeSseChunk(enc('data: {"a":1}\n\n'), clean).length).toBe(1);
    expect(clean.buffer).toBe("");
    decodeSseChunk(undefined, clean);
    // Optional field; falsy (undefined) on a clean flush — no false positive.
    expect(clean.droppedPartialAtFlush ?? false).toBe(false);
  });

  it("(iter7 [4]) final flush does NOT flag a legal comment/whitespace EOF trailer as truncation", () => {
    // A complete event + boundary, then a standard SSE keepalive COMMENT, then
    // clean EOF. The comment is a legal clean-EOF tail, NOT a mid-event
    // truncation, so the flush must not set droppedPartialAtFlush — the forwarder
    // turns that flag into a 502, which here would be a FALSE error injected into
    // a healthy stream. Regression guard for the iter6 over-flag (which set the
    // flag on ANY non-empty last segment).
    const comment: SseDecoderState = { buffer: "" };
    expect(
      decodeSseChunk(enc('data: {"a":1}\n\n:keepalive\n'), comment).length,
    ).toBe(1);
    expect(comment.buffer).toBe(":keepalive\n"); // comment held as trailing segment
    decodeSseChunk(undefined, comment);
    expect(comment.droppedPartialAtFlush ?? false).toBe(false);

    // Whitespace-only trailer → likewise a legal clean-EOF tail, not truncation.
    const ws: SseDecoderState = { buffer: "" };
    expect(decodeSseChunk(enc('data: {"a":1}\n\n   '), ws).length).toBe(1);
    decodeSseChunk(undefined, ws);
    expect(ws.droppedPartialAtFlush ?? false).toBe(false);

    // Control — the fix is NOT a blanket suppression: a genuine unterminated
    // field line at EOF still flags as a dropped partial.
    const trunc: SseDecoderState = { buffer: "" };
    expect(
      decodeSseChunk(enc('data: {"a":1}\n\ndata: {"b":2'), trunc).length,
    ).toBe(1);
    decodeSseChunk(undefined, trunc);
    expect(trunc.droppedPartialAtFlush).toBe(true);
  });

  it("(iter7 [4] v2) a stranded multibyte appended to a comment tail is STILL flagged as truncation", () => {
    // iter7 re-gate finding: `:keepalive ` + a lone 0xE2 (start of a 3-byte
    // codepoint) at EOF. `trailingIsTruncatedEvent` skips the `:`-line, so gating
    // on it ALONE (the v1 fix) missed the stranded multibyte → silent 200. The
    // decoder-finalization signal (flushed.length > 0) is authoritative: the flag
    // MUST be set so the forwarder surfaces a 502. Reverting to the v1 gate makes
    // this expect(true) fail.
    const state: SseDecoderState = { buffer: "" };
    const complete = enc('data: {"a":1}\n\n:keepalive ');
    const strayFirstByte = enc("€").subarray(0, 1); // 0xE2, held mid-codepoint
    const chunk = new Uint8Array(complete.byteLength + 1);
    chunk.set(complete, 0);
    chunk.set(strayFirstByte, complete.byteLength);
    expect(decodeSseChunk(chunk, state).length).toBe(1); // the complete event flows
    // decoder holds the 0xE2; buffer holds the ":keepalive " comment tail.
    decodeSseChunk(undefined, state);
    expect(state.droppedPartialAtFlush).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F6 (H5-chat) — the OpenAI Chat Completions `data: [DONE]` terminator is a
// non-JSON line; it must decode to a branded sentinel (not be dropped as
// malformed JSON) and round-trip back to EXACTLY `data: [DONE]\n\n`.
// ---------------------------------------------------------------------------

describe("chat [DONE] sentinel (F6)", () => {
  it("(iter7 [5]) isChatDoneSentinel is TOTAL — hostile/revoked Proxy → false, never throws", () => {
    // The brand read must never escape as an exception for a hostile input, else
    // it would crash the translated forwarder mid-stream. A throwing get trap and
    // a revoked Proxy are the exotic inputs codex iter6 [5] flagged.
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile get trap");
        },
      },
    );
    expect(() => isChatDoneSentinel(throwingProxy)).not.toThrow();
    expect(isChatDoneSentinel(throwingProxy)).toBe(false);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => isChatDoneSentinel(proxy)).not.toThrow();
    expect(isChatDoneSentinel(proxy)).toBe(false);

    // Non-object inputs → false (no throw).
    expect(isChatDoneSentinel(null)).toBe(false);
    expect(isChatDoneSentinel(undefined)).toBe(false);
    expect(isChatDoneSentinel(Symbol("x"))).toBe(false);

    // Sanity — the real sentinel is still detected after the totality guard.
    expect(isChatDoneSentinel(chatDoneSentinel())).toBe(true);
  });
  it("decodeSseChunk('data: [DONE]\\n\\n') → a single branded sentinel event", () => {
    const state: SseDecoderState = { buffer: "" };
    const events = decodeSseChunk(enc("data: [DONE]\n\n"), state);
    expect(events.length).toBe(1);
    expect(isChatDoneSentinel(events[0])).toBe(true);
    // A NON-sentinel data object is not mistaken for the sentinel.
    const other = decodeSseChunk(enc('data: {"type":"a"}\n\n'), {
      buffer: "",
    });
    expect(isChatDoneSentinel(other[0])).toBe(false);
  });

  it("encodeSseEvent(chatDoneSentinel()) → exactly `data: [DONE]\\n\\n` bytes (no event: line, no JSON)", () => {
    const bytes = encodeSseEvent(chatDoneSentinel());
    expect(dec(bytes)).toBe("data: [DONE]\n\n");
  });

  it("round-trips: decode → encode reproduces the literal terminator", () => {
    const events = decodeSseChunk(enc("data: [DONE]\n\n"), { buffer: "" });
    expect(dec(encodeSseEvent(events[0]!))).toBe("data: [DONE]\n\n");
  });

  it("isChatDoneSentinel is total on hostile input (null / primitive / plain object)", () => {
    expect(isChatDoneSentinel(null)).toBe(false);
    expect(isChatDoneSentinel(undefined)).toBe(false);
    expect(isChatDoneSentinel("[DONE]")).toBe(false);
    expect(isChatDoneSentinel({ type: "[DONE]" })).toBe(false);
  });
});
