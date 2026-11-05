/**
 * derive-upstream-signal.ts — request-scoped AbortSignal helper that filters
 * the srvx + Node v24 false-pre-aborted-signal bug.
 *
 * **The problem.** Under srvx 0.8.16 (the HTTP server adapter v2 uses) running
 * on Node v24.x, `c.req.raw.signal.aborted === true` at handler-entry time even
 * when the client has NOT actually disconnected. This is reproducible: every
 * incoming request shows `signal.aborted=true` synchronously inside the route
 * handler, before any user code has run. Passing that signal directly to
 * `fetch()` causes immediate AbortError → 500 "This operation was aborted"
 * within ~77ms. Wiring it to abort listeners in `forward-stream.ts` causes the
 * M12.8 H1 synchronous-abort-check to fire `onAbort()` before any bytes
 * stream — every stream gets cancelled at start.
 *
 * **The fix.** Wrap `c.req.raw.signal` in a fresh AbortController whose signal
 * mirrors ONLY post-creation aborts. Pre-existing aborted state from srvx is
 * filtered out. Late aborts (real client disconnect mid-request) DO propagate
 * via the addEventListener registered here.
 *
 * **Per-request usage contract.** Each handler / forwarder calls this once per
 * request and uses the returned signal everywhere it would have used
 * `c.req.raw.signal`. Multiple calls within the same request return the SAME
 * signal (cached in Hono's per-request context) so all consumers (upstream
 * fetch, forward-stream listener, error-detection branches) see consistent
 * abort state.
 *
 * The helper owns only the request boundary; late disconnects still cancel
 * upstream reads and forwarding. See forward-stream.ts and its abort tests.
 */

import type { Context } from "hono";

const HONO_CTX_KEY = "upstreamSignal";

/**
 * Return a request-scoped AbortSignal that filters srvx's false-pre-aborted
 * state and propagates only real mid-request client disconnects.
 *
 * Multiple calls within one HTTP request return the SAME signal object when
 * `c` is a real Hono Context with `.get`/`.set` ctx-vars; falls back to a
 * fresh AbortController per call when `c` is a test-mock without ctx-vars
 * (functionally equivalent — both register their own listener on the
 * inbound signal so a real abort propagates to all derived signals).
 */
export function deriveUpstreamSignal(c: Context): AbortSignal {
  // Cache lookup: tolerate test-mock contexts that lack .get/.set.
  let cached: AbortSignal | undefined;
  let canCache = true;
  try {
    cached = c.get(HONO_CTX_KEY) as AbortSignal | undefined;
  } catch {
    canCache = false;
  }
  if (cached !== undefined) return cached;

  const inbound = c.req.raw.signal;
  const out = new AbortController();

  // Snapshot pre-existing aborted state. If inbound is already aborted at
  // handler-entry (the srvx + Node v24 bug), do NOT propagate — the client
  // hasn't actually disconnected. Only propagate aborts that arrive AFTER
  // this listener registration (genuine client disconnect mid-request).
  if (!inbound.aborted) {
    inbound.addEventListener(
      "abort",
      () => {
        try {
          out.abort(inbound.reason);
        } catch {
          /* idempotent; ignore double-abort */
        }
      },
      { once: true },
    );
  }

  if (canCache) {
    try {
      c.set(HONO_CTX_KEY, out.signal);
    } catch {
      /* test mock without ctx-vars; cache miss is fine */
    }
  }
  return out.signal;
}
