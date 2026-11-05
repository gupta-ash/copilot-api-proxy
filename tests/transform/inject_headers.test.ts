/**
 * inject_headers.test.ts — per-rule unit tests for inject_headers (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { InjectHeadersSchema } from "~/lib/transform/inject_headers";
import "~/lib/transform/inject_headers";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/inject_headers");
  const { register } = await import("~/lib/transform/registry");
  register("inject_headers", mod.inject_headers, mod.InjectHeadersSchema, {
    ctx_reads: ["headers"],
    ctx_writes: ["headers"],
    allow_override: true,
  });
}

function makeCtx(headers: Record<string, string>): TransformContext {
  return {
    body: {},
    headers,
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("inject_headers — schema validation", () => {
  test("missing set → invalid", () => {
    const r = InjectHeadersSchema.safeParse({
      name: "x",
      use: "inject_headers",
    });
    expect(r.success).toBe(false);
  });

  test("valid config", () => {
    const r = InjectHeadersSchema.safeParse({
      name: "x",
      use: "inject_headers",
      set: { "x-foo": "bar" },
    });
    expect(r.success).toBe(true);
  });
});

describe("inject_headers — behavior", () => {
  test("set if absent → adds new header", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "i",
        use: "inject_headers",
        set: { "anthropic-beta": "advanced-tool-use-2025-11-20" },
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "advanced-tool-use-2025-11-20",
    );
  });

  test("force=false: existing header is preserved (idempotent)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "i",
        use: "inject_headers",
        set: { "anthropic-beta": "new-value" },
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "existing-value" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["anthropic-beta"]).toBe("existing-value");
  });

  test("force=true: existing header is overwritten", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "i",
        use: "inject_headers",
        force: true,
        set: { "anthropic-beta": "new-value" },
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "existing-value" }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe("new-value");
  });

  test("case-insensitive presence check", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "i",
        use: "inject_headers",
        set: { "Anthropic-Beta": "v2" },
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "v1" }),
      rules,
      snap,
    );
    // Already present (case-insensitive) under default force=false.
    expect(result.applied).toEqual([]);
  });

  test("multi-header injection", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "i",
        use: "inject_headers",
        set: {
          "x-proxy-tag": "public-fixture",
          "x-proxy-version": "v2",
        },
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-proxy-tag"]).toBe("public-fixture");
    expect(result.ctx.headers["x-proxy-version"]).toBe("v2");
  });
});
