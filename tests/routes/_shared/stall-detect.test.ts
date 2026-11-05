/**
 * stall-detect.test.ts — unit coverage for the protocol-agnostic stall-detect
 * foundation (feature W2). Uses tiny REAL timeouts (1-80 ms); `setSystemTime`
 * is deliberately NOT used because it does not advance `setTimeout`.
 *
 * Coverage:
 *   1. arm() mints a FRESH promise per call (distinct identities; each a Promise).
 *   2. arm(5) resolves quickly.
 *   3. cancel() after arm(1000) → the armed promise never resolves (loses a race
 *      to a ~30 ms sentinel), proving cancellation.
 *   4. appendStallLog appends one JSONL line per call (2 calls → 2 lines).
 *   5. appendStallLog with a circular record does NOT throw and still writes a
 *      valid line (total-safe, mirroring lib/crash.ts).
 *   6. buildStallRecord fills an ISO `ts` and passes the rest through.
 *   7. raceReadWithKeepAlive: `read` returns the ORIGINAL result; `stall` and
 *      `keepalive` arms select correctly; the `keepalive` arm is UNSELECTABLE
 *      when no keep-alive promise is passed (proved by starving both real arms
 *      against a sentinel, NOT by the vacuous settled-arms form).
 *   8. raceReadWithKeepAlive ARM PRECEDENCE (a documented contract): a delivered
 *      read beats a same-turn stall, and an elapsed stall beats a ready
 *      keep-alive — the latter is D96's no-manufactured-liveness rule.
 *   9. Reusing one settled stall promise across N rounds vs re-arming per round,
 *      with a NEGATIVE ARM. ⚠ These pin arm-selection, NOT the forwarder-level
 *      "arm once outside the loop" property — see the scope note at that block.
 *  10. raceRead arms the timer EXACTLY ONCE with the caller's period.
 *  11. `peekObservesContent` AGREES with `peekOutboundEvent`'s runtime behaviour
 *      per protocol, and a REAL `ChatStreamChunk` (no `type` field) is shown to
 *      die at the guard ABOVE the protocol switch — the second, easily-missed
 *      half of the translated chat lane's blindness.
 *  12. `detectorPhaseOf` precedence, and that `detectorPeriodFor ∘ detectorPhaseOf`
 *      is byte-identical to the `contentStarted && !inThinking` predicate it
 *      replaced, over the full cross-product.
 *  13. `makeKeepAliveConfig` polarity (OFF unless explicitly enabled — the
 *      INVERSE of its two sibling factories) and its D96 refusal when the stall
 *      detector is off, including the one-shot latch on both warns.
 */

import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "bun:test";
import consola from "consola";

import { expandTilde } from "../../../src/lib/paths.ts";
import {
  appendStallLog,
  buildStallRecord,
  detectorPeriodFor,
  detectorPhaseOf,
  makeKeepAliveConfig,
  makeStallTimer,
  newPeekState,
  peekObservesContent,
  peekOutboundEvent,
  raceRead,
  raceReadWithKeepAlive,
  _resetKeepAliveWarnForTests,
  type DetectorPhase,
  type StallConfig,
  type StallRecord,
  type StallTimer,
} from "../../../src/routes/_shared/stall-detect.ts";

const tmpFiles: string[] = [];

