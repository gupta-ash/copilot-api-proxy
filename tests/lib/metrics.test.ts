/**
 * metrics.test.ts — coverage for src/lib/metrics.ts (M12 Group A § 6).
 *
 * ≥15 tests covering:
 *   - Counter increment (single, multi-label, repeat, zero, negative-default)
 *   - Gauge set + re-set
 *   - Render shape (HELP + TYPE + value lines, stable order)
 *   - Label-value escaping (backslash, quote, newline)
 *   - Always-on gauges (token_status, uptime, memory) emit before any counter
 *   - Default delta = 1
 *   - resetForTests() clears state
 *   - Bounded label values (`boundedLabelValue`) — the per-key distinct-value
 *     ceiling behind the runbook's bounded-cardinality guarantee
 *   - `copilot_proxy_stream_no_first_byte_total` render shape
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  boundedLabelValue,
  bumpDispatchNoUpstream,
  classifyDispatchFailure,
  getValueForTests,
  incCounter,
  observeHistogram,
  renderPrometheus,
  resetForTests,
  resetLabelBoundsForTests,
  setGauge,
} from "../../src/lib/metrics.ts";
import {
  HTTPError,
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "../../src/lib/error.ts";
import { ConfigSchema } from "../../src/types/config-schema.ts";

beforeEach(() => {
  resetForTests();
});
afterEach(() => {
  resetForTests();
});

describe("metrics — counter mutations", () => {
  it("incCounter once renders {label=value} 1", () => {
    incCounter("copilot_proxy_requests_total", 1, {
      route: "messages",
      status: "200",
    });
    const out = renderPrometheus();
    expect(out).toContain(
      'copilot_proxy_requests_total{route="messages",status="200"} 1',
    );
  });

  it("incCounter same label set twice → value 2 (single line, not duplicated)", () => {
    incCounter("copilot_proxy_requests_total", 1, { route: "messages" });
    incCounter("copilot_proxy_requests_total", 1, { route: "messages" });
    const out = renderPrometheus();
    expect(out).toContain('copilot_proxy_requests_total{route="messages"} 2');
    // Assert only ONE value line for that series.
    const matches = out.match(
      /^copilot_proxy_requests_total\{route="messages"\} \d+$/gm,
    );
    expect(matches?.length).toBe(1);
  });

  it("default delta = 1 when omitted", () => {
    incCounter("copilot_proxy_requests_total", undefined, {
      route: "responses",
    });
    incCounter("copilot_proxy_requests_total", undefined, {
      route: "responses",
    });
    expect(
      getValueForTests("copilot_proxy_requests_total", { route: "responses" }),
    ).toBe(2);
  });

  it("incCounter with explicit delta sums", () => {
    incCounter("copilot_proxy_response_bytes_total", 100, {
      route: "messages",
    });
    incCounter("copilot_proxy_response_bytes_total", 250, {
      route: "messages",
    });
    expect(
      getValueForTests("copilot_proxy_response_bytes_total", {
        route: "messages",
      }),
    ).toBe(350);
  });

  it("distinct label sets render as separate lines, sorted by label key", () => {
    incCounter("copilot_proxy_requests_total", 5, {
      route: "messages",
      status: "200",
    });
    incCounter("copilot_proxy_requests_total", 1, {
      route: "responses",
      status: "503",
    });
    const out = renderPrometheus();
    expect(out).toContain(
      'copilot_proxy_requests_total{route="messages",status="200"} 5',
    );
    expect(out).toContain(
      'copilot_proxy_requests_total{route="responses",status="503"} 1',
    );
  });

  it("counter with NO labels renders without label braces", () => {
    incCounter("copilot_proxy_token_refresh_total", 1);
    const out = renderPrometheus();
    expect(out).toContain("copilot_proxy_token_refresh_total 1");
  });
});

describe("metrics — gauge mutations", () => {
  it("setGauge single value renders as expected line", () => {
    setGauge("copilot_proxy_inflight_requests", 3, { route: "messages" });
    const out = renderPrometheus();
    expect(out).toContain(
      'copilot_proxy_inflight_requests{route="messages"} 3',
    );
  });

  it("setGauge twice → last value wins (NOT additive)", () => {
    setGauge("copilot_proxy_inflight_requests", 5, { route: "messages" });
    setGauge("copilot_proxy_inflight_requests", 2, { route: "messages" });
    expect(
      getValueForTests("copilot_proxy_inflight_requests", {
        route: "messages",
      }),
    ).toBe(2);
  });

  it("setGauge token_status to 1 (ready)", () => {
    setGauge("copilot_proxy_token_status", 1);
    expect(getValueForTests("copilot_proxy_token_status")).toBe(1);
  });
});

describe("metrics — render format", () => {
  it("each emitted metric has # HELP and # TYPE lines", () => {
    incCounter("copilot_proxy_requests_total", 1, { route: "messages" });
    const out = renderPrometheus();
    expect(out).toContain("# HELP copilot_proxy_requests_total ");
    expect(out).toContain("# TYPE copilot_proxy_requests_total counter");
  });

  it("gauge lines show TYPE gauge (not counter)", () => {
    setGauge("copilot_proxy_inflight_requests", 1, { route: "messages" });
    const out = renderPrometheus();
    expect(out).toContain("# TYPE copilot_proxy_inflight_requests gauge");
  });

  it("body matches Prometheus per-line shape (regex per spec)", () => {
    incCounter("copilot_proxy_requests_total", 7, {
      route: "messages",
      status: "200",
    });
    setGauge("copilot_proxy_inflight_requests", 0, { route: "messages" });
    const out = renderPrometheus();
    const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? -?\d+(\.\d+)?$/;
    for (const line of out.split("\n")) {
      if (line === "" || line.startsWith("# ")) continue;
      expect(lineRe.test(line)).toBe(true);
    }
  });

  it("output ends with a single trailing newline", () => {
    incCounter("copilot_proxy_requests_total", 1);
    const out = renderPrometheus();
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("metrics — label-value escaping", () => {
  it("escapes backslash → \\\\", () => {
    incCounter("copilot_proxy_requests_total", 1, { route: "a\\b" });
    const out = renderPrometheus();
    expect(out).toContain('copilot_proxy_requests_total{route="a\\\\b"} 1');
  });

  it('escapes double-quote → \\"', () => {
    incCounter("copilot_proxy_requests_total", 1, { route: 'a"b' });
    const out = renderPrometheus();
    expect(out).toContain('copilot_proxy_requests_total{route="a\\"b"} 1');
  });

  it("escapes newline → \\n", () => {
    incCounter("copilot_proxy_requests_total", 1, { route: "a\nb" });
    const out = renderPrometheus();
    expect(out).toContain('copilot_proxy_requests_total{route="a\\nb"} 1');
  });
});

describe("metrics — always-on gauges", () => {
  it("renderPrometheus emits token_status even before any setGauge call", () => {
    const out = renderPrometheus();
    // Default = 0 (starting) per render-time materialization.
    expect(out).toContain("# TYPE copilot_proxy_token_status gauge");
    expect(out).toMatch(/^copilot_proxy_token_status 0$/m);
  });

  it("renderPrometheus emits process_uptime_seconds (>= 0)", () => {
    const out = renderPrometheus();
    expect(out).toContain("# TYPE copilot_proxy_process_uptime_seconds gauge");
    const match = out.match(/^copilot_proxy_process_uptime_seconds (\d+)$/m);
    expect(match).not.toBeNull();
    if (match !== null) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(0);
    }
  });

  it("renderPrometheus emits process_resident_memory_bytes (positive)", () => {
    const out = renderPrometheus();
    expect(out).toContain(
      "# TYPE copilot_proxy_process_resident_memory_bytes gauge",
    );
    const match = out.match(
      /^copilot_proxy_process_resident_memory_bytes (\d+)$/m,
    );
    expect(match).not.toBeNull();
    if (match !== null) {
      expect(Number(match[1])).toBeGreaterThan(0);
    }
  });

  it("token_status set explicitly survives render-time refresh", () => {
    setGauge("copilot_proxy_token_status", 1);
    const out = renderPrometheus();
    expect(out).toMatch(/^copilot_proxy_token_status 1$/m);
  });
});

describe("metrics — resetForTests", () => {
  it("clears counters", () => {
    incCounter("copilot_proxy_requests_total", 5, { route: "messages" });
    resetForTests();
    expect(
      getValueForTests("copilot_proxy_requests_total", { route: "messages" }),
    ).toBeUndefined();
  });
});

/**
 * D96 Phase 1 — histograms. These exist because every threshold in the timeout
 * ladder is currently a guess, so the properties that matter are the ones a
 * percentile calculation depends on: buckets must be CUMULATIVE, a bogus
 * sample must be dropped rather than clamped, and an untouched histogram must
 * be absent rather than a row of zeros.
 */
