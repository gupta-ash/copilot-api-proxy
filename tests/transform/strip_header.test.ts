/**
 * strip_header.test.ts — per-rule unit tests for strip_header (M6 F5
 * deny-list addendum).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import { StripHeaderSchema } from "~/lib/transform/strip_header";
import "~/lib/transform/strip_header";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/strip_header");
  const { register } = await import("~/lib/transform/registry");
  register("strip_header", mod.strip_header, mod.StripHeaderSchema, {
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

describe("strip_header — schema validation", () => {
  test("missing headers → invalid", () => {
    expect(
      StripHeaderSchema.safeParse({ name: "x", use: "strip_header" }).success,
    ).toBe(false);
  });

  test("empty headers array → invalid (min 1)", () => {
    expect(
      StripHeaderSchema.safeParse({
        name: "x",
        use: "strip_header",
        headers: [],
      }).success,
    ).toBe(false);
  });

  test("valid config", () => {
    const r = StripHeaderSchema.safeParse({
      name: "x",
      use: "strip_header",
      headers: ["x-stainless-arch"],
    });
    expect(r.success).toBe(true);
  });
});

describe("strip_header — behavior", () => {
  test("drops named header(s)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header",
        headers: ["x-stainless-arch", "x-stainless-os"],
      },
    ];
    const result = await applyRules(
      makeCtx({
        authorization: "Bearer abc",
        "x-stainless-arch": "x64",
        "x-stainless-os": "linux",
      }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-stainless-arch"]).toBeUndefined();
    expect(result.ctx.headers["x-stainless-os"]).toBeUndefined();
    expect(result.ctx.headers["authorization"]).toBe("Bearer abc");
    const after = result.applied[0]?.after as { headers_dropped: string[] };
    expect(after.headers_dropped).toContain("x-stainless-arch");
    expect(after.headers_dropped).toContain("x-stainless-os");
  });

  test("missing header → applied: false (when ALL miss)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "s", use: "strip_header", headers: ["ghost"] },
    ];
    const result = await applyRules(
      makeCtx({ authorization: "Bearer abc" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["authorization"]).toBe("Bearer abc");
  });

  test("case-insensitive name match", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "s", use: "strip_header", headers: ["X-Stainless-Arch"] },
    ];
    const result = await applyRules(
      makeCtx({ "x-stainless-arch": "x64" }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-stainless-arch"]).toBeUndefined();
  });

  test("multi-header drop emits headers_dropped provenance", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "s", use: "strip_header", headers: ["a", "b", "c"] },
    ];
    const result = await applyRules(
      makeCtx({ a: "1", b: "2", c: "3", d: "4" }),
      rules,
      snap,
    );
    const after = result.applied[0]?.after as { headers_dropped: string[] };
    expect(after.headers_dropped.sort()).toEqual(["a", "b", "c"]);
    expect(result.ctx.headers["d"]).toBe("4");
  });
});
