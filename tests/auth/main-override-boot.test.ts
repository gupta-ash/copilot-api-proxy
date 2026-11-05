/**
 * main-override-boot.test.ts — the BOOT behaviour of the upstream override.
 *
 * WHY THIS FILE EXISTS, and it is a direct answer to a cross-family finding.
 * `main.ts` handles the override in two ADJACENT `if` statements, and an earlier
 * comment claimed that made omitting the announcement "structurally impossible".
 * That was false: deleting the `ok` arm leaves `OVERRIDE` still referenced by the
 * `error` arm, so `noUnusedLocals` does not fire, `tsc` is happy, and the proxy
 * silently talks to an operator-supplied host while printing nothing. Nothing in
 * the suite noticed, because no test executed `main()` at all.
 *
 * So the guarantee is TEST-DETECTED rather than compiler-enforced, and this file
 * is the detector. Each arm gets a child process; delete either arm and the
 * matching case fails. Proven by mutation, not asserted.
 *
 * ── HOW THE CHILDREN ARE STOPPED, WHICH IS THE PART TWO GATE ROUNDS REWROTE ──
 *
 * v1 waited for exit. `--list-models` does not return quickly, so two cases blew
 * bun's per-test budget and left dangling processes.
 *
 * v2 slept a fixed 4 s and killed. Round 3 refuted it: a fixed window is a timing
 * assumption, and the NEGATIVE case — asserting the banner is ABSENT — passes
 * vacuously on any child slow enough not to have printed yet.
 *
 * v3 waited for a post-gate marker and then killed. Round 4 refuted
 * THAT too, and the refutation is worth stating because it is subtle: observing a
 * marker and then calling `kill()` is still a RACE. The parent only acts after
 * the pipe delivers the bytes and the scheduler runs it, and in that window the
 * child keeps going — past `loadConfig`, through `ensurePaths`, into
 * `TokenManager.start()`. So the isolation the comment claimed was never
 * guaranteed, only likely.
 *
 * v4 does not stop the children at all: IT MAKES THEM STOP THEMSELVES.
 * `COPILOT_PROXY_PORT` points at a port this file is itself listening on, so
 * `ensurePortFree` refuses and the child exits 1 on its own. Measured ordering in
 * `main()`: `ensurePortFree` runs BEFORE `ensurePaths`, which runs BEFORE
 * `new TokenManager` — so termination is structurally prior to any token work,
 * rather than prior-if-the-scheduler-cooperates. Every case is a `spawnSync` run
 * to natural exit: no kill, no sleep, no stream pumping, no race to lose.
 * Measured cost: ~0.5 s per child.
 *
 * ⚠ MARKERS MUST BE AT `warn` OR `error` LEVEL IN THIS FILE. Measured: a child
 * spawned by `Bun.spawn` with piped stdio — which is every child here — reports
 * `consola.level = 1` and `isTTY = false`, and its `consola.info` produces ZERO
 * bytes on either stream. So an info-level marker here is not unreliable, it is
 * invisible, and both markers below are error level for that reason.
 *
 * ⚠ DO NOT GENERALISE THAT INTO "consola suppresses info off a TTY". An earlier
 * version of this paragraph asserted exactly that causal rule and it is FALSE:
 * the `:4144` gate harness redirects the proxy's output to files under `node`,
 * also not a TTY, and those files DO contain info-level lines. The two contexts
 * differ in runtime and in stdio setup, and only the Bun-spawn one suppresses.
 * What is measured is the Bun-spawn behaviour; the mechanism is not established.
 *
 * HOME is sandboxed per child (F168) so APP_DIR moves with it and no child can
 * touch the operator's real meta.json, models.json, traces or crash marker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const REPO = path.resolve(import.meta.dir, "..", "..");
const ENTRY = path.join(REPO, "src", "main.ts");

// Written as a LITERAL, never imported from the source. Importing the constant
// would make a typo in the source agree with the test perfectly — the failure
// mode where every test is green and the operator's documented variable does
// nothing.
const ENV_KEY = "COPILOT_PROXY_UPSTREAM_BASE_URL";

/**
 * `loadConfig`'s first observable act. `childEnv` points `COPILOT_PROXY_CONFIG`
 * at a present-but-unparseable file, so the loader throws, logs this at ERROR
 * level and falls back to defaults.
 *
 * Used as an ABSENCE probe on the `--list-models` refusal case: `loadConfig` is
 * the first statement of `runListModels`, so if this string is missing, that
 * branch was never entered — which is the round-1 defect, stated as an
 * observation rather than as an argument about what "announces itself" means.
 */
