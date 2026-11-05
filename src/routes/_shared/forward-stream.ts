/**
 * forward-stream.ts — verbatim byte-pass-through SSE forwarder (D-LOCK-7).
 *
 * Per M5 D-LOCK-7: forwards upstream bytes EXACTLY (no decode/re-encode).
 * Honors client abort via signal listener that calls reader.cancel(). Releases
 * the reader's lock in a finally block so the upstream connection is freed
 * even if the client disconnects while the reader is suspended in `read()`.
 *
 * Replaces the inline `streamSSE(...)` block previously duplicated in three
 * handlers (messages, responses, chat-completions). The previous shape had
 * four bugs flagged by the M5 discriminator (iter-1 H1):
 *
 *   1. Final-flush dropped — `decoder.decode(value, { stream: true })` left
 *      any trailing partial UTF-8 codepoint silently truncated when the
 *      upstream closed; no `decoder.decode()` no-arg flush call.
 *   2. Re-encode cost — decode-to-string then write-string forces a UTF-8
 *      re-encode on the wire, violating the D-LOCK-7 "verbatim" contract
 *      despite the in-code comment claiming verbatim.
 *   3. Binary corruption risk — future non-UTF-8 SSE data fields would
 *      corrupt under the decode-then-encode round-trip.
 *   4. No reader cleanup — `reader.cancel()` and `reader.releaseLock()` were
 *      never called. If the client disconnected while the reader was
 *      suspended in `read()`, the upstream connection was held until GC.
 *      The polling abort-check only triggers BEFORE `reader.read()`, not
 *      while suspended.
 *
 * Hono's `StreamingApi.write` accepts `Uint8Array | string` (verified in
 * node_modules/hono/dist/types/utils/stream.d.ts:20), so we pass the upstream
 * `Uint8Array` chunks directly — no decode required, no codepoint
 * truncation risk, byte-exact forwarding.
 */

import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import consola from "consola";

import { LEVEL_ON, debug } from "~/lib/debug.ts";
import {
  type IncidentConfig,
  type IncidentRecord,
} from "~/lib/incident-log.ts";
import {
  boundedLabelValue,
  bumpTraceWrites,
  classifyTraceError,
  getValueForTests,
  incCounter,
  observeHistogram,
  setGauge,
} from "~/lib/metrics.ts";
import {
  decodeSseChunk,
  encodeSseEvent,
  isChatDoneSentinel,
  trailingIsTruncatedEvent,
  type SseDecoderState,
} from "~/lib/sse-codec.ts";
import {
  classifyBody,
  type FlowRecord,
  type TraceWriter,
} from "~/lib/trace.ts";
import { applyEvent } from "~/lib/transform/apply_event.ts";
import type { RegisteredStreamEventRule } from "~/lib/transform/registry.ts";
import {
  acquireStreamState,
  releaseStreamState,
} from "~/lib/transform/sse-state.ts";
import type { Rule, StreamEventContext } from "~/lib/transform/types.ts";
import { deriveUpstreamSignal } from "~/routes/_shared/derive-upstream-signal.ts";
import {
  formatErrorChain,
  safeStringify,
} from "~/routes/_shared/error-helpers.ts";
import {
  buildStallRecord,
  DETECTOR_PHASES,
  detectorPeriodFor,
  detectorPhaseOf,
  newPeekState,
  peekObservesContent,
  peekOutboundEvent,
  peekUpstreamEvent,
  peekVerbatimLine,
  raceReadWithKeepAlive,
  STALL_PEEK_CAP,
  type DetectorPhase,
  type KeepAliveConfig,
  type PeekState,
  type RaceReadResult,
  type StallConfig,
  type StallTimer,
} from "~/routes/_shared/stall-detect.ts";

// ---------------------------------------------------------------------------
// Phase 5 v3.1 Group C — streaming-side trace wiring (F-DISC-3, F-DISC-4,
// F-DISC-14). The streaming forwarders now buffer the outbound (post-
// translation, when applicable) byte stream up to a per-stream cap so the
// `finally` block can serialize a `FlowRecord` and hand it to the writer.
// Buffer cap defaults to 4 MB per F-DISC-4; overflow is logged once via
// `consola.warn` (visible to operators) and the flow is still written —
// just with `event_counts` reflecting only the captured chunks.
// ---------------------------------------------------------------------------

/** Default per-stream buffer cap when `ctxBase.streamBufferMb` is unset. */
const STREAM_BUFFER_MB_DEFAULT = 4;

/** F6 — the three bytes of a leading UTF-8 BOM (EF BB BF). The verbatim
 *  truncation scanner swallows one leading BOM from line classification (it is
 *  NOT a real SSE field) while still forwarding it verbatim. */
const BOM_BYTES = [0xef, 0xbb, 0xbf];

/**
 * Process-wide single-shot guard for trace-write failures. The first failure
 * surfaces via `consola.warn`; every subsequent failure is silent at the log
 * level (still counted by `copilot_proxy_trace_errors_total`). Prevents
 * log-spam on persistent ENOSPC / EACCES while keeping the operator-visible
 * heads-up on the first occurrence (F-DISC-3).
 */
let firstFailureReported = false;

/**
 * Emit a `consola.warn` for the first trace-write failure per process; later
 * failures are dropped at the log level (Prometheus counter still ticks via
 * `bumpTraceWrites("error", ...)` at the call site). Idempotent + thread-safe
 * (single-threaded JS loop).
 */
function reportFirstFailure(err: unknown, requestId: string): void {
  if (firstFailureReported) return;
  firstFailureReported = true;
  consola.warn(
    `trace: first write failure (request ${requestId}); subsequent failures will be silent — see copilot_proxy_trace_errors_total: ${String(err)}`,
  );
}

/**
 * TEST-ONLY: reset the first-failure throttle so tests can independently
 * exercise the "first failure surfaces via consola.warn" path. Production
 * code MUST never call this — the throttle is intentionally process-wide.
 */
export function _resetFirstFailureForTests(): void {
  firstFailureReported = false;
}

/**
 * Phase 5 v3.1 Group C — minimal `TraceMeta` shape consumed by the streaming
 * forwarders to assemble a `FlowRecord` in the `finally` block.
 *
 * **Group B note:** Group B owns the canonical `TraceMeta` definition (lives
 * with `with-trace.ts`). For Group C we declare a minimal LOCAL type so this
 * file remains independent of Group B's middleware. Group B may later move
 * this type to a shared location and re-export it; field names are stable.
 */
export interface TraceMeta {
  /** Per-request id (echoed in log lines + `consola.warn` failure surfaces). */
  requestId: string;
  /** Inbound HTTP method ("POST", "GET", ...). */
  method: string;
  /** Full inbound URL string. */
  url: string;
  /** Inbound `Host` header (sans port). */
  host: string;
  /** Inbound path (no query). */
  path: string;
  /** Inbound headers (raw; redaction happens inside `TraceWriter.write`). */
  inboundHeaders: Record<string, string>;
  /** Inbound body bytes (null = empty body, e.g. GET). */
  inboundBody: Uint8Array | null;
  /** Inbound `Content-Type` (used by `classifyBody` for JSON/SSE detection). */
  inboundContentType: string;
  /** Wall clock (ms since epoch) when the inbound request was received. */
  startedAt: number;
}

/**
 * Per-event context base passed to `forwardStreamTranslated` so the per-
 * event apply loop fills `route` + `model` for predicate matches (e.g.,
 * `when: { route: "/v1/messages" }`). C1 fix: `StreamEventContext`
 * REQUIRES these fields per `types.ts:205-218` — handler must thread the
 * matched route + parsed body model through, OR predicates that filter on
 * route/model would never fire in stream-side rules. Stream context has
 * NO `harness` field (harness is body-engine TransformContext only).
 *
 * **M12 D-LOCK-3 — also threaded into the verbatim `forwardStream` path.**
 * Previously only the translated path took this; M12 extends `forwardStream`
 * to also accept it so per-route metrics counters (`response_bytes_total`,
 * `stream_events_total`) have the route label available without touching
 * the global request context.
 *
 * **M12.5 H1 — `metricRoute` added.** `route` (the inbound HTTP path,
 * e.g. `/v1/messages`) is consumed by stream-event predicates via
 * `applyEvent` (`when: { route: "/v1/messages" }`); it MUST stay equal to
 * the path. `metricRoute` is the clean canonical Prometheus label
 * (e.g. `messages`, `responses`, `chat_completions`) and is the ONLY
 * value used in metric emissions from this module. Without the split,
 * stream metrics emitted `route="/v1/messages"` while the wrapping
 * `withMetrics` middleware emitted `route="messages"` — Prometheus
 * cross-metric joins on `route` failed (split labels). Both paths
 * (verbatim `forwardStream` + translated `forwardStreamTranslated`) take
 * a `StreamCtxBase` with both fields populated by the handler.
 *
 * **M2 (D100) — build this ONCE per handler, as an ANNOTATED `const`.** Each of
 * the three handlers used to spell it as two byte-identical object literals, one
 * per forwarder branch: six copies of one shape, so an edit adding a field had
 * six places to land and five ways to be half-applied.
 *
 * The `: StreamCtxBase` annotation on that hoisted `const` is **load-bearing, and
 * that is the non-obvious part.** TypeScript applies excess-property checking to a
 * FRESH object literal at an argument position — which is exactly what the six
 * literals were getting for free. A hoisted `const` reaches the call site as a
 * VARIABLE, so the check no longer fires there, and an unannotated hoist would
 * silently trade the typo protection away while looking like a pure refactor.
 * **MEASURED, three arms under `bun run typecheck`, not assumed:** annotated with a
 * `metricRout:` typo → `TS2561 … Did you mean to write 'metricRoute'?`; the SAME
 * typo with the annotation removed → **compiles clean, rc 0**; control → clean.
 * **Do not drop the annotation to "tidy" the declaration.**
 */
export interface StreamCtxBase extends Pick<
  StreamEventContext,
  "route" | "model"
> {
  /**
   * Clean canonical metric label (e.g., "messages", "responses",
   * "chat_completions"). Used by forward-stream metric emissions only.
   * NOT the same as `route` (which is the inbound HTTP path consumed by
   * stream-event predicates).
   */
  metricRoute: string;
  /**
   * Phase 5 v3.1 Group C — when set, the streaming forwarders buffer the
   * outbound chunks and persist a `FlowRecord` to disk in their `finally`
   * blocks. When unset (the legacy default), the forwarders behave exactly
   * as they did pre-Group-C — no buffer allocation, no disk I/O.
   */
  traceWriter?: TraceWriter;
  /**
   * Phase 5 v3.1 Group C — request/inbound metadata required to assemble the
   * `FlowRecord`. Co-required with `traceWriter`: when one is set the other
   * MUST be, otherwise the trace-write step in `finally` is skipped.
   */
  traceMeta?: TraceMeta;
  /**
   * Phase 5 v3.1 Group C — per-stream buffer cap in megabytes. Defaults to
   * `STREAM_BUFFER_MB_DEFAULT` (4) per F-DISC-4. Group B will thread this
   * through `config-schema.ts` for operator override.
   */
  streamBufferMb?: number;
  /**
   * Feature W2 — content-phase stall detector. When set (schema default is ON),
   * both forwarders race each `reader.read()` against a two-phase idle timer and
   * surface a protocol-shaped `upstream_stall` (504) frame + a retained JSONL
   * diagnostics record if the upstream goes silent past the phase's window. When
   * UNSET (legacy caller / feature off / existing test), both read loops behave
   * exactly as before — no timer, no smart-peek. Threaded like `streamBufferMb`.
   */
  stall?: StallConfig;
  /**
   * F165 / D96 Amendment 1 — the proxy-emitted SSE keep-alive comment. When set
   * (schema default is ON as of D118), a byte-silent read inside the
   * stall detector's race emits `: keepalive\n\n` to the client every
   * `intervalMs` so the client's own idle watchdog does not tear down a stream
   * the upstream is still working on.
   *
   * ⚠ **Meaningless without `stall`, and that is enforced at construction, not
   * here.** `makeKeepAliveConfig` takes the `StallConfig` as a parameter and
   * REFUSES (with a warn) when it is absent, because a keep-alive with no
   * detector behind it suppresses the client's watchdog while nothing bounds a
   * dead stream. The forwarders reinforce it structurally: the whole keep-alive
   * lives inside the `stall !== undefined` race branch, so with the detector off
   * this field is dead regardless of how it was built.
   */
  keepAlive?: KeepAliveConfig;
  /**
   * Per-request join key, resolved by `getRequestId(c)` in the handler and
   * threaded here INDEPENDENTLY of `logging.level`.
   *
   * **Why this exists separately from `traceMeta.requestId`.** `traceMeta` is
   * built by `with-trace.ts` ONLY at `level >= raw` (D69 live gate), so at the
   * default `level: off` it is `undefined` — and every diagnostic that read
   * `traceMeta?.requestId` degraded to the literal `<unknown>`. That made the
   * stall detector's JSONL records and the truncation log line impossible to
   * correlate with client-side failures unless this independent key is passed.
   *
   * The id itself was never the problem: `getRequestId` has always minted one
   * (or adopted an inbound `x-request-id`) on every request at every level.
   * The VERBATIM path simply never received it — `forwardStreamTranslated`
   * takes it as a positional parameter, `forwardStream` did not. Lane 1
   * (`^claude-` on `/v1/messages`, i.e. every Claude Code session) is the
   * verbatim path, so the blind path was the only one that mattered.
   *
   * Optional so legacy callers and existing tests construct `StreamCtxBase`
   * unchanged; consumers fall back to `traceMeta?.requestId` then `<unknown>`.
   */
  requestId?: string;
  /**
   * D96 Phase 1 — always-on stream-incident log. When set (schema default is
   * ON), a stream completing with any outcome other than `success` appends one
   * JSONL record. UNSET (feature off / legacy caller / existing test) means no
   * record and no allocation beyond the per-stream counters, which are plain
   * numbers.
   *
   * This is a SIBLING of `logging.level`, never a child of it — the same
   * relationship `stall` already has, and for the same reason: the fleet runs
   * at the default level, so a diagnostic gated behind `raw` is blind exactly
   * when it is needed (F138).
   */
  incident?: IncidentConfig;
  /**
   * D96 Phase 1 — inbound request body size in bytes, when the handler knows
   * it. Recorded on an incident because request size was the first thing asked
   * for and the first thing unrecoverable after the fact: nothing else in the
   * proxy retains it at the default level (the trace path that does is gated
   * on `raw`). Optional — a handler that does not compute it simply omits the
   * field rather than reporting a wrong one.
   */
  requestBytes?: number;
  /**
   * F159 — `performance.now()` stamped by the `withMetrics` wrapper at PROXY
   * REQUEST ENTRY, threaded here by the handler via `dispatchStartedMsOf(c)`.
   * It is the origin of `copilot_proxy_dispatch_first_byte_seconds`, the
   * end-to-end companion to `copilot_proxy_upstream_first_byte_seconds`
   * (whose clock starts inside the stream callback, i.e. after the upstream
   * response headers are already in).
   *
   * ⚠ **NEVER substitute the forwarder's own start instant when this is
   * absent.** That is F159 itself, republished under the new name: it would
   * put a post-header value into the end-to-end series where nothing could
   * tell the two apart afterwards.
   *
   * Optional so legacy callers and existing tests construct `StreamCtxBase`
   * unchanged — but an ABSENT value in production is a DEFECT, not a supported
   * mode, and is counted by `copilot_proxy_dispatch_anchor_missing_total`.
   */
  dispatchStartedMs?: number;
}

/**
 * Resolve the per-request join key, preferring the level-INDEPENDENT
 * `ctxBase.requestId` and falling back to the level-gated `traceMeta` for
 * legacy callers that thread only the latter. `undefined` when neither is
 * present, so a record field stays absent rather than claiming a false id.
 */
function requestIdOf(ctxBase: StreamCtxBase): string | undefined {
  return ctxBase.requestId ?? ctxBase.traceMeta?.requestId;
}

/**
 * Display form of {@link requestIdOf} for log interpolation. `<unknown>` is
 * retained as the last resort so the line shape never changes, but it should
 * now be unreachable in production: every handler threads `requestId`.
 * Seeing `<unknown>` in a log is therefore itself a defect signal.
 */
function requestIdLabel(ctxBase: StreamCtxBase): string {
  return requestIdOf(ctxBase) ?? "<unknown>";
}

/**
 * D96 Phase 1 — inbound request size for the incident record, read from the
 * `content-length` header rather than by re-serializing the parsed body.
 *
 * The obvious alternative is what the trace path already does —
 * `new TextEncoder().encode(JSON.stringify(body))` — and it is affordable
 * THERE only because it runs at `level >= raw` and nowhere else. Doing it
 * unconditionally would put a full stringify of a ~200k-token body on the hot
 * path of every streaming request, to populate a field consulted on the
 * fraction of a percent that fail. The header is also the more honest number:
 * it is what the client actually sent, not what a round-trip through our own
 * parser would re-emit.
 *
 * Absent, malformed or negative → `undefined`, so the record omits the field
 * rather than asserting a wrong one. "Malformed" is enforced by matching the
 * WHOLE header against `^\d+$` before converting: `Number.parseInt` alone
 * accepts a numeric PREFIX, so `812004junk` would be recorded as `812004` and
 * `1e6` as `1`. Conforming traffic cannot produce either — an HTTP parser
 * rejects such a `content-length` upstream of us — so this is a truth-in-
 * documentation fix rather than a reachable defect, but the docblock claimed
 * the guarantee and the code did not implement it (round-5 gate).
 */
export function requestBytesOf(c: Context): number | undefined {
  const raw = c.req.raw.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * **M12.5 H2 — stream-lifecycle ownership transfer.** When the wrapping
 * `withMetrics` middleware sees a `text/event-stream` response, it SKIPS
 * the inflight decrement + requests_total increment in its `finally`
 * (the handler resolves the Response synchronously after streamSSE
 * flushes headers, but the stream callback is still writing). Instead,
 * BOTH `forwardStream` + `forwardStreamTranslated` call this helper from
 * their `finally` blocks — which fire only after the stream actually
 * completes (client drains, abort, or upstream close). Status is "200"
 * because by the time we entered forward-stream the upstream had already
 * returned a 2xx body (otherwise the handler would have errored before
 * forwarding); a more nuanced status (e.g., "stream_error" on mid-stream
 * abort) is M13 backlog.
 *
 * Uses `Math.max(0, prior - 1)` so a double-decrement (e.g., if the
 * middleware ever flips streams back to its own ownership in a future
 * change) stays non-negative.
 *
 * **M12.6 M1-NEW — outcome parameter.** The pre-M12.6 helper recorded
 * `status="200"` unconditionally, even when the catch block fired due to
 * a client abort or upstream mid-stream error. That distorted Prometheus
 * status-code distributions for stream lanes (everything looked like 2xx
 * regardless of actual outcome). The new `outcome` param maps to status:
 *   - `"success"`       -> `status="200"` (clean drain or upstream close)
 *   - `"client_abort"`  -> `status="499"` (Nginx convention for client-
 *                          aborted requests; the connection was open but
 *                          the client disconnected mid-stream)
 *   - `"upstream_error"`-> `status="502"` (bad gateway; the upstream
 *                          socket errored / was reset mid-stream)
 *   - `"internal_error"`-> `status="500"` (F4 — a proxy-internal transform
 *                          failure: EngineAbort500Error / UnregisteredRuleError
 *                          / RuleSchemaInvalidError. Only the translated path
 *                          runs transforms, so only it can produce this.)
 *   - `"upstream_stall"`-> `status="504"` (W2 — the upstream held the socket
 *                          open but went byte-silent past the phase-aware stall
 *                          window; the detector aborts it + injects a gateway-
 *                          timeout frame. Set in the read loop, never the catch.)
 *
 * Detection lives in each forwarder's catch block (it inspects
 * `clientSignal.aborted` and `stream.aborted`); the finally block
 * threads the resulting outcome into this helper.
 */
type StreamCompletionOutcome =
  | "success"
  | "client_abort"
  | "upstream_error"
  | "internal_error"
  | "upstream_stall";

function statusFromOutcome(outcome: StreamCompletionOutcome): string {
  switch (outcome) {
    case "success":
      return "200";
    case "client_abort":
      return "499";
    case "upstream_error":
      return "502";
    case "internal_error":
      return "500";
    case "upstream_stall":
      return "504";
  }
}

/**
 * Phase 5 v3.1 Group C — numeric variant of `statusFromOutcome` for the
 * `FlowRecord.response.status` field (which is `int` per the trace schema,
 * not the string Prometheus uses). Reuses the same M12.6 mapping so trace
 * status + Prometheus status stay in lock-step. If a future change adds
 * outcomes here, update both helpers atomically.
 */
function numericStatusFromOutcome(outcome: StreamCompletionOutcome): number {
  switch (outcome) {
    case "success":
      return 200;
    case "client_abort":
      return 499;
    case "upstream_error":
      return 502;
    case "internal_error":
      return 500;
    case "upstream_stall":
      return 504;
  }
}

/**
 * Phase 5 v3.1 Group C — human-readable reason phrase paired with
 * `numericStatusFromOutcome`. The trace uses a terse lowercase reason with
 * underscores: the upstream reason for known outcomes, or a local reason for
 * a client abort that has no upstream counterpart.
 */
