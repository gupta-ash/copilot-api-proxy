/**
 * stall-detect.ts — protocol-agnostic foundation for the content-phase stall
 * detector (feature W2). Pure timing + logging primitives only.
 *
 * The forwarder (a later task) watches two windows during an upstream stream:
 *   - "no_response" (Case-1): no first content byte within `noResponseWaitMs`.
 *   - "response"    (Case-2): a gap between content chunks exceeds `responseWaitMs`.
 *
 * NO protocol / content-start / thinking predicates live here — those are
 * authored in the next task. This module intentionally knows nothing about
 * SSE shapes; the caller supplies a `protocol` label and decides what a
 * "content chunk" is.
 *
 * `appendStallLog` mirrors lib/crash.ts's TOTAL-SAFE discipline: ensure the
 * parent dir, append synchronously, and NEVER throw — it runs inside a stream
 * read callback where a throw would tear down the live proxy stream.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import consola from "consola";

import { PATHS, expandTilde } from "~/lib/paths.ts";

// ---------------------------------------------------------------------------
// Stall timer — a FRESH promise is minted per `arm()` (hard correctness
// requirement). A stable/reused promise causes a false stall if it resolves
// during a slow `stream.write` between reads; cancelling the timer must orphan
// the old promise (never resolve it) rather than re-use it.
// ---------------------------------------------------------------------------

export interface StallTimer {
  /** Arm a fresh timer; the returned promise resolves after `ms`. A NEW promise is minted each call. */
  arm(ms: number): Promise<void>;
  /** Cancel the currently-armed timer (idempotent). */
  cancel(): void;
}

export function makeStallTimer(): StallTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    arm(ms: number): Promise<void> {
      if (handle !== undefined) clearTimeout(handle);
      return new Promise<void>((resolve) => {
        handle = setTimeout(resolve, ms);
        (handle as unknown as { unref?: () => void })?.unref?.();
      });
    },
    cancel(): void {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Records + config shapes
// ---------------------------------------------------------------------------

export interface StallRecord {
  ts: string; // ISO-8601 (new Date().toISOString())
  phase: "no_response" | "response"; // which window elapsed
  waitedMs: number; // the period that elapsed
  protocol: string; // caller-supplied metric-route protocol label
  model?: string;
  requestId?: string;
  route?: string;
}

export interface StallConfig {
  noResponseWaitMs: number; // Case-1 (pre-content) window
  responseWaitMs: number; // Case-2 (post-content) window
  makeTimer(): StallTimer;
  log(record: StallRecord): void;
}

/** Fill `ts` with the current ISO-8601 instant; pass the rest through verbatim. */
export function buildStallRecord(args: {
  phase: "no_response" | "response";
  waitedMs: number;
  protocol: string;
  model?: string;
  requestId?: string;
  route?: string;
}): StallRecord {
  return { ts: new Date().toISOString(), ...args };
}

// ---------------------------------------------------------------------------
// Total-safe JSONL logger (mirrors lib/crash.ts's safe helpers verbatim; those
// helpers are module-private in crash.ts, so they are re-stated here rather
// than exported from a do-not-modify file).
// ---------------------------------------------------------------------------

const UNSERIALIZABLE_LINE = '{"stall":"[unserializable record]"}';

/**
 * Coerce to string WITHOUT ever throwing. `String(x)` can throw for a
 * null-prototype object, a throwing `toString`, or a throwing `Symbol.toPrimitive`.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * `JSON.stringify` WITHOUT throwing (circular / bigint). Returns undefined for
 * values it cannot represent (function / symbol / undefined) OR when it throws.
 */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Coerce a (possibly non-string) value to a plain, serializable string. */
function normalizeToString(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJson(value) ?? safeString(value);
}

/**
 * Serialize a record to ONE JSONL line, guarding a field that breaks
 * `JSON.stringify` (a circular ref or bigint attached to the record). If the
 * record serializes directly we use that; otherwise we rebuild from the known
 * scalar fields so a line is still emitted; a constant is the last resort.
 */
function serializeRecord(record: StallRecord): string {
  const direct = safeJson(record);
  if (direct !== undefined) return direct;

  const safe: Record<string, unknown> = {
    ts: normalizeToString(record.ts),
    phase: normalizeToString(record.phase),
    waitedMs: record.waitedMs,
    protocol: normalizeToString(record.protocol),
  };
  if (record.model !== undefined) safe.model = normalizeToString(record.model);
  if (record.requestId !== undefined) {
    safe.requestId = normalizeToString(record.requestId);
  }
  if (record.route !== undefined) safe.route = normalizeToString(record.route);

  return safeJson(safe) ?? UNSERIALIZABLE_LINE;
}

/**
 * Total-safe append-only JSONL logger. Ensures the parent dir, appends a single
 * line synchronously, and NEVER throws — it runs inside a stream read callback,
 * so a throw here would tear down the live proxy stream.
 */
export function appendStallLog(record: StallRecord, logPath: string): void {
  try {
    const line = serializeRecord(record);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, line + "\n", "utf8");
  } catch (err) {
    // Best-effort diagnostic; the append is non-critical and must not throw.
    try {
      consola.warn(`appendStallLog failed (swallowed): ${safeString(err)}`);
    } catch {
      /* even the warn must never throw */
    }
  }
}

