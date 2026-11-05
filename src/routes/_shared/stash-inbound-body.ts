/**
 * stash-inbound-body.ts — Phase 5 v3.1 follow-up bug fix.
 *
 * Single shared helper for the body-stash pattern (F-DISC-5). Each of the
 * four body-handling routes (messages, responses, chat-completions,
 * embeddings) MUST call this immediately after parsing the JSON body and
 * BEFORE dispatching to the upstream / streaming forwarder.
 *
 * **Why both writes (c.set AND in-place TraceMeta mutation).**
 *
 * The non-streaming trace path in `with-trace.ts` reads
 * `c.get("inboundBody")` directly AFTER `next()` returns, and works without
 * the meta update. The streaming forwarders (`forwardStream` /
 * `forwardStreamTranslated` in `forward-stream.ts`) consume a snapshot
 * `TraceMeta` (passed via `ctxBase.traceMeta`) and emit the trace flow from
 * inside their `finally` block. Without the in-place meta update here, the
 * meta they consume still carries the `inboundBody: null` placeholder set
 * by `with-trace.ts:139` — producing `request.body_kind: "empty"` in
 * traces of every streaming flow.
 *
 * Pre-fix duplication (c.set in 4 handlers) was the structural smell that
 * masked the streaming gap; centralising "stash + sync" here closes the
 * bug at the source AND removes the 4-site duplication.
 *
 * **Type-import note.** `TraceMeta` is owned by `forward-stream.ts`
 * (Group C declared the canonical type there; `with-trace.ts:56` imports
 * it from the same path). Helper follows the same import path so the
 * canonical home is preserved.
 *
 * **No-op when raw mode off.** Callers gate with
 * `if (c.get("traceWriter") !== undefined)`; when the meta object is also
 * absent (level < raw), the in-place mutation here is a no-op (`tm` is
 * `undefined`). Guard intentionally narrow — never alters the c.set
 * indirection (the non-streaming middleware path needs both keys set
 * regardless of whether a streaming meta object exists).
 */

import type { Context } from "hono";

import type { TraceMeta } from "~/routes/_shared/forward-stream.ts";

/**
 * Stash the inbound request body bytes onto the Hono context AND propagate
 * into the streaming `TraceMeta` (when raw mode is active so a meta object
 * exists). See module-level docstring for the rationale behind the two
 * writes.
 *
 * Handlers MUST call this immediately after parsing the body (and BEFORE
 * dispatching to the upstream / streaming forwarder).
 */
export function stashInboundBody(
  c: Context,
  bytes: Uint8Array,
  contentType: string,
): void {
  c.set("inboundBody", bytes);
  c.set("inboundContentType", contentType);
  // Mirror onto the streaming-side meta in place. The middleware
  // constructed this object BEFORE the handler ran with `inboundBody: null`
  // as a placeholder; we replace it with the real bytes here so the
  // streaming forwarder's emitTraceFlow sees a non-empty body.
  const tm = c.get("traceMeta") as TraceMeta | undefined;
  if (tm !== undefined) {
    tm.inboundBody = bytes;
    tm.inboundContentType = contentType;
  }
}
