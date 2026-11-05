/**
 * metrics.ts — framework-agnostic Prometheus-text-format metrics store.
 *
 * **M12 Group A § 1.** Pure functions over a module-level Map store; no Hono
 * dependency. Renders canonical Prometheus text 0.0.4 format on demand.
 *
 * **Surface.**
 *   - `incCounter(name, delta?, labels?)` — monotonic counter increment.
 *   - `setGauge(name, value, labels?)` — last-write-wins gauge.
 *   - `boundedLabelValue(key, value, limit?)` — hard per-key ceiling on the
 *     number of distinct label values that can ever be emitted.
 *   - `renderPrometheus()` — emit `text/plain; version=0.0.4` body.
 *   - `resetForTests()` — wipe internal state (test-only; production callers
 *     should never reach for it).
 *
 * **Always-on gauges.** Per spec § Group A § 1, three system-level gauges
 * emit even before any counter is touched:
 *   - `copilot_proxy_token_status`           — 0=starting, 1=ready, 2=failed
 *   - `copilot_proxy_process_uptime_seconds` — `Math.floor(performance.now()/1000)`
 *   - `copilot_proxy_process_resident_memory_bytes` — `process.memoryUsage().rss`
 *
 * The first two are server-set (token-manager.ts + module-level startupTime in
 * server.ts); the memory + uptime gauges are computed lazily at render time.
 *
 * **Label-value escaping.** Backslash, double-quote, newline rendered as
 * `\\`, `\"`, `\n` per Prometheus text spec.
 *
 * **Initial state.** Counters emit only after first `incCounter` call (per
 * Prometheus convention — un-touched series are absent). The three always-on
 * gauges always emit.
 */

// ---------------------------------------------------------------------------
// Types + internal store
// ---------------------------------------------------------------------------