/**
 * Build a `StallConfig` from the parsed `logging.stall_detection` config
 * sub-object. Read defensively — Zod's outer `.default(() => ({...}))` literal
 * does not re-run the inner object's defaults, so on a minimal `parse({})` the
 * nested object can be absent; the `?.` / `??` fallbacks cover that. Returns
 * `undefined` when the feature is explicitly disabled, so both forwarders keep
 * the legacy no-timer read loop (additivity). The diagnostics log defaults to
 * `PATHS.STALL_LOG_PATH` (sibling of the crash marker).
 */
export function makeStallConfig(
  cfg:
    | {
        enabled?: boolean;
        no_response_wait_ms?: number;
        response_wait_ms?: number;
        log_path?: string;
      }
    | undefined,
): StallConfig | undefined {
  if (cfg?.enabled === false) return undefined;
  const logPath = expandTilde(cfg?.log_path ?? PATHS.STALL_LOG_PATH);
  return {
    noResponseWaitMs: cfg?.no_response_wait_ms ?? 1_140_000,
    responseWaitMs: cfg?.response_wait_ms ?? 600_000,
    makeTimer: makeStallTimer,
    log: (record: StallRecord): void => {
      appendStallLog(record, logPath);
    },
  };
}

// ---------------------------------------------------------------------------
// F165 / D96 Amendment 1 — the proxy-emitted SSE keep-alive.
//
// It reuses {@link StallTimer} deliberately. `arm()`'s clearTimeout-then-mint-
// fresh is WRONG for a deadline and exactly right for an INTERVAL, and reusing
// the shape gives tests one fake to build instead of two.
// ---------------------------------------------------------------------------

/**
 * One stream's keep-alive settings, already validated and defaulted.
 *
 * ⚠ **`makeTimer()` must be called for a SEPARATE `StallTimer` INSTANCE from the
 * stall detector's.** `makeStallTimer` closes over ONE handle and `arm()` begins
 * by clearing it, so a shared instance makes the first keep-alive arm CANCEL the
 * stall deadline — the unbounded liveness lie D96 forbids, produced by a
 * plausible "reuse the timer we already have" tidy-up.
 */
export interface KeepAliveConfig {
  /** Gap between comments. RE-ARMED every round — see `raceReadWithKeepAlive`. */
  intervalMs: number;
  /**
   * Withhold the comment until the upstream has produced a byte.
   *
   * ⚠ **CURRENTLY REDUNDANT BY STRUCTURE, and it is NOT the protection.** Both
   * forwarders independently refuse to emit before the first upstream byte — the
   * verbatim lane because its boundary predicate requires `bomIndex === 3`, the
   * translated lane because its boundary flag initialises `false` — so setting
   * this to `false` does NOT enable pre-first-byte comments. The field is kept
   * because that safety is produced today by two UNRELATED accidents in another
   * file, and a property held by coincidence is the property that vanishes
   * silently; keeping the knob keeps the vocabulary in which to assert it.
   */
  requireFirstByte: boolean;
  /**
   * Budget for how long ONE read may go on emitting.
   *
   * ⚠ Checked when the NEXT interval is armed, so emission stops within one
   * `intervalMs` of it rather than exactly at it — and the client's own watchdog
   * still applies on top. It is a budget, not a hard cap. At the budget the loop
   * degenerates to the exact 2-way race the detector shipped with: no new
   * termination path, and the stall detector stays the authority on a genuinely
   * dead stream (D96).
   */
  maxTotalMs: number;
  makeTimer(): StallTimer;
}

/**
 * One-shot latches for the two operator warns below. Both fire from a factory
 * called PER REQUEST inside the streaming branch of all three handlers, so an
 * unlatched `consola.warn` here is a log flood at one line per stream.
 */
let warnedKeepAliveWithoutDetector = false;
let warnedKeepAliveInert = false;

