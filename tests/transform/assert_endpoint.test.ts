/**
 * assert_endpoint.test.ts — per-rule unit tests for assert_endpoint (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules, EngineAbort500Error } from "~/lib/transform/apply";
import {
  AssertEndpointFailedError,
  AssertEndpointSchema,
} from "~/lib/transform/assert_endpoint";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/assert_endpoint";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/assert_endpoint");
  const { register } = await import("~/lib/transform/registry");
  register("assert_endpoint", mod.assert_endpoint, mod.AssertEndpointSchema, {
    ctx_reads: ["body"],
    ctx_writes: [],
    allow_override: true,
  });
}

function makeCtx(route: string): TransformContext {
  return {
    body: {},
    headers: {},
    route,
    model: "claude-opus-4.7",
  };
}

describe("assert_endpoint — schema validation", () => {
  test("missing ensure_endpoint → invalid", () => {
    const r = AssertEndpointSchema.safeParse({
      name: "x",
      use: "assert_endpoint",
    });
    expect(r.success).toBe(false);
  });

  test("valid config", () => {
    const r = AssertEndpointSchema.safeParse({
      name: "x",
      use: "assert_endpoint",
      ensure_endpoint: "/v1/messages",
    });
    expect(r.success).toBe(true);
  });
});

describe("assert_endpoint — behavior", () => {
  test("match: silent pass (applied: false)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "ensure_msg",
        use: "assert_endpoint",
        ensure_endpoint: "/v1/messages",
      },
    ];
    const result = await applyRules(makeCtx("/v1/messages"), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("mismatch under default on_error=continue: pushed AppliedRule with error", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "ensure_msg",
        use: "assert_endpoint",
        ensure_endpoint: "/v1/messages",
      },
    ];
    const result = await applyRules(
      makeCtx("/v1/chat/completions"),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.error).toContain("/v1/messages");
    expect(result.applied[0]?.error).toContain("/v1/chat/completions");
  });

  test("mismatch under on_error=abort_with_500: throws EngineAbort500Error", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "ensure_msg",
        use: "assert_endpoint",
        on_error: "abort_with_500",
        ensure_endpoint: "/v1/messages",
      },
    ];
    await expect(
      applyRules(makeCtx("/v1/chat/completions"), rules, snap),
    ).rejects.toBeInstanceOf(EngineAbort500Error);
  });

  test("error message identifies rule + actual + expected route", () => {
    const err = new AssertEndpointFailedError(
      "ensure_msg",
      "/v1/chat/completions",
      "/v1/messages",
    );
    expect(err.message).toContain("ensure_msg");
    expect(err.message).toContain("/v1/messages");
    expect(err.message).toContain("/v1/chat/completions");
  });
});
