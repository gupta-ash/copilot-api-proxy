// Adapted from xianml/copilot-api-pro@f212832 src/lib/error.ts
// Modifications:
//   - Removed `forwardError` (Hono-coupled — moves to src/routes/_shared/error-helpers.ts in M5).
//   - Removed Hono + consola imports — `lib/` must not depend on `routes/`'s framework choice (D17 P3).
//   - Added `TokenRefreshExhaustedError` class (NEW — used by `src/auth/token-manager.ts`).
//   - M4.5 M6: `TokenRefreshExhaustedError` now also passes `{ cause: lastError }` to
//     `super(...)` so V8/Bun "Caused by:" chains surface in DevTools/stack traces. The
//     `lastError` own-property is retained for programmatic access by M5's request-handler
//     retry layer (e.g. distinguishing HTTPError from network errors).
//   - M5 D-LOCK-4: Added `TokenManagerDisposedError` sentinel class (replaces M4.5's
//     `Error("TokenManager disposed")` plain-Error throws in token-manager.ts at 3 sites).
//     Message preserved verbatim so existing tests' `.message` checks continue to pass.

/**
 * error.ts — pure error classes shared across the proxy.
 *
 * Per D17 P3 (layer separation by structure), this module is FRAMEWORK-FREE:
 * no Hono import, no `Context`-coupled helpers. The route layer (M5) provides
 * `src/routes/_shared/error-helpers.ts` with the Hono-coupled `forwardError`
 * helper that consumes these errors and shapes HTTP responses.
 *
 * Three errors live here today:
 *   - `HTTPError` — wraps a non-OK upstream `fetch` response.
 *   - `TokenRefreshExhaustedError` — thrown by `TokenManager.refresh()` after
 *     `retryAttempts` failed token-refresh attempts with no usable cache.
 *   - `TokenManagerDisposedError` — thrown by `TokenManager.refresh()` /
 *     `getTokenForRequest()` after `dispose()` was called. M5 sentinel.
 */

/**
 * `HTTPError` — wraps an upstream `Response` that returned a non-OK status.
 * The original `Response` is preserved so callers can inspect `.status`,
 * read the body (`response.text()` / `.json()` once — caller's responsibility
 * to handle `bodyUsed`), or forward to the harness.
 */
export class HTTPError extends Error {
  response: Response;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "HTTPError";
    this.response = response;
  }
}

/**
 * `TokenRefreshExhaustedError` — thrown by `TokenManager.refresh()` after
 * `retryAttempts` consecutive failed attempts to refresh the Copilot token,
 * with no still-valid cached token to fall back on.
 *
 * `attempts` is the number of attempts that were made (== `retryAttempts`).
 * `lastError` is the last underlying error encountered (typically an
 * `HTTPError` or a network error / `TypeError` from `fetch`). It is exposed
 * BOTH as the standard `.cause` (M4.5 M6 — for V8/Bun "Caused by:" chains in
 * stack traces and DevTools) AND as the `.lastError` own-property (for
 * programmatic access by M5's request-handler retry layer, which uses it to
 * decide whether to retry the original upstream call).
 *
 * Layer A (token acquisition) owns this error per O11. Layer B (request
 * retry, mid-stream re-issue) is M5's responsibility — M5 maps this error
 * uniformly to HTTP 503 (auth subsystem unavailable, retryable client-side)
 * across BOTH `/health` AND actual upstream calls. (Was previously documented
 * as 503-on-`/health` + 502-on-upstream — discriminator iter-2 L1 unified to
 * a single status; see `routes/_shared/error-helpers.ts` § status-mapping.)
 */
export class TokenRefreshExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const lastMsg =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(`Token refresh exhausted after ${attempts} attempts: ${lastMsg}`, {
      cause: lastError,
    });
    this.name = "TokenRefreshExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * `TokenManagerDisposedError` — thrown by `TokenManager.refresh()` and
 * related methods after `dispose()` was called. M5's request-handler retry
 * logic uses `instanceof` to distinguish "we shut down mid-request" (return
 * 503 + `Connection: close`) from generic upstream auth failures (return
 * 401/502 per the upstream response).
 *
 * Replaces the M4.5-shipped plain `Error("TokenManager disposed")` throws —
 * `token-manager.ts` updated to throw this class instead. Existing tests
 * that assert `.message === "TokenManager disposed"` continue to pass
 * because the message is preserved verbatim.
 */
export class TokenManagerDisposedError extends Error {
  constructor() {
    super("TokenManager disposed");
    this.name = "TokenManagerDisposedError";
  }
}
