/**
 * strip_header_csv_token.test.ts — per-rule unit tests for
 * strip_header_csv_token (M6 F5 deny-list addendum), including the
 * mandatory F4 PROPAGATION TEST per D-LOCK-5.
 *
 * **Test inventory** (per spec § Bucket D row for this file):
 *   (a) drop one token from a multi-token CSV
 *   (b) deny token absent → no-op
 *   (c) header missing → no-op
 *   (d) header case-insensitive match
 *   (e) realistic anthropic-beta scenario denying `context-1m-2025-08-07`
 *       from `claude-code-20250219, context-1m-2025-08-07, effort-2025-11-24`
 *       (per F33 / sister project D6 production verification)
 *   (f) **D-LOCK-5 PROPAGATION TEST** — chain two body rules where
 *       rule#1 mutates `ctx.headers["anthropic-beta"]` and rule#2 reads
 *       `ctx.headers["anthropic-beta"]`. Assert rule#2 sees rule#1's
 *       mutation under BOTH `mutate_in_place: true` AND `false`.
 *
 *   Plus: provenance fields per D-LOCK-6 — `header_name/before/after/dropped`
 *   ALWAYS, plus `beta_in/beta_out/beta_dropped` aliases when the header
 *   is `anthropic-beta`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  register,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { StripHeaderCsvTokenSchema } from "~/lib/transform/strip_header_csv_token";
import "~/lib/transform/strip_header_csv_token";
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
  const mod = await import("~/lib/transform/strip_header_csv_token");
  register(
    "strip_header_csv_token",
    mod.strip_header_csv_token,
    mod.StripHeaderCsvTokenSchema,
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

describe("strip_header_csv_token — schema validation", () => {
  test("missing header/deny → invalid", () => {
    expect(
      StripHeaderCsvTokenSchema.safeParse({
        name: "x",
        use: "strip_header_csv_token",
        deny: ["a"],
      }).success,
    ).toBe(false);
    expect(
      StripHeaderCsvTokenSchema.safeParse({
        name: "x",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
      }).success,
    ).toBe(false);
  });

  test("valid config", () => {
    const r = StripHeaderCsvTokenSchema.safeParse({
      name: "x",
      use: "strip_header_csv_token",
      header: "anthropic-beta",
      deny: ["context-1m-2025-08-07"],
    });
    expect(r.success).toBe(true);
  });
});

describe("strip_header_csv_token — behavior", () => {
  test("(a) drop one token from multi-token CSV", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe("a, c");
  });

  test("(b) deny token absent → no-op (applied: false)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["never-present"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["anthropic-beta"]).toBe("a, b, c");
  });

  test("(c) header missing → no-op (applied: false)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(makeCtx({}), rules, snap);
    expect(result.applied).toEqual([]);
  });

  test("(d) header case-insensitive match", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "Anthropic-Beta", // capitalized in config
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }), // lowercase in dict
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe("a, c");
  });

  test("(e) realistic anthropic-beta scenario — denies context-1m-2025-08-07 (F33 / sister D6)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "deny_context_1m",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["context-1m-2025-08-07"],
      },
    ];
    const result = await applyRules(
      makeCtx({
        "anthropic-beta":
          "claude-code-20250219, context-1m-2025-08-07, effort-2025-11-24",
      }),
      rules,
      snap,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["anthropic-beta"]).toBe(
      "claude-code-20250219, effort-2025-11-24",
    );
  });

  test("provenance: emits header_name/before/after/dropped (canonical fields)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }),
      rules,
      snap,
    );
    const before = result.applied[0]?.before as Record<string, unknown>;
    const after = result.applied[0]?.after as Record<string, unknown>;
    expect(before["header_name"]).toBe("anthropic-beta");
    expect(before["value"]).toBe("a, b, c");
    expect(after["header_name"]).toBe("anthropic-beta");
    expect(after["value"]).toBe("a, c");
    expect(after["dropped"]).toEqual(["b"]);
  });

  test("provenance: emits beta_in/beta_out/beta_dropped aliases (anthropic-beta only, per D-LOCK-6 / sister D5)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a, b, c" }),
      rules,
      snap,
    );
    const before = result.applied[0]?.before as Record<string, unknown>;
    const after = result.applied[0]?.after as Record<string, unknown>;
    expect(before["beta_in"]).toBe("a, b, c");
    expect(after["beta_out"]).toBe("a, c");
    expect(after["beta_dropped"]).toEqual(["b"]);
  });

  test("provenance: NON-anthropic-beta header does NOT emit beta_* aliases", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "x-csv-list",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "x-csv-list": "a, b, c" }),
      rules,
      snap,
    );
    const before = result.applied[0]?.before as Record<string, unknown>;
    const after = result.applied[0]?.after as Record<string, unknown>;
    expect(before["beta_in"]).toBeUndefined();
    expect(after["beta_out"]).toBeUndefined();
    expect(after["beta_dropped"]).toBeUndefined();
  });

  test("trailing-comma input value (a,b,) handled cleanly", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "a,b," }),
      rules,
      snap,
    );
    expect(result.ctx.headers["anthropic-beta"]).toBe("a");
  });

  test('empty CSV value ("") → no-op (no tokens to drop)', async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "s",
        use: "strip_header_csv_token",
        header: "anthropic-beta",
        deny: ["b"],
      },
    ];
    const result = await applyRules(
      makeCtx({ "anthropic-beta": "" }),
      rules,
      snap,
    );
    expect(result.applied).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// (f) D-LOCK-5 PROPAGATION TEST — mandatory before M6 ships.
// ----------------------------------------------------------------------------

describe("strip_header_csv_token — F4 propagation (D-LOCK-5)", () => {
  /**
   * Inline schema for the test-only "header sniffer" rule. Keeps the test
   * self-contained and avoids polluting the production registry with
   * test-only rule files.
   */
  const sniffSchema = z
    .object({
      name: z.string(),
      use: z.literal("test_header_sniffer"),
      header: z.string(),
    })
    .passthrough();

  test("F4 propagation — chained header rules see prior mutations under mutate_in_place=true AND mutate_in_place=false", async () => {
    await registerRule();
    // 'rename strip rule registration' done above with default
    // mutate_in_place: true. We re-register with both true and false in
    // turn for the propagation test below.

    // For each mutate_in_place value, do a clean register-and-test cycle.
    for (const mip of [true, false] as const) {
      // Reset between iterations so each gets a clean registry.
      resetRegistry();
      resetPredicate();

      // Register strip_header_csv_token with the chosen mutate_in_place.
      const stripMod = await import("~/lib/transform/strip_header_csv_token");
      register(
        "strip_header_csv_token",
        stripMod.strip_header_csv_token,
        stripMod.StripHeaderCsvTokenSchema,
        {
          ctx_reads: ["headers"],
          ctx_writes: ["headers"],
          mutate_in_place: mip,
          allow_override: true,
        },
      );

      // Register a closure-captured "header sniffer" rule downstream that
      // records what value of `anthropic-beta` it sees.
      let sniffed: string | undefined;
      const sniffer: TransformFn = (
        ctx: TransformContext,
        options: unknown,
      ): TransformResult => {
        const opts = options as { header: string };
        sniffed = ctx.headers[opts.header.toLowerCase()];
        return { ctx, applied: false };
      };
      register("test_header_sniffer", sniffer, sniffSchema, {
        ctx_reads: ["headers"],
        ctx_writes: [],
        mutate_in_place: mip,
        allow_override: true,
      });

      const snap = snapshot("body");
      const rules: Rule[] = [
        // rule#1: strip "context-1m-2025-08-07"
        {
          name: "deny_context_1m",
          use: "strip_header_csv_token",
          header: "anthropic-beta",
          deny: ["context-1m-2025-08-07"],
        },
        // rule#2: read anthropic-beta and capture
        {
          name: "sniff_beta",
          use: "test_header_sniffer",
          header: "anthropic-beta",
        },
      ];

      const initialCtx = makeCtx({
        "anthropic-beta":
          "claude-code-20250219, context-1m-2025-08-07, effort-2025-11-24",
      });
      const result = await applyRules(initialCtx, rules, snap);

      // The sniffer MUST have observed the post-mutation value (rule#1's
      // output), regardless of mutate_in_place mode.
      expect(sniffed).toBe("claude-code-20250219, effort-2025-11-24");
      // Final ctx headers should also reflect the mutation.
      expect(result.ctx.headers["anthropic-beta"]).toBe(
        "claude-code-20250219, effort-2025-11-24",
      );
    }
  });
});