describe("metrics — histograms", () => {
  const H = "copilot_proxy_upstream_first_byte_seconds";

  it("fills buckets CUMULATIVELY — an observation lands in every le >= value", () => {
    observeHistogram(H, 5, { route: "messages" });

    // 5 is <= 5, so le="5" counts it; le="2.5" must be PRESENT AT ZERO, not
    // absent — histogram_quantile interpolates between the buckets it can see,
    // so a missing lower bucket silently widens the interpolation range.
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "2.5" }),
    ).toBe(0);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "0.1" }),
    ).toBe(0);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "5" }),
    ).toBe(1);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "10" }),
    ).toBe(1);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "180" }),
    ).toBe(1);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "+Inf" }),
    ).toBe(1);
    expect(getValueForTests(`${H}_sum`, { route: "messages" })).toBe(5);
    expect(getValueForTests(`${H}_count`, { route: "messages" })).toBe(1);
  });

  it("counts an over-range observation only in +Inf, so the tail is never lost", () => {
    observeHistogram(H, 900, { route: "messages" });
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "600" }),
    ).toBe(0);
    expect(
      getValueForTests(`${H}_bucket`, { route: "messages", le: "+Inf" }),
    ).toBe(1);
    expect(getValueForTests(`${H}_count`, { route: "messages" })).toBe(1);
  });

  it("DROPS a non-finite or negative sample rather than clamping it", () => {
    // These come from timing subtractions. A clamped bogus sample silently
    // biases the very percentile the metric exists to establish.
    observeHistogram(H, Number.NaN, { route: "messages" });
    observeHistogram(H, Number.POSITIVE_INFINITY, { route: "messages" });
    observeHistogram(H, -1, { route: "messages" });
    expect(
      getValueForTests(`${H}_count`, { route: "messages" }),
    ).toBeUndefined();
  });

  it("ignores an unregistered name — a bucket set is part of the contract", () => {
    observeHistogram("copilot_proxy_not_a_histogram", 1, { route: "messages" });
    expect(
      getValueForTests("copilot_proxy_not_a_histogram_count", {
        route: "messages",
      }),
    ).toBeUndefined();
  });

  it("renders ONE histogram block, not three counters", () => {
    observeHistogram(H, 1, { route: "messages" });
    const out = renderPrometheus();

    expect(out).toContain(`# TYPE ${H} histogram`);
    // The derived families must NOT declare their own TYPE lines — that would
    // publish three counters where one histogram lives, and a scrape consumer
    // would fail to reassemble the distribution.
    expect(out).not.toContain(`# TYPE ${H}_bucket`);
    expect(out).not.toContain(`# TYPE ${H}_sum`);
    expect(out).not.toContain(`# TYPE ${H}_count`);
    expect(out).toContain(`${H}_count{route="messages"} 1`);
  });

  it("orders le buckets ASCENDING with +Inf last, not lexically", () => {
    observeHistogram(H, 0.4, { route: "messages" });
    const lines = renderPrometheus()
      .split("\n")
      .filter((l) => l.startsWith(`${H}_bucket`));
    const les = lines.map((l) => /le="([^"]*)"/.exec(l)?.[1]);
    // The COMPLETE registered ladder, in ascending numeric order with +Inf
    // last. Two properties in one assertion, deliberately: lexical sorting
    // would give 0.1, 0.25, 1, 10, 120, 180, 2.5 … and strand +Inf in the
    // middle; and an implementation that emitted only the buckets an
    // observation falls into would drop every entry below 0.5.
    expect(les).toEqual([
      "0.1",
      "0.25",
      "0.5",
      "1",
      "2.5",
      "5",
      "10",
      "20",
      "30",
      "60",
      "120",
      "180",
      "300",
      "600",
      "+Inf",
    ]);
  });

  it("is ABSENT from the scrape until observed (Prometheus convention)", () => {
    const out = renderPrometheus();
    expect(out).not.toContain("copilot_proxy_upstream_first_byte_seconds");
    expect(out).not.toContain("copilot_proxy_dispatch_first_byte_seconds");
    expect(out).not.toContain("copilot_proxy_stream_max_silence_seconds");
    expect(out).not.toContain("copilot_proxy_request_bytes");
  });

  it("keeps distinct label sets independent", () => {
    observeHistogram(H, 1, { route: "messages" });
    observeHistogram(H, 1, { route: "responses" });
    observeHistogram(H, 1, { route: "messages" });
    expect(getValueForTests(`${H}_count`, { route: "messages" })).toBe(2);
    expect(getValueForTests(`${H}_count`, { route: "responses" })).toBe(1);
  });
});

