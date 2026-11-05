/**
 * dispatch_no_upstream.test.ts — F159: a HEADER-PHASE failure is counted, and
 * it is counted on NEITHER first-byte series.
 *
 * **Why this needs the full app rather than a forwarder harness.** The whole
 * point of the population is that it never reaches the forwarder. A request
 * whose upstream header phase fails returns from the handler's dispatch
 * `catch` arm, so no `StreamCtxBase` is ever built and
 * `observeStreamHistograms` never runs — which is precisely why
 * `copilot_proxy_stream_no_first_byte_total` cannot see it either (that counter
 * counts streams that STARTED). Only a request driven through `buildApp` with
 * `globalThis.fetch` stubbed exercises the path.
 *
 * `_retry.ts` calls bare `fetch(...)`, so the stub is reached. The
 * `TokenManager` takes an injected `fetchCopilotToken`, so stubbing the global
 * does not disturb auth.
 *
 * The `timeout` / `client_abort` pair additionally PINS the runtime's
 * abort-reason propagation through `AbortSignal.any` — if Bun ever deviates
 * from the spec here, this test fails rather than the metric quietly lying.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { getValueForTests, resetForTests } from "../../src/lib/metrics.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

const MODEL = "claude-test";

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-dnu-"));
  const ghpath = path.join(dir, "github_token");
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

/** Lane 1 — `/v1/messages` × `^claude-` native Anthropic passthrough. */
function configAnthropicLane(): Config {
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
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

const ORIGINAL_FETCH = globalThis.fetch;

/** What the stubbed upstream does: reject with this, or resolve with that. */
let rejectWith: unknown;
let resolveWith: Response | undefined;

beforeEach(() => {
  resetForTests();
  rejectWith = undefined;
  resolveWith = undefined;
  globalThis.fetch = (async (): Promise<Response> => {
    if (resolveWith !== undefined) return resolveWith;
    throw rejectWith;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetForTests();
});

/** Drive one STREAMING `/v1/messages` request through the whole app. */
async function driveStreamingRequest(): Promise<Response> {
  const tm = await makeReadyManagerStarted();
  try {
    const app = buildApp(configAnthropicLane(), tm);
    return await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  } finally {
    tm.dispose();
  }
}

function noUpstreamCount(reason: string): number | undefined {
  return getValueForTests("copilot_proxy_dispatch_no_upstream_total", {
    route: "messages",
    model: MODEL,
    reason,
  });
}

/**
 * The exclusion the counter exists for: this request contributed to NO
 * first-byte distribution and to NO stream-level counter, on either label
 * spelling. Asserted on every case so a partial fix cannot pass one reason and
 * fail silently on the rest.
 */
function assertInvisibleToStreamMetrics(): void {
  expect(
    getValueForTests("copilot_proxy_dispatch_first_byte_seconds_count", {
      route: "messages",
      model: MODEL,
    }),
  ).toBeUndefined();
  expect(
    getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
      route: "messages",
      model: MODEL,
    }),
  ).toBeUndefined();
  expect(
    getValueForTests("copilot_proxy_stream_no_first_byte_total", {
      route: "messages",
      model: MODEL,
    }),
  ).toBeUndefined();
}

describe("F159 dispatch_no_upstream — the header-phase population", () => {
  it("a 20-minute upstream hang lands on reason=timeout", async () => {
    // What `AbortSignal.timeout(1_200_000)` produces when the deadline fires.
    rejectWith = new DOMException("The operation timed out.", "TimeoutError");
    const r = await driveStreamingRequest();

    expect(r.ok).toBe(false);
    expect(noUpstreamCount("timeout")).toBe(1);
    assertInvisibleToStreamMetrics();
  });

  it("a client that gave up first lands on reason=client_abort", async () => {
    rejectWith = new DOMException("The operation was aborted.", "AbortError");
    const r = await driveStreamingRequest();

    expect(r.ok).toBe(false);
    // Collapsing this into "timeout" would erase the distinction between
    // "upstream never answered" and "the client stopped waiting" — the one the
    // end-to-end origin exists to expose.
    expect(noUpstreamCount("client_abort")).toBe(1);
    expect(noUpstreamCount("timeout")).toBeUndefined();
    assertInvisibleToStreamMetrics();
  });

  it("a non-OK upstream lands on reason=upstream_status", async () => {
    // `createAnthropicMessages` throws HTTPError on any non-OK response. 500
    // rather than 401, which `fetchWithLayerBRetry` would refresh-and-retry.
    resolveWith = new Response('{"error":"upstream boom"}', {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const r = await driveStreamingRequest();

    expect(r.ok).toBe(false);
    expect(noUpstreamCount("upstream_status")).toBe(1);
    assertInvisibleToStreamMetrics();
  });

  it("a pre-dispatch 404 is NOT counted — it never opened an upstream", async () => {
    // No route matches `gpt-4o`, so the handler returns 404 before the dispatch
    // try block. Counting it would inflate the denominator with requests that
    // never attempted a stream; it stays visible on requests_total instead.
    rejectWith = new DOMException("should not be reached", "TimeoutError");
    const tm = await makeReadyManagerStarted();
    try {
      const app = buildApp(configAnthropicLane(), tm);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(404);
    } finally {
      tm.dispose();
    }
    expect(
      getValueForTests("copilot_proxy_dispatch_no_upstream_total", {
        route: "messages",
        model: "gpt-4o",
        reason: "timeout",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "404",
      }),
    ).toBe(1);
  });
});
