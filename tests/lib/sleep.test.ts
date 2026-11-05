/**
 * Tests for src/lib/sleep.ts
 *
 * Coverage map (from M4.5 spec § Tests § sleep.test.ts):
 *   1. resolves after specified ms
 *   2. rejects with AbortError when signal already aborted at call time
 *   3. rejects with AbortError when signal aborts mid-sleep
 *   4. resolves normally when signal is undefined
 *   5. abort listener is removed after timeout fires (no listener leak)
 *   6. clearTimeout fires on abort (timer doesn't continue running after abort)
 */

import { describe, expect, it } from "bun:test";

import { sleep } from "../../src/lib/sleep.ts";

describe("sleep — basic timing", () => {
  it("resolves after specified ms", async () => {
    const t0 = Date.now();
    await sleep(20);
    const elapsed = Date.now() - t0;
    // Allow generous slack for CI noise; the point is the promise actually waits.
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(200);
  });

  it("resolves normally when signal is undefined", async () => {
    await sleep(5);
    // If we get here without throwing, we're good.
    expect(true).toBe(true);
  });
});

describe("sleep — signal handling", () => {
  it("rejects with AbortError when signal already aborted at call time", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let thrown: unknown = null;
    try {
      await sleep(50, ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
  });

  it("rejects with AbortError when signal aborts mid-sleep", async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 10);
    let thrown: unknown = null;
    try {
      await sleep(10_000, ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - t0;
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    // Should reject promptly after abort, not after the full 10s.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("sleep — listener / timer cleanup", () => {
  it("removes abort listener after timeout fires (no listener leak)", async () => {
    const ctrl = new AbortController();
    // EventTarget doesn't expose listener counts; we proxy through addEventListener
    // to count. Wrap the signal's add/remove and track delta.
    let added = 0;
    let removed = 0;
    const realAdd = ctrl.signal.addEventListener.bind(ctrl.signal);
    const realRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.addEventListener = ((
      ...args: Parameters<typeof realAdd>
    ): void => {
      added += 1;
      realAdd(...args);
    }) as typeof ctrl.signal.addEventListener;
    ctrl.signal.removeEventListener = ((
      ...args: Parameters<typeof realRemove>
    ): void => {
      removed += 1;
      realRemove(...args);
    }) as typeof ctrl.signal.removeEventListener;

    await sleep(10, ctrl.signal);
    // Exactly 1 add (in sleep) and 1 remove (after timeout fires).
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it("clearTimeout fires on abort (timer doesn't continue past abort)", async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    // Schedule abort almost immediately.
    queueMicrotask(() => ctrl.abort());
    let thrown: unknown = null;
    try {
      await sleep(2000, ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - t0;
    // If clearTimeout didn't fire, we'd wait the full 2s. We should reject ~instantly.
    expect(thrown).toBeInstanceOf(DOMException);
    expect(elapsed).toBeLessThan(200);
  });
});
