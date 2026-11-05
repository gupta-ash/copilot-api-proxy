/**
 * initiator_headers_apply.test.ts — integration test for the x-initiator /
 * x-interaction-type pair (Copilot client fidelity).
 *
 * **What this proves that the default.yaml assertions cannot.** The deployed
 * state on every already-provisioned machine is an Anthropic lane WITHOUT the
 * derive rule — `deploy/install_bundle.ps1` (installed as `scripts/install_bundle.ps1`) places `config.yaml` only if
 * absent, so a `config/default.yaml` edit never reaches it. These tests start
 * from that state (EMPTY `header_rules`), run `applyInitiatorHeaders`, and then
 * run the resulting rules through the real transform engine (`applyRules`) with
 * real request bodies. If the boot injection were a no-op, both headers would
 * be absent and every test here fails — which is exactly the silent no-op an
 * edit-the-YAML-and-cut-a-Release change would have shipped.
 *
 * Cases: tool_result-last → agent pair; text-last → user pair; Lane 5
 * (`/responses × ^claude-`) gets the same treatment; gpt lane gets neither.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules (first-run case)
import { applyInitiatorHeaders } from "~/lib/apply-initiator-headers.ts";
import { applyRules } from "~/lib/transform/apply.ts";
import {
  derive_x_initiator,
  DeriveXInitiatorSchema,
} from "~/lib/transform/derive_x_initiator.ts";
import { register, snapshot } from "~/lib/transform/registry.ts";
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

/**
 * The DEPLOYED-FLEET state: both Anthropic lanes with EMPTY header_rules (the
 * derive rule commented out / absent from the operator's config.yaml).
 */
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
          model_pattern: "^gpt-5\\.",
        },
        header_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_responses",
          shape: "openai_responses",
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
const GPT_LANE = 1;
const LANE5 = 2;

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

/** Boot-inject, then run the lane's header_rules over `body`. */
async function runLane(
  laneIdx: number,
  body: unknown,
): Promise<Record<string, string>> {
  const config = makeDeployedConfig();
  applyInitiatorHeaders(config);
  const lane = config.routes[laneIdx]!;
  const ctx: TransformContext = {
    body,
    headers: {},
    route: lane.match.path ?? "/v1/messages",
    model: "claude-opus-4.8",
  };
  const result = await applyRules(
    ctx,
    lane.header_rules as unknown as Rule[],
    snapshot("body"),
  );
  return result.ctx.headers;
}

describe("initiator headers — boot injection reaches an EMPTY-header_rules lane", () => {
  test("Lane 1: tool_result-last body → agent + conversation-agent", async () => {
    const headers = await runLane(LANE1, agentBody);
    expect(headers["x-initiator"]).toBe("agent");
    expect(headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("Lane 1: text-last body → user + conversation-user", async () => {
    const headers = await runLane(LANE1, userBody);
    expect(headers["x-initiator"]).toBe("user");
    expect(headers["x-interaction-type"]).toBe("conversation-user");
  });

  test("Lane 5 (/responses × ^claude-) gets the same pair", async () => {
    const agent = await runLane(LANE5, agentBody);
    expect(agent["x-initiator"]).toBe("agent");
    expect(agent["x-interaction-type"]).toBe("conversation-agent");
    const user = await runLane(LANE5, userBody);
    expect(user["x-initiator"]).toBe("user");
    expect(user["x-interaction-type"]).toBe("conversation-user");
  });

  test("gpt lane emits NEITHER header", async () => {
    const headers = await runLane(GPT_LANE, agentBody);
    expect(headers["x-initiator"]).toBeUndefined();
    expect(headers["x-interaction-type"]).toBeUndefined();
  });
});