// The ONLY import in this module, and it is deliberately from the one place
// that cannot create a cycle: `error.ts` is framework-free and has zero
// top-level imports of its own. It is needed because `classifyDispatchFailure`
// (below) discriminates on error TYPE, not on a string.
import {
  HTTPError,
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "~/lib/error.ts";

export type LabelValues = Readonly<Record<string, string>>;

interface MetricMeta {
  /** Help text rendered in `# HELP` line. */
  readonly help: string;
  /** Drives the `# TYPE` line. */
  readonly type: "counter" | "gauge" | "histogram";
}

/**
 * Internal store layout: per metric name, a Map keyed by the canonical label
 * encoding ("k1=v1,k2=v2" with sorted keys + escaped values) → numeric value.
 * Counters add; gauges overwrite. Empty-label series use the empty-string key.
 */
const metricValues: Map<string, Map<string, number>> = new Map();
const metricMeta: Map<string, MetricMeta> = new Map();

/**
 * Process startup timestamp, captured at module load. `performance.now()`
 * returns ms-since-process-start so floor(now/1000) gives integer seconds.
 * Module-level capture per D38 iter-2 L1 fix (no DI).
 */
const startupTime = performance.now();

// ---------------------------------------------------------------------------
// Built-in metric registration (defines help + type for the canonical set)
// ---------------------------------------------------------------------------

function registerMeta(
  name: string,
  type: "counter" | "gauge" | "histogram",
  help: string,
): void {
  metricMeta.set(name, { type, help });
}

registerMeta(
  "copilot_proxy_requests_total",
  "counter",
  "Total HTTP requests served by route + status.",
);
registerMeta(
  "copilot_proxy_response_bytes_total",
  "counter",
  "Total bytes written to response bodies (non-stream content-length OR streamed chunk byte sum) by route.",
);
registerMeta(
  "copilot_proxy_stream_events_total",
  "counter",
  "Total upstream SSE events forwarded (verbatim or translated) by route.",
);
registerMeta(
  "copilot_proxy_token_refresh_total",
  "counter",
  "Total Copilot token refresh attempts grouped by outcome.",
);
registerMeta(
  "copilot_proxy_inflight_requests",
  "gauge",
  "Currently in-flight requests by route.",
);
registerMeta(
  "copilot_proxy_token_status",
  "gauge",
  "TokenManager status: 0=starting, 1=ready, 2=failed.",
);
registerMeta(
  "copilot_proxy_process_uptime_seconds",
  "gauge",
  "Seconds since proxy process startup (computed lazily at scrape time).",
);
registerMeta(
  "copilot_proxy_process_resident_memory_bytes",
  "gauge",
  "Resident set size of the proxy process at scrape time (bytes).",
);

// ---------------------------------------------------------------------------
// Phase 5 v3.1 — F-DISC-14 trace-write health counters.
//
// Three counters surface the post-write outcome of the TraceWriter so
// operators can spot disk-pressure / permission failures from the
// /metrics scrape without scanning logs. Wired by both the streaming
// forwarder (`forwardStream` / `forwardStreamTranslated`, this group)
// and the non-streaming `withTrace` middleware (Group B). Use the
// `bumpTraceWrites` ergonomic helper rather than calling `incCounter`
// directly so call sites stay one-liners in tight `finally` / `catch`
// blocks.
// ---------------------------------------------------------------------------

registerMeta(
  "copilot_proxy_trace_writes_total",
  "counter",
  "Total trace flow records written to disk by result (success|error).",
);
registerMeta(
  "copilot_proxy_trace_bytes_written_total",
  "counter",
  "Total bytes of JSON-stringified flow records written to disk.",
);
registerMeta(
  "copilot_proxy_trace_errors_total",
  "counter",
  "Total trace-write errors by kind (enospc|eacces|other).",
);

// A counter needs NO registration to render as valid exposition — the renderer
// already defaults an unknown name to `# TYPE <name> counter`. Registration
// supplies only the `# HELP` text; without it the line reads
// "<name> (no help registered)." (verified by rendering, this session).
registerMeta(
  "copilot_proxy_stream_no_first_byte_total",
  "counter",
  "Total upstream streams that completed without ever yielding a first non-empty chunk, by route and model.",
);

// F165 / D96 Amendment 1 — the proxy-emitted SSE keep-alive comment.
//
// The two EXCLUSIONS belong in the HELP text and not only in a doc, because
// they are the kind of omission a later reader "fixes" back: a keep-alive
// comment is not an SSE event and its bytes are not upstream output, so folding
// it into either family would inflate that family in proportion to how badly a
// stream is stalling — the metric would rise fastest exactly when the thing it
// describes is not happening.
registerMeta(
  "copilot_proxy_stream_keepalives_total",
  "counter",
  "Total proxy-emitted SSE keep-alive comments written to clients, by route and model. DELIBERATELY EXCLUDED from two other families: a comment is not an SSE event, so it is not in copilot_proxy_stream_events_total, and its bytes are proxy-injected rather than upstream output, so they are not in copilot_proxy_response_bytes_total (which therefore under-counts the wire by 13 bytes per increment here). Emitted only from inside the stall detector's race, so it is zero on every stream that never went byte-silent, and zero whenever logging.stall_detection is off.",
);

// D99(c) — the join-key capture outcome, one increment per stream.
//
// Without a counter that separates "a message_start was seen and its id was
// REJECTED" from "no message_start was seen at all", a 100% rejection rate
// after the next backend era change is invisible on the fleet: the incident
// records simply stop carrying the field and nothing says why. That is the same
// silent return to session granularity D96 was written about, and the shape
// guard is the component most likely to go stale — it already failed once
// against this repo's own captured `msg_vrtx_` id (F166).
registerMeta(
  "copilot_proxy_upstream_msg_id_total",
  "counter",
  "Total streams by the outcome of the UPSTREAM Anthropic message_start id capture (the D99(c) join key), by route, model and result. EXACTLY ONE increment per stream that reached the forwarder, emitted for every stream including successes, so the four result values PARTITION that population. captured = a message_start was seen and its id passed the shape guard, so the id is on the incident record for a non-success stream. rejected = a message_start was seen and its id FAILED the guard, which includes an id pushed past STALL_PEEK_CAP=200 by an upstream key-order change. absent = no message_start was seen; this is CORRECT and expected for every Responses-upstream lane by construction, and is also the case for a stream that died before its first byte. not_observed = stall detection is off, so no smart-peek existed and nothing looked — a distinct value rather than no emission at all, because dropping those streams would censor the denominator, this project's most-repeated defect. The reading is rejected / (captured + rejected) per (route, model), and it MUST be taken per model: route=messages carries BOTH the Anthropic-upstream lane (expect captured) and the Responses-upstream Lane 4 (expect absent), so route alone cannot reveal a 100% rejection.",
);

// F159 — the header-phase population, which NO stream-level series can see.
//
// A request whose upstream header phase fails returns via the handler's
// dispatch `catch` and never reaches the forwarder at all, so it contributes
// to NEITHER first-byte histogram AND NOT to
// `copilot_proxy_stream_no_first_byte_total` either — the counter above counts
// streams that STARTED. That excluded exactly the long pre-header hangs the
// dispatch-anchored origin exists to see, which is why this counter lands in
// the same change.
registerMeta(
  "copilot_proxy_dispatch_no_upstream_total",
  "counter",
  "Total requests that entered the dispatch phase and never obtained an upstream stream, by route, model and reason. EXCLUDES pre-dispatch rejections (400 invalid_json, 404 no_route, 503 auth gate / auth_pending) — those never opened an upstream connection — and EXCLUDES a successful NON-STREAMING upstream response. It is therefore neither derivable from nor summable with copilot_proxy_requests_total.",
);

// F159 / D100 — the defect signal for the dispatch anchor itself.
//
// `observeHistogram` DROPS a non-finite or negative sample silently, so a
// broken withMetrics → handler → StreamCtxBase thread would censor the new
// histogram invisibly — the same class of defect, arriving through the very
// metric built to fix its previous recurrence. This counter converts that
// silent loss into a visible one, the pattern
// `copilot_proxy_stream_no_first_byte_total` established.
registerMeta(
  "copilot_proxy_dispatch_anchor_missing_total",
  "counter",
  "Streams that produced a first byte but carried no usable dispatch anchor, so they contributed no copilot_proxy_dispatch_first_byte_seconds sample, by route. Expected to be ZERO in production: a non-zero value means the withMetrics -> handler -> StreamCtxBase thread is broken and that histogram's denominator is silently short.",
);

// ---------------------------------------------------------------------------
// D96 Phase 1 — latency + silence + request-size histograms.
//
// These exist because EVERY threshold in the timeout ladder is currently a
// guess. The proxy had an inflight gauge and byte counters but no latency
// distribution of any kind, so "what does the proxy see about time-to-first-
// token under concurrency" was unanswerable BY MEASUREMENT — which is exactly
// how a 180 s client watchdog came to sit at the maximum of the healthy
// population's own gap distribution, cutting the tail off SLOW without
// separating broken from working (D96 rule 3: instrument before tuning).
//
// A histogram is stored as three ordinary series families — `_bucket` (with an
// `le` label, cumulative), `_sum` and `_count` — so the existing counter store
// needs no new value type. The renderer groups them back under the base name.
// ---------------------------------------------------------------------------

/** Bucket boundaries per registered histogram, ascending, WITHOUT `+Inf`. */
const histogramBuckets: Map<string, ReadonlyArray<number>> = new Map();

function registerHistogram(
  name: string,
  help: string,
  buckets: ReadonlyArray<number>,
): void {
  registerMeta(name, "histogram", help);
  histogramBuckets.set(name, buckets);
}

/**
 * POST-HEADER time-to-first-upstream-byte. Its clock starts when the stream
 * callback begins — i.e. AFTER the upstream response headers have already been
 * received — so it EXCLUDES the header phase entirely.
 *
 * ⚠ **This metric was called `copilot_proxy_ttfb_seconds` until F159, and the
 * old name invited an end-to-end reading it never supported.** The header phase
 * is the dominant latency term (D56: median 8.5 s, tail 37.9 s; D58: ~290-302 s
 * — all of it upstream of this origin), and a live scrape showed `_sum` 0.00196 s
 * over `_count` 6, ~0.3 ms per stream, which is impossible end-to-end. For the
 * end-to-end figure use `copilot_proxy_dispatch_first_byte_seconds`, whose clock
 * is stamped at proxy request entry; the two differ by exactly the header phase.
 *
 * ⚠ **NO boundary here carries a client-watchdog reading.** An earlier revision
 * of this docblock said `le="180"` "sits at the harness watchdog", so
 * `bucket{le="180"} / _count` read as the fraction of streams that answered
 * before the watchdog would fire. That is FALSE on two independent grounds:
 * this clock starts post-header, so 180 s here is not 180 s of client-visible
 * wait; and the watchdog claim is not this series' to make in the first place.
 * The boundaries are retained unchanged so historical samples stay comparable —
 * they are ordinary distribution boundaries, nothing more.
 *
 * ⚠ **`_count` is a CENSORED denominator — answering streams only — so any
 * bucket-over-count ratio is NOT a fraction of all streams.** 50 timely answers
 * plus 50 streams that never produced a byte reads 100 % here against a true
 * 50 %. The full-population form adds the counter holding the excluded streams:
 *
 *     upstream_first_byte_bucket{le="N"}
 *       / (upstream_first_byte_count + stream_no_first_byte_total)
 *
 * See `docs/runbook.md` § "Reading the first-byte histograms — the denominator
 * is CENSORED" for the absent-safe PromQL. An earlier revision of this docblock
 * said the bucket-over-count form "reads directly as" the fraction of streams —
 * the exact censored-denominator defect this metric's own HELP text warns about
 * a few lines below, and the defect this whole remediation arc was about.
 * Caught by the round-5 gate in the metric ADJACENT to the one round 4 fixed
 * (F154 — a correction's blast radius is not the set of sites the gate names).
 */
registerHistogram(
  "copilot_proxy_upstream_first_byte_seconds",
  "Seconds from the START OF THE STREAM CALLBACK (upstream response headers already received) to the first non-empty upstream chunk, by route and model. It EXCLUDES the upstream header phase, which is the dominant latency term — use copilot_proxy_dispatch_first_byte_seconds for the end-to-end figure. ANSWERING streams only — a stream that never produced a byte is counted by copilot_proxy_stream_no_first_byte_total instead, so _count is a censored denominator; add that counter before deriving any fraction.",
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300, 600],
);

