/**
 * passthrough_headers.test.ts — per-rule unit tests for passthrough_headers (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { PassthroughHeadersSchema } from "~/lib/transform/passthrough_headers";
import "~/lib/transform/passthrough_headers";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/passthrough_headers");
  const { register } = await import("~/lib/transform/registry");
  register(
    "passthrough_headers",
    mod.passthrough_headers,
    mod.PassthroughHeadersSchema,
    {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
      allow_override: true,
    },
  );
}

function makeCtx(headers: Record<string, string>): TransformContext {
  return {
    body: {},
    headers,
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("passthrough_headers — schema validation", () => {
  test("missing allow → invalid", () => {
    const r = PassthroughHeadersSchema.safeParse({
      name: "x",
      use: "passthrough_headers",
    });
    expect(r.success).toBe(false);
  });

  test("valid config", () => {
    const r = PassthroughHeadersSchema.safeParse({
      name: "x",
      use: "passthrough_headers",
      allow: ["authorization", "content-type"],
    });
    expect(r.success).toBe(true);
  });
});

describe("passthrough_headers — behavior", () => {
  test("allowlist filter: drops disallowed headers", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "p",
        use: "passthrough_headers",
        allow: ["authorization", "content-type"],
      },
    ];
    const result = await applyRules(
      makeCtx({
        authorization: "Bearer abc",
        "content-type": "application/json",
        "x-stainless-arch": "x64",
        "x-stainless-os": "linux",
      }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(Object.keys(result.ctx.headers).sort()).toEqual([
      "authorization",
      "content-type",
    ]);
    expect(
      (result.applied[0]?.after as { headers_dropped: string[] })
        .headers_dropped,
    ).toContain("x-stainless-arch");
  });

  test("case-insensitive allowlist match", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "p",
        use: "passthrough_headers",
        allow: ["Authorization"],
      },
    ];
    const result = await applyRules(
      makeCtx({
        authorization: "Bearer abc",
        "x-junk": "drop",
      }),
      rules,
      snap,
    );
    expect(result.ctx.headers["authorization"]).toBe("Bearer abc");
  });

  test("empty allow → drops all headers", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "p", use: "passthrough_headers", allow: [] },
    ];
    const result = await applyRules(makeCtx({ "x-foo": "bar" }), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(Object.keys(result.ctx.headers)).toEqual([]);
  });

  test("input already a subset → applied: false (no-op)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "p",
        use: "passthrough_headers",
        allow: ["authorization", "content-type"],
      },
    ];
    const result = await applyRules(
      makeCtx({ authorization: "Bearer abc" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
  });
});
