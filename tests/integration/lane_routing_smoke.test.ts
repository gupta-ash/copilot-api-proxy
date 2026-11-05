/**
 * lane_routing_smoke.test.ts — M11 D-LOCK-4b routing-correctness coverage
 * for the 2 PATH_MATRIX-zero-evidence lanes (Lane 3 + Lane 6).
 *
 * **Why NOT replay fixtures (per D-LOCK-4b).** Lanes 3 + 6 have ZERO
 * captured upstream-SSE evidence in PATH_MATRIX. Both are passthrough /
 * redirect lanes with NO event translation — a synthesized replay
 * fixture would produce `expected_client.sse == upstream.sse` byte-for-
 * byte regardless of whether the route fired correctly. The replay test
 * would assert nothing meaningful (it cannot observe the redirect's
 * effect on the upstream REQUEST). Routing-correctness tests use a
 * different harness — mock `globalThis.fetch` + assert request URL/body/
 * headers — that DOES verify the lane wiring.
 *
 * **Tests:**
 *   1. Lane 3 (`/chat/completions × ^gpt-4` native passthrough): inbound
 *      request reaches upstream `/chat/completions` with body byte-equal
 *      to input (no body rules fire); Authorization header carries Bearer.
 *   2. Lane 6 (`/responses × ^gpt-4` defensive redirect): inbound request
 *      reaches upstream `/chat/completions` (NOT `/responses`) per
 *      `redirect_to_chat_completions` body rule; request body retains
 *      the `input` field unmodified (defensive redirect re-targets the
 *      path, NOT translating the body).
 *   3. Lane 2 as shipped in `config/default.yaml` (`/responses × ^gpt-[56]`):
 *      gpt-5-mini and gpt-6-sol reach upstream `/responses` through
 *      route-driven dispatch (no redirect marker), and `service_tier` is
 *      stripped from the egress body with every other key preserved.
 *   4. Lane 4 as shipped in `config/default.yaml` (`/v1/messages × ^gpt-[56]`):
 *      gpt-6-sol and gpt-5-mini reach upstream `/responses` with a translated
 *      Responses-shape body (`input[]`, no Anthropic `messages`).
 *   5. Lanes 1-4 as shipped: the egress `x-github-api-version` is the
 *      `2026-07-01` each lane's `inject_copilot_static_headers` rule sets.
 *
 * **Coverage gap acknowledged.** These tests verify ROUTING (the redirect
 * dispatches to the right upstream path) but NOT END-TO-END SHAPE PARITY
 * (because no captured Lane 3/6 flows exist as the parity reference).
 * M13 raw-log + auto-fix-config CLI is the natural follow-up if a future
 * client surfaces Lane 3/6 traffic and reveals an upstream-shape mismatch.
 *
 * **Style template:** mirrors `tests/integration/redirect_to_responses_dispatch.test.ts`
 * (the M9 dispatcher pattern: `beforeEach ensureRulesRegistered`, build
 * Hono Context + Config from default-yaml-style routes, mock
 * `globalThis.fetch` to capture the upstream Request, assert URL +
 * body shape).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { register } from "../../src/lib/transform/registry.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

// Side-effect imports — ensure marker-setting + response-passthrough
// rules are registered before the defensive re-registration runs. The barrel
// registers every rule `config/default.yaml` uses, so it zod-parses.
import "../../src/lib/transform/index.ts";
import "../../src/lib/transform/redirect_to_chat_completions.ts";
import "../../src/lib/transform/response_passthrough_openai_chat_completions.ts";

// ---------------------------------------------------------------------------
// Defensive re-registration (per D-LOCK-11).
// ---------------------------------------------------------------------------

/**
 * Re-register the Lane 3 + Lane 6 rules with `allow_override: true` so
 * the test is idempotent across test-suite ordering. ESM-import side-
 * effect cannot re-fire on subsequent imports (module cache); explicit
 * register() handles both cold-start (registry empty) and warm-start
 * (already registered by side-effect import).
 *
 * Pattern matches `tests/integration/redirect_to_responses_dispatch.test.ts:64-142`.
 */