function reasonFromOutcome(outcome: StreamCompletionOutcome): string {
  switch (outcome) {
    case "success":
      return "OK";
    case "client_abort":
      return "Client Closed Request";
    case "upstream_error":
      return "Bad Gateway";
    case "internal_error":
      return "Internal Server Error";
    case "upstream_stall":
      return "Gateway Timeout";
  }
}

/**
 * D96 Phase 1 — per-stream state the incident record needs that is not already
 * an argument of the metric write. Assembled once per stream by each forwarder
 * and handed to {@link recordStreamCompletion}.
 *
 * **Why it rides on `recordStreamCompletion` instead of its own call site.**
 * That helper is the ONLY code both outer `finally` blocks already invoke, so
 * routing the record through it makes lane symmetry structural rather than
 * something a reviewer has to notice — D47's "fix the twin in the same
 * iteration" enforced by construction. It also already computes the decremented
 * inflight value, which is one of the fields, so no second read of the gauge.
 */
interface IncidentContext {
  ctxBase: StreamCtxBase;
  /** Client protocol label; with route + model this identifies the lane. */
  protocol: string;
  /** `performance.now()` at forwarder entry. */
  startedMs: number;
  /** `performance.now()` at the first non-empty upstream chunk; undefined if none ever arrived. */
  firstByteMs: number | undefined;
  /** Upstream bytes received, counted UNCONDITIONALLY (see the forwarders). */
  bytesReceived: number;
  /**
   * Largest byte-silent gap observed WITHIN the stream, in ms. Tracked as a
   * running max rather than per-gap histogram writes: observing every gap would
   * be thousands of writes per busy stream to answer a question about one
   * number. ⚠ This is a TRIAGE upper bound, NOT the span the stall detector
   * observes — see `observeStreamHistograms` for the measured divergences (four
   * so far, in BOTH directions, and the list is not known to be complete), and
   * and do not derive a detector window from it.
   */
  maxSilenceMs: number;
  /** `performance.now()` at the most recent upstream chunk; undefined if none. */
  lastByteMs: number | undefined;
  /** Inflight gauge for this route sampled at forwarder entry. */
  inflightAtStart: number | undefined;
  /** Smart-peek state, when the stall detector is active; sharpens `phase`. */
  peek: PeekState | undefined;
  /**
   * Per-stream MAX detector-active wait, KEYED BY THE PHASE IT WAS SPENT IN. A
   * key exists **iff** that phase was actually entered — never a synthetic zero,
   * because a zero sample for a phase the stream never reached would drag the
   * low end of the very quantile the series exists to establish.
   *
   * Sparse rather than a scalar for the reason the scalar could not survive: one
   * number per stream mixes the pre-content, thinking and response budgets, i.e.
   * `max_silence` divergence #3 reproduced inside the instrument built to
   * replace it.
   */
  maxDetectorWaitMsByPhase: Partial<Record<DetectorPhase, number>>;
  /**
   * The phase whose wait was RIGHT-CENSORED by the stall timer winning, if any.
   * At most one per stream: the stall arm terminates the stream. Its elapsed
   * time is deliberately NOT a histogram sample — see
   * `copilot_proxy_detector_wait_censored_total` — and it additionally
   * SUPPRESSES that phase's own completed-wait sample, because the censoring is
   * applied per READ while the sample is per STREAM×PHASE. See
   * `observeStreamHistograms` for why publishing both is a known underestimate
   * AND a double count.
   */
  censoredWaitPhase: DetectorPhase | undefined;
  /**
   * Elapsed ms on the censored read: a LOWER BOUND (≈ the window that was in
   * force), never a measurement of the true wait, which is unknowable because
   * the read is orphaned.
   *
   * Carried for the incident RECORD alone. It must never reach a histogram —
   * that is the entire point of the censoring — but a record that drops it says
   * nothing at all about the wait that killed the stream, which was the state
   * slice (b) shipped in.
   */
  censoredWaitMs: number | undefined;
  /** `performance.now()` at the first CONTENT delta; undefined if none was observed. */
  firstContentMs: number | undefined;
  /** Whether this lane's smart-peek can observe content AT ALL (`peekObservesContent`). */
  contentObservable: boolean;
}

/**
 * Classify the content phase at completion. Prefers the smart-peek's view
 * (which tracks real content deltas and Anthropic thinking blocks) and falls
 * back to the raw first-byte signal when the stall detector is off, so the
 * field is populated in both configurations rather than silently absent in one.
 *
 * `contentObservable` is tested FIRST inside the peek branch, and the order is
 * load-bearing: on a structurally blind lane `contentStarted` and `inThinking`
 * are permanently false, so without that test the record would assert
 * `pre_content` — a false measurement, not a missing one. The detector-OFF
 * fallback deliberately ignores `contentObservable`: it reads a RAW-byte signal,
 * which every lane can produce, and claiming `unobservable` there would assert
 * something about a lane nothing ever looked at. Same precedence as
 * {@link noContentReason}.
 */
function incidentPhase(
  peek: PeekState | undefined,
  firstByteMs: number | undefined,
  contentObservable: boolean,
): IncidentRecord["phase"] {
  if (peek !== undefined) {
    if (!contentObservable) return "unobservable";
    if (peek.inThinking) return "thinking";
    return peek.contentStarted ? "mid_stream" : "pre_content";
  }
  return firstByteMs === undefined ? "pre_content" : "mid_stream";
}

/**
 * Why this stream contributed no `copilot_proxy_first_content_seconds` sample.
 *
 * **The precedence is the contract, and it is not obvious.** A blind lane with
 * the detector OFF files as `detector_off`, not `lane_unobservable`: nothing
 * looked, so asserting the lane's incapacity would claim knowledge this stream
 * never had. Only once the detector actually ran does the lane's structural
 * blindness become the reason, and only once BOTH of those are excluded is
 * "content simply never arrived" a true statement.
 */
function noContentReason(
  ctx: IncidentContext,
): "detector_off" | "lane_unobservable" | "never_started" {
  if (ctx.peek === undefined) return "detector_off";
  if (!ctx.contentObservable) return "lane_unobservable";
  return "never_started";
}

/**
 * Build and append one incident record. TOTAL-SAFE: this runs inside a
 * stream's outer `finally`, so a throw would tear down a live stream on its
 * way out. The writer itself never throws; this wrapper additionally guards
 * record ASSEMBLY, which reads fields off a caller-supplied object.
 *
 * The "is an incident log configured" test lives HERE, inside the try, rather
 * than at the call site: `ctx.ctxBase` is caller-supplied, so reading
 * `.incident` off it is exactly as capable of throwing as the field reads the
 * try already covers, and a read placed at the call site would escape into the
 * stream's outer `finally` instead. Keeping it here also leaves
 * `recordStreamCompletion` with no try of its own — the gauge/counter writes it
 * performs are total by construction, and wrapping them would silently convert
 * a real accounting bug into a swallowed one.
 */
function emitIncident(
  ctx: IncidentContext,
  outcome: StreamCompletionOutcome,
  inflightAtEnd: number,
): void {
  try {
    const { ctxBase } = ctx;
    const incident = ctxBase.incident;
    if (incident === undefined) return;
    const now = performance.now();
    const record: IncidentRecord = {
      ts: new Date().toISOString(),
      outcome,
      status: numericStatusFromOutcome(outcome),
      route: ctxBase.metricRoute,
      protocol: ctx.protocol,
      // `requestIdOf` (not `requestIdLabel`): a record asserting `<unknown>`
      // is worse than one omitting the field, because a consumer cannot tell
      // afterwards which it was looking at.
      requestId: requestIdOf(ctxBase),
      // Rounded to whole ms: `performance.now()` is sub-microsecond and the
      // extra digits are noise that makes lines harder to scan.
      ttfbMs:
        ctx.firstByteMs === undefined
          ? undefined
          : Math.round(ctx.firstByteMs - ctx.startedMs),
      elapsedMs: Math.round(now - ctx.startedMs),
      phase: incidentPhase(ctx.peek, ctx.firstByteMs, ctx.contentObservable),
      bytesReceived: ctx.bytesReceived,
      inflightAtStart: ctx.inflightAtStart,
      inflightAtEnd,
    };
    if (ctx.firstContentMs !== undefined) {
      record.firstContentMs = Math.round(ctx.firstContentMs - ctx.startedMs);
    }
    // The per-stream JOIN: which phase this stream waited longest in, and for
    // how long. Computed here rather than carried, because the map is the
    // authoritative shape and a second accumulator would be a drift surface.
    // Iterating DETECTOR_PHASES (not `Object.entries`) keeps the key typed.
    //
    // ⚠ This is the max over COMPLETED waits only. The censored wait is NOT
    // folded in and MUST NOT be: the two are not comparable, because each phase
    // carries its own window, so a censored `response` wait (`>= 600 s`) can be
    // smaller or larger than a completed `no_response` one (up to 1 140 s), and
    // a max over the union would silently mix a bound with a measurement. It is
    // reported alongside instead, in its own pair of fields.
    let worstPhase: DetectorPhase | undefined;
    let worstMs = -1;
    for (const phase of DETECTOR_PHASES) {
      const ms = ctx.maxDetectorWaitMsByPhase[phase];
      if (ms === undefined || ms <= worstMs) continue;
      worstMs = ms;
      worstPhase = phase;
    }
    if (worstPhase !== undefined) {
      record.maxDetectorWaitMs = Math.round(worstMs);
      record.maxDetectorWaitPhase = worstPhase;
    }
    // The wait that actually killed a stall-terminated stream. Without this the
    // record was SILENT on the dominant population it exists to explain: on a
    // pre-content stall the map is empty, so both fields above are absent and
    // the record reads as if the detector never armed; on a post-content stall
    // they report an earlier, trivially small wait under the wrong phase.
    if (
      ctx.censoredWaitPhase !== undefined &&
      ctx.censoredWaitMs !== undefined
    ) {
      record.censoredWaitPhase = ctx.censoredWaitPhase;
      record.censoredWaitMs = Math.round(ctx.censoredWaitMs);
    }
    if (ctxBase.model !== undefined && ctxBase.model !== "") {
      record.model = ctxBase.model;
    }
    // D99(c) — the CLIENT-side join key. `ctx.peek` is already a field of
    // IncidentContext and already threaded from BOTH lanes, so this costs no
    // new plumbing: the D47 mirror is inherited from the seam rather than
    // re-established here. Absent when stall detection is off (no peek exists),
    // when no `message_start` was seen, or when its id failed the shape guard —
    // `copilot_proxy_upstream_msg_id_total{result}` is what tells those apart.
    const upstreamId = ctx.peek?.upstreamMessageId;
    if (upstreamId !== undefined) {
      record.upstreamMessageId = upstreamId;
    }
    if (ctxBase.requestBytes !== undefined) {
      record.requestBytes = ctxBase.requestBytes;
    }
    // `IncidentConfig.log` is declared `void`, but `void` accepts an
    // implementation that returns a promise — an `async log()` type-checks
    // here and its rejection would land AFTER this synchronous try has already
    // returned, i.e. as an unhandled rejection with no stream to attribute it
    // to. Attach a no-op rejection handler when (and only when) something
    // thenable came back.
    //
    // ⚠ The DEFAULT writer is SYNCHRONOUS (`appendIncidentLog` →
    // `appendFileSync`) and that is deliberate, not an oversight: D97
    // Decision 1 weighed an async bounded-queue writer and REJECTED it,
    // because a queued record is lost in exactly the crash it exists to
    // explain. Only the defensive thenable-rejection handling below is
    // fire-and-forget. An earlier revision of this comment said the project's
    // "whole reason" for the incident log was to keep file I/O off the
    // completion path — that is the design D97 turned down, asserted here as
    // the rationale for the design it chose instead.
    const returned: unknown = incident.log(record);
    if (
      returned !== null &&
      (typeof returned === "object" || typeof returned === "function") &&
      typeof (returned as { then?: unknown }).then === "function"
    ) {
      void Promise.resolve(returned).catch(() => {
        /* a failed incident write must not surface as an unhandled rejection */
      });
    }
  } catch {
    /* an incident record must never be able to break the stream it describes */
  }
}

function recordStreamCompletion(
  metricRoute: string,
  outcome: StreamCompletionOutcome,
  incidentCtx?: IncidentContext,
): void {
  const inflight =
    getValueForTests("copilot_proxy_inflight_requests", {
      route: metricRoute,
    }) ?? 1;
  const inflightAtEnd = Math.max(0, inflight - 1);
  setGauge("copilot_proxy_inflight_requests", inflightAtEnd, {
    route: metricRoute,
  });
  incCounter("copilot_proxy_requests_total", 1, {
    route: metricRoute,
    status: statusFromOutcome(outcome),
  });
  if (incidentCtx !== undefined) {
    // D96 Phase 1 — histograms are observed for EVERY stream, success included.
    // That is the point: a threshold is set from the HEALTHY population's
    // distribution, and recording only failures would leave the ladder exactly
    // as unmeasured as it is today.
    observeStreamHistograms(incidentCtx, metricRoute);
    // The incident RECORD, by contrast, is failures only — it is a file, not an
    // aggregate, so including successes would make it a function of traffic.
    // The "is a log configured" test is inside `emitIncident`'s try, not here:
    // a property read on the caller-supplied `ctxBase` performed at THIS level
    // would escape into the stream's outer `finally`.
    if (outcome !== "success") {
      emitIncident(incidentCtx, outcome, inflightAtEnd);
    }
  }
}

/**
 * D96 Phase 1 — publish this stream's latency, silence and request-size
 * observations. Called once per stream from the single completion choke point,
 * so both lanes are covered by construction (D47).
 *
 * **Populations — these families do NOT share a denominator.** (There is
 * deliberately no count in that sentence: it named "four" while four slices were
 * queued to extend the list, which is the same drift surface `docs/runbook.md`
 * calls its own most-repeated defect.)
 *
 * - `copilot_proxy_upstream_first_byte_seconds` — streams that produced a first
 *   byte, measured from THIS callback's start, i.e. after the upstream response
 *   headers were already received. It excludes the header phase entirely, which
 *   is why it is no longer called `ttfb` and why no boundary on it carries a
 *   client-watchdog reading (F159). A stream that never answered has no first
 *   byte, so it is not a sample.
 * - `copilot_proxy_dispatch_first_byte_seconds` — the SAME endpoint from the
 *   handler-supplied end-to-end origin (`ctxBase.dispatchStartedMs`, stamped in
 *   `withMetrics` at request entry), so it INCLUDES the header phase. It
 *   excludes TWO populations, not one, and both must be added back before any
 *   fraction is derived: streams that produced no byte
 *   (`copilot_proxy_stream_no_first_byte_total`, below), and requests that
 *   never obtained an upstream stream at all
 *   (`copilot_proxy_dispatch_no_upstream_total`). **That second counter lives
 *   OUTSIDE this file, in the handlers' dispatch `catch` arms, because the
 *   request never reached this forwarder** — which is precisely why the
 *   post-header series cannot see that population and this one needs the extra
 *   term. A stream whose anchor is absent or inverted contributes no sample and
 *   ticks `copilot_proxy_dispatch_anchor_missing_total` instead.
 * - `copilot_proxy_stream_no_first_byte_total` — the population the two lines
 *   above EXCLUDE, counted exactly once per stream. Without it the first-byte
 *   denominators are censored and unrecoverable: dropping every silent stream
 *   makes a bucket-over-count ratio read 100 % in precisely the outage the
 *   distribution exists to detect. `upstream_first_byte_count +
 *   no_first_byte_total` is the true count of streams that STARTED.
 * - `copilot_proxy_stream_max_silence_seconds` — streams that produced a first
 *   byte, i.e. a true INTER-BYTE gap distribution. A stream that never spoke is
 *   excluded because it has no inter-byte gap to contribute: its only available
 *   number is its whole duration, and pooling that with real gaps would corrupt
 *   the distribution outright (90 healthy streams with 1 s gaps plus 10
 *   pre-content stalls ending at 600 s would put p95 in the 600 s bucket while
 *   no healthy gap ever exceeded 1 s). Such streams are counted by
 *   `..._no_first_byte_total` instead.
 * - `copilot_proxy_detector_max_wait_seconds` — streams while the detector was
 *   ARMED, one sample per phase ENTERED. Detector-off streams and post-terminal
 *   idle contribute nothing, and a phase never entered contributes nothing (not
 *   a zero). It excludes one further population: a read whose wait was
 *   RIGHT-CENSORED by the stall timer winning, counted by
 *   `copilot_proxy_detector_wait_censored_total`.
 * - `copilot_proxy_first_content_seconds` — streams where a CONTENT delta was
 *   observed. `copilot_proxy_stream_no_content_total{reason}` is the population
 *   it excludes, with the reason distinguishing "nothing looked" from "this lane
 *   cannot look" from "nothing came".
 * - `copilot_proxy_upstream_msg_id_total{result}` — the ONE family here with an
 *   UNCENSORED denominator: every stream that reached this forwarder gets
 *   exactly one increment, and the four `result` values partition that
 *   population. That is deliberate — it is the D99(c) join key's own health
 *   signal, so a value that dropped a population would be the defect it exists
 *   to detect. `result="absent"` is CORRECT for a Responses-upstream lane, so
 *   the rejection fraction is only interpretable per (route, model).
 *
 * For streams that DID start, the final gap — last upstream byte to completion
 * — is still folded into the max silence deliberately. On a clean close it is
 * negligible; on a stall it IS the stall, and excluding it would make the metric
 * blind to the exact shape it exists to size.
 *
 * **What the SPAN actually contains — read this before tuning anything against
 * it.** "Silence" here is NOT pure upstream await-time. A chunk is timestamped
 * when it is READ from upstream, and the final gap runs to overall COMPLETION,
 * so each measured interval also contains whatever this process did between the
 * two marks: SSE decode and translation on the translated lane, the downstream
 * `stream.write`, and any client backpressure it blocks on. On a large final
 * chunk or a slow client, an upstream that closed immediately can still show
 * seconds of "silence". A gap is therefore an UPPER BOUND on upstream silence,
 * never a measurement of it in isolation.
 *
 * ⚠ **DO NOT calibrate the stall detector from this distribution, and do not
 * claim the two measure the same span. An earlier version of this docblock
 * did, and it was FALSE — refuted at source by the round-3 cross-family gate.**
 * The detector's window is armed around the `reader.read()` await ONLY: the read
 * loop calls `stallTimer.arm(period)` once per read and races it with
 * `raceReadWithKeepAlive`, which arms nothing itself (M1/D100 moved the arming out
 * of the race and into the caller). The SPAN is what matters to everything below,
 * and it is unchanged, so every divergence still holds.
 *
 * ⚠ **The divergences below are the ones MEASURED SO FAR — this list is NOT
 * known to be complete, and they do NOT all point the same direction.** Every
 * gate round that went looking for another found one (round 3 found 1 and 2,
 * round 4 found 3, round 5 found 4), and each round's fix had asserted the
 * previous list was complete. The enumeration is evidence FOR the prohibition
 * above; it is not a bound on it. Do not restore a "there are exactly N" or
 * "all of them lengthen the metric" framing — both have now been false.
 *
 *   1. **Local work is inside the metric's interval and outside the
 *      detector's.** `noteUpstreamBytes` stamps the chunk BEFORE anything else
 *      happens to it (deliberately — the record should reflect what upstream
 *      produced, not what the client drained). On the verbatim lane that means
 *      before `await stream.write(value)`; on the TRANSLATED lane it is also
 *      before `decodeSseChunk` → `applyEvent` → `encodeSseEvent`, so our own
 *      decode/translate/encode time lands in this metric too. If a write blocks
 *      on client backpressure for 30 s while the next chunk is already queued
 *      upstream, this metric records ~30 s of "silence" while the detector's
 *      next race resolves immediately.
 *   2. **Post-terminal, the detector is not armed AT ALL.** The race is gated
 *      on `!sawTerminal` (W2 F#1 — arming it there would fire a spurious 504
 *      on a hung-but-complete upstream). The final-gap fold has no such gate,
 *      so an upstream that emits its terminal event, idles N seconds, then
 *      closes contributes N seconds here against a zero-length detector window.
 *   3. **The PHASE boundaries differ, so this distribution MIXES all three
 *      detector budgets** (found by the round-4 gate). The detector picks its
 *      window from `peek.contentStarted && !peek.inThinking`, i.e. the tight
 *      `responseWaitMs` applies only after a CONTENT DELTA and outside a
 *      thinking block. This metric's gaps begin at the first non-empty RAW
 *      chunk. So the `message_start` → first-delta window, and every gap inside
 *      a thinking block, are recorded here while the detector is applying the
 *      generous `noResponseWaitMs`. Concretely: `message_start` lands at once,
 *      then 300 s pass before the first delta — post-header first-byte reads ~0, this metric
 *      records ~300 s, and the detector was in its no-response phase
 *      throughout. **A quantile taken from this metric is a mixture over three
 *      budgets and matches none of them.** Note the corollary: the post-header series does not
 *      own that window either, since it ends at the first raw byte — the series
 *      that DOES own it is `copilot_proxy_first_content_seconds`, whose clock
 *      stops where the detector's phase actually flips. Its existence retires
 *      the corollary, not the divergence: this metric still mixes the three
 *      budgets exactly as described.
 *   4. **The FIRST read is raced but contributes NO gap, so here the metric
 *      reads SHORTER than the detector** (found by the round-5 gate; it is why
 *      the "all of them lengthen it" claim above was withdrawn).
 *      `noteUpstreamBytes` stamps the first-byte instant on the first chunk and only begins
 *      accumulating gaps from the second onward — deliberately, since the wait
 *      for a first byte is first-byte latency and not an inter-byte gap — while the read loop
 *      arms the detector around that first `reader.read()` exactly as it does
 *      every later one. An upstream that stays silent for 100 s, emits one
 *      terminal chunk and closes therefore gives a ~100 s detector-active wait
 *      against a near-zero max silence. The pre-content wait is not missing
 *      from the metric surface — it is the first-byte series' — but it is missing from THIS
 *      metric, so the two cannot be compared directly in either direction.
 *
 * **What this metric IS, stated so it is not over-read:** an UPPER BOUND on
 * inter-byte upstream silence for streams that answered, inclusive of local
 * processing, downstream drain and post-terminal idle. That is a genuinely
 * useful triage number — on a healthy localhost stream those terms are
 * sub-millisecond — but it is NOT the quantity the stall windows govern.
 * Deriving a timeout from it yields an over-permissive window, which is D96's
 * own diagnosis (a threshold read off the wrong population) reproduced inside
 * the instrument built to fix it — repeatedly, and the count is deliberately
 * not written here because it has gone stale every time it was (F147).
 *
 * **Phase 2 consequence, now DISCHARGED rather than deferred:** tuning the
 * detector needs detector-active await-time measured at the race site, and a
 * first-CONTENT latency series. Both are emitted from this function as of slice
 * (b), and each is licensed to size exactly one thing:
 *
 *   - `copilot_proxy_detector_max_wait_seconds{phase}` sizes the WINDOWS —
 *     `phase="response"` sizes `responseWaitMs`, `phase="no_response"` sizes
 *     `noResponseWaitMs`. It is a per-stream MAX, so it answers "what must a
 *     window survive", not "what is a typical wait".
 *   - `copilot_proxy_first_content_seconds` sizes the FIRST-CONTENT LATENCY —
 *     how long a stream takes to emit its first content delta of ANY kind.
 *     ⚠ That is NOT the same as "how long the detector is in its generous
 *     phase", and the difference is not a corner case: on an Anthropic
 *     extended-thinking stream the first content delta IS a thinking delta, so
 *     `contentStarted` flips while `inThinking` is true, `detectorPhaseOf`
 *     returns `"thinking"`, and `detectorPeriodFor` hands back the GENEROUS
 *     window — which then reverts to generous again on every later thinking
 *     block. Size `noResponseWaitMs` from this series only on traffic with no
 *     thinking blocks; on thinking traffic use
 *     `detector_max_wait_seconds{phase="no_response"}` and
 *     `{phase="thinking"}`, which measure the budget that was actually applied.
 *
 * `max_silence` is not a detector-window tuning input: its observation span
 * differs from the detector's applied budget. Use the detector-specific series
 * described above rather than assuming these spans are interchangeable.
 *
 * The `model` label is routed through {@link boundedLabelValue} because its
 * value originates as the client-requested model string; `docs/runbook.md`
 * guarantees bounded label cardinality, and the same clamp is applied to every
 * family emitted here so one stream cannot land under two spellings.
 */
