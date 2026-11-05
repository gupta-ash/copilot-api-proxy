/**
 * Tests for src/lib/debug.ts
 *
 * Coverage:
 *   - level constants are correctly ordered
 *   - parseLevel maps known names + safely defaults unknown
 *   - setLevel/getLevel round-trip
 *   - lazy-eval guard: msgFn is NOT invoked when current level is below threshold
 *     (the canonical "L1 review fix" check from the spec)
 */

import { afterEach, describe, expect, it } from "bun:test";
import { LogLevels, consola } from "consola";

import {
  LEVEL_OFF,
  LEVEL_ON,
  LEVEL_RAW,
  LEVEL_VERBOSE,
  consolaLevelFor,
  debug,
  parseLevel,
} from "../../src/lib/debug.ts";

afterEach(() => {
  // Restore default so tests are order-independent.
  debug.setLevel(LEVEL_ON);
});

describe("level constants", () => {
  it("are strictly ordered off < on < raw < verbose", () => {
    expect(LEVEL_OFF).toBe(0);
    expect(LEVEL_ON).toBe(1);
    expect(LEVEL_RAW).toBe(2);
    expect(LEVEL_VERBOSE).toBe(3);
  });
});

describe("parseLevel", () => {
  it("maps each known level (case-insensitive)", () => {
    expect(parseLevel("off")).toBe(LEVEL_OFF);
    expect(parseLevel("OFF")).toBe(LEVEL_OFF);
    expect(parseLevel("on")).toBe(LEVEL_ON);
    expect(parseLevel("On")).toBe(LEVEL_ON);
    expect(parseLevel("raw")).toBe(LEVEL_RAW);
    expect(parseLevel("verbose")).toBe(LEVEL_VERBOSE);
  });

  it("defaults to LEVEL_ON for unknown names", () => {
    expect(parseLevel("debug")).toBe(LEVEL_ON);
    expect(parseLevel("")).toBe(LEVEL_ON);
    expect(parseLevel("trace")).toBe(LEVEL_ON);
  });
});

describe("setLevel / getLevel", () => {
  it("round-trips each level", () => {
    debug.setLevel(LEVEL_OFF);
    expect(debug.getLevel()).toBe(LEVEL_OFF);
    debug.setLevel(LEVEL_VERBOSE);
    expect(debug.getLevel()).toBe(LEVEL_VERBOSE);
    debug.setLevel(LEVEL_RAW);
    expect(debug.getLevel()).toBe(LEVEL_RAW);
  });
});

describe("lazy-eval guard (L1 review fix)", () => {
  it("does NOT invoke msgFn when level is OFF", () => {
    debug.setLevel(LEVEL_OFF);
    let calls = 0;
    debug.on(LEVEL_RAW, () => {
      calls++;
      return "expensive message";
    });
    expect(calls).toBe(0);
  });

  it("does NOT invoke msgFn when current level is below the requested level", () => {
    debug.setLevel(LEVEL_ON);
    let calls = 0;
    debug.on(LEVEL_RAW, () => {
      calls++;
      return "raw payload";
    });
    debug.on(LEVEL_VERBOSE, () => {
      calls++;
      return "verbose payload";
    });
    expect(calls).toBe(0);
  });

  it("DOES invoke msgFn when current level meets or exceeds the requested level", () => {
    debug.setLevel(LEVEL_VERBOSE);
    let calls = 0;
    debug.on(LEVEL_RAW, () => {
      calls++;
      return "raw payload";
    });
    debug.on(LEVEL_VERBOSE, () => {
      calls++;
      return "verbose payload";
    });
    expect(calls).toBe(2);
  });

  it("LEVEL_OFF as the threshold is a no-op (the API forbids emitting at OFF)", () => {
    debug.setLevel(LEVEL_VERBOSE);
    let calls = 0;
    debug.on(LEVEL_OFF, () => {
      calls++;
      return "should never run";
    });
    expect(calls).toBe(0);
  });
});

