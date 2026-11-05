/**
 * sigterm_drain.test.ts -- M12 D-LOCK-8 (verifies the 30s SIGTERM grace
 * drain implemented at main.ts:505-537). NOT a re-implementation; the
 * production code is correct as-is per D38 iter-1 M3 fix.
 *
 * **Default-skip behind SLOW_TESTS=1.** Each test spawns a child process
 * and sleeps for several seconds; running them in every `bun test` would
 * add ~30s+ per run. Set `SLOW_TESTS=1` (env var) to enable.
 *
 * **Windows nuance.** SIGTERM is POSIX. Windows has no signal delivery:
 * Node/Bun implement `subprocess.kill('SIGTERM')` as a forced
 * TerminateProcess, so the main.ts handler does NOT run and the graceful drain
 * is never exercised there. Accordingly the suite is gated
 * `SLOW_TESTS && !IS_WINDOWS` (see SLOW_ENABLED below) and genuinely cannot
 * run on Windows. An earlier version of this paragraph was wrong twice: it
 * claimed the suite asserted "the same exit-code behavior on both platforms"
 * (contradicting its own gate) and that the handler runs on Windows as
 * documented (it does not). The Windows-equivalent gate is
 * tests/integration/sigterm.windows-fallback.test.ts, which drives
 * serverHandle.close() directly. We use the bun runner (`bun run src/main.ts`)
 * to spawn so platform behavior matches production.
 *
 * ⚠ INVARIANT, no exceptions — attach the `exit` listener BEFORE the first
 * `await` that follows `spawnV2()`. Not merely before the first `kill(...)`:
 * `exit` is one-shot and is not replayed to a late listener, so a child dying
 * during any earlier await leaves the promise unsettled and hangs the test to
 * its full budget. All four tests below satisfy this.
 *
 * The rule is stated with NO exceptions on purpose. A narrower version that
 * exempted Tests 1 and 2 because their `toContain("listening")` asserts fail
 * fast is not sound: such an assert says nothing about a child dying AFTER it,
 * and Test 2 has a 200 ms await in exactly that position. Registering early
 * costs nothing — the promise is resolve-only and adds no libuv ref. It CAN
 * settle before it is awaited, which is precisely the point, and awaiting an
 * already-settled resolve-only promise is harmless.
 *
 * Coverage:
 *   1. Bare drain — spawn, wait for "listening", SIGTERM, exit code 0
 *      within 30s (under no in-flight load).
 *   2. Drain after a COMPLETED /health request — issues one `fetch` to the
 *      non-streaming `/health` route, waits 200 ms (so the response has
 *      already arrived), then SIGTERMs. ⚠ Nothing is in flight and there is no
 *      stream at kill time: `/health` answers synchronously (`src/server.ts`),
 *      so deleting the fetch would not change this test's result and it is
 *      effectively Test 1. Genuine mid-stream drain coverage is the deferred
 *      follow-up (D79).
 *   3. Second signal after the drain already finished — SIGTERM, wait 1s,
 *      SIGTERM again, exit code 0. Does NOT reach the force branch
 *      (main.ts:508-518); see the notice on the test itself.
 *   4. SIGINT parity (optional) — same shape as Test 1 with SIGINT.
 */

import { afterAll, describe, expect, it } from "bun:test";

import {
  makeProxySandbox,
  type ProxySandbox,
} from "../helpers/proxy_sandbox.ts";

const SLOW_TESTS = process.env["SLOW_TESTS"] === "1";
// Per existing tests/integration/sigterm.test.ts: Bun on Windows has
// shaky signal compatibility; signal-based child-process tests skip on
// Windows. The Windows-equivalent gate is in
// tests/integration/sigterm.windows-fallback.test.ts which exercises
// serverHandle.close() directly without going through process signals.
const IS_WINDOWS = process.platform === "win32";
const SLOW_ENABLED = SLOW_TESTS && !IS_WINDOWS;

interface SpawnedProc {
  proc: import("node:child_process").ChildProcessWithoutNullStreams;
  stdoutBuf: { value: string };
}

/**
 * Every sandbox handed out by `spawnV2`, so a single `afterAll` can remove them
 * all. `spawnV2` has several call sites with no shared teardown, and leaking a
 * temp dir per spawn is sloppy even though the OS would eventually reap them.
 */
const sandboxes: ProxySandbox[] = [];

afterAll(async () => {
  await Promise.all(sandboxes.map((s) => s.cleanup()));
  sandboxes.length = 0;
});

