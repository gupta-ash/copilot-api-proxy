/**
 * tests/integration/alias_path_routing.test.ts — D-LOCK-1 alias normalization
 * end-to-end coverage (M9-FIX-PATHS-CONFIG D37).
 *
 * Per spec § D-LOCK-1: handlers normalize request path → canonical
 * (= `inbound_paths[0]`) BEFORE calling `findMatchingRoute`. This proves
 * the alias contract works: `/v1/responses` (alias) matches the same lanes
 * as `/responses` (canonical), because the handler swaps the request path
 * to the canonical literal before route-match.
 *
 * Test cases (per Acceptance Criteria):
 *   - `/v1/responses` × `claude-opus-4.7`  → matches Lane 5 (Codex→Claude cross-vendor)
 *   - `/v1/responses` × `gpt-5.5`          → matches Lane 2 (Codex→GPT-5.x native)
 *   - `/v1/chat/completions` × `gpt-4o-mini` → matches Lane 3 (native /chat/completions for GPT-4)
 *   - `/v1/embeddings` × `text-embedding-3-small` → reaches normalization (no_route since
 *     no embeddings lane in the smoke fixture; verifies the canonicalPath
 *     normalization happens regardless of model_pattern lanes)
 *   - `/chat/completions` × `gpt-5.5`      → no_route 404 (gpt-5.x family ONLY accepts /responses)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules
import { TokenManager } from "~/auth/token-manager.ts";
import { buildApp } from "~/server.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_YAML_PATH = path.join(REPO_ROOT, "config", "default.yaml");

function loadDefaultConfig(): Config {
  const text = readFileSync(DEFAULT_YAML_PATH, "utf-8");
  return ConfigSchema.parse(YAML.parse(text) as unknown);
}

// ---- TokenManager test factory -------------------------------------------

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const p = await import("node:path");
  const dir = await fs.mkdtemp(p.join(os.tmpdir(), "copilot-proxy-alias-"));
  const ghpath = p.join(dir, "github_token");
  await fs.writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "stub-copilot-token",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await tm.start();
  return tm;
}

// ---- Fetch mocking -------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
  const stubFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    fetchCalls.push({ url: input.toString(), init });
    return new Response('{"id":"upstream-stub"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = stubFetch as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("D-LOCK-1: alias path normalization → canonical (M9-FIX-PATHS-CONFIG)", () => {
  it("/v1/responses × claude-opus-4.7 → matches Lane 5 (Codex→Claude cross-vendor)", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(loadDefaultConfig(), tm);
    const r = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.7", input: "hi" }),
    });
    // Lane 5 redirects to /v1/messages upstream. Status 200 from stub.
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    // Cross-vendor: upstream URL MUST be /v1/messages (the redirect target),
    // NOT /v1/responses (the inbound alias) NOR /responses (the canonical inbound).
    expect(last?.url).toContain("/v1/messages");
    expect(last?.url).not.toContain("/responses");
    tm.dispose();
  });

  it("/v1/responses × gpt-5.5 → matches Lane 2 (Codex→GPT-5.x native passthrough)", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(loadDefaultConfig(), tm);
    const r = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
    });
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    // Lane 2 is passthrough → upstream is /responses (per upstreams config).
    expect(last?.url).toContain("/responses");
    expect(last?.url).not.toContain("/v1/responses");
    expect(last?.url).not.toContain("/v1/messages");
    tm.dispose();
  });

  it("/v1/chat/completions × gpt-4o-mini → matches Lane 3 (native /chat/completions for GPT-4)", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(loadDefaultConfig(), tm);
    const r = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    // Lane 3 passthrough → upstream is /chat/completions.
    expect(last?.url).toContain("/chat/completions");
    expect(last?.url).not.toContain("/v1/chat/completions");
    tm.dispose();
  });

  it("/v1/embeddings × text-embedding-3-small → handler normalizes (no_route since no embeddings lane wired in default.yaml)", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(loadDefaultConfig(), tm);
    const r = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "test",
      }),
    });
    // No embeddings lane in default.yaml today → 404 no_route.
    // BUT the error message MUST reference the CANONICAL path /embeddings,
    // not the alias /v1/embeddings (proves the handler normalized).
    expect(r.status).toBe(404);
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("no_route");
    expect(body.error.message).toContain("/embeddings");
    expect(body.error.message).not.toContain("/v1/embeddings");
    tm.dispose();
  });

  it("/chat/completions × gpt-5.5 → no_route 404 (gpt-5.x family ONLY accepts /responses upstream per OQ4)", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(loadDefaultConfig(), tm);
    const r = await app.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [] }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("no_route");
    // Lane 3 has model_pattern ^gpt-4 so gpt-5.5 doesn't match.
    // The error message references the inbound path + model.
    expect(body.error.message).toContain("/chat/completions");
    expect(body.error.message).toContain("gpt-5.5");
    tm.dispose();
  });
});