function observeStreamHistograms(
  ctx: IncidentContext,
  metricRoute: string,
): void {
  try {
    const now = performance.now();
    const model = ctx.ctxBase.model;
    // Omit an empty model rather than emitting `model=""`, which reads as a
    // real series to a scrape consumer. Built imperatively because a ternary
    // yields a union type the `Record<string, string>` index signature rejects.
    const labels: Record<string, string> = { route: metricRoute };
    if (model !== undefined && model !== "") {
      labels.model = boundedLabelValue("model", model);
    }

    if (ctx.firstByteMs === undefined) {
      // Never answered: no first-byte sample, no inter-byte gap sample, one tick on
      // the counter that keeps the excluded population visible.
      incCounter("copilot_proxy_stream_no_first_byte_total", 1, labels);
    } else {
      observeHistogram(
        "copilot_proxy_upstream_first_byte_seconds",
        (ctx.firstByteMs - ctx.startedMs) / 1000,
        labels,
      );
      // F159 — the same endpoint from the handler-supplied END-TO-END origin.
      // The guard is explicit rather than delegated to `observeHistogram`,
      // which DROPS a non-finite or negative sample silently: a missing or
      // inverted anchor would otherwise censor this histogram invisibly, which
      // is the exact defect class this series was added to stop recurring.
      const anchor = ctx.ctxBase.dispatchStartedMs;
      if (
        anchor === undefined ||
        !Number.isFinite(anchor) ||
        anchor > ctx.firstByteMs
      ) {
        incCounter("copilot_proxy_dispatch_anchor_missing_total", 1, {
          route: metricRoute,
        });
      } else {
        observeHistogram(
          "copilot_proxy_dispatch_first_byte_seconds",
          (ctx.firstByteMs - anchor) / 1000,
          // The SAME `labels` object the line above used, so both series are
          // clamped by the single `boundedLabelValue("model", …)` call: one
          // stream cannot land under two spellings, and no second admission
          // is consumed against the ceiling.
          labels,
        );
      }
      // `lastByteMs` is necessarily set once `firstByteMs` is, but fall back to
      // it rather than to `startedMs` so a future reordering cannot silently
      // reintroduce whole-duration samples into a gap distribution.
      const finalGapMs = now - (ctx.lastByteMs ?? ctx.firstByteMs);
      const maxSilenceMs = Math.max(ctx.maxSilenceMs, finalGapMs);
      observeHistogram(
        "copilot_proxy_stream_max_silence_seconds",
        maxSilenceMs / 1000,
        labels,
      );
    }

    // Slice (b) — the detector's OWN await time, sliced by the budget in force.
    // OUTSIDE the first-byte if/else on purpose: a stream that never answered
    // still spent real time in the detector's no-response phase, and on the
    // never-answered streams the detector did NOT kill — an RST or a client
    // abort mid-wait — that wait is a completed sample and the most relevant one
    // for sizing `noResponseWaitMs`. (A never-answered stream the STALL TIMER
    // killed contributes no sample at all: its wait is censored, below.)
    //
    // Iterating `DETECTOR_PHASES` rather than `Object.entries` keeps the label
    // value TYPED, so a stray key cannot reach the store. `continue` on
    // undefined is what keeps a phase that was never entered out of the
    // distribution — a zero sample there would bias the low end of the very
    // quantile this series exists to establish.
    //
    // ⚠ The CENSORED phase is skipped even when it also holds completed reads,
    // and that asymmetry is the contract. Censoring is applied per READ; the
    // sample is per STREAM×PHASE. So when one phase carries both an uncensored
    // read and the censored one, the max over the uncensored reads is a KNOWN
    // underestimate of that stream's worst wait in that phase (the true worst is
    // `>= window`), and publishing it would be indistinguishable from a complete
    // measurement — dragging the quantile toward zero with exactly the stalling
    // streams the window is being sized against. It would ALSO put the stream in
    // `_count` and in `censored_total` at once, so the documented
    // `count + censored_total` denominator would count it twice. Skipping makes
    // the two families a PARTITION of stream×phase entries: exactly one of them
    // fires per phase entered, never both.
    //
    // `{ ...labels, phase }` and never `labels.phase = …`: `labels` is a plain
    // mutable record already reused by the emissions above, so a mutation here
    // would leak into all of them.
    for (const phase of DETECTOR_PHASES) {
      if (phase === ctx.censoredWaitPhase) continue;
      const ms = ctx.maxDetectorWaitMsByPhase[phase];
      if (ms === undefined) continue;
      observeHistogram("copilot_proxy_detector_max_wait_seconds", ms / 1000, {
        ...labels,
        phase,
      });
    }
    if (ctx.censoredWaitPhase !== undefined) {
      // The stall timer won, so the read's true wait is unknown and merely
      // `>= window`. Counted, never histogrammed — see the family's docblock.
      incCounter("copilot_proxy_detector_wait_censored_total", 1, {
        ...labels,
        phase: ctx.censoredWaitPhase,
      });
    }

    // Slice (b) — the detector's PHASE BOUNDARY, and the population that has
    // none. Also outside the first-byte if/else: `message_start` is a first byte
    // and is not content, so the two questions are independent.
    if (ctx.firstContentMs !== undefined) {
      observeHistogram(
        "copilot_proxy_first_content_seconds",
        (ctx.firstContentMs - ctx.startedMs) / 1000,
        labels,
      );
    } else {
      incCounter("copilot_proxy_stream_no_content_total", 1, {
        ...labels,
        reason: noContentReason(ctx),
      });
    }

    if (ctx.ctxBase.requestBytes !== undefined) {
      observeHistogram(
        "copilot_proxy_request_bytes",
        ctx.ctxBase.requestBytes,
        {
          route: metricRoute,
        },
      );
    }

    // D99(c) — the join-key capture outcome, EXACTLY ONE increment per stream.
    //
    // Emitted here rather than in `emitIncident` on purpose: this helper runs
    // for every stream including successes, while the incident record is
    // failures-only. A counter written inside `emitIncident` would be a
    // function of the failure rate, so a 100 % rejection on a HEALTHY fleet
    // would be invisible — the censored-denominator defect
    // `copilot_proxy_stream_no_first_byte_total` exists to prevent, arriving
    // through the join key this time.
    //
    // `not_observed` rather than `absent` when `peek === undefined`: with stall
    // detection off nothing looked, and reporting "no message_start was seen"
    // about a stream nobody examined is a manufactured fact that would corrupt
    // any fleet-level rejection ratio.
    //
    // `{ ...labels, result }` and never `labels.result = …`, for the reason the
    // loop above states: `labels` is a mutable record shared by every emission
    // in this function. It is REUSED (not rebuilt) so the `model` label rides
    // along — `metricRoute` is "messages" for BOTH the Anthropic-upstream lane
    // and the Responses-upstream Lane 4, so route alone cannot separate an
    // expected `absent` from a 100 % rejection.
    const upstreamIdResult =
      ctx.peek === undefined ? "not_observed" : ctx.peek.upstreamIdStatus;
    incCounter("copilot_proxy_upstream_msg_id_total", 1, {
      ...labels,
      result: upstreamIdResult,
    });
  } catch {
    /* metrics must never be able to break the stream they describe */
  }
}

/**
 * Phase 5 v3.1 Group C — concatenate the captured outbound chunks into a
 * single `Uint8Array`. Pure helper; null-safe (empty array → zero-length
 * Uint8Array). Hoisted outside the closure so both forwarders share the
 * same allocation pattern.
 */
function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Phase 5 v3.1 Group C — assemble + persist the `FlowRecord` for a streaming
 * response. Called from BOTH forwarders' `finally` blocks. Skips silently
 * when `traceWriter` or `traceMeta` is unset (the legacy path).
 *
 * Outcome → status maps via `numericStatusFromOutcome` (sibling of the
 * Prometheus-string `statusFromOutcome` so trace + metrics stay aligned).
 * Inbound body uses `classifyBody` with the request `Content-Type`;
 * outbound (the captured stream chunks) is classified as
 * `text/event-stream` regardless — the caller has already decided this is
 * a stream lane (handlers gate `forwardStream` on upstream content-type).
 *
 * **Phase 6.** Raw inbound + outbound bytes are passed as separate args to
 * `TraceWriter.write` and serialized to .req / .res sidecar files. The
 * manifest carries `body_kind` + `body_path` + `body_bytes` + `body_truncated`
 * + (for SSE) `body_summary` — never the body text itself.
 *
 * `bodyTruncated` is set true iff the per-stream buffer cap was hit AND a real
 * upstream chunk was dropped (F6 — the caller's `droppedAnyBytes` signal, NOT
 * the mere `warnedOverflow` warn-guard; the tiny injected terminal error frame
 * tipping the cap does not count as dropped upstream bytes). When true the .res
 * sidecar ends abruptly at the cap byte boundary and the manifest
 * `body_truncated: true` tells the operator the byte stream is incomplete.
 *
 * Failure handling per F-DISC-3 / F-DISC-14:
 *   - On success: bump `copilot_proxy_trace_writes_total{result="success"}`
 *     and `copilot_proxy_trace_bytes_written_total += manifest + sidecars`.
 *   - On error: bump `copilot_proxy_trace_writes_total{result="error"}`
 *     and `copilot_proxy_trace_errors_total{kind=classify(err)}`. The
 *     first failure per process surfaces via `consola.warn`; later
 *     failures are silent at the log level.
 *
 * Returns `void` — the writer's promise is fired-and-forgotten so trace
 * I/O never blocks the stream-completion `finally` (which has already
 * recorded the Prometheus stream-completion metrics by the time this is
 * invoked).
 */
function emitTraceFlow(
  ctxBase: StreamCtxBase,
  capturedChunks: ReadonlyArray<Uint8Array>,
  outcome: StreamCompletionOutcome,
  upstreamHeaders: Record<string, string>,
  bodyTruncated: boolean,
): void {
  const writer = ctxBase.traceWriter;
  const meta = ctxBase.traceMeta;
  if (writer === undefined || meta === undefined) return;

  // Inbound body classification — `classifyBody` handles empty/null cleanly.
  const inboundBytes = meta.inboundBody ?? new Uint8Array(0);
  const inboundClassified = classifyBody(inboundBytes, meta.inboundContentType);

  // Outbound body classification — we have already filtered to the stream
  // lane in the handler; force the `text/event-stream` content-type so SSE
  // detection fires regardless of upstream's exact Content-Type header value.
  const outboundBytes = concatChunks(capturedChunks);
  const outboundClassified = classifyBody(outboundBytes, "text/event-stream");

  const flow: FlowRecord = {
    captured_at: meta.startedAt / 1000,
    request: {
      method: meta.method,
      url: meta.url,
      host: meta.host,
      path: meta.path,
      headers: meta.inboundHeaders,
      body_kind: inboundClassified.kind,
      // body_path overwritten by TraceWriter.write to the sidecar basename.
      body_path: null,
      body_bytes: inboundBytes.length,
      // Request bodies are always full — handlers stash the FULL inbound
      // body via the body-stash pattern (no cap on inbound side).
      body_truncated: false,
    },
    response: {
      status: numericStatusFromOutcome(outcome),
      reason: reasonFromOutcome(outcome),
      headers: upstreamHeaders,
      body_kind: outboundClassified.kind,
      body_path: null,
      body_bytes: outboundBytes.length,
      body_truncated: bodyTruncated,
      ...(outboundClassified.summary !== undefined
        ? { body_summary: outboundClassified.summary }
        : {}),
    },
  };

  // Pre-compute the bytes-to-disk count so the success metric reflects
  // actual disk usage = manifest + .req + .res sidecars. The manifest is
  // small (metadata only); sidecars dominate for SSE / large JSON payloads.
  const manifestBytes = JSON.stringify(flow).length;
  const approxBytes =
    manifestBytes + inboundBytes.length + outboundBytes.length;

  // Fire-and-forget. Errors are handled in the catch — the trace write
  // never throws into the stream-completion finally (which has already
  // recorded its Prometheus metrics).
  writer
    .write(flow, inboundBytes, outboundBytes)
    .then(() => {
      bumpTraceWrites("success", approxBytes);
    })
    .catch((err: unknown) => {
      bumpTraceWrites("error", undefined, classifyTraceError(err));
      reportFirstFailure(err, meta.requestId);
    });
}

const errFrameEncoder = new TextEncoder();

/**
 * **F3 (remediation)** — hard cap (bytes) on the diagnostic MESSAGE embedded in
 * an injected error frame. An injected frame is ALWAYS captured into the trace
 * buffer (see `captureInjectedFrame`), so a multi-MB upstream cause string would
 * blow straight past the per-stream buffer cap AND bloat the client-facing
 * frame. Capping the MESSAGE (not the frame) keeps the client frame bounded
 * regardless of upstream error size. 8 KiB fits any real cause chain while
 * staying far under the default 4 MB stream buffer.
 */
const MAX_ERROR_MESSAGE_BYTES = 8192;

/**
 * Truncate `msg` so the RETURNED string (kept head + `...[truncated N bytes]`
 * marker) is at most `MAX_ERROR_MESSAGE_BYTES` UTF-8 bytes — the marker length
 * is reserved from the budget, not added on top (M8). The kept head is cut on a
 * UTF-8 codepoint boundary (`stream: true` holds back a trailing partial
 * multibyte sequence rather than splitting it), so the result is always valid
 * UTF-8. The marker states the dropped byte count. Returns `msg` unchanged when
 * already within the cap.
 */
function capDiagnosticMessage(msg: string): string {
  const bytes = errFrameEncoder.encode(msg);
  if (bytes.byteLength <= MAX_ERROR_MESSAGE_BYTES) return msg;
  // M8 — bound the TOTAL returned string (head + marker), not just the head.
  // Reserve the worst-case marker byte length: `bytes.byteLength` is an upper
  // bound on the dropped-byte count (real droppedBytes < total), so its digit
  // count is ≥ the real marker's, guaranteeing head + real marker ≤ MAX.
  const markerReserve = errFrameEncoder.encode(
    `...[truncated ${bytes.byteLength} bytes]`,
  ).byteLength;
  const headBudget = Math.max(0, MAX_ERROR_MESSAGE_BYTES - markerReserve);
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, headBudget), {
    stream: true,
  });
  const droppedBytes =
    bytes.byteLength - errFrameEncoder.encode(head).byteLength;
  return `${head}...[truncated ${droppedBytes} bytes]`;
}

/**
 * **F1** — the client protocol a stream is being forwarded to. Derived from
 * `ctxBase.metricRoute` (the clean Prometheus label wired in `server.ts`
 * from `ROUTE_LABEL_MAP`): `messages` → Anthropic, `responses` → OpenAI
 * Responses, `chat_completions` → OpenAI Chat Completions. A mid-stream error
 * frame must be shaped for the protocol the client actually speaks — an
 * Anthropic `event: error` frame injected into an OpenAI Responses stream is
 * unparseable by the client SDK and looks like a silent truncation.
 */
type ClientProtocol = "anthropic" | "openai_responses" | "openai_chat";

/**
 * Map the clean metric-route label to the client protocol. Unknown labels
 * default to the Anthropic shape (the proxy's primary lane) with a warn so an
 * un-mapped route surfaces in the operator log rather than silently emitting
 * the wrong shape.
 */
function protocolFromMetricRoute(metricRoute: string): ClientProtocol {
  switch (metricRoute) {
    case "messages":
      return "anthropic";
    case "responses":
      return "openai_responses";
    case "chat_completions":
      return "openai_chat";
    default:
      consola.warn(
        `forward-stream: unknown metricRoute "${metricRoute}" for error frame; defaulting to anthropic shape`,
      );
      return "anthropic";
  }
}

/**
 * **H5** — does an outbound SSE line begin the protocol's success-terminal
 * event? Tolerates the optional single space after the field colon. Used by the
 * VERBATIM forwarder (byte scanner) to note that the upstream already delivered
 * a clean terminal, so a later read() error is post-completion noise and the
 * injected error frame is suppressed.
 *
 * | protocol           | terminal marker line        |
 * |--------------------|-----------------------------|
 * | `anthropic`        | `event: message_stop`       |
 * | `openai_responses` | `event: response.completed` |
 * | `openai_chat`      | `data: [DONE]`              |
 */
function isTerminalLine(line: string, protocol: ClientProtocol): boolean {
  switch (protocol) {
    case "anthropic":
      return /^event:\s?message_stop\s*$/.test(line);
    case "openai_responses":
      return /^event:\s?response\.completed\s*$/.test(line);
    case "openai_chat":
      return /^data:\s?\[DONE\]\s*$/.test(line);
  }
}

/**
 * **H5** — is `event` the protocol's success-terminal event object? Used by the
 * TRANSLATED forwarder, which has the decoded/re-encoded event objects in hand
 * before writing. Inspecting the `type` field directly is more robust than
 * re-parsing our own encoded bytes and needs no allocation.
 *
 * `openai_chat` matches the branded `[DONE]` sentinel (F6): the translated chat
 * terminal is the literal `data: [DONE]` line, which `parseEventSegment` now
 * decodes to a branded sentinel event (and `encodeSseEvent` round-trips back to
 * `data: [DONE]`). Recognizing it here sets `sawTerminal` so a post-`[DONE]`
 * reset stays a clean success instead of injecting a false chat error frame.
 * (The verbatim chat path still detects `data: [DONE]` in raw bytes via
 * `isTerminalLine`.)
 */
function isOutboundTerminalEvent(
  event: { type?: unknown },
  protocol: ClientProtocol,
): boolean {
  switch (protocol) {
    case "anthropic":
      return event.type === "message_stop";
    case "openai_responses":
      return event.type === "response.completed";
    case "openai_chat":
      return isChatDoneSentinel(event);
  }
}