/**
 * `boundedLabelValue` — the structural cardinality ceiling behind the
 * runbook's "label values are bounded to a small canonical set" guarantee.
 *
 * The property under test is not "it returns the value" — it is that NO input
 * sequence, however hostile, can make one label key emit more than `limit`
 * real values. Each assertion below names the mutation it catches, because a
 * bound whose test passes under an unbounded implementation is worse than no
 * test at all.
 */
describe("metrics — boundedLabelValue", () => {
  it("returns a value under the ceiling VERBATIM (real model ids pass through)", () => {
    // Catches: an implementation that canonicalizes or hashes, which would
    // make every histogram unattributable to the model that produced it.
    expect(boundedLabelValue("model", "claude-sonnet-4.5", 8)).toBe(
      "claude-sonnet-4.5",
    );
    expect(boundedLabelValue("model", "gpt-5-mini", 8)).toBe("gpt-5-mini");
  });

  it("collapses distinct value number limit+1 to 'other' — the ceiling itself", () => {
    // MUTATION ARMED. Removing the ceiling, or writing `>` where the code has
    // `admitted.size >= cap`, admits a 4th value and this fails on the last
    // assertion. This is the single assertion that makes the runbook's
    // bounded-cardinality guarantee true rather than aspirational.
    expect(boundedLabelValue("model", "m1", 3)).toBe("m1");
    expect(boundedLabelValue("model", "m2", 3)).toBe("m2");
    expect(boundedLabelValue("model", "m3", 3)).toBe("m3");
    expect(boundedLabelValue("model", "m4", 3)).toBe("other");
    expect(boundedLabelValue("model", "m5", 3)).toBe("other");
  });

  it("still returns an ALREADY-ADMITTED value after the ceiling is reached", () => {
    // Catches: checking the size before the membership test, which would strand
    // every real series at "other" the moment one novel value arrived — the
    // metric would keep rendering while silently measuring nothing.
    boundedLabelValue("model", "m1", 2);
    boundedLabelValue("model", "m2", 2);
    expect(boundedLabelValue("model", "m3", 2)).toBe("other");
    expect(boundedLabelValue("model", "m1", 2)).toBe("m1");
    expect(boundedLabelValue("model", "m2", 2)).toBe("m2");
  });

  it("bounds each key SEPARATELY", () => {
    // Catches: a single global Set instead of Map<key, Set>. Filling `model`
    // would then exhaust the budget for `route`, and route — a genuinely
    // closed set of five — would start reporting "other".
    boundedLabelValue("model", "m1", 2);
    boundedLabelValue("model", "m2", 2);
    expect(boundedLabelValue("model", "m3", 2)).toBe("other");
    expect(boundedLabelValue("route", "messages", 2)).toBe("messages");
    expect(boundedLabelValue("route", "responses", 2)).toBe("responses");
  });

  it("defaults the ceiling to 64", () => {
    // Catches: a silent change to the default. Call sites omit the argument,
    // so the default IS the shipped bound.
    for (let i = 0; i < 64; i++) {
      expect(boundedLabelValue("model", `m${i}`)).toBe(`m${i}`);
    }
    expect(boundedLabelValue("model", "m64")).toBe("other");
  });

  it("fails TOWARD the bound on a nonsense limit, never away from it", () => {
    // Catches: `admitted.size >= limit` used raw. `size >= NaN` is false, so a
    // NaN ceiling would admit every value forever — an unbounded label wearing
    // a bound's name.
    expect(boundedLabelValue("k1", "v", Number.NaN)).toBe("other");
    expect(boundedLabelValue("k2", "v", 0)).toBe("other");
    expect(boundedLabelValue("k3", "v", -5)).toBe("other");
  });

  it("never throws, and never invents a value the client did not send", () => {
    // Runs inside request-path `finally` blocks, so a throw here surfaces as a
    // failed request. Catches: any added string operation (`.toLowerCase()`,
    // `.trim()`) on an unchecked value — those throw on undefined/null. The
    // `toBe("other")` half additionally catches `String(value)` coercion, which
    // would mint the literal series `model="undefined"`.
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      { toString: null },
      Symbol("s"),
      [],
    ];
    for (const v of hostile) {
      expect(boundedLabelValue("model", v as string, 8)).toBe("other");
    }
    expect(boundedLabelValue(undefined as unknown as string, "v", 8)).toBe(
      "other",
    );
    // An empty string is a legitimate string and is admitted as such; callers
    // that must not emit `model=""` omit the label, they do not rely on this.
    expect(boundedLabelValue("model", "", 8)).toBe("");
  });

  it("resetLabelBoundsForTests() releases the ceiling", () => {
    boundedLabelValue("model", "m1", 1);
    expect(boundedLabelValue("model", "m2", 1)).toBe("other");
    resetLabelBoundsForTests();
    expect(boundedLabelValue("model", "m2", 1)).toBe("m2");
  });

  it("resetForTests() also clears the bounds registry", () => {
    // MUTATION ARMED against the docblock, not just the code: `resetForTests`
    // claims to wipe ALL metric state. Drop its `resetLabelBoundsForTests()`
    // call and the last assertion returns "other".
    boundedLabelValue("model", "m1", 1);
    expect(boundedLabelValue("model", "m2", 1)).toBe("other");
    resetForTests();
    expect(boundedLabelValue("model", "m2", 1)).toBe("m2");
  });

  it("bounds the RENDERED series count, not merely the return value", () => {
    // The assertions above test the helper; this one tests the artifact the
    // helper exists to protect. 200 novel model ids through a ceiling of 5 must
    // produce exactly 6 series (5 real + "other") in the scrape body. Any
    // ceiling break shows up here as a scrape with hundreds of model series —
    // which is the actual failure mode the gate flagged.
    for (let i = 0; i < 200; i++) {
      incCounter("copilot_proxy_stream_no_first_byte_total", 1, {
        route: "messages",
        model: boundedLabelValue("model", `evil-model-${i}`, 5),
      });
    }
    const out = renderPrometheus();
    const modelValues = new Set(
      out
        .split("\n")
        .filter((l) =>
          l.startsWith("copilot_proxy_stream_no_first_byte_total{"),
        )
        .map((l) => /model="([^"]*)"/.exec(l)?.[1]),
    );
    expect(modelValues.size).toBe(6);
    expect(modelValues.has("evil-model-0")).toBe(true);
    expect(modelValues.has("evil-model-4")).toBe(true);
    expect(modelValues.has("evil-model-5")).toBe(false);
    expect(modelValues.has("other")).toBe(true);
    // All 200 observations are still counted — the bound loses attribution,
    // never the event. Catches a "fix" that drops over-ceiling observations.
    const total = out
      .split("\n")
      .filter((l) => l.startsWith("copilot_proxy_stream_no_first_byte_total{"))
      .map((l) => Number(l.slice(l.lastIndexOf(" ") + 1)))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(200);
  });
});

