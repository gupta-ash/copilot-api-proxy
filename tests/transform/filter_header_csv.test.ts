/**
 * filter_header_csv.test.ts — per-rule unit tests for filter_header_csv (M6).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { FilterHeaderCsvSchema } from "~/lib/transform/filter_header_csv";
import "~/lib/transform/filter_header_csv";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import { reset as resetRegistry, snapshot } from "~/lib/transform/registry";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/filter_header_csv");
  const { register } = await import("~/lib/transform/registry");
  register(
    "filter_header_csv",
    mod.filter_header_csv,
    mod.FilterHeaderCsvSchema,
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

describe("filter_header_csv — schema validation", () => {
  test("missing header/allow → invalid", () => {
    expect(
      FilterHeaderCsvSchema.safeParse({
        name: "x",
        use: "filter_header_csv",
        allow: ["a"],
      }).success,
    ).toBe(false);
    expect(
      FilterHeaderCsvSchema.safeParse({
        name: "x",
        use: "filter_header_csv",
        header: "anthropic-beta",
      }).success,
    ).toBe(false);
  });

  test("valid config", () => {
    const r = FilterHeaderCsvSchema.safeParse({
      name: "x",
      use: "filter_header_csv",
      header: "anthropic-beta",
      allow: ["claude-code-20250219"],
    });
    expect(r.success).toBe(true);
  });
});

describe("filter_header_csv — behavior", () => {
  test("typical anthropic-beta filter (drops one disallowed token)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "f",
        use: "filter_header_csv",
        header: "anthropic-beta",
        allow: ["claude-code-20250219", "advanced-tool-use-2025-11-20"],
      },
    ];
    const result = await applyRules(
      makeCtx({
        "anthropic-beta":
          "claude-code-20250219, context-1m-2025-08-07, advanced-tool-use-2025-11-20",
      }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "claude-code-20250219, advanced-tool-use-2025-11-20",
    );
    const after = result.applied[0]?.after as {
      header_name: string;
      value: string;
      dropped: string[];
    };
    expect(after.dropped).toEqual(["context-1m-2025-08-07"]);
  });

  test("empty value → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "f",
        use: "filter_header_csv",
        header: "anthropic-beta",
        allow: ["claude-code-20250219"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
  });

  test("all tokens filtered → header value becomes empty string", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "f",
        use: "filter_header_csv",
        header: "anthropic-beta",
        allow: [],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe("");
  });

  test("case-sensitive token match (Anthropic-Beta semantics per F14)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "f",
        use: "filter_header_csv",
        header: "anthropic-beta",
        // Allowlist with capital A — input has lowercase a → should drop.
        allow: ["Allowed-Token"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "allowed-token, Allowed-Token" }),
      rules,
      snap,
    );
    expect(result.ctx.headers["anthropic-beta"]).toBe("Allowed-Token");
  });

  test("missing header → applied: false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "f",
        use: "filter_header_csv",
        header: "anthropic-beta",
        allow: ["x"],
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toEqual([]);
  });
});