/**
 * **F1** — encode a mid-stream error as an SSE frame shaped for `protocol`.
 * Every wire string carries the leading blank-line boundary (`\n\n`) so the
 * frame survives a DANGLING partial upstream event (H1): if the upstream
 * closed mid-event with no terminating `\n\n`, the leading boundary terminates
 * that partial on the wire so the injected frame parses as its OWN SSE event
 * instead of being glued onto the partial's trailing `data:` line. Harmless
 * when the prior event was already terminated (an extra blank line between SSE
 * events is ignored per spec).
 *
 * Shapes:
 *   - `openai_responses`: `event: response.failed` + a `response` object with
 *     `status: "failed"` and `error: { code, message }` (grounded in
 *     `src/types/openai-responses.ts` `ResponsesFailedEvent` /
 *     `ResponsesResponse.error`).
 *   - `openai_chat`: a bare `data: { error: { message, type, code, param } }`
 *     frame (NO `event:` line) — the OpenAI Chat Completions streaming error
 *     convention.
 *   - `anthropic` (default): `event: error` + `{ type: "error", error: {
 *     type: "api_error", message } }` — a known Anthropic error type so the
 *     Claude Code SDK surfaces it (the real cause rides in `message`).
 */
function encodeErrorFrame(
  protocol: ClientProtocol,
  err: unknown,
  model: string | undefined,
  outcome: StreamCompletionOutcome,
): Uint8Array {
  // F3 — bound the embedded diagnostic message so a giant upstream cause string
  // can neither defeat the per-stream trace buffer cap nor bloat the client frame.
  const msg = capDiagnosticMessage(formatErrorChain(err));
  // F4 — the client-facing error `code` reflects the classified outcome: a
  // proxy-INTERNAL failure (a transform/encode threw) is `internal_error` (500),
  // while an upstream socket reset / truncation keeps the gateway `upstream_error`
  // (502). The Anthropic shape has no distinct internal code — `api_error` is its
  // umbrella server-error type for both 500 and 502 — so it stays `api_error`.
  const isInternal = outcome === "internal_error";
  let wire: string;
  switch (protocol) {
    case "openai_responses": {
      const payload = JSON.stringify({
        type: "response.failed",
        response: {
          id: "resp_proxy_error",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "failed",
          model: model ?? "unknown",
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          error: {
            code: isInternal ? "internal_error" : "upstream_error",
            message: msg,
          },
        },
      });
      wire = `\n\nevent: response.failed\ndata: ${payload}\n\n`;
      break;
    }
    case "openai_chat": {
      const payload = JSON.stringify({
        error: {
          message: msg,
          type: "api_error",
          code: isInternal ? "internal_error" : null,
          param: null,
        },
      });
      wire = `\n\ndata: ${payload}\n\n`;
      break;
    }
    default: {
      const payload = JSON.stringify({
        type: "error",
        error: { type: "api_error", message: msg },
      });
      wire = `\n\nevent: error\ndata: ${payload}\n\n`;
      break;
    }
  }
  return errFrameEncoder.encode(wire);
}

/** Write a protocol-shaped mid-stream error SSE frame to the client. Best-
 *  effort: the client socket may already be gone (swallow write errors).
 *
 *  **F1** — the frame shape follows `protocol` (see `encodeErrorFrame`); the
 *  leading `\n\n` boundary in every wire string preserves the H1 dangling-
 *  partial guarantee.
 *
 *  **M4** — returns the exact bytes written (or `null` if the client socket was
 *  already gone) so callers can fold the injected frame into trace capture +
 *  the response-bytes / stream-events metric counters. */
async function writeUpstreamErrorFrame(
  stream: SSEStreamingApi,
  err: unknown,
  protocol: ClientProtocol,
  model: string | undefined,
  outcome: StreamCompletionOutcome,
): Promise<Uint8Array | null> {
  try {
    // F1 (remediation) — encode INSIDE the protective try so a frame-encode
    // failure (defense-in-depth: `formatErrorChain` is now total) cannot escape
    // the writer and crash the stream callback with no terminal frame emitted.
    const bytes = encodeErrorFrame(protocol, err, model, outcome);
    // M7 — Hono suppresses `stream.write` errors on an aborted stream, so a
    // write to a torn-down client resolves cleanly and the frame would be
    // wrongly counted as delivered. Report not-delivered (`null`) when the
    // stream is already aborted OR becomes aborted during the write, so trace +
    // metrics reflect that nothing actually reached the client.
    if (stream.aborted) return null; // client provably gone — not delivered
    await stream.write(bytes);
    if (stream.aborted) return null; // torn down during the write
    return bytes;
  } catch {
    /* client already gone OR frame encode failed — nothing to surface to */
    return null;
  }
}

/**
 * F165 — the keep-alive comment, encoded ONCE at module scope rather than per
 * fire. 13 bytes.
 *
 * ⚠ **The literal carries NO counter, and the form with measured survival
 * behind it DID.** Phase 3's Arm B stub wrote `` `: keepalive ${++kaCount}\n\n` ``
 * and held a stream open for 240,006 ms; this ships the bare form because a
 * per-stream counter is mutable state that makes a captured flow
 * non-deterministic exactly when captured flows are wanted as primary test
 * vectors (F166). The difference cannot matter to the thing being defeated —
 * the client's watchdog is BYTE-idle (`stream idle: no bytes for 180000ms`) and
 * a `:`-leading line is a comment every conformant SSE parser discards — but
 * that is an INFERENCE, so re-running Arm B against the proxy emitting THIS
 * literal is a condition on the ship gate, not a footnote.
 */
const KEEPALIVE_BYTES = errFrameEncoder.encode(": keepalive\n\n");

/**
 * Write one keep-alive comment. Returns whether it actually REACHED the client.
 *
 * The double `stream.aborted` check is structural, copied from
 * {@link writeUpstreamErrorFrame}: Hono suppresses write errors on an aborted
 * stream, so a single check reports a dead client as delivered.
 *
 * **Returning a boolean rather than the bytes is deliberate.** It makes it
 * TYPE-IMPOSSIBLE to hand the result to `captureInjectedFrame`, which would fold
 * proxy-injected comments into `copilot_proxy_stream_events_total` and the trace
 * sidecar — inflating both in proportion to how badly a stream is stalling, and
 * degrading the sidecar as a replay fixture.
 */
async function writeKeepAliveComment(
  stream: SSEStreamingApi,
): Promise<boolean> {
  try {
    if (stream.aborted) return false; // client provably gone — not delivered
    await stream.write(KEEPALIVE_BYTES);
    if (stream.aborted) return false; // torn down during the write
    return true;
  } catch {
    /* client already gone — a keep-alive has nothing to surface to */
    return false;
  }
}

/**
 * The per-stream label set for `copilot_proxy_stream_keepalives_total`, built
 * ONCE per stream and only when the keep-alive is on.
 *
 * `model` is routed through `boundedLabelValue` like every other model-labelled
 * family, and an EMPTY model is omitted rather than emitted as `model=""`, which
 * reads as a real series to a scrape consumer. Building it once also keeps the
 * `boundedLabelValue` Set lookup out of the fire path — and, because the call
 * consumes an admission against the label-cardinality ceiling, keeps it from
 * being consumed at all on the streams where the feature is off.
 */
function keepAliveLabelsFor(ctxBase: StreamCtxBase): Record<string, string> {
  const labels: Record<string, string> = { route: ctxBase.metricRoute };
  const model = ctxBase.model;
  if (model !== undefined && model !== "") {
    labels.model = boundedLabelValue("model", model);
  }
  return labels;
}

/**
 * Per-stream keep-alive state: the validated config, its OWN timer instance, and
 * its label set. Built together so the three cannot be half-present, and so the
 * race block narrows `undefined` exactly once.
 */
interface KeepAliveState {
  cfg: KeepAliveConfig;
  timer: StallTimer;
  labels: Record<string, string>;
}

/**
 * Build the per-stream keep-alive state, or `undefined` when the feature is off.
 *
 * ⚠ **`cfg.makeTimer()` mints a SEPARATE `StallTimer` INSTANCE from the stall
 * detector's.** `makeStallTimer` closes over ONE handle and `arm()` begins by
 * clearing it, so sharing the detector's instance would make the first
 * keep-alive arm CANCEL the stall deadline — an unbounded liveness lie (D96)
 * reachable by a one-line "reuse the timer we already have".
 */
function makeKeepAliveState(
  ctxBase: StreamCtxBase,
): KeepAliveState | undefined {
  const cfg = ctxBase.keepAlive;
  if (cfg === undefined) return undefined;
  return { cfg, timer: cfg.makeTimer(), labels: keepAliveLabelsFor(ctxBase) };
}

/**
 * **F2 (remediation)** — brand marking a throw that originated in the
 * transform/encode phase (`applyEvent` → `encodeSseEvent`) rather than the
 * upstream READ phase. Such a failure is proxy-INTERNAL (HTTP 500), not a bad
 * gateway (502): the upstream delivered fine; our own transform/encoder threw
 * (e.g. a rule emits a circular-ref event → `encodeSseEvent`'s `JSON.stringify`
 * throws a `TypeError`, whose `.name` is NOT in `INTERNAL_ERROR_NAMES`). The
 * translated forwarder's catch checks this brand alongside `INTERNAL_ERROR_NAMES`.
 */
const TRANSFORM_PHASE_BRAND = Symbol("copilot-proxy.transformPhaseError");

/** Brand `err` as a transform/encode-phase failure (best-effort — a frozen or
 *  primitive throw value is left unbranded and falls back to name-based
 *  classification). Returns `err` for `throw markTransformPhase(err)`. */
function markTransformPhase(err: unknown): unknown {
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    try {
      Object.defineProperty(err, TRANSFORM_PHASE_BRAND, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      /* frozen / sealed / exotic — name-based classification still applies */
    }
  }
  return err;
}

/** True iff `err` was branded by `markTransformPhase` (a transform/encode-phase
 *  failure → internal_error).
 *
 *  **F2 (remediation)** — TOTAL. The branded-symbol read is a reflective
 *  property access that a hostile `Proxy` with a throwing `get` trap makes
 *  throw. This is called INSIDE the terminal catch (outcome classification), so
 *  an unguarded throw here would escape the catch → no SSE error frame written =
 *  the silent truncation the error path exists to prevent. Guard it: an
 *  unbrandable / hostile value is simply "not a transform-phase error". */
function isTransformPhaseError(err: unknown): boolean {
  try {
    return (
      err !== null &&
      (typeof err === "object" || typeof err === "function") &&
      (err as Record<PropertyKey, unknown>)[TRANSFORM_PHASE_BRAND] === true
    );
  } catch {
    return false;
  }
}

/**
 * **F2 (remediation)** — read an error's `.name` WITHOUT ever throwing. `?.`
 * guards null/undefined only, NOT a hostile `get name()` getter (or a `Proxy`
 * `get` trap). Called inside the terminal catch, so an unguarded reflective read
 * that throws would escape the catch → no SSE error frame written. Returns `""`
 * for a missing / non-string / throwing name.
 */
function safeErrorName(err: unknown): string {
  try {
    const n = (err as { name?: unknown } | null | undefined)?.name;
    return typeof n === "string" ? n : "";
  } catch {
    return "";
  }
}

/**
 * **F3 (remediation)** — is `err` an abort-shaped throw (its `.name` is
 * "AbortError")? Read via the total `safeErrorName` guard. The terminal catch
 * uses this to tell a genuine client-teardown throw (the composed upstream
 * signal aborted the fetch → AbortError) apart from a real upstream/transform
 * failure that merely COINCIDES with a client abort flag. `reader.cancel()`
 * (fired by onAbort) resolves `read()` with done:true (handled in the
 * done-branch), so a throw reaching the catch is a real failure UNLESS it is
 * itself abort-shaped — the case that must stay a clean 499.
 */
function isAbortError(err: unknown): boolean {
  return safeErrorName(err) === "AbortError";
}

/**
 * Build a streamSSE callback that forwards upstream bytes verbatim to the
 * client. Caller passes the result to `streamSSE(c, ...)`:
 *
 *   return streamSSE(c, forwardStream(c, upstream, { route, model }));
 *
 * - Registers an abort listener on `clientSignal` that calls
 *   `reader.cancel()` synchronously, kicking the reader out of any
 *   suspended `read()` and freeing the upstream connection immediately.
 * - Releases the reader's lock in `finally` so the upstream `ReadableStream`
 *   is drained/cancelled cleanly even on error.
 * - Forwards `Uint8Array` chunks directly to `stream.write` — preserves
 *   D-LOCK-7 verbatim contract, avoids UTF-8 codepoint truncation at
 *   chunk boundaries, supports binary SSE data fields.
 *
 * **M12 metrics (Group A § 4).** Per-chunk byte length is added to
 * `copilot_proxy_response_bytes_total{route}`; SSE event boundaries
 * (detected via `\n\n` separator scan) are counted into
 * `copilot_proxy_stream_events_total{route}`. The route label comes from
 * `ctxBase.metricRoute` (the clean canonical Prometheus label like
 * `messages` — NOT `ctxBase.route` which is the inbound HTTP path
 * consumed by stream-event predicates). M12.5 H1 split this into two
 * distinct fields so cross-metric joins on `route` work in Prometheus.
 */