async function spawnV2(
  extraEnv: Record<string, string> = {},
): Promise<SpawnedProc> {
  const { spawn } = await import("node:child_process");
  // HOME-sandboxed: without this the child resolves PATHS.APP_DIR from the
  // operator's real home and OVERWRITES the live :4143 proxy's meta.json.
  // See tests/helpers/proxy_sandbox.ts for why XDG_DATA_HOME is not a lever.
  const sandbox = await makeProxySandbox("sigterm-drain-", extraEnv);
  sandboxes.push(sandbox);
  const proc = spawn("bun", ["run", "src/main.ts"], {
    env: sandbox.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutBuf = { value: "" };
  proc.stdout.on("data", (c: Buffer) => {
    stdoutBuf.value += c.toString("utf-8");
  });
  proc.stderr.on("data", (c: Buffer) => {
    stdoutBuf.value += c.toString("utf-8");
  });
  return { proc, stdoutBuf };
}

async function waitForListening(
  buf: { value: string },
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!buf.value.includes("listening") && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!SLOW_ENABLED)(
  "SIGTERM drain (slow; SLOW_TESTS=1 + non-Windows to enable)",
  () => {
    it("Test 1 — bare drain: SIGTERM triggers clean exit within 30s", async () => {
      const { proc, stdoutBuf } = await spawnV2();
      // Register before the first await — file-level invariant.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      await waitForListening(stdoutBuf, 5000);
      expect(stdoutBuf.value).toContain("listening");
      proc.kill("SIGTERM");
      const exitCode = await exited;
      expect(exitCode).toBe(0);
      expect(stdoutBuf.value).toContain("draining");
    }, 35000);

    it("Test 2 — drain after a COMPLETED /health request (nothing in flight at signal time)", async () => {
      const { proc, stdoutBuf } = await spawnV2();
      // Register before the first await — file-level invariant. This is the
      // site that motivated stating the invariant with NO exceptions: the
      // `toContain("listening")` assert below does NOT protect it, because the
      // 200 ms await further down sits between that assert and the kill.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      await waitForListening(stdoutBuf, 5000);
      expect(stdoutBuf.value).toContain("listening");

      // Extract bound port from stdout (consola line: 'listening on http://0.0.0.0:NNNNN').
      const portMatch = stdoutBuf.value.match(
        /listening on http:\/\/[^:]+:(\d+)/,
      );
      const port = portMatch !== null ? Number(portMatch[1]) : null;
      // ⚠ This fetch does NOT stay in flight. `/health` is a synchronous JSON
      // route (src/server.ts), so it answers immediately and the 200 ms wait
      // below guarantees the response has ALREADY arrived before we signal.
      // Do NOT restore the claim this comment once carried, that the fetch is
      // "long-running" and "won't actually complete" — both halves are false.
      // Whether a keep-alive socket lingers at kill time is NOT asserted here
      // and has not been verified; what IS established is that deleting the
      // fetch entirely would not change this test's result. Genuine mid-stream
      // drain coverage is the deferred follow-up (D79), NOT something to bolt
      // on here.
      const inflight =
        port !== null
          ? fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(40000),
            }).catch(() => undefined)
          : Promise.resolve();

      await new Promise((r) => setTimeout(r, 200));
      proc.kill("SIGTERM");
      const exitCode = await exited;
      expect(exitCode).toBe(0);
      // Best-effort: drain the inflight promise.
      await inflight;
    }, 45000);

    it("Test 3 — second SIGTERM is harmless — exit stays 0 (force-exit branch NOT covered)", async () => {
      const { proc, stdoutBuf } = await spawnV2();
      // Register BEFORE the first await after spawnV2() — file-level
      // invariant. No `toContain("listening")` assert guards this test, so
      // early registration is the only thing preventing a boot-time child
      // death from hanging it to its 10000 ms budget.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      await waitForListening(stdoutBuf, 5000);
      // ⚠ COVERAGE NOTICE — twin of the same-named case in sigterm.test.ts,
      // fixed together per D79. With no in-flight load the FIRST signal's
      // graceful path finishes long before the 1000 ms gap elapses, so the
      // second kill lands on a dead child and the force branch
      // (src/main.ts:508-518) never runs. The name carries that so `bun test`
      // output alone states it.
      //
      // NOTE: unlike the sigterm.test.ts twin, `spawnV2` above pipes BOTH
      // stdout and stderr into stdoutBuf, so the stderr trap does not apply
      // here — a future `toContain("force-closing")` assertion WOULD see the
      // consola.warn. It would also fail today, correctly, because the branch
      // does not run. Real coverage needs an in-flight request pinning
      // `handle.close({graceMs:30_000})` open across the second signal.
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      proc.kill("SIGTERM");
      const exitCode = await exited;
      expect(exitCode).toBe(0);
    }, 10000);

    it("Test 4 — SIGINT parity with bare drain (clean exit within 30s)", async () => {
      const { proc, stdoutBuf } = await spawnV2();
      // Register BEFORE the first await after spawnV2() — file-level
      // invariant. Like Test 3 this case has no `toContain("listening")`
      // assert, so a boot-time death would otherwise hang it to 35000 ms.
      const exited = new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? -1));
      });
      await waitForListening(stdoutBuf, 5000);
      proc.kill("SIGINT");
      const exitCode = await exited;
      expect(exitCode).toBe(0);
    }, 35000);
  },
);

// Sanity placeholder so the file's case-count > 0 even when the slow suite
// is skipped (matches the pattern in tests/integration/sigterm.test.ts).
describe("sigterm_drain — slow-suite gating notice", () => {
  it.skipIf(SLOW_ENABLED)(
    "default-skipped behind SLOW_TESTS=1 (and skipped on Windows; see tests/integration/sigterm.windows-fallback.test.ts for the platform-equivalent gate)",
    () => {
      expect(SLOW_ENABLED).toBe(false);
    },
  );
});