/**
 * The new counter another agent writes from `forward-stream.ts`. It needs no
 * registration to render (the renderer defaults an unknown name to
 * `# TYPE <name> counter`); registration supplies the HELP text only.
 */
describe("metrics — stream_no_first_byte counter", () => {
  const C = "copilot_proxy_stream_no_first_byte_total";

  it("renders with real HELP text, a counter TYPE, and its label set", () => {
    // Catches: dropping the registerMeta call, which regresses the HELP line to
    // the "(no help registered)." placeholder while every other counter in the
    // scrape documents itself.
    incCounter(C, 1, { route: "messages", model: "claude-sonnet-4.5" });
    const out = renderPrometheus();
    expect(out).toContain(`# TYPE ${C} counter`);
    expect(out).toContain(`# HELP ${C} Total upstream streams that completed`);
    expect(out).not.toContain("(no help registered)");
    expect(out).toContain(`${C}{model="claude-sonnet-4.5",route="messages"} 1`);
  });

  it("is ABSENT until incremented (untouched series are not zero rows)", () => {
    expect(renderPrometheus()).not.toContain(C);
  });

  it("is not mistaken for a histogram family by the renderer", () => {
    // `histogramBaseOf` strips `_bucket`/`_sum`/`_count`. A name ending in
    // `_total` must not be swallowed by that path — if it were, the counter
    // would be skipped entirely in the flat-metric loop and never emitted.
    incCounter(C, 3, { route: "responses" });
    const out = renderPrometheus();
    expect(out).toMatch(new RegExp(`^${C}\\{route="responses"\\} 3$`, "m"));
  });
});

