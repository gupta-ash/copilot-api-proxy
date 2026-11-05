/**
 * response_passthrough_anthropic_v1_messages.test.ts — per-rule unit tests
 * for the M9 Group C consumer stub (D-LOCK-7).
 *
 * Coverage maps to M9 mini-audit items 50, 53:
 *   - schema validation (minimal config)
 *   - registry metadata: response_shape="anthropic_v1_messages",
 *     ctx_reads=[], ctx_writes=[]
 *   - function returns {applied: false} (pure no-op)
 *   - validateResponseShape returns 0 failures when this rule is in
 *     responseRules + matching `redirect_to_anthropic_messages` is in
 *     bodyRules.
 *   - D-LOCK-18 default materialization: Schema.parse(options) is invoked.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  register,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import "~/lib/transform/redirect_to_anthropic_messages";
import "~/lib/transform/response_passthrough_anthropic_v1_messages";
import { ResponsePassthroughAnthropicV1MessagesSchema } from "~/lib/transform/response_passthrough_anthropic_v1_messages";
import { validateResponseShape } from "~/lib/transform/_validate_response_shape";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerConsumer(): Promise<void> {
  const mod =
    await import("~/lib/transform/response_passthrough_anthropic_v1_messages");
  register(
    "response_passthrough_anthropic_v1_messages",
    mod.response_passthrough_anthropic_v1_messages,
    mod.ResponsePassthroughAnthropicV1MessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
}

async function registerRedirect(): Promise<void> {
  const mod = await import("~/lib/transform/redirect_to_anthropic_messages");
  register(
    "redirect_to_anthropic_messages",
    mod.redirect_to_anthropic_messages,
    mod.RedirectToAnthropicMessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
}

function makeCtx(): TransformContext {
  return {
    body: {},
    headers: {},
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("response_passthrough_anthropic_v1_messages — schema validation", () => {
  test("valid minimal config", () => {
    const r = ResponsePassthroughAnthropicV1MessagesSchema.safeParse({
      name: "x",
      use: "response_passthrough_anthropic_v1_messages",
    });
    expect(r.success).toBe(true);
  });

  test("rejects wrong use literal", () => {
    const r = ResponsePassthroughAnthropicV1MessagesSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });

  test("rejects empty name", () => {
    const r = ResponsePassthroughAnthropicV1MessagesSchema.safeParse({
      name: "",
      use: "response_passthrough_anthropic_v1_messages",
    });
    expect(r.success).toBe(false);
  });
});

describe("response_passthrough_anthropic_v1_messages — registry metadata (mini-audit 50)", () => {
  test("declares response_shape: 'anthropic_v1_messages'", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_anthropic_v1_messages");
    expect(reg).toBeDefined();
    expect(reg?.opts.response_shape).toBe("anthropic_v1_messages");
  });

  test("declares ctx_reads: [], ctx_writes: []", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_anthropic_v1_messages");
    expect(reg?.opts.ctx_reads).toEqual([]);
    expect(reg?.opts.ctx_writes).toEqual([]);
  });
});

describe("response_passthrough_anthropic_v1_messages — behavior (mini-audit 53)", () => {
  test("returns {applied: false} (pure no-op)", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_anthropic_v1_messages" },
    ];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("does not modify ctx.body or ctx.headers", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const ctx: TransformContext = {
      body: { sample: "value" },
      headers: { "content-type": "application/json" },
      route: "/v1/messages",
      model: "claude-opus-4.7",
    };
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_anthropic_v1_messages" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.body).toEqual({ sample: "value" });
    expect(result.ctx.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("response_passthrough_anthropic_v1_messages — validator pairing (mini-audit 53/54)", () => {
  test("validateResponseShape returns 0 failures when paired with redirect_to_anthropic_messages", async () => {
    await registerRedirect();
    await registerConsumer();
    const bodyRules: Rule[] = [
      { name: "to_claude", use: "redirect_to_anthropic_messages" },
    ];
    const responseRules: Rule[] = [
      {
        name: "from_claude",
        use: "response_passthrough_anthropic_v1_messages",
      },
    ];
    const snap = snapshot("body");
    const failures = validateResponseShape(
      bodyRules,
      responseRules,
      snap,
      snap,
    );
    expect(failures).toEqual([]);
  });
});
