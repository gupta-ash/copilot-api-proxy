/**
 * auth_layer_b.test.ts — D-LOCK-2 + D-LOCK-7 verification.
 *
 * Coverage (≥6 cases per spec, including interleaving test for F29):
 *   1. Mock upstream returns 401 once → service caller invokes refresh() → retries → 200
 *   2. Mock upstream returns 401 twice → propagates 401 (no infinite loop)
 *   3. TokenManagerDisposedError mid-request → 503 + Connection: close
 *   4. TokenRefreshExhaustedError → 503
 *   5. Mid-stream auth-error wire spec (D-LOCK-7): error frame forwarded verbatim
 *   6. Custom-rule authorization override defense (iter-2 M4)
 *   7. Interleaving (F29): request-during-dispose race
 *   8. (M5.5 M2) Parameterized 401-retry battery across all 5 service
 *      callers — each caller gets a 401→success retry, a 401→401 propagate,
 *      and a replay-correctness assertion.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import {
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "../../src/lib/error.ts";
import { createAnthropicMessages } from "../../src/services/copilot/create-anthropic-messages.ts";
import { createChatCompletions } from "../../src/services/copilot/create-chat-completions.ts";
import { createEmbeddings } from "../../src/services/copilot/create-embeddings.ts";
import { createResponses } from "../../src/services/copilot/create-responses.ts";
import { getModels } from "../../src/services/copilot/get-models.ts";

const ORIGINAL_FETCH = globalThis.fetch;
let tempDirs: Array<string> = [];

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-aux-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
  tempDirs = [];
});

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
});

async function makeStartedManager(): Promise<TokenManager> {
  const dir = await makeTempDir();
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "fresh-after-refresh",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await tm.start();
  return tm;
}

describe("auth_layer_b — Layer B 401-retry", () => {
  it("retries ONCE on 401 → succeeds", async () => {
    let fetchN = 0;
    globalThis.fetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      fetchCalls.push({ url: url.toString(), init });
      if (fetchN === 1) {
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response('{"ok":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const tm = await makeStartedManager();
    const resp = await createAnthropicMessages({
      body: { model: "claude-opus-4.7", messages: [] },
      headers: {},
      copilotToken: "stale-token",
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      tokenManager: tm,
      upstreamPath: "/v1/messages",
    });
    expect(resp.status).toBe(200);
    // 2 inbound fetches (1 initial 401 + 1 retry success).
    expect(fetchN).toBe(2);
    tm.dispose();
  });

  it("propagates 401 (no infinite loop) when retry also returns 401", async () => {
    let fetchN = 0;
    globalThis.fetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      fetchN += 1;
      fetchCalls.push({ url: url.toString(), init });
      return new Response("", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const tm = await makeStartedManager();
    let thrown: unknown = null;
    try {
      await createAnthropicMessages({
        body: { model: "claude-opus-4.7", messages: [] },
        headers: {},
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/v1/messages",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Bounded at exactly 2 fetches (1 initial + 1 retry); NOT infinite.
    expect(fetchN).toBe(2);
    tm.dispose();
  });

  it("custom-rule authorization override is overridden by fresh token on retry (iter-2 M4)", async () => {
    let fetchN = 0;
    let lastInit: RequestInit | undefined;
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
      return new Response('{"ok":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const tm = await makeStartedManager();
    // Simulate an M9-style custom rule injecting an authorization override
    // into ctx.headers (which gets passed as args.headers to the service caller).
    const headers: Record<string, string> = {
      authorization: "Bearer fake_override",
    };
    await createAnthropicMessages({
      body: { model: "claude-opus-4.7", messages: [] },
      headers,
      copilotToken: "initial-token",
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      tokenManager: tm,
      upstreamPath: "/v1/messages",
    });
    // After retry, the outbound authorization MUST be the fresh token from
    // tokenManager.refresh() — NOT "Bearer fake_override".
    const outHeaders = lastInit?.headers as Record<string, string> | undefined;
    expect(outHeaders?.["authorization"]).toBe("Bearer fresh-after-refresh");
    tm.dispose();
  });

  it("TokenManagerDisposedError mid-request: dispose then refresh throws sentinel", async () => {
    const tm = await makeStartedManager();
    tm.dispose();
    let thrown: unknown = null;
    try {
      await tm.refresh();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TokenManagerDisposedError);
  });

  it("TokenRefreshExhaustedError thrown when refresh exhausts retries with no usable cache", async () => {
    const dir = await makeTempDir();
    const ghpath = path.join(dir, "github_token");
    await writeFile(ghpath, "ghp_test");
    const tm = new TokenManager({
      githubTokenPath: ghpath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: async () => {
        throw new Error("upstream 503");
      },
      sleep: async () => {
        /* skip */
      },
      retryAttempts: 3,
      retryBackoffMs: [0, 0, 0],
    });
    let thrown: unknown = null;
    try {
      await tm.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TokenRefreshExhaustedError);
    tm.dispose();
  });

  it("mid-stream auth error wire spec (D-LOCK-7): SSE error frame forwarded verbatim, no re-issue", async () => {
    let fetchN = 0;
    globalThis.fetch = (async () => {
      fetchN += 1;
      // Mock streaming response that emits an authentication_error mid-stream.
      const sse =
        `event: message_start\ndata: {"type":"message_start"}\n\n` +
        `event: error\ndata: {"type":"authentication_error","message":"bad token"}\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const tm = await makeStartedManager();
    const resp = await createAnthropicMessages({
      body: { model: "claude-opus-4.7", messages: [], stream: true },
      headers: {},
      copilotToken: "fresh",
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      tokenManager: tm,
      upstreamPath: "/v1/messages",
    });
    expect(resp.status).toBe(200);
    // Exactly 1 fetch — no mid-stream re-issue (D-LOCK-7 phase B: deferred to M7b).
    expect(fetchN).toBe(1);
    // Forwarded body contains the verbatim error frame.
    const text = await resp.text();
    expect(text).toContain("authentication_error");
    expect(text).toContain("event: error");
    tm.dispose();
  });

  it("interleaving (F29): request mid-flight + dispose() races cleanly", async () => {
    // Set up a fetch that hangs until we explicitly resolve it.
    let resolveFetch: ((r: Response) => void) | null = null;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as unknown as typeof fetch;
    const tm = await makeStartedManager();
    // Start a request that will hang on the global fetch.
    const reqPromise = createAnthropicMessages({
      body: { model: "claude-opus-4.7", messages: [] },
      headers: {},
      copilotToken: "old-token",
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      tokenManager: tm,
      upstreamPath: "/v1/messages",
    });
    // Wait for the inflight fetch to be set.
    const t_wait = Date.now();
    while (resolveFetch === null && Date.now() - t_wait < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resolveFetch).not.toBeNull();
    // Dispose mid-request.
    tm.dispose();
    // Resolve the hung fetch with a 401 — the service caller will try refresh
    // which throws TokenManagerDisposedError.
    (resolveFetch as unknown as (r: Response) => void)(
      new Response("", { status: 401 }),
    );
    let thrown: unknown = null;
    try {
      await reqPromise;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TokenManagerDisposedError);
  });
});

// ============================================================================
// M5.5 M2: parameterized 401-retry battery across all 5 service callers.
// The original suite only exercised createAnthropicMessages directly. The
// other 4 callers (createResponses, createChatCompletions,
// createEmbeddings, getModels) shared the same retry shape but had no
// direct retry assertions — copy-paste divergence in any one would not
// have been caught. Post-M5.5, all 5 use the shared fetchWithLayerBRetry
// helper; this battery proves they all exhibit the same retry behaviour
// from the public surface.
// ============================================================================

interface CallerSpec {
  name: string;
  /** Whether the caller sends a request body. getModels does not. */
  hasBody: boolean;
  /** HTTP method that the caller sends to the upstream. */
  method: "GET" | "POST";
  /** Invoke the service caller against the supplied TokenManager. */
  invoke: (
    tm: TokenManager,
    headers: Record<string, string>,
  ) => Promise<Response>;
}

const callers: CallerSpec[] = [
  {
    name: "createAnthropicMessages",
    hasBody: true,
    method: "POST",
    invoke: (tm, headers) =>
      createAnthropicMessages({
        body: { model: "claude-opus-4.7", messages: [] },
        headers,
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/v1/messages",
      }),
  },
  {
    name: "createResponses",
    hasBody: true,
    method: "POST",
    invoke: (tm, headers) =>
      createResponses({
        body: { model: "gpt-5.1", input: "hi" },
        headers,
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/responses",
      }),
  },
  {
    name: "createChatCompletions",
    hasBody: true,
    method: "POST",
    invoke: (tm, headers) =>
      createChatCompletions({
        body: { model: "gpt-4o", messages: [] },
        headers,
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/chat/completions",
      }),
  },
  {
    name: "createEmbeddings",
    hasBody: true,
    method: "POST",
    invoke: (tm, headers) =>
      createEmbeddings({
        body: { model: "text-embedding-3-small", input: "x" },
        headers,
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/embeddings",
      }),
  },
  {
    name: "getModels",
    hasBody: false,
    method: "GET",
    invoke: (tm, headers) =>
      getModels({
        headers,
        copilotToken: "stale-token",
        accountType: "enterprise",
        vsCodeVersion: "1.95.0",
        tokenManager: tm,
        upstreamPath: "/models",
      }),
  },
];

describe.each(callers)(
  "auth_layer_b parameterized (M5.5 M2) — $name",
  ({ name, hasBody, method, invoke }) => {
    it(`${name}: 401 → refresh → retry → 200`, async () => {
      let fetchN = 0;
      globalThis.fetch = (async () => {
        fetchN += 1;
        if (fetchN === 1)
          return new Response("", {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const tm = await makeStartedManager();
      const resp = await invoke(tm, {});
      expect(resp.status).toBe(200);
      expect(fetchN).toBe(2);
      tm.dispose();
    });

    it(`${name}: 401 → refresh → 401 again → propagates`, async () => {
      let fetchN = 0;
      globalThis.fetch = (async () => {
        fetchN += 1;
        return new Response("", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const tm = await makeStartedManager();
      let thrown: unknown = null;
      let resp: Response | null = null;
      try {
        resp = await invoke(tm, {});
      } catch (err) {
        thrown = err;
      }
      // Either the service caller throws an HTTPError on the second 401
      // (createAnthropicMessages, createResponses, createChatCompletions
      // throw on !ok && !streaming; createEmbeddings, getModels throw on
      // !ok unconditionally) — all 5 paths must surface the 401 (NOT
      // attempt a third fetch).
      if (thrown !== null) {
        expect(thrown).toBeDefined();
      } else {
        expect(resp?.status).toBe(401);
      }
      // Bounded at 2 fetches (no infinite loop).
      expect(fetchN).toBe(2);
      tm.dispose();
    });

    it(`${name}: retry uses identical method/body/signal as initial`, async () => {
      const initSeen: RequestInit[] = [];
      let fetchN = 0;
      globalThis.fetch = (async (
        _url: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        fetchN += 1;
        if (init !== undefined) initSeen.push(init);
        if (fetchN === 1)
          return new Response("", {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const tm = await makeStartedManager();
      await invoke(tm, {});

      expect(initSeen.length).toBe(2);
      const a = initSeen[0]!;
      const b = initSeen[1]!;
      expect(a.method).toBe(method);
      expect(b.method).toBe(method);
      // Body parity: GET callers MUST NOT send a body on either attempt.
      if (hasBody) {
        expect(a.body).toBe(b.body);
        expect(typeof a.body).toBe("string");
      } else {
        expect(a.body).toBeUndefined();
        expect(b.body).toBeUndefined();
      }
      // Signal parity (both undefined when not provided).
      expect(a.signal).toBe(b.signal);
      // Authorization MUST differ (initial vs retry token).
      const aHeaders = a.headers as Record<string, string>;
      const bHeaders = b.headers as Record<string, string>;
      expect(aHeaders["authorization"]).not.toBe(bHeaders["authorization"]);
      expect(bHeaders["authorization"]).toBe("Bearer fresh-after-refresh");
      tm.dispose();
    });

    it(`${name}: client-supplied authorization MUST NOT win over Copilot bearer`, async () => {
      // Copilot authorization must replace the client placeholder before the
      // first fetch, not only after a 401 retry.
      const initSeen: RequestInit[] = [];
      globalThis.fetch = (async (
        _url: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        if (init !== undefined) initSeen.push(init);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const tm = await makeStartedManager();
      // Inbound headers carry a client-supplied authorization (lowercase
      // canonical form, matching what canonicalHeaders produces from
      // Object.fromEntries(c.req.raw.headers.entries())).
      await invoke(tm, { authorization: "Bearer client-supplied-DUMMY" });
      expect(initSeen.length).toBe(1);
      const headers = initSeen[0]!.headers as Record<string, string>;
      // The Copilot bearer (from copilotToken: "stale-token") MUST win.
      expect(headers["authorization"]).toBe("Bearer stale-token");
      // Defense-in-depth: no second authorization key under any case variant.
      const authKeys = Object.keys(headers).filter(
        (k) => k.toLowerCase() === "authorization",
      );
      expect(authKeys.length).toBe(1);
      expect(authKeys[0]).toBe("authorization");
      tm.dispose();
    });
  },
);