/**
 * F159 — the rename is a HARD one (no dual-emit) and no boundary carries a
 * client-watchdog claim any more.
 *
 * The HELP assertions are documentation-as-test, and they are justified rather
 * than decorative: the watchdog reading of `le="180"` was false on two
 * independent grounds, and this metric's docblock has now had a false claim
 * removed in four separate rounds. A guard that fails when the sentence comes
 * back is cheaper than a fifth round.
 */
describe("metrics — F159 first-byte series", () => {
  it("the rename is complete and no watchdog claim survives in HELP", () => {
    observeHistogram("copilot_proxy_upstream_first_byte_seconds", 1, {
      route: "messages",
    });
    observeHistogram("copilot_proxy_dispatch_first_byte_seconds", 1, {
      route: "messages",
    });
    const out = renderPrometheus();

    // The old name is GONE — no alias, no dual-write under both names.
    expect(out).not.toContain("copilot_proxy_ttfb_seconds");
    expect(out).toContain(
      "# TYPE copilot_proxy_upstream_first_byte_seconds histogram",
    );
    expect(out).toContain(
      "# TYPE copilot_proxy_dispatch_first_byte_seconds histogram",
    );

    const helpLines = out
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("# HELP copilot_proxy_upstream_first_byte_seconds ") ||
          l.startsWith("# HELP copilot_proxy_dispatch_first_byte_seconds "),
      );
    // Both HELP lines present. A MISSING `registerHistogram` call would drop
    // the sample entirely (`observeHistogram` returns early when the name has
    // no bucket set), so the whole family — HELP line included — vanishes and
    // this count reads 1 or 0.
    expect(helpLines.length).toBe(2);
    for (const line of helpLines) {
      expect(line).not.toContain("watchdog");
      expect(line).not.toContain("(no help registered)");
    }
  });

  it("each HELP names its own ORIGIN, so a later subtraction stays interpretable", () => {
    observeHistogram("copilot_proxy_upstream_first_byte_seconds", 1, {
      route: "messages",
    });
    observeHistogram("copilot_proxy_dispatch_first_byte_seconds", 1, {
      route: "messages",
    });
    const out = renderPrometheus();
    // The two series differ ONLY by the upstream header phase. If the HELP
    // text stops saying which end of that phase each one starts at, the pair
    // becomes two similar numbers with no defined relationship.
    expect(out).toContain(
      "# HELP copilot_proxy_upstream_first_byte_seconds Seconds from the START OF THE STREAM CALLBACK",
    );
    expect(out).toContain(
      "# HELP copilot_proxy_dispatch_first_byte_seconds Seconds from PROXY REQUEST ENTRY",
    );
  });
});