async function ensureRulesRegistered(): Promise<void> {
  const m1 =
    await import("../../src/lib/transform/redirect_to_chat_completions.ts");
  register(
    "redirect_to_chat_completions",
    m1.redirect_to_chat_completions,
    m1.RedirectToChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m2 =
    await import("../../src/lib/transform/response_passthrough_openai_chat_completions.ts");
  register(
    "response_passthrough_openai_chat_completions",
    m2.response_passthrough_openai_chat_completions,
    m2.ResponsePassthroughOpenaiChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
}

// ---------------------------------------------------------------------------
// TokenManager test factory (mirrors redirect_to_responses_dispatch.test.ts).
// ---------------------------------------------------------------------------

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-lrs-"));
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

// ---------------------------------------------------------------------------
// Fetch mocking — capture upstream URL + body + headers.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];

beforeEach(async () => {
  fetchCalls = [];
  const stubFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    fetchCalls.push({ url: input.toString(), init });
    // NON-streaming: application/json content-type so byte-forward path is
    // bypassed (mirrors redirect_to_responses_dispatch.test.ts pattern).
    return new Response('{"id":"upstream-stub"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  await ensureRulesRegistered();
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Test config helpers.
// ---------------------------------------------------------------------------

/**
 * Build a config with the Lane 3 native passthrough wired:
 *   - Inbound /chat/completions for ^gpt-4 → no body rules → upstream
 *     /chat/completions (verbatim) with response_passthrough_openai_chat_completions.
 */
function configLane3Native(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/chat/completions",
          model_pattern: "^gpt-4",
        },
        body_rules: [],
        header_rules: [],
        response_rules: [
          {
            name: "lane3_consume_chat",
            use: "response_passthrough_openai_chat_completions",
          },
        ],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_chat_completions",
          shape: "openai_chat",
        },
      },
    ],
  });
}

/**
 * Build a config with the Lane 6 defensive redirect wired:
 *   - Inbound /responses for ^gpt-4 → body rule
 *     redirect_to_chat_completions → upstream /chat/completions.
 */
function configLane6DefensiveRedirect(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/responses",
          model_pattern: "^gpt-4",
        },
        body_rules: [
          {
            name: "lane6_defensive_redirect",
            use: "redirect_to_chat_completions",
          },
        ],
        header_rules: [],
        response_rules: [
          {
            name: "lane6_consume_chat",
            use: "response_passthrough_openai_chat_completions",
          },
        ],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_chat_completions",
          shape: "openai_chat",
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Lane 3 — native /chat/completions × ^gpt-4 (no body rules; passthrough).
// ---------------------------------------------------------------------------

describe("Lane 3 routing — /chat/completions × ^gpt-4 native passthrough (M11 D-LOCK-4b)", () => {
  it("dispatches to upstream /chat/completions with body byte-equal to input + Bearer auth", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(configLane3Native(), tm);
    const inboundBody = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    };
    const r = await app.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inboundBody),
    });
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    // Lane 3: upstream URL ends with /chat/completions (NOT /responses,
    // NOT /v1/messages). The default copilot_enterprise endpoint path
    // for openai_chat_completions is /chat/completions per
    // EndpointsSectionSchema.default() + UpstreamsSectionSchema.default().
    expect(last?.url).toContain("/chat/completions");
    expect(last?.url).not.toContain("/responses");
    expect(last?.url).not.toContain("/v1/messages");
    // Body byte-equal to input (no body rules fired — passthrough).
    const sentBody =
      last?.init?.body === undefined ? "" : String(last.init.body);
    expect(sentBody).toBe(JSON.stringify(inboundBody));
    // Authorization header carries a Bearer token (the stub copilot
    // token from TokenManager); copilotHeaders sets it.
    const sentHeaders = last?.init?.headers as
      | Record<string, string>
      | undefined;
    const auth =
      sentHeaders === undefined
        ? ""
        : (sentHeaders["authorization"] ?? sentHeaders["Authorization"] ?? "");
    expect(auth.toLowerCase()).toContain("bearer");
    tm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Lane 6 — /responses × ^gpt-4 defensive redirect → /chat/completions.
// ---------------------------------------------------------------------------

describe("Lane 6 routing — /responses × ^gpt-4 defensive redirect (M11 D-LOCK-4b)", () => {
  it("redirect_to_chat_completions sends the request to upstream /chat/completions (NOT /responses); body retains 'input' field unmodified", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(configLane6DefensiveRedirect(), tm);
    const inboundBody = { model: "gpt-4o-mini", input: "hi" };
    const r = await app.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inboundBody),
    });
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    // Lane 6: defensive redirect MUST land on /chat/completions, NOT
    // /responses. This proves the marker dispatch overrode the inbound-
    // path-based dispatch.
    expect(last?.url).toContain("/chat/completions");
    expect(last?.url).not.toContain("/responses");
    // Body retains `input` field unmodified — the defensive redirect
    // ONLY re-targets the upstream path; it does NOT translate the body
    // shape (Responses-shape body forwarded to /chat/completions
    // upstream as-is per D8 + D37 final scope; future M13 may add an
    // optional translator). Verify by parsing the captured body.
    const sentBody =
      last?.init?.body === undefined ? "" : String(last.init.body);
    const parsed = JSON.parse(sentBody) as Record<string, unknown>;
    expect(parsed["input"]).toBe("hi");
    expect(parsed["model"]).toBe("gpt-4o-mini");
    // Response Content-Type matches the mock's content-type.
    expect(r.headers.get("content-type")).toContain("application/json");
    tm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Lane 2 as shipped — config/default.yaml, /responses × ^gpt-[56].
// ---------------------------------------------------------------------------

const DEFAULT_YAML_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "default.yaml",
);

function loadDefaultConfig(): Config {
  const text = readFileSync(DEFAULT_YAML_PATH, "utf-8");
  return ConfigSchema.parse(YAML.parse(text) as unknown);
}

