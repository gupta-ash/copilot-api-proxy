/**
 * _retry.test.ts — Layer B 401-retry helper coverage (per discriminator
 * iter-1 M1 extraction).
 *
 * Coverage:
 *   1. First 401 response body is cancelled BEFORE refresh+retry (resource
 *      leak fix). Use a mock body whose ReadableStream records cancel().
 *   2. Retry uses the FRESH token returned by tokenManager.refresh()
 *      (not the original initialToken).
 *   3. Retry replays identical method/body as the initial attempt and the
 *      caller's abort still propagates to BOTH attempts (the signal handed
 *      to fetch is a composite of the caller signal + the wall-clock
 *      deadline, not the caller signal itself) — only Authorization differs.
 *   4. Without a tokenManager, 401 is propagated as-is (no retry).
 *   5. setAuthorization is called on the retry path (defensive override
 *      handling per iter-2 M4) — even if user-supplied headers contain an
 *      authorization key.
 *   6. ONE wall-clock deadline is shared across the initial fetch + the 401
 *      retry (the retry gets no fresh budget) — verified via the injectable
 *      `deadline` test seam (iter-3 medium).
 *   7. The deadline is composed INTO the caller-signal branch on both
 *      attempts (production shape: aborting ONLY the deadline still cancels
 *      both fetches even when a caller signal is present), and both attempts
 *      carry the scoped undici dispatcher — guards the
 *      `AbortSignal.any([callerSignal, deadline])` + dispatcher path
 *      (iter-4 medium).
 *   8. The production DEFAULT path (no injected deadline) creates exactly one
 *      `AbortSignal.timeout(1_200_000)` shared across both attempts and
 *      cancels both when it fires — guards the 20-min wall-clock cap and the
 *      scoped dispatcher on the real production code path (iter-5 medium).
 *   9. F135 outbound-header capture: at `verbose` BOTH fetch sites emit the
 *      URL/method/headers they are about to send, the two are distinguishable
 *      by `attempt`, `Authorization` is redacted through `redact.ts`, and
 *      nothing at all is emitted below `verbose`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";

import type { TokenManager } from "../../../src/auth/token-manager.ts";
import {
  debug,
  LEVEL_ON,
  LEVEL_VERBOSE,
  type Level,
} from "../../../src/lib/debug.ts";
import { fetchWithLayerBRetry } from "../../../src/services/copilot/_retry.ts";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  /* nothing */
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** Build a minimal TokenManager-shaped fake whose refresh() returns the
 * supplied token snapshot. Only `refresh` is invoked by the helper. */
function fakeTokenManager(refreshToken: string): TokenManager {
  return {
    refresh: async () => ({
      token: refreshToken,
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      fetched_at: Math.floor(Date.now() / 1000),
    }),
  } as unknown as TokenManager;
}

describe("fetchWithLayerBRetry — 401 body cancellation", () => {
  it("cancels the first 401 response body BEFORE issuing the retry (resource leak fix)", async () => {
    let cancelCalled = false;
    let fetchN = 0;
    globalThis.fetch = (async () => {
      fetchN += 1;
      if (fetchN === 1) {
        // Build a 401 Response with a ReadableStream body that records
        // cancel() invocation.
        const body = new ReadableStream({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode("unauthorized"));
            // Stays open; cancel() is the only way the consumer can free it.
          },
          cancel(): void {
            cancelCalled = true;
          },
        });
        return new Response(body, {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tm = fakeTokenManager("fresh-token");
    const resp = await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ x: 1 }),
        },
      }),
      initialToken: "stale-token",
      tokenManager: tm,
    });

    expect(resp.status).toBe(200);
    expect(fetchN).toBe(2);
    // Allow microtasks queued by `void cancel().catch(...)` to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelCalled).toBe(true);
  });
});

