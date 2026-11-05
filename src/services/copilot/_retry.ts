// Adapted from xianml/copilot-api-pro@f212832 — DRY refactor of the 5 service
// callers' inline 401-retry blocks. Original upstream did the same retry shape
// inline at each service caller; M5 extracted to per-caller copies. M5.5
// extracts to this single helper after the discriminator (iter-1 M1) flagged
// resource-leak risk (the prior 401 Response body was overwritten without
// being cancelled or drained, holding upstream connections under repeated
// expired-token traffic).

/**
 * _retry.ts — Layer B 401-retry helper (per D-LOCK-2).
 *
 * Single source of truth for the "401 → refresh → retry once" pattern used
 * by all 5 service callers (createAnthropicMessages, createResponses,
 * createChatCompletions, createEmbeddings, getModels). Bounded at ONE retry
 * to prevent infinite loops on persistent 401s.
 *
 * **Resource leak fix (iter-1 M1).** The first 401 Response is now
 * cancelled (`response.body?.cancel()`) BEFORE the refresh+retry, so the
 * underlying upstream connection is freed. Without this, repeated
 * expired-token traffic leaked upstream sockets.
 *
 * **Defensive header re-assertion (iter-2 M4).** `setAuthorization` is
 * called on the retry path even though `buildRequest` already produced the
 * fresh-token headers. `canonicalHeaders`'s "later wins" rule means an
 * `authorization` override in user-supplied transform headers (e.g. an M9
 * custom rule) would clobber the just-refreshed token on retry. The
 * `setAuthorization` call after the retry build re-asserts the fresh
 * token regardless of any override.
 *
 * **Replay correctness (iter-2 M-retry-replay).** The `buildRequest`
 * factory is called twice with different tokens but otherwise identical
 * args; this guarantees method/body/signal are bit-identical across
 * attempts (only the Authorization header differs).
 *
 * **Outbound-header observation point (F135).** This file is the ONLY place
 * the proxy records what it puts on the wire to Copilot. Trace mode at `raw`
 * captures the INBOUND client request and the UPSTREAM RESPONSE — nothing on
 * the proxy->upstream request leg — so verifying a header-fidelity change
 * previously needed a bolt-on `globalThis.fetch` wrapper improvised per ship.
 * It lives HERE rather than at the 5 service callers because all of them
 * (createAnthropicMessages, createResponses, createChatCompletions,
 * createEmbeddings, getModels) funnel through `fetchWithLayerBRetry`, whose
 * two fetch sites are the only egress points: one emit site per attempt
 * covers every caller, and the 401-retry request — which no caller can see,
 * since `setAuthorization` rewrites its Authorization header inside this
 * helper — is observable only from in here. Emission is `LEVEL_VERBOSE` and
 * strictly lazy, and has ZERO wire effect: `redactHeaders` returns a new
 * object and never mutates its input, so `init.headers` reaches `fetch`
 * unchanged.
 */

import { Agent } from "undici";

import type { TokenManager } from "~/auth/token-manager.ts";
import { debug, LEVEL_VERBOSE } from "~/lib/debug.ts";
import { redactHeaders } from "~/lib/redact.ts";
import { setAuthorization } from "~/routes/_shared/headers.ts";

// ---- Upstream fetch idle timeouts (scoped undici dispatcher) --------------
// Node's global fetch (undici) defaults headersTimeout/bodyTimeout to 300s.
// These are IDLE timeouts: headersTimeout caps time-to-first-byte; bodyTimeout
// caps the gap BETWEEN received body chunks. Neither bounds total request
// duration. Heavy Copilot upstream requests (1M-context + interleaved-thinking
// + high effort) can exceed 5 min to first byte, otherwise throwing
// "fetch failed" (UND_ERR_HEADERS_TIMEOUT) mid-flight. Raise both idle limits
// to 20 min so a slow-to-respond or slow-streaming upstream is not killed
// prematurely.
//
// Scoped to the two upstream Copilot fetches below (via `dispatcher` in the
// RequestInit) rather than installed globally, so short-lived auth fetches
// (get-copilot-token / get-device-code / poll-access-token) keep Node's default
// 300s idle behaviour instead of hanging up to 20 min on a stuck endpoint.
//
// NOTE — the TOTAL wall-clock cap on a (possibly downstream-cancelled) upstream
// fetch is enforced separately by the per-request `AbortSignal.timeout`
// deadline in fetchWithLayerBRetry, NOT by these idle timeouts (an SSE stream
// emitting chunks < 20 min apart would never trip bodyTimeout). The wall-clock
// deadline is required because under srvx 0.8.x + Node v24 `c.req.raw.signal`
// is already aborted at handler entry for EVERY request (the srvx
// pre-aborted-signal bug; see derive-upstream-signal.ts), so
// deriveUpstreamSignal CANNOT abort an orphaned fetch on a genuine client
// disconnect.
const upstreamDispatcher = new Agent({
  headersTimeout: 1_200_000,
  bodyTimeout: 1_200_000,
});

/** RequestInit augmented with undici's per-request `dispatcher` extension. */
type InitWithDispatcher = RequestInit & { dispatcher: Agent };

/**
 * Compose the per-request upstream signal (from `deriveUpstreamSignal`) with
 * the shared wall-clock deadline so EITHER aborting cancels the fetch.
 * `AbortSignal.any` requires real signals, so a missing per-request signal
 * falls back to the deadline alone.
 */
function composeUpstreamSignal(
  reqSignal: AbortSignal | null | undefined,
  deadline: AbortSignal,
): AbortSignal {
  return reqSignal ? AbortSignal.any([reqSignal, deadline]) : deadline;
}

