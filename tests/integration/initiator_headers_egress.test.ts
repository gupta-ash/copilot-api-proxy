/**
 * initiator_headers_egress.test.ts — WIRE-level proof for the x-initiator /
 * x-interaction-type pair (Copilot client fidelity).
 *
 * **What this proves that `initiator_headers_apply.test.ts` cannot.** That
 * test stops at `applyRules` and asserts on `result.ctx.headers` — the
 * transform engine's in-memory dict. Between there and the socket the request
 * still passes through THREE more mutations inside
 * `services/copilot/create-anthropic-messages.ts § buildUpstreamRequest`:
 * `canonicalHeaders` (lowercase merge with `copilotHeaders`, later-wins),
 * `dropOutboundHopHeaders` (the `OUTBOUND_DROP_HEADERS` set in
 * `routes/_shared/headers.ts`), and `setAuthorization` / `stripDeniedBetas`.
 * Any of those could silently remove the pair and every ctx-level assertion
 * would stay green — the "a check that cannot fail on the fault it guards"
 * pattern this repo has already hit repeatedly.
 *
 * So these tests capture the ACTUAL outbound request: `globalThis.fetch` is
 * replaced, `createAnthropicMessages` is driven end-to-end, and the assertions
 * read the `Headers` object built from the real `RequestInit` — the same bytes
 * undici would put on the wire. Adding `x-initiator` or `x-interaction-type`
 * to `OUTBOUND_DROP_HEADERS` turns these RED.
 *
 * The pipeline under test is the full deployed-fleet path: an Anthropic lane
 * with EMPTY `header_rules` (what an already-provisioned `config.yaml` has) →
 * `applyInitiatorHeaders` boot injection → `applyRules` → the upstream caller.
 *
 * Cases: agent (tool_result-last) and user (text-last), both asserted at
 * egress; plus the value lockstep and the survival of the merge with
 * `copilotHeaders`.
 *
 * ⚠ KNOWN GAPS — accepted, not oversights. Recorded here so the limitation is
 * visible in the file that carries it rather than only in a review report.
 *
 *   1. **The Lane 5 case does not drive the production router.** Lane 5
 *      (`/responses × ^claude-`) reaches the Anthropic upstream through the
 *      real handler's body-rule chain — `redirect_to_anthropic_messages` sets
 *      the `x-proxy-redirect-to` marker, `translate_responses_to_anthropic`
 *      converts the body, and `routes/_shared/marker-dispatch.ts` selects the
 *      service. The `LANE5` test below skips all of that: it calls
 *      `createAnthropicMessages` directly with an already-Anthropic body, so it
 *      proves the header pair survives EGRESS on that lane but NOT that the
 *      router delivers a Lane 5 request to that egress at all. That is a real
 *      coverage gap, deferred per C-2 (single-user home scope) as test-DEPTH
 *      debt — the product path itself is exercised by the existing
 *      marker-dispatch and responses-lane suites.
 *   2. **The header-name schema accepts empty / whitespace-only names.**
 *      `DeriveXInitiatorSchema`'s `header_name` /
 *      `interaction_type_header_name` are `z.string()` with no `.min(1)` or
 *      trim, so an operator could hand-write `header_name: ""`. Reachable ONLY
 *      via hand-edited operator config — never via `applyInitiatorHeaders`,
 *      which pins both names. The case that actually BREAKS the pair (two names
 *      colliding case-insensitively, which collapses two writes into one and
 *      emits a single malformed half) IS closed, by the `.refine` in
 *      `derive_x_initiator.ts` and its tests in
 *      `tests/transform/derive_x_initiator.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules (first-run case)
import { applyInitiatorHeaders } from "~/lib/apply-initiator-headers.ts";
import { applyRules } from "~/lib/transform/apply.ts";
import {
  derive_x_initiator,
  DeriveXInitiatorSchema,
} from "~/lib/transform/derive_x_initiator.ts";
import { register, snapshot } from "~/lib/transform/registry.ts";
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";
import type { Rule, TransformContext } from "~/lib/transform/types.ts";

// Shared-singleton registry: force-(re)register so both ConfigSchema.parse and
// applyRules see the rule regardless of the order Bun runs test files in.
beforeAll(() => {
  register("derive_x_initiator", derive_x_initiator, DeriveXInitiatorSchema, {
    ctx_reads: ["body"],
    ctx_writes: ["headers"],
    allow_override: true,
  });
});

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** The DEPLOYED-FLEET state: Anthropic lanes with EMPTY header_rules. */
function makeDeployedConfig(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        header_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
      {
        match: {
          method: "POST",
          path: "/responses",
          model_pattern: "^claude-",
        },
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

const LANE1 = 0;
const LANE5 = 1;

/** Last message's content array ENDS WITH a tool_result block → agent. */
const agentBody = {
  model: "claude-opus-4.8",
  messages: [
    { role: "user", content: [{ type: "text", text: "run the thing" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
    },
  ],
};

/** Last content block is text → user. */
const userBody = {
  model: "claude-opus-4.8",
  messages: [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "done" },
        { type: "text", text: "now explain it" },
      ],
    },
  ],
};

/**
 * Drive the FULL path — boot injection → transform engine → upstream caller —
 * and return the headers of the request that actually reached `fetch`.
 *
 * `seed` is written into `ctx.headers` BEFORE the transform engine runs, i.e.
 * it stands in for a header the inbound client sent. Used to put a real
 * `content-length` into the pipeline so the outbound drop pass has something to
 * drop (see the drop-pass test).
 *
 * Read back through `new Headers(...)` deliberately: that is the same
 * normalization undici applies, so the assertions are about the wire form
 * rather than about the shape of an intermediate JS object.
 */
async function egressHeaders(
  laneIdx: number,
  body: unknown,
  seed: Record<string, string> = {},
): Promise<Headers> {
  const config = makeDeployedConfig();
  applyInitiatorHeaders(config);
  const lane = config.routes[laneIdx]!;

  const ctx: TransformContext = {
    body,
    headers: { ...seed },
    route: lane.match.path ?? "/v1/messages",
    model: "claude-opus-4.8",
  };
  const piped = await applyRules(
    ctx,
    lane.header_rules as unknown as Rule[],
    snapshot("body"),
  );

  const sent: Headers[] = [];
  globalThis.fetch = (async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    sent.push(new Headers(init?.headers));
    return new Response('{"ok":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const response = await createAnthropicMessages({
    body: piped.ctx.body,
    headers: piped.ctx.headers,
    copilotToken: "test-copilot-token",
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    upstreamPath: "/v1/messages",
    betaDeny: config.anthropic_beta.deny,
  });
  expect(response.status).toBe(200);

  // Exactly one upstream fetch (no 401 → no Layer-B retry).
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("initiator headers reach the WIRE (outbound upstream request)", () => {
  test("agent case: BOTH headers present on the outbound request", async () => {
    const out = await egressHeaders(LANE1, agentBody);
    expect(out.get("x-initiator")).toBe("agent");
    expect(out.get("x-interaction-type")).toBe("conversation-agent");
  });

  test("user case: BOTH headers present on the outbound request", async () => {
    const out = await egressHeaders(LANE1, userBody);
    expect(out.get("x-initiator")).toBe("user");
    expect(out.get("x-interaction-type")).toBe("conversation-user");
  });

  test("Lane 5 (/responses × ^claude-) egresses the pair too", async () => {
    const agent = await egressHeaders(LANE5, agentBody);
    expect(agent.get("x-initiator")).toBe("agent");
    expect(agent.get("x-interaction-type")).toBe("conversation-agent");
    const user = await egressHeaders(LANE5, userBody);
    expect(user.get("x-initiator")).toBe("user");
    expect(user.get("x-interaction-type")).toBe("conversation-user");
  });

  test("the pair survives the canonicalHeaders merge with copilotHeaders", async () => {
    // `canonicalHeaders(baseHeaders, args.headers)` is later-wins, so the base
    // Copilot identification headers must coexist with the derived pair rather
    // than displace it (or be displaced by it).
    const out = await egressHeaders(LANE1, agentBody);
    expect(out.get("x-initiator")).toBe("agent");
    expect(out.get("x-interaction-type")).toBe("conversation-agent");
    // Base identification headers still there.
    expect(out.get("copilot-integration-id")).toBe("vscode-chat");
    expect(out.get("openai-intent")).toBe("conversation-panel");
    expect(out.get("authorization")).toBe("Bearer test-copilot-token");
  });

  test("the outbound hop-header drop pass RUNS, and does not take the pair with it", async () => {
    // The pair lives or dies by `dropOutboundHopHeaders`: adding `x-initiator`
    // to OUTBOUND_DROP_HEADERS would silently un-ship this feature. To assert
    // that the drop pass ran we must give it something to drop — an earlier
    // revision asserted `content-length` was null WITHOUT ever putting one in,
    // which passes whether or not the pass runs and proves nothing.
    //
    // So: seed a real `content-length` (as an inbound client would send) and
    // require it GONE at egress, alongside the pair being PRESENT. Both halves
    // matter — the first proves the pass ran on this exact request, the second
    // proves it did not eat the headers under test.
    const out = await egressHeaders(LANE1, agentBody, {
      "content-length": "12345",
    });
    expect(out.get("content-length")).toBeNull();
    expect(out.get("x-initiator")).toBe("agent");
    expect(out.get("x-interaction-type")).toBe("conversation-agent");
  });

  test("the seeded content-length really does reach the pipeline (anti-vacuity)", async () => {
    // Guards the guard. If `seed` were dropped on the floor before egress —
    // a helper refactor, a ctx.headers overwrite — the test above would go
    // back to asserting the absence of a header that was never present. A
    // control header seeded the SAME way, and NOT in OUTBOUND_DROP_HEADERS,
    // must survive to the wire.
    const out = await egressHeaders(LANE1, agentBody, {
      "content-length": "12345",
      "x-seed-control": "seeded",
    });
    expect(out.get("x-seed-control")).toBe("seeded");
    expect(out.get("content-length")).toBeNull();
  });

  test("egress values are in LOCKSTEP: x-interaction-type === conversation-<x-initiator>", async () => {
    for (const body of [agentBody, userBody]) {
      const out = await egressHeaders(LANE1, body);
      const initiator = out.get("x-initiator");
      expect(initiator).not.toBeNull();
      expect(out.get("x-interaction-type")).toBe(`conversation-${initiator}`);
    }
  });
});