export function forwardStream(
  c: Context,
  upstream: Response,
  ctxBase: StreamCtxBase,
): (stream: SSEStreamingApi) => Promise<void> {
  const clientSignal = deriveUpstreamSignal(c);
  // Phase 5 v3.1 Group C — capture upstream response headers up-front; the
  // upstream Response is consumed by `getReader()` below + we want the
  // headers verbatim in the trace `response.headers` field. Pulled into
  // the closure-builder scope (NOT the per-stream callback) so it is fixed
  // at the moment forwardStream is built.
  const upstreamHeadersForTrace: Record<string, string> = {};
  if (ctxBase.traceWriter !== undefined && ctxBase.traceMeta !== undefined) {
    upstream.headers.forEach((v, k) => {
      upstreamHeadersForTrace[k] = v;
    });
  }
  return async (stream): Promise<void> => {
    // M12.6 H1-NEW — outer try/finally guarantees `recordStreamCompletion`
    // fires even when `upstream.body === null` (the early-return path).
    // Before this fix the null-body return ran BEFORE any finally block, so
    // the inflight gauge — incremented by withMetrics on entry and deferred
    // for stream Content-Type per M12.5 H2 — never decremented, leaking
    // permanently for null-body SSE responses (the exact defect class
    // M12.5 was meant to fix).
    //
    // M12.6 M1-NEW — `outcome` lifted to the closure so the inner catch
    // block (which sees the abort/error signal) can inform the outer
    // finally that records the metric. Default "success" covers the
    // null-body and clean-drain paths.
    let outcome: StreamCompletionOutcome = "success";
    // F1 — client protocol for any mid-stream error frame (shape depends on
    // the route the client speaks). Fixed for the stream's lifetime.
    const protocol = protocolFromMetricRoute(ctxBase.metricRoute);
    // W2 — content-phase stall detector wiring (additive; every use below is a
    // no-op when `ctxBase.stall` is unset). `stallTimer` + `peek` are created
    // once per stream: the timer is armed/cancelled per read; `peek` tracks the
    // content phase (Case-1 pre-content → Case-2 post-content) + Anthropic
    // thinking blocks so the tight window is suspended during a redacted think.
    const stall = ctxBase.stall;
    const stallTimer = stall !== undefined ? stall.makeTimer() : undefined;
    const peek = stall !== undefined ? newPeekState() : undefined;
    // F165 — the keep-alive, created once per stream alongside the detector it
    // sits inside. `undefined` when the feature is off, which is the shipped
    // default; every use below is then a no-op.
    const keepAlive = makeKeepAliveState(ctxBase);
    // D96 Phase 1 — incident-log accounting, tracked UNCONDITIONALLY.
    // `bytesActuallyReceived` further down CANNOT serve this: it is incremented
    // only inside `if (traceEnabled)`, i.e. only at `logging.level >= raw`, and
    // the entire point of the incident log is to survive at the level the fleet
    // actually runs (F138). `performance.now()` is monotonic, so these durations
    // are immune to a wall-clock adjustment landing mid-stream.
    const incidentStartedMs = performance.now();
    const incidentInflightAtStart = getValueForTests(
      "copilot_proxy_inflight_requests",
      { route: ctxBase.metricRoute },
    );
    let incidentFirstByteMs: number | undefined;
    let incidentBytes = 0;
    // D96 Phase 1 — running max byte-silent gap WITHIN the stream, plus the
    // instant of the most recent chunk. A running max costs one comparison per
    // chunk; observing every gap into a histogram would cost thousands of
    // writes per stream to answer a question about a single number.
    let incidentLastByteMs: number | undefined;
    let incidentMaxSilenceMs = 0;
    /**
     * Slice (b) — per-stream MAX detector-active wait, KEYED BY PHASE. This is
     * the quantity no other emitted series can
     * provide: `max_silence` mixes all three detector budgets, and the first-byte
     * series end at the first RAW byte while the detector's phase flips on the
     * first CONTENT delta.
     *
     * ⚠ **Sparse, and the sparseness is the design.** A key exists IFF that
     * phase was entered. M1 shipped this as a single scalar
     * (`let incidentMaxDetectorWaitMs = 0`), and consuming that unchanged would
     * have published ONE number per stream mixing all three budgets — i.e.
     * `max_silence` divergence #3 reproduced inside the instrument built to
     * replace it, and a scalar additionally cannot distinguish never-armed from
     * armed-and-zero. Do NOT collapse it back, and do NOT pre-seed the phases
     * with zeros: a zero for a phase the stream never reached biases the low end
     * of the very quantile the series exists to establish.
     *
     * Read by `observeStreamHistograms` into
     * `copilot_proxy_detector_max_wait_seconds{phase}`, and by `emitIncident`
     * into the record's `maxDetectorWaitMs` / `maxDetectorWaitPhase` join.
     */
    const incidentMaxDetectorWaitByPhase: Partial<
      Record<DetectorPhase, number>
    > = {};
    const noteDetectorWait = (ms: number, phase: DetectorPhase): void => {
      const prior = incidentMaxDetectorWaitByPhase[phase];
      if (prior === undefined || ms > prior) {
        incidentMaxDetectorWaitByPhase[phase] = ms;
      }
    };
    /**
     * The phase whose wait was RIGHT-CENSORED by the stall timer winning the
     * race, if any. At most one per stream — the stall arm writes the error
     * frame and returns.
     *
     * The censoring is not incidental: `stallTimer.arm(period)` is taken one
     * statement before `waitStart`, so on a stall the `finally` measures ≈the
     * whole window while the read itself is orphaned (`void readP.catch()`) and
     * its TRUE wait is unknowable — only `>= period`. Recording that as if it
     * were a completed wait makes an operator's p99 read back the configured
     * window and call it saturated demand.
     */
    let incidentCensoredWaitPhase: DetectorPhase | undefined;
    /**
     * Elapsed ms measured on that censored read. ≈`period`, and recorded as a
     * LOWER BOUND rather than a value: it is what lets the incident RECORD say
     * "this 504 was preceded by a wait of at least N ms in phase P" instead of
     * omitting the wait that actually killed the stream. The metric surface
     * still never sees it.
     */
    let incidentCensoredWaitMs: number | undefined;
    /**
     * `performance.now()` at the instant `peek.contentStarted` first flips —
     * the instant the detector LEAVES its `no_response` phase, stamped where the
     * peek is updated, because that is the value the detector's NEXT read reads.
     *
     * ⚠ **Leaving `no_response` is not the same as entering `response`.** On an
     * Anthropic thinking stream the first content delta is a THINKING delta, so
     * the next phase is `"thinking"` — which takes the same GENEROUS window.
     * This stamp is therefore the first-content latency, not the instant the
     * tight budget begins to apply; see `observeStreamHistograms`' docblock.
     *
     * Idempotent and clock-cheap, so it can be called unconditionally at the
     * peek site. Stamping it at the first byte instead would make the series an alias of
     * `copilot_proxy_upstream_first_byte_seconds` and destroy its entire reason
     * to exist.
     */
    let incidentFirstContentMs: number | undefined;
    const noteContentPhase = (): void => {
      if (
        peek !== undefined &&
        peek.contentStarted &&
        incidentFirstContentMs === undefined
      ) {
        incidentFirstContentMs = performance.now();
      }
    };
    /**
     * Whether this lane's smart-peek can observe content AT ALL. Fixed for the
     * stream's lifetime; see `peekObservesContent` for the two independent
     * reasons the translated `openai_chat` lane cannot.
     */
    const contentObservable = peekObservesContent("verbatim", protocol);
    /**
     * Note upstream bytes arriving from the reader; called once per non-empty
     * chunk. The first-byte instant is stamped exactly once, and ONLY from a
     * real upstream chunk — never from an empty one and never from an injected
     * error frame, which is our byte rather than the upstream's. An ABSENT
     * `ttfbMs` is the discriminator between "the upstream never spoke" and "the
     * stream started and then broke", so a false stamp would erase the one
     * distinction the record exists to preserve.
     *
     * The gap from stream start to the FIRST byte is first-byte latency, not silence, so the
     * silence max only starts accumulating from the second chunk onward.
     */
    const noteUpstreamBytes = (n: number): void => {
      if (n <= 0) return;
      const now = performance.now();
      if (incidentFirstByteMs === undefined) {
        incidentFirstByteMs = now;
      } else if (incidentLastByteMs !== undefined) {
        const gap = now - incidentLastByteMs;
        if (gap > incidentMaxSilenceMs) incidentMaxSilenceMs = gap;
      }
      incidentLastByteMs = now;
      incidentBytes += n;
    };
    // Phase 5 v3.1 Group C — outbound-byte capture for trace. Allocated
    // unconditionally so the per-chunk push site stays branch-free; when
    // `traceWriter`/`traceMeta` are unset, the buffer is built but never
    // serialized (`emitTraceFlow` no-ops without the writer). Cost: one
    // empty array allocation per stream — negligible vs the upstream
    // socket cost.
    const traceEnabled =
      ctxBase.traceWriter !== undefined && ctxBase.traceMeta !== undefined;
    const capMb = ctxBase.streamBufferMb ?? STREAM_BUFFER_MB_DEFAULT;
    const capBytes = capMb * 1024 * 1024;
    const buffer: Uint8Array[] = [];
    let bytesAccumulated = 0;
    let bytesActuallyReceived = 0;
    let warnedOverflow = false;
    // F6 — body_truncated must reflect only DROPPED upstream bytes. Track real-
    // chunk drops here, separately from `warnedOverflow` (which stays solely the
    // one-shot dedup guard for the consola.warn). The injected terminal error
    // frame tipping the cap must NOT set this — no upstream bytes were lost.
    let droppedAnyBytes = false;
    // M4 — fold an injected error frame's bytes into trace capture + the
    // response-bytes / stream-events metric counters (mirrors the per-chunk
    // accounting). Local closure so it captures THIS forwarder's own mutable
    // buffer state; `null` (client socket already gone) is a no-op.
    const captureInjectedFrame = (frameBytes: Uint8Array | null): void => {
      if (frameBytes === null) return;
      if (traceEnabled) {
        bytesActuallyReceived += frameBytes.byteLength;
        buffer.push(frameBytes); // always capture the terminal diagnostic frame
        bytesAccumulated += frameBytes.byteLength;
      }
      incCounter("copilot_proxy_response_bytes_total", frameBytes.byteLength, {
        route: ctxBase.metricRoute,
      });
      incCounter("copilot_proxy_stream_events_total", 1, {
        route: ctxBase.metricRoute,
      });
    };
    try {
      if (upstream.body === null) return;
      const reader = upstream.body.getReader();
      // Synchronous abort listener: when the client disconnects, cancel the
      // reader so any suspended `reader.read()` resolves promptly. Without
      // this, the upstream connection would be held until GC. Registered
      // INSIDE the outer try (after the null-body check) — for null body
      // there is no reader to abort, no listener to add.
      const onAbort = (): void => {
        // M12.7 — record abort intent BEFORE cancel so the production
        // path (Hono signal -> onAbort -> reader.cancel() -> next read
        // resolves done:true -> normal `if (done) return` -> outer finally)
        // records status="499". The catch-block detection below only fires
        // when the read loop throws; cancel() resolves cleanly so it does
        // NOT throw — without setting outcome here, real client aborts
        // would record status="200" (default outcome).
        //
        // F3 (H2) — outcome is MONOTONIC for proven failures: a client abort
        // that races in AFTER a proven upstream/internal/stall failure was
        // classified (e.g. while `writeUpstreamErrorFrame` is awaited — W2 sets
        // `upstream_stall` right before that await) must NOT downgrade that
        // 502/500/504 to a 499. Only promote to client_abort when no failure
        // has been established yet. (The intentional post-terminal
        // `outcome = "success"` downgrade lives in the catch, is a direct
        // assignment, and is untouched by this guard.)
        if (
          outcome !== "upstream_error" &&
          outcome !== "internal_error" &&
          outcome !== "upstream_stall"
        ) {
          outcome = "client_abort";
        }
        // `cancel()` returns a Promise; we don't await it (the read loop will
        // see the cancellation on its next tick) and we swallow rejections
        // ("already closed", "stream is locked", etc.) to avoid unhandled
        // rejections during teardown.
        void reader.cancel().catch(() => {
          /* already closed / cancelled */
        });
      };
      clientSignal.addEventListener("abort", onAbort);
      // M12.8 HIGH-1 — WHATWG AbortSignal does NOT replay past aborts to late
      // listeners. If signal already aborted at listener-registration time,
      // onAbort never fires; the loop would park at await reader.read()
      // indefinitely (stalled upstream + no further chunks). Fire onAbort
      // synchronously to set outcome="client_abort" + cancel the reader so
      // the next read() resolves done:true. Idempotent: outcome reassignment
      // is harmless and reader.cancel() swallows already-closed errors, so a
      // subsequent abort-event firing the same listener is safe.
      if (clientSignal.aborted) {
        onAbort();
      }
      // M12 — partial-event boundary tracker. Count `\n\n` occurrences across
      // chunk boundaries: keep the trailing 1 byte if the prior chunk ended
      // with `\n` so a `\n` at the start of the next chunk completes the
      // boundary. Cheap O(chunkLength) scan; no decode required.
      //
      // M12.5 M2 — empty-chunk handling: if the upstream emits a zero-byte
      // chunk between a `\n`-ending chunk and a `\n`-leading chunk, the
      // bridge `\n\n` boundary MUST still be counted. The pre-M12.5 code
      // unconditionally reset `boundaryTail` based on the latest chunk's
      // last byte — for an empty chunk that resolves to `0` (no last byte
      // exists; `value[-1]` is `undefined` so the comparison is false),
      // erasing the prior chunk's trailing-newline state. The fix: skip
      // the loop body entirely for empty chunks (no bytes to forward, no
      // metric to increment, no `boundaryTail` mutation — the prior
      // chunk's state is preserved untouched).
      let boundaryTail = 0; // 0 = no trailing newline; 1 = chunk ended with single '\n'
      // F3 — SSE-correct truncation detection via an O(1) byte state machine
      // (no TextDecoder, constant space). Tracks, across chunk boundaries,
      // whether the bytes since the last event boundary (blank line) began a
      // REAL field line — i.e. the upstream closed mid-event. Replaces the
      // round-1/F2 per-chunk decode-into-string + `.split(EVENT_BOUNDARY_RE)`,
      // which decoded on the zero-decode verbatim fast path and was O(n) space
      // with a repeated split per chunk. The machine natively handles bare `\r`,
      // lone `\n`, and `\r\n` line endings, so it needs no boundary regex.
      //
      //   curLineKind — 0 = at line start (nothing seen on the current line
      //     yet), 1 = comment line (first byte was ':'), 2 = real field line
      //     (first non-whitespace byte was anything but ':'), 3 = whitespace-only
      //     line so far (every byte seen has been a space/tab — F5).
      //   sinceBoundaryHasReal — has a real field line been seen since the last
      //     blank-line boundary? A blank line resets it to false; a real line
      //     sets it true; a comment OR whitespace-only line leaves it unchanged.
      //   prevWasCR — the previous byte was a lone CR, so a following LF is the
      //     back half of a `\r\n` pair and must NOT be counted as a second line
      //     ending.
      //   bomIndex — F6: how many bytes of a leading UTF-8 BOM (EF BB BF) have
      //     matched at the very START of the stream. A BOM byte is skipped from
      //     line classification (it is NOT a real field) but is still forwarded
      //     verbatim (the scan is read-only). Reaches 3 once the BOM is consumed
      //     OR abandoned on the first non-matching byte; thereafter the scan runs
      //     normally. Persisted across chunks so a BOM split [EF]|[BB]|[BF] works.
      let sinceBoundaryHasReal = false;
      let curLineKind = 0;
      let prevWasCR = false;
      let bomIndex = 0;
      /**
       * F165 — is the wire at an SSE EVENT BOUNDARY right now, i.e. can a
       * keep-alive comment be spliced in without landing inside a half-written
       * event? Derived from the EXISTING F3/F5/F6 scanner state rather than a
       * new tracked variable, so it cannot drift from what the scanner believes.
       *
       * The four conjuncts, each load-bearing:
       *   - `bomIndex === 3` — BOM resolution is settled. It does two jobs: it
       *     blocks a splice into a PARTIALLY-matched BOM, and (because it is 0
       *     until the first byte is scanned) it blocks emitting BEFORE the
       *     upstream's leading BOM, which would move U+FEFF off byte 0 — the
       *     client would then read it as line content while this scanner, which
       *     sees only upstream bytes, still counted it as a BOM.
       *   - `curLineKind === 0` — no bytes of a new line have been seen yet.
       *   - `!prevWasCR` — not sitting between the halves of a `\r\n` pair.
       *   - `!sinceBoundaryHasReal` — no real field line is open since the last
       *     blank-line boundary, i.e. we are not mid-EVENT across lines.
       *
       * The D47 mirror on the translated lane is a maintained FLAG rather than a
       * derivation — that lane has no byte scanner — but the predicate is called
       * identically at both seams so the two race blocks stay byte-identical.
       */
      const atSseBoundary = (): boolean =>
        bomIndex === 3 &&
        curLineKind === 0 &&
        !prevWasCR &&
        !sinceBoundaryHasReal;
      // H5 — success-terminal tracking. F5 (remediation): a terminal is only
      // "delivered" once its COMPLETE event (through the blank-line boundary)
      // has been forwarded. `pendingTerminal` records that the terminal MARKER
      // line (message_stop / response.completed / [DONE]) was seen; `sawTerminal`
      // is promoted from it only when the event's boundary is processed. The
      // catch then treats a later read() error as post-completion noise ONLY for
      // a fully-delivered terminal — an incomplete terminal (marker but no
      // boundary) followed by a read error stays a real upstream_error.
      // `linePrefix` accumulates the current line's leading bytes (bounded to
      // 40 — markers are short ASCII) so `endOfLine` can test the completed
      // line. All three persist across chunk boundaries (a marker line can be
      // split across chunks).
      let sawTerminal = false;
      let pendingTerminal = false;
      let linePrefix = "";
      // W2 smart-peek — a SEPARATE bounded line buffer (independent of the
      // 40-char `linePrefix` used for terminal detection). Only accumulated when
      // stall detection is on; classified + reset in `endOfLine`. Captures more
      // of each line (STALL_PEEK_CAP) so the Anthropic thinking-block type / Chat
      // `"content"` field — which sit past byte 40 — are visible.
      let peekLine = "";
      const endOfLine = (): void => {
        // F5 (H5) — note the terminal MARKER line here (BEFORE resetting the
        // accumulator), but do NOT commit `sawTerminal` yet: commit happens at
        // the blank-line boundary below, once the full terminal event's bytes
        // are forwarded.
        if (
          !sawTerminal &&
          !pendingTerminal &&
          isTerminalLine(linePrefix, protocol)
        ) {
          pendingTerminal = true;
        }
        // W2 smart-peek — classify the just-completed line for the content-phase
        // + Anthropic thinking transitions, then reset the peek buffer. No-op
        // when stall detection is off (`peek` undefined).
        if (peek !== undefined) {
          peekVerbatimLine(peekLine, protocol, peek);
          // D99(c) — this call ALSO carries the join-key capture; the verbatim
          // lane's entire share of that slice lives inside `peekVerbatimLine`,
          // with NO code change here. The D47 mirror is structural, not
          // textual: this lane sees raw client-shaped bytes (on Lane 1 the
          // client shape IS the upstream shape), the translated lane sees
          // decoded upstream objects, and both feed the UPSTREAM view into the
          // one `captureUpstreamMessageId` guard. Recorded so the asymmetry
          // reads as deliberate rather than as a half-applied edit.
          //
          // Slice (b) — stamp the first-CONTENT instant HERE, where the peek is
          // updated, because this is the value the detector's NEXT read reads
          // when it selects its window. ⚠ On THIS lane `endOfLine` runs during
          // the byte scan AFTER `await stream.write(value)`, so the sample
          // includes the downstream write of the chunk that carried the first
          // delta — the translated lane peeks BEFORE its write and does not.
          noteContentPhase();
          peekLine = "";
        }
        linePrefix = "";
        if (curLineKind === 0) {
          sinceBoundaryHasReal = false; // blank line = event boundary
          // F5 (H5) — the boundary completes the event: if a terminal marker was
          // seen earlier in THIS event, the terminal is now fully delivered →
          // commit sawTerminal (a POST-terminal socket RST then resolves to
          // success, as before).
          if (pendingTerminal) sawTerminal = true;
        } else if (curLineKind === 2) sinceBoundaryHasReal = true; // real field line seen
        // curLineKind === 1 (comment) or 3 (whitespace-only, F5) leaves
        // sinceBoundaryHasReal untouched — neither is a real field line.
        curLineKind = 0;
      };
      try {
        while (true) {
          if (stream.aborted) {
            // M12.7 — downstream tear-down race: streamSSE marks
            // `stream.aborted=true` when the writer is torn down (client
            // closed downstream socket).
            //
            // H2/P2 — before recording client_abort, evaluate the SAME
            // truncation signal the done-branch uses: a real field line still
            // open since the last boundary (`sinceBoundaryHasReal` /
            // `curLineKind === 2`), OR an incomplete leading BOM at EOF
            // (`bomIndex` 1..2, H6). If truncated, the client tore down
            // mid-event on a stalled/broken upstream, so reclassify to
            // upstream_error for correct metrics/trace, mirroring the
            // done-branch. No frame is written — stream.aborted means the client
            // socket is provably gone (nothing to deliver to); log + reclassify
            // only.
            const truncated =
              sinceBoundaryHasReal ||
              curLineKind === 2 ||
              (bomIndex > 0 && bomIndex < 3);
            if (
              truncated &&
              (outcome === "success" || outcome === "client_abort")
            ) {
              outcome = "upstream_error";
              consola.error(
                `stream ${requestIdLabel(ctxBase)}: upstream truncated before final boundary (client already gone; classifying upstream_error)`,
              );
            } else {
              outcome = "client_abort";
            }
            // M12.8 HIGH-2 — releaseLock alone (in the outer finally) does
            // NOT cancel the underlying ReadableStream / abort the upstream
            // fetch body. Without an explicit cancel, the upstream
            // connection stays live until GC. Mirror the onAbort listener's
            // cancel-and-swallow pattern so teardown is immediate.
            void reader.cancel().catch(() => {
              /* already closed / cancelled */
            });
            return;
          }
          let readResult: Awaited<ReturnType<typeof reader.read>>;
          if (
            stall !== undefined &&
            stallTimer !== undefined &&
            peek !== undefined &&
            !sawTerminal // W2 F#1 — response already complete; do not arm a post-terminal
            //             stall timer (would fire a spurious 504 on a hung-but-complete
            //             upstream). Fall through to the plain read → baseline
            //             sawTerminal→success handling (the `else if (sawTerminal)` catch below).
          ) {
            // W2 — race the read against the phase-aware stall window. Slice (b):
            // the PHASE is derived first and the PERIOD is derived FROM the
            // phase, so a metric label and the budget it describes cannot
            // disagree by construction. Behaviour is byte-identical to the
            // two-way `contentStarted && !inThinking` predicate this replaces.
            // Computed ONCE per read, before `reader.read()` — it cannot change
            // during a keep-alive re-entry, because no upstream data is
            // processed in that loop.
            const detectorPhase = detectorPhaseOf(peek, contentObservable);
            const period = detectorPeriodFor(detectorPhase, stall);
            const readP = reader.read();
            // M1 (D100) — ARM THE STALL WINDOW EXACTLY ONCE PER READ, then reuse
            // this same settled promise on every keep-alive re-entry below. That
            // is what keeps the window an ABSOLUTE deadline across N keep-alive
            // fires BY CONSTRUCTION: a loop that re-armed per tick would extend the
            // deadline without bound — precisely the unbounded liveness lie D96
            // forbids. `raceReadWithKeepAlive` arms nothing, so that mistake is
            // unavailable here rather than merely discouraged.
            const stallP = stallTimer.arm(period);
            // F165 — the keep-alive's ceiling clock, metered PER READ.
            //
            // Per-read rather than per-stream because content IS liveness: a read
            // that produces data resets the budget correctly rather than as a
            // loophole, and a per-stream meter would penalise a legitimately long
            // stream with many real gaps. It cannot become unbounded — the
            // keep-alive lives INSIDE this race and `stallP` is armed once and
            // reused, so it can never outlive one stall window.
            const readStartedMs = performance.now();
            /**
             * Arm ONE keep-alive interval, or `undefined` when the keep-alive
             * must not fire. All three gates live here, so the initial arm and
             * every re-arm below cannot diverge:
             *
             *   - the feature is on at all;
             *   - `require_first_byte` is satisfied. `incidentFirstByteMs` cannot
             *     change during the loop (no upstream data is processed in it),
             *     so this is stable for the whole read;
             *   - the per-read `max_total_ms` budget is unspent. Past it this
             *     returns `undefined`, the `keepalive` arm goes unselectable, and
             *     the loop degenerates to the EXACT 2-way race M1 shipped — no
             *     new outcome member, no new termination path, and the stall
             *     detector stays the authority on a genuinely dead stream (D96).
             *     ⚠ The budget is tested when the NEXT interval is armed, so
             *     emission stops within one `interval_ms` of the ceiling, not at
             *     it. That is stated in the schema docblock and the HELP text
             *     rather than left for an operator to discover.
             */
            const armKeepAlive = (): Promise<void> | undefined =>
              keepAlive !== undefined &&
              (!keepAlive.cfg.requireFirstByte ||
                incidentFirstByteMs !== undefined) &&
              performance.now() - readStartedMs < keepAlive.cfg.maxTotalMs
                ? keepAlive.timer.arm(keepAlive.cfg.intervalMs)
                : undefined;
            let kaP = armKeepAlive();
            // M1 — detector-active wait is the SUM of this read's race SEGMENTS,
            // never the wall-clock span of the loop. The segment is CLOSED before
            // each keep-alive write and REOPENED after it returns, so time spent
            // writing to the client is EXCLUDED: the series must measure how long
            // the DETECTOR waited, not how long we spent talking downstream. Both
            // naive merges of the two Phase 2 slices get exactly this wrong — one
            // caps the value at `interval_ms`, the other swallows N writes into
            // it (D100 § the two collisions), and either one silently destroys the
            // only series licensed to size a stall window.
            let detectorWaitMs = 0;
            /**
             * D101 — the accumulator is a closed-over PAIR with an IDEMPOTENT
             * close, not a bare `+=` followed by a re-stamp. `undefined` means
             * CLOSED.
             *
             * The keep-alive write between the two is I/O, and so is the `arm()`
             * that follows it. A throw from either would leave a bare `waitStart`
             * sitting at the START of the segment just accounted, and the
             * `finally` below would then add that same segment a SECOND time —
             * corrupting `detectorWaitMs`, which feeds `noteDetectorWait` and
             * `incidentCensoredWaitMs`, i.e. the exact series slice (b) exists to
             * produce. Structural beats handled: there is no try/catch around the
             * write because there is no longer a failure mode to catch.
             */
            let waitStart: number | undefined = performance.now();
            const closeSegment = (): void => {
              if (waitStart === undefined) return; // already closed — add nothing
              detectorWaitMs += performance.now() - waitStart;
              waitStart = undefined;
            };
            const openSegment = (): void => {
              waitStart = performance.now();
            };
            let raced: RaceReadResult<Awaited<ReturnType<typeof reader.read>>>;
            // Slice (b) — set when the STALL arm wins, which RIGHT-CENSORS this
            // read's wait. A REJECTING read is deliberately NOT censored: it
            // completed, with an error, after a wait we actually observed.
            let censoredByStall = false;
            try {
              for (;;) {
                // ⚠ **`kaP` IS RE-ARMED FRESH ON EVERY ROUND, five lines below —
                // the exact INVERSE of `stallP` above, and mirroring `stallP`'s
                // arm-once-and-reuse here is a LIVELOCK.** A reused keep-alive is
                // already settled on re-entry, so the race resolves `keepalive`
                // immediately and forever in a PURE-MICROTASK loop. That starves
                // the macrotask queue, `setTimeout` lives there, and the stall
                // timer therefore never fires — the keep-alive would silently
                // disable the detector it is supposed to sit inside. See
                // `raceReadWithKeepAlive`'s docblock.
                const r = await raceReadWithKeepAlive(readP, stallP, kaP);
                if (r.kind !== "keepalive") {
                  raced = r;
                  censoredByStall = r.kind === "stall";
                  break;
                }
                closeSegment();
                // Emitted ONLY at an SSE event boundary, so a comment can never
                // splice into a half-written event; and `writeKeepAliveComment`
                // reports DELIVERY, so a write into a torn-down client does not
                // tick the counter.
                if (
                  keepAlive !== undefined &&
                  atSseBoundary() &&
                  (await writeKeepAliveComment(stream))
                ) {
                  incCounter(
                    "copilot_proxy_stream_keepalives_total",
                    1,
                    keepAlive.labels,
                  );
                }
                kaP = armKeepAlive();
                openSegment();
              }
            } finally {
              // M1 — accounted in `finally` so a REJECTING `reader.read()` still
              // records its wait. Without this, a stream that waited 300 s and was
              // then RST reports a max drawn from earlier trivial waits — a WRONG
              // value, which is strictly worse than an absent sample. D101 — the
              // close is IDEMPOTENT, so on a throw out of the loop (where the
              // segment is already closed) this adds nothing rather than double-
              // counting the last segment.
              closeSegment();
              if (censoredByStall) {
                // Slice (b) — RIGHT-CENSORED, so it is COUNTED and not
                // histogrammed. `stallTimer.arm(period)` is taken one statement
                // before `waitStart`, so `detectorWaitMs` here is ≈`period` while
                // the read itself is orphaned below and its true wait is only
                // known to be >= `period`. Filing that as a completed wait makes
                // an operator's p99 read back the configured window and call it
                // saturated demand — the whole distribution then says "the window
                // is exactly right" no matter what upstream is doing.
                //
                // The elapsed IS kept, as a lower bound, for the incident RECORD
                // — see `IncidentContext.censoredWaitMs`. Dropping it left the
                // record silent about the only wait that mattered on a
                // stall-terminated stream.
                incidentCensoredWaitPhase = detectorPhase;
                incidentCensoredWaitMs = detectorWaitMs;
              } else {
                noteDetectorWait(detectorWaitMs, detectorPhase);
              }
            }
            if (raced.kind === "stall") {
              // W2 F#2 — abort-first precedence: if the client already tore down (its socket
              // close beat the stall window), this is a client_abort (499), NOT an
              // upstream_stall (504). Only classify a stall while the client is still
              // connected. Mirrors the loop-top stream.aborted handling; no frame is written
              // (the client is gone) and no stall is logged.
              if (stream.aborted || clientSignal.aborted) {
                void readP.catch(() => {
                  /* orphaned read — the timer won the race */
                });
                if (outcome === "success") outcome = "client_abort";
                void reader.cancel().catch(() => {
                  /* already closed / cancelled */
                });
                return;
              }
              // Genuine upstream stall. Set the outcome BEFORE any await so a
              // client abort racing in during the frame write cannot downgrade
              // 504 → 499 (the onAbort guard also excludes `upstream_stall`).
              outcome = "upstream_stall";
              void readP.catch(() => {
                /* orphaned read — the timer won the race */
              });
              // Slice (b) — derived from `detectorPhase`, NOT from
              // `peek.contentStarted` alone. The old two-way predicate ignored
              // `inThinking` while the period selector did not, so a thinking-block
              // stall logged `phase:"response"` against the GENEROUS 1,140,000 ms
              // no-response budget — measured in this repo's own passing test
              // output as `upstream stall: no further content within 1140000ms
              // (response phase)`. `StallRecord.phase` is a two-value union, so
              // `thinking` and `unobservable` both collapse onto `no_response`,
              // which is the budget they actually run under.
              const phase =
                detectorPhase === "response" ? "response" : "no_response";
              const detail =
                phase === "response" ? "further content" : "response";
              const stallErr = new Error(
                `upstream stall: no ${detail} within ${period}ms (${phase} phase)`,
              );
              consola.error(
                `stream ${requestIdLabel(ctxBase)}: ${stallErr.message}`,
              );
              const frameBytes = await writeUpstreamErrorFrame(
                stream,
                stallErr,
                protocol,
                ctxBase.model,
                outcome,
              );
              captureInjectedFrame(frameBytes);
              stall.log(
                buildStallRecord({
                  phase,
                  waitedMs: period,
                  protocol,
                  model: ctxBase.model,
                  requestId: requestIdOf(ctxBase),
                  route: ctxBase.route,
                }),
              );
              // Tear down the hung upstream (releaseLock alone does not cancel it).
              void reader.cancel().catch(() => {
                /* already closed / cancelled */
              });
              return;
            }
            readResult = raced.result;
          } else {
            readResult = await reader.read();
          }
          const { value, done } = readResult;
          if (done) {
            // F3 — surface a truncated upstream: clean EOF (done:true, no
            // throw) but the byte state machine shows a real (non-empty,
            // non-comment) field line was still open since the last event
            // boundary, so the upstream closed mid-event. `curLineKind === 2`
            // catches a final real line with no trailing line terminator at all
            // (e.g. `data: x` with no `\n`); `sinceBoundaryHasReal` catches a
            // real line that WAS terminated but never closed by a blank line
            // (e.g. `data: x\n`).
            //
            // P2 — reclassify a truncated trailing event to upstream_error even
            // when the outcome was ALREADY client_abort. When the client
            // disconnects first (the harness times out waiting on a stalled or
            // broken upstream mid-event), onAbort has already set
            // outcome=client_abort and cancelled the reader, so this done:true
            // arrives with a truncated trailing event. A client disconnect + a
            // TRUNCATED trailing event means the client left because the upstream
            // stalled/broke mid-event — so it is an upstream failure (502), not a
            // client abort (499). Reclassifying makes the trace/metric correct
            // and fires the error frame best-effort (harmless if the client
            // socket is already gone; delivered if still reachable). ACCEPTED
            // tradeoff: a client cancelling EXACTLY mid-content-token on a
            // HEALTHY upstream also has truncated=true and is labeled
            // upstream_error — rare and harmless (the client cancelled and will
            // not see the frame); surfacing real upstream stalls outweighs this
            // benign mislabel. A clean-boundary abort leaves truncated=false, so
            // it STAYS client_abort (499) with no frame (nothing to surface).
            //
            // H6 — an incomplete leading BOM at EOF (`bomIndex` 1 or 2: the
            // stream ended after `EF` or `EF BB` with no `BF`) is also a
            // truncation; a full BOM sets bomIndex to 3 and is NOT flagged.
            const truncated =
              sinceBoundaryHasReal ||
              curLineKind === 2 ||
              (bomIndex > 0 && bomIndex < 3);
            if (
              truncated &&
              (outcome === "success" || outcome === "client_abort")
            ) {
              outcome = "upstream_error";
              const truncErr = new Error(
                "upstream closed the stream before the final event boundary (truncated response)",
              );
              consola.error(
                `stream ${requestIdLabel(ctxBase)}: ${truncErr.message}`,
              );
              const frameBytes = await writeUpstreamErrorFrame(
                stream,
                truncErr,
                protocol,
                ctxBase.model,
                outcome,
              );
              captureInjectedFrame(frameBytes);
            }
            return;
          }
          // M12.5 M2 — short-circuit empty chunks. Preserve `boundaryTail`
          // so a subsequent `\n`-leading chunk completes the bridge event.
          if (value.byteLength === 0) continue;
          // D96 Phase 1 — stamp the first byte + count upstream bytes BEFORE forwarding,
          // so the record reflects what the upstream produced rather than what
          // the client managed to drain.
          noteUpstreamBytes(value.byteLength);
          // Forward bytes verbatim. Hono's `StreamingApi.write` accepts
          // `Uint8Array | string`; we pass the upstream chunk directly.
          // No decode → no UTF-8 codepoint truncation at chunk boundaries,
          // no re-encode cost, supports any byte sequence (binary-safe).
          await stream.write(value);
          // F3 — advance the truncation state machine over the forwarded
          // bytes. Order relative to `stream.write(value)` above is irrelevant
          // (this is a read-only scan). O(chunkLength) time, O(1) space; no
          // decode, no allocation, no boundary regex.
          for (let bi = 0; bi < value.byteLength; bi++) {
            const b = value[bi];
            // F6 — consume a leading UTF-8 BOM (EF BB BF) WITHOUT classifying it
            // as a real field line. The bytes are already forwarded verbatim
            // (stream.write(value) above); this only affects truncation
            // classification. On the first byte that does not continue the BOM,
            // abandon BOM tracking (bomIndex=3) and fall through to classify
            // THAT byte normally.
            if (bomIndex < 3) {
              if (b === BOM_BYTES[bomIndex]) {
                bomIndex++;
                continue;
              }
              // H6 — the leading bytes did NOT form a complete BOM. Any BOM
              // bytes provisionally matched-and-skipped were real content, so if
              // ≥1 was matched mark the current line real (kind 2) — a truncation
              // here (e.g. `EF BB 41…` then close mid-line) must be detected.
              // Then classify THIS byte normally below.
              const hadPartialBom = bomIndex > 0;
              bomIndex = 3;
              if (hadPartialBom && curLineKind === 0) curLineKind = 2;
            }
            if (b === 0x0a) {
              // LF. If it closes a `\r\n` pair, the CR already ended the line.
              if (prevWasCR) {
                prevWasCR = false;
                continue;
              }
              endOfLine(); // lone LF line terminator (prevWasCR stays false)
            } else if (b === 0x0d) {
              // CR line terminator. A following LF (if any) is coalesced above.
              endOfLine();
              prevWasCR = true;
            } else {
              // H5 — accumulate the line's leading bytes (bounded to 40; SSE
              // field names/markers are short ASCII) so `endOfLine` can test the
              // completed line against the protocol terminal marker. A UTF-8 data
              // byte can never match a marker, so a truncated 40-byte prefix of a
              // long `data:` line is harmless.
              if (linePrefix.length < 40) linePrefix += String.fromCharCode(b);
              // W2 smart-peek — accumulate a longer bounded prefix (only when
              // stall detection is on) so `peekVerbatimLine` sees the Anthropic
              // block type / Chat `"content"` field that sit past byte 40.
              if (peek !== undefined && peekLine.length < STALL_PEEK_CAP) {
                peekLine += String.fromCharCode(b);
              }
              // Content byte — classify the line by its bytes (F5):
              //   ':'                     → comment line (kind 1)
              //   only spaces/tabs so far → whitespace-only line (kind 3; a
              //     trailing all-whitespace line is NOT a real field and must
              //     not trip truncation detection)
              //   anything else           → real field line (kind 2)
              prevWasCR = false;
              const isWs = b === 0x20 || b === 0x09;
              if (curLineKind === 0) {
                if (b === 0x3a) curLineKind = 1;
                else if (isWs) curLineKind = 3;
                else curLineKind = 2;
              } else if (curLineKind === 3 && !isWs) {
                // A non-whitespace byte after leading whitespace makes this a
                // real field line (e.g. "  data: x" with leading spaces).
                curLineKind = 2;
              }
            }
          }
          // Phase 5 v3.1 Group C — outbound capture for trace. Track every
          // received byte (for body_bytes accounting); push to the in-memory
          // buffer up to the cap. Once the cap is exceeded we emit a single
          // `consola.warn` per stream + drop the chunk (still counted in
          // bytesActuallyReceived). F-DISC-4: trace integrity wins over
          // strict accuracy — operators see the warn line, the manifest
          // carries body_truncated:true, and the .res sidecar ends abruptly
          // at the cap byte boundary; the file is still written.
          if (traceEnabled) {
            bytesActuallyReceived += value.byteLength;
            if (bytesAccumulated + value.byteLength <= capBytes) {
              buffer.push(value);
              bytesAccumulated += value.byteLength;
            } else if (!warnedOverflow) {
              warnedOverflow = true;
              droppedAnyBytes = true; // F6 — a REAL upstream chunk was dropped
              consola.warn(
                `trace: stream ${requestIdLabel(ctxBase)} exceeded ${capMb}MB buffer at ${bytesActuallyReceived} bytes received; event_counts will undercount`,
              );
            }
          }
          // Metrics — per-chunk bytes + per-event boundary count.
          incCounter("copilot_proxy_response_bytes_total", value.byteLength, {
            route: ctxBase.metricRoute,
          });
          // Count SSE-event boundaries: `\n\n` (0x0A 0x0A). Bridge across the
          // prior chunk's trailing `\n` if any.
          //
          // M12.6 M2-NEW — track whether the LAST byte of this chunk was
          // already CONSUMED as the second-of-pair (either by the bridge
          // or by an in-chunk pair ending at byteLength-1). Pre-M12.6 the
          // post-loop assignment unconditionally read `value[byteLength-1]`
          // and set boundaryTail=1 if it was `\n` — but if that `\n` was
          // already the second-of-pair, the next chunk's leading `\n`
          // would be wrongly counted as a bridge boundary (double-counting).
          let events = 0;
          let i = 0;
          let lastConsumed = false;
          if (boundaryTail === 1 && value[0] === 0x0a) {
            events += 1;
            i = 1;
            // The bridge consumed value[0]. If that was also the LAST
            // byte of this chunk (single-byte chunk = "\n"), mark it.
            if (value.byteLength === 1) lastConsumed = true;
          }
          for (; i + 1 < value.byteLength; i++) {
            if (value[i] === 0x0a && value[i + 1] === 0x0a) {
              events += 1;
              // The pair ended at index i+1. If that's the chunk's last
              // byte, the trailing `\n` was consumed as the second-of-
              // pair — boundaryTail must be 0, not 1.
              if (i + 1 === value.byteLength - 1) lastConsumed = true;
              i += 1; // skip past the second \n
            }
          }
          // M12.5 M2 — only update boundaryTail on non-empty chunks (we
          // guarded with `continue` above, so byteLength > 0 here).
          // M12.6 M2-NEW — if the last byte was already consumed as the
          // second-of-pair, boundaryTail MUST be 0; otherwise inspect it.
          if (lastConsumed) {
            boundaryTail = 0;
          } else {
            boundaryTail = value[value.byteLength - 1] === 0x0a ? 1 : 0;
          }
          if (events > 0) {
            incCounter("copilot_proxy_stream_events_total", events, {
              route: ctxBase.metricRoute,
            });
          }
        }
      } catch (err) {
        // Client abort or upstream error — close cleanly. The finally block
        // below releases the reader lock + removes the abort listener.
        // M12.6 M1-NEW — distinguish client abort from upstream error so
        // requests_total carries the right status label (499 vs 502 per
        // Nginx convention). Both abort signals are checked: client-side
        // `clientSignal.aborted` (set by Hono when the inbound socket
        // closes) and `stream.aborted` (set by streamSSE when the
        // downstream writer is torn down).
        //
        // F3 (H2) — a genuine upstream failure must NOT be masked by a
        // COINCIDENT client abort. `reader.cancel()` (fired by onAbort)
        // resolves `read()` with done:true (the done-branch handles that path),
        // so a THROW reaching this catch is a real upstream failure UNLESS the
        // throw is itself abort-shaped (the composed upstream signal aborted the
        // fetch → AbortError). Precedence: label client_abort ONLY for an
        // abort-shaped throw under an active abort flag; a non-abort throw is
        // surfaced as the upstream failure it is, even under a coincident abort.
        if ((clientSignal.aborted || stream.aborted) && isAbortError(err)) {
          outcome = "client_abort";
        } else if (sawTerminal) {
          // H5 — upstream already delivered a clean terminal event; a later
          // read() error is post-completion noise (e.g. socket RST after
          // message_stop). The message is complete — do NOT inject a duplicate
          // terminal error frame.
          outcome = "success";
        } else {
          outcome = "upstream_error";
          // Surface the real mid-stream failure to the client as a protocol-
          // shaped SSE error event (+ operator log) instead of a silently
          // truncated stream. Never emitted on client_abort (nothing to
          // surface to).
          consola.error(
            `stream ${requestIdLabel(ctxBase)}: upstream mid-stream failure — ${formatErrorChain(err)}`,
          );
          const frameBytes = await writeUpstreamErrorFrame(
            stream,
            err,
            protocol,
            ctxBase.model,
            outcome,
          );
          captureInjectedFrame(frameBytes);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
        clientSignal.removeEventListener("abort", onAbort);
        // W2 — cancel any armed stall timer so its (unref'd) setTimeout does not
        // linger past stream teardown. Idempotent; no-op when stall is off.
        // F165 — the keep-alive owns a SEPARATE timer instance, so it needs its
        // own cancel; cancelling one never cancels the other.
        stallTimer?.cancel();
        keepAlive?.timer.cancel();
      }
    } finally {
      // M12.5 H2 — stream-lifecycle ownership: forward-stream owns the
      // inflight decrement + requests_total increment for streams (the
      // wrapping withMetrics middleware skips those when Content-Type is
      // text/event-stream). M12.6 H1-NEW — moved to OUTER finally so the
      // null-body early-return path also decrements (no inflight leak).
      // M12.6 M1-NEW — `outcome` is set inside the inner catch block
      // (default "success" for clean drain or null-body path).
      recordStreamCompletion(ctxBase.metricRoute, outcome, {
        ctxBase,
        protocol,
        startedMs: incidentStartedMs,
        firstByteMs: incidentFirstByteMs,
        bytesReceived: incidentBytes,
        maxSilenceMs: incidentMaxSilenceMs,
        lastByteMs: incidentLastByteMs,
        inflightAtStart: incidentInflightAtStart,
        peek,
        maxDetectorWaitMsByPhase: incidentMaxDetectorWaitByPhase,
        censoredWaitPhase: incidentCensoredWaitPhase,
        censoredWaitMs: incidentCensoredWaitMs,
        firstContentMs: incidentFirstContentMs,
        contentObservable,
      });
      // Phase 5 v3.1 Group C — emit trace flow record (no-op when
      // traceWriter/traceMeta unset). Fire-and-forget: the writer's
      // promise resolves async; we never await it here so trace I/O
      // can't block the metric finally that just ran.
      // F6 — `droppedAnyBytes` is the body_truncated signal: true iff we hit
      // the per-stream buffer cap and dropped a REAL upstream chunk. The tiny
      // injected terminal error frame tipping the cap does NOT set it (no
      // upstream bytes were lost), so a stream whose only overflow was the
      // diagnostic frame reports body_truncated:false. `warnedOverflow` stays
      // solely the one-shot dedup guard for the consola.warn above.
      emitTraceFlow(
        ctxBase,
        buffer,
        outcome,
        upstreamHeadersForTrace,
        droppedAnyBytes,
      );
    }
  };
}

// ============================================================================
// M10 D-LOCK-4 — `forwardStreamTranslated` companion (translated path)
// ============================================================================

/**
 * Build a streamSSE callback that runs the upstream bytes through the
 * decode → applyEvent → re-encode pipeline before writing to the client.
 * Companion to `forwardStream` (verbatim byte path); the existing
 * `forwardStream` STAYS UNCHANGED. Both coexist; the handler chooses
 * per-route based on `route.stream_event_rules.length > 0` (D-LOCK-7).
 *
 * **Lifecycle (D-LOCK-4).**
 *   1. `acquireStreamState(requestId)` at start — keys the per-stream
 *      state map; subsequent acquires within the same id are idempotent
 *      (same `StreamState` reference).
 *   2. Per-chunk: `decodeSseChunk(value, state)` → for each decoded event
 *      `applyEvent({...ctxBase, event, state}, rules, snapshot)` →
 *      for each emitted event `stream.write(encodeSseEvent(...))`.
 *   3. On `done = true`: `decodeSseChunk(undefined, state)` flushes the
 *      decoder (drops partial events; logs `"sse-codec: partial-event-dropped"`).
 *   4. `finally`: `reader.releaseLock()` + abort-listener removed +
 *      `releaseStreamState(requestId)` so client-disconnect-mid-stream
 *      still releases per-request state. The lazy GC in `sse-state.ts` is
 *      the safety net; explicit release is the primary path.
 *
 * **Abort (M5 H1 parity with `forwardStream`).** Synchronous abort listener
 * on `clientSignal` calls `reader.cancel()` so any suspended
 * `reader.read()` resolves promptly. Without this, the upstream connection
 * would be held until GC.
 *
 * **Error semantics (M4 fix — distinguish I/O from transform errors).**
 *   - I/O errors (reader cancelled, upstream socket closed) are
 *     SWALLOWED silently (matches `forwardStream`'s pattern; client sees
 *     a closed stream — headers already flushed; cannot synthesize an
 *     HTTP error response after that point).
 *   - Transform errors (`EngineAbort{500,502}Error`,
 *     `UnregisteredRuleError`, `RuleSchemaInvalidError`) get an explicit
 *     `debug.on(LEVEL_ON, ...)` log so operators can see WHICH rule
 *     failed mid-stream. Client still sees a closed stream; the log is
 *     the diagnostic surface. M11+ may add error-event synthesis if
 *     integration tests reveal client-side breakage.
 */
export function forwardStreamTranslated(
  c: Context,
  upstream: Response,
  rules: ReadonlyArray<Rule>,
  registrySnapshot: ReadonlyMap<string, RegisteredStreamEventRule>,
  requestId: string,
  ctxBase: StreamCtxBase,
): (stream: SSEStreamingApi) => Promise<void> {
  const clientSignal = deriveUpstreamSignal(c);
  // Phase 5 v3.1 Group C — capture upstream response headers up-front; the
  // upstream Response is consumed by `getReader()` below + we want the
  // headers verbatim in the trace `response.headers` field. Pulled into
  // the closure-builder scope so it is fixed at the moment forwardStream
  // is built (mirrors the verbatim forwarder).
  const upstreamHeadersForTrace: Record<string, string> = {};
  if (ctxBase.traceWriter !== undefined && ctxBase.traceMeta !== undefined) {
    upstream.headers.forEach((v, k) => {
      upstreamHeadersForTrace[k] = v;
    });
  }
  return async (stream): Promise<void> => {
    // M12.6 H1-NEW — outer try/finally guarantees `recordStreamCompletion`
    // fires even when `upstream.body === null`. Stream-state is acquired
    // INSIDE the try (after the null-body check) so null-body neither
    // acquires nor needs to release per-stream state — sse-state.ts's lazy
    // GC remains the safety net for any stream that does acquire.
    //
    // M12.6 M1-NEW — `outcome` lifted to closure; inner catch sets it to
    // either client_abort or upstream_error so the outer finally records
    // the right requests_total status label.
    let outcome: StreamCompletionOutcome = "success";
    // F1 — client protocol for any mid-stream error frame (shape depends on
    // the route the client speaks). Fixed for the stream's lifetime.
    const protocol = protocolFromMetricRoute(ctxBase.metricRoute);
    // W2 — content-phase stall detector wiring (additive; every use is a no-op
    // when `ctxBase.stall` is unset). Mirror of the verbatim forwarder:
    // `stallTimer` + `peek` created once per stream; the translated path feeds
    // `peek` its decoded OUTBOUND events (structured `.type`) instead of raw
    // bytes.
    const stall = ctxBase.stall;
    const stallTimer = stall !== undefined ? stall.makeTimer() : undefined;
    const peek = stall !== undefined ? newPeekState() : undefined;
    // F165 — the keep-alive, created once per stream alongside the detector it
    // sits inside. `undefined` when the feature is off, which is the shipped
    // default; every use below is then a no-op.
    const keepAlive = makeKeepAliveState(ctxBase);
    // D96 Phase 1 — incident-log accounting, tracked UNCONDITIONALLY.
    // `bytesActuallyReceived` further down CANNOT serve this: it is incremented
    // only inside `if (traceEnabled)`, i.e. only at `logging.level >= raw`, and
    // the entire point of the incident log is to survive at the level the fleet
    // actually runs (F138). `performance.now()` is monotonic, so these durations
    // are immune to a wall-clock adjustment landing mid-stream.
    const incidentStartedMs = performance.now();
    const incidentInflightAtStart = getValueForTests(
      "copilot_proxy_inflight_requests",
      { route: ctxBase.metricRoute },
    );
    let incidentFirstByteMs: number | undefined;
    let incidentBytes = 0;
    // D96 Phase 1 — running max byte-silent gap WITHIN the stream, plus the
    // instant of the most recent chunk. A running max costs one comparison per
    // chunk; observing every gap into a histogram would cost thousands of
    // writes per stream to answer a question about a single number.
    let incidentLastByteMs: number | undefined;
    let incidentMaxSilenceMs = 0;
    /**
     * Slice (b) — per-stream MAX detector-active wait, KEYED BY PHASE. This is
     * the quantity no other emitted series can
     * provide: `max_silence` mixes all three detector budgets, and the first-byte
     * series end at the first RAW byte while the detector's phase flips on the
     * first CONTENT delta.
     *
     * ⚠ **Sparse, and the sparseness is the design.** A key exists IFF that
     * phase was entered. M1 shipped this as a single scalar
     * (`let incidentMaxDetectorWaitMs = 0`), and consuming that unchanged would
     * have published ONE number per stream mixing all three budgets — i.e.
     * `max_silence` divergence #3 reproduced inside the instrument built to
     * replace it, and a scalar additionally cannot distinguish never-armed from
     * armed-and-zero. Do NOT collapse it back, and do NOT pre-seed the phases
     * with zeros: a zero for a phase the stream never reached biases the low end
     * of the very quantile the series exists to establish.
     *
     * Read by `observeStreamHistograms` into
     * `copilot_proxy_detector_max_wait_seconds{phase}`, and by `emitIncident`
     * into the record's `maxDetectorWaitMs` / `maxDetectorWaitPhase` join.
     */
    const incidentMaxDetectorWaitByPhase: Partial<
      Record<DetectorPhase, number>
    > = {};
    const noteDetectorWait = (ms: number, phase: DetectorPhase): void => {
      const prior = incidentMaxDetectorWaitByPhase[phase];
      if (prior === undefined || ms > prior) {
        incidentMaxDetectorWaitByPhase[phase] = ms;
      }
    };
    /**
     * The phase whose wait was RIGHT-CENSORED by the stall timer winning the
     * race, if any. At most one per stream — the stall arm writes the error
     * frame and returns.
     *
     * The censoring is not incidental: `stallTimer.arm(period)` is taken one
     * statement before `waitStart`, so on a stall the `finally` measures ≈the
     * whole window while the read itself is orphaned (`void readP.catch()`) and
     * its TRUE wait is unknowable — only `>= period`. Recording that as if it
     * were a completed wait makes an operator's p99 read back the configured
     * window and call it saturated demand.
     */
    let incidentCensoredWaitPhase: DetectorPhase | undefined;
    /**
     * Elapsed ms measured on that censored read. ≈`period`, and recorded as a
     * LOWER BOUND rather than a value: it is what lets the incident RECORD say
     * "this 504 was preceded by a wait of at least N ms in phase P" instead of
     * omitting the wait that actually killed the stream. The metric surface
     * still never sees it.
     */
    let incidentCensoredWaitMs: number | undefined;
    /**
     * `performance.now()` at the instant `peek.contentStarted` first flips —
     * the instant the detector LEAVES its `no_response` phase, stamped where the
     * peek is updated, because that is the value the detector's NEXT read reads.
     *
     * ⚠ **Leaving `no_response` is not the same as entering `response`.** On an
     * Anthropic thinking stream the first content delta is a THINKING delta, so
     * the next phase is `"thinking"` — which takes the same GENEROUS window.
     * This stamp is therefore the first-content latency, not the instant the
     * tight budget begins to apply; see `observeStreamHistograms`' docblock.
     *
     * Idempotent and clock-cheap, so it can be called unconditionally at the
     * peek site. Stamping it at the first byte instead would make the series an alias of
     * `copilot_proxy_upstream_first_byte_seconds` and destroy its entire reason
     * to exist.
     */
    let incidentFirstContentMs: number | undefined;
    const noteContentPhase = (): void => {
      if (
        peek !== undefined &&
        peek.contentStarted &&
        incidentFirstContentMs === undefined
      ) {
        incidentFirstContentMs = performance.now();
      }
    };
    /**
     * Whether this lane's smart-peek can observe content AT ALL. Fixed for the
     * stream's lifetime; see `peekObservesContent` for the two independent
     * reasons the translated `openai_chat` lane cannot.
     */
    const contentObservable = peekObservesContent("translated", protocol);
    /**
     * Note upstream bytes arriving from the reader; called once per non-empty
     * chunk. The first-byte instant is stamped exactly once, and ONLY from a
     * real upstream chunk — never from an empty one and never from an injected
     * error frame, which is our byte rather than the upstream's. An ABSENT
     * `ttfbMs` is the discriminator between "the upstream never spoke" and "the
     * stream started and then broke", so a false stamp would erase the one
     * distinction the record exists to preserve.
     *
     * The gap from stream start to the FIRST byte is first-byte latency, not silence, so the
     * silence max only starts accumulating from the second chunk onward.
     */
    const noteUpstreamBytes = (n: number): void => {
      if (n <= 0) return;
      const now = performance.now();
      if (incidentFirstByteMs === undefined) {
        incidentFirstByteMs = now;
      } else if (incidentLastByteMs !== undefined) {
        const gap = now - incidentLastByteMs;
        if (gap > incidentMaxSilenceMs) incidentMaxSilenceMs = gap;
      }
      incidentLastByteMs = now;
      incidentBytes += n;
    };
    // H5 — set once the translator emits the protocol's success-terminal event
    // (message_stop / response.completed). A subsequent read()/transform throw
    // is then post-completion noise: the catch suppresses the injected error
    // frame instead of appending a duplicate terminal. Persists across the loop.
    let sawTerminal = false;
    /**
     * F165 — the D47 mirror of the verbatim lane's `atSseBoundary()` predicate.
     *
     * This lane has no byte scanner to derive a boundary from, so the boundary
     * is MAINTAINED by the live write loop: cleared immediately before each
     * `stream.write` and set immediately after it returns. That is sound here
     * and not on the other lane because `encodeSseEvent` ALWAYS terminates
     * `\n\n` (its `parts.join("\n") + "\n\n"`, and the `[DONE]` sentinel branch
     * returns `"data: [DONE]\n\n"`), so a COMPLETED write is provably an event
     * boundary.
     *
     * Initialising `false` makes the pre-first-event case unreachable, which is
     * this lane's structural mirror of `bomIndex === 3` — the reason
     * `require_first_byte: false` cannot actually enable a pre-first-byte
     * comment on either lane.
     */
    let atEventBoundary = false;
    /**
     * Called identically at both seams so the two race blocks stay
     * byte-identical (D47); the two lanes differ by this definition alone.
     */
    const atSseBoundary = (): boolean => atEventBoundary;
    // Phase 5 v3.1 Group C — outbound-byte capture for trace. Allocated
    // unconditionally so the per-chunk push site stays branch-free; when
    // `traceWriter`/`traceMeta` are unset, the buffer is built but never
    // serialized (`emitTraceFlow` no-ops without the writer). Cost: one
    // empty array allocation per stream — negligible vs the upstream
    // socket cost.
    const traceEnabled =
      ctxBase.traceWriter !== undefined && ctxBase.traceMeta !== undefined;
    const capMb = ctxBase.streamBufferMb ?? STREAM_BUFFER_MB_DEFAULT;
    const capBytes = capMb * 1024 * 1024;
    const buffer: Uint8Array[] = [];
    let bytesAccumulated = 0;
    let bytesActuallyReceived = 0;
    let warnedOverflow = false;
    // F6 — body_truncated must reflect only DROPPED upstream bytes. Track real-
    // chunk drops here, separately from `warnedOverflow` (which stays solely the
    // one-shot dedup guard for the consola.warn). The injected terminal error
    // frame tipping the cap must NOT set this — no upstream bytes were lost.
    let droppedAnyBytes = false;
    // M4 — fold an injected error frame's bytes into trace capture + the
    // response-bytes / stream-events metric counters. Local closure so it
    // captures THIS forwarder's own mutable buffer state; `null` (client
    // socket already gone) is a no-op.
    const captureInjectedFrame = (frameBytes: Uint8Array | null): void => {
      if (frameBytes === null) return;
      if (traceEnabled) {
        bytesActuallyReceived += frameBytes.byteLength;
        buffer.push(frameBytes); // always capture the terminal diagnostic frame
        bytesAccumulated += frameBytes.byteLength;
      }
      incCounter("copilot_proxy_response_bytes_total", frameBytes.byteLength, {
        route: ctxBase.metricRoute,
      });
      incCounter("copilot_proxy_stream_events_total", 1, {
        route: ctxBase.metricRoute,
      });
    };
    try {
      if (upstream.body === null) return;
      const reader = upstream.body.getReader();
      const decoderState: SseDecoderState = { buffer: "" };
      const streamState = acquireStreamState(requestId);

      const onAbort = (): void => {
        // M12.7 — record abort intent BEFORE cancel. See forwardStream's
        // onAbort for full rationale: production client-aborts go through
        // onAbort -> reader.cancel() -> done:true (no throw), so the
        // catch-block detection below would NOT fire. Setting outcome here
        // ensures real client aborts record status="499" not "200".
        //
        // F3 (H2) — MONOTONIC for proven failures (mirror of the verbatim
        // forwarder): a client abort racing in after a proven upstream_error /
        // internal_error / upstream_stall was set (e.g. during the awaited
        // writeUpstreamErrorFrame — W2 sets upstream_stall right before it) must
        // NOT downgrade it to a 499.
        if (
          outcome !== "upstream_error" &&
          outcome !== "internal_error" &&
          outcome !== "upstream_stall"
        ) {
          outcome = "client_abort";
        }
        void reader.cancel().catch(() => {
          /* already closed / cancelled */
        });
      };
      clientSignal.addEventListener("abort", onAbort);
      // M12.8 HIGH-1 — WHATWG AbortSignal does NOT replay past aborts to late
      // listeners. If signal already aborted at listener-registration time,
      // onAbort never fires; the loop would park at await reader.read()
      // indefinitely (stalled upstream + no further chunks). Fire onAbort
      // synchronously to set outcome="client_abort" + cancel the reader so
      // the next read() resolves done:true. Idempotent: outcome reassignment
      // is harmless and reader.cancel() swallows already-closed errors.
      if (clientSignal.aborted) {
        onAbort();
      }

      try {
        while (true) {
          if (stream.aborted) {
            // M12.7 — downstream tear-down race; mirror forwardStream.
            //
            // H2/P2 — before recording client_abort, evaluate the SAME
            // truncation signal the done-branch uses (a real partial event
            // stranded in the decoder buffer): if present, the client tore down
            // mid-event on a stalled/broken upstream, so reclassify to
            // upstream_error for correct metrics/trace. No frame is written —
            // stream.aborted means the client socket is provably gone.
            const pendingPartial = trailingIsTruncatedEvent(
              decoderState.buffer,
            );
            if (
              pendingPartial &&
              (outcome === "success" || outcome === "client_abort")
            ) {
              outcome = "upstream_error";
              consola.error(
                `stream ${requestId}: upstream truncated mid-event (client already gone; classifying upstream_error)`,
              );
            } else {
              outcome = "client_abort";
            }
            // M12.8 HIGH-2 — explicit cancel BEFORE return so upstream
            // connection teardown is immediate (releaseLock alone does not
            // cancel the underlying ReadableStream). Mirror forwardStream.
            void reader.cancel().catch(() => {
              /* already closed / cancelled */
            });
            return;
          }
          let readResult: Awaited<ReturnType<typeof reader.read>>;
          if (
            stall !== undefined &&
            stallTimer !== undefined &&
            peek !== undefined &&
            !sawTerminal // W2 F#1 — response already complete; do not arm a post-terminal
            //             stall timer (would fire a spurious 504 on a hung-but-complete
            //             upstream). Fall through to the plain read → baseline
            //             sawTerminal→success handling (the `else if (sawTerminal)` catch below).
          ) {
            // W2 — race the read against the phase-aware stall window. Slice (b):
            // the PHASE is derived first and the PERIOD is derived FROM the
            // phase, so a metric label and the budget it describes cannot
            // disagree by construction. Behaviour is byte-identical to the
            // two-way `contentStarted && !inThinking` predicate this replaces.
            // Computed ONCE per read, before `reader.read()` — it cannot change
            // during a keep-alive re-entry, because no upstream data is
            // processed in that loop.
            const detectorPhase = detectorPhaseOf(peek, contentObservable);
            const period = detectorPeriodFor(detectorPhase, stall);
            const readP = reader.read();
            // M1 (D100) — ARM THE STALL WINDOW EXACTLY ONCE PER READ, then reuse
            // this same settled promise on every keep-alive re-entry below. That
            // is what keeps the window an ABSOLUTE deadline across N keep-alive
            // fires BY CONSTRUCTION: a loop that re-armed per tick would extend the
            // deadline without bound — precisely the unbounded liveness lie D96
            // forbids. `raceReadWithKeepAlive` arms nothing, so that mistake is
            // unavailable here rather than merely discouraged.
            const stallP = stallTimer.arm(period);
            // F165 — the keep-alive's ceiling clock, metered PER READ.
            //
            // Per-read rather than per-stream because content IS liveness: a read
            // that produces data resets the budget correctly rather than as a
            // loophole, and a per-stream meter would penalise a legitimately long
            // stream with many real gaps. It cannot become unbounded — the
            // keep-alive lives INSIDE this race and `stallP` is armed once and
            // reused, so it can never outlive one stall window.
            const readStartedMs = performance.now();
            /**
             * Arm ONE keep-alive interval, or `undefined` when the keep-alive
             * must not fire. All three gates live here, so the initial arm and
             * every re-arm below cannot diverge:
             *
             *   - the feature is on at all;
             *   - `require_first_byte` is satisfied. `incidentFirstByteMs` cannot
             *     change during the loop (no upstream data is processed in it),
             *     so this is stable for the whole read;
             *   - the per-read `max_total_ms` budget is unspent. Past it this
             *     returns `undefined`, the `keepalive` arm goes unselectable, and
             *     the loop degenerates to the EXACT 2-way race M1 shipped — no
             *     new outcome member, no new termination path, and the stall
             *     detector stays the authority on a genuinely dead stream (D96).
             *     ⚠ The budget is tested when the NEXT interval is armed, so
             *     emission stops within one `interval_ms` of the ceiling, not at
             *     it. That is stated in the schema docblock and the HELP text
             *     rather than left for an operator to discover.
             */
            const armKeepAlive = (): Promise<void> | undefined =>
              keepAlive !== undefined &&
              (!keepAlive.cfg.requireFirstByte ||
                incidentFirstByteMs !== undefined) &&
              performance.now() - readStartedMs < keepAlive.cfg.maxTotalMs
                ? keepAlive.timer.arm(keepAlive.cfg.intervalMs)
                : undefined;
            let kaP = armKeepAlive();
            // M1 — detector-active wait is the SUM of this read's race SEGMENTS,
            // never the wall-clock span of the loop. The segment is CLOSED before
            // each keep-alive write and REOPENED after it returns, so time spent
            // writing to the client is EXCLUDED: the series must measure how long
            // the DETECTOR waited, not how long we spent talking downstream. Both
            // naive merges of the two Phase 2 slices get exactly this wrong — one
            // caps the value at `interval_ms`, the other swallows N writes into
            // it (D100 § the two collisions), and either one silently destroys the
            // only series licensed to size a stall window.
            let detectorWaitMs = 0;
            /**
             * D101 — the accumulator is a closed-over PAIR with an IDEMPOTENT
             * close, not a bare `+=` followed by a re-stamp. `undefined` means
             * CLOSED.
             *
             * The keep-alive write between the two is I/O, and so is the `arm()`
             * that follows it. A throw from either would leave a bare `waitStart`
             * sitting at the START of the segment just accounted, and the
             * `finally` below would then add that same segment a SECOND time —
             * corrupting `detectorWaitMs`, which feeds `noteDetectorWait` and
             * `incidentCensoredWaitMs`, i.e. the exact series slice (b) exists to
             * produce. Structural beats handled: there is no try/catch around the
             * write because there is no longer a failure mode to catch.
             */
            let waitStart: number | undefined = performance.now();
            const closeSegment = (): void => {
              if (waitStart === undefined) return; // already closed — add nothing
              detectorWaitMs += performance.now() - waitStart;
              waitStart = undefined;
            };
            const openSegment = (): void => {
              waitStart = performance.now();
            };
            let raced: RaceReadResult<Awaited<ReturnType<typeof reader.read>>>;
            // Slice (b) — set when the STALL arm wins, which RIGHT-CENSORS this
            // read's wait. A REJECTING read is deliberately NOT censored: it
            // completed, with an error, after a wait we actually observed.
            let censoredByStall = false;
            try {
              for (;;) {
                // ⚠ **`kaP` IS RE-ARMED FRESH ON EVERY ROUND, five lines below —
                // the exact INVERSE of `stallP` above, and mirroring `stallP`'s
                // arm-once-and-reuse here is a LIVELOCK.** A reused keep-alive is
                // already settled on re-entry, so the race resolves `keepalive`
                // immediately and forever in a PURE-MICROTASK loop. That starves
                // the macrotask queue, `setTimeout` lives there, and the stall
                // timer therefore never fires — the keep-alive would silently
                // disable the detector it is supposed to sit inside. See
                // `raceReadWithKeepAlive`'s docblock.
                const r = await raceReadWithKeepAlive(readP, stallP, kaP);
                if (r.kind !== "keepalive") {
                  raced = r;
                  censoredByStall = r.kind === "stall";
                  break;
                }
                closeSegment();
                // Emitted ONLY at an SSE event boundary, so a comment can never
                // splice into a half-written event; and `writeKeepAliveComment`
                // reports DELIVERY, so a write into a torn-down client does not
                // tick the counter.
                if (
                  keepAlive !== undefined &&
                  atSseBoundary() &&
                  (await writeKeepAliveComment(stream))
                ) {
                  incCounter(
                    "copilot_proxy_stream_keepalives_total",
                    1,
                    keepAlive.labels,
                  );
                }
                kaP = armKeepAlive();
                openSegment();
              }
            } finally {
              // M1 — accounted in `finally` so a REJECTING `reader.read()` still
              // records its wait. Without this, a stream that waited 300 s and was
              // then RST reports a max drawn from earlier trivial waits — a WRONG
              // value, which is strictly worse than an absent sample. D101 — the
              // close is IDEMPOTENT, so on a throw out of the loop (where the
              // segment is already closed) this adds nothing rather than double-
              // counting the last segment.
              closeSegment();
              if (censoredByStall) {
                // Slice (b) — RIGHT-CENSORED, so it is COUNTED and not
                // histogrammed. `stallTimer.arm(period)` is taken one statement
                // before `waitStart`, so `detectorWaitMs` here is ≈`period` while
                // the read itself is orphaned below and its true wait is only
                // known to be >= `period`. Filing that as a completed wait makes
                // an operator's p99 read back the configured window and call it
                // saturated demand — the whole distribution then says "the window
                // is exactly right" no matter what upstream is doing.
                //
                // The elapsed IS kept, as a lower bound, for the incident RECORD
                // — see `IncidentContext.censoredWaitMs`. Dropping it left the
                // record silent about the only wait that mattered on a
                // stall-terminated stream.
                incidentCensoredWaitPhase = detectorPhase;
                incidentCensoredWaitMs = detectorWaitMs;
              } else {
                noteDetectorWait(detectorWaitMs, detectorPhase);
              }
            }
            if (raced.kind === "stall") {
              // W2 F#2 — abort-first precedence: if the client already tore down (its socket
              // close beat the stall window), this is a client_abort (499), NOT an
              // upstream_stall (504). Only classify a stall while the client is still
              // connected. Mirrors the loop-top stream.aborted handling; no frame is written
              // (the client is gone) and no stall is logged.
              if (stream.aborted || clientSignal.aborted) {
                void readP.catch(() => {
                  /* orphaned read — the timer won the race */
                });
                if (outcome === "success") outcome = "client_abort";
                void reader.cancel().catch(() => {
                  /* already closed / cancelled */
                });
                return;
              }
              // Set the outcome BEFORE any await so a client abort racing in
              // during the frame write cannot downgrade 504 → 499 (the onAbort
              // guard also excludes `upstream_stall`).
              outcome = "upstream_stall";
              void readP.catch(() => {
                /* orphaned read — the timer won the race */
              });
              // Slice (b) — derived from `detectorPhase`, NOT from
              // `peek.contentStarted` alone. The old two-way predicate ignored
              // `inThinking` while the period selector did not, so a thinking-block
              // stall logged `phase:"response"` against the GENEROUS 1,140,000 ms
              // no-response budget — measured in this repo's own passing test
              // output as `upstream stall: no further content within 1140000ms
              // (response phase)`. `StallRecord.phase` is a two-value union, so
              // `thinking` and `unobservable` both collapse onto `no_response`,
              // which is the budget they actually run under.
              const phase =
                detectorPhase === "response" ? "response" : "no_response";
              const detail =
                phase === "response" ? "further content" : "response";
              const stallErr = new Error(
                `upstream stall: no ${detail} within ${period}ms (${phase} phase)`,
              );
              consola.error(`stream ${requestId}: ${stallErr.message}`);
              const frameBytes = await writeUpstreamErrorFrame(
                stream,
                stallErr,
                protocol,
                ctxBase.model,
                outcome,
              );
              captureInjectedFrame(frameBytes);
              stall.log(
                buildStallRecord({
                  phase,
                  waitedMs: period,
                  protocol,
                  model: ctxBase.model,
                  requestId,
                  route: ctxBase.route,
                }),
              );
              // Tear down the hung upstream (releaseLock alone does not cancel it).
              void reader.cancel().catch(() => {
                /* already closed / cancelled */
              });
              return;
            }
            readResult = raced.result;
          } else {
            readResult = await reader.read();
          }
          const { value, done } = readResult;
          if (done) {
            // F2 — capture whether a partial event is stranded in the decoder
            // buffer at clean EOF, BEFORE the flush loop clears it. The decoder
            // keeps only the trailing (post-boundary) segment in its buffer, so
            // `trailingIsTruncatedEvent` is true iff that segment holds a real
            // (non-empty, non-comment) partial field line — the upstream closed
            // mid-event. The flush below DROPS that partial (sse-codec
            // § Final-flush rule), so without this the client would see a silent
            // truncation with a 200. Comment-only / bare-newline trailers (a
            // clean close after a `:keepalive`) are correctly NOT flagged.
            //
            // F4 (H4) — this is the PRE-FLUSH signal: it sees only what is in
            // `decoderState.buffer`, NOT a final multibyte codepoint the
            // TextDecoder is still holding. That held byte materializes (as
            // U+FFFD) only DURING the flush below, so its truncation is folded
            // in AFTER the flush via `droppedPartialAtFlush` (see the combined
            // `pendingPartial` after the flush loop).
            const preFlushPartial = trailingIsTruncatedEvent(
              decoderState.buffer,
            );
            // Final flush — decoder may hold partial event in its buffer.
            // sse-codec's `decodeSseChunk(undefined, ...)` flushes (drops
            // partial; logs `"sse-codec: partial-event-dropped"`).
            for (const event of decodeSseChunk(undefined, decoderState)) {
              // F2 (remediation) — apply + encode is the transform/encode phase:
              // a throw here (e.g. encodeSseEvent hits a circular ref) is
              // proxy-internal (500), NOT an upstream bad gateway (502). Brand it
              // so the outer catch classifies it internal_error. stream.write
              // stays OUTSIDE the brand (a write failure is a client concern
              // handled by the abort checks, not a transform failure).
              //
              // F5 (H5) — encode INSIDE the try (H3), but pair each encoded
              // frame with its terminal-ness so `sawTerminal` is committed only
              // AFTER the bytes are written (below), never during `.map()`. A
              // terminal-event ENCODE failure must not be reported as success.
              let encodedFrames: Array<{
                bytes: Uint8Array;
                isTerminal: boolean;
              }>;
              try {
                const result = applyEvent(
                  { ...ctxBase, event, state: streamState },
                  rules as Rule[],
                  registrySnapshot,
                );
                encodedFrames = result.events_out.map((outEvent) => ({
                  isTerminal: isOutboundTerminalEvent(outEvent, protocol),
                  bytes: encodeSseEvent(outEvent),
                }));
              } catch (err) {
                // H3 — a primitive, frozen, or sealed throw cannot carry the
                // transform-phase brand (markTransformPhase brands only
                // EXTENSIBLE objects). Mark first; if the brand did not take,
                // wrap in a fresh branded Error so the outer catch classifies it
                // internal_error (500), not upstream_error (502). An extensible
                // EngineAbort502Error IS branded but is excluded from the
                // internal branch by name in the outer catch, so it stays 502.
                const marked = markTransformPhase(err);
                if (isTransformPhaseError(marked)) throw marked;
                throw markTransformPhase(
                  new Error(`transform-phase failure: ${safeStringify(err)}`),
                );
              }
              for (const { bytes: encoded, isTerminal } of encodedFrames) {
                await stream.write(encoded);
                // F5 (H5) — the terminal event's bytes are now delivered to the
                // client → commit sawTerminal AFTER the write resolves (not
                // during encode). A terminal-event encode failure (caught above)
                // or a write throw leaves sawTerminal false, so the outer catch
                // surfaces the real failure instead of reporting success.
                if (isTerminal && !sawTerminal) sawTerminal = true;
                // Phase 5 v3.1 Group C — capture POST-translation bytes for
                // trace. Mirrors the verbatim forwarder; tracks every emitted
                // byte (for body_bytes accounting) and pushes to the buffer
                // up to the cap.
                if (traceEnabled) {
                  bytesActuallyReceived += encoded.byteLength;
                  if (bytesAccumulated + encoded.byteLength <= capBytes) {
                    buffer.push(encoded);
                    bytesAccumulated += encoded.byteLength;
                  } else if (!warnedOverflow) {
                    warnedOverflow = true;
                    droppedAnyBytes = true; // F6 — a REAL upstream chunk was dropped
                    consola.warn(
                      `trace: stream ${requestIdLabel(ctxBase)} exceeded ${capMb}MB buffer at ${bytesActuallyReceived} bytes received; event_counts will undercount`,
                    );
                  }
                }
                // M12 metrics — count emitted bytes + per-event count.
                // M12.5 H1: use `metricRoute` (clean Prometheus label), NOT
                // `route` (inbound HTTP path consumed by predicates).
                incCounter(
                  "copilot_proxy_response_bytes_total",
                  encoded.byteLength,
                  { route: ctxBase.metricRoute },
                );
                incCounter("copilot_proxy_stream_events_total", 1, {
                  route: ctxBase.metricRoute,
                });
              }
            }
            // F4 (H4) — fold in a final partial that the decoder was holding and
            // only DROPPED during the flush above (an EOF-stranded mid-codepoint,
            // e.g. a lone 0xE2): `droppedPartialAtFlush` is set by
            // `decodeSseChunk`'s final flush when it discards a non-empty
            // trailing partial. A HEALTHY stream (complete final event + boundary,
            // decoder fully drained) leaves BOTH signals falsy → no false-positive
            // frame; only a genuinely stranded final partial now surfaces as 502.
            const pendingPartial =
              preFlushPartial || decoderState.droppedPartialAtFlush === true;
            // F2 — after the flush, if a partial was stranded at clean EOF,
            // surface it as an injected error frame so the client sees an
            // explicit failure instead of a silent 200.
            //
            // P2 — reclassify to upstream_error even when the outcome was
            // ALREADY client_abort. When the client disconnects first (the
            // harness times out waiting on a stalled or broken upstream
            // mid-event), onAbort has already set outcome=client_abort and
            // cancelled the reader, so this done:true arrives with a partial
            // stranded in the decoder buffer. A client disconnect + a TRUNCATED
            // trailing event means the client left because the upstream
            // stalled/broke mid-event — so it is an upstream failure (502), not a
            // client abort (499). Reclassifying makes the trace/metric correct
            // and fires the error frame best-effort (harmless if the client
            // socket is already gone; delivered if still reachable). ACCEPTED
            // tradeoff: a client cancelling EXACTLY mid-content-token on a
            // HEALTHY upstream also strands a partial and is labeled
            // upstream_error — rare and harmless (the client cancelled and will
            // not see the frame). A clean-boundary abort leaves
            // pendingPartial=false, so it STAYS client_abort (499) with no frame.
            if (
              pendingPartial &&
              (outcome === "success" || outcome === "client_abort")
            ) {
              outcome = "upstream_error";
              const truncErr = new Error(
                "upstream closed the stream mid-event (partial SSE event dropped by decoder flush)",
              );
              // F5 — use the `requestId` param (ctxBase.traceMeta is undefined
              // when tracing is off, which would log "<unknown>").
              consola.error(`stream ${requestId}: ${truncErr.message}`);
              const frameBytes = await writeUpstreamErrorFrame(
                stream,
                truncErr,
                protocol,
                ctxBase.model,
                outcome,
              );
              captureInjectedFrame(frameBytes);
            }
            return;
          }
          // D96 Phase 1 — `value` is the RAW upstream chunk here, before decode
          // and translation, so the first-byte stamp means the same thing on both lanes.
          noteUpstreamBytes(value.byteLength);
          for (const event of decodeSseChunk(value, decoderState)) {
            // D99(c) — the join key, captured from the UPSTREAM event, BEFORE
            // the transform. Two things about the placement are deliberate:
            //
            //   1. `decodeSseChunk` yields the parsed UPSTREAM events, and this
            //      is the only place on this lane where the upstream shape is
            //      visible as an object. Reading `result.events_out` below would
            //      record a translator-minted id (see `peekUpstreamEvent`).
            //   2. It sits OUTSIDE the transform-phase `try`, so a capture bug
            //      can never be branded a transform failure and misclassified
            //      `internal_error` (500).
            if (peek !== undefined) peekUpstreamEvent(event, peek);
            // F2 (remediation) — see the final-flush loop: brand a transform/
            // encode-phase throw so the outer catch classifies it internal_error
            // (500), not upstream_error (502). stream.write stays outside.
            //
            // F5 (H5) — pair each encoded frame with its terminal-ness so
            // `sawTerminal` is committed only AFTER the bytes are written (never
            // during `.map()`).
            let encodedFrames: Array<{
              bytes: Uint8Array;
              isTerminal: boolean;
            }>;
            try {
              const result = applyEvent(
                { ...ctxBase, event, state: streamState },
                rules as Rule[],
                registrySnapshot,
              );
              encodedFrames = result.events_out.map((outEvent) => ({
                isTerminal: isOutboundTerminalEvent(outEvent, protocol),
                bytes: encodeSseEvent(outEvent),
              }));
              // W2 smart-peek — update the content-phase / Anthropic thinking
              // state from the OUTBOUND (post-translation) events so the NEXT
              // read selects the right window. No-op when stall detection is off.
              if (peek !== undefined) {
                for (const outEvent of result.events_out) {
                  peekOutboundEvent(outEvent, protocol, peek);
                }
                // Slice (b) — stamp the first-CONTENT instant HERE, the instant
                // the detector's phase actually flips as the detector
                // experiences it. Exactly one call per lane; the verbatim twin
                // sits in `endOfLine`.
                noteContentPhase();
              }
            } catch (err) {
              // H3 — a primitive, frozen, or sealed throw cannot carry the
              // transform-phase brand (markTransformPhase brands only EXTENSIBLE
              // objects). Mark first; if the brand did not take, wrap in a fresh
              // branded Error so the outer catch classifies it internal_error
              // (500), not upstream_error (502). An extensible EngineAbort502Error
              // IS branded but is excluded from the internal branch by name in
              // the outer catch, so it stays 502.
              const marked = markTransformPhase(err);
              if (isTransformPhaseError(marked)) throw marked;
              throw markTransformPhase(
                new Error(`transform-phase failure: ${safeStringify(err)}`),
              );
            }
            for (const { bytes: encoded, isTerminal } of encodedFrames) {
              // F165 — a write is in flight, so the wire is NOT at an event
              // boundary; `encodeSseEvent` always terminates `\n\n`, so a
              // RETURNED write puts it back at one. The final-flush loop above
              // deliberately does not maintain this: the race is never re-entered
              // after `done`, so the flag can no longer be read.
              atEventBoundary = false;
              await stream.write(encoded);
              atEventBoundary = true;
              // F5 (H5) — terminal bytes delivered → commit sawTerminal AFTER
              // the write resolves (parity with the final-flush block).
              if (isTerminal && !sawTerminal) sawTerminal = true;
              // Phase 5 v3.1 Group C — capture POST-translation bytes (per-
              // event path; mirrors the final-flush block above).
              if (traceEnabled) {
                bytesActuallyReceived += encoded.byteLength;
                if (bytesAccumulated + encoded.byteLength <= capBytes) {
                  buffer.push(encoded);
                  bytesAccumulated += encoded.byteLength;
                } else if (!warnedOverflow) {
                  warnedOverflow = true;
                  droppedAnyBytes = true; // F6 — a REAL upstream chunk was dropped
                  consola.warn(
                    `trace: stream ${requestIdLabel(ctxBase)} exceeded ${capMb}MB buffer at ${bytesActuallyReceived} bytes received; event_counts will undercount`,
                  );
                }
              }
              incCounter(
                "copilot_proxy_response_bytes_total",
                encoded.byteLength,
                { route: ctxBase.metricRoute },
              );
              incCounter("copilot_proxy_stream_events_total", 1, {
                route: ctxBase.metricRoute,
              });
            }
          }
        }
      } catch (err) {
        // Per M4 fix: distinguish I/O errors from transform errors. Headers
        // are already sent at this point so we cannot synthesize an HTTP
        // error response — close the stream cleanly and rely on
        // observability via debug.on traces.
        //
        // F2 (remediation) — read the name via the TOTAL `safeErrorName` (a
        // bare `?.name` still throws on a hostile `get name()` getter / Proxy
        // trap, which would escape this catch → no error frame written).
        const errName = safeErrorName(err);
        if (
          errName.startsWith("EngineAbort") ||
          errName === "UnregisteredRuleError" ||
          errName === "RuleSchemaInvalidError"
        ) {
          debug.on(
            LEVEL_ON,
            () =>
              // F2 — `formatErrorChain` is total; a bare `(err as Error).message`
              // would throw on a hostile message getter and escape the catch.
              `forwardStreamTranslated: transform error ${errName}: ${formatErrorChain(err)}`,
          );
        }
        // Errors are surfaced to the client as a protocol-shaped SSE error
        // event below (parity with forwardStream); we still cannot synthesize
        // an HTTP error response (headers already sent). Classify the outcome
        // for the requests_total status label. Client-abort wins first (inbound
        // socket close OR downstream stream teardown) -> 499. F4 — internal
        // transform errors (EngineAbort500Error / UnregisteredRuleError /
        // RuleSchemaInvalidError) are proxy-internal (HTTP 500), NOT a bad
        // gateway; everything else (upstream socket reset, EngineAbort502Error,
        // decode error) -> 502. The verbatim path has no transforms, so it can
        // never produce internal_error and stays exempt.
        //
        // F3 (H2) — precedence mirrors the verbatim catch: client_abort is the
        // label ONLY for an abort-shaped throw under an active abort flag (a
        // real client-teardown). A non-abort throw coincident with an abort is
        // surfaced as the upstream/internal failure it is, not masked as 499.
        //
        // F2 (remediation) — classify by PHASE, not only by name: a throw
        // branded by `markTransformPhase` came from the transform/encode step
        // (applyEvent → encodeSseEvent — e.g. a circular-ref event makes
        // encodeSseEvent's JSON.stringify throw a TypeError, whose name is NOT
        // in INTERNAL_ERROR_NAMES). Such a throw is proxy-internal (500), so it
        // joins the INTERNAL_ERROR_NAMES branch instead of falling through to
        // the upstream_error (502) default. EXCEPTION: EngineAbort502Error is
        // also thrown from the transform phase (a rule's `on_error:
        // abort_with_502`) and IS branded, but it carries an explicit bad-gateway
        // policy — it must stay upstream_error (502), so it is excluded from the
        // transform-phase → internal reclassification and falls through below.
        const INTERNAL_ERROR_NAMES = new Set([
          "EngineAbort500Error",
          "UnregisteredRuleError",
          "RuleSchemaInvalidError",
        ]);
        if (
          (clientSignal.aborted || stream.aborted) &&
          isAbortError(err) &&
          // iter7 [3] — a branded transform-phase failure (proven proxy-internal,
          // e.g. an encode-step throw whose `.name` happens to be "AbortError")
          // must NOT be masked as a client abort merely because it is abort-named
          // and an abort flag is set. Exclude it here so it falls through to the
          // internal branch (500 + frame). EngineAbort502Error is transform-
          // branded too but carries an explicit bad-gateway policy, so it is NOT
          // excluded here — it stays on the upstream_error (502) path below.
          !(isTransformPhaseError(err) && errName !== "EngineAbort502Error")
        ) {
          outcome = "client_abort";
        } else if (sawTerminal) {
          // H5 — the translator already emitted a clean success-terminal event
          // (message_stop / response.completed); a later read()/transform throw
          // is post-completion noise. The message is complete — do NOT inject a
          // duplicate terminal error frame. Checked BEFORE the internal/upstream
          // classification so a post-terminal error resolves to success.
          outcome = "success";
        } else if (
          INTERNAL_ERROR_NAMES.has(errName) ||
          (isTransformPhaseError(err) && errName !== "EngineAbort502Error")
        ) {
          outcome = "internal_error";
          // F5 — log with the `requestId` param directly (ctxBase.traceMeta is
          // undefined when tracing is off, which would log "<unknown>").
          consola.error(
            `stream ${requestId}: internal transform error ${errName} — ${formatErrorChain(err)}`,
          );
          const frameBytes = await writeUpstreamErrorFrame(
            stream,
            err,
            protocol,
            ctxBase.model,
            outcome,
          );
          captureInjectedFrame(frameBytes);
        } else {
          outcome = "upstream_error";
          // F5 — operator log for the translated mid-stream failure (parity
          // with the verbatim forwarder's catch). Uses `requestId` directly so
          // it is correct even when tracing is off. EngineAbort502Error lands
          // here (a genuine bad gateway), NOT in the internal branch above.
          consola.error(
            `stream ${requestId}: upstream mid-stream failure — ${formatErrorChain(err)}`,
          );
          const frameBytes = await writeUpstreamErrorFrame(
            stream,
            err,
            protocol,
            ctxBase.model,
            outcome,
          );
          captureInjectedFrame(frameBytes);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
        clientSignal.removeEventListener("abort", onAbort);
        // Always release per-stream state, even on abort/error. Lazy GC in
        // sse-state.ts is the safety net; explicit release here is primary.
        releaseStreamState(requestId);
        // W2 — cancel any armed stall timer so its (unref'd) setTimeout does not
        // linger past stream teardown. Idempotent; no-op when stall is off.
        // F165 — the keep-alive owns a SEPARATE timer instance, so it needs its
        // own cancel; cancelling one never cancels the other.
        stallTimer?.cancel();
        keepAlive?.timer.cancel();
      }
    } finally {
      // M12.5 H2 — stream-lifecycle ownership: parity with forwardStream
      // (the wrapping withMetrics middleware skips inflight decrement +
      // requests_total for streams). M12.6 H1-NEW — moved to OUTER finally
      // so the null-body early-return path also decrements (no inflight
      // leak). Note: for null-body case `acquireStreamState` was never
      // called, so `releaseStreamState` is correctly skipped (it lives in
      // the inner finally which only runs after a successful acquire).
      // M12.6 M1-NEW — `outcome` set in inner catch (default "success").
      recordStreamCompletion(ctxBase.metricRoute, outcome, {
        ctxBase,
        protocol,
        startedMs: incidentStartedMs,
        firstByteMs: incidentFirstByteMs,
        bytesReceived: incidentBytes,
        maxSilenceMs: incidentMaxSilenceMs,
        lastByteMs: incidentLastByteMs,
        inflightAtStart: incidentInflightAtStart,
        peek,
        maxDetectorWaitMsByPhase: incidentMaxDetectorWaitByPhase,
        censoredWaitPhase: incidentCensoredWaitPhase,
        censoredWaitMs: incidentCensoredWaitMs,
        firstContentMs: incidentFirstContentMs,
        contentObservable,
      });
      // Phase 5 v3.1 Group C — emit trace flow record (mirrors verbatim
      // forwarder; no-op when traceWriter/traceMeta unset).
      // F6 — `droppedAnyBytes` is the body_truncated signal: true iff a REAL
      // post-translation chunk was dropped at the cap. The injected terminal
      // error frame tipping the cap does NOT set it. `warnedOverflow` stays
      // solely the one-shot dedup guard for the consola.warn.
      emitTraceFlow(
        ctxBase,
        buffer,
        outcome,
        upstreamHeadersForTrace,
        droppedAnyBytes,
      );
    }
  };
}
