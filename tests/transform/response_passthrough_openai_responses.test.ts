/**
 * response_passthrough_openai_responses.test.ts — per-rule unit tests for
 * the M9 Group C consumer stub (D-LOCK-7).
 *
 * Coverage maps to M9 mini-audit items 52, 53. Includes the M9-specific
 * "closes the M8 D-LOCK-13 gate" pairing check (matches `redirect_to_responses`
 * declared `openai_responses` shape).
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
import "~/lib/transform/redirect_to_responses";
import "~/lib/transform/response_passthrough_openai_responses";
import { ResponsePassthroughOpenaiResponsesSchema } from "~/lib/transform/response_passthrough_openai_responses";
import { validateResponseShape } from "~/lib/transform/_validate_response_shape";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerConsumer(): Promise<void> {
  const mod =
    await import("~/lib/transform/response_passthrough_openai_responses");
  register(
    "response_passthrough_openai_responses",
    mod.response_passthrough_openai_responses,
    mod.ResponsePassthroughOpenaiResponsesSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
}

async function registerRedirect(): Promise<void> {
  const mod = await import("~/lib/transform/redirect_to_responses");
  register(
    "redirect_to_responses",
    mod.redirect_to_responses,
    mod.RedirectToResponsesSchema,
    {
      response_shape: "openai_responses",
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
    route: "/chat/completions",
    model: "gpt-5.1",
  };
}

describe("response_passthrough_openai_responses — schema validation", () => {
  test("valid minimal config", () => {
    const r = ResponsePassthroughOpenaiResponsesSchema.safeParse({
      name: "x",
      use: "response_passthrough_openai_responses",
    });
    expect(r.success).toBe(true);
  });

  test("rejects wrong use literal", () => {
    const r = ResponsePassthroughOpenaiResponsesSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

describe("response_passthrough_openai_responses — registry metadata (mini-audit 52)", () => {
  test("declares response_shape: 'openai_responses'", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_openai_responses");
    expect(reg).toBeDefined();
    expect(reg?.opts.response_shape).toBe("openai_responses");
  });

  test("declares ctx_reads: [], ctx_writes: []", async () => {
    await registerConsumer();
    const reg = get("body", "response_passthrough_openai_responses");
    expect(reg?.opts.ctx_reads).toEqual([]);
    expect(reg?.opts.ctx_writes).toEqual([]);
  });
});

describe("response_passthrough_openai_responses — behavior (mini-audit 53)", () => {
  test("returns {applied: false} (pure no-op)", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_openai_responses" },
    ];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("does not modify ctx.body or ctx.headers", async () => {
    await registerConsumer();
    const snap = snapshot("body");
    const ctx: TransformContext = {
      body: { model: "gpt-5.1" },
      headers: { "x-custom": "untouched" },
      route: "/chat/completions",
      model: "gpt-5.1",
    };
    const rules: Rule[] = [
      { name: "r", use: "response_passthrough_openai_responses" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.body).toEqual({ model: "gpt-5.1" });
    expect(result.ctx.headers).toEqual({ "x-custom": "untouched" });
  });
});

describe("response_passthrough_openai_responses — validator pairing (mini-audit 53/54; closes M8 D-LOCK-13 gate)", () => {
  test("validateResponseShape returns 0 failures when paired with redirect_to_responses", async () => {
    await registerRedirect();
    await registerConsumer();
    const bodyRules: Rule[] = [
      { name: "gpt5_to_responses", use: "redirect_to_responses" },
    ];
    const responseRules: Rule[] = [
      {
        name: "consume_openai_responses",
        use: "response_passthrough_openai_responses",
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