function uniqueLogPath(tag: string): string {
  const name = `stall-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
  const p = path.join(tmpdir(), name);
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const f of tmpFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** A promise whose settlement this test controls explicitly. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A `StallTimer` that records every `arm()` period instead of setting a timer. */
function countingTimer(): StallTimer & { armed: number[] } {
  const armed: number[] = [];
  return {
    armed,
    arm(ms: number): Promise<void> {
      armed.push(ms);
      return new Promise<void>(() => {
        /* never resolves — the read wins in these tests */
      });
    },
    cancel(): void {
      /* nothing to cancel */
    },
  };
}

describe("raceReadWithKeepAlive (M1 / D100)", () => {
  it("resolves `read` with the ORIGINAL result, preserving the caller's narrowing", async () => {
    const stall = deferred();
    const raced = await raceReadWithKeepAlive(
      Promise.resolve({ value: 42, done: false }),
      stall.promise,
    );
    expect(raced.kind).toBe("read");
    if (raced.kind !== "read") throw new Error("unreachable");
    expect(raced.result).toEqual({ value: 42, done: false });
  });

  it("resolves `stall` when the stall promise settles first", async () => {
    const read = deferred();
    const raced = await raceReadWithKeepAlive(
      read.promise.then(() => ({ value: undefined, done: true })),
      Promise.resolve(),
    );
    expect(raced.kind).toBe("stall");
  });

  it("the `keepalive` arm is UNSELECTABLE when no keep-alive promise is passed", async () => {
    // ⚠ THE OBVIOUS FORM OF THIS TEST IS VACUOUS, and it was written that way
    // first. Settling both real arms and asserting the result is not "keepalive"
    // holds under a mutation that pushes a keepalive arm UNCONDITIONALLY: `read`
    // is attached first, so `Promise.race` returns it either way and the
    // assertion can never see the defect it names.
    // Live form: STARVE both real arms, so the race can settle at all ONLY if a
    // keepalive arm exists. A sentinel must win.
    const raced = raceReadWithKeepAlive(
      new Promise<{ value: number; done: boolean }>(() => {
        /* never settles */
      }),
      new Promise<void>(() => {
        /* never settles */
      }),
    );
    const sentinel = new Promise<"sentinel">((r) => {
      setTimeout(() => r("sentinel"), 20);
    });
    expect(await Promise.race([raced, sentinel])).toBe("sentinel");
  });

  // -------------------------------------------------------------------------
  // Arm precedence is a CONTRACT (see the docblock), not an accident of
  // `arms.push` order — and the second of these is D96-critical.
  // -------------------------------------------------------------------------
  it("PRECEDENCE — a delivered read beats a stall that elapsed in the same turn", async () => {
    const raced = await raceReadWithKeepAlive(
      Promise.resolve({ value: 9, done: false }),
      Promise.resolve(),
      Promise.resolve(),
    );
    expect(raced.kind).toBe("read");
  });

  it("PRECEDENCE — an elapsed stall beats a ready keep-alive (D96: no manufactured liveness)", async () => {
    // If `keepalive` were attached before `stall`, a keep-alive that happens to be
    // ready in the same turn would MASK an expired deadline — the proxy would hold
    // a client open on a stream the detector had already condemned. Reordering
    // `arms` breaks this test, which is the point of it existing.
    const raced = await raceReadWithKeepAlive(
      new Promise<{ value: number; done: boolean }>(() => {
        /* never settles */
      }),
      Promise.resolve(),
      Promise.resolve(),
    );
    expect(raced.kind).toBe("stall");
  });

  it("resolves `keepalive` when that arm wins", async () => {
    const read = deferred();
    const stall = deferred();
    const raced = await raceReadWithKeepAlive(
      read.promise.then(() => ({ value: undefined, done: true })),
      stall.promise,
      Promise.resolve(),
    );
    expect(raced.kind).toBe("keepalive");
  });

  // -------------------------------------------------------------------------
  // ⚠ SCOPE OF THE TWO TESTS BELOW, STATED HONESTLY — an earlier version of this
  // comment called them "THE M1 INVARIANT ... the property the whole arming
  // inversion exists to guarantee". They are not, and overclaiming a guard is
  // this project's single most-repeated defect (F153, F81).
  //
  // What they DO pin: `Promise.race` arm-selection over promises the TEST
  // controls, and the difference between reusing a settled promise and handing
  // over a fresh one each round.
  //
  // What they do NOT pin: M1's actual invariant — "the caller arms ONCE, OUTSIDE
  // the loop" — which lives in `forward-stream.ts` and is not imported here.
  // `raceReadWithKeepAlive` is stateless and timer-free, so NO mutation of it can
  // slide a deadline. The forwarder-level property is in fact currently
  // UNFALSIFIABLE: no `keepAliveP` is ever passed, so the loop provably runs once
  // and `armedPeriods` is identical wherever `arm()` sits.
  //
  // It becomes testable only when slice (d) lands, and pinning it is a NAMED
  // ACCEPTANCE CRITERION of that slice: `armedPeriods` stays length 1 across N
  // keep-alive rounds, and the recorded detector wait EXCEEDS `interval_ms`.
  // -------------------------------------------------------------------------
  it("REUSING one settled stall promise keeps the deadline ABSOLUTE across N keep-alive rounds", async () => {
    const read = deferred();
    const readP = read.promise.then(() => ({ value: undefined, done: true }));
    const stall = deferred(); // armed ONCE, by the caller, before the loop
    let rounds = 0;

    // Five keep-alive rounds, each racing against the SAME stall promise.
    for (let i = 0; i < 5; i++) {
      const raced = await raceReadWithKeepAlive(
        readP,
        stall.promise,
        Promise.resolve(),
      );
      expect(raced.kind).toBe("keepalive");
      rounds++;
    }
    expect(rounds).toBe(5);

    // The window now elapses. Because the SAME promise was reused, the very next
    // race must stall immediately — the deadline did not slide by five rounds.
    stall.resolve();
    const final = await raceReadWithKeepAlive(
      readP,
      stall.promise,
      deferred().promise,
    );
    expect(final.kind).toBe("stall");
  });

  it("NEGATIVE ARM — re-arming per round would let the deadline slide forever", async () => {
    // The rejected shape: a race that arms its own timer, re-entered per tick.
    // Modelled here by handing each round a FRESH unsettled promise. This test
    // exists because the assertion above can only ever return "stall" if the
    // reuse is real; without a control showing the other shape behaves
    // DIFFERENTLY, that assertion is a probe rather than a test.
    const read = deferred();
    const readP = read.promise.then(() => ({ value: undefined, done: true }));
    const elapsed = deferred();
    elapsed.resolve(); // the ORIGINAL window has already elapsed

    for (let i = 0; i < 5; i++) {
      const raced = await raceReadWithKeepAlive(
        readP,
        deferred().promise, // FRESH each round — the defect being guarded against
        Promise.resolve(),
      );
      // Never stalls, however long the original window has been over.
      expect(raced.kind).toBe("keepalive");
    }

    // Same inputs, same round count, but reusing the elapsed promise → stall.
    // The two branches differ ONLY in reuse-vs-re-arm, so the comparator is live.
    const reused = await raceReadWithKeepAlive(
      readP,
      elapsed.promise,
      Promise.resolve(),
    );
    expect(reused.kind).toBe("stall");
  });
});

describe("raceRead (2-way delegation)", () => {
  it("arms the timer EXACTLY ONCE, with the caller's period", async () => {
    const timer = countingTimer();
    const raced = await raceRead(
      Promise.resolve({ value: 7, done: false }),
      timer,
      1_140_000,
    );
    expect(timer.armed).toEqual([1_140_000]);
    expect(raced.kind).toBe("read");
  });

  it("still reports `stall` when the timer wins", async () => {
    const read = deferred();
    const timer: StallTimer = {
      arm: (): Promise<void> => Promise.resolve(),
      cancel: (): void => undefined,
    };
    const raced = await raceRead(
      read.promise.then(() => ({ value: undefined, done: true })),
      timer,
      1,
    );
    expect(raced.kind).toBe("stall");
  });
});

describe("makeStallTimer", () => {
  it("arm() mints a fresh promise per call", () => {
    const timer = makeStallTimer();
    const p1 = timer.arm(1000);
    const p2 = timer.arm(1000);
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
    expect(p1).not.toBe(p2);
    timer.cancel(); // release the dangling timer
  });

  it("arm(5) resolves quickly", async () => {
    const timer = makeStallTimer();
    // makeStallTimer calls `.unref()` on its handle (spec-verbatim), so an armed
    // timer does not keep bun's event loop alive on its own — in production the
    // live HTTP server socket holds the loop open. With nothing else pending, bun
    // idles the process out before the unref'd timer fires, so hold the loop open
    // with a ref'd keepalive for the brief duration of the await.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      let resolved = false;
      await timer.arm(5).then(() => {
        resolved = true;
      });
      expect(resolved).toBe(true);
    } finally {
      timer.cancel();
      clearInterval(keepAlive);
    }
  });

  it("cancel() prevents the armed promise from resolving", async () => {
    const timer = makeStallTimer();
    let armedWon = false;
    const armed = timer.arm(1000).then(() => {
      armedWon = true;
      return "armed" as const;
    });
    timer.cancel();
    const sentinel = new Promise<"sentinel">((resolve) =>
      setTimeout(() => resolve("sentinel"), 30),
    );
    const winner = await Promise.race([armed, sentinel]);
    expect(winner).toBe("sentinel");
    expect(armedWon).toBe(false);
  });
});

describe("appendStallLog", () => {
  it("appends one JSONL line per call", () => {
    const logPath = uniqueLogPath("append");

    const rec1 = buildStallRecord({
      phase: "no_response",
      waitedMs: 1_140_000,
      protocol: "anthropic_messages",
      model: "claude-opus-4.8",
      requestId: "req-1",
      route: "/v1/messages",
    });
    appendStallLog(rec1, logPath);

    const rec2 = buildStallRecord({
      phase: "response",
      waitedMs: 600_000,
      protocol: "openai_responses",
    });
    appendStallLog(rec2, logPath);

    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    const parsed1 = JSON.parse(lines[0]!) as StallRecord;
    expect(parsed1.phase).toBe("no_response");
    expect(parsed1.waitedMs).toBe(1_140_000);
    expect(parsed1.protocol).toBe("anthropic_messages");
    expect(parsed1.model).toBe("claude-opus-4.8");
    expect(parsed1.requestId).toBe("req-1");
    expect(parsed1.route).toBe("/v1/messages");
    expect(typeof parsed1.ts).toBe("string");

    const parsed2 = JSON.parse(lines[1]!) as StallRecord;
    expect(parsed2.phase).toBe("response");
    expect(parsed2.waitedMs).toBe(600_000);
    expect(parsed2.protocol).toBe("openai_responses");
  });

  it("is total-safe with a circular record (no throw, still writes a line)", () => {
    const logPath = uniqueLogPath("circular");

    const rec = buildStallRecord({
      phase: "no_response",
      waitedMs: 5,
      protocol: "test",
    });
    // Attach a circular field so JSON.stringify(rec) throws.
    const circular = { ...rec } as StallRecord & { self?: unknown };
    circular.self = circular;

    expect(() => appendStallLog(circular, logPath)).not.toThrow();

    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);

    // The rebuilt line must be valid JSON with the scalar fields preserved.
    const parsed = JSON.parse(lines[0]!) as StallRecord;
    expect(parsed.phase).toBe("no_response");
    expect(parsed.protocol).toBe("test");
    expect(parsed.waitedMs).toBe(5);
    expect(typeof parsed.ts).toBe("string");
  });
});

describe("buildStallRecord", () => {
  it("fills an ISO ts and passes the rest through", () => {
    const before = Date.now();
    const rec = buildStallRecord({
      phase: "response",
      waitedMs: 600_000,
      protocol: "openai_responses",
      model: "gpt-5.1",
      requestId: "req-xyz",
      route: "/responses",
    });

    expect(rec.phase).toBe("response");
    expect(rec.waitedMs).toBe(600_000);
    expect(rec.protocol).toBe("openai_responses");
    expect(rec.model).toBe("gpt-5.1");
    expect(rec.requestId).toBe("req-xyz");
    expect(rec.route).toBe("/responses");

    expect(typeof rec.ts).toBe("string");
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const parsedMs = Date.parse(rec.ts);
    expect(Number.isNaN(parsedMs)).toBe(false);
    expect(parsedMs).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("expandTilde", () => {
  it("expands a leading ~ and passes non-tilde paths through unchanged", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/a/b.log")).toBe(path.join(homedir(), "a/b.log"));
    expect(expandTilde("/abs/x")).toBe("/abs/x");
    expect(expandTilde("rel/x")).toBe("rel/x");
  });
});

/**
 * Slice (b) — `peekObservesContent` is a STATIC claim about what
 * `peekOutboundEvent` does at runtime. A static claim and a runtime behaviour
 * drift silently, and this lane's mislabel would be invisible if they did, so
 * the claim is asserted AGAINST the behaviour rather than restated.
 *
 * MUTATION ARMED, against both directions of the drift:
 *   - implement the `openai_chat` branch of `peekOutboundEvent` without updating
 *     the predicate → the agreement assertion goes red at exactly the moment the
 *     static claim stops being true;
 *   - "fix" that branch, see a hand-written `{type: …}` fixture pass, and delete
 *     `lane_unobservable` believing the lane is now observable → the REAL
 *     `ChatStreamChunk` case below still leaves `contentStarted` false, because
 *     the `type === "" -> return` guard ABOVE the protocol switch drops every
 *     genuine chat chunk one step earlier.
 */
describe("peekObservesContent — the predicate agrees with peekOutboundEvent", () => {
  /** One content-shaped event per protocol, each carrying a `type` string so it
   *  actually reaches the protocol switch. */
  const vectors: Array<{ protocol: string; event: unknown }> = [
    { protocol: "anthropic", event: { type: "content_block_delta" } },
    {
      protocol: "openai_responses",
      event: { type: "response.output_text.delta" },
    },
    {
      protocol: "openai_chat",
      event: {
        type: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hi" } }],
      },
    },
  ];

  it("contentStarted after a content event == peekObservesContent, for every protocol", () => {
    for (const { protocol, event } of vectors) {
      const peek = newPeekState();
      peekOutboundEvent(event, protocol, peek);
      expect(peek.contentStarted).toBe(
        peekObservesContent("translated", protocol),
      );
      // Stated separately so a failure says WHICH side moved.
      expect(peekObservesContent("translated", protocol)).toBe(
        protocol !== "openai_chat",
      );
    }
  });

  it("a REAL ChatStreamChunk carries no `type` at all, so it dies one guard earlier", () => {
    const peek = newPeekState();
    // src/types/openai-chat.ts: `object: "chat.completion.chunk"`, and NO `type`
    // field. The hand-written vector above is the shape a fixture author
    // invents; this is the shape the wire actually carries.
    peekOutboundEvent(
      {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hi" } }],
      },
      "openai_chat",
      peek,
    );
    expect(peek.contentStarted).toBe(false);
    expect(peekObservesContent("translated", "openai_chat")).toBe(false);
  });

  it("the VERBATIM lane is observable on every protocol — the blindness is per-lane", () => {
    expect(peekObservesContent("verbatim", "anthropic")).toBe(true);
    expect(peekObservesContent("verbatim", "openai_responses")).toBe(true);
    expect(peekObservesContent("verbatim", "openai_chat")).toBe(true);
  });
});

/**
 * Slice (b) — the phase derivation, and the claim that deriving the PERIOD from
 * the PHASE preserves the old two-way predicate byte for byte.
 *
 * That equivalence is what makes the label safe to add to a shipped detector:
 * the metric gains a slice, the detector's behaviour does not change. It is
 * asserted here over the full cross-product rather than argued in a comment.
 */
describe("detectorPhaseOf / detectorPeriodFor", () => {
  const cfg: StallConfig = {
    noResponseWaitMs: 1_140_000,
    responseWaitMs: 600_000,
    makeTimer: makeStallTimer,
    log: (): void => {
      /* unused by the two pure functions under test */
    },
  };

  it("unobservable wins over every peek state, then no_response, thinking, response", () => {
    // A blind lane is labelled honestly whatever the peek says — and on a real
    // blind lane `contentStarted` is permanently false, so the second case here
    // is unreachable in production and pins the PRECEDENCE, not a behaviour.
    expect(detectorPhaseOf(newPeekState(), /* observable */ false)).toBe(
      "unobservable",
    );
    expect(
      detectorPhaseOf(
        {
          contentStarted: true,
          inThinking: true,
          lastEvent: "",
          upstreamIdStatus: "absent",
        },
        false,
      ),
    ).toBe("unobservable");
    expect(detectorPhaseOf(newPeekState(), true)).toBe("no_response");
    expect(
      detectorPhaseOf(
        {
          contentStarted: true,
          inThinking: true,
          lastEvent: "",
          upstreamIdStatus: "absent",
        },
        true,
      ),
    ).toBe("thinking");
    expect(
      detectorPhaseOf(
        {
          contentStarted: true,
          inThinking: false,
          lastEvent: "",
          upstreamIdStatus: "absent",
        },
        true,
      ),
    ).toBe("response");
  });

  it("only the response phase gets the tight window", () => {
    const phases: DetectorPhase[] = [
      "no_response",
      "thinking",
      "response",
      "unobservable",
    ];
    const got = phases.map((p) => detectorPeriodFor(p, cfg));
    // Only "response" takes the tight window. "thinking" deliberately does NOT:
    // a byte-silent redacted-think must not trip the tight budget, which is the
    // whole reason the thinking phase is tracked at all.
    expect(got).toEqual([1_140_000, 1_140_000, 600_000, 1_140_000]);
  });

  it("the derived period is byte-identical to the predicate it replaced", () => {
    // Old expression: `peek.contentStarted && !peek.inThinking ? responseWaitMs
    // : noResponseWaitMs`. It had NO observability term, so the equivalence
    // claim has to be checked on BOTH values of `contentObservable`; the first
    // revision of this test passed `true` always, which is the half where the
    // two are trivially identical.
    for (const contentStarted of [false, true]) {
      for (const inThinking of [false, true]) {
        const peek = {
          contentStarted,
          inThinking,
          lastEvent: "",
          upstreamIdStatus: "absent" as const,
        };
        const old =
          peek.contentStarted && !peek.inThinking
            ? cfg.responseWaitMs
            : cfg.noResponseWaitMs;
        expect(detectorPeriodFor(detectorPhaseOf(peek, true), cfg)).toBe(old);
      }
    }
    // BLIND lane, REACHABLE states only. `contentStarted` is permanently false
    // there for the two structural reasons in `peekObservesContent`'s docblock
    // (each pinned separately by the drift guard above), so `inThinking` is the
    // only free variable — and this is the comparison the byte-identity claim
    // actually rests on.
    for (const inThinking of [false, true]) {
      const peek = {
        contentStarted: false,
        inThinking,
        lastEvent: "",
        upstreamIdStatus: "absent" as const,
      };
      const old =
        peek.contentStarted && !peek.inThinking
          ? cfg.responseWaitMs
          : cfg.noResponseWaitMs;
      expect(detectorPeriodFor(detectorPhaseOf(peek, false), cfg)).toBe(old);
    }
  });

  it("the ONE state where the derivation diverges from the old predicate is unreachable", () => {
    // `contentStarted: true` on a blind lane. The old expression hands back the
    // TIGHT window; the new one labels the read `unobservable` and hands back
    // the GENEROUS one. `detectorPhaseOf`'s docblock asserts this is the only
    // divergence and that it cannot occur — asserted here rather than argued,
    // because a reader who assumed byte-identity everywhere would "restore" the
    // tight window and give a structurally blind lane a 600 s budget.
    const peek = {
      contentStarted: true,
      inThinking: false,
      lastEvent: "",
      upstreamIdStatus: "absent" as const,
    };
    const old =
      peek.contentStarted && !peek.inThinking
        ? cfg.responseWaitMs
        : cfg.noResponseWaitMs;
    expect(old).toBe(cfg.responseWaitMs);
    expect(detectorPeriodFor(detectorPhaseOf(peek, false), cfg)).toBe(
      cfg.noResponseWaitMs,
    );
    // UNREACHABLE, and here is why: the blind lane is blind because
    // `peekOutboundEvent` never touches `contentStarted` on it. Fed BOTH the
    // real wire shape (no `type` field — dies one guard earlier) and the
    // hand-written shape a fixture author invents, the flag stays false, so the
    // state above cannot arise from any input.
    const live = newPeekState();
    peekOutboundEvent(
      {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hi" } }],
      },
      "openai_chat",
      live,
    );
    peekOutboundEvent({ type: "content_block_delta" }, "openai_chat", live);
    expect(live.contentStarted).toBe(false);
    expect(peekObservesContent("translated", "openai_chat")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. makeKeepAliveConfig — polarity + the D96 refusal
// ---------------------------------------------------------------------------

/** A minimal live `StallConfig`; only the two windows are read by the factory. */
function stallCfg(responseWaitMs = 600_000): StallConfig {
  return {
    noResponseWaitMs: 1_140_000,
    responseWaitMs,
    makeTimer: makeStallTimer,
    log: (): void => {
      /* not exercised here */
    },
  };
}

/** Run `fn` with `consola.warn` captured, restoring it even on a throw. */
function captureWarns(fn: () => void): string[] {
  const warned: string[] = [];
  const original = consola.warn;
  consola.warn = ((msg: unknown): void => {
    warned.push(String(msg));
  }) as typeof consola.warn;
  try {
    fn();
  } finally {
    consola.warn = original;
  }
  return warned;
}

describe("makeKeepAliveConfig — default polarity is OFF, not ON", () => {
  /**
   * MUTATION ARMED, and it is the single highest-likelihood copy-paste error in
   * this slice: write `if (cfg?.enabled === false) return undefined` — the idiom
   * BOTH sibling factories (`makeStallConfig`, `makeIncidentConfig`) use, because
   * both of those are on by default. Here it silently ships the keep-alive ON,
   * contrary to the requirement for an explicitly enabled sub-object. Under
   * that mutation the first three assertions below all return a config.
   */
  it("only an explicit `enabled: true` builds a config", () => {
    const stall = stallCfg();
    expect(makeKeepAliveConfig(undefined, stall)).toBeUndefined();
    expect(makeKeepAliveConfig({}, stall)).toBeUndefined();
    expect(makeKeepAliveConfig({ enabled: false }, stall)).toBeUndefined();
    expect(makeKeepAliveConfig({ enabled: true }, stall)).toBeDefined();
  });

  /**
   * F66 mitigation 2 — the three numbers are read with `??`, so an ENABLED but
   * otherwise empty sub-object still yields the documented defaults rather than
   * `NaN`/`undefined` leaking into the race. (The outer-literal half of F66 is
   * pinned in tests/types/config-schema.test.ts; a factory cannot see it.)
   */
  it("fills the documented defaults when only `enabled` is supplied", () => {
    const ka = makeKeepAliveConfig({ enabled: true }, stallCfg());
    expect(ka?.intervalMs).toBe(30_000);
    expect(ka?.requireFirstByte).toBe(true);
    expect(ka?.maxTotalMs).toBe(300_000);
    // A SEPARATE timer instance per call is the anti-cancellation property the
    // forwarder depends on: `makeStallTimer` holds ONE handle and `arm()` clears
    // it, so a shared instance would let the first keep-alive arm cancel the
    // stall deadline.
    expect(ka?.makeTimer()).not.toBe(ka?.makeTimer());
  });

  it("passes explicit values through unchanged", () => {
    const ka = makeKeepAliveConfig(
      {
        enabled: true,
        interval_ms: 5_000,
        require_first_byte: false,
        max_total_ms: 60_000,
      },
      stallCfg(),
    );
    expect(ka?.intervalMs).toBe(5_000);
    expect(ka?.requireFirstByte).toBe(false);
    expect(ka?.maxTotalMs).toBe(60_000);
  });
});

describe("makeKeepAliveConfig — REFUSES when the stall detector is off (D96)", () => {
  /**
   * MUTATION ARMED two ways:
   *   - drop the `stall === undefined` guard → a config is returned, i.e. a
   *     keep-alive with no detector behind it, which suppresses the CLIENT's own
   *     watchdog while nothing bounds a dead stream. That is the unbounded
   *     liveness lie D96 forbids, arriving through the refusal path.
   *   - drop the one-shot latch → the warn fires once per call. The factory runs
   *     PER REQUEST inside the streaming branch of all three handlers, so that
   *     is one log line per stream, forever.
   */
  it("returns undefined and warns EXACTLY once across repeated calls", () => {
    _resetKeepAliveWarnForTests();
    const warned = captureWarns(() => {
      for (let i = 0; i < 4; i += 1) {
        expect(
          makeKeepAliveConfig({ enabled: true }, undefined),
        ).toBeUndefined();
      }
    });
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("stall_detection");
  });

  it("stays silent when the keep-alive is off, detector or no detector", () => {
    _resetKeepAliveWarnForTests();
    const warned = captureWarns(() => {
      expect(makeKeepAliveConfig(undefined, undefined)).toBeUndefined();
      expect(
        makeKeepAliveConfig({ enabled: false }, undefined),
      ).toBeUndefined();
    });
    expect(warned).toEqual([]);
  });

  /**
   * Q6 — `interval_ms >= response_wait_ms` makes the feature INERT: the stall
   * fires before the first tick, so zero comments are emitted and nothing
   * distinguishes that from a working keep-alive on a quiet box (F163). It is a
   * warn and not a refusal, because inert is not harmful — the config is still
   * returned.
   *
   * MUTATION ARMED: drop the warn → `warned` is empty; print only one of the two
   * numbers → the `toContain` pair fails, and an operator cannot tell which side
   * of the comparison to change.
   */
  it("warns ONCE, with both numbers, when the interval cannot fit the window", () => {
    _resetKeepAliveWarnForTests();
    const warned = captureWarns(() => {
      for (let i = 0; i < 3; i += 1) {
        const ka = makeKeepAliveConfig(
          { enabled: true, interval_ms: 600_000 },
          stallCfg(600_000),
        );
        expect(ka).toBeDefined();
      }
    });
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("600000");
    expect(warned[0]).toContain("interval_ms");
    // The healthy configuration must NOT warn — otherwise the signal is noise.
    _resetKeepAliveWarnForTests();
    expect(
      captureWarns(() => {
        makeKeepAliveConfig(
          { enabled: true, interval_ms: 30_000 },
          stallCfg(600_000),
        );
      }),
    ).toEqual([]);
  });

  /**
   * The inertness warn must compare the interval against the MINIMUM of the two
   * stall windows, not against `response_wait_ms` alone.
   *
   * Under the SHIPPED defaults `response_wait_ms` (600 000) IS the tighter of the
   * two, so a check against it alone is correct today — which is exactly why the
   * defect was invisible. On a retuned config where `no_response_wait_ms` drops
   * below `interval_ms` while `response_wait_ms` stays above it, the no-response
   * stall closes before the first keep-alive tick and the feature is INERT, while
   * the warn promising to catch that stays SILENT. That is the "inert and working
   * look identical on a quiet box" case (F163) the warn exists to prevent.
   *
   * Found by the D118 cross-family gate, which read the comment's promise ("the
   * tighter of the two windows") against the implementation.
   *
   * MUTATION ARMED, and this is the arm that matters: revert `tighterMs` to
   * `stall.responseWaitMs` and this test fails — 300 000 < 600 000, so no warn is
   * emitted and `warned.length` is 0 against the expected 1.
   */
  it("warns on the NO-RESPONSE window when it is the tighter one", () => {
    _resetKeepAliveWarnForTests();
    const skewed: StallConfig = {
      noResponseWaitMs: 60_000, // BELOW the interval — the window that bites
      responseWaitMs: 600_000, // ABOVE it — what the old check looked at
      makeTimer: makeStallTimer,
      log: (): void => {
        /* not exercised here */
      },
    };
    const warned = captureWarns(() => {
      const ka = makeKeepAliveConfig(
        { enabled: true, interval_ms: 300_000 },
        skewed,
      );
      // Still INERT-not-harmful: the config is returned, only a warn is emitted.
      expect(ka).toBeDefined();
    });
    expect(warned.length).toBe(1);
    // Both windows are named, so an operator can see WHICH one is binding.
    expect(warned[0]).toContain("60000");
    expect(warned[0]).toContain("600000");
    expect(warned[0]).toContain("300000");
  });
});
