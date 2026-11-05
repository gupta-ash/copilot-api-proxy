/**
 * tests/e2e/_harness.ts — proxy spawn + tear-down helper for the
 * end-to-end regression suite.
 *
 * Cribbed from `tests/integration/sigterm_drain.test.ts` (`spawnV2()` +
 * `waitForListening()` pattern) with three modifications:
 *
 *   (a) The opt-in gate is `RUN_E2E=1` (NOT `SLOW_TESTS=1`). The e2e
 *       suite costs real Copilot Enterprise quota and hits real upstream
 *       (`api.enterprise.githubcopilot.com`); CI MUST NOT run these by
 *       default. See `tests/e2e/README.md` for the operator playbook.
 *
 *   (b) The harness pre-allocates a TCP port (binds + closes a temp
 *       Node `net.createServer` on `port: 0`, reads back the OS-chosen
 *       port, and passes it to the spawned proxy via
 *       `COPILOT_PROXY_PORT=<n>`). This bypasses a Bun-on-Windows
 *       quirk where the spawned proxy's `consola.info(...)` "listening"
 *       log line does NOT flush to the parent's piped stdout (consola's
 *       reporter buffers when the process is bun-spawning-bun under
 *       `bun test`, observed empirically — `process.stdout.write` from
 *       the spawned process flushes fine; `consola.info` does not).
 *       Pre-allocating the port avoids needing to parse the listening
 *       log to discover the port.
 *
 *   (c) `startProxy()` polls `/health` until `auth_status === "ready"`
 *       (NOT just "listening"). Per `src/main.ts`'s two-stage bootstrap:
 *       Stage 1 (~1s) binds the server and `/health` returns
 *       `{auth_status:"starting"}`; Stage 2 (~3-5s) starts TokenManager
 *       which transitions `auth_status` to `"ready"`. Real-upstream
 *       tests MUST wait for stage 2 — issuing a /v1/messages request
 *       during stage 1 returns 503 `auth_pending`.
 *
 * The harness MUST NOT touch operator runtime files
 * (`~/.local/share/copilot-proxy/{github_token,config.yaml}`). The
 * spawned proxy inherits the operator's existing token; tests run
 * against the same auth context as a manual `bun run start`.
 *
 * The harness pins COPILOT_PROXY_CONFIG to this checkout's default config,
 * avoiding interference from deployed operator routing. Trace-enabled callers
 * receive a temporary copy with only the logging block overridden.
 *
 * Cross-platform note: Bun on Windows handles SIGTERM as a clean
 * termination signal (per `sigterm_drain.test.ts` doc-comment). HTTP
 * tests need no special-casing for Windows.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";

import type { Subprocess } from "bun";

export const RUN_E2E: boolean = process.env["RUN_E2E"] === "1";

/**
 * Absolute path to the repo's `config/default.yaml`. Resolved from the
 * harness file's location: `tests/e2e/_harness.ts` → repo root is
 * `../../`. Pinned through COPILOT_PROXY_CONFIG in spawned processes.
 */
const REPO_DEFAULT_CONFIG: string = resolvePath(
  import.meta.dir,
  "../../config/default.yaml",
);

export interface ProxyHandle {
  /** Resolved bind URL e.g. `http://127.0.0.1:54321`. NO trailing slash. */
  readonly url: string;
  /** Resolved bind port (the pre-allocated port we passed to the proxy). */
  readonly port: number;
  /** The spawned `bun run src/main.ts` child process (Bun.spawn handle). */
  readonly proc: Subprocess;
  /**
   * Mutable buffer for combined stdout+stderr. Best-effort — see the
   * file-header note about consola buffering on Bun-on-Windows; the
   * "listening" log line may NOT appear here even after the proxy IS
   * listening. Use `/health` polling for readiness, not stdout grep.
   */
  readonly stdoutBuf: { value: string };
}

export interface StartProxyOptions {
  /**
   * Wait for `auth_status === "ready"` (default `true`). Pass `false` to
   * wait only for the `/health` endpoint to return ANY response (stage 1
   * — useful for tests that exercise 503-during-bootstrap behavior).
   */
  waitForAuth?: boolean;
  /**
   * Max ms to wait for the requested ready state (default 30_000). Stage
   * 1 (`/health` returns 200) usually arrives in ~1s; stage 2
   * (`auth_status:"ready"`) usually arrives in ~3-5s on a warm machine.
   * 30s gives generous headroom for slow CI / first-token-fetch.
   */
  timeoutMs?: number;
  /**
   * Group D (F-DISC-10): when set, spawn the proxy with a temporary
   * config that overrides `logging.level: raw` + `logging.trace_dir:
   * <traceDir>`. Used by Lane 1's trace-mode assertion under the SINGLE
   * `RUN_E2E=1` gate. The harness clones the repo's `config/default.yaml`
   * (so all 6 lanes stay wired) and only rewrites the `logging:` block.
   * Caller is responsible for `mkdtemp`-ing + cleaning up `traceDir`.
   */
  traceDir?: string;
}

/**
 * Pre-allocate a TCP port by binding + closing a temporary
 * `net.createServer` on `port: 0`. The OS-assigned port is unlikely to
 * be reused immediately by another listener (TIME_WAIT window aside),
 * so this is safe for tests that bind shortly after.
 */
