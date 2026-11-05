// Adapted from xianml/copilot-api-pro@f212832 src/services/github/get-device-code.ts
// Modifications:
//   - Imports rewired: api-config + error live under v2's path conventions.
//   - Otherwise verbatim crib (logic + body shape unchanged).

/**
 * get-device-code.ts — kick off the GitHub OAuth device-code flow.
 *
 * Used by `TokenManager.start()` when the on-disk `github_token` file is
 * empty: we POST to `/login/device/code`, GitHub returns a short user-code
 * for the browser flow + a device-code we then poll on (`poll-access-token`).
 */

import {
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "./api-config.ts";

import { HTTPError } from "~/lib/error.ts";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_APP_SCOPES,
    }),
  });

  if (!response.ok) {
    throw new HTTPError("Failed to get device code", response);
  }

  return (await response.json()) as DeviceCodeResponse;
}