/**
 * END-TO-END time-to-first-upstream-byte: the same endpoint as the series above
 * measured from a strictly earlier origin — proxy request entry, stamped in the
 * `withMetrics` wrapper before the request body is read. The two differ by
 * exactly the upstream header phase, which is what makes subtracting them
 * meaningful, and why both carry the SAME bucket boundaries: a different bucket
 * set would force interpolation to compare them.
 *
 * ⚠ **First UPSTREAM byte, not first CLIENT byte.** These are the same event
 * today. They will stop being the same the moment a keep-alive frame is written
 * downstream ahead of the upstream answer — at which point the client's first
 * byte is something this proxy wrote, and reading this series as client-visible
 * latency becomes the next false claim. Stated here so it cannot be arrived at
 * by inference later.
 *
 * ⚠ **Two populations are excluded, and BOTH must be added back before any
 * fraction is derived** — not one, which is the defect this metric exists to
 * stop recurring:
 *   - a stream that started but never produced a byte →
 *     `copilot_proxy_stream_no_first_byte_total`;
 *   - a request that never reached a stream AT ALL — including a header phase
 *     that hung until the 20-minute upstream deadline, or a client that gave up
 *     first → `copilot_proxy_dispatch_no_upstream_total`. That population is
 *     invisible to the post-header series by construction, since it never
 *     entered the forwarder.
 *
 * No boundary here carries a watchdog interpretation either. See the note on
 * the series above for why that reading was retired rather than re-homed.
 */
registerHistogram(
  "copilot_proxy_dispatch_first_byte_seconds",
  "Seconds from PROXY REQUEST ENTRY (stamped by the withMetrics wrapper, before the request body is read) to the first non-empty upstream chunk, by route and model. INCLUDES the upstream header phase, unlike copilot_proxy_upstream_first_byte_seconds. Measures the first UPSTREAM byte, not the first CLIENT byte. Two populations are excluded: a stream that produced no byte is counted by copilot_proxy_stream_no_first_byte_total, and a request that never obtained an upstream stream at all by copilot_proxy_dispatch_no_upstream_total; add BOTH before deriving any fraction.",
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300, 600],
);

/**
 * The LARGEST byte-silent gap within a single stream, observed once at
 * completion rather than per chunk.
 *
 * Per-gap observation would be thousands of histogram writes on a busy SSE
 * stream to answer a question about the maximum.
 *
 * ⚠ **This is a TRIAGE upper bound. Do NOT derive a stall-detector threshold
 * from it.** An earlier revision of this docblock called the max "the statistic
 * the stall windows are actually tuned against" and cited a peer's hand-computed
 * gaps (115,133,141,152,161,168,169,180 s) as the precedent. That was withdrawn
 * — the round-3 cross-family gate refuted the claim that this metric and the
 * detector observe the same span, and the round-4 gate caught this docblock
 * still asserting it four lines above the HELP text that says the opposite.
 * ⚠ **The divergences below are the ones MEASURED SO FAR. This list is NOT
 * known to be complete, and they do NOT all point the same way.** Each gate
 * round that looked for another found one — round 3 found two, round 4 a third,
 * round 5 a fourth that reverses the direction — so treat the enumeration as
 * evidence for the prohibition, never as a bound on it:
 *
 *   1. Local work between the two marks is inside this interval and outside the
 *      detector's — the chunk is stamped before SSE decode/translate/encode (on
 *      the translated lane) and before `await stream.write(value)` on both, so
 *      client backpressure and our own processing are counted as "silence".
 *   2. Post-terminal the detector is not armed at all (its race is gated on
 *      `!sawTerminal`), while the final-gap fold has no such gate.
 *   3. The detector's PHASE boundary is `peek.contentStarted` (a content delta),
 *      while this metric's gaps begin at the first non-empty RAW chunk. So the
 *      `message_start` → first-delta window, and every gap inside a thinking
 *      block, are counted here while the detector applies the GENEROUS
 *      no-response budget. This metric therefore mixes gaps governed by three
 *      different detector phases.
 *   4. **The FIRST read is raced but contributes no gap — so here the metric
 *      reads SHORTER than the detector.** `noteUpstreamBytes` stamps `firstByteMs` on
 *      the first chunk and starts accumulating gaps only from the second, while
 *      the read loop arms the detector around that first `reader.read()` too. An
 *      upstream silent for 100 s that then emits one terminal chunk and closes
 *      gives a ~100 s detector-active wait against a near-zero max silence.
 *
 * Deriving a window needs detector-active await time measured AT THE RACE SITE.
 * `copilot_proxy_detector_max_wait_seconds{phase}` now provides exactly that,
 * sliced by the budget in force, and `copilot_proxy_first_content_seconds`
 * provides the first-CONTENT latency this metric cannot own (divergence 3) —
 * which is NOT the same as the budget switch; read that family's docblock. Use
 * those; the prohibition above is unchanged, and none of the divergences
 * enumerated above is retired by their existence. See `docs/runbook.md`
 * § "What `max_silence` spans" and D97 Amendment 2.
 */