describe("fetchWithLayerBRetry — retry token + replay correctness", () => {
  it("retry uses the fresh token (not the original initialToken)", async () => {
    let lastInit: RequestInit | undefined;
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      lastInit = init;
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const tm = fakeTokenManager("fresh-after-refresh");
    await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ x: 1 }),
        },
      }),
      initialToken: "stale",
      tokenManager: tm,
    });

    const headers = lastInit?.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBe("Bearer fresh-after-refresh");
  });

  it("retry replays identical method/body and propagates caller abort to both attempts (only Authorization differs)", async () => {
    const initials: RequestInit[] = [];
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      if (init !== undefined) initials.push(init);
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const sharedSignal = ac.signal;
    const sharedBody = JSON.stringify({ replay: "test" });

    const tm = fakeTokenManager("fresh");
    await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: sharedBody,
          signal: sharedSignal,
        },
      }),
      initialToken: "stale",
      tokenManager: tm,
    });

    expect(initials.length).toBe(2);
    const a = initials[0]!;
    const b = initials[1]!;
    expect(a.method).toBe(b.method);
    expect(a.method).toBe("POST");
    expect(a.body).toBe(b.body);
    expect(a.body).toBe(sharedBody);
    // The signal handed to fetch is NO LONGER the caller's signal: it is a
    // composite (AbortSignal.any([callerSignal, deadline])) so EITHER the
    // caller aborting OR the wall-clock deadline cancels the upstream fetch.
    expect(a.signal).not.toBe(sharedSignal);
    expect(b.signal).not.toBe(sharedSignal);
    expect(a.signal!.aborted).toBe(false);
    expect(b.signal!.aborted).toBe(false);
    // Caller abort must still propagate to BOTH attempts' composite signals.
    ac.abort();
    expect(a.signal!.aborted).toBe(true);
    expect(b.signal!.aborted).toBe(true);
    // Authorization MUST differ.
    const aHeaders = a.headers as Record<string, string>;
    const bHeaders = b.headers as Record<string, string>;
    expect(aHeaders["authorization"]).toBe("Bearer stale");
    expect(bHeaders["authorization"]).toBe("Bearer fresh");
  });

  it("shares ONE wall-clock deadline across the initial fetch + the 401 retry (retry gets no fresh budget)", async () => {
    const initials: RequestInit[] = [];
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      if (init !== undefined) initials.push(init);
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    // Inject a controllable deadline (no caller signal) so each attempt's
    // composite collapses to the deadline itself. Aborting the single shared
    // deadline must cancel BOTH attempts — proving the retry reuses the same
    // budget rather than minting a fresh 20-min timer.
    const deadlineController = new AbortController();
    const injectedDeadline = deadlineController.signal;

    const tm = fakeTokenManager("fresh");
    await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ x: 1 }),
          // no per-request signal → composeUpstreamSignal returns the deadline
        },
      }),
      initialToken: "stale",
      tokenManager: tm,
      deadline: injectedDeadline,
    });

    expect(initials.length).toBe(2);
    const a = initials[0]!;
    const b = initials[1]!;
    // With no caller signal, both attempts receive the SAME injected deadline.
    expect(a.signal).toBe(injectedDeadline);
    expect(b.signal).toBe(injectedDeadline);
    expect(a.signal).toBe(b.signal);
    expect(a.signal!.aborted).toBe(false);
    deadlineController.abort();
    expect(a.signal!.aborted).toBe(true);
    expect(b.signal!.aborted).toBe(true);
  });

  it("composes the wall-clock deadline INTO the caller-signal branch on both attempts (production shape: deadline cancels even when a caller signal is present)", async () => {
    const initials: RequestInit[] = [];
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      if (init !== undefined) initials.push(init);
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    // Production shape: real service calls ALWAYS pass a per-request caller
    // signal AND the helper composes the wall-clock deadline. Inject BOTH a
    // caller signal and a controllable deadline, then abort ONLY the deadline:
    // both attempts must still cancel. This guards against a regression that
    // drops `deadline` from the `AbortSignal.any([callerSignal, deadline])`
    // composition (which would silently remove the 20-min cap from every
    // normal request while leaving caller-abort propagation intact).
    const callerController = new AbortController();
    const callerSignal = callerController.signal;
    const deadlineController = new AbortController();
    const injectedDeadline = deadlineController.signal;

    const tm = fakeTokenManager("fresh");
    await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ x: 1 }),
          signal: callerSignal,
        },
      }),
      initialToken: "stale",
      tokenManager: tm,
      deadline: injectedDeadline,
    });

    expect(initials.length).toBe(2);
    const a = initials[0]!;
    const b = initials[1]!;
    // Both attempts get a COMPOSITE, distinct from BOTH inputs.
    expect(a.signal).not.toBe(callerSignal);
    expect(a.signal).not.toBe(injectedDeadline);
    expect(b.signal).not.toBe(callerSignal);
    expect(b.signal).not.toBe(injectedDeadline);
    expect(a.signal).not.toBe(b.signal);
    expect(a.signal!.aborted).toBe(false);
    expect(b.signal!.aborted).toBe(false);
    // Both attempts MUST carry the scoped undici dispatcher (the 20-min idle
    // headers/body timeouts). Same object on initial + retry = the
    // module-scoped `upstreamDispatcher`, not a per-call one. Guards against a
    // regression deleting `dispatcher` (which silently reverts to undici's
    // 300s default idle timeout).
    const aDispatcher = (a as { dispatcher?: unknown }).dispatcher;
    const bDispatcher = (b as { dispatcher?: unknown }).dispatcher;
    expect(aDispatcher).toBeDefined();
    expect(aDispatcher).not.toBeNull();
    expect(aDispatcher).toBe(bDispatcher);
    // Abort ONLY the deadline (NOT the caller): both attempts must cancel,
    // proving the deadline is truly composed into the caller-signal branch.
    deadlineController.abort();
    expect(a.signal!.aborted).toBe(true);
    expect(b.signal!.aborted).toBe(true);
  });

  it("falls back to a default 20-min AbortSignal.timeout when no deadline is injected, created ONCE and cancelling both attempts (production default cap)", async () => {
    const initials: RequestInit[] = [];
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      if (init !== undefined) initials.push(init);
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    // Stub AbortSignal.timeout to (a) record the budget it is called with and
    // (b) return a controllable stand-in signal. With NO `args.deadline`, the
    // helper MUST create exactly one default timeout of 1_200_000ms (20 min)
    // and share it across the initial fetch + the 401 retry; aborting the
    // stand-in must cancel BOTH attempts. Guards the production-only default
    // path (the injectable-`deadline` tests bypass it).
    const timeoutCalls: number[] = [];
    const defaultDeadlineCtrl = new AbortController();
    const origTimeout = AbortSignal.timeout;
    (
      AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }
    ).timeout = (ms: number) => {
      timeoutCalls.push(ms);
      return defaultDeadlineCtrl.signal;
    };

    try {
      const callerController = new AbortController();
      const tm = fakeTokenManager("fresh");
      await fetchWithLayerBRetry({
        buildRequest: (token) => ({
          url: "https://upstream.example/v1/messages",
          init: {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ x: 1 }),
            signal: callerController.signal,
          },
        }),
        initialToken: "stale",
        tokenManager: tm,
        // no `deadline` -> exercises the default AbortSignal.timeout(1_200_000)
      });

      // Default deadline created EXACTLY once with the 20-min budget (shared,
      // not a fresh timer per attempt).
      expect(timeoutCalls.length).toBe(1);
      expect(timeoutCalls[0]).toBe(1_200_000);

      expect(initials.length).toBe(2);
      const a = initials[0]!;
      const b = initials[1]!;
      expect(a.signal!.aborted).toBe(false);
      expect(b.signal!.aborted).toBe(false);
      // The scoped dispatcher must still ride on both attempts.
      const aDispatcher = (a as { dispatcher?: unknown }).dispatcher;
      const bDispatcher = (b as { dispatcher?: unknown }).dispatcher;
      expect(aDispatcher).toBeDefined();
      expect(aDispatcher).toBe(bDispatcher);
      // Aborting the default deadline cancels BOTH attempts.
      defaultDeadlineCtrl.abort();
      expect(a.signal!.aborted).toBe(true);
      expect(b.signal!.aborted).toBe(true);
    } finally {
      (AbortSignal as unknown as { timeout: typeof origTimeout }).timeout =
        origTimeout;
    }
  });
});