/**
 * TEST-ONLY: reset both one-shot warn latches. Production code MUST never call
 * this — the latches are intentionally process-wide.
 */
export function _resetKeepAliveWarnForTests(): void {
  warnedKeepAliveWithoutDetector = false;
  warnedKeepAliveInert = false;
}

/**
 * Build a `KeepAliveConfig` from the parsed `logging.keep_alive` sub-object.
 *
 * ⚠ **Reads `cfg?.enabled !== true`, NOT `=== false`, and that stays.** As of
 * **D118** all three logging sub-sections default ON, so the inverted-polarity
 * hazard this docblock was written about is gone — but `!== true` additionally
 * refuses a runtime-`undefined` sub-object, which is the F66 shape, where
 * `=== false` would build a config out of nothing. Strictly safer than the
 * sibling idiom now rather than merely different from it; do not relax it.
 *
 * A missing or disabled sub-object returns `undefined`; the caller must supply
 * an enabled keep-alive configuration rather than synthesizing one here.
 *
 * **It REFUSES when stall detection is off**, because a keep-alive with no
 * detector behind it is exactly the unbounded liveness lie D96 forbids. Taking
 * `stall` as a parameter is what makes that refusal structural rather than a
 * convention the three call sites have to remember.
 *
 * Reads DEFENSIVELY (`??`) for the same F66 reason `makeStallConfig` does: zod's
 * outer `.default(() => ({...}))` literal does not re-run the inner object's
 * defaults, so the nested object can be absent at runtime.
 */
export function makeKeepAliveConfig(
  cfg:
    | {
        enabled?: boolean;
        interval_ms?: number;
        require_first_byte?: boolean;
        max_total_ms?: number;
      }
    | undefined,
  stall: StallConfig | undefined,
): KeepAliveConfig | undefined {
  if (cfg?.enabled !== true) return undefined;
  if (stall === undefined) {
    if (!warnedKeepAliveWithoutDetector) {
      warnedKeepAliveWithoutDetector = true;
      consola.warn(
        "logging.keep_alive.enabled is true but logging.stall_detection.enabled is false — REFUSING to emit keep-alives. A keep-alive with no stall detector behind it suppresses the client's own watchdog while nothing bounds a dead stream (D96). Enable stall detection or disable the keep-alive.",
      );
    }
    return undefined;
  }
  const intervalMs = cfg.interval_ms ?? 30_000;
  // The tighter of the two windows is the one an interval has to fit inside; at
  // or above it the stall fires before the first tick and the feature is INERT.
  // A warn rather than a schema `superRefine`: the misconfiguration is inert,
  // not harmful, and cross-field validation on the logging object is new
  // machinery for it. BOTH numbers are printed because on a quiet box "inert"
  // and "working" are otherwise indistinguishable (F163).
  //
  // ⚠ COMPUTE the minimum; do NOT hardcode `responseWaitMs` as the tighter one.
  // Under the SHIPPED defaults it is (600 000 vs 1 140 000), so a check against
  // it alone is correct today and WRONG on any retuned config where
  // `no_response_wait_ms` drops below `interval_ms` — there the no-response stall
  // closes before the first tick while the warn stays silent, which is the exact
  // "inert and working look identical" case this warn exists to prevent. Found by
  // the D118 cross-family gate against the comment above, which promised the
  // minimum while the code checked one window.
  const tighterMs = Math.min(stall.responseWaitMs, stall.noResponseWaitMs);
  if (intervalMs >= tighterMs && !warnedKeepAliveInert) {
    warnedKeepAliveInert = true;
    consola.warn(
      `logging.keep_alive.interval_ms (${intervalMs}) is >= the tighter stall window (${tighterMs}; response_wait_ms=${stall.responseWaitMs}, no_response_wait_ms=${stall.noResponseWaitMs}) — that window closes before the first keep-alive tick, so the feature is INERT. Lower interval_ms below the tighter stall window.`,
    );
  }
  return {
    intervalMs,
    requireFirstByte: cfg.require_first_byte ?? true,
    maxTotalMs: cfg.max_total_ms ?? 300_000,
    makeTimer: makeStallTimer,
  };
}

// ---------------------------------------------------------------------------
// Read-vs-timer race — localizes the race + returns a discriminated result.
// The caller retains a reference to `readP` so it can swallow the orphaned
// read on a stall (the read is still in flight when the timer wins).
// ---------------------------------------------------------------------------
export type RaceReadResult<T> =
  | { kind: "read"; result: T }
  | { kind: "stall" }
  | { kind: "keepalive" };