/**
 * Slice (b) — the two new counters get the registration coverage the sibling
 * `stream_no_first_byte_total` already had, and the detector histogram's bucket
 * list is bound to the config-schema literals it claims to mirror.
 *
 * The binding is the load-bearing half. `600` and `1140` are asserted by the
 * HELP string, the docblock and `docs/runbook.md` to BE the schema-default
 * stall windows, and nothing imported them — change a default in
 * `config-schema.ts` and all three go false in silence, with no test, no
 * typecheck and no CI step able to notice.
 */
describe("metrics — slice (b) detector-phase families", () => {
  const CENSORED = "copilot_proxy_detector_wait_censored_total";
  const NO_CONTENT = "copilot_proxy_stream_no_content_total";

  /** The `le` values the renderer actually emitted, in registration order. */
  function renderedBoundaries(family: string): string[] {
    return renderPrometheus()
      .split("\n")
      .filter((l) => l.startsWith(`${family}_bucket{`))
      .map((l) => /le="([^"]+)"/.exec(l)?.[1] ?? "<none>");
  }

  it("both new counters render with real HELP and a counter TYPE", () => {
    // Catches: dropping either `registerMeta` call, which regresses the HELP
    // line to the "(no help registered)." placeholder. These two counters are
    // useless without their reason/phase semantics, so the HELP is the metric.
    incCounter(NO_CONTENT, 1, {
      route: "messages",
      model: "claude-test",
      reason: "never_started",
    });
    incCounter(CENSORED, 1, {
      route: "messages",
      model: "claude-test",
      phase: "response",
    });
    const out = renderPrometheus();
    expect(out).toContain(`# TYPE ${NO_CONTENT} counter`);
    expect(out).toContain(`# TYPE ${CENSORED} counter`);
    expect(out).toContain(`# HELP ${NO_CONTENT} Total streams that completed`);
    expect(out).toContain(`# HELP ${CENSORED} Total stream-phases`);
    expect(out).not.toContain("(no help registered)");
  });

  it("both are absent until incremented, and neither is mistaken for a histogram family", () => {
    // A name ending in `_total` must not be swallowed by `histogramBaseOf`'s
    // `_bucket`/`_sum`/`_count` stripping — it would be skipped in the flat
    // loop and never emitted at all.
    expect(renderPrometheus()).not.toContain(CENSORED);
    expect(renderPrometheus()).not.toContain(NO_CONTENT);
    incCounter(CENSORED, 3, { route: "responses", phase: "no_response" });
    expect(renderPrometheus()).toMatch(
      new RegExp(
        `^${CENSORED}\\{phase="no_response",route="responses"\\} 3$`,
        "m",
      ),
    );
  });

  it("the detector histogram registers the bucket list its docblock argues for", () => {
    observeHistogram("copilot_proxy_detector_max_wait_seconds", 0.05, {
      route: "messages",
      phase: "response",
    });
    expect(
      renderedBoundaries("copilot_proxy_detector_max_wait_seconds"),
    ).toEqual([
      "0.1",
      "0.5",
      "1",
      "2.5",
      "5",
      "10",
      "30",
      "60",
      "120",
      "180",
      "300",
      "600",
      "900",
      "1140",
      "1800",
      "+Inf",
    ]);
  });

  it("600 and 1140 ARE the schema-default stall windows — the binding nothing else enforces", () => {
    observeHistogram("copilot_proxy_detector_max_wait_seconds", 0.05, {
      route: "messages",
      phase: "response",
    });
    // ⚠ `config-schema.ts` carries these literals THREE times and ALL THREE
    // must be pinned, because each is reachable only by a different config
    // shape. Measured by mutating each copy in turn:
    //   - `{}`                                  → the `logging` object default,
    //     which spells `stall_detection` out inline;
    //   - `{logging: {}}`                       → `stall_detection`'s own
    //     `.default(() => ({...}))`;
    //   - `{logging:{stall_detection:{}}}`      → the per-FIELD `.default()`s.
    // A single-shape assertion here is a THIRD of a guard: mutating the field
    // default alone left `parse({})` completely unchanged, and vice versa.
    const shapes = [
      ConfigSchema.parse({}).logging.stall_detection,
      ConfigSchema.parse({ logging: {} }).logging.stall_detection,
      ConfigSchema.parse({ logging: { stall_detection: {} } }).logging
        .stall_detection,
    ];
    // If ANY copy moves, THIS fails — instead of the HELP string, the docblock
    // and the runbook silently becoming false.
    for (const stall of shapes) {
      expect(stall.response_wait_ms).toBe(600_000);
      expect(stall.no_response_wait_ms).toBe(1_140_000);
    }
    const les = renderedBoundaries("copilot_proxy_detector_max_wait_seconds");
    expect(les).toContain(String(shapes[0]!.response_wait_ms / 1000));
    expect(les).toContain(String(shapes[0]!.no_response_wait_ms / 1000));
  });
});

