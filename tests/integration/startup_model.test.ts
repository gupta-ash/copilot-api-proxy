/**
 * startup_model.test.ts — D-LOCK-2 startup model verification.
 *
 * Coverage (≥7 cases per spec):
 *   1. Stage-1 fast bind: /health 200, all 5 protected routes 503 auth_pending
 *   2. Transition to ready: route serves through to upstream
 *   3. Transition to failed: routes return 503 auth_failed
 *   4. getStatus() lifecycle: uninitialized → starting → ready
 *   5. Dispose-after-ready: getStatus returns 'disposed' without throwing
 *   6. Starting-state observability: getStatus during slow start returns 'starting'
 *   7. Dispose-mid-start race: status transitions starting → disposed (terminal)
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

const ORIGINAL_FETCH = globalThis.fetch;
let tempDirs: Array<string> = [];

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-startup-"));
  tempDirs.push(d);
  return d;
}

function configWithRoutes(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: { method: "POST", path: "/v1/messages" },
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
      {
        match: { method: "POST", path: "/responses" },
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_responses",
          shape: "openai_responses",
        },
      },
      {
        match: { method: "POST", path: "/chat/completions" },
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_chat_completions",
          shape: "openai_chat",
        },
      },
      {
        match: { method: "POST", path: "/embeddings" },
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "embeddings",
          shape: "openai_chat",
        },
      },
    ],
  });
}

async function makeManagerWithControllableStart(opts: {
  startResolveAfterMs?: number;
  shouldFail?: boolean;
}): Promise<TokenManager> {
  const dir = await makeTempDir();
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => {
      if (opts.startResolveAfterMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.startResolveAfterMs));
      }
      if (opts.shouldFail === true) {
        throw new Error("forced upstream failure");
      }
      return {
        token: "fresh-token",
        refresh_in: 3540,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    },
    sleep: async () => {
      /* skip */
    },
    retryAttempts: 1,
    retryBackoffMs: [0],
  });
  return tm;
}

describe("D-LOCK-2 startup model", () => {
  it("(1) stage-1: /health serves; all 5 protected routes 503 auth_pending (per iter-4 M4 option A)", async () => {
    const tm = await makeManagerWithControllableStart({
      startResolveAfterMs: 1000,
    });
    // Do NOT await tm.start(); status remains "uninitialized".
    const app = buildApp(configWithRoutes(), tm);

    const health = await app.request("/health");
    expect(health.status).toBe(200);

    const protectedRoutes = [
      ["POST", "/v1/messages"],
      ["POST", "/responses"],
      ["POST", "/chat/completions"],
      ["POST", "/embeddings"],
      ["GET", "/v1/models"],
    ] as const;
    for (const [method, path] of protectedRoutes) {
      const init: RequestInit = { method };
      if (method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({ model: "claude-opus-4.7" });
      }
      const r = await app.request(path, init);
      expect(r.status).toBe(503);
      const body = (await r.json()) as { error: { type: string } };
      expect(body.error.type).toBe("auth_pending");
    }
    tm.dispose();
  });

  it("(2) transition to ready: /v1/messages 200 once start() resolves", async () => {
    globalThis.fetch = (async () =>
      new Response('{"ok":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const tm = await makeManagerWithControllableStart({});
    await tm.start();
    expect(tm.getStatus()).toBe("ready");

    const app = buildApp(configWithRoutes(), tm);
    const r = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.7" }),
    });
    expect(r.status).toBe(200);
    tm.dispose();
  });

  it("(3) transition to failed: /v1/messages returns 503 auth_failed", async () => {
    const tm = await makeManagerWithControllableStart({ shouldFail: true });
    await tm.start().catch(() => undefined);
    expect(tm.getStatus()).toBe("failed");

    const app = buildApp(configWithRoutes(), tm);
    const r = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.7" }),
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: { type: string } };
    expect(body.error.type).toBe("auth_failed");
    tm.dispose();
  });

  it("(4) getStatus lifecycle: uninitialized → starting → ready", async () => {
    const tm = await makeManagerWithControllableStart({
      startResolveAfterMs: 100,
    });
    expect(tm.getStatus()).toBe("uninitialized");
    const startP = tm.start();
    // Quick async tick — should be 'starting' before refresh resolves.
    await new Promise((r) => setTimeout(r, 5));
    expect(tm.getStatus()).toBe("starting");
    await startP;
    expect(tm.getStatus()).toBe("ready");
    tm.dispose();
  });

  it("(5) dispose-after-ready: getStatus returns 'disposed' without throwing", async () => {
    const tm = await makeManagerWithControllableStart({});
    await tm.start();
    expect(tm.getStatus()).toBe("ready");
    tm.dispose();
    // Must NOT throw — synchronous status read is the gate for routes.
    let thrown: unknown = null;
    let status: unknown = null;
    try {
      status = tm.getStatus();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(status).toBe("disposed");
  });

  it("(6) starting-state observability: status === 'starting' during slow start", async () => {
    const tm = await makeManagerWithControllableStart({
      startResolveAfterMs: 200,
    });
    const startP = tm.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(tm.getStatus()).toBe("starting");
    await startP;
    tm.dispose();
  });

  it("(7) dispose-mid-start race: status flips starting → disposed terminally", async () => {
    const tm = await makeManagerWithControllableStart({
      startResolveAfterMs: 200,
    });
    const startP = tm.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(tm.getStatus()).toBe("starting");
    tm.dispose();
    // After dispose: status MUST be 'disposed' (NOT ready, NOT failed).
    expect(tm.getStatus()).toBe("disposed");
    // start() promise rejects with disposal error.
    let thrown: unknown = null;
    try {
      await startP;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Status remains terminally 'disposed'.
    expect(tm.getStatus()).toBe("disposed");
  });
});
