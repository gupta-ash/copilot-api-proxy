/**
 * proxy_sandbox.ts — HOME-sandboxing for tests that spawn `bun run src/main.ts`.
 *
 * ## Why this exists
 *
 * A spawned proxy resolves its data directory from `os.homedir()`:
 * `src/lib/paths.ts:25` sets `APP_DIR = path.join(os.homedir(), ".local",
 * "share", "copilot-proxy")`, and that file's header states plainly
 * "No env-var override". A spawn that inherits the operator's real environment
 * therefore reads `~/.local/share/copilot-proxy/config.yaml` and `github_token`
 * — and, via `writeMeta` (`src/main.ts:498`, an unconditional full overwrite),
 * CLOBBERS `copilot-proxy.meta.json` in that directory.
 *
 * On a fleet box that file belongs to the LIVE `:4143` gateway, with real
 * harness sessions connected to it. That is a production outage caused by a
 * test run.
 *
 * ## XDG_DATA_HOME is NOT a lever — do not reach for it
 *
 * `paths.ts` honours no environment override of any kind; `XDG_DATA_HOME`
 * appears nowhere in `src/`. A sandbox written against it is a SILENT NO-OP
 * that leaves the hazard fully armed while looking fixed. The only working
 * knobs are `USERPROFILE` + `HOME` on win32 and `HOME` on POSIX.
 *
 * ## Why the config path points at a file that is never created
 *
 * `COPILOT_PROXY_CONFIG` is set to a path INSIDE the sandbox and deliberately
 * left non-existent. Two reasons:
 *   1. Setting it explicitly stops an inherited `COPILOT_PROXY_CONFIG` from
 *      surviving the `...process.env` spread and pulling the operator's real
 *      config back in — the sandboxed HOME alone would not prevent that.
 *   2. Landing on a missing file is DOCUMENTED, not accidental:
 *      `src/main.ts:79-85` — "Per D-LOCK-2 H1: missing file → defaults; never
 *      throw on missing config." The child boots on zod defaults (no routes,
 *      passthrough only), which is all a signal/bootstrap test needs.
 *
 * Mirrors the shape of `spawnProxy` / `sandboxHome` in
 * `tests/integration/trace_wiring.test.ts`. The two are independent copies and
 * MUST agree on two things, or one of them silently regresses:
 *   1. `CONSOLA_LEVEL=3` (see the note on that key below) — without it the
 *      spawned child emits no listening banner under `bun test`, and every
 *      caller that parses a port out of that banner times out.
 *   2. a pre-seeded `github_token` under the sandbox APP_DIR — without it the
 *      child starts the device-code flow and polls GitHub over the network.
 * Neither is enforced by anything but this note. Change one copy, change both.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ProxySandbox {
  /** Temp dir standing in for the operator's home. */
  dir: string;
  /** Env to hand to `spawn` — already includes `...process.env`. */
  env: Record<string, string>;
  /** Remove the sandbox. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Create a throwaway home directory and the env that redirects a spawned proxy
 * into it.
 *
 * @param prefix mkdtemp prefix, e.g. `"sigterm-"` — shows up in the temp path.
 * @param extraEnv per-test overrides, merged after the defaults. NOT applied
 *   last: `HOME` (and `USERPROFILE` on win32) are assigned after this spread,
 *   below, and overwrite anything `extraEnv` sets for those two keys.
 */
export async function makeProxySandbox(
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<ProxySandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));

  // Pre-seed a dummy GitHub token. Without one the child logs "No GitHub token
  // on disk; starting device-code flow." and begins UNBOUNDED polling of
  // GitHub — outbound traffic from a unit test, on every spawn, and a flake
  // source on CI.
  //
  // This BOUNDS that traffic; it does not remove it. A present-but-invalid
  // token skips the device flow but still reaches `TokenManager.start()` →
  // `refresh()` → `getCopilotToken`, which retries 3× (default per O11) before
  // going terminal `failed`. Three bounded requests instead of unbounded
  // polling. Do not describe these tests as network-isolated.
  const appDir = path.join(dir, ".local", "share", "copilot-proxy");
  await mkdir(appDir, { recursive: true });
  await writeFile(
    path.join(appDir, "github_token"),
    "ghu_sandbox_dummy_not_a_real_token",
    { mode: 0o600 },
  );

  const env: Record<string, string> = {
    ...process.env,
    // Explicit override — see the header note on inherited values.
    COPILOT_PROXY_CONFIG: path.join(dir, "config.yaml"),
    COPILOT_PROXY_PORT: "0",
    COPILOT_PROXY_ALLOW_PORT_IN_USE: "1",
    // `bun test` injects NODE_ENV=test, which makes consola clamp its level to
    // warn(1) at import time — dropping every `consola.info`, INCLUDING the
    // "listening on http://..." banner these tests parse the port from. consola
    // reads CONSOLA_LEVEL *after* `_getDefaultLogLevel()`, so this beats the
    // clamp. That is why the log-level fix needs no `src/` change at all.
    CONSOLA_LEVEL: "3",
    ...extraEnv,
  } as Record<string, string>;

  if (process.platform === "win32") {
    // Bun on Windows reads USERPROFILE for os.homedir(); HOME alone is not
    // enough. Both are set so the same sandbox holds on either platform.
    env["USERPROFILE"] = dir;
    env["HOME"] = dir;
  } else {
    env["HOME"] = dir;
  }

  return {
    dir,
    env,
    cleanup: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
