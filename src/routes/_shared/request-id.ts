/**
 * request-id.ts — per-request id helper for the M10 stream pipeline
 * (per D-LOCK-8 + interface-contracts.md § 3).
 *
 * **Purpose.** `forwardStreamTranslated` calls
 * `acquireStreamState(requestId)` + `releaseStreamState(requestId)` to
 * key the per-stream state map (see `sse-state.ts § Map<string, StreamState>`).
 * That requires a stable per-request string id. This helper extracts one
 * from the request headers (honoring `x-request-id` if set) or synthesizes
 * a UUID via `crypto.randomUUID()`.
 *
 * **Stability contract (M1 fix).** Multiple calls within a single HTTP
 * request return the SAME string. The first call resolves the id and
 * stashes it in Hono's per-request context (`c.set("requestId", ...)`);
 * subsequent calls read it back via `c.get("requestId")`. Different
 * concurrent requests get different ids (Hono ctx vars are per-request
 * scoped on a single event-loop turn; no locking needed).
 *
 * **Source priority.**
 *   1. `x-request-id` request header (if present + non-empty).
 *   2. `crypto.randomUUID()` fallback.
 *
 * `crypto.randomUUID()` is available in Node 19.0+ and Bun (verified). v2
 * targets Bun, no polyfill needed. `x-request-id` is a de-facto standard
 * request-tracking header (GCP/AWS/CDN proxies set it); honoring it lets
 * operators correlate proxy logs to upstream/client logs.
 */

import type { Context } from "hono";

const HONO_CTX_KEY = "requestId";

/**
 * Extract or synthesize a per-request id. Used by the stream-translated
 * forwarder to acquire/release per-stream state in `sse-state.ts`.
 *
 * Same string returned across multiple calls within one HTTP request
 * (cached in Hono per-request context). Distinct ids for distinct
 * concurrent requests.
 */
export function getRequestId(c: Context): string {
  const cached = c.get(HONO_CTX_KEY) as string | undefined;
  if (typeof cached === "string" && cached.length > 0) return cached;

  const header = c.req.raw.headers.get("x-request-id");
  const resolved =
    header !== null && header.length > 0 ? header : crypto.randomUUID();

  c.set(HONO_CTX_KEY, resolved);
  return resolved;
}
