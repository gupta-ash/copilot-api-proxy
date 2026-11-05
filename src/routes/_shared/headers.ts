/**
 * headers.ts — canonical-lowercase header merger + Authorization update helper.
 *
 * **Why this exists (M5 D-LOCK-10).** `api-config.copilotHeaders()` returns
 * mixed-case `Authorization` (capital A); transform-engine headers
 * (`lib/headers.ts`) use lowercase canonical. Naive merge
 * `{...baseHeaders, ...transformHeaders}` produces BOTH `Authorization` AND
 * `authorization` keys. The 401-retry path that mutates only `Authorization`
 * leaves stale `authorization` to potentially win at fetch normalization
 * (Node `undici` normalizes to lowercase but the resulting value is
 * non-deterministic when both keys exist).
 *
 * Resolution: every M5 service caller MUST use `canonicalHeaders` for the
 * initial fetch and `setAuthorization` for the 401 retry. NO direct
 * `{...a, ...b}` merging of header records anywhere in M5 service callers
 * (mini-audit lints by grep).
 */

/**
 * Merge an arbitrary number of header records into one lowercase-canonical
 * record. Later records win over earlier on duplicate (case-insensitive) keys.
 * Returns a fresh `Record<string, string>`; inputs are NOT mutated.
 *
 * Numeric / boolean values in the input are coerced to strings via
 * `String(...)`. (Hono and undici do the same coercion at fetch time; doing
 * it here makes the contract explicit.)
 */
export function canonicalHeaders(
  ...sources: Array<Record<string, string | number | boolean>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      out[k.toLowerCase()] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

/**
 * Headers that must NOT cross the proxy hop to upstream because the proxy
 * re-serializes the body and is a fresh HTTP/1.1 hop.
 *
 * **Why each entry exists.**
 *
 * Body-encoding entity headers — describe the INBOUND wire form of the
 * request body. The proxy re-serializes `ctx.body` to JSON for upstream;
 * the inbound length / encoding is stale and wrong. Node `undici` `fetch`
 * enforces `body.byteLength === content-length` (TypeError on mismatch).
 * Any body transformation can change the serialized size, so dropping stale
 * entity headers is structural rather than specific to a transformation rule:
 *   - `content-length`, `content-encoding`, `transfer-encoding`
 *
 * Hop-by-hop headers per RFC 7230 §6.1 — apply only to the single connection
 * they arrived on. The proxy MUST NOT relay them across the proxy/upstream
 * hop:
 *   - `connection`, `keep-alive`, `te`, `trailer`, `upgrade`,
 *     `proxy-authenticate`, `proxy-authorization`
 *
 * Authority — the inbound `host` names the proxy (e.g. `127.0.0.1:4143`);
 * upstream fetch must compute it from the upstream URL
 * (`api.enterprise.githubcopilot.com`):
 *   - `host`
 *
 * Set is lowercase to match `canonicalHeaders` output. Membership check is
 * case-insensitive (callers should pass canonical-lowercased keys; the helper
 * also defensively lowercases at lookup time).
 */
export const OUTBOUND_DROP_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);

/**
 * Drop hop-by-hop and body-encoding entity headers that must not cross the
 * proxy hop. Returns a fresh record with all keys in `OUTBOUND_DROP_HEADERS`
 * removed (case-insensitive). Input is NOT mutated.
 *
 * **Use site.** Every service caller's `buildUpstreamRequest` MUST call this
 * after `canonicalHeaders` and before passing to `fetch`. The body is
 * re-serialized inside `buildUpstreamRequest` (or by undici from `body:
 * JSON.stringify(...)`), so its content-length is recomputed by undici from
 * the new bytes; the inbound value would be stale and wrong.
 */
export function dropOutboundHopHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!OUTBOUND_DROP_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Update the Authorization header in a header record. Removes ALL
 * case-insensitive variants of `authorization` defensively (in case a
 * caller bypassed `canonicalHeaders`); sets the new value as lowercase
 * `authorization` with the `Bearer ` prefix.
 *
 * Use when refreshing the token mid-request (M5 D-LOCK-2 401-retry path).
 *
 * Returns a fresh record; the input is NOT mutated.
 *
 * **Defensive design (per discriminator iter-2 M4):** in the 401-retry
 * path inside service callers, the `buildUpstreamRequest` factory already
 * produces correct headers from the freshly-refreshed token. BUT
 * `canonicalHeaders`'s "later wins" rule means an `authorization` key in
 * the caller-supplied transform headers (e.g. an M9 custom rule injecting
 * a per-route token override) would clobber the just-refreshed token. By
 * calling `setAuthorization(headers, fresh.token)` AFTER
 * `buildUpstreamRequest` on the retry, the just-refreshed token wins
 * regardless of any override. The `auth_layer_b.test.ts` "custom rule
 * sets authorization override" case verifies this guarantee.
 */
export function setAuthorization(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "authorization") out[k] = v;
  }
  out["authorization"] = `Bearer ${token}`;
  return out;
}