registerHistogram(
  "copilot_proxy_stream_max_silence_seconds",
  "Largest INTER-BYTE gap observed within one upstream stream, by route and model. ANSWERING streams only. UPPER BOUND on upstream silence, not a measurement of it: chunks are timestamped when read and the final gap runs to completion, so translation, downstream writes, client backpressure and post-terminal idle are included. It also MIXES gaps governed by all three stall-detector phases (no-response, thinking, response), so no single detector window can be derived from it — see docs/runbook.md, 'What max_silence spans'.",
  [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300, 600],
);

/**
 * Inbound request size. A counter would give only a mean; the distribution is
 * what answers whether a retry chain re-sends an accumulated transcript —
 * strictly larger bodies across attempts means the retry spiral is real.
 */
registerHistogram(
  "copilot_proxy_request_bytes",
  "Inbound request body size in bytes (from content-length), by route. STREAMING requests only: it is observed at stream completion, so a non-streaming request contributes no sample.",
  [
    1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000,
    5_000_000,
  ],
);

/**
 * D97 Amendment 4 — DETECTOR-ACTIVE await time, measured at the race site. This
 * is the quantity no other family can supply: `max_silence` mixes all three
 * detector budgets, and neither first-byte series ends where the detector's
 * phase flips.
 *
 * **The statistic is a per-stream MAX, one sample PER PHASE ENTERED**, so the
 * series answers "distribution of per-stream WORST waits", not "distribution of
 * waits". That is the right statistic for sizing a window — a window has to
 * survive the worst read in a stream, and one exceedance kills the stream — but
 * it is not interchangeable with a percentile over all reads, and a reader who
 * treats it as one will size the window too tightly.
 *
 * ⚠ **RIGHT-CENSORED samples are EXCLUDED, not recorded.** When the stall timer
 * wins the race the read is orphaned, so its true wait is unknown and merely
 * `>= window`. Recording the elapsed ~window indistinguishably from a completed
 * wait would make a p99 read back the configured window and look like saturated
 * demand. The censored phase contributes NO sample AT ALL — not even the max
 * over that phase's completed reads, which would be a known underestimate of
 * the stream's worst wait in it — and ticks
 * `copilot_proxy_detector_wait_censored_total{phase}` instead. The two families
 * are therefore a PARTITION of stream×phase entries: exactly one fires per
 * phase entered, never both, so `_count + censored_total` is the number of
 * streams that entered that phase.
 *
 * **THE HEADLINE READING — the fraction that HIT the window.** Per phase:
 *
 *     censored_total{phase=P} / ( _count{phase=P} + censored_total{phase=P} )
 *
 * That is the fraction of streams entering phase P whose worst wait reached the
 * window in force, i.e. the streams the window killed. It is the tuning signal:
 * a window is too tight exactly when that fraction is larger than the failure
 * rate the operator will accept.
 *
 * ⚠ **`bucket{le=<that phase's own window>} / _count` is IDENTICALLY 1 and MUST
 * NOT be used.** A wait that reaches the window loses the race to the stall
 * timer and is censored out of this family, so every surviving sample is
 * strictly BELOW the window in force — by construction, on every box, at every
 * scrape, whatever upstream is doing. A previous revision of this docblock
 * advertised `bucket{le="600",phase="response"} / count{phase="response"}` as
 * "fraction of response-phase waits that fit inside the current tight window"
 * and called the boundary alignment "the entire reason the bucket-over-count
 * form is readable"; that alignment is exactly what makes the ratio degenerate.
 * Do not re-derive it.
 *
 * **What the distribution CAN do: size a TIGHTER window.** It is the
 * distribution of COMPLETED waits, so `bucket{le=X}/_count` for X strictly below
 * the phase's window answers "what fraction of this phase's worst waits would
 * still have fitted if the window were X". At the schema defaults that means
 * boundaries up to 300 for `phase="response"` (window 600 s) and up to 900 for
 * the three phases on the generous budget (window 1140 s); every boundary at or
 * above a phase's own window equals `_count` for that phase.
 *
 * **Why 1800 is here.** NOT to catch stall samples — the sentence it replaces
 * said "1800 sits above both so a stall sample, which lands just ABOVE its own
 * window, is not swept into `+Inf`", and stall samples never enter this family
 * at all. It is retained as HEADROOM for a retuned `response_wait_ms`, which
 * `config-schema.ts` does not bound above; it is unreachable for the three
 * generous-budget phases under ANY valid config, because `no_response_wait_ms`
 * is schema-capped at 1_199_000 ms.
 *
 * ⚠ **The 600 and 1140 boundaries are PINNED TO THE SCHEMA DEFAULTS, not
 * tracked from the config.** `makeStallConfig` reads both windows from
 * `logging.stall_detection`, so an operator who retunes either one moves the
 * window without moving the boundary — and then boundaries below the new window
 * become live where they were dead, or vice versa. Do not claim the boundary
 * follows the config. `tests/lib/metrics.test.ts` pins the two literals to the
 * schema defaults so a default change fails a test rather than silently
 * falsifying this paragraph.
 *
 * ⚠ **`phase="unobservable"` is NOT evidence about the pre-content phase.** It
 * means the generous no-response budget applied while the lane's smart-peek was
 * structurally incapable of seeing content at all (translated × `openai_chat`),
 * so the wait says nothing about how long content took.
 *
 * ⚠ **`phase="thinking"` can only ever appear on lanes whose CLIENT PROTOCOL is
 * `anthropic`.** Verified at source: `peekVerbatimLine` and `peekOutboundEvent`
 * both `return` from their `openai_responses` / `openai_chat` branches before
 * any code touches `inThinking`. That is a claim about the PROTOCOL, not about
 * the `route` label: `protocolFromMetricRoute` maps `messages` → `anthropic`,
 * and its `default:` arm ALSO returns `anthropic` (with a warn) for any
 * unrecognized `metricRoute`, so thinking-phase samples can appear under an
 * unexpected route label too. What holds structurally is the converse — no
 * thinking sample can appear under `route="responses"` or
 * `route="chat_completions"`.
 *
 * NO boundary here carries a client-watchdog reading — `le="180"` included. The
 * commit that retired that claim from the first-byte series must not author a
 * fresh copy of it on a new one.
 */