/**
 * Slice (c) — the D99(c) join-key counter gets the same registration coverage
 * its two siblings already have.
 *
 * The HELP text IS the metric here: without the four `result` semantics spelled
 * out, `rejected` and `absent` read as interchangeable and the whole point of
 * the series — making a 100 % rejection visible — is lost on the operator who
 * scrapes it.
 */
describe("metrics — slice (c) upstream msg-id counter", () => {
  const MSG_ID = "copilot_proxy_upstream_msg_id_total";

  it("renders with real HELP and a counter TYPE", () => {
    // Catches: dropping the `registerMeta` call, which regresses the HELP line
    // to the "(no help registered)." placeholder while the samples keep
    // rendering — a silent degradation with no failing assertion anywhere else.
    incCounter(MSG_ID, 1, {
      route: "messages",
      model: "claude-test",
      result: "captured",
    });
    const out = renderPrometheus();
    expect(out).toContain(`# TYPE ${MSG_ID} counter`);
    expect(out).toContain(`# HELP ${MSG_ID} Total streams by the outcome`);
    expect(out).not.toContain("(no help registered)");
  });

  it("the HELP names all four result values and states the per-model reading", () => {
    incCounter(MSG_ID, 1, { route: "messages", result: "captured" });
    const help =
      renderPrometheus()
        .split("\n")
        .find((l) => l.startsWith(`# HELP ${MSG_ID} `)) ?? "";
    // A `result` value that exists in code but not in the HELP is a label an
    // operator cannot interpret. All four, by name.
    for (const v of ["captured", "rejected", "absent", "not_observed"]) {
      expect(help).toContain(v);
    }
    // The reading is only valid per (route, model) — route=messages carries BOTH
    // the Anthropic-upstream lane and the Responses-upstream Lane 4, so a
    // route-only ratio mixes an expected `absent` with a real rejection.
    expect(help).toContain("route=messages");
    expect(help).toContain("EXACTLY ONE increment per stream");
  });
});

