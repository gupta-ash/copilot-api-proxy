/**
 * metrics_endpoint.test.ts — integration coverage for the /metrics endpoint
 * mounted in src/server.ts (M12 D-LOCK-4).
 *
 * Tests:
 *   1. GET /metrics returns 200 + content-type "text/plain; version=0.0.4".
 *   2. Body matches Prometheus per-line shape.
 *   3. /metrics is reachable when TokenManager status is "starting"
 *      (NOT auth-gated).
 *   4. /metrics is reachable when TokenManager status is "ready".
 *   5. /metrics short-circuit: 10 GETs to /metrics leave
 *      copilot_proxy_requests_total{route="metrics"} ABSENT (per D38
 *      iter-1 M2 fix MANDATE).
 *   6. After making N requests to /health, /metrics body shows the
 *      copilot_proxy_token_status gauge present (always-on).
 *   7. (M12.5 H1) Stream metrics emit a single canonical `route` label
 *      across `requests_total`, `response_bytes_total`,
 *      `stream_events_total`, `inflight_requests` — i.e. all four
 *      families show `route="messages"`, never `route="/v1/messages"`.
 *      Same for `responses` lane and `chat_completions` lane.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { resetForTests } from "../../src/lib/metrics.ts";
import { buildApp, startServer, type ServerHandle } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

interface Harness {
  handle: ServerHandle;
  tm: TokenManager;
  cleanup: () => Promise<void>;
}

async function bootStartingServer(): Promise<Harness> {
  // Build a TokenManager that NEVER finishes starting — fetch returns a
  // never-resolving promise so status stays "starting" the whole test.
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-proxy-met-"));
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: () =>
      new Promise(() => {
        /* never resolves — status remains "starting" */
      }),
  });
  // Fire start() but DON'T await — we want status "starting".
  void tm.start();
  const cfg = ConfigSchema.parse({});
  const handle = await startServer({
    port: 0,
    host: "127.0.0.1",
    config: cfg,
    tokenManager: tm,
  });
  return {
    handle,
    tm,
    cleanup: async () => {
      tm.dispose();
      await handle.close({ graceMs: 100 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function bootReadyServer(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-proxy-met-"));
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "stub",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await tm.start();
  const cfg = ConfigSchema.parse({});
  const handle = await startServer({
    port: 0,
    host: "127.0.0.1",
    config: cfg,
    tokenManager: tm,
  });
  return {
    handle,
    tm,
    cleanup: async () => {
      tm.dispose();
      await handle.close({ graceMs: 100 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  resetForTests();
});
afterEach(() => {
  resetForTests();
});

describe("/metrics endpoint — basic shape", () => {
  it("returns 200 with content-type text/plain; version=0.0.4", async () => {
    const h = await bootReadyServer();
    try {
      const r = await fetch(h.handle.url + "/metrics");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; version=0.0.4");
      // Drain the body so the connection can close cleanly.
      await r.text();
    } finally {
      await h.cleanup();
    }
  });

  it("body parses as valid Prometheus text format (each non-comment line matches the shape)", async () => {
    const h = await bootReadyServer();
    try {
      const r = await fetch(h.handle.url + "/metrics");
      const body = await r.text();
      const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? -?\d+(\.\d+)?$/;
      let valueLines = 0;
      for (const line of body.split("\n")) {
        if (line === "") continue;
        if (line.startsWith("# ")) continue;
        expect(lineRe.test(line)).toBe(true);
        valueLines += 1;
      }
      // At minimum the 3 always-on gauges should emit value lines.
      expect(valueLines).toBeGreaterThanOrEqual(3);
    } finally {
      await h.cleanup();
    }
  });
});

describe("/metrics endpoint — auth gate behavior", () => {
  it("returns 200 even when TokenManager status is 'starting' (NOT auth-gated)", async () => {
    const h = await bootStartingServer();
    try {
      // Sanity — status really IS starting.
      expect(h.tm.getStatus()).toBe("starting");
      const r = await fetch(h.handle.url + "/metrics");
      expect(r.status).toBe(200);
      const body = await r.text();
      // token_status gauge present + reflects starting (0).
      expect(body).toMatch(/^copilot_proxy_token_status 0$/m);
    } finally {
      await h.cleanup();
    }
  });

  it("returns 200 when TokenManager status is 'ready'", async () => {
    const h = await bootReadyServer();
    try {
      expect(h.tm.getStatus()).toBe("ready");
      const r = await fetch(h.handle.url + "/metrics");
      expect(r.status).toBe(200);
      const body = await r.text();
      // token_status gauge present + reflects ready (1).
      expect(body).toMatch(/^copilot_proxy_token_status 1$/m);
    } finally {
      await h.cleanup();
    }
  });
});

describe("/metrics endpoint — short-circuit (D38 iter-1 M2 mandate)", () => {
  it("10 GETs to /metrics leave requests_total{route='metrics'} ABSENT", async () => {
    const h = await bootReadyServer();
    try {
      for (let i = 0; i < 10; i++) {
        const r = await fetch(h.handle.url + "/metrics");
        expect(r.status).toBe(200);
        await r.text();
      }
      const r = await fetch(h.handle.url + "/metrics");
      const body = await r.text();
      // No requests_total{route="metrics",...} line should appear.
      expect(body).not.toMatch(
        /copilot_proxy_requests_total\{[^}]*route="metrics"/,
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("/metrics endpoint — always-on gauges", () => {
  it("emits the 3 always-on gauges on first scrape", async () => {
    const h = await bootReadyServer();
    try {
      const r = await fetch(h.handle.url + "/metrics");
      const body = await r.text();
      expect(body).toContain("# TYPE copilot_proxy_token_status gauge");
      expect(body).toContain(
        "# TYPE copilot_proxy_process_uptime_seconds gauge",
      );
      expect(body).toContain(
        "# TYPE copilot_proxy_process_resident_memory_bytes gauge",
      );
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// M12.5 H1 — stream-metric label consistency
//
// Issue a streaming POST through the buildApp wiring with a mocked upstream
// returning an SSE response. Then scrape /metrics and assert ALL four metric
// families that get the `route` label use the SAME canonical label value
// (e.g. all `"messages"`); the inbound HTTP path label `"/v1/messages"` MUST
// NEVER appear in metric output.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Build an upstream Response whose body is a small SSE stream that closes
 * promptly. Used by the H1 label-consistency tests below to drive the
 * forwardStream metric path end-to-end.
 */
function makeStreamingUpstream(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller): void {
      controller.enqueue(enc.encode('data: {"hello":"world"}\n\n'));
      controller.enqueue(enc.encode('data: {"goodbye":"world"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function makeReadyTm(): Promise<{
  tm: TokenManager;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-proxy-met-h1-"));
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "stub",
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

function configWithLane(path: string, viaEndpoint: string): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: { method: "POST", path },
        body_rules: [],
        header_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: viaEndpoint,
          shape:
            viaEndpoint === "anthropic_messages"
              ? "anthropic_messages"
              : viaEndpoint === "openai_responses"
                ? "openai_responses"
                : "openai_chat",
        },
      },
    ],
  });
}

describe("/metrics endpoint — M12.5 H1 stream-metric label consistency", () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      makeStreamingUpstream()) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  async function streamThenScrape(
    inboundPath: string,
    viaEndpoint: string,
    model: string,
    expectedRouteLabel: string,
  ): Promise<void> {
    const { tm, cleanup } = await makeReadyTm();
    try {
      const app = buildApp(configWithLane(inboundPath, viaEndpoint), tm);
      // Issue the streaming POST. The mocked fetch returns an SSE upstream
      // → handler returns streamSSE(forwardStream(...)) → metrics emitted
      // with `route: ctxBase.metricRoute`.
      const streamResp = await app.request(inboundPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [] }),
      });
      expect(streamResp.status).toBe(200);
      // Drain the response body so forwardStream's read loop fully runs +
      // its `finally` block executes (releases the reader lock).
      await streamResp.text();
      // Now scrape /metrics via the same in-memory app.
      const metricsResp = await app.request("/metrics");
      const body = await metricsResp.text();

      // The wrapping middleware emits requests_total + inflight under the
      // clean route label. The stream forwarder emits response_bytes_total
      // + stream_events_total. ALL of these MUST carry `route="<expectedRouteLabel>"`.
      const goodLabelRe = new RegExp(`\\{[^}]*route="${expectedRouteLabel}"`);
      const badPathLabelRe = new RegExp(
        `\\{[^}]*route="${inboundPath.replace(/[/]/g, "\\/")}"`,
      );

      // Each family must have at least one line carrying the clean label.
      for (const family of [
        "copilot_proxy_requests_total",
        "copilot_proxy_response_bytes_total",
        "copilot_proxy_stream_events_total",
      ] as const) {
        const familyLines = body
          .split("\n")
          .filter((l) => l.startsWith(`${family}{`));
        expect(familyLines.length).toBeGreaterThanOrEqual(1);
        const cleanHit = familyLines.find((l) => goodLabelRe.test(l));
        expect(cleanHit).toBeDefined();
        // No line in this family may carry the inbound HTTP path as its
        // route label.
        for (const line of familyLines) {
          expect(badPathLabelRe.test(line)).toBe(false);
        }
      }

      // No metric line ANYWHERE in the body may carry the path label.
      const pathLabelMatches = body.match(badPathLabelRe);
      expect(pathLabelMatches).toBeNull();
    } finally {
      await cleanup();
    }
  }

  it("messages lane: requests_total + response_bytes_total + stream_events_total all carry route='messages'", async () => {
    await streamThenScrape(
      "/v1/messages",
      "anthropic_messages",
      "claude-opus-4.7",
      "messages",
    );
  });

  it("responses lane: stream metrics carry route='responses'", async () => {
    await streamThenScrape(
      "/responses",
      "openai_responses",
      "gpt-5.1",
      "responses",
    );
  });

  it("chat_completions lane: stream metrics carry route='chat_completions'", async () => {
    await streamThenScrape(
      "/chat/completions",
      "openai_chat_completions",
      "gpt-4o",
      "chat_completions",
    );
  });
});

// ---------------------------------------------------------------------------
// M12.5 H2 — inflight gauge tracks stream lifecycle
//
// Issue a streaming POST whose upstream holds the stream open for ≥500ms
// (one chunk emitted immediately to flush headers, second chunk delayed via
// setTimeout). Mid-stream: scrape /metrics, assert inflight=1. After the
// stream completes: scrape again, assert inflight=0.
// ---------------------------------------------------------------------------

describe("/metrics endpoint — M12.5 H2 inflight stream-lifecycle tracking", () => {
  beforeEach(() => {
    // Override fetch to return a slow upstream (500ms gap between chunks).
    globalThis.fetch = (async () => {
      const enc = new TextEncoder();
      let resolveSecond: (() => void) | null = null;
      const secondReady = new Promise<void>((r) => {
        resolveSecond = r;
      });
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(enc.encode('data: {"first":1}\n\n'));
          // Delay second chunk for 500ms so the stream is in-flight long
          // enough for the test to scrape /metrics mid-stream.
          setTimeout(() => {
            controller.enqueue(enc.encode('data: {"second":2}\n\n'));
            controller.close();
            resolveSecond?.();
          }, 500);
          // Hand `secondReady` to the test by stashing it on globalThis
          // (ad-hoc but contained to this test scope).
          (
            globalThis as unknown as { __h2_secondReady?: Promise<void> }
          ).__h2_secondReady = secondReady;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete (globalThis as unknown as { __h2_secondReady?: Promise<void> })
      .__h2_secondReady;
  });

  it("inflight_requests{route='messages'} >=1 mid-stream, ==0 after stream completes", async () => {
    const { tm, cleanup } = await makeReadyTm();
    try {
      const app = buildApp(
        configWithLane("/v1/messages", "anthropic_messages"),
        tm,
      );
      // Kick off the streaming request but don't await drain — start
      // reading the body, observe the first chunk, then peek metrics
      // mid-stream.
      const respPromise = app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4.7", messages: [] }),
      });
      const resp = await respPromise;
      expect(resp.status).toBe(200);
      if (resp.body === null) throw new Error("no body");
      const reader = resp.body.getReader();
      // Read the first chunk so we know the stream is in-flight (the
      // upstream's first enqueue has been forwarded).
      const first = await reader.read();
      expect(first.done).toBe(false);

      // Mid-stream scrape: forward-stream's `finally` has NOT fired yet
      // (upstream second chunk is still on the 500ms setTimeout),
      // metrics-middleware deferred ownership, so inflight should be >=1.
      const midScrape = await app.request("/metrics");
      const midBody = await midScrape.text();
      const midMatch = midBody.match(
        /^copilot_proxy_inflight_requests\{[^}]*route="messages"[^}]*\} (\d+)$/m,
      );
      expect(midMatch).not.toBeNull();
      const midValue = Number(midMatch?.[1] ?? "0");
      expect(midValue).toBeGreaterThanOrEqual(1);

      // Drain the rest of the stream (this triggers the second chunk +
      // upstream close → forward-stream's finally → recordStreamCompletion).
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      // Wait for the upstream's second-chunk timer to actually fire so
      // the forwarder's finally is guaranteed to have run.
      const secondReady = (
        globalThis as unknown as { __h2_secondReady?: Promise<void> }
      ).__h2_secondReady;
      if (secondReady !== undefined) await secondReady;
      // One more microtask flush so the finally block's metric writes
      // are observable to the next scrape.
      await new Promise<void>((r) => setTimeout(r, 10));

      // Post-stream scrape: forward-stream's finally has run →
      // inflight back to 0; requests_total{route='messages',status='200'}
      // recorded.
      const postScrape = await app.request("/metrics");
      const postBody = await postScrape.text();
      const postMatch = postBody.match(
        /^copilot_proxy_inflight_requests\{[^}]*route="messages"[^}]*\} (\d+)$/m,
      );
      expect(postMatch).not.toBeNull();
      const postValue = Number(postMatch?.[1] ?? "-1");
      expect(postValue).toBe(0);
      // requests_total emitted by forward-stream's finally.
      expect(postBody).toMatch(
        /copilot_proxy_requests_total\{[^}]*route="messages"[^}]*status="200"[^}]*\} 1/,
      );
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// M12.6 H1-NEW — null-body SSE inflight leak fix
//
// Pre-M12.6: when an upstream returned a Response with body === null AND
// Content-Type: text/event-stream, the wrapping withMetrics middleware
// deferred inflight decrement to forward-stream (M12.5 H2), but
// forward-stream's null-body early-return was OUTSIDE the
// try/finally that calls recordStreamCompletion. Result: inflight gauge
// permanently leaked +1 per null-body SSE response.
//
// This test fires 5 sequential null-body SSE GETs through the in-memory app
// then scrapes /metrics. Post-fix invariants:
//   - copilot_proxy_inflight_requests{route="messages"} === 0
//     (or the line is absent — both mean zero leak).
//   - copilot_proxy_requests_total{route="messages",status="200"} === 5.
// ---------------------------------------------------------------------------

describe("/metrics endpoint — M12.6 H1-NEW null-body inflight leak fix", () => {
  beforeEach(() => {
    // Override fetch to return an SSE-Content-Type Response with body=null.
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("5 sequential null-body SSE GETs leave inflight=0 and requests_total=5", async () => {
    const { tm, cleanup } = await makeReadyTm();
    try {
      const app = buildApp(
        configWithLane("/v1/messages", "anthropic_messages"),
        tm,
      );
      for (let i = 0; i < 5; i++) {
        const resp = await app.request("/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-4.7", messages: [] }),
        });
        expect(resp.status).toBe(200);
        // Drain — stream callback runs synchronously to its outer finally.
        await resp.text();
      }
      const scrape = await app.request("/metrics");
      const body = await scrape.text();
      // Inflight gauge: either absent (never written) or zero. Pre-fix
      // would show 5 (one leak per request).
      const inflightMatch = body.match(
        /^copilot_proxy_inflight_requests\{[^}]*route="messages"[^}]*\} (\d+)$/m,
      );
      const inflightValue =
        inflightMatch === null ? 0 : Number(inflightMatch[1] ?? "-1");
      expect(inflightValue).toBe(0);
      // requests_total must be exactly 5 (forward-stream's outer finally
      // fires for each null-body call).
      const totalMatch = body.match(
        /^copilot_proxy_requests_total\{[^}]*route="messages"[^}]*status="200"[^}]*\} (\d+)$/m,
      );
      expect(totalMatch).not.toBeNull();
      const totalValue = Number(totalMatch?.[1] ?? "-1");
      expect(totalValue).toBe(5);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-OK SSE error inflight leak fix
//
// When the upstream returns a non-OK status (e.g. 400) AND
// Content-Type: text/event-stream, the service layer throws HTTPError and
// the handler returns `forwardError`, which forwards the upstream headers
// (including the text/event-stream content-type) and returns a fully
// BUFFERED error body — it never enters the live-stream lane in
// forward-stream.ts.
//
// Pre-fix: the withMetrics middleware classified the buffered error as a
// live stream (content-type substring match only) and deferred the
// inflight decrement + requests_total to a forward-stream `finally` that
// never runs → permanent +1 inflight leak per non-OK SSE error and a
// dropped requests_total sample.
//
// Post-fix: isStreamResponse requires a 2xx status, so the wrapper owns
// the decrement for non-OK SSE errors. Invariants after 5 sequential
// 400-SSE POSTs:
//   - copilot_proxy_inflight_requests{route="messages"} === 0
//   - copilot_proxy_requests_total{route="messages",status="400"} === 5
// ---------------------------------------------------------------------------

describe("/metrics endpoint — non-OK SSE error inflight leak fix", () => {
  beforeEach(() => {
    // Override fetch to return a 400 error whose content-type is
    // text/event-stream (the shape that used to fool the stream classifier).
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"bad request"}}', {
        status: 400,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("5 sequential 400-SSE POSTs leave inflight=0 and requests_total{status='400'}=5", async () => {
    const { tm, cleanup } = await makeReadyTm();
    try {
      const app = buildApp(
        configWithLane("/v1/messages", "anthropic_messages"),
        tm,
      );
      for (let i = 0; i < 5; i++) {
        const resp = await app.request("/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-4.7", messages: [] }),
        });
        // forwardError surfaces the upstream status verbatim.
        expect(resp.status).toBe(400);
        // Drain the buffered error body.
        await resp.text();
      }
      const scrape = await app.request("/metrics");
      const body = await scrape.text();
      // Inflight gauge: absent (never written) or zero. Pre-fix would
      // show 5 (one leak per non-OK SSE error).
      const inflightMatch = body.match(
        /^copilot_proxy_inflight_requests\{[^}]*route="messages"[^}]*\} (\d+)$/m,
      );
      const inflightValue =
        inflightMatch === null ? 0 : Number(inflightMatch[1] ?? "-1");
      expect(inflightValue).toBe(0);
      // requests_total for the error status must be exactly 5 (the wrapper
      // owns the increment now that the buffered error is not deferred).
      const totalMatch = body.match(
        /^copilot_proxy_requests_total\{[^}]*route="messages"[^}]*status="400"[^}]*\} (\d+)$/m,
      );
      expect(totalMatch).not.toBeNull();
      const totalValue = Number(totalMatch?.[1] ?? "-1");
      expect(totalValue).toBe(5);
    } finally {
      await cleanup();
    }
  });
});