registerHistogram(
  "copilot_proxy_detector_max_wait_seconds",
  'Largest COMPLETED detector-active await within one upstream stream, by route, model and detector phase — one sample per phase ENTERED, so a phase never entered contributes nothing (never a zero). Observed only while the stall detector is armed, so post-terminal idle and detector-off streams contribute nothing at all. Per-stream MAX: this is the distribution of per-stream WORST waits, not of all waits. RIGHT-CENSORED phases (the stall timer won, so the true wait is only known to be >= the window) contribute NO sample at all and tick copilot_proxy_detector_wait_censored_total instead, so the two are a PARTITION: exactly one fires per phase entered, and _count + censored_total is the number of streams that entered that phase. HEADLINE READING: censored_total/(_count+censored_total) is the fraction of streams whose worst wait in that phase HIT the window. In PromQL that sum MUST use the absent-safe `or <other> * 0` form (see docs/runbook.md "Reading the detector-phase series") — binary arithmetic is a set intersection and an untouched series is absent, not zero, so a bare `+` returns NOTHING for a phase that is 100% censored, which is the case the ratio exists to surface. DO NOT use bucket{le=<that phase\'s own window>}/_count — every surviving sample is below the window in force by construction, so that ratio is identically 1; boundaries strictly BELOW the window size a TIGHTER window, and that is all this distribution can do. phase="unobservable" means the no-response budget applied to a lane whose smart-peek cannot observe content at all, so it is NOT evidence about the pre-content phase; phase="thinking" can only appear on lanes whose client protocol is anthropic (route="messages", plus any unrecognized route, which defaults to the anthropic shape). The 600 and 1140 boundaries are the SCHEMA-DEFAULT response/no-response windows and do not follow a retuned config.',
  [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 300, 600, 900, 1140, 1800],
);

/**
 * D97 Amendment 4 — seconds to the first CONTENT delta, stamped where the peek
 * state is updated (which is exactly what the detector's next read reads).
 *
 * ⚠ **This is NOT a first-BYTE series, and the difference is the whole reason it exists.**
 * `message_start` is a raw chunk and is not content. An upstream that emits
 * `message_start` at once and then thinks for 300 s has a first-byte figure near
 * zero and a first-CONTENT figure near 300 s, with the detector applying its
 * generous no-response budget throughout — `max_silence` divergence #3, which is
 * precisely the window nothing could size before this series.
 *
 * ⚠ **It is NOT the no-response → response BUDGET SWITCH either, and an earlier
 * revision of this HELP said it was.** `peek.contentStarted` flips on the first
 * `content_block_delta` of ANY kind, and on an Anthropic extended-thinking
 * stream that is a THINKING delta: `detectorPhaseOf` then returns `"thinking"`,
 * and `detectorPeriodFor` gives `"thinking"` the GENEROUS `noResponseWaitMs` —
 * deliberately, so a byte-silent redacted think cannot trip the tight budget.
 * The generous budget therefore continues past this stamp, and REVERTS to
 * generous on every later thinking block (`forward-stream-stall.test.ts` asserts
 * `armedPeriods` of `[1_140_000, 600_000, 1_140_000]` on exactly that shape).
 *
 * So: on traffic with no thinking blocks this stamp and the budget switch
 * coincide. On extended-thinking traffic they do not, and sizing
 * `no_response_wait_ms` from this series' p99 there would cut the generous
 * window to the length of a thinking stream's FIRST token — spurious 504s on
 * exactly the traffic the thinking phase was added to protect. For that traffic
 * use `copilot_proxy_detector_max_wait_seconds{phase="no_response"}` and
 * `{phase="thinking"}`, which measure the budget that was actually in force.
 *
 * Boundaries are `copilot_proxy_upstream_first_byte_seconds`'s list plus one
 * higher boundary (1200, above the 1140 s default pre-content budget), so the
 * two distributions are comparable bucket-for-bucket and their difference is the
 * `message_start` → first-delta window. Both are measured from the SAME origin —
 * forwarder entry — which is what makes subtracting them meaningful; pair it with
 * `upstream_first_byte`, never with the dispatch-anchored series.
 *
 * ⚠ **`_count` is a CENSORED denominator.** Only streams where content was
 * actually observed are samples. `copilot_proxy_stream_no_content_total` counts
 * every stream this family structurally excludes, and must be added back before
 * deriving any fraction — the same relationship
 * `stream_no_first_byte_total` has to the first-byte families, and the defect
 * class this project has now caught five times.
 *
 * NO boundary here carries a client-watchdog reading either.
 */
registerHistogram(
  "copilot_proxy_first_content_seconds",
  "Seconds from the START OF THE STREAM CALLBACK to the first CONTENT delta as the smart-peek classifies it, by route and model. NOT time-to-first-byte: message_start is a raw chunk and is not content, so an upstream that greets immediately and then thinks scores near zero on copilot_proxy_upstream_first_byte_seconds and near the think time here. NOT the no-response-to-response budget switch either: on an Anthropic thinking stream the first content delta is a THINKING delta, and the thinking phase keeps the GENEROUS budget and can revert to it repeatedly afterwards — so do not size no_response_wait_ms from this series on extended-thinking traffic; use copilot_proxy_detector_max_wait_seconds{phase} there. Observed ONLY for streams where content was observed, so _count is a CENSORED denominator: add copilot_proxy_stream_no_content_total before deriving any fraction.",
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300, 600, 1200],
);

// The population `copilot_proxy_first_content_seconds` structurally excludes —
// the same relationship `stream_no_first_byte_total` has to the first-byte
// histograms. Registration supplies only HELP (see the note above
// `stream_no_first_byte_total`), and this counter is useless without the reason
// semantics, so they are spelled out rather than left to the reader.
registerMeta(
  "copilot_proxy_stream_no_content_total",
  "counter",
  "Total streams that completed without a first CONTENT delta ever being observed, by route, model and reason — the population copilot_proxy_first_content_seconds structurally excludes. The three reasons are tested in this PRECEDENCE order: detector_off (stall detection is disabled, so nothing looked); lane_unobservable (the detector ran, but this lane's smart-peek cannot classify content at all — translated x openai_chat); never_started (the detector ran on a lane that CAN see content, and none arrived). The order matters: a blind lane with the detector off files as detector_off, because claiming lane_unobservable would assert knowledge about a lane nothing ever looked at. first_content_count + no_content_total is the true count of streams that reached the forwarder.",
);

