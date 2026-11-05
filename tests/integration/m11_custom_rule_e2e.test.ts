/**
 * Synthetic request through the real handler with a mocked upstream verifies
 * opt-in custom-rule loading and billing-header removal. Import the fixture
 * only after loadCustomRules so its self-registration remains observable.
 * The dedicated fixture subdirectory isolates it from other plugin examples.
 */

import { resolve } from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { loadCustomRules } from "../../src/lib/transform/custom-loader.ts";
import {
  list,
  register,
  type RegisteredRuleOpts,
} from "../../src/lib/transform/registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "../../src/lib/transform/types.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

// Side-effect import: ensure response_passthrough_anthropic_v1_messages
// is registered (validates lane wiring).
import "../../src/lib/transform/response_passthrough_anthropic_v1_messages.ts";

// ---------------------------------------------------------------------------
// Fixture path. See "Fixture location deviation" header comment.
// ---------------------------------------------------------------------------

const CUSTOM_RULES_DIR = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "custom-rules",
  "m11_strip_billing",
);

// ---------------------------------------------------------------------------
// Symbols populated by the dynamic import in `beforeAll` (after
// loadCustomRules runs). Static `import` of strip_billing_header_sample.ts
// would trigger the H2 ESM-cache bug. Declared at module scope so
// beforeEach can re-register them.
// ---------------------------------------------------------------------------

let stripBillingHeader: TransformFn | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StripBillingHeaderSchema: any = null;

// ---------------------------------------------------------------------------
// beforeAll — load the custom rule via the M9 lazy-loader, then dynamic-
// import to obtain symbols for D-LOCK-11 re-registration.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const result = await loadCustomRules(CUSTOM_RULES_DIR);
  // C3: LoadResult has exactly two fields — `loaded` and `skipped` (NO
  // `errors` field; failures land in `skipped` with `reason` set).
  expect(result.skipped).toEqual([]);
  expect(result.loaded.length).toBe(1);
  // The lane.json in the same dir is filtered before import attempt
  // (loader's `*.ts` filter at custom-loader.ts:157); it does NOT
  // appear in skipped[].
  expect(result.loaded[0]?.endsWith("strip_billing_header_sample.ts")).toBe(
    true,
  );
  // Self-registration landed in the body registry.
  expect(list("body")).toContain("strip_billing_header_sample");

  // AFTER loadCustomRules, dynamic-import to obtain symbols. ESM
  // module-cache returns the same module instance the loader
  // dynamic-imported; NO additional register side effect fires (rule
  // already registered).
  const mod =
    await import("../fixtures/custom-rules/m11_strip_billing/strip_billing_header_sample.ts");
  stripBillingHeader = mod.stripBillingHeader as TransformFn;
  StripBillingHeaderSchema = mod.StripBillingHeaderSchema;
});

// ---------------------------------------------------------------------------
// beforeEach — defensive re-registration per D-LOCK-11 (allow_override:true
// idempotent across suite ordering).
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (stripBillingHeader === null) {
    throw new Error(
      "custom_rule_e2e: stripBillingHeader symbol not populated; beforeAll did not run",
    );
  }
  const opts: RegisteredRuleOpts = {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
    version: ">=1.0.0",
    allow_override: true,
  };
  register(
    "strip_billing_header_sample",
    stripBillingHeader,
    StripBillingHeaderSchema,
    opts,
  );
  // Defensive re-registration of dependencies — per D-LOCK-11. Other test
  // files (notably custom_loader.test.ts) call resetRegistry() in afterEach,
  // and ESM-import side-effects cannot re-fire on cached modules. Without
  // these re-registrations, the test config's
  // `response_passthrough_anthropic_v1_messages` rule reference would fail
  // zod validation under suite-ordered execution.
  const m4 =
    await import("../../src/lib/transform/response_passthrough_anthropic_v1_messages.ts");
  register(
    "response_passthrough_anthropic_v1_messages",
    m4.response_passthrough_anthropic_v1_messages,
    m4.ResponsePassthroughAnthropicV1MessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
});

// ---------------------------------------------------------------------------
// TokenManager test factory.
// ---------------------------------------------------------------------------

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-cre-"));
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
// Fetch mocking — capture upstream request body to verify the rule's body
// mutation reaches the wire.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
  const stubFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (
      initHeaders !== undefined &&
      typeof initHeaders === "object" &&
      !Array.isArray(initHeaders) &&
      !(initHeaders instanceof Headers)
    ) {
      for (const [k, v] of Object.entries(
        initHeaders as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
    }
    fetchCalls.push({
      url: input.toString(),
      body: init?.body === undefined ? "" : String(init.body),
      headers,
    });
    return new Response('{"id":"upstream-stub","content":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = stubFetch as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Test config — Lane 1 native passthrough on /v1/messages × ^claude- with
// the custom rule wired in body_rules.
// ---------------------------------------------------------------------------

function configCustomRuleLane(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        body_rules: [
          {
            name: "custom_strip_billing",
            use: "strip_billing_header_sample",
          },
        ],
        header_rules: [],
        response_rules: [
          {
            name: "consume_anthropic",
            use: "response_passthrough_anthropic_v1_messages",
          },
        ],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("M11 D-LOCK-7 — drop-in custom rule end-to-end", () => {
  it("loadCustomRules registered the rule and the symbol round-trip works", () => {
    // Sanity check — re-asserts the beforeAll outcome from a per-test
    // perspective (would catch suite-ordering registry-reset regressions).
    expect(list("body")).toContain("strip_billing_header_sample");
    expect(stripBillingHeader).not.toBeNull();
  });

  it("rule fires on a wire request and strips matching system[*] blocks from the upstream body", async () => {
    const tm = await makeReadyManagerStarted();
    const app = buildApp(configCustomRuleLane(), tm);
    const inboundBody = {
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "You are Claude." },
        {
          type: "text",
          text: "x-anthropic-billing-header: synthetic-public-example",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    const r = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inboundBody),
    });
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const last = fetchCalls[fetchCalls.length - 1];
    expect(last?.url).toContain("/v1/messages");
    // Parse the captured upstream body and verify the billing-header
    // system block was stripped (the custom rule mutated ctx.body).
    const parsed = JSON.parse(last?.body ?? "{}") as {
      system?: Array<{ type: string; text: string }>;
      messages?: unknown;
    };
    expect(parsed.system).toBeDefined();
    expect(parsed.system?.length).toBe(1);
    expect(parsed.system?.[0]?.text).toBe("You are Claude.");
    // Rest of the body preserved.
    expect(parsed.messages).toEqual([{ role: "user", content: "hello" }]);
    tm.dispose();
  });

  it("rule returns applied:false when the body has no system array (predicate path)", () => {
    if (stripBillingHeader === null) {
      throw new Error("stripBillingHeader not populated");
    }
    const ctx: TransformContext = {
      body: { model: "claude-sonnet-4-6", messages: [] },
      headers: {},
      route: "/v1/messages",
      model: "claude-sonnet-4-6",
    };
    const result = stripBillingHeader(ctx, {}) as TransformResult;
    expect(result.applied).toBe(false);
    expect(result.ctx).toBe(ctx);
  });
});