const MARK_CONFIG = "config: failed to load";

/**
 * `ensurePortFree`'s refusal — the deterministic exit this file is built on, and
 * the anchor proving a child got PAST the override block. It is emitted strictly
 * after the override block and strictly before `ensurePaths` / `new TokenManager`.
 */
const MARK_PORT = "is already in use";

const sandboxes: string[] = [];
let squatter: ReturnType<typeof Bun.serve> | undefined;
let busyPort = "";

beforeAll(() => {
  // Occupy a kernel-assigned port. Port 0 means the OS picks a free one, so this
  // cannot collide with the live proxy on :4143, with a parallel test run, or
  // with anything else on the box.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("squatter"),
  });
  squatter = server;
  const assigned = server.port;
  if (assigned === undefined) {
    // Fail loudly rather than proceeding: with no port to squat on, every child
    // would boot normally instead of exiting, and the absence assertions below
    // would start passing for the wrong reason.
    throw new Error("Bun.serve did not report a bound port");
  }
  busyPort = String(assigned);
});

afterAll(() => {
  // `void`: Bun types `stop()` as returning a promise, and this is teardown —
  // there is nothing useful to do with it and nothing may reject the suite here.
  void squatter?.stop(true);
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort; a leaked temp dir must not fail the suite */
    }
  }
});

interface BootResult {
  exitCode: number | null;
  output: string;
}

function childEnv(value: string | undefined): Record<string, string> {
  const home = mkdtempSync(path.join(tmpdir(), "cp-override-"));
  sandboxes.push(home);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Move APP_DIR with HOME (F168) — one assignment isolates meta.json,
  // models.json, the incident log, the stall log, traces and the crash marker.
  env["HOME"] = home;
  env["USERPROFILE"] = home;
  // Present but unparseable, so `loadConfig` emits MARK_CONFIG at error level.
  const badConfig = path.join(home, "bad-config.yaml");
  writeFileSync(badConfig, "routes: [\n", "utf8"); // unterminated flow sequence
  env["COPILOT_PROXY_CONFIG"] = badConfig;
  // The self-termination mechanism. Explicitly DELETED rather than merely unset:
  // an inherited COPILOT_PROXY_ALLOW_PORT_IN_USE=1 would skip `ensurePortFree`,
  // and the children would then run on into TokenManager instead of exiting —
  // silently turning every case below into the v3 design this one replaced.
  env["COPILOT_PROXY_PORT"] = busyPort;
  env["COPILOT_PROXY_HOST"] = "127.0.0.1";
  delete env["COPILOT_PROXY_ALLOW_PORT_IN_USE"];
  if (value === undefined) delete env[ENV_KEY];
  else env[ENV_KEY] = value;
  return env;
}

/**
 * Run a child to its NATURAL exit and return everything it said.
 *
 * `args` selects the path through `main()`: `["--list-models"]` takes the branch
 * the round-1 defect was about; `[]` takes the ordinary boot path, which is the
 * one that reaches `ensurePortFree` and therefore stops on its own.
 */
