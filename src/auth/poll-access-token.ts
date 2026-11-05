// Adapted from xianml/copilot-api-pro@f212832 src/services/github/poll-access-token.ts
// Modifications:
//   - Added optional `signal: AbortSignal` parameter so the CLI can cancel
//     polling on SIGINT during initial auth.
//   - M4.5 F12: replaced inline `sleep` definition with import of canonical
//     signal-aware sleep from `~/lib/sleep.ts`. The sleep call now also
//     respects the abort signal so dispose() during a sleep window surfaces
//     promptly rather than waiting out the full interval.
//   - M4.5 H4 (cosmetic): reordered the `!response.ok` branch to check
//     `throwIfAborted(signal)` BEFORE the `consola.error` log, so an
//     abort-during-error-response does not emit a misleading log line.
//   - M4.5 M7: enforce the device-code's own `expires_in` cap. After
//     `expires_in` seconds the device code is invalid and every poll will
//     return 4xx forever; we now throw a clear "Device code expired" error
//     instead of looping until externally aborted.
//   - Logs go through the M1a `debug.on(LEVEL_VERBOSE, ...)` pattern for
//     per-poll bodies; outer surface still uses `consola` for one-time info.

/**
 * poll-access-token.ts — poll GitHub's `/login/oauth/access_token` until the
 * user completes the device-code browser flow.
 *
 * The poll cadence is dictated by the device-code response's `interval` field
 * (we add 1s slack). Each loop iteration checks the `AbortSignal` before
 * issuing the fetch and again before sleeping, so SIGINT-driven cancellation
 * surfaces as `AbortError` within at most one full sleep window. The loop
 * also self-terminates after `device_code.expires_in` seconds (M4.5 M7) so
 * an unattended browser flow doesn't run indefinitely.
 */

import consola from "consola";

import type { DeviceCodeResponse } from "./get-device-code.ts";
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "./api-config.ts";

import { LEVEL_VERBOSE, debug } from "~/lib/debug.ts";
import { sleep } from "~/lib/sleep.ts";

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  /** Present on still-pending responses (e.g. `authorization_pending`). */
  error?: string;
  error_description?: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  signal?: AbortSignal,
): Promise<string> {
  // Interval is in seconds; convert to ms and add 1s of slack per upstream.
  const sleepDuration = (deviceCode.interval + 1) * 1000;
  // M4.5 M7: cap total polling to the device-code's advertised lifetime.
  const expiresAtMs = Date.now() + deviceCode.expires_in * 1000;

  debug.on(
    LEVEL_VERBOSE,
    () =>
      `Polling access token with interval of ${sleepDuration}ms; device-code expires in ${deviceCode.expires_in}s`,
  );

  while (true) {
    if (Date.now() >= expiresAtMs) {
      throw new Error(
        `Device code expired (expires_in: ${deviceCode.expires_in}s). Re-run login.`,
      );
    }
    throwIfAborted(signal);

    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      },
    );

    if (!response.ok) {
      // M4.5 H4 cosmetic: check abort BEFORE logging so an abort-during-4xx
      // surfaces as AbortError without a misleading "Failed to poll" log.
      throwIfAborted(signal);
      const errText = await response.text();
      consola.error("Failed to poll access token:", errText);
      await sleep(sleepDuration, signal);
      continue;
    }

    const json = (await response.json()) as AccessTokenResponse;
    // SECURITY: the successful poll response carries the raw GitHub OAuth
    // `access_token`. Redact it before verbose logging so that running with
    // `logging.level: verbose` on a fresh device-code login (e.g. via
    // `--list-models` against a new identity, or normal first-run startup)
    // cannot leak the token to stdout/stderr/log sinks. Non-secret fields
    // (token_type/scope/error/error_description) are preserved for diagnosis.
    debug.on(LEVEL_VERBOSE, () => ({
      msg: "Polling access token response",
      body: {
        ...json,
        access_token:
          json.access_token === undefined ? undefined : "[redacted]",
      },
    }));

    if (json.access_token) {
      return json.access_token;
    }

    throwIfAborted(signal);
    await sleep(sleepDuration, signal);
  }
}
