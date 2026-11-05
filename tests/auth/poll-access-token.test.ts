/**
 * Tests for src/auth/poll-access-token.ts
 *
 * Coverage map (from M4.5 spec § Tests § poll-access-token.test.ts):
 *   1. Returns access_token on first successful response.
 *   2. Polls multiple times until access_token surfaces.
 *   3. M4.5 M7: throws "Device code expired" after expires_in elapses.
 *   4. M4.5 H4: aborted signal during 4xx response surfaces AbortError WITHOUT
 *      the consola.error log firing first.
 *   5. Returns immediately with AbortError when signal already aborted at entry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";

import type { DeviceCodeResponse } from "../../src/auth/get-device-code.ts";
import { pollAccessToken } from "../../src/auth/poll-access-token.ts";
import { debug, LEVEL_ON, LEVEL_VERBOSE } from "../../src/lib/debug.ts";

const realFetch = globalThis.fetch;

function makeDeviceCode(
  over: Partial<DeviceCodeResponse> = {},
): DeviceCodeResponse {
  return {
    device_code: "dev-code-123",
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    // interval=0 → sleep ((0+1)*1000) = 1000ms; tests override as needed.
    interval: 0,
    ...over,
  };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("pollAccessToken — happy path", () => {
  it("returns access_token on first successful response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "ghp_abc", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const tok = await pollAccessToken(makeDeviceCode());
    expect(tok).toBe("ghp_abc");
  });

  it("polls multiple times until access_token surfaces", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ access_token: "ghp_after_3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    // interval=-1 → sleep((-1+1)*1000)=0ms; loop runs at full speed.
    const tok = await pollAccessToken(makeDeviceCode({ interval: -1 }));
    expect(tok).toBe("ghp_after_3");
    expect(calls).toBe(3);
  });
});

describe("pollAccessToken — M7 device-code expiration", () => {
  it("throws 'Device code expired' after expires_in elapses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Always return pending so the loop keeps going; expiration must terminate it.
      return new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    // expires_in: 0 means we are already past expiration on entry. Loop check
    // at the top of each iteration should trigger immediately.
    let thrown: unknown = null;
    try {
      await pollAccessToken(makeDeviceCode({ expires_in: 0, interval: -1 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Device code expired");
    expect((thrown as Error).message).toContain("expires_in: 0s");
    // Should not have polled at all (expiration trips before any fetch).
    expect(calls).toBe(0);
  });

  it("expires after a successful loop iteration", async () => {
    // expires_in: 0.05s; interval=-1 → sleep 0ms; one iteration runs, second
    // iteration's expiration check trips.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "slow_down" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    // expires_in is in seconds (per upstream); 0.05s = 50ms.
    let thrown: unknown = null;
    try {
      await pollAccessToken(makeDeviceCode({ expires_in: 0.05, interval: -1 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Device code expired");
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe("pollAccessToken — H4 abort handling", () => {
  it("aborted signal during 4xx response surfaces AbortError without 'Failed to poll' log", async () => {
    const ctrl = new AbortController();
    let logFired = false;
    const realError = consola.error;
    consola.error = ((..._args: Array<unknown>): void => {
      logFired = true;
    }) as typeof consola.error;

    try {
      // Mock returns 4xx; abort the signal during the response handling.
      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        // Abort just before returning the response so the !response.ok branch
        // sees the aborted signal at the throwIfAborted check.
        queueMicrotask(() => ctrl.abort());
        // Give the abort a beat to land before we resolve.
        await new Promise((r) => setTimeout(r, 5));
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response("rate limited", { status: 429 });
      }) as unknown as typeof globalThis.fetch;

      let thrown: unknown = null;
      try {
        await pollAccessToken(makeDeviceCode({ interval: -1 }), ctrl.signal);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("AbortError");
      // Per M4.5 H4: the misleading 'Failed to poll' log must NOT fire.
      expect(logFired).toBe(false);
    } finally {
      consola.error = realError;
    }
  });

  it("returns immediately with AbortError when signal is already aborted at entry", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: "should-not-fire" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    let thrown: unknown = null;
    try {
      await pollAccessToken(makeDeviceCode(), ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AbortError");
    expect(calls).toBe(0);
  });
});

describe("pollAccessToken — SECURITY: token redaction in verbose logs", () => {
  it("redacts access_token in the verbose poll-response debug log", async () => {
    const captured: Array<unknown> = [];
    const realDebug = consola.debug;
    consola.debug = ((arg: unknown): void => {
      captured.push(arg);
    }) as typeof consola.debug;
    debug.setLevel(LEVEL_VERBOSE);

    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            access_token: "ghp_SUPERSECRET_should_never_log",
            token_type: "bearer",
            scope: "read:user",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof globalThis.fetch;

      const tok = await pollAccessToken(makeDeviceCode());
      expect(tok).toBe("ghp_SUPERSECRET_should_never_log");

      const serialized = JSON.stringify(captured);
      // The verbose response log must have fired...
      expect(serialized).toContain("Polling access token response");
      // ...but the raw token must NOT appear anywhere in the emitted logs...
      expect(serialized).not.toContain("ghp_SUPERSECRET_should_never_log");
      // ...with the redaction marker in its place, and non-secret fields kept.
      expect(serialized).toContain("[redacted]");
      expect(serialized).toContain("bearer");
    } finally {
      consola.debug = realDebug;
      debug.setLevel(LEVEL_ON);
    }
  });
});
