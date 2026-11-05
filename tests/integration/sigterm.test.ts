/**
 * sigterm.test.ts — D-LOCK-8B graceful shutdown via process signals.
 *
 * Per discriminator M-SIGTERM-Bun-Windows: Bun on Windows has shaky signal
 * compat, so the suite below SKIPS on Windows. THIS FILE is the Linux-side
 * gate; the Windows-equivalent gate is in `sigterm.windows-fallback.test.ts`
 * (which exercises serverHandle.close() directly without going through process
 * signals), and the slow drain variants live in `sigterm_drain.test.ts` behind
 * `SLOW_TESTS=1 && !IS_WINDOWS`. Note none of those carry in-flight load at
 * signal time either — see that file's Coverage note before assuming otherwise.
 *
 * These tests spawn `bun run src/main.ts` as a child process, send signals,
 * and verify the documented drain behavior.
 *
 * ⚠ INVARIANT, no exceptions — attach the `exit` listener BEFORE the first
 * `await` that follows `spawn(...)`. Not merely before the first `kill(...)`:
 * `exit` is one-shot and EventEmitter does not replay it to a late listener,
 * so a child that dies during ANY earlier await leaves the promise permanently
 * unsettled and hangs the test to its FULL timeout budget. Every site in this
 * file and in `sigterm_drain.test.ts` satisfies this.
 *
 * The rule is stated with NO exceptions on purpose. A narrower version that
 * exempted sites carrying a `toContain("listening")` assert is not sound: such
 * an assert says nothing about a child dying AFTER it, and drain Test 2 has a
 * 200 ms await in exactly that position. Registering early costs nothing — the
 * promise is resolve-only, adds no libuv ref, and suppresses no default
 * behaviour. It CAN settle before it is awaited (that is the whole point: a
 * boot-time death resolves it early instead of stranding it), and an
 * already-settled resolve-only promise is harmless to await later.
 *
 * Not hypothetical: a listener attached after an inter-kill sleep kept the
 * second test below red on Linux CI, at ~15000 ms in each of the four runs
 * whose timings are recorded in D79. What the fix buys is a BOUNDED failure
 * rather than a hang — not an instant one, since neither wait loop checks child
 * liveness and both still spin their full 5000 ms first.
 */

import { describe, expect, it } from "bun:test";

import { makeProxySandbox } from "../helpers/proxy_sandbox.ts";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("sigterm — child-process drain (Linux only)", () => {
  it("SIGTERM triggers graceful shutdown within ~5s", async () => {
    const { spawn } = await import("node:child_process");
    const sandbox = await makeProxySandbox("sigterm-drain-");
    try {
      const proc = spawn("bun", ["run", "src/main.ts"], {
        env: sandbox.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuf = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
      });
      // Register the exit listener before the first await — file-level invariant.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      // Wait until stdout reports "listening" or 5s timeout.
      const t_wait = Date.now();
      while (!stdoutBuf.includes("listening") && Date.now() - t_wait < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stdoutBuf).toContain("listening");
      // Send SIGTERM.
      proc.kill("SIGTERM");
      // NOTE: "exit" fires before stdio is guaranteed drained ("close" is the
      // draining signal), so the `toContain("draining")` assertion below is
      // structurally flake-exposed. Tracked as risk R4 and still left as-is.
      // ⚠ Do NOT reuse the justification this comment previously carried
      // ("a test that has never executed on any platform") — that is false.
      // This case ran red on Linux CI (run 30146602385, failing at 5021.24 ms
      // on the `listening` assert for want of the banner) and has passed on
      // every run since CONSOLA_LEVEL=3 landed in 30321281082. It is left
      // alone because it passes consistently now and a speculative rewrite of
      // a green test is the larger risk.
      const exitCode = await exited;
      expect(exitCode).toBe(0);
      expect(stdoutBuf).toContain("draining");
    } finally {
      await sandbox.cleanup();
    }
  }, 15000);

  it("second SIGTERM is harmless — exit stays 0 (force-exit branch NOT covered)", async () => {
    const { spawn } = await import("node:child_process");
    const sandbox = await makeProxySandbox("sigterm-force-");
    try {
      const proc = spawn("bun", ["run", "src/main.ts"], {
        env: sandbox.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuf = "";
      proc.stdout?.on("data", (c: Buffer) => {
        stdoutBuf += c.toString("utf-8");
      });
      // Register BEFORE the first await after spawn() — file-level invariant.
      // This test has no `toContain("listening")` assert, so early
      // registration is the ONLY thing standing between a boot-time child
      // death and a full-budget hang.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      const t_wait = Date.now();
      while (!stdoutBuf.includes("listening") && Date.now() - t_wait < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // ⚠ COVERAGE NOTICE — READ BEFORE TRUSTING THIS TEST'S GREEN.
      //
      // This test does NOT exercise the force-exit branch
      // (src/main.ts:508-518), and it never has — the name now says so. With
      // zero in-flight requests the FIRST SIGTERM's graceful path
      // (`handle.close({graceMs:30_000})` with nothing to drain, then
      // `exit(0)`) completes well inside the 100 ms gap below, so the second
      // kill lands on an already-dead process and `expect(exitCode).toBe(0)`
      // passes for the ordinary graceful reason.
      //
      // What it DOES verify, branch-agnostically: a redundant second SIGTERM
      // never perturbs the exit code — 0 whether the signal is swallowed by an
      // already-dead child (today) or handled by the force branch (if some
      // future change made the drain outlast the 100 ms gap). Real, but modest.
      //
      // ⚠ CORRECTION (D79). The prior text here claimed the CONSOLA_LEVEL fix
      // flipped this test red→green. That is FALSE. The FIRST-EVER CI run
      // (30146602385 — pre-sandbox, pre-CONSOLA_LEVEL) already timed out at
      // 15001.28 ms, and all four Linux runs sit at 15001.28 / 15000.00 /
      // 15000.01 / 15000.04 — deterministic and INVARIANT. This test has never
      // been green anywhere. Its redness was the late-`exit`-listener defect
      // fixed just below (see the file-level invariant), not a missing banner.
      // R3's CONCLUSION (branch uncovered) stands; its stated MECHANISM did not.
      //
      // Genuinely covering the force branch needs an in-flight request pinning
      // `handle.close({graceMs:30_000})` open across the second signal —
      // deferred per D79/C-2, deliberately NOT done here. The only other test
      // shaped for it is sigterm_drain.test.ts Test 3, which carries the same
      // gap and is default-skipped behind SLOW_TESTS, so it has never run.
      //
      // ⚠ Trap for that follow-up: `consola.warn` writes to STDERR, and THIS
      // test registers a `proc.stdout` handler only — grep this test body for
      // `proc.stderr` and you will find none. A `toContain("force-closing")`
      // assertion would therefore silently never match as the file stands. The
      // sibling test above pipes BOTH streams into its buffer; copy that shape
      // first. (Intra-file line numbers are deliberately not cited anywhere in
      // this file — they drift on the next edit. References to src/main.ts are
      // fine; that file is not touched here.)

      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      proc.kill("SIGTERM");
      const exitCode = await exited;
      expect(exitCode).toBe(0);
    } finally {
      await sandbox.cleanup();
    }
  }, 15000);
});

// Sanity placeholder to keep the file's case-count >0 even on Windows.
describe("sigterm — windows skip notice", () => {
  it.skipIf(!isWindows)(
    "Windows: sigterm signal test skipped; see sigterm.windows-fallback.test.ts",
    () => {
      expect(true).toBe(true);
    },
  );
});