/**
 * F159 — dispatch-failure classification + the counter's label shape.
 *
 * The `reason` vocabulary is bounded by a TS union, so what needs testing is
 * the MAPPING, not the set. The `timeout` / `client_abort` split carries the
 * most weight: it is the difference between "upstream never answered" and "the
 * client gave up first", which is the distinction the end-to-end origin exists
 * to expose.
 */
describe("metrics — F159 dispatch failure accounting", () => {
  it("maps each failure shape to its own reason", () => {
    expect(
      classifyDispatchFailure(
        new DOMException("The operation timed out.", "TimeoutError"),
      ),
    ).toBe("timeout");
    expect(
      classifyDispatchFailure(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
    ).toBe("client_abort");
    expect(
      classifyDispatchFailure(
        new HTTPError("Copilot 500", new Response("", { status: 500 })),
      ),
    ).toBe("upstream_status");
    expect(
      classifyDispatchFailure(
        new TokenRefreshExhaustedError(3, new Error("no token")),
      ),
    ).toBe("auth");
    expect(classifyDispatchFailure(new TokenManagerDisposedError())).toBe(
      "auth",
    );
    // Catch-all, and it must survive a non-Error argument rather than throwing:
    // this runs inside a request-path `catch`.
    expect(classifyDispatchFailure(new TypeError("fetch failed"))).toBe(
      "transport",
    );
    expect(classifyDispatchFailure(undefined)).toBe("transport");
  });

  it("emits the model label bounded, and OMITS it when the model is empty", () => {
    bumpDispatchNoUpstream(
      "messages",
      "claude-test",
      new DOMException("x", "TimeoutError"),
    );
    expect(
      getValueForTests("copilot_proxy_dispatch_no_upstream_total", {
        route: "messages",
        model: "claude-test",
        reason: "timeout",
      }),
    ).toBe(1);

    // An empty model must NOT become `model=""`, which reads as a real series
    // to a scrape consumer — it is omitted, matching the convention every other
    // model-labelled family here already follows.
    bumpDispatchNoUpstream("messages", "", new TypeError("boom"));
    expect(
      getValueForTests("copilot_proxy_dispatch_no_upstream_total", {
        route: "messages",
        reason: "transport",
      }),
    ).toBe(1);
    expect(renderPrometheus()).not.toContain('model=""');
  });
});