/**
 * M1 (D100) — the PURE race. **It arms nothing; the caller owns arming**, and
 * that inversion is the whole point of the function existing.
 *
 * The caller arms the stall window ONCE per read and hands the SAME settled
 * `stallP` back in on every keep-alive re-entry, so the window stays an ABSOLUTE
 * deadline across N keep-alive fires **by construction**. The shape this replaces
 * — a race that arms its own timer, re-entered once per keep-alive tick — would
 * silently re-arm and extend that deadline without bound, which is exactly the
 * unbounded liveness lie D96 forbids. Keeping `arm()` OUT of here makes that
 * mistake unavailable rather than merely discouraged.
 *
 * `keepAliveP` is optional: omit it and this is the classic 2-way race, with the
 * `keepalive` arm unselectable.
 *
 * ⚠ **`keepAliveP` MUST BE RE-ARMED FRESH EVERY ROUND — the exact INVERSE of
 * `stallP`, and mirroring `stallP`'s hoist-and-reuse here is a LIVELOCK.** The
 * paragraph above tells the caller to arm the stall window once and reuse it; a
 * reader who applies that symmetrically to the keep-alive gets a promise that is
 * already settled on re-entry, so `Promise.race` resolves `keepalive` immediately,
 * forever, in a **pure-microtask loop**. That starves the macrotask queue, which is
 * where `setTimeout` lives — so the stall timer can never fire and the stall
 * detector is silently disabled by the very feature that is supposed to sit inside
 * it. The two promises are asymmetric on purpose: `stallP` is a DEADLINE (arm once,
 * reuse), `keepAliveP` is an INTERVAL (re-arm each round).
 *
 * **Arm precedence on simultaneous settlement is a CONTRACT, not an accident of
 * `arms.push` order.** `read` is attached first, then `stall`, then `keepalive`, and
 * `Promise.race` settles on the earliest-attached already-resolved arm. So:
 * `read` > `stall` > `keepalive`. Both orderings are load-bearing — a delivered read
 * must not be discarded in favour of a deadline that expired in the same turn, and a
 * ready keep-alive must NEVER mask an elapsed deadline (D96: a keep-alive may not
 * manufacture liveness). Do not reorder `arms`; the ordering is pinned by test.
 *
 * On `read` the ORIGINAL read result is returned verbatim (`result`) so the caller
 * keeps its discriminated `{ value, done }` narrowing. On `stall` — and on
 * `keepalive`, if the caller ever abandons the read — the caller still holds
 * `readP` and must swallow it (`void readP.catch(() => {})`): the read is orphaned
 * but still in flight when another arm wins.
 *
 * **Cost model the caller inherits:** each re-entry attaches a NEW reaction to the
 * SAME `readP` and `stallP`, and nothing detaches them. One round per read (today's
 * state) is identical to the pre-M1 cost; a keep-alive firing N times per read
 * accumulates N reactions on both promises for the life of that read.
 */
export function raceReadWithKeepAlive<T>(
  readP: Promise<T>,
  stallP: Promise<void>,
  keepAliveP?: Promise<void>,
): Promise<RaceReadResult<T>> {
  const arms: Promise<RaceReadResult<T>>[] = [
    readP.then((result): RaceReadResult<T> => ({ kind: "read", result })),
    stallP.then((): RaceReadResult<T> => ({ kind: "stall" })),
  ];
  if (keepAliveP !== undefined) {
    arms.push(
      keepAliveP.then((): RaceReadResult<T> => ({ kind: "keepalive" })),
    );
  }
  return Promise.race(arms);
}

/**
 * Arm the stall timer and race one in-flight read against it. A one-line
 * delegation to `raceReadWithKeepAlive`, so exactly ONE `Promise.race` exists in
 * this repo and this docblock cannot drift from an implementation of its own.
 *
 * ⚠ **It has NO caller in `src/` and is retained deliberately — do not read its
 * green unit tests as sanctioning it for the forwarder.** It is the one function
 * left that arms INSIDE itself, which is precisely the shape M1 removed from the
 * read loop: re-entered once per keep-alive tick it re-arms and slides the deadline
 * without bound (D96's unbounded liveness lie). Use it only where a single read is
 * raced against a single window with no keep-alive. Anything in a loop wants
 * `raceReadWithKeepAlive` with a caller-owned `stallP`.
 */
export function raceRead<T>(
  readP: Promise<T>,
  timer: StallTimer,
  ms: number,
): Promise<RaceReadResult<T>> {
  return raceReadWithKeepAlive(readP, timer.arm(ms));
}

