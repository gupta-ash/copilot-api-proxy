/**
 * Tests for src/auth/get-copilot-token.ts
 *
 * Coverage map (from M4.5 spec § Tests § get-copilot-token.test.ts):
 *   1. expires_at within +1 hour: response is returned unchanged.
 *   2. expires_at = now + 365 days: returned (boundary).
 *   3. expires_at = now + 366 days: throws HTTPError "out of plausible range".
 *   4. expires_at = ms-mistake: throws HTTPError.
 *   5. expires_at = "not a number" string: throws HTTPError.
 *   6. expires_at = NaN / Infinity: throws HTTPError.
 *   7. signal abort propagates: pass an aborted signal; assert AbortError surfaces.
 *   8. !response.ok throws HTTPError "Failed to get Copilot token".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getCopilotToken } from "../../src/auth/get-copilot-token.ts";
import { HTTPError } from "../../src/lib/error.ts";

const realFetch = globalThis.fetch;

interface FetchStub {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function installFetchStub(
  stub:
    | FetchStub
    | ((
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>),
): void {
  if (typeof stub === "function") {
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;
    return;
  }
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(stub.body), {
      status: stub.status,
      headers: { "content-type": "application/json", ...(stub.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getCopilotToken — happy path", () => {
  it("returns response unchanged when expires_at is within +1 hour", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    installFetchStub({
      status: 200,
      body: { token: "tok-1", refresh_in: 3540, expires_at: expires },
    });
    const out = await getCopilotToken("ghp_test", "enterprise", "1.95.0");
    expect(out.token).toBe("tok-1");
    expect(out.refresh_in).toBe(3540);
    expect(out.expires_at).toBe(expires);
  });

  it("accepts expires_at at the +365 day boundary (M4.5 M4)", async () => {
    const ONE_YEAR_SEC = 365 * 24 * 60 * 60;
    const expires = Math.floor(Date.now() / 1000) + ONE_YEAR_SEC;
    installFetchStub({
      status: 200,
      body: { token: "tok-boundary", refresh_in: 100, expires_at: expires },
    });
    const out = await getCopilotToken("ghp_test", "enterprise", "1.95.0");
    expect(out.expires_at).toBe(expires);
  });
});

describe("getCopilotToken — expires_at validation (M4.5 M4)", () => {
  it("throws HTTPError when expires_at exceeds +366 days", async () => {
    const ONE_YEAR_SEC = 365 * 24 * 60 * 60;
    const expires = Math.floor(Date.now() / 1000) + ONE_YEAR_SEC + 86400;
    installFetchStub({
      status: 200,
      body: { token: "tok", refresh_in: 100, expires_at: expires },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
    expect((thrown as Error).message).toContain("out of plausible range");
  });

  it("throws HTTPError when expires_at is in milliseconds (regression guard)", async () => {
    // 365 days from now in MS = ~now * 1000 + 365d_ms ≈ 1.7e12, way > nowSec + 1y.
    const msMistake = Date.now() + 3600 * 1000;
    installFetchStub({
      status: 200,
      body: { token: "tok", refresh_in: 100, expires_at: msMistake },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
    expect((thrown as Error).message).toContain("out of plausible range");
  });

  it("throws HTTPError when expires_at is a string", async () => {
    installFetchStub({
      status: 200,
      body: { token: "tok", refresh_in: 100, expires_at: "not-a-number" },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
  });

  it("throws HTTPError when expires_at is NaN", async () => {
    installFetchStub({
      status: 200,
      body: { token: "tok", refresh_in: 100, expires_at: Number.NaN },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
  });

  it("throws HTTPError when expires_at is Infinity", async () => {
    installFetchStub({
      status: 200,
      body: {
        token: "tok",
        refresh_in: 100,
        expires_at: Number.POSITIVE_INFINITY,
      },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
  });
});

describe("getCopilotToken — signal threading (M4.5 F1)", () => {
  it("propagates AbortError when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Real fetch will throw AbortError when called with an aborted signal.
    // We use the real undici-backed fetch by NOT installing a stub here —
    // but pointing at an unreachable URL would still try DNS first, so we
    // install a stub that respects the signal.
    installFetchStub(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        void input;
        const sig = init?.signal;
        if (sig?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response("{}", { status: 200 });
      },
    );
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0", ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
  });

  it("aborts mid-request when signal is aborted while fetch is in flight", async () => {
    const ctrl = new AbortController();
    installFetchStub(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        void input;
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    setTimeout(() => ctrl.abort(), 5);
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0", ctrl.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
  });
});

describe("getCopilotToken — non-OK response", () => {
  it("throws HTTPError with the response on 401", async () => {
    installFetchStub({
      status: 401,
      body: { error: "unauthorized" },
    });
    let thrown: unknown = null;
    try {
      await getCopilotToken("ghp", "enterprise", "1.95.0");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPError);
    expect((thrown as Error).message).toBe("Failed to get Copilot token");
    expect((thrown as HTTPError).response.status).toBe(401);
  });
});
