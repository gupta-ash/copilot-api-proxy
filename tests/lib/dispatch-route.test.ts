/**
 * dispatch-route.test.ts — `dispatchRoute` (routes/_shared/dispatcher.ts).
 *
 * The matched route alone picks the upstream: `upstream.shape` selects the
 * service, `upstreams[via].paths[via_endpoint]` supplies the path. Routes here
 * use a second upstream service `alt` with non-default paths, so a lookup that
 * ignored `via` (e.g. hardcoded `copilot_enterprise`) or `via_endpoint` would
 * egress to a different path and fail the assertion.
 *
 * Observable per shape through a stubbed `globalThis.fetch` (the pattern in
 * `tests/integration/lane_routing_smoke.test.ts`): the egress URL path, and for
 * `anthropic_messages` the `config.anthropic_beta.deny` egress guard. The two
 * OpenAI-shape services build byte-identical requests, so on the wire they
 * differ only by the path the route resolves to.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { TokenManager } from "~/auth/token-manager.ts";
import type { TransformContext } from "~/lib/transform/types.ts";
import { dispatchRoute } from "~/routes/_shared/dispatcher.ts";
import type { MarkerDispatchDeps } from "~/routes/_shared/marker-dispatch.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";

const KEPT_BETA = "kept-beta-2025-01-01";
const DENIED_BETA = "denied-beta-2026-01-01";

const ALT_PATHS = {
  anthropic_messages: "/alt/messages",
  openai_responses: "/alt/responses",
  openai_chat_completions: "/alt/chat",
} as const;

/** One route per upstream shape, all via the non-default `alt` service. */
function makeConfig(): Config {
  const route = (
    path: string,
    viaEndpoint: keyof typeof ALT_PATHS,
    shape: string,
  ): unknown => ({
    match: { method: "POST", path },
    upstream: { via: "alt", via_endpoint: viaEndpoint, shape },
  });
  return ConfigSchema.parse({
    routes: [
      route("/v1/messages", "anthropic_messages", "anthropic_messages"),
      route("/responses", "openai_responses", "openai_responses"),
      route("/chat/completions", "openai_chat_completions", "openai_chat"),
    ],
    upstreams: {
      copilot_enterprise: {
        paths: {
          anthropic_messages: "/v1/messages",
          openai_responses: "/responses",
          openai_chat_completions: "/chat/completions",
          embeddings: "/embeddings",
          models: "/models",
        },
      },
      alt: { paths: { ...ALT_PATHS } },
    },
    anthropic_beta: { deny: [DENIED_BETA] },
  });
}

async function makeReadyManagerStarted(): Promise<TokenManager> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-dr-"));
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

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let tm: TokenManager;

beforeAll(async () => {
  tm = await makeReadyManagerStarted();
});
afterAll(() => {
  tm.dispose();
});

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

function makeDeps(config: Config): MarkerDispatchDeps {
  return {
    config,
    copilotToken: "stub-copilot-token",
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    tokenManager: tm,
  };
}

function makeCtx(route: string, model: string): TransformContext {
  return {
    body: { model, input: "hi" },
    headers: { "anthropic-beta": `${KEPT_BETA}, ${DENIED_BETA}` },
    route,
    model,
  };
}

/** The single captured egress call: URL pathname + lowercase-keyed headers. */
function onlyEgress(): { pathname: string; headers: Record<string, string> } {
  expect(fetchCalls).toHaveLength(1);
  const call = fetchCalls[0]!;
  const raw = (call.init?.headers ?? {}) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
  return { pathname: new URL(call.url).pathname, headers };
}

describe("dispatchRoute — upstream chosen by the matched route", () => {
  it("anthropic_messages → upstreams.alt.paths.anthropic_messages, with anthropic_beta.deny stripped at egress", async () => {
    const config = makeConfig();
    const r = await dispatchRoute(
      config.routes[0]!,
      makeCtx("/v1/messages", "claude-opus-4.7"),
      makeDeps(config),
    );
    expect(r.status).toBe(200);
    const egress = onlyEgress();
    expect(egress.pathname).toBe(ALT_PATHS.anthropic_messages);
    expect(egress.headers["anthropic-beta"]).toBe(KEPT_BETA);
  });

  it("openai_responses → upstreams.alt.paths.openai_responses", async () => {
    const config = makeConfig();
    const r = await dispatchRoute(
      config.routes[1]!,
      makeCtx("/responses", "gpt-5-mini"),
      makeDeps(config),
    );
    expect(r.status).toBe(200);
    expect(onlyEgress().pathname).toBe(ALT_PATHS.openai_responses);
  });

  it("openai_chat → upstreams.alt.paths.openai_chat_completions", async () => {
    const config = makeConfig();
    const r = await dispatchRoute(
      config.routes[2]!,
      makeCtx("/chat/completions", "gpt-4o-mini"),
      makeDeps(config),
    );
    expect(r.status).toBe(200);
    expect(onlyEgress().pathname).toBe(ALT_PATHS.openai_chat_completions);
  });

  it("throws, naming via and via_endpoint, when upstreams[via].paths[via_endpoint] does not resolve; nothing egresses", async () => {
    const config = makeConfig();
    const base = config.routes[1]!;
    const unresolvable = {
      ...base,
      upstream: { ...base.upstream, via_endpoint: "missing_endpoint" },
    };
    await expect(
      dispatchRoute(
        unresolvable,
        makeCtx("/responses", "gpt-5-mini"),
        makeDeps(config),
      ),
    ).rejects.toThrow("via='alt' via_endpoint='missing_endpoint'");
    expect(fetchCalls).toHaveLength(0);
  });
});