// ---------------------------------------------------------------------------
// Smart-peek — track when the upstream response actually STARTS producing
// content (the Case-1 → Case-2 transition) and, for Anthropic, whether the
// stream is currently inside a `thinking` block (during which the tight Case-2
// window is suspended so a byte-silent redacted-think cannot trip a false
// stall). Keyed on the CLIENT protocol label; both forwarders feed their
// OUTBOUND view (verbatim = raw client-shaped bytes, translated = the
// post-translation event objects), so one vocabulary suffices.
//
// Detection is intentionally conservative: UNDER-detecting `contentStarted`
// only keeps the generous Case-1 window armed longer (never a false stall), so
// any protocol/shape we cannot classify safely stays in the generous window.
// ---------------------------------------------------------------------------

/**
 * Max chars of each SSE line captured for the verbatim smart-peek. Long enough
 * to reach the Anthropic `content_block_start` block type (~byte 66) and a Chat
 * `"content"` field; bounded so the scan stays O(1) space.
 *
 * ⚠ **"Long enough" holds for Anthropic and is DOUBTFUL for the verbatim
 * `openai_chat` lane — measured, and the constant is deliberately NOT raised.**
 * On a canonical `chat.completion.chunk` carrying `system_fingerprint`, the
 * `"content"` substring ends at bytes **199–216** across the 13 real catalog
 * `gpt-4*` model ids (213–230 with a long fingerprint), so **11 of 13 fall past
 * this cap outright**; the two that fit (`gpt-4` at 199, `gpt-4o` at 200) stop
 * fitting under a longer fingerprint. `[inferred]` from the OpenAI-canonical
 * chunk shape — **no captured chat chunk exists anywhere in this repo**, only
 * the `ChatStreamChunk` interface, so a `:4144` capture is still the decisive
 * test.
 *
 * Raising the cap would change detector behaviour on EVERY lane, which is why
 * the bias is recorded rather than "fixed". Under-detection is documented as
 * safe for the DETECTOR (it only keeps the generous window armed longer, never a
 * false stall) — but it is NOT safe for the phase metrics, where it silently
 * biases `route="chat_completions"` streams toward
 * `stream_no_content_total{reason="never_started"}` and their waits toward
 * `detector_max_wait_seconds{phase="no_response"}`. That is a data-dependent
 * bias no label value can express.
 */
export const STALL_PEEK_CAP = 200;

// ---------------------------------------------------------------------------
// D99(c) — the upstream `message_start` JOIN KEY.
//
// The id Claude Code prints in its own transcript is the one the upstream put
// in `message_start`, so capturing it here hard-joins an incident line to a
// client-side session. Both lanes route through the ONE guard below; a second
// copy of the shape test is what would let the two lanes disagree about what
// counts as an id.
// ---------------------------------------------------------------------------

/**
 * Shape guard for the upstream Anthropic `message_start` id.
 *
 * Deliberately allow underscores as well as alphanumeric characters: upstream
 * backends can issue both `msg_ABCDEFGHIJKLMNOPQRST` and
 * `msg_vrtx_ABCDEFGHIJKLMNOPQRST` shapes. These are synthetic examples.
 * Restricting the tail to alphanumeric characters would reject the second
 * shape. Short locally minted identifiers can fail this guard, but that is
 * not a substitute for reading the actual upstream event.
 *
 * ⚠ **That rejection is INCIDENTAL, not the defence.** `msg_${Date.now()}` has
 * 13 tail characters today and fails `{16,}`; `Date.now()` reaches 14 digits
 * around 2286. The durable defence against recording a locally-minted id is
 * reading the UPSTREAM event — see {@link peekUpstreamEvent} — never this regex.
 */
export const UPSTREAM_MSG_ID_RE = /^msg_[A-Za-z0-9_]{16,}$/;

/**
 * Outcome of the join-key capture for one stream.
 *
 * `"rejected"` and `"absent"` are NOT interchangeable and collapsing them into a
 * boolean is the defect this type exists to prevent: both leave
 * {@link PeekState.upstreamMessageId} undefined, but only `"rejected"` says a
 * `message_start` WAS seen and its id failed the guard. Without that split a
 * 100 % rejection rate after the next backend era change is invisible.
 */
export type UpstreamIdStatus = "absent" | "captured" | "rejected";

/**
 * Apply {@link UPSTREAM_MSG_ID_RE} and record the outcome. **The single guard
 * both lanes call** — the verbatim lane from {@link peekVerbatimLine}, the
 * translated lane from {@link peekUpstreamEvent} — for the same reason exactly
 * one `Promise.race` exists in this file: a guard that exists twice is a guard
 * whose two copies can drift.
 *
 * A non-match sets `"rejected"`, never leaves `"absent"`. At `STALL_PEEK_CAP` a
 * truncated line is indistinguishable from one carrying no id at all, and
 * filing that as `"absent"` would report "no `message_start` was seen" about a
 * stream whose `message_start` was right there — the silent miss F166 was
 * written about.
 *
 * Callers own the "first one wins" gate (`upstreamIdStatus === "absent"`); this
 * function is unconditional so a caller cannot half-apply it.
 */
