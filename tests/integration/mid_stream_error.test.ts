/**
 * mid_stream_error.test.ts — D-LOCK-7 mid-stream error frame is forwarded
 * VERBATIM through the route handler's streamSSE bridge (per discriminator
 * iter-1 M3).
 *
 * The original auth_layer_b.test.ts case 5 only asserted that the SERVICE
 * CALLER returns the upstream Response intact. It did NOT prove that the
 * route handler's streamSSE bridge forwards the error frame to the client
 * verbatim. Combined with H1 (streaming bridge bugs), this left a real
 * gap. This test exercises the full route → forwardStream → client path.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema } from "../../src/types/config-schema.ts";

const ORIGINAL_FETCH = globalThis.fetch;
let tempDirs: Array<string> = [];

beforeEach(() => {
  /* nothing */
});
afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
  tempDirs = [];
});

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-proxy-midstream-"));
  tempDirs.push(dir);
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
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

describe("mid-stream error frame forwarded VERBATIM via route → streamSSE (M5.5 M3)", () => {
  it("/v1/messages: upstream emits message_start then event: error → client sees BOTH frames intact", async () => {
    let fetchN = 0;
    globalThis.fetch = (async () => {
      fetchN += 1;
      // Mock a streaming response: a message_start frame, a brief delay,
      // then an event: error frame, then close.
      const body = new ReadableStream({
        async start(controller): Promise<void> {
          controller.enqueue(
            new TextEncoder().encode(
              `event: message_start\ndata: {"type":"message_start"}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: {"type":"authentication_error","message":"upstream test error"}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const tm = await makeReadyManagerStarted();
    const cfg = ConfigSchema.parse({
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          body_rules: [],
          header_rules: [],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    const app = buildApp(cfg, tm);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain(
      "text/event-stream",
    );
    const text = await res.text();
    // Verbatim: BOTH the message_start AND the error frames must be
    // visible to the client byte-exactly.
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: error");
    expect(text).toContain("authentication_error");
    expect(text).toContain("upstream test error");
    // Exactly 1 upstream fetch — no mid-stream re-issue (D-LOCK-7 phase B
    // deferred to M7b).
    expect(fetchN).toBe(1);
    tm.dispose();
  });

  it("/responses: same forwarding contract for the Codex inbound", async () => {
    let fetchN = 0;
    globalThis.fetch = (async () => {
      fetchN += 1;
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(
            new TextEncoder().encode(
              `event: response.created\ndata: {"id":"resp_1"}\n\nevent: error\ndata: {"type":"server_error","message":"resp upstream error"}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const tm = await makeReadyManagerStarted();
    const cfg = ConfigSchema.parse({
      routes: [
        {
          match: { method: "POST", path: "/responses" },
          body_rules: [],
          header_rules: [],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "openai_responses",
            shape: "openai_responses",
          },
        },
      ],
    });
    const app = buildApp(cfg, tm);
    const res = await app.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.1", input: "test", stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: error");
    expect(text).toContain("resp upstream error");
    expect(fetchN).toBe(1);
    tm.dispose();
  });
});