function boot(value: string | undefined, args: string[] = []): BootResult {
  const r = Bun.spawnSync({
    cmd: ["bun", ENTRY, ...args],
    cwd: REPO,
    env: childEnv(value),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return {
    exitCode: r.exitCode,
    output: r.stdout.toString() + r.stderr.toString(),
  };
}

describe("boot — a malformed override is REFUSED", () => {
  it("exits 1 and names the variable, before --list-models can reach the upstream", () => {
    const r = boot("not a url", ["--list-models"]);
    // EXACTLY 1, not merely non-zero. `main.ts` refuses by setting
    // `process.exitCode = 1` and RETURNING — it no longer calls `process.exit(1)`,
    // so the code is delivered by normal shutdown. A crash, a signal or a timeout
    // are all non-zero too, and treating them as a pass would let this test go
    // green on the failure it exists to catch.
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(ENV_KEY);
    expect(r.output.toLowerCase()).toContain("refusing to start");
  }, 25_000);

  it("refuses BEFORE the --list-models branch is entered at all", () => {
    const r = boot("not a url", ["--list-models"]);
    expect(r.exitCode).toBe(1);
    // `loadConfig` is the FIRST statement of `runListModels`, so the absence of
    // its marker is direct evidence the branch was never entered.
    //
    // ⚠ This replaces an assertion on the absence of the string "--list-models:",
    // which round 4 showed was unsound: that text appears only on
    // `runListModels`' ERROR paths, so a child could load config, ensure paths,
    // start a TokenManager and even fetch a catalog while never emitting it. The
    // old guard could not distinguish "branch skipped" from "branch ran fine".
    expect(r.output).not.toContain(MARK_CONFIG);
  }, 25_000);

  it("refuses before ANY config load or port check on the ordinary boot path", () => {
    const r = boot("not a url");
    expect(r.exitCode).toBe(1);
    // Neither marker appears, and between them they cover everything `main()`
    // does after the gate: the refusal is structurally first.
    expect(r.output).not.toContain(MARK_CONFIG);
    expect(r.output).not.toContain(MARK_PORT);
  }, 25_000);

  it("does not put the rejected value's credentials in the boot log", () => {
    const r = boot("http://user:hunter2@127.0.0.1:4144", ["--list-models"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(ENV_KEY);
    expect(r.output).toContain("credentials");
    // The whole point of `safeValue`: the operator's password must not reach a
    // log file that this platform preserves and rotates (D65).
    expect(r.output).not.toContain("hunter2");
  }, 25_000);
});

describe("boot — a live override is ANNOUNCED", () => {
  /**
   * This is the case the cross-family gate found unguarded. Delete the `ok` arm
   * from `main.ts` and typecheck still passes, the whole rest of the suite still
   * passes, and only this test goes red. Proven: the mutation that deletes it
   * fails here on the ANNOUNCEMENT assertion while the anchor below stays green,
   * so the anchor is independent of the thing it anchors.
   */
  it("warns loudly that traffic is NOT going to Copilot", () => {
    // A port nothing listens on for the OVERRIDE value: the announcement is
    // printed before any request is ever attempted.
    const r = boot("http://127.0.0.1:9");
    // The anchor first. Without it the assertions below could pass or fail for
    // reasons that have nothing to do with the announcement arm.
    expect(r.output).toContain(MARK_PORT);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("UPSTREAM OVERRIDE ACTIVE");
    expect(r.output).toContain("http://127.0.0.1:9");
    expect(r.output).toContain(ENV_KEY);
  }, 25_000);

  it("says nothing when the variable is unset — the insertion-only claim", () => {
    const r = boot(undefined);
    // THE LOAD-BEARING ASSERTION OF THIS CASE. Two `not.toContain`s are satisfied
    // by a child that never got as far as printing anything, so on their own they
    // are satisfied by the absence of the program rather than by the absence of
    // the banner. This pins that execution provably ran PAST the point where the
    // banner would have been emitted.
    expect(r.output).toContain(MARK_PORT);
    expect(r.exitCode).toBe(1);
    expect(r.output).not.toContain("UPSTREAM OVERRIDE ACTIVE");
    expect(r.output).not.toContain("Refusing to start");
  }, 25_000);
});