describe("fetchWithLayerBRetry — no tokenManager → 401 propagates as-is", () => {
  it("returns the 401 response without attempting a retry", async () => {
    let fetchN = 0;
    globalThis.fetch = (async () => {
      fetchN += 1;
      return new Response("denied", { status: 401 });
    }) as unknown as typeof fetch;

    const resp = await fetchWithLayerBRetry({
      buildRequest: (token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      }),
      initialToken: "stale",
      // tokenManager: undefined
    });

    expect(resp.status).toBe(401);
    expect(fetchN).toBe(1);
  });
});

describe("fetchWithLayerBRetry — defensive setAuthorization on retry", () => {
  it("user-supplied authorization override is overridden by fresh token on retry (iter-2 M4)", async () => {
    let lastInit: RequestInit | undefined;
    let fetchN = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      lastInit = init;
      if (fetchN === 1)
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const tm = fakeTokenManager("just-refreshed");
    await fetchWithLayerBRetry({
      // Simulate buildRequest that picks up a user-supplied authorization
      // override (M9 custom-rule case). The retry-path setAuthorization
      // must override this with the fresh token.
      buildRequest: (_token) => ({
        url: "https://upstream.example/v1/messages",
        init: {
          method: "POST",
          headers: { authorization: "Bearer user_override" },
        },
      }),
      initialToken: "stale",
      tokenManager: tm,
    });

    const headers = lastInit?.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBe("Bearer just-refreshed");
  });
});

// ---- F135 outbound-header capture ----------------------------------------

/**
 * A distinctive NON-sensitive header value. Nothing in the helper, the debug
 * layer or redact.ts would ever produce this string, so its presence in an
 * emission proves the outbound headers were really captured — as opposed to
 * an assertion that some default would satisfy anyway.
 */
