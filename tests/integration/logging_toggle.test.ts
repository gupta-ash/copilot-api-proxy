/**
 * logging_toggle.test.ts — end-to-end coverage for the dynamic logging toggle
 * (Feature: runtime logging on/off with NO restart).
 *
 * Proves the whole loop through the REAL admin endpoint + the with-trace.ts
 * live gate, exactly as production wires it (main.ts always passes a
 * TraceWriter to startServer; capture is gated live on debug.getLevel()):
 *
 *   test 1 (on/off toggle via the admin API):
 *     - Boot at `off` (debug.setLevel(LEVEL_OFF)): the writer is present but
 *       with-trace.ts arms nothing → a non-streaming POST writes NO trace file.
 *     - POST /admin/logging {"level":"raw"} flips the live level → the NEXT
 *       request writes a .json manifest + .req + .res sidecar trio.
 *     - POST /admin/logging {"level":"off"} flips it back → subsequent requests
 *       stop writing (the flow count stays put).
 *
 *   test 2 (additivity — streaming path untouched at off):
 *     - At `off`, a STREAMING SSE request writes NO flow file (the handler
 *       threads an undefined traceWriter into the forwarder, so the streaming
 *       forwarder's traceEnabled stays false) AND the response bytes are
 *       byte-identical to the upstream SSE stream. The trace success counter
 *       is never bumped.
 *
 * Mechanism: buildApp(cfg, tm, writer) with a stubbed globalThis.fetch, driven
 * via app.request(...). Level flips go through the real POST /admin/logging
 * handler (not a direct debug.setLevel) so the admin route is under test too.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { LEVEL_OFF, LEVEL_ON, debug } from "../../src/lib/debug.ts";
import {
  getValueForTests,
  resetForTests as resetMetricsForTests,
} from "../../src/lib/metrics.ts";
import { TraceWriter } from "../../src/lib/trace.ts";
import { _resetFirstFailureForTests } from "../../src/routes/_shared/with-trace.ts";
import { _resetFirstFailureForTests as _resetStreamFirstFailureForTests } from "../../src/routes/_shared/forward-stream.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

// Side-effect import: register lane-1 rules so buildApp can wire the route.
import "../../src/lib/transform/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  resetMetricsForTests();
  _resetFirstFailureForTests();
  _resetStreamFirstFailureForTests();
  // The feature's headline scenario: the proxy booted at `off` (writer
  // present, capture disarmed). Each test drives the level from there.
  debug.setLevel(LEVEL_OFF);
});
afterEach(() => {
  resetMetricsForTests();
  debug.setLevel(LEVEL_ON);
  globalThis.fetch = ORIGINAL_FETCH;
});

function installStubFetch(responder: () => Response): void {
  globalThis.fetch = (async () => responder()) as unknown as typeof fetch;
}

async function makeReadyTokenManager(): Promise<{
  tm: TokenManager;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "logging-toggle-tm-"));
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
  return {
    tm,
    cleanup: async () => {
      tm.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function configLane1Native(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        body_rules: [],
        header_rules: [],
        response_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

/** All files (manifest + sidecars) under the dated traces flows dir. */
async function listAllFlowEntries(tempDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return [];
  }
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) return [];
  const flowsDir = path.join(tempDir, traceDir, "flows");
  try {
    return (await readdir(flowsDir)).sort();
  } catch {
    return [];
  }
}

/** Just the .json manifests under the flows dir. */
async function listManifests(tempDir: string): Promise<string[]> {
  return (await listAllFlowEntries(tempDir)).filter((n) => n.endsWith(".json"));
}

async function waitForTraceFlush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

async function postLevel(
  app: ReturnType<typeof buildApp>,
  level: string,
): Promise<Response> {
  return app.request("/admin/logging", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level }),
  });
}

async function postMessage(
  app: ReturnType<typeof buildApp>,
  extra?: Record<string, unknown>,
): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-3-opus",
      messages: [{ role: "user", content: "hi" }],
      ...(extra ?? {}),
    }),
  });
}

describe("dynamic logging toggle — end-to-end via /admin/logging", () => {
  it("test 1: off writes nothing; POST raw starts capture (.json/.req/.res trio); POST off stops", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "logging-toggle-1-"));
    installStubFetch(
      () =>
        new Response(JSON.stringify({ id: "resp-1", ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);

      // (a) Booted at off — GET reports off, and a request captures nothing.
      const g0 = await app.request("/admin/logging");
      expect(await g0.json()).toEqual({ level: "off" });

      const r0 = await postMessage(app);
      expect(r0.status).toBe(200);
      await waitForTraceFlush();
      expect(await listAllFlowEntries(tempDir)).toEqual([]);
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBeUndefined();

      // (b) Flip to raw via the admin API.
      const flipOn = await postLevel(app, "raw");
      expect(flipOn.status).toBe(200);
      expect(await flipOn.json()).toEqual({ previous: "off", current: "raw" });
      expect(await (await app.request("/admin/logging")).json()).toEqual({
        level: "raw",
      });

      // (c) The NEXT request writes a full trace trio.
      const r1 = await postMessage(app);
      expect(r1.status).toBe(200);
      await waitForTraceFlush();
      const afterRaw = await listAllFlowEntries(tempDir);
      expect(afterRaw.filter((n) => n.endsWith(".json")).length).toBe(1);
      expect(afterRaw.some((n) => n.endsWith(".req"))).toBe(true);
      expect(afterRaw.some((n) => n.endsWith(".res"))).toBe(true);
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBe(1);

      // (d) Flip back to off — subsequent requests stop writing.
      const flipOff = await postLevel(app, "off");
      expect(flipOff.status).toBe(200);
      expect(await flipOff.json()).toEqual({ previous: "raw", current: "off" });

      const manifestsBefore = (await listManifests(tempDir)).length;
      const r2 = await postMessage(app);
      expect(r2.status).toBe(200);
      await waitForTraceFlush();
      const manifestsAfter = (await listManifests(tempDir)).length;
      // No NEW manifest appeared after flipping off.
      expect(manifestsAfter).toBe(manifestsBefore);
      expect(manifestsAfter).toBe(1);
    } finally {
      await cleanup();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 2: additivity — at off a streaming request writes no flow AND response bytes are byte-identical to upstream", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "logging-toggle-2-"));
    const sseWire =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    installStubFetch(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(enc.encode(sseWire));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);

      // Level is off (beforeEach). A streaming request must forward verbatim
      // and capture nothing.
      const r = await postMessage(app, { stream: true });
      expect(r.status).toBe(200);
      const text = await r.text();
      await waitForTraceFlush();

      // Response bytes byte-identical to the upstream SSE wire.
      expect(text).toBe(sseWire);
      // No flow file written (streaming forwarder saw traceWriter=undefined).
      expect(await listAllFlowEntries(tempDir)).toEqual([]);
      // Trace success counter untouched — proves the streaming path never
      // entered the capture branch (additivity at off).
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBeUndefined();
    } finally {
      await cleanup();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
