/**
 * response_passthrough_openai_chat_completions.test.ts — per-rule unit tests
 * for the M9 Group C consumer stub (D-LOCK-7).
 *
 * Coverage maps to M9 mini-audit items 51, 53.
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
import "~/lib/transform/redirect_to_chat_completions";
import "~/lib/transform/response_passthrough_openai_chat_completions";
import { ResponsePassthroughOpenaiChatCompletionsSchema } from "~/lib/transform/response_passthrough_openai_chat_completions";
import { validateResponseShape } from "~/lib/transform/_validate_response_shape";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerConsumer(): Promise<void> {
  const mod =
    await import("~/lib/transform/response_passthrough_openai_chat_completions");
  register(
    "response_passthrough_openai_chat_completions",
    mod.response_passthrough_openai_chat_completions,
    mod.ResponsePassthroughOpenaiChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
}

async function registerRedirect(): Promise<void> {
  const mod = await import("~/lib/transform/redirect_to_chat_completions");
  register(
    "redirect_to_chat_completions",
    mod.redirect_to_chat_completions,
    mod.RedirectToChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
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
    route: "/responses",
    model: "gpt-4o",
  };
}

describe("response_passthrough_openai_chat_completions — schema validation", () => {
  test("valid minimal config", () => {
    const r = ResponsePassthroughOpenaiChatCompletionsSchema.safeParse({
      name: "x",
      use: "response_passthrough_openai_chat_completions",
    });
    expect(r.success).toBe(true);
  });

  test("rejects wrong use literal", () => {
    const r = ResponsePassthroughOpenaiChatCompletionsSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

describe("response_passthrough_openai_chat_completions — registry metadata (mini-audit 51)", () => {
  test("declares response_shape: 'openai_chat_completions'", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_openai_chat_completions");
    expect(reg).toBeDefined();
    expect(reg?.opts.response_shape).toBe("openai_chat_completions");
  });

  test("declares ctx_reads: [], ctx_writes: []", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_openai_chat_completions");
    expect(reg?.opts.ctx_reads).toEqual([]);
    expect(reg?.opts.ctx_writes).toEqual([]);
  });
});

describe("response_passthrough_openai_chat_completions — behavior (mini-audit 53)", () => {
  test("returns {applied: false} (pure no-op)", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_openai_chat_completions" },
    ];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("does not modify ctx.body or ctx.headers", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const ctx: TransformContext = {
      body: { x: 1 },
      headers: { foo: "bar" },
      route: "/responses",
      model: "gpt-4o",
    };
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_openai_chat_completions" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.body).toEqual({ x: 1 });
    expect(result.ctx.headers).toEqual({ foo: "bar" });
  });
});

describe("response_passthrough_openai_chat_completions — validator pairing (mini-audit 53/54)", () => {
  test("validateResponseShape returns 0 failures when paired with redirect_to_chat_completions", async () => {
    await registerRedirect();
    await registerConsumer();
    const bodyRules: Rule[] = [
      { name: "to_chat", use: "redirect_to_chat_completions" },
    ];
    const responseRules: Rule[] = [
      {
        name: "from_chat",
        use: "response_passthrough_openai_chat_completions",
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
