// Adapted from xianml/copilot-api-pro@f212832 src/lib/paths.ts
// Modifications:
//   - APP_DIR changed to ~/.local/share/copilot-proxy (sibling to upstream's copilot-api).
//   - Same export shape (PATHS, ensurePaths) so future cribbing aligns.
//   - No env-var override (speculative complexity per CLAUDE.md anti-patterns; add if a real need surfaces).

/**
 * paths.ts — XDG-style on-disk paths for copilot-proxy.
 *
 * The proxy persists very little to disk:
 *   - `GITHUB_TOKEN_PATH` — long-lived GitHub OAuth token (mode 0o600).
 *   - `CLAUDE_CODE_CONFIG_PATH` — Claude Code harness config (read-only, optional).
 *   - `CODEX_CONFIG_PATH` — Codex harness config (touched empty so harness can write).
 *   - `PID_PATH` — server PID file for clean shutdown / external introspection.
 *
 * Notably absent: the Copilot token. It is in-memory only (60-min TTL,
 * fetched on-demand by `TokenManager`).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_DIR = path.join(os.homedir(), ".local", "share", "copilot-proxy");

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token");
const CLAUDE_CODE_CONFIG_PATH = path.join(APP_DIR, "claude-code.json");
const CODEX_CONFIG_PATH = path.join(APP_DIR, "codex.json");
const PID_PATH = path.join(APP_DIR, "server.pid");
// Structured crash marker (uncaughtException / unhandledRejection); best-effort,
// written synchronously by lib/crash.ts. Sibling of the meta.json/models.json sidecars.
const CRASH_PATH = path.join(APP_DIR, "logs", "copilot-proxy.crash.json");
// Content-phase stall detector log (feature W2); append-only JSONL, best-effort,
// written synchronously by routes/_shared/stall-detect.ts. Sibling of CRASH_PATH.
const STALL_LOG_PATH = path.join(APP_DIR, "logs", "copilot-proxy.stalls.log");
// Always-on stream-incident log; append-only JSONL, best-effort, written
// synchronously by lib/incident-log.ts. Sibling of CRASH_PATH/STALL_LOG_PATH.
// Deliberately NOT under `traces/`: traces are gated on `logging.level >= raw`
// and the operator deletes them regularly, whereas an incident record must
// survive at the level the fleet actually runs (F138).
const INCIDENT_LOG_PATH = path.join(
  APP_DIR,
  "logs",
  "copilot-proxy.incidents.log",
);

/**
 * Phase 5 v3.1 Group B — default trace-output directory used by the bootstrap
 * (main.ts) when `config.logging.trace_dir` is unset AND `config.logging.level`
 * is `raw` or higher. Sibling of APP_DIR's other on-disk artefacts; per-day
 * rotation buckets land underneath via `TraceWriter`.
 */
export const TRACES_DIR_DEFAULT = path.join(APP_DIR, "traces");

/**
 * Expand a leading `~` / `~/` / `~\` in a path to the user's home dir.
 * Non-tilde paths pass through unchanged. Shared by main.ts (trace_dir) and
 * stall-detect.ts (stall log_path) so both honor the same convention.
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CLAUDE_CODE_CONFIG_PATH,
  CODEX_CONFIG_PATH,
  PID_PATH,
  CRASH_PATH,
  STALL_LOG_PATH,
  INCIDENT_LOG_PATH,
  TRACES_DIR_DEFAULT,
} as const;

/**
 * Ensure `APP_DIR` exists and the canonical persistent files (`github_token`,
 * `codex.json`) are touched with `0o600` perms if missing.
 *
 * Idempotent — safe to call on every server start.
 */
export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true });
  await ensureFile(PATHS.GITHUB_TOKEN_PATH);
  await ensureFile(PATHS.CODEX_CONFIG_PATH);
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK);
  } catch {
    await fs.writeFile(filePath, "");
    await fs.chmod(filePath, 0o600);
  }
}
