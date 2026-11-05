/**
 * types.test.ts — F3+F9 force-import test for `ENGINE_VERSION`, plus
 * F5/M6 D-LOCK-2 coverage for `RegisteredRuleOpts.ctx_reads/ctx_writes`
 * defaults + explicit declarations.
 *
 * **Why this file exists.** Before M2.5 the only test that exercised the
 * `package.json`-derived `ENGINE_VERSION` was an indirect import via
 * apply/registry tests. M5 will bundle `transform/types.ts` into
 * `dist/main.js` via tsdown — and the JSON-import path was never
 * runtime-tested in a non-tree-shaken bundle. This test forces the import
 * AND asserts the value matches `package.json.version` so a missing or
 * stale `version.ts` (the build-time generated constant) fails loudly
 * instead of silently shipping the wrong version string.
 *
 * **M6 ctx-surface metadata (D-LOCK-2).** `register()` resolves
 * `ctx_reads` / `ctx_writes` to `["body"]` defaults so M3 rules behave
 * implicitly; M6 header-mutating rules opt-in to `["headers"]`. Lint
 * (D-LOCK-3) consumes these — these tests confirm the resolved-opts
 * surface lint reads from is correct.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };

import {
  get,
  register,
  reset as resetRegistry,
} from "~/lib/transform/registry";
import { ENGINE_VERSION } from "~/lib/transform/types";
import type { TransformContext, TransformResult } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
});

const noopBodyFn = (ctx: TransformContext): TransformResult => ({
  ctx,
  applied: true,
});

const noopSchema = z
  .object({
    name: z.string(),
    use: z.string(),
  })
  .passthrough();

describe("ENGINE_VERSION", () => {
  test("matches package.json version", () => {
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  test("is a non-empty semver string", () => {
    expect(typeof ENGINE_VERSION).toBe("string");
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("RegisteredRuleOpts ctx_reads/ctx_writes (F5/M6 D-LOCK-2)", () => {
  test("default-resolve: ctx_reads and ctx_writes both default to ['body'] when not provided", () => {
    register("default-rule", noopBodyFn, noopSchema);
    const reg = get("body", "default-rule");
    expect(reg).toBeDefined();
    expect(reg?.opts.ctx_reads).toEqual(["body"]);
    expect(reg?.opts.ctx_writes).toEqual(["body"]);
  });

  test("explicit ctx_reads: ['headers'] resolves through unchanged", () => {
    register("hdr-only-reader", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    const reg = get("body", "hdr-only-reader");
    expect(reg?.opts.ctx_reads).toEqual(["headers"]);
    expect(reg?.opts.ctx_writes).toEqual(["headers"]);
  });

  test("explicit ctx_reads: ['body','headers'] (both surfaces) resolves through unchanged", () => {
    register("redirect-like", noopBodyFn, noopSchema, {
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
    });
    const reg = get("body", "redirect-like");
    expect(reg?.opts.ctx_reads).toEqual(["body"]);
    expect(reg?.opts.ctx_writes).toEqual(["body", "headers"]);
  });

  test("explicit ctx_writes: [] (assertion-only rule) resolves through unchanged", () => {
    register("asserter", noopBodyFn, noopSchema, {
      ctx_reads: ["body"],
      ctx_writes: [],
    });
    const reg = get("body", "asserter");
    expect(reg?.opts.ctx_writes).toEqual([]);
  });

  test("ctx_reads/ctx_writes coexist with reads/writes (state-field manifest) — independent fields", () => {
    register("multi-meta", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
      reads: ["finalUsage"],
      writes: ["finalUsage"],
    });
    const reg = get("body", "multi-meta");
    expect(reg?.opts.ctx_reads).toEqual(["headers"]);
    expect(reg?.opts.ctx_writes).toEqual(["headers"]);
    expect(reg?.opts.reads).toEqual(["finalUsage"]);
    expect(reg?.opts.writes).toEqual(["finalUsage"]);
  });
});
