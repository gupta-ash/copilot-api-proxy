// Adapted with refactor (no global state) from xianml/copilot-api-pro@f212832 src/lib/api-config.ts
// Modifications:
//   - Header factories take their inputs as explicit args (no `state` singleton — D17 P3).
//   - `copilotBaseUrl(accountType)` takes the account type explicitly.
//   - Added `AccountType` type alias.
//   - `accountType` removed from `copilotHeaders()` opts (it only matters at URL-building, not header).
//   - Same constants exported (GITHUB_*, COPILOT_VERSION, EDITOR_PLUGIN_VERSION, USER_AGENT, API_VERSION).

/**
 * api-config.ts — header factories, base URLs, and Copilot-Ent constants.
 *
 * The auth layer (`TokenManager`, `getCopilotToken`, etc.) calls these
 * factories with whatever token + version it has in hand; nothing is read
 * from a global. This keeps the call graph explicit and makes the helpers
 * trivially testable (no module-level mocking required).
 *
 * The constants below are intentionally pinned to a known-good vsCode +
 * Copilot Chat extension version pair. The `vsCodeVersion` field comes from
 * config (loaded by M1a's `config.ts`) but always passes through these
 * helpers as an explicit arg.
 */

import { randomUUID } from "node:crypto";

import {
  UPSTREAM_OVERRIDE_ENV,
  parseUpstreamOverride,
  type UpstreamOverride,
} from "~/auth/upstream-override.ts";

/**
 * The upstream override, captured ONCE at module load.
 *
 * Module scope is deliberate and is the property the tests pin: the value is
 * read when this module is first imported, so setting the variable later — from
 * inside a test body, or from an admin endpoint — is INERT. A subprocess with
 * the variable exported before start is the only thing that can change it, which
 * is why `api-config-override.test.ts` drives its positive cases through spawned
 * children rather than by mutating `process.env` in-process.
 *
 * `main.ts` reads this to refuse the boot on `error` and to announce on `ok`.
 *
 * The `error` variant's diagnostic field is `safeValue`, NOT `raw`. It was called
 * `raw` until the cross-family gate found the boot log printing the operator's
 * value verbatim; it is now redacted in the PARSER and renamed, because a field
 * called `raw` that is quietly sanitised lies to the next reader. It exists for
 * the boot log ONLY and must never be composed into a URL — `copilotBaseUrl`
 * below reads `.baseUrl` and nothing anywhere reads `.safeValue` except that one
 * `consola.error`. See the module docblock in `upstream-override.ts`.
 */
export const OVERRIDE: UpstreamOverride = parseUpstreamOverride(
  process.env[UPSTREAM_OVERRIDE_ENV],
);

export type AccountType = "individual" | "business" | "enterprise";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_BASE_URL = "https://github.com";
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_APP_SCOPES = ["read:user"].join(" ");

export const COPILOT_VERSION = "0.26.7";
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
export const API_VERSION = "2025-04-01";

export function standardHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
  };
}

/**
 * Per-account-type Copilot upstream base URL.
 *
 *   individual  → https://api.githubcopilot.com
 *   business    → https://api.business.githubcopilot.com
 *   enterprise  → https://api.enterprise.githubcopilot.com
 *
 * When `COPILOT_PROXY_UPSTREAM_BASE_URL` holds a valid origin, that origin is
 * returned for EVERY account type — the override is a whole-upstream repoint,
 * not a per-tier substitution. This is the single choke point: all five live
 * call sites compose their URL as `${copilotBaseUrl(...)}${upstreamPath}`, so
 * they inherit the override for free and the 401-retry path inherits it too.
 *
 * A SIXTH composer exists and is named here rather than silently omitted, because
 * a reviewer counting occurrences will find it and reasonably ask:
 * `resolveUpstreamUrl` in `types/config-schema.ts` composes the same way, but has
 * ZERO callers anywhere in `src/` (measured — the only other mentions of it are
 * comments in `lib/apply-initiator-headers.ts`). It is dead, it would inherit the
 * override correctly if it were ever revived, and it is excluded from "five live
 * call sites" for that reason and no other.
 *
 * INSERTION-ONLY: with the variable unset, `OVERRIDE.kind` is `"unset"`, the
 * guard falls through, and this function is byte-for-byte the behaviour it had
 * before the override existed.
 */
export function copilotBaseUrl(accountType: AccountType): string {
  if (OVERRIDE.kind === "ok") return OVERRIDE.baseUrl;
  return accountType === "individual"
    ? "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`;
}

export interface CopilotHeadersOpts {
  /** The Copilot-Ent token (NOT the GitHub OAuth token). */
  token: string;
  /** vsCode version string the extension reports — pass-through to `editor-version`. */
  vsCodeVersion: string;
  /** Set to true to request vision-capable serving from upstream. */
  vision?: boolean;
}

/**
 * Build the headers for a Copilot upstream request. Exact shape matches
 * what the Copilot Chat extension itself sends (cargo-culted from the
 * upstream skeleton; deviations break Copilot-Ent acceptance).
 */
export function copilotHeaders(
  opts: CopilotHeadersOpts,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "content-type": standardHeaders()["content-type"] as string,
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${opts.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  };

  if (opts.vision) headers["copilot-vision-request"] = "true";

  return headers;
}

export interface GithubHeadersOpts {
  /** The GitHub OAuth token (NOT the Copilot token). */
  token: string;
  /** vsCode version string — pass-through to `editor-version`. */
  vsCodeVersion: string;
}

/**
 * Build the headers for a `api.github.com` request — used to fetch the
 * Copilot token and (later) introspect the user.
 */
export function githubHeaders(opts: GithubHeadersOpts): Record<string, string> {
  return {
    ...standardHeaders(),
    authorization: `token ${opts.token}`,
    "editor-version": `vscode/${opts.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  };
}