export function captureUpstreamMessageId(
  rawId: unknown,
  peek: PeekState,
): void {
  if (typeof rawId === "string" && UPSTREAM_MSG_ID_RE.test(rawId)) {
    peek.upstreamMessageId = rawId;
    peek.upstreamIdStatus = "captured";
    return;
  }
  peek.upstreamIdStatus = "rejected";
}

/**
 * Smart-peek state for one stream.
 *
 * ⚠ **The WHOLE seam is gated on `ctxBase.stall`.** Both forwarders build
 * `peek` only when `stall !== undefined` (`const peek = stall !== undefined ?
 * newPeekState() : undefined`), so with stall detection off there is no
 * `PeekState` at all and the D99(c) join key is DEAD — no id reaches the
 * incident record and the counter reports `result="not_observed"` rather than
 * `"absent"`. That is a configuration dependency of a DIAGNOSTIC, documented
 * here rather than discovered by an operator wondering why the field is missing.
 */
export interface PeekState {
  /** First real content delta has been seen (Case-1 → Case-2 transition). */
  contentStarted: boolean;
  /** Currently inside an Anthropic `thinking` block (suspends the tight window). */
  inThinking: boolean;
  /**
   * Verbatim path only: the most recent `event:` field value, used to correlate
   * a `content_block_start` event line with its following `data:` line.
   */
  lastEvent: string;
  /**
   * D99(c) — the guard-ACCEPTED upstream `message_start` id. Present only when
   * {@link upstreamIdStatus} is `"captured"`; read the status, not this field's
   * absence, to learn why it is missing.
   */
  upstreamMessageId?: string;
  /** D99(c) — whether an upstream id was captured, rejected, or never seen. */
  upstreamIdStatus: UpstreamIdStatus;
}

export function newPeekState(): PeekState {
  return {
    contentStarted: false,
    inThinking: false,
    lastEvent: "",
    upstreamIdStatus: "absent",
  };
}

/**
 * Verbatim path: feed each COMPLETED SSE line (a bounded leading prefix up to
 * `STALL_PEEK_CAP` chars suffices). Mutates `peek`. `protocol` is the client
 * protocol label ("anthropic" | "openai_responses" | "openai_chat").
 */
export function peekVerbatimLine(
  line: string,
  protocol: string,
  peek: PeekState,
): void {
  if (protocol === "openai_responses") {
    if (
      !peek.contentStarted &&
      line.startsWith("event:") &&
      line.slice(6).trim() === "response.output_text.delta"
    ) {
      peek.contentStarted = true;
    }
    return;
  }
  if (protocol === "openai_chat") {
    // Chat has no `event:` lines; content rides in `data:` chunks. The role-only
    // first chunk carries no `"content"`, so this fires on the first real token.
    if (
      !peek.contentStarted &&
      line.startsWith("data:") &&
      !line.includes("[DONE]") &&
      line.includes('"content"')
    ) {
      peek.contentStarted = true;
    }
    return;
  }
  // anthropic (+ unknown, which defaults to the Anthropic shape upstream).
  if (line.startsWith("event:")) {
    const ev = line.slice(6).trim();
    peek.lastEvent = ev;
    if (ev === "content_block_delta") peek.contentStarted = true;
    else if (ev === "content_block_stop") peek.inThinking = false;
    // `content_block_start` block type is resolved at its `data:` line below.
  } else if (
    peek.lastEvent === "content_block_start" &&
    line.startsWith("data:")
  ) {
    // A thinking block's start carries `"type":"thinking"` in its content_block;
    // a text/tool_use block does not — set inThinking from this line directly.
    peek.inThinking = line.includes('"thinking"');
  } else if (
    peek.lastEvent === "message_start" &&
    line.startsWith("data:") &&
    peek.upstreamIdStatus === "absent"
  ) {
    // D99(c) — the join key. Same `event:`/`data:` correlation the arm above
    // uses; `message_start` is the same shape.
    //
    // ⚠ **The `upstreamIdStatus === "absent"` gate is load-bearing — do NOT copy
    // the arm above and drop it.** `peek.lastEvent` is never reset, so every
    // subsequent `data:` line of a multi-line SSE event re-enters this arm (that
    // is exactly why `peek.inThinking` above is re-assigned per data line — a
    // latent overwrite this arm must not reproduce). The gate makes the FIRST
    // `message_start` data line the only one that can decide the outcome, and it
    // also stops a second `message_start` later in the stream from replacing it.
    //
    // A NO-MATCH goes through the guard as `undefined` so it files as
    // `"rejected"`: at `STALL_PEEK_CAP` = 200 a `data:` line whose key order put
    // the id past the cap is indistinguishable from one carrying no id, and
    // "absent" there is a false claim. MEASURED on the captured Lane-1 fixture,
    // `"id":"msg_` starts at column 32 and the id closes at column 71 of a
    // 410-char line, so today's key order is comfortably inside the cap.
    const m = /"id"\s*:\s*"([^"]{1,128})"/.exec(line);
    captureUpstreamMessageId(m?.[1], peek);
  }
}

