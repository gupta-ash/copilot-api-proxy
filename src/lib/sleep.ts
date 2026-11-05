// NEW — canonical signal-aware sleep helper.
// F12 (M4.5): replaces inline sleep definitions in src/auth/token-manager.ts and
// src/auth/poll-access-token.ts. M5 will be the third consumer (request-handler
// retry layer per O11 Layer B).

/**
 * sleep.ts — signal-aware async sleep.
 *
 * Resolves after `ms` milliseconds, OR rejects with an `AbortError` DOMException
 * if `signal` aborts before the timeout fires. Inert if `signal` is undefined.
 *
 * Cleanup is symmetric: timer is cleared on abort; abort listener is removed on
 * timeout (so we don't leak listeners on a re-used controller).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
