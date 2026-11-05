/**
 * registry_baseline_installed.test.ts — SELF-CHECK for the registry preload.
 *
 * tests/_registry_baseline.ts has three ways to look applied and do nothing,
 * all of which would otherwise leave the suite green:
 *   1. the `preload` key lands under `[install]` instead of `[test]` in
 *      bunfig.toml — TOML table scoping makes it `install.preload`, which is
 *      a no-op even under `bun test`;
 *   2. the preload loses its `import "~/lib/transform/index.ts"` — it then
 *      snapshots an empty baseline and every refill is a no-op;
 *   3. the beforeEach stops actually refilling.
 *
 * WHICH GUARD CATCHES WHICH — stated precisely, because an earlier version of
 * this docblock claimed "these two tests fail loudly on all three" and that is
 * not true of mode 2:
 *   - mode 1 → `marker()` below throws, in BOTH tests, carrying the fix.
 *   - mode 2 → the PRELOAD's own throw, at module-evaluation time. The run
 *     aborts before either test here executes, so these tests do not catch it;
 *     they are simply never reached. `toBeGreaterThan(0)` in test A therefore
 *     cannot fail as written — it is defence-in-depth that only becomes a live
 *     detector if that throw is ever removed.
 *   - mode 3 → test B, and ONLY when test A ran first. Test A's `reset()` is
 *     the entire reason B is non-trivial: without it B compares the untouched
 *     preload baseline against itself and passes even with the refill deleted.
 *     That coupling is silent under `-t` filtering or a future file split, so
 *     it is enforced explicitly by `testARan` rather than left to convention.
 *
 * Do not `import` the preload here — that would evaluate it on demand and fake
 * the marker, so the check would pass while the fix did nothing.
 */

import { describe, expect, test } from "bun:test";

import { list, reset } from "~/lib/transform/registry";

/**
 * Set by test A. Test B is only a real detector when A ran immediately before
 * it; this makes that precondition loud instead of silently vacuous.
 */
let testARan = false;

function marker(): { body: number; stream: number } {
  const m = globalThis.__registry_baseline__;
  if (m === undefined) {
    throw new Error(
      "tests/_registry_baseline.ts did not run as a preload. bunfig.toml " +
        "needs a [test] table (NOT [install]) containing: preload = " +
        '["./tests/_registry_baseline.ts"]',
    );
  }
  return m;
}

describe("registry baseline preload", () => {
  test("A: ran as a preload and captured a non-empty built-in baseline", () => {
    testARan = true;

    expect(marker().body).toBeGreaterThan(0);
    expect(marker().stream).toBeGreaterThan(0);

    // Wipe, so test B can prove the refill actually happens. Both surfaces are
    // asserted empty: B compares the stream count too, and that comparison is
    // only meaningful if reset() really cleared the stream map.
    reset();
    expect(list("body")).toHaveLength(0);
    expect(list("stream_event")).toHaveLength(0);
  });

  test("B: refilled the registry that test A wiped", () => {
    if (!testARan) {
      throw new Error(
        "test A did not run before test B, so this assertion cannot detect a " +
          "broken refill: with no preceding reset() it compares the untouched " +
          "preload baseline against itself and passes even if the beforeEach " +
          "in tests/_registry_baseline.ts were deleted entirely. Run the whole " +
          "file without a -t filter, and keep both tests in this one file.",
      );
    }

    expect(list("body")).toHaveLength(marker().body);
    expect(list("stream_event")).toHaveLength(marker().stream);
  });
});
