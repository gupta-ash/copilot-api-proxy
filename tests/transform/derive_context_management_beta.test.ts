/**
 * derive_context_management_beta.test.ts — per-rule unit tests for the M9
 * (D33) `derive_context_management_beta` body rule (M9 D-LOCK-4 +
 * D-LOCK-18).
 *
 * Coverage maps to M9 mini-audit items 22-28:
 *   - schema validation + registry metadata (ctx_reads/ctx_writes)
 *   - presence detection: body without context_management → applied:false
 *   - presence + missing header → header set to JUST the token
 *   - presence + header already contains token → applied:false (idempotent)
 *   - presence + header has unrelated tokens → unionCsv preserves
 *   - custom beta_token forward-compat
 *   - custom body_field name
 *   - D-LOCK-18 default materialization: omit beta_token + body_field →
 *     reads "context_management" + injects "context-management-2025-06-27"
 *
 * Includes mini-audit 21: docstring warning verbatim per D-LOCK-4 (the
 * source file's TSDoc carries the F15 warning; this file does not assert
 * docstring contents — that's a structural-spec concern verified by the
 * controller-side mini-audit, not the runtime test suite).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { DeriveContextManagementBetaSchema } from "~/lib/transform/derive_context_management_beta";
import "~/lib/transform/derive_context_management_beta";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/derive_context_management_beta");
  const { register } = await import("~/lib/transform/registry");
  register(
    "derive_context_management_beta",
    mod.derive_context_management_beta,
    mod.DeriveContextManagementBetaSchema,
    {
      ctx_reads: ["body", "headers"],
      ctx_writes: ["headers"],
      allow_override: true,
    },
  );
}

function makeCtx(
  body: unknown,
  headers: Record<string, string> = {},
): TransformContext {
  return {
    body,
    headers,
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("derive_context_management_beta — schema validation", () => {
  test("minimal valid config (defaults applied)", () => {
    const r = DeriveContextManagementBetaSchema.safeParse({
      name: "x",
      use: "derive_context_management_beta",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.beta_token).toBe("context-management-2025-06-27");
      expect(r.data.body_field).toBe("context_management");
    }
  });

  test("custom beta_token (forward-compat) accepted", () => {
    const r = DeriveContextManagementBetaSchema.safeParse({
      name: "x",
      use: "derive_context_management_beta",
      beta_token: "context-management-2026-01-01",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.beta_token).toBe("context-management-2026-01-01");
    }
  });

  test("custom body_field accepted", () => {
    const r = DeriveContextManagementBetaSchema.safeParse({
      name: "x",
      use: "derive_context_management_beta",
      body_field: "ctx_mgmt",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.body_field).toBe("ctx_mgmt");
    }
  });
});

describe("derive_context_management_beta — registry metadata (mini-audit 19)", () => {
  test("ctx_reads = ['body', 'headers'], ctx_writes = ['headers']", async () => {
    await registerRule();
    const reg = get("body", "derive_context_management_beta");
    expect(reg).toBeDefined();
    expect(reg?.opts.ctx_reads).toEqual(["body", "headers"]);
    expect(reg?.opts.ctx_writes).toEqual(["headers"]);
  });

  test("no response_shape declared", async () => {
    await registerRule();
    const reg = get("body", "derive_context_management_beta");
    expect(reg?.opts.response_shape).toBeUndefined();
  });
});

describe("derive_context_management_beta — behavior (D-LOCK-4 mini-audit 22-27)", () => {
  test("mini-audit 22: body with no context_management field → applied:false, header unchanged", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(
      { messages: [] },
      { "anthropic-beta": "claude-code-2025-11-19" },
    );
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["anthropic-beta"]).toBe("claude-code-2025-11-19");
  });

  test("mini-audit 23: body with context_management.edits=[] AND header missing → header set to JUST the token", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({ context_management: { edits: [] } });
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "context-management-2025-06-27",
    );
    const ar = result.applied[0];
    expect(ar?.before).toEqual({ "anthropic-beta": "" });
    expect(ar?.after).toEqual({
      "anthropic-beta": "context-management-2025-06-27",
    });
  });

  test("mini-audit 24: body with context_management AND header already contains the token → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(
      { context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } },
      { "anthropic-beta": "context-management-2025-06-27" },
    );
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "context-management-2025-06-27",
    );
  });

  test("mini-audit 25: body with context_management AND header has unrelated token → unionCsv preserves existing", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(
      { context_management: { edits: [] } },
      { "anthropic-beta": "claude-code-2025-11-19" },
    );
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    // unionCsv preserves LEFT order: existing tokens first, new token appended.
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "claude-code-2025-11-19, context-management-2025-06-27",
    );
  });

  test("mini-audit 26: custom beta_token (forward-compat) injected as configured", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({ context_management: { edits: [] } });
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_context_management_beta",
        beta_token: "context-management-2026-01-01",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "context-management-2026-01-01",
    );
  });

  test("mini-audit 27: custom body_field reads the alternate field name", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Body has ctx_mgmt (custom field) but NOT context_management (default).
    const ctx = makeCtx({ ctx_mgmt: { edits: [] } });
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_context_management_beta",
        body_field: "ctx_mgmt",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "context-management-2025-06-27",
    );
  });

  test("custom body_field absent in body → applied:false (defaults to context_management which IS present, but custom override matters)", async () => {
    await registerRule();
    const snap = snapshot("body");
    // Body has the default field, but operator pointed body_field at a
    // different name; rule should look for the configured name only.
    const ctx = makeCtx({ context_management: { edits: [] } });
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_context_management_beta",
        body_field: "nonexistent_field",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("non-object body → applied:false (defensive)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(null);
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
  });
});

describe("derive_context_management_beta — D-LOCK-18 default materialization (mini-audit 28)", () => {
  test("omitting beta_token + body_field → reads 'context_management' field + injects 'context-management-2025-06-27' token", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({ context_management: { edits: [] } });
    // Rule config OMITS both beta_token AND body_field — proves zod
    // defaults were materialized at runtime via Schema.parse.
    const rules: Rule[] = [
      { name: "r", use: "derive_context_management_beta" },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "context-management-2025-06-27",
    );
  });
});