/**
 * Translated path: feed each OUTBOUND (post-translation) event object. Reads the
 * structured `type` (and, for an Anthropic `content_block_start`, the nested
 * `content_block.type`) directly. Mutates `peek`.
 */
export function peekOutboundEvent(
  event: unknown,
  protocol: string,
  peek: PeekState,
): void {
  if (event === null || typeof event !== "object") return;
  const rawType = (event as { type?: unknown }).type;
  const type = typeof rawType === "string" ? rawType : "";
  if (type === "") return;
  if (protocol === "openai_responses") {
    if (type === "response.output_text.delta") peek.contentStarted = true;
    return;
  }
  if (protocol === "openai_chat") {
    // Structurally blind, and NOT merely "not exercised in practice" — that
    // wording is what would make the resulting mislabel invisible. This bare
    // `return` is only HALF the blindness: the `type === "" -> return` guard
    // above already dropped every real `ChatStreamChunk`, which carries
    // `object`, not `type`. `peekObservesContent` is the predicate that states
    // this to the metric layer; read its docblock before touching either half.
    return;
  }
  // anthropic (+ unknown).
  if (type === "content_block_delta") {
    peek.contentStarted = true;
  } else if (type === "content_block_start") {
    const cb = (event as { content_block?: { type?: unknown } }).content_block;
    peek.inThinking = cb !== null && cb !== undefined && cb.type === "thinking";
  } else if (type === "content_block_stop") {
    peek.inThinking = false;
  }
}

/**
 * D99(c), translated path: feed each **UPSTREAM** (pre-translation) decoded
 * event object and capture the Anthropic `message_start` id.
 *
 * ⚠ **It reads the UPSTREAM event, and that is the whole point of it existing
 * as a separate function from {@link peekOutboundEvent}. Never repoint it at
 * `applyEvent`'s `result.events_out`.** On Lane 4 (CC client, Responses
 * upstream) the reverse translator's `handleResponseCreated` sets the OUTBOUND
 * `message_start.message.id` to ``strOr(response, "id", `msg_${Date.now()}`)``.
 * Upstream response ids may be opaque values containing `+`, `/` or `=`;
 * these are distinct from a translator-generated fallback message id, and
 * the fallback is locally minted. Reading the outbound event therefore
 * records either a non-upstream value or a manufactured one — the D96 "never
 * manufacture" class, arriving through the join key instead of the keep-alive.
 *
 * **It takes NO `protocol` argument, deliberately.** The discriminator is the
 * UPSTREAM event's own `type`. `protocol` is derived from `metricRoute`, so on
 * Lane 4 it reads `"anthropic"` while the upstream is Responses-shaped —
 * keying on it would be keying on the wrong side of the translation.
 *
 * A Responses-upstream stream reaches no `message_start` at all and correctly
 * leaves the status `"absent"`; that is expected, not a miss.
 */
export function peekUpstreamEvent(event: unknown, peek: PeekState): void {
  if (event === null || typeof event !== "object") return;
  const rawType = (event as { type?: unknown }).type;
  const type = typeof rawType === "string" ? rawType : "";
  if (type !== "message_start") return;
  // First one wins — the verbatim arm's gate, mirrored. A second `message_start`
  // must not replace a captured id, and a rejected one must not be retried into
  // a capture by a later malformed event.
  if (peek.upstreamIdStatus !== "absent") return;
  const message = (event as { message?: unknown }).message;
  const rawId =
    message !== null && typeof message === "object"
      ? (message as { id?: unknown }).id
      : undefined;
  captureUpstreamMessageId(rawId, peek);
}