/**
 * F244 — `debug.on` emits through `consola.debug`, a LogLevels.debug (4) call,
 * and consola applies its OWN level filter on top of ours. It defaults to 3, so
 * every one of the 62 `debug.on` sites was silently discarded AFTER passing our
 * gate, at any `config.logging.level`.
 *
 * ⚠ **These tests deliberately assert on a consola REPORTER, not on
 * `consola.debug`.** The suite already had a spy-on-`consola.debug` test
 * (`tests/services/copilot/_retry.test.ts`, F135) and it passed throughout,
 * because a spy REPLACES the method and therefore bypasses the very filter that
 * was dropping the message. That is why 1824 tests were blind to this. A
 * reporter sits on the far side of the filter, so it can fail on this fault —
 * mutation-check by reverting `setLevel` to assign only `currentLevel`.
 */
describe("consola level coupling (F244)", () => {
  const original = consola.level;
  afterEach(() => {
    consola.level = original;
  });

  /** Capture what actually survives consola's filter, without printing it. */
  function reaching(fn: () => void): string[] {
    const seen: string[] = [];
    const reporter = {
      log: (obj: { type: string }) => void seen.push(obj.type),
    };
    consola.addReporter(reporter);
    try {
      fn();
    } finally {
      consola.removeReporter(reporter);
    }
    return seen;
  }

  it("consolaLevelFor keeps OFF at info and raises every emitting level to debug", () => {
    // OFF stays at info (3) on purpose: main.ts's bootstrap consola.info calls,
    // including the `listening on ...` banner both sigterm.test.ts and the :4144
    // gate harness watch for, print today even at logging.level: off.
    expect(consolaLevelFor(LEVEL_OFF)).toBe(LogLevels.info);
    expect(consolaLevelFor(LEVEL_ON)).toBe(LogLevels.debug);
    expect(consolaLevelFor(LEVEL_RAW)).toBe(LogLevels.debug);
    expect(consolaLevelFor(LEVEL_VERBOSE)).toBe(LogLevels.debug);
  });

  it("setLevel drives consola's level, not just ours", () => {
    debug.setLevel(LEVEL_OFF);
    expect(consola.level).toBe(LogLevels.info);
    debug.setLevel(LEVEL_ON);
    expect(consola.level).toBe(LogLevels.debug);
    debug.setLevel(LEVEL_RAW);
    expect(consola.level).toBe(LogLevels.debug);
    debug.setLevel(LEVEL_VERBOSE);
    expect(consola.level).toBe(LogLevels.debug);
  });

  it("a verbose debug.on message REACHES a reporter (the F135 capture is observable)", () => {
    debug.setLevel(LEVEL_VERBOSE);
    const seen = reaching(() => {
      debug.on(LEVEL_VERBOSE, () => ({ msg: "Outbound upstream request" }));
    });
    expect(seen).toEqual(["debug"]);
  });

  it("a LEVEL_ON debug.on message reaches a reporter too (the 18 on-level sites)", () => {
    debug.setLevel(LEVEL_ON);
    const seen = reaching(() => {
      debug.on(LEVEL_ON, () => "on-level diagnostic");
    });
    expect(seen).toEqual(["debug"]);
  });

  it("OFF is never quieter than info, even starting from a lower level", () => {
    // Pinned explicitly rather than inherited. Another suite file leaves
    // `consola.level = 1` behind, and relying on that made this fail for a
    // borrowed reason instead of a stated one. The claim under test is that
    // setLevel(OFF) RAISES a too-quiet consola back to info, so the bootstrap
    // banner survives a config that asked only for our own gate to be shut.
    consola.level = LogLevels.warn;
    debug.setLevel(LEVEL_OFF);
    const seen = reaching(() => {
      debug.on(LEVEL_VERBOSE, () => "must not appear");
      consola.info("copilot-proxy listening on http://127.0.0.1:4143");
    });
    expect(seen).toEqual(["info"]);
  });
});
