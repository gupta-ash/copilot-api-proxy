/**
 * auth-gate.ts — D-LOCK-2 stage-1/2 auth gate (DRY at 5).
 *
 * Per M5 D-LOCK-2: every protected route MUST gate on
 * `tokenManager.getStatus()` BEFORE any other request handling. Stage 1
 * (server bound, TokenManager not ready yet) returns 503 auth_pending;
 * stage 2 ready proceeds to the handler body.
 *
 * Replaces the ~30-line auth-gate boilerplate previously duplicated in five
 * route handlers (messages, responses, chat-completions, embeddings,
 * models). The duplication was flagged by the M5 discriminator (iter-1 M7):
 * iter-4 already had to fix all 5 places when /v1/models was added to the
 * gate. Future status changes would otherwise require 5-place edits.
 *
 * Status mapping (matches the per-handler shape that this helper replaces):
 *
 *   | Status         | Response                                                       |
 *   |----------------|----------------------------------------------------------------|
 *   | "ready"        | null  — caller proceeds to handler body                        |
 *   | "disposed"     | 503 service_unavailable + "Connection: close" header           |
 *   | "failed"       | 503 auth_failed                                                |
 *   | "uninitialized"| 503 auth_pending                                               |
 *   | "starting"     | 503 auth_pending                                               |
 */

import type { Context } from "hono";

import type { TokenManager } from "~/auth/token-manager.ts";

/**
 * Inspect `tokenManager.getStatus()` and return either:
 *   - `null` — request should proceed (status === "ready"); OR
 *   - a 503 `Response` — caller should `return` it immediately.
 *
 * Adds `Connection: close` to the disposed-state response so that any
 * keep-alive client closes the socket promptly during shutdown.
 */
export function checkAuthGate(
  c: Context,
  tokenManager: TokenManager,
): Response | null {
  const status = tokenManager.getStatus();
  if (status === "ready") return null;
  if (status === "disposed") {
    c.header("Connection", "close");
    return c.json(
      {
        error: {
          type: "service_unavailable",
          message: "Proxy is shutting down",
        },
      },
      503,
    );
  }
  if (status === "failed") {
    return c.json(
      {
        error: {
          type: "auth_failed",
          message: "TokenManager failed to acquire Copilot token",
        },
      },
      503,
    );
  }
  // status === "uninitialized" || "starting"
  return c.json(
    {
      error: {
        type: "auth_pending",
        message: "TokenManager initializing",
      },
    },
    503,
  );
}