async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("pickFreePort: no address bound"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

interface SpawnedProxy {
  proc: Subprocess;
  stdoutBuf: { value: string };
}

/**
 * Build a temporary config file that clones the repo's `config/default.yaml`
 * and overrides the `logging:` block with `level: raw` + `trace_dir:
 * <traceDir>`. Returns the absolute path to the temp config. Caller must
 * not delete this file before the spawned proxy exits — the proxy's config
 * watcher reads it lazily.
 */
async function buildTraceOverrideConfig(traceDir: string): Promise<string> {
  const baseYaml = await readFile(REPO_DEFAULT_CONFIG, "utf-8");
  // Strip the existing `logging:` block (3 lines: header + level + trace_dir).
  // The default's structure (lines 74-76) is:
  //   logging:
  //     level: on # off | on | raw | verbose
  //     trace_dir: ~/.local/share/copilot-proxy/traces
  // We rewrite via regex (anchored multiline) — robust against minor
  // whitespace drift but assumes the canonical 3-line shape.
  const stripped = baseYaml.replace(/^logging:\r?\n(?:[ \t]+.*\r?\n?)+/m, "");
  // YAML scalar quoting: trace_dir is a string. Backslashes in Windows
  // paths must be escaped under double-quote style; single-quote style
  // treats backslashes literally. Use single quotes + escape any embedded
  // single quotes by doubling them per YAML 1.2 §7.3.2.
  const quotedTraceDir = `'${traceDir.replace(/'/g, "''")}'`;
  const overrideBlock = `logging:\n  level: raw\n  trace_dir: ${quotedTraceDir}\n`;
  const overrideDir = await mkdtemp(joinPath(tmpdir(), "copilot-proxy-e2e-"));
  const overridePath = joinPath(overrideDir, "config.yaml");
  await writeFile(overridePath, overrideBlock + stripped, "utf-8");
  return overridePath;
}

async function spawnV2(
  port: number,
  configPath: string = REPO_DEFAULT_CONFIG,
): Promise<SpawnedProxy> {
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    env: {
      ...process.env,
      COPILOT_PROXY_PORT: String(port),
      COPILOT_PROXY_HOST: "127.0.0.1",
      COPILOT_PROXY_ALLOW_PORT_IN_USE: "1",
      // Exercise repository routing; trace callers use a temporary logging
      // override of the same default configuration.
      COPILOT_PROXY_CONFIG: configPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutBuf = { value: "" };
  // Best-effort stdout/stderr drain. See file-header note: consola may
  // not flush to this buffer even after the proxy is fully running.
  // The buffer is still useful for surfacing crash output on timeout.
  const decoder = new TextDecoder();
  if (proc.stdout !== null && typeof proc.stdout !== "number") {
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) stdoutBuf.value += decoder.decode(value);
        }
      } catch {
        /* reader closed */
      }
    })();
  }
  if (proc.stderr !== null && typeof proc.stderr !== "number") {
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) stdoutBuf.value += decoder.decode(value);
        }
      } catch {
        /* reader closed */
      }
    })();
  }
  return { proc, stdoutBuf };
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  buf: { value: string },
  requireAuthReady: boolean,
): Promise<void> {
  const start = Date.now();
  let lastStatus = "unknown";
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { auth_status?: string };
        lastStatus = body.auth_status ?? "missing";
        if (!requireAuthReady) return;
        if (lastStatus === "ready") return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const lastErrMsg =
    lastError !== null
      ? lastError instanceof Error
        ? lastError.message
        : String(lastError)
      : "(none)";
  throw new Error(
    `startProxy: ${requireAuthReady ? 'auth_status did not reach "ready"' : "/health did not respond"} ` +
      `within ${timeoutMs}ms (last status: "${lastStatus}", last error: ${lastErrMsg}).\n` +
      `--- captured output ---\n${buf.value}\n--- end output ---`,
  );
}

/**
 * Spawn `bun run src/main.ts` from the repo root with a pre-allocated
 * port, wait for it to reach the requested ready state (auth_status ===
 * "ready" by default), and return a handle. The caller MUST eventually
 * invoke `stopProxy(handle)` to free the child process — typically via
 * `afterAll(() => stopProxy(handle))`.
 */
export async function startProxy(
  opts: StartProxyOptions = {},
): Promise<ProxyHandle> {
  const waitForAuth = opts.waitForAuth ?? true;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const port = await pickFreePort();
  const url = `http://127.0.0.1:${port}`;
  const configPath =
    opts.traceDir !== undefined
      ? await buildTraceOverrideConfig(opts.traceDir)
      : REPO_DEFAULT_CONFIG;
  const { proc, stdoutBuf } = await spawnV2(port, configPath);

  try {
    await waitForHealth(url, timeoutMs, stdoutBuf, waitForAuth);
  } catch (err) {
    // Best-effort cleanup before re-throwing.
    try {
      proc.kill();
    } catch {
      /* ignored */
    }
    throw err;
  }

  return { url, port, proc, stdoutBuf };
}

/**
 * Tear down a proxy spawned by `startProxy()`. Sends SIGTERM, waits up
 * to 10s for clean exit, then sends SIGKILL if the process is still
 * alive. Idempotent — safe to call multiple times.
 */
export async function stopProxy(handle: ProxyHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* may already be dead */
  }
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 10_000);
    }),
  ]);
  if (!exited && proc.exitCode === null) {
    try {
      // Force kill on stragglers. On Windows Bun translates SIGKILL to
      // a hard termination via TerminateProcess.
      proc.kill("SIGKILL");
    } catch {
      /* may already be dead */
    }
    await Promise.race([
      proc.exited.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(() => resolve(), 5_000)),
    ]);
  }
}