// ---------------------------------------------------------------------------
// Slice (b) — detector PHASE derivation, plus the lane-observability predicate
// the phase depends on.
//
// Both live HERE rather than in `forward-stream.ts` because both are claims
// about the behaviour of the peek functions directly above: an implementer who
// changes one reads the other in the same screen. Stated in the other file they
// would be two files away from their own evidence.
// ---------------------------------------------------------------------------

/**
 * Can this lane's smart-peek observe content AT ALL?
 *
 * FALSE for exactly one lane — TRANSLATED × `openai_chat` — and that lane is
 * blind for TWO independent reasons, both of which must be removed before this
 * predicate may be weakened:
 *
 *   1. `peekOutboundEvent`'s `openai_chat` branch is a bare `return`. It never
 *      touches `contentStarted`.
 *   2. **Even implementing that branch does not restore observability.** The
 *      guard ABOVE the protocol switch reads `const type = typeof rawType ===
 *      "string" ? rawType : ""; if (type === "") return;` — and a real
 *      `ChatStreamChunk` (`src/types/openai-chat.ts`) declares
 *      `object: "chat.completion.chunk"` and carries NO `type` field at all. So
 *      every genuine chat chunk is dropped one guard EARLIER than the branch,
 *      and a hand-written `{type: …}` fixture will pass a test that real traffic
 *      would fail.
 *
 * ⚠ **Fixing the branch alone does NOT license deleting this predicate.** Both
 * (1) and (2) have to go, and the drift guard in
 * `tests/routes/_shared/stall-detect.test.ts` asserts each half separately so
 * the two cannot be confused for one another.
 *
 * Without this predicate the blind lane's waits file under `phase="no_response"`
 * and its streams under `reason="never_started"` — a mislabel that is wrong
 * 100 % of the time and invisible, because nothing on that lane ever contradicts
 * it.
 *
 * The VERBATIM `openai_chat` lane is NOT covered here: it can observe content
 * (`peekVerbatimLine`'s chat branch matches the `"content"` substring), but only
 * within `STALL_PEEK_CAP` bytes of the line — see that constant for the
 * data-dependent bias that leaves.
 */
export function peekObservesContent(
  lane: "verbatim" | "translated",
  protocol: string,
): boolean {
  return !(lane === "translated" && protocol === "openai_chat");
}

/**
 * Which stall budget the detector is applying to the read it is about to make.
 *
 * `"unobservable"` is NOT a fourth budget — it takes the same generous window as
 * `"no_response"`. It is a distinct LABEL because a blind lane's wait is not
 * evidence about the pre-content phase: `contentStarted` there is permanently
 * false for structural reasons, not because content is slow.
 */
export type DetectorPhase =
  | "no_response"
  | "thinking"
  | "response"
  | "unobservable";

/** Every `DetectorPhase`, for label iteration. Order is presentational only. */
export const DETECTOR_PHASES = [
  "no_response",
  "thinking",
  "response",
  "unobservable",
] as const;

/**
 * Derive the detector's phase from the smart-peek state and the lane's
 * structural observability.
 *
 * A ternary chain, deliberately NOT a `switch`: D73 reserves the no-`default`-arm
 * switch as the ONE machine-check on the stream-outcome union, and a second
 * exhaustive-switch idiom over an unrelated union dilutes that signal.
 *
 * ⚠ **Behaviour is byte-identical to the two-way predicate this replaces**, as
 * long as it is consumed through {@link detectorPeriodFor}. The old expression
 * was `peek.contentStarted && !peek.inThinking`; the new one differs only when
 * `!contentObservable && peek.contentStarted`, which is unreachable — a lane
 * that cannot observe content never sets `contentStarted`. What is NEW is the
 * LABEL, not the window.
 */
export function detectorPhaseOf(
  peek: PeekState,
  contentObservable: boolean,
): DetectorPhase {
  if (!contentObservable) return "unobservable";
  if (!peek.contentStarted) return "no_response";
  return peek.inThinking ? "thinking" : "response";
}

/**
 * The window in force for a phase. **The period is DERIVED FROM the phase**, so
 * a metric label and the budget it describes cannot disagree by construction.
 *
 * That is not a hypothetical guard. Before this pair existed, the race selected
 * its window from `contentStarted && !inThinking` while the stall RECORD labelled
 * itself from `contentStarted` alone, and a passing test emitted
 * `upstream stall: no further content within 1140000ms (response phase)` — the
 * label said `response` while 1,140,000 ms is the `no_response` budget.
 */
export function detectorPeriodFor(
  phase: DetectorPhase,
  cfg: StallConfig,
): number {
  return phase === "response" ? cfg.responseWaitMs : cfg.noResponseWaitMs;
}
