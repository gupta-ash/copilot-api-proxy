/**
 * redirect_to_chat_completions.test.ts — per-rule unit tests for
 * redirect_to_chat_completions (M6, D-LOCK-4).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { REDIRECT_MARKER_HEADER } from "~/lib/transform/redirect_to_anthropic_messages";
import { RedirectToChatCompletionsSchema } from "~/lib/transform/redirect_to_chat_completions";
import "~/lib/transform/redirect_to_chat_completions";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/redirect_to_chat_completions");
  const { register } = await import("~/lib/transform/registry");
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

function makeCtx(headers: Record<string, string> = {}): TransformContext {
  return {
    body: {},
    headers,
    route: "/v1/messages",
    model: "gpt-5",
  };
}

describe("redirect_to_chat_completions — schema validation", () => {
  test("valid minimal config", () => {
    const r = RedirectToChatCompletionsSchema.safeParse({
      name: "x",
      use: "redirect_to_chat_completions",
    });
    expect(r.success).toBe(true);
  });
});

describe("redirect_to_chat_completions — behavior", () => {
  test("sets x-proxy-redirect-to: /v1/chat/completions", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_chat_completions" }];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe(
      "/v1/chat/completions",
    );
  });

  test("idempotent: re-applying when marker already set → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_chat_completions" }];
    const result = await applyRules(
      makeCtx({ [REDIRECT_MARKER_HEADER]: "/v1/chat/completions" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
  });

  test("declares response_shape: 'openai_chat_completions' in registry metadata (D-LOCK-4)", async () => {
    await registerRule();
    const reg = get("body", "redirect_to_chat_completions");
    expect(reg).toBeDefined();
    expect(reg?.opts.response_shape).toBe("openai_chat_completions");
  });
});
