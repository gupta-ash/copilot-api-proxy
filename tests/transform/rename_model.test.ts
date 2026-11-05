/**
 * rename_model.test.ts — per-rule unit tests for rename_model (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import "~/lib/transform/rename_model";
import { RenameModelSchema } from "~/lib/transform/rename_model";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/rename_model");
  const { register } = await import("~/lib/transform/registry");
  register("rename_model", mod.rename_model, mod.RenameModelSchema, {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
    allow_override: true,
  });
}

function makeCtx(body: unknown, model = "claude-opus-4-7"): TransformContext {
  return {
    body,
    headers: {},
    route: "/v1/messages",
    model,
  };
}

describe("rename_model — schema validation", () => {
  test("must specify map OR from+to", () => {
    const r = RenameModelSchema.safeParse({
      name: "x",
      use: "rename_model",
    });
    expect(r.success).toBe(false);
  });

  test("from without to → invalid", () => {
    const r = RenameModelSchema.safeParse({
      name: "x",
      use: "rename_model",
      from: "claude-opus-4-7",
    });
    expect(r.success).toBe(false);
  });

  test("valid map-only config", () => {
    const r = RenameModelSchema.safeParse({
      name: "x",
      use: "rename_model",
      map: { "o3-mini": "o3" },
    });
    expect(r.success).toBe(true);
  });

  test("valid from+to regex config", () => {
    const r = RenameModelSchema.safeParse({
      name: "x",
      use: "rename_model",
      from: "^claude-(opus|sonnet)-(\\d+)-(\\d+)$",
      to: "claude-$1-$2.$3",
    });
    expect(r.success).toBe(true);
  });
});

describe("rename_model — behavior", () => {
  test("map: exact match (case-insensitive) rewrites body.model", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "O3-Mini" };
    const rules: Rule[] = [
      { name: "r", use: "rename_model", map: { "o3-mini": "o3" } },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as Record<string, unknown>).model).toBe("o3");
    expect(result.applied[0]?.before).toBe("O3-Mini");
    expect(result.applied[0]?.after).toBe("o3");
  });

  test("map: no match → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-opus-4.7" };
    const rules: Rule[] = [
      { name: "r", use: "rename_model", map: { "o3-mini": "o3" } },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
    expect((result.ctx.body as Record<string, unknown>).model).toBe(
      "claude-opus-4.7",
    );
  });

  test("from+to: claude hyphenated → dotted (bundle parity)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-opus-4-6" };
    const rules: Rule[] = [
      {
        name: "r",
        use: "rename_model",
        from: "^(claude-(?:opus|sonnet|haiku)-\\d+)-(\\d{1,2})\\b",
        to: "$1.$2",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as Record<string, unknown>).model).toBe(
      "claude-opus-4.6",
    );
  });

  test("from+to: dotted name passes through (no-op)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-opus-4.7" };
    const rules: Rule[] = [
      {
        name: "r",
        use: "rename_model",
        from: "^(claude-(?:opus|sonnet|haiku)-\\d+)-(\\d{1,2})\\b",
        to: "$1.$2",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("map + from+to: map wins on exact match", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude-opus-4-6" };
    const rules: Rule[] = [
      {
        name: "r",
        use: "rename_model",
        map: { "claude-opus-4-6": "claude-opus-mapped" },
        from: "^(claude-(?:opus|sonnet|haiku)-\\d+)-(\\d{1,2})\\b",
        to: "$1.$2",
      },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toHaveLength(1);
    expect((result.ctx.body as Record<string, unknown>).model).toBe(
      "claude-opus-mapped",
    );
  });

  test("body without .model field → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "r", use: "rename_model", map: { "o3-mini": "o3" } },
    ];
    const result = await applyRules(makeCtx({ messages: [] }), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("invalid regex `from` → applied: false (no throw)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = { model: "claude" };
    const rules: Rule[] = [
      { name: "r", use: "rename_model", from: "[invalid", to: "x" },
    ];
    const result = await applyRules(makeCtx(body), rules, snap);
    expect(result.applied).toEqual([]);
  });
});
