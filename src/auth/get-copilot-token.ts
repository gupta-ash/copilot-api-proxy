// Adapted with refactor (no global state) from xianml/copilot-api-pro@f212832 src/services/github/get-copilot-token.ts
// Modifications:
//   - Pure function: takes `(githubToken, accountType, vsCodeVersion, signal?)` as
//     explicit args instead of reading from the upstream `state` singleton.
//   - M4.5 F1: optional `signal: AbortSignal` parameter threaded through to fetch
//     so the caller (TokenManager) can interrupt an in-flight refresh on dispose().
//   - M4.5 F11: `accountType` rename — was `_accountType` underscore-suppressed.
//     Now `accountType` + `void accountType` + TODO comment. Wire-through to
//     `copilotBaseUrl(accountType)` deferred to M5 when per-tier endpoints surface.
//   - M4.5 M4: validate `expires_at` is in plausible Unix-seconds range. Defends
//     against an upstream regression that returns ms-instead-of-s, which would
//     otherwise let the fail-open cache serve a dead token forever.
//   - Imports rewired to v2 paths.

/**
 * get-copilot-token.ts — exchange a GitHub OAuth token for a short-lived
 * (~60-min) Copilot-Ent token via `api.github.com/copilot_internal/v2/token`.
 *
 * This is the function `TokenManager.refresh()` calls under the hood. The
 * cache + retry + singleflight semantics live in `TokenManager`; this module
 * is a thin wrapper around `fetch` that adds defensive validation of the
 * response shape (M4.5 M4).
 */

import {
  GITHUB_API_BASE_URL,
  type AccountType,
  githubHeaders,
} from "./api-config.ts";

import { HTTPError } from "~/lib/error.ts";

export interface CopilotTokenResponse {
  /** The Copilot-Ent token (Bearer-style). */
  token: string;
  /** Recommended seconds until the next refresh (upstream guidance, not a hard TTL). */
  refresh_in: number;
  /** Unix-seconds at which the token will hard-expire. */
  expires_at: number;
}

/**
 * Upper bound for `expires_at` (one year from now in Unix-seconds). Real
 * Copilot tokens have ~60-minute TTL — the 365-day bound is generous by
 * ~8500x, so it cannot false-positive on a real token but will reliably
 * catch ms-instead-of-s regressions (1745999999000 >> now + 365d).
 */
const ONE_YEAR_SEC = 365 * 24 * 60 * 60;

export async function getCopilotToken(
  githubToken: string,
  accountType: AccountType,
  vsCodeVersion: string,
  signal?: AbortSignal,
): Promise<CopilotTokenResponse> {
  // M4.5 F11: accountType is currently unused at the URL level (api.github.com
  // for all tiers). Future per-tier endpoints would route via
  // `copilotBaseUrl(accountType)` — see api-config.ts:51.
  // TODO M5: thread accountType into URL selection if per-tier endpoints surface.
  void accountType;

  const headers = githubHeaders({ token: githubToken, vsCodeVersion });
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    { headers, signal },
  );

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot token", response);
  }

  const body = (await response.json()) as CopilotTokenResponse;

  // M4.5 M4: validate `expires_at` is in plausible Unix-seconds range. If
  // upstream ever returns ms (e.g. 1745999999000) by mistake, fail-open
  // would otherwise serve a dead cache forever.
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    typeof body.expires_at !== "number" ||
    !Number.isFinite(body.expires_at) ||
    body.expires_at > nowSec + ONE_YEAR_SEC
  ) {
    throw new HTTPError(
      `Copilot token expires_at out of plausible range (got ${String(body.expires_at)}; expected Unix-seconds <= ${nowSec + ONE_YEAR_SEC})`,
      response,
    );
  }

  return body;
}