// The population `copilot_proxy_detector_max_wait_seconds` deliberately drops:
// the phase whose wait was RIGHT-CENSORED by the stall timer winning the race.
// Without this counter that exclusion is invisible, which is the censored-
// denominator defect arriving through the detector series instead of the
// content series. It is also the NUMERATOR of that family's headline reading —
// see its docblock.
registerMeta(
  "copilot_proxy_detector_wait_censored_total",
  "counter",
  "Total stream-phases whose detector-active wait was RIGHT-CENSORED — the stall timer won the race, so the read was orphaned and its true wait is known only to be >= the window in force — by route, model and detector phase. At most one per stream: a stall arm terminates the stream. A censored phase contributes NO sample to copilot_proxy_detector_max_wait_seconds, not even the max over that phase's completed reads, because recording an elapsed ~window as if it were a completed wait makes a p99 read back the configured window and look like saturated demand, and publishing the completed max instead would be a known underestimate presented as a measurement. The two families PARTITION stream-phase entries: censored_total/(detector_max_wait_seconds_count + censored_total) is the fraction of streams entering that phase whose worst wait HIT the window, and that ratio — not any bucket-over-count form — is the tuning signal. That sum MUST be written with the absent-safe `or <other> * 0` fills (docs/runbook.md): PromQL binary arithmetic is a set intersection and an untouched series is absent rather than zero, so a bare `+` yields NO DATA precisely when a phase is 100% censored.",
);

// ---------------------------------------------------------------------------
// Bounded label values — structural cardinality ceiling.
//
// `docs/runbook.md` § Security GUARANTEES that "metric label values are bounded
// to a small canonical set". For `route` and `status` that is true by
// construction. For `model` it was NOT: the value is the client's requested
// model string, copied verbatim out of the parsed request body with no
// canonicalization and no bound, so a client looping over generated model names
// mints one new time series per name — permanently, since the store never
// evicts. This helper makes the guarantee structural rather than aspirational.
//
// WHY NOT THE UPSTREAM MODEL CATALOG (investigated and rejected — do not
// "fix" this back): `fetchModelCatalog` is called only from `main.ts`, writes
// its result to `meta.json`, and is deliberately non-fatal. It is not reachable
// from any request path, so validating against it would mean an async-populated
// global whose empty-or-failed state maps EVERY model to one value — a scrape
// that renders plausibly while measuring nothing, which is strictly worse than
// the unbounded label it replaced. A hard ceiling has no such failure mode: it
// needs no I/O, no startup ordering, and degrades only under the pathological
// input it exists to catch.
// ---------------------------------------------------------------------------

/**
 * Admitted distinct values per label key. Never evicted: the whole point is
 * that admission is monotonic, so the number of distinct values a key can ever
 * emit is fixed for the process lifetime.
 */
const labelValueBounds: Map<string, Set<string>> = new Map();

/** Value substituted once a key's distinct-value ceiling is reached. */
const OVERFLOW_LABEL_VALUE = "other";

/**
 * Clamp a label value to at most `limit` distinct values per `key`, for the
 * lifetime of the process.
 *
 * - Already admitted for this key → returned unchanged.
 * - Not admitted and the key is under `limit` → admitted, returned unchanged.
 * - Otherwise → `"other"`.
 *
 * So a key emits at most `limit` real values plus `"other"`, no matter what
 * arrives. Real model ids (a handful per deployment) always pass through
 * untouched; only pathological novelty collapses, which is exactly the case
 * that would otherwise grow the store without bound.
 *
 * Never throws. It runs inside metrics call sites that are themselves inside
 * request-path `finally` blocks, so a throw here would surface as a failed
 * request — a measurement helper must never be able to do that. Non-string
 * input (possible from an untyped JS caller, or a request body whose `model`
 * field parsed as a number) collapses to `"other"` rather than being coerced:
 * coercion would invent a label value that no client actually sent.
 */
export function boundedLabelValue(
  key: string,
  value: string,
  limit = 64,
): string {
  if (typeof key !== "string" || typeof value !== "string") {
    return OVERFLOW_LABEL_VALUE;
  }
  // A non-finite or non-positive limit admits nothing rather than everything:
  // a bad ceiling must fail toward the bound, not away from it.
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  let admitted = labelValueBounds.get(key);
  if (admitted === undefined) {
    admitted = new Set();
    labelValueBounds.set(key, admitted);
  }
  if (admitted.has(value)) return value;
  if (admitted.size >= cap) return OVERFLOW_LABEL_VALUE;
  admitted.add(value);
  return value;
}

/**
 * Wipe the admitted-value registry so a suite can exercise the ceiling
 * deterministically. TEST-ONLY — admission is deliberately monotonic in
 * production. Also invoked by `resetForTests()` so that function's "wipe all
 * metric state" contract stays true.
 */
export function resetLabelBoundsForTests(): void {
  labelValueBounds.clear();
}

// ---------------------------------------------------------------------------
// Label-key canonicalization + escaping
// ---------------------------------------------------------------------------

/**
 * Escape a label value per Prometheus text format spec:
 *   `\\` → `\\\\`, `"` → `\\"`, `\n` → `\\n`.
 */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Canonical key for a label set: sorted by label name; values escaped. Empty
 * label set → empty string.
 */
function labelsToKey(labels: LabelValues | undefined): string {
  if (labels === undefined) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const k of keys) {
    const v = labels[k];
    if (v === undefined) continue;
    parts.push(`${k}="${escapeLabelValue(v)}"`);
  }
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// Public mutators
// ---------------------------------------------------------------------------

/**
 * Increment a counter. Default delta = 1. Creates the per-label-set entry on
 * first touch (Prometheus-convention: un-touched series are absent).
 */
export function incCounter(
  name: string,
  delta: number = 1,
  labels?: LabelValues,
): void {
  const key = labelsToKey(labels);
  let series = metricValues.get(name);
  if (series === undefined) {
    series = new Map();
    metricValues.set(name, series);
  }
  const prior = series.get(key) ?? 0;
  series.set(key, prior + delta);
}

/**
 * Set a gauge to `value` (last-write-wins; absent labels means a single
 * un-labeled time series). Creates the per-label-set entry on first touch.
 */
export function setGauge(
  name: string,
  value: number,
  labels?: LabelValues,
): void {
  const key = labelsToKey(labels);
  let series = metricValues.get(name);
  if (series === undefined) {
    series = new Map();
    metricValues.set(name, series);
  }
  series.set(key, value);
}