/** Which of the two egress points an outbound-header emission came from. */
type OutboundAttempt = "initial" | "retry-after-401";

/**
 * Record one outbound upstream request (URL, method, redacted headers) at
 * `LEVEL_VERBOSE` — the F135 observation point.
 *
 * `attempt` distinguishes the two egress sites; without it the initial and
 * the 401-retry emissions are indistinguishable in the log and the gate is
 * unreadable.
 *
 * Everything, INCLUDING the `redactHeaders` walk, happens inside the
 * `debug.on` factory, so this costs nothing below `verbose`. Redaction
 * builds a NEW object (`redactHeaders` does not mutate its input) — do not
 * change that: `init.headers` is the same object handed to `fetch`, and this
 * emission must have no wire effect.
 */
function logOutboundRequest(
  attempt: OutboundAttempt,
  url: string,
  init: RequestInit,
): void {
  debug.on(LEVEL_VERBOSE, () => ({
    msg: "Outbound upstream request",
    attempt,
    url,
    // fetch defaults an absent method to GET; report what will actually go out.
    method: init.method ?? "GET",
    headers: redactHeaders((init.headers ?? {}) as Record<string, string>),
  }));
}

/** A built upstream request — URL + RequestInit. */
export interface RetryableUpstreamArgs {
  url: string;
  init: RequestInit;
}

/** Args for {@link fetchWithLayerBRetry}. */
export interface RetryHelperArgs {
  /**
   * Pure builder that produces the upstream request from a Copilot token.
   * Called once with `initialToken`; on a 401 it is called a second time
   * with the freshly-refreshed token. MUST be deterministic apart from the
   * token (so method/body/signal are identical across attempts).
   */
  buildRequest: (token: string) => RetryableUpstreamArgs;
  /** The Copilot token snapshot taken at the request handler. */
  initialToken: string;
  /**
   * Optional TokenManager for the retry path. When omitted, a 401 is
   * propagated as-is (no retry attempt). Service callers MAY omit this if
   * they explicitly do NOT want the retry behaviour.
   */
  tokenManager?: TokenManager;
  /**
   * Optional injected wall-clock deadline signal (test seam). Production
   * callers omit this; the helper then creates `AbortSignal.timeout(1_200_000)`
   * once and shares it across the initial fetch + the 401 retry. Tests inject
   * a controllable signal to deterministically verify the shared-budget
   * behaviour without waiting 20 min.
   */
  deadline?: AbortSignal;
}

/**
 * Issue an upstream fetch with at-most-one Layer B 401 retry.
 *
 * Behaviour:
 *   1. Build + fetch with `initialToken`.
 *   2. If status !== 401 OR no `tokenManager`, return the response as-is.
 *   3. Otherwise: cancel the 401 response body to free the connection, call
 *      `tokenManager.refresh()` to get a fresh token, build the request
 *      again with the fresh token, defensively re-assert the Authorization
 *      header, and re-fetch. Return the second response (200 OR 401 OR
 *      whatever — caller decides what to do with it).
 *
 * Throws whatever `fetch` or `tokenManager.refresh()` throws — caller is
 * responsible for catching `TokenManagerDisposedError`,
 * `TokenRefreshExhaustedError`, etc.
 */
export async function fetchWithLayerBRetry(
  args: RetryHelperArgs,
): Promise<Response> {
  // Total wall-clock ceiling shared across the initial fetch + the 401 retry.
  // The scoped Agent's headers/body timeouts are IDLE timeouts only; this gives
  // a real total-duration cap so an orphaned (downstream-cancelled) upstream
  // fetch — which deriveUpstreamSignal cannot abort under the srvx + Node v24
  // pre-aborted-signal bug — cannot outlive Claude Code's API_TIMEOUT_MS even
  // while still streaming. Reused across both attempts so the retry shares the
  // same budget rather than getting a fresh 20 min. Injectable via `args.deadline`
  // as a test seam (production omits it → real 20 min timer created once here).
  const deadline = args.deadline ?? AbortSignal.timeout(1_200_000);

  const initial = args.buildRequest(args.initialToken);
  logOutboundRequest("initial", initial.url, initial.init);
  let response = await fetch(initial.url, {
    ...initial.init,
    signal: composeUpstreamSignal(initial.init.signal, deadline),
    dispatcher: upstreamDispatcher,
  } as InitWithDispatcher);

  if (response.status === 401 && args.tokenManager !== undefined) {
    // Cancel the first 401 body BEFORE refresh+retry to prevent leaking
    // the upstream connection. Use `void`+`.catch` to swallow any rejection
    // (body may already be consumed/closed) and to make explicit that we
    // are NOT awaiting the cancellation — it can run in the background
    // while we kick off the refresh.
    void response.body?.cancel().catch(() => {
      /* already closed / already consumed */
    });

    const fresh = await args.tokenManager.refresh();
    const retry = args.buildRequest(fresh.token);
    // Defensive (per iter-2 M4): re-assert fresh token. See the file-head
    // doc for rationale.
    retry.init.headers = setAuthorization(
      retry.init.headers as Record<string, string>,
      fresh.token,
    );
    // After setAuthorization: the emission must show the header actually sent.
    logOutboundRequest("retry-after-401", retry.url, retry.init);
    response = await fetch(retry.url, {
      ...retry.init,
      signal: composeUpstreamSignal(retry.init.signal, deadline),
      dispatcher: upstreamDispatcher,
    } as InitWithDispatcher);
  }

  return response;
}
