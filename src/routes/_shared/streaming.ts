/**
 * streaming.ts — canonical SSE-streaming predicate.
 *
 * Per discriminator iteration-3 M1: BOTH the route handlers AND every
 * streaming-capable service caller import from here. NO duplicated
 * `isStreamingResponse` definitions allowed (mini-audit item 23b grep
 * asserts exactly one definition).
 *
 * The UPSTREAM response is the source of truth — NOT the request's
 * `stream:true` body field. This handles the misconfigured-upstream edge
 * case (upstream returns SSE for non-streaming request OR vice versa —
 * handler does the right thing either way).
 */

/**
 * Returns true iff the response's content-type indicates a server-sent-events
 * stream. Case-insensitive (HTTP headers are case-insensitive); tolerates
 * content-type parameters like `text/event-stream; charset=utf-8`.
 */
export function isStreamingResponse(response: Response): boolean {
  const ct = response.headers.get("content-type");
  if (ct === null) return false;
  return ct.toLowerCase().includes("text/event-stream");
}