/**
 * Read the current gauge/counter value for a label set (test helper). Returns
 * `undefined` if the series has not been touched. Production code should
 * never need this.
 */
export function getValueForTests(
  name: string,
  labels?: LabelValues,
): number | undefined {
  const series = metricValues.get(name);
  if (series === undefined) return undefined;
  return series.get(labelsToKey(labels));
}

/**
 * Wipe all metric state, including the bounded-label admitted-value registry.
 * TEST-ONLY.
 */
export function resetForTests(): void {
  metricValues.clear();
  resetLabelBoundsForTests();
}

// ---------------------------------------------------------------------------
// D96 Phase 1 — histogram observation + rendering.
// ---------------------------------------------------------------------------

/**
 * Format a bucket boundary for the `le` label. Prometheus compares `le`
 * lexically-as-a-float, so the value must round-trip as a number; `String(n)`
 * does that for every boundary registered here and keeps `0.1` from becoming
 * `0.1000000000000000055`.
 */
function formatLe(boundary: number): string {
  return String(boundary);
}

/**
 * Record one observation into a registered histogram.
 *
 * Buckets are CUMULATIVE per the Prometheus contract: an observation lands in
 * `le=b` for every boundary `b >= value`, plus `le="+Inf"` always. That is what
 * lets a consumer read `bucket{le="180"} / count` as a percentile without any
 * further arithmetic.
 *
 * A non-finite or negative observation is DROPPED rather than clamped: these
 * come from timing subtractions, and a clamped bogus sample silently biases the
 * very percentile the metric exists to establish. Unregistered names are also
 * dropped — the bucket set is part of a histogram's contract, so guessing one
 * would publish a distribution nobody declared.
 */
export function observeHistogram(
  name: string,
  value: number,
  labels?: LabelValues,
): void {
  const buckets = histogramBuckets.get(name);
  if (buckets === undefined) return;
  if (!Number.isFinite(value) || value < 0) return;

  for (const b of buckets) {
    // Touch EVERY bucket, incrementing only the ones this observation falls in.
    // Emitting only the matching buckets would leave the lower ones absent
    // rather than zero, and PromQL's `histogram_quantile` interpolates between
    // the buckets it can SEE: with le=0.1..5 missing, a median computed from a
    // single 8.5 s sample interpolates over [0, 10] instead of [5, 10]. The
    // scrape would look correct and the percentile — the metric's only purpose
    // — would be wrong.
    incCounter(`${name}_bucket`, value <= b ? 1 : 0, {
      ...labels,
      le: formatLe(b),
    });
  }
  incCounter(`${name}_bucket`, 1, { ...labels, le: "+Inf" });
  incCounter(`${name}_sum`, value, labels);
  incCounter(`${name}_count`, 1, labels);
}

/**
 * The three derived family names a histogram writes into. Used by the renderer
 * to suppress their standalone HELP/TYPE lines — they are emitted under the
 * base name instead, which is what a Prometheus parser expects.
 */
function histogramBaseOf(name: string): string | undefined {
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      if (histogramBuckets.has(base)) return base;
    }
  }
  return undefined;
}

/**
 * Order a histogram's `_bucket` label keys so `le` ascends within each label
 * set. The generic renderer sorts label keys as STRINGS, which would emit
 * `le="0.1"`, `le="0.25"`, `le="1"`, `le="10"`, `le="120"` … in lexical order —
 * technically parseable but unreadable to a human scanning a scrape, and it
 * puts `+Inf` in the middle. Sorting numerically with `+Inf` last matches what
 * every other exporter emits.
 */
function sortBucketKeys(keys: ReadonlyArray<string>): string[] {
  const leOf = (k: string): number => {
    const m = /(?:^|,)le="([^"]*)"/.exec(k);
    if (m === null) return Number.POSITIVE_INFINITY;
    return m[1] === "+Inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
  };
  // Strip `le` so series differing only by bucket group together, then order
  // those groups stably and the buckets within each group numerically.
  const groupOf = (k: string): string =>
    k.replace(/(?:^|,)le="[^"]*"/, "").replace(/^,/, "");
  return [...keys].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== gb) return ga < gb ? -1 : 1;
    return leOf(a) - leOf(b);
  });
}

// ---------------------------------------------------------------------------
// Phase 5 v3.1 — F-DISC-14 trace-write helpers (typed call-site ergonomics).
// ---------------------------------------------------------------------------

/** Outcome label for `copilot_proxy_trace_writes_total`. */
export type TraceWriteResult = "success" | "error";

/** Kind label for `copilot_proxy_trace_errors_total`. */
export type TraceErrorKind = "enospc" | "eacces" | "other";

/**
 * Record one trace-write attempt and (when successful) the byte count of
 * the JSON-stringified record. Encapsulates the three trace counters in a
 * single ergonomic call so callers (forward-stream `finally`, with-trace
 * `catch`) keep one-liners.
 *
 *   bumpTraceWrites("success", JSON.stringify(flow).length);
 *   bumpTraceWrites("error", undefined, classifyTraceError(err));
 *
 * - On `"success"`: increments `copilot_proxy_trace_writes_total{result="success"}`
 *   and adds `bytesWritten` to `copilot_proxy_trace_bytes_written_total`
 *   (skipped when `bytesWritten` is undefined or 0).
 * - On `"error"`: increments `copilot_proxy_trace_writes_total{result="error"}`
 *   and `copilot_proxy_trace_errors_total{kind=errorKind}` (default `"other"`).
 */
export function bumpTraceWrites(
  result: TraceWriteResult,
  bytesWritten?: number,
  errorKind?: TraceErrorKind,
): void {
  incCounter("copilot_proxy_trace_writes_total", 1, { result });
  if (result === "success") {
    if (bytesWritten !== undefined && bytesWritten > 0) {
      incCounter("copilot_proxy_trace_bytes_written_total", bytesWritten);
    }
  } else {
    incCounter("copilot_proxy_trace_errors_total", 1, {
      kind: errorKind ?? "other",
    });
  }
}

/**
 * Classify a Node `fs` error into the trace-error kind label. Reads
 * `(err as NodeJS.ErrnoException).code` and maps:
 *   - `"ENOSPC"` → `"enospc"` (disk full)
 *   - `"EACCES"` / `"EPERM"` → `"eacces"` (permission denied; Windows often
 *     surfaces `EPERM` where Linux uses `EACCES` — group them so operators
 *     don't have to chase platform-specific error codes)
 *   - anything else (including non-fs errors) → `"other"`
 */
