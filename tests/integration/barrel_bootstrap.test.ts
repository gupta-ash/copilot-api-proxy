/**
 * barrel_bootstrap.test.ts — proves the side-effect import
 * `import "~/lib/transform/index.ts"` in `src/types/config-schema.ts` is
 * load-bearing in production.
 *
 * WHY THIS NEEDS A CHILD PROCESS. That import is the only one of the
 * generated barrel anywhere in `src/` (the other `transform/index` hits, in
 * `src/lib/config.ts` and `src/main.ts`, are comment prose, not imports). It
 * is therefore the sole thing that registers the BUILT-IN rules in a
 * production boot — `custom-loader.ts` populates the registry too, but only
 * with operator drop-ins from `transforms.custom_dir`. But `bunfig.toml`'s
 * `[test] preload` imports the barrel itself (`tests/_registry_baseline.ts`),
 * so under `bun test` the registry is warm no matter what `config-schema.ts`
 * does — with the import deleted, this file's case is the only one of the
 * suite's 1569 that fails (measured). `bun -e` does NOT run the `[test]`
 * preload (measured: `globalThis.__registry_baseline__` is undefined there),
 * so a child is the only place in the suite that can observe the loss.
 *
 * WHAT PRODUCTION LOSES WITHOUT IT. With `NODE_ENV=production` and an empty
 * body registry, `RuleSchema` refuses every rule with "Cannot validate rules:
 * body registry is empty (barrel auto-gen broken?)"; the stream-event schema
 * carries the same guard for `stream_event`. Both are in
 * `src/types/config-schema.ts`.
 *
 * ⚠ INVARIANT (D80/F82) — attach the terminal-event listener BEFORE the first
 * `await` that follows `spawn(...)`. `close` (like `exit`) is one-shot and
 * EventEmitter does not replay it to a late listener, so a child that dies
 * during any earlier await leaves the promise permanently unsettled and hangs
 * the test to its full timeout budget. This file syncs on `close` rather than
 * `exit` so stdio is drained before the output is read — see the note at the
 * listener. `sigterm.test.ts` carries the full statement of the rule.
 */

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * Child program. Imports `config-schema.ts` and NOTHING else that touches the
 * transform layer, then reports what the registry holds. Importing the schema
 * module binds no port and writes no files, so this is safe to run against a
 * machine already serving a live proxy.
 *
 * Written as joined lines rather than a template literal so the inner source
 * needs no backtick or `${}` escaping.
 */
const CHILD_SOURCE = [
  'import "~/types/config-schema.ts";',
  'import { list } from "~/lib/transform/registry.ts";',
  "",
  "process.stdout.write(",
  '  "BARREL_BOOTSTRAP body=" + list("body").length +',
  '  " stream_event=" + list("stream_event").length + "\\n",',
  ");",
].join("\n");

const MARKER = /BARREL_BOOTSTRAP body=(\d+) stream_event=(\d+)/;

describe("barrel bootstrap — config-schema.ts is the production entry point", () => {
  test("importing config-schema.ts alone fills both registries", async () => {
    const proc = spawn("bun", ["-e", CHILD_SOURCE], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    // Register the listener before the first await — see file docblock.
    //
    // `close`, NOT `exit`: `exit` fires when the child terminates, which is
    // BEFORE its stdio pipes are drained, so a marker still sitting in the pipe
    // buffer can be missed and `toMatch` fails spuriously. `close` fires only
    // after every stdio stream has ended, so the output read below is complete
    // by construction rather than by timing luck. The suite already carries
    // this defect elsewhere as a known deferred item; a new spawn site should
    // not reproduce it. Bounded by this test's own 30 s budget, so a pipe held
    // open by a hypothetical grandchild fails loudly rather than hanging
    // forever — `bun -e` here spawns none.
    const exited = new Promise<number>((resolveExit) => {
      proc.on("close", (code) => resolveExit(code ?? -1));
    });
    const exitCode = await exited;

    // Asserted before the exit code on purpose: this one prints the child's
    // full stdout+stderr on failure, so an import-time throw stays legible.
    expect(output).toMatch(MARKER);
    expect(exitCode).toBe(0);

    const counts = MARKER.exec(output);
    // A zero on either line means the barrel side-effect import at the top of
    // src/types/config-schema.ts is gone. Restore it; do not relax this test.
    expect(Number(counts?.[1])).toBeGreaterThan(0);
    expect(Number(counts?.[2])).toBeGreaterThan(0);
  }, 30000);
});
