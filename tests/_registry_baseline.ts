/**
 * _registry_baseline.ts — `bun test` preload (wired in bunfig.toml `[test]`).
 *
 * WHY. The transform registry is a module-level singleton filled by the
 * side-effect import of the generated barrel (src/lib/transform/index.ts).
 * Test files that call `reset()` wipe it, and a later
 * `import "~/lib/transform/index.ts"` is an ES-module cache hit that
 * re-registers nothing — so whether a given file sees a warm registry
 * depends on which file ran before it. Registry-dependent assertions are
 * therefore order-dependent, and against an *empty* registry the escape
 * hatch in src/types/config-schema.ts accepts every rule name, so they can
 * pass while verifying nothing.
 *
 * WHAT. Snapshot the built-ins ONCE here, at preload time, while the barrel
 * is guaranteed freshly evaluated; then before every test re-register only
 * the names that are MISSING. Entries already present are never touched, so
 * a test's deliberate override survives and test-only rules are never wiped.
 * This re-registers by VALUE from the captured snapshot — the only mechanism
 * that survives a mid-run `reset()`, unlike a re-import.
 *
 * NOT a test file (no `.test.ts` suffix); Bun never collects it.
 * Its self-check lives in tests/registry_baseline_installed.test.ts.
 */

import { beforeEach } from "bun:test";

import "~/lib/transform/index.ts";
import {
  register,
  registerStreamEvent,
  snapshot,
} from "~/lib/transform/registry";

declare global {
  /**
   * Set ONLY when this module is evaluated as a preload. Read by
   * tests/registry_baseline_installed.test.ts — that assertion is what turns
   * a mis-scoped `preload` key into a red run instead of a silent no-op.
   * Never `import` this module from a test: that would evaluate it on demand
   * and fake the marker.
   */
  var __registry_baseline__: { body: number; stream: number } | undefined;
}

const BASELINE_BODY = snapshot("body");
const BASELINE_STREAM = snapshot("stream_event");

// Fail loud, at preload time, if the barrel did not populate the registry.
// Without this an empty baseline makes every refill below a no-op and the
// whole preload becomes invisible — a green run that changed nothing.
if (BASELINE_BODY.size === 0 || BASELINE_STREAM.size === 0) {
  throw new Error(
    `_registry_baseline: the barrel import did not populate the registry ` +
      `(body=${BASELINE_BODY.size} stream=${BASELINE_STREAM.size}). ` +
      `Generate it first: bun run scripts/gen_barrel.ts`,
  );
}

globalThis.__registry_baseline__ = {
  body: BASELINE_BODY.size,
  stream: BASELINE_STREAM.size,
};

beforeEach(() => {
  const live_body = snapshot("body");
  for (const [name, reg] of BASELINE_BODY) {
    if (!live_body.has(name)) {
      register(name, reg.fn, reg.schema, reg.opts);
    }
  }
  const live_stream = snapshot("stream_event");
  for (const [name, reg] of BASELINE_STREAM) {
    if (!live_stream.has(name)) {
      registerStreamEvent(name, reg.fn, reg.schema, reg.opts);
    }
  }
});