export function classifyTraceError(err: unknown): TraceErrorKind {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC") return "enospc";
  if (code === "EACCES" || code === "EPERM") return "eacces";
  return "other";
}

// ---------------------------------------------------------------------------
// F159 — dispatch-phase failure accounting.
//
// Three handlers reach the same conclusion ("no upstream stream was obtained")
// from the same `catch` arm, so the vocabulary is bounded by a TS union rather
// than by convention — the structural analogue of what `boundedLabelValue`
// gives the `model` label.
// ---------------------------------------------------------------------------

/** Reason label for `copilot_proxy_dispatch_no_upstream_total`. */
export type DispatchFailureReason =
  | "timeout"
  | "client_abort"
  | "upstream_status"
  | "auth"
  | "transport";

/**
 * Classify a dispatch-phase failure into the `reason` label.
 *
 * The `timeout` / `client_abort` split is the point of the classifier, not a
 * refinement of it: `_retry.ts` composes
 * `AbortSignal.any([reqSignal, AbortSignal.timeout(1_200_000)])`, so a
 * 20-minute pre-header hang self-terminates as a `TimeoutError` while a client
 * that gave up first surfaces as an `AbortError`. Collapsing the two would
 * lose exactly the distinction the dispatch-anchored origin exists for.
 *
 * Property reads are wrapped because the argument is `unknown` and may be a
 * proxy or a getter that throws — this runs inside a request-path `catch`, so
 * it must never be able to replace one failure with another.
 */
export function classifyDispatchFailure(err: unknown): DispatchFailureReason {
  try {
    if (err instanceof HTTPError) return "upstream_status";
    if (
      err instanceof TokenRefreshExhaustedError ||
      err instanceof TokenManagerDisposedError
    ) {
      return "auth";
    }
    // `AbortSignal.timeout` rejects with a DOMException, not an Error, so the
    // discriminator is `.name` rather than the constructor.
    const name = (err as { name?: unknown } | null | undefined)?.name;
    if (name === "TimeoutError") return "timeout";
    if (name === "AbortError") return "client_abort";
  } catch {
    /* fall through to the catch-all below */
  }
  return "transport";
}

/**
 * Record one request that entered the dispatch phase and never obtained an
 * upstream stream. Called from every handler's dispatch `catch` arm, right
 * before it returns `forwardError`.
 *
 * The `model` label is present for the same reason it is on the histogram this
 * counter is the exclusion term for: without it the histogram is `{route,model}`
 * while its exclusion counter is `{route}`, and an operator writing the
 * runbook's own `sum by (route, model)` gets a silently censored denominator —
 * the exact defect this counter exists to close. It is routed through
 * {@link boundedLabelValue} like every other `model` label, and OMITTED
 * entirely when the model string is empty rather than emitted as `model=""`,
 * which reads as a real series to a scrape consumer.
 *
 * Never throws — a measurement helper inside a `catch` must not be able to
 * convert a handled upstream failure into an unhandled one.
 */
export function bumpDispatchNoUpstream(
  metricRoute: string,
  model: string | undefined,
  err: unknown,
): void {
  try {
    const labels: Record<string, string> = {
      route: metricRoute,
      reason: classifyDispatchFailure(err),
    };
    if (typeof model === "string" && model !== "") {
      labels.model = boundedLabelValue("model", model);
    }
    incCounter("copilot_proxy_dispatch_no_upstream_total", 1, labels);
  } catch {
    /* metrics must never be able to break the request they describe */
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render the entire metric store as Prometheus text 0.0.4. Always-on gauges
 * (`copilot_proxy_token_status`, `copilot_proxy_process_uptime_seconds`,
 * `copilot_proxy_process_resident_memory_bytes`) are emitted even if no
 * `setGauge` call has touched them — for token_status we default to 0
 * (starting); uptime + memory are computed live.
 */
export function renderPrometheus(): string {
  // Refresh always-on gauges that are computed lazily at render time.
  const uptimeSec = Math.floor((performance.now() - startupTime) / 1000);
  setGauge("copilot_proxy_process_uptime_seconds", uptimeSec);
  // process.memoryUsage is sync and cheap (single syscall).
  const rss = process.memoryUsage().rss;
  setGauge("copilot_proxy_process_resident_memory_bytes", rss);
  // Default token_status to 0 ("starting") if it has never been touched —
  // routes that scrape /metrics during stage-1 should still see the gauge.
  if (metricValues.get("copilot_proxy_token_status") === undefined) {
    setGauge("copilot_proxy_token_status", 0);
  }

  // Stable output order: sort by metric name.
  const names = Array.from(metricValues.keys()).sort();

  const lines: string[] = [];

  /** Emit the value lines of one series family (no HELP/TYPE). */
  const emitSeries = (name: string, bucketOrder: boolean): void => {
    const series = metricValues.get(name);
    if (series === undefined) return;
    const raw = Array.from(series.keys());
    const labelKeys = bucketOrder ? sortBucketKeys(raw) : raw.sort();
    for (const lk of labelKeys) {
      const value = series.get(lk) ?? 0;
      const labelPart = lk === "" ? "" : `{${lk}}`;
      lines.push(`${name}${labelPart} ${value}`);
    }
  };

  for (const name of names) {
    // D96 — a histogram's `_bucket`/`_sum`/`_count` families are emitted under
    // their BASE name below, so skip them here rather than giving each its own
    // HELP/TYPE (which would declare three counters where one histogram lives).
    if (histogramBaseOf(name) !== undefined) continue;

    const meta = metricMeta.get(name);
    const help = meta?.help ?? `${name} (no help registered).`;
    const type = meta?.type ?? "counter";
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    emitSeries(name, false);
  }

  // D96 — histograms, after the flat metrics so the base name's HELP/TYPE
  // immediately precedes its own three families. Only histograms that have
  // actually been observed are emitted (Prometheus convention: an untouched
  // series is absent, not zero).
  for (const base of Array.from(histogramBuckets.keys()).sort()) {
    if (metricValues.get(`${base}_count`) === undefined) continue;
    const meta = metricMeta.get(base);
    lines.push(
      `# HELP ${base} ${meta?.help ?? `${base} (no help registered).`}`,
    );
    lines.push(`# TYPE ${base} histogram`);
    emitSeries(`${base}_bucket`, true);
    emitSeries(`${base}_sum`, false);
    emitSeries(`${base}_count`, false);
  }

  return lines.join("\n") + "\n";
}