/** POST `inboundPath` against the shipped config; returns status + sole egress. */
async function postDefault(
  inboundPath: string,
  inboundBody: Record<string, unknown>,
): Promise<{
  status: number;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}> {
  const tm = await makeReadyManagerStarted();
  const app = buildApp(loadDefaultConfig(), tm);
  const r = await app.request(inboundPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inboundBody),
  });
  tm.dispose();
  expect(fetchCalls).toHaveLength(1);
  const call = fetchCalls[0]!;
  const raw = (call.init?.headers ?? {}) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
  return {
    status: r.status,
    pathname: new URL(call.url).pathname,
    headers,
    body: call.init?.body === undefined ? "" : String(call.init.body),
  };
}

describe("Lane 2 routing — config/default.yaml /responses × ^gpt-[56] (route-driven dispatch)", () => {
  it("gpt-5-mini (no dot after the 5) reaches upstream /responses with 200", async () => {
    const out = await postDefault("/responses", {
      model: "gpt-5-mini",
      input: "hi",
    });
    expect(out.status).toBe(200);
    expect(out.pathname).toBe("/responses");
  });

  it("gpt-6-sol reaches upstream /responses and carries NO x-proxy-redirect-to marker", async () => {
    const out = await postDefault("/responses", {
      model: "gpt-6-sol",
      input: "hi",
    });
    expect(out.status).toBe(200);
    expect(out.pathname).toBe("/responses");
    expect(out.headers["x-proxy-redirect-to"]).toBeUndefined();
  });

  for (const model of ["gpt-5.6-sol", "gpt-6-sol"]) {
    it(`${model} with service_tier "priority" egresses with NO service_tier key; every other key byte-preserved`, async () => {
      const kept = {
        model,
        input: "hi",
        reasoning: { effort: "high" },
        stream: false,
      };
      const out = await postDefault("/responses", {
        model: kept.model,
        input: kept.input,
        service_tier: "priority",
        reasoning: kept.reasoning,
        stream: kept.stream,
      });
      expect(out.status).toBe(200);
      expect(out.pathname).toBe("/responses");
      expect(Object.keys(JSON.parse(out.body) as object)).not.toContain(
        "service_tier",
      );
      expect(out.body).toBe(JSON.stringify(kept));
    });
  }
});

// ---------------------------------------------------------------------------
// Lane 4 as shipped — config/default.yaml, /v1/messages × ^gpt-[56].
// ---------------------------------------------------------------------------

describe("Lane 4 routing — config/default.yaml /v1/messages × ^gpt-[56] (Anthropic → Responses)", () => {
  // gpt-5-mini has no dot after the 5, so the old `^gpt-5\.` pattern missed it
  // as well as the gpt-6 family: both 404'd no_route with zero egress.
  for (const model of ["gpt-6-sol", "gpt-5-mini"]) {
    it(`${model} egresses to upstream /responses with a translated Responses-shape body`, async () => {
      const out = await postDefault("/v1/messages", {
        model,
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(out.status).toBe(200);
      expect(out.pathname).toBe("/responses");
      const sent = JSON.parse(out.body) as Record<string, unknown>;
      expect(sent["model"]).toBe(model);
      expect(Array.isArray(sent["input"])).toBe(true);
      expect(sent["max_output_tokens"]).toBe(64);
      expect(Object.keys(sent)).not.toContain("messages");
      expect(Object.keys(sent)).not.toContain("max_tokens");
    });
  }
});

// ---------------------------------------------------------------------------
// Lanes 1-4 as shipped — egress x-github-api-version.
// ---------------------------------------------------------------------------

describe("config/default.yaml egress x-github-api-version on Lanes 1-4", () => {
  // Each lane's inject_copilot_static_headers rule overrides the code default
  // (`API_VERSION` in src/auth/api-config.ts), so a lane whose rule drifts or
  // disappears egresses a different value.
  const lanes = [
    {
      lane: 1,
      inboundPath: "/v1/messages",
      body: {
        model: "claude-sonnet-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      },
      egressPath: "/v1/messages",
    },
    {
      lane: 2,
      inboundPath: "/responses",
      body: { model: "gpt-6-sol", input: "hi" },
      egressPath: "/responses",
    },
    {
      lane: 3,
      inboundPath: "/chat/completions",
      body: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      },
      egressPath: "/chat/completions",
    },
    {
      lane: 4,
      inboundPath: "/v1/messages",
      body: {
        model: "gpt-6-sol",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
      egressPath: "/responses",
    },
  ];
  for (const { lane, inboundPath, body, egressPath } of lanes) {
    it(`Lane ${lane} (${inboundPath} × ${body.model}) egresses x-github-api-version: 2026-07-01`, async () => {
      const out = await postDefault(inboundPath, body);
      expect(out.status).toBe(200);
      expect(out.pathname).toBe(egressPath);
      expect(out.headers["x-github-api-version"]).toBe("2026-07-01");
    });
  }
});