const PROBE_HEADER_VALUE = "f135-outbound-probe-6b3d9a";
/** Plaintext bearer secrets — MUST never reach an emission. Deliberately
 * different lengths, so the two `<redacted, len=N>` forms differ too and the
 * retry emission cannot be mistaken for a second copy of the initial one. */
const INITIAL_SECRET = "test-initial";
const FRESH_SECRET = "test-fresh-value";

/** The shape `logOutboundRequest` emits. */
interface OutboundEmission {
  msg: string;
  attempt: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Pick the F135 emissions out of everything consola.debug received. */
function outboundEmissions(captured: Array<unknown>): Array<OutboundEmission> {
  return captured.filter(
    (e): e is OutboundEmission =>
      typeof e === "object" &&
      e !== null &&
      (e as { msg?: unknown }).msg === "Outbound upstream request",
  );
}

/** Run `fn` with the debug level pinned to `level` and consola.debug
 * intercepted; return everything emitted. Both are restored on the way out. */
async function captureDebug(
  level: Level,
  fn: () => Promise<void>,
): Promise<Array<unknown>> {
  const captured: Array<unknown> = [];
  const realDebug = consola.debug;
  consola.debug = ((arg: unknown): void => {
    captured.push(arg);
  }) as typeof consola.debug;
  debug.setLevel(level);
  try {
    await fn();
  } finally {
    consola.debug = realDebug;
    debug.setLevel(LEVEL_ON);
  }
  return captured;
}

/** Drive one 401 -> refresh -> retry through the helper, so BOTH fetch sites
 * run. Carries the probe header and plaintext bearer tokens. */
async function driveRetryFlow(): Promise<void> {
  let fetchN = 0;
  globalThis.fetch = (async () => {
    fetchN += 1;
    if (fetchN === 1)
      return new Response("", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;

  await fetchWithLayerBRetry({
    buildRequest: (token) => ({
      url: "https://upstream.example/v1/messages",
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-f135-probe": PROBE_HEADER_VALUE,
        },
        body: JSON.stringify({ x: 1 }),
      },
    }),
    initialToken: INITIAL_SECRET,
    tokenManager: fakeTokenManager(FRESH_SECRET),
  });
}

describe("fetchWithLayerBRetry — F135 outbound request-header capture", () => {
  it("captures the outbound headers, URL and method at verbose", async () => {
    const emissions = outboundEmissions(
      await captureDebug(LEVEL_VERBOSE, driveRetryFlow),
    );

    expect(emissions.length).toBe(2);
    const first = emissions[0]!;
    // Only a real capture of `init.headers` can put this value in the log.
    expect(first.headers["x-f135-probe"]).toBe(PROBE_HEADER_VALUE);
    expect(first.url).toBe("https://upstream.example/v1/messages");
    expect(first.method).toBe("POST");
  });

  it("redacts Authorization through redact.ts and leaves other headers intact", async () => {
    const emissions = outboundEmissions(
      await captureDebug(LEVEL_VERBOSE, driveRetryFlow),
    );

    expect(emissions.length).toBe(2);
    // The plaintext bearer values must be absent from EVERY emitted field.
    const serialized = JSON.stringify(emissions);
    expect(serialized).not.toContain(INITIAL_SECRET);
    expect(serialized).not.toContain(FRESH_SECRET);
    // ...replaced by redact.ts's length-exact `<redacted, len=N>` form.
    expect(emissions[0]!.headers["authorization"]).toBe(
      `<redacted, len=${`Bearer ${INITIAL_SECRET}`.length}>`,
    );
    expect(emissions[1]!.headers["authorization"]).toBe(
      `<redacted, len=${`Bearer ${FRESH_SECRET}`.length}>`,
    );
    // Redaction is targeted, not blanket suppression.
    expect(emissions[1]!.headers["x-f135-probe"]).toBe(PROBE_HEADER_VALUE);
  });

  it("emits at BOTH fetch sites and makes the two distinguishable", async () => {
    const emissions = outboundEmissions(
      await captureDebug(LEVEL_VERBOSE, driveRetryFlow),
    );

    expect(emissions.length).toBe(2);
    expect(emissions[0]!.attempt).toBe("initial");
    expect(emissions[1]!.attempt).toBe("retry-after-401");
    expect(emissions[0]!.attempt).not.toBe(emissions[1]!.attempt);
  });

  it("emits NOTHING below verbose (default level)", async () => {
    const captured = await captureDebug(LEVEL_ON, driveRetryFlow);

    expect(outboundEmissions(captured).length).toBe(0);
    expect(JSON.stringify(captured)).not.toContain(PROBE_HEADER_VALUE);
    expect(captured.length).toBe(0);
  });
});
