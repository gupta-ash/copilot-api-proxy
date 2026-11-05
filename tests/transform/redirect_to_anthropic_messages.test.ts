/**
 * redirect_to_anthropic_messages.test.ts — per-rule unit tests for
 * redirect_to_anthropic_messages (M6, D-LOCK-4).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import {
  REDIRECT_MARKER_HEADER,
  RedirectToAnthropicMessagesSchema,
} from "~/lib/transform/redirect_to_anthropic_messages";
import "~/lib/transform/redirect_to_anthropic_messages";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/redirect_to_anthropic_messages");
  const { register } = await import("~/lib/transform/registry");
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

function makeCtx(headers: Record<string, string> = {}): TransformContext {
  return {
    body: {},
    headers,
    route: "/v1/responses",
    model: "claude-opus-4.7",
  };
}

describe("redirect_to_anthropic_messages — schema validation", () => {
  test("valid minimal config", () => {
    const r = RedirectToAnthropicMessagesSchema.safeParse({
      name: "x",
      use: "redirect_to_anthropic_messages",
    });
    expect(r.success).toBe(true);
  });
});

describe("redirect_to_anthropic_messages — behavior", () => {
  test("sets x-proxy-redirect-to: /v1/messages", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "redirect_to_anthropic_messages" },
    ];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/messages");
  });

  test("idempotent: re-applying when marker already set → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "redirect_to_anthropic_messages" },
    ];
    const result = await applyRules(
      makeCtx({ [REDIRECT_MARKER_HEADER]: "/v1/messages" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
  });

  test("overwrites prior redirect to a different target", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "redirect_to_anthropic_messages" },
    ];
    const result = await applyRules(
      makeCtx({ [REDIRECT_MARKER_HEADER]: "/v1/chat/completions" }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/messages");
  });

  test("declares response_shape: 'anthropic_v1_messages' in registry metadata (D-LOCK-4)", async () => {
    await registerRule();
    const reg = get("body", "redirect_to_anthropic_messages");
    expect(reg).toBeDefined();
    expect(reg?.opts.response_shape).toBe("anthropic_v1_messages");
  });
});
