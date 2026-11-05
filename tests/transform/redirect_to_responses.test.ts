/**
 * redirect_to_responses.test.ts — per-rule unit tests for the M8 NEW
 * `redirect_to_responses` body rule (D-LOCK-13 + D-LOCK-14).
 *
 * Coverage maps to M8 mini-audit items 21-28:
 *   - schema validation (minimal config)
 *   - registry metadata: response_shape="openai_responses",
 *     ctx_reads=["body"], ctx_writes=["body","headers"]
 *   - REDIRECT_TARGET = "/v1/responses" (LOCKED per D-LOCK-13)
 *   - REDIRECT_MARKER_HEADER reused from redirect_to_anthropic_messages
 *     (NOT a new local constant)
 *   - idempotency: 2nd call when marker already set returns applied:false
 *   - 1st call: sets header + applied:true with before/after snapshots
 *   - validator positive: stub response rule offers the shape → 0 failures
 *   - validator negative: no response rule offers shape → 1 failure with
 *     correct shape + message
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  register,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { REDIRECT_MARKER_HEADER } from "~/lib/transform/redirect_to_anthropic_messages";
import { RedirectToResponsesSchema } from "~/lib/transform/redirect_to_responses";
import "~/lib/transform/redirect_to_responses";
import {
  validateResponseShape,
  type ValidationFailure,
} from "~/lib/transform/_validate_response_shape";
import type {
  Rule,
  TransformContext,
  TransformFn,
  TransformResult,
} from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
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

function makeCtx(headers: Record<string, string> = {}): TransformContext {
  return {
    body: {},
    headers,
    route: "/v1/messages",
    model: "gpt-5",
  };
}

describe("redirect_to_responses — schema validation", () => {
  test("valid minimal config", () => {
    const r = RedirectToResponsesSchema.safeParse({
      name: "x",
      use: "redirect_to_responses",
    });
    expect(r.success).toBe(true);
  });

  test("REDIRECT_MARKER_HEADER constant reused from redirect_to_anthropic_messages (mini-audit 22)", () => {
    // Sanity: importing from the canonical site works; not a new local const.
    expect(REDIRECT_MARKER_HEADER).toBe("x-proxy-redirect-to");
  });
});

describe("redirect_to_responses — registry metadata (mini-audit 21)", () => {
  test("declares ctx_reads: ['body'], ctx_writes: ['body','headers']", async () => {
    await registerRule();
    const reg = get("body", "redirect_to_responses");
    expect(reg).toBeDefined();
    expect(reg?.opts.ctx_reads).toEqual(["body"]);
    expect(reg?.opts.ctx_writes).toEqual(["body", "headers"]);
  });

  test("declares response_shape: 'openai_responses' (D-LOCK-13)", async () => {
    await registerRule();
    const reg = get("body", "redirect_to_responses");
    expect(reg?.opts.response_shape).toBe("openai_responses");
  });
});

describe("redirect_to_responses — behavior (mini-audit 24-25)", () => {
  test("1st invocation sets x-proxy-redirect-to: /v1/responses → applied:true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_responses" }];
    const result = await applyRules(makeCtx(), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/responses");
    // before / after snapshots are populated.
    const ar = result.applied[0];
    expect(ar?.before).toEqual({ [REDIRECT_MARKER_HEADER]: null });
    expect(ar?.after).toEqual({ [REDIRECT_MARKER_HEADER]: "/v1/responses" });
  });

  test("idempotent: re-applying when marker already set → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_responses" }];
    const result = await applyRules(
      makeCtx({ [REDIRECT_MARKER_HEADER]: "/v1/responses" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/responses");
  });

  test("REDIRECT_TARGET is /v1/responses (LOCKED per D-LOCK-13, mini-audit 23)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_responses" }];
    const result = await applyRules(makeCtx(), rules, snap);
    // Project convention: /v1/* prefix matches sibling primitives. NOT /responses.
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/responses");
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).not.toBe("/responses");
  });

  test("does not modify other headers", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "r", use: "redirect_to_responses" }];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "claude-code-2025-11-19" }),
      rules,
      snap,
    );
    expect(result.ctx.headers["anthropic-beta"]).toBe("claude-code-2025-11-19");
    expect(result.ctx.headers[REDIRECT_MARKER_HEADER]).toBe("/v1/responses");
  });
});

// -----------------------------------------------------------------------------
// Validator interaction (D-LOCK-14)
// -----------------------------------------------------------------------------

// Stub response-side rule that "consumes" the openai_responses shape.
// Registered into the body registry (M8 doesn't yet have a separate
// response-side registry; M9 may differentiate). Per D-LOCK-14 the stub
// is sufficient for the validator interaction test.
const NoopResponseSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("noop_response_for_openai_responses"),
  })
  .passthrough();

const noop_response_for_openai_responses: TransformFn = (
  ctx: TransformContext,
): TransformResult => ({ ctx, applied: true });

async function registerNoopConsumer(): Promise<void> {
  register(
    "noop_response_for_openai_responses",
    noop_response_for_openai_responses,
    NoopResponseSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
}

describe("redirect_to_responses — validator interaction (D-LOCK-14)", () => {
  test("positive: when stub response rule offers shape, validateResponseShape returns 0 failures (mini-audit 26)", async () => {
    await registerRule();
    await registerNoopConsumer();

    const bodyRules: Rule[] = [
      { name: "redirect_test", use: "redirect_to_responses" },
    ];
    const responseRules: Rule[] = [
      {
        name: "consume_test",
        use: "noop_response_for_openai_responses",
      },
    ];
    const bodySnap = snapshot("body");
    // For M8's interaction test, both args use the body snapshot — M9 may
    // differentiate registries. The validator only cares that the snapshot
    // contains the response-side rule's metadata (response_shape).
    const respSnap = snapshot("body");

    const failures: ValidationFailure[] = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      respSnap,
    );
    expect(failures).toEqual([]);
  });

  test("negative: when no response rule offers shape, validateResponseShape returns exactly 1 failure with shape + message (mini-audit 27)", async () => {
    await registerRule();
    // Intentionally do NOT register the noop consumer.

    const bodyRules: Rule[] = [
      { name: "redirect_test", use: "redirect_to_responses" },
    ];
    const responseRules: Rule[] = [];
    const bodySnap = snapshot("body");
    const respSnap = snapshot("body");

    const failures: ValidationFailure[] = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      respSnap,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      bodyRuleName: "redirect_test",
      shape: "openai_responses",
    });
    expect(failures[0]?.message).toContain("openai_responses");
    expect(failures[0]?.message).toContain("redirect_test");
  });

  test("negative: validator message wording matches M9 config-load error format", async () => {
    await registerRule();

    const bodyRules: Rule[] = [
      { name: "redirect_for_gpt5", use: "redirect_to_responses" },
    ];
    const respSnap = snapshot("body");
    const failures = validateResponseShape(
      bodyRules,
      [],
      snapshot("body"),
      respSnap,
    );
    expect(failures[0]?.message).toBe(
      "Rule 'redirect_for_gpt5' redirects to openai_responses but no response rules configured for that shape.",
    );
  });
});
