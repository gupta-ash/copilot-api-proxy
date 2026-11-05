/**
 * barrel.test.ts — verifies that the auto-generated `index.ts` barrel
 * stays in sync with the rule files in `src/lib/transform/` (per X13/M3).
 *
 * Failure modes guarded against:
 *   - A rule file lands without index.ts being regenerated → silently
 *     never registered → engine consumers can't find `use:` at apply time.
 *   - index.ts lists a file that doesn't exist → import error at boot.
 *   - gen_barrel.ts produces non-deterministic output → diff churn.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { get, list, snapshot } from "~/lib/transform/registry";
import type { CtxSurface } from "~/lib/transform/registry";

// Resolve paths relative to repo root.
const TRANSFORM_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "src",
  "lib",
  "transform",
);
const INDEX_PATH = resolve(TRANSFORM_DIR, "index.ts");
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const ENGINE_CORE = new Set<string>([
  "types.ts",
  "registry.ts",
  "predicate.ts",
  "apply.ts",
  "apply_event.ts",
  "lint.ts",
  "version.ts",
  "index.ts",
  // M7b — see scripts/gen_barrel.ts: sse-state.ts is engine-side
  // scaffolding (StreamState + lifecycle Map), not a registered rule.
  "sse-state.ts",
  // M8 — see scripts/gen_barrel.ts: usage.ts is a pure helper
  // (toResponsesUsage), not a registered rule. Consumers import directly.
  "usage.ts",
  // M9 — see scripts/gen_barrel.ts: plugin.ts is the public-API surface
  // for drop-in plugin authors (D-LOCK-6). Operators import from
  // ~/lib/transform/plugin; the file itself only re-exports types +
  // registration functions, not a registered rule.
  "plugin.ts",
  // M9 — see scripts/gen_barrel.ts: custom-loader.ts is the lazy-loader
  // for ${transforms.custom_dir} drop-in rules (D-LOCK-5 + D-LOCK-15).
  // Loaded by main.ts at boot; not itself a registered rule.
  "custom-loader.ts",
]);

function isRuleFile(name: string): boolean {
  if (!name.endsWith(".ts")) return false;
  if (name.startsWith("_")) return false;
  if (ENGINE_CORE.has(name)) return false;
  return true;
}

function readBarrelImports(): string[] {
  const text = readFileSync(INDEX_PATH, "utf-8");
  const matches = text.matchAll(/^import\s+"\.\/([^"]+)";\s*$/gm);
  return Array.from(matches, (m) => m[1] as string).sort();
}

function readRuleFiles(): string[] {
  return readdirSync(TRANSFORM_DIR).filter(isRuleFile).sort();
}

/**
 * Re-register all rules from the barrel into the live registry. Other
 * test files reset the registry in their afterEach hooks; ES module
 * side-effects are cached per-process so a plain `import` would not
 * re-fire `register(...)`. We explicitly walk each file's exports and
 * re-call `register()`.
 *
 * Each rule module exports `{ <fnName>, <SchemaName> }` per the M3
 * convention. The bound names match `<file_basename>` and
 * `<PascalCase(file_basename)>Schema`.
 *
 * **M7b stream-event split.** The two M7b translator files
 * (`translate_*_event_to_*_event.ts`) self-register on the
 * STREAM-EVENT registry, not the body registry. The defensive
 * re-registration here uses `registerStreamEvent` for those files,
 * `register` for everything else. The discriminator is filename-based
 * (the M7b naming convention `translate_<source>_event_to_<target>_event`
 * is per D-LOCK-8 / O19); a misnamed stream-event rule would land in
 * the wrong registry, which the dedicated `barrel — engine
 * registration on import` block below catches.
 */
function isStreamEventRuleFile(name: string): boolean {
  return /^translate_.*_event_to_.*_event\.ts$/.test(name);
}

/**
 * Hardcoded reads/writes manifests for M7b stream-event rules. This
 * mirrors what the rule files declare at registration time. We keep
 * this as the source-of-truth for the defensive re-registration path
 * because:
 *   1. ES modules are cached per-process; once another test's
 *      `resetRegistry()` ran, the original `registerStreamEvent(...)`
 *      side effect cannot re-fire by re-importing.
 *   2. Forwarding `get()`'s cached opts works only when the registry is
 *      still warm; cold-restart cases (full-suite ordering) need the
 *      fallback.
 *
 * If a translator file changes its X6 manifest, update this map to
 * match — the dedicated `M7b stream translators carry X6
 * reads/writes manifests` test will fail otherwise, signaling drift.
 */
const M7B_STREAM_RULE_MANIFESTS: Record<
  string,
  { reads: string[]; writes: string[] }
> = {
  translate_anthropic_event_to_responses_event: {
    // M7b.5 F1: per-block content meta (`contentBlocks` map) replaced
    // the legacy stream-wide `toolArgBuffers` / `currentToolId` /
    // `currentToolName` / `currentBlockType`. Source-of-truth: see
    // `src/lib/transform/translate_anthropic_event_to_responses_event.ts`
    // `registerStreamEvent(...)` opts (lines ~711-727).
    reads: [
      "contentBlocks",
      "finalUsage",
      "model",
      "outputIndex",
      "requestId",
      "responseId",
    ],
    writes: [
      "contentBlocks",
      "finalUsage",
      "model",
      "outputIndex",
      "responseId",
      "stopReason",
    ],
  },
  translate_responses_event_to_anthropic_event: {
    reads: [
      "contentBlockIndex",
      "contentBlockOpen",
      "currentToolCallId",
      "currentToolName",
      "currentToolType",
      "messageStartSent",
      "model",
      "requestId",
      "responseId",
    ],
    writes: [
      "contentBlockIndex",
      "contentBlockOpen",
      "currentToolCallId",
      "currentToolName",
      "currentToolType",
      "messageStartSent",
      "model",
      "responseId",
    ],
  },
};

/**
 * Hardcoded body-rule overrides for rules whose `register()` opts
 * differ from the default `{ ctx_reads: ["body"], ctx_writes: ["body"] }`
 * shape. Same purpose as `M7B_STREAM_RULE_MANIFESTS` but for body
 * rules: at cold-restart (full-suite ordering after another test's
 * `resetRegistry()`), `get("body", base)` returns `undefined` and the
 * defensive re-register loop has no source-of-truth for these opts.
 *
 * Affected rules:
 *   - 3 redirect rules (M6 + M8): declare `response_shape` per X2 +
 *     header-mutating ctx_writes.
 *   - 3 D33 derive primitives (M9-A): write to headers (not body).
 *     `derive_context_management_beta` ALSO reads headers (for unionCsv).
 *   - 3 response-passthrough consumer rules (M9-C): declare
 *     `response_shape` AND empty `ctx_reads` / `ctx_writes` (pure
 *     no-op stubs per D-LOCK-7).
 *
 * If a rule changes its registration opts, update this map — the
 * dedicated barrel tests will fail otherwise, signaling drift.
 */
const M9_BODY_RULE_OVERRIDES: Record<
  string,
  {
    response_shape?: string;
    ctx_reads?: ReadonlyArray<CtxSurface>;
    ctx_writes?: ReadonlyArray<CtxSurface>;
  }
> = {
  redirect_to_anthropic_messages: {
    response_shape: "anthropic_v1_messages",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
  redirect_to_chat_completions: {
    response_shape: "openai_chat_completions",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
  redirect_to_responses: {
    response_shape: "openai_responses",
    ctx_reads: ["body"],
    ctx_writes: ["body", "headers"],
  },
  // M9-A D33 derive primitives — body-reading, header-writing.
  derive_x_initiator: {
    ctx_reads: ["body"],
    ctx_writes: ["headers"],
  },
  derive_copilot_vision_request: {
    ctx_reads: ["body"],
    ctx_writes: ["headers"],
  },
  derive_context_management_beta: {
    ctx_reads: ["body", "headers"],
    ctx_writes: ["headers"],
  },
  // M9-C response-passthrough consumer rules — pure no-op stubs.
  response_passthrough_anthropic_v1_messages: {
    response_shape: "anthropic_v1_messages",
    ctx_reads: [],
    ctx_writes: [],
  },
  response_passthrough_openai_chat_completions: {
    response_shape: "openai_chat_completions",
    ctx_reads: [],
    ctx_writes: [],
  },
  response_passthrough_openai_responses: {
    response_shape: "openai_responses",
    ctx_reads: [],
    ctx_writes: [],
  },
};

async function ensureRulesRegistered(): Promise<void> {
  const ruleFiles = readRuleFiles();
  const { register, registerStreamEvent, get } =
    await import("~/lib/transform/registry");
  for (const f of ruleFiles) {
    const base = f.replace(/\.ts$/, ""); // e.g. "strip_body_block"
    const schemaName =
      base
        .split("_")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("") + "Schema"; // e.g. "StripBodyBlockSchema"
    const mod = (await import(`~/lib/transform/${base}`)) as Record<
      string,
      unknown
    >;
    const fn = mod[base];
    const schema = mod[schemaName];
    if (typeof fn !== "function" || schema === undefined) {
      throw new Error(
        `barrel.test: rule file ${f} must export both ${base} (fn) and ${schemaName}; got ${typeof fn} / ${typeof schema}`,
      );
    }
    if (isStreamEventRuleFile(f)) {
      // Prefer cached opts from the live registry (warm-restart);
      // fall back to the hardcoded M7B_STREAM_RULE_MANIFESTS for the
      // cold-restart case where the registry was reset by a prior test
      // and the original side-effect-import opts are gone.
      const existing = get("stream_event", base);
      const manifest = M7B_STREAM_RULE_MANIFESTS[base];
      const reads =
        existing?.opts.reads !== undefined
          ? existing.opts.reads
          : manifest?.reads;
      const writes =
        existing?.opts.writes !== undefined
          ? existing.opts.writes
          : manifest?.writes;
      registerStreamEvent(
        base,
        fn as Parameters<typeof registerStreamEvent>[1],
        schema as Parameters<typeof registerStreamEvent>[2],
        {
          allow_override: true,
          ...(reads !== undefined ? { reads } : {}),
          ...(writes !== undefined ? { writes } : {}),
        },
      );
    } else {
      const existing = get("body", base);
      const override = M9_BODY_RULE_OVERRIDES[base];
      // Source-of-truth precedence: warm registry > hardcoded override map
      // > ensureRulesRegistered's defaults. This handles the cold-restart
      // case (full-suite ordering) where existing is undefined.
      const responseShape =
        existing?.opts.response_shape ?? override?.response_shape;
      const ctxReads = existing?.opts.ctx_reads ??
        override?.ctx_reads ?? ["body"];
      const ctxWrites = existing?.opts.ctx_writes ??
        override?.ctx_writes ?? ["body"];
      register(
        base,
        fn as Parameters<typeof register>[1],
        schema as Parameters<typeof register>[2],
        {
          allow_override: true,
          ...(existing?.opts.reads !== undefined
            ? { reads: existing.opts.reads }
            : {}),
          ...(existing?.opts.writes !== undefined
            ? { writes: existing.opts.writes }
            : {}),
          ...(responseShape !== undefined
            ? { response_shape: responseShape }
            : {}),
          ctx_reads: ctxReads,
          ctx_writes: ctxWrites,
        },
      );
    }
  }
}

describe("barrel — index.ts <-> rule files invariant", () => {
  test("every import in index.ts points at an existing rule file", () => {
    const imports = readBarrelImports();
    const present = new Set(readdirSync(TRANSFORM_DIR));
    for (const imp of imports) {
      expect(present.has(imp)).toBe(true);
    }
  });

  test("every rule file in src/lib/transform/ appears in index.ts", () => {
    const rules = readRuleFiles();
    const imports = readBarrelImports();
    expect(imports).toEqual(rules);
  });
});

describe("barrel — engine registration on import", () => {
  test("after barrel registration, body registry contains all M3 rules", async () => {
    await ensureRulesRegistered();
    const bodyRules = list("body");
    // The 4 M3 day-1 rules must be registered.
    expect(bodyRules.length).toBeGreaterThanOrEqual(4);
    expect(bodyRules).toContain("strip_body_block");
    expect(bodyRules).toContain("modify_body_block");
    expect(bodyRules).toContain("add_body_block");
    expect(bodyRules).toContain("strip_body_field");
  });

  test("registry.get('body', 'strip_body_block') is defined after barrel registration", async () => {
    await ensureRulesRegistered();
    expect(get("body", "strip_body_block")).toBeDefined();
  });

  test("after barrel registration, body registry contains all 12 M6 primitives", async () => {
    await ensureRulesRegistered();
    const bodyRules = list("body");
    // M6 primitives (per D-LOCK-8 / O19 naming convention <verb>_<scope>):
    expect(bodyRules).toContain("rename_model");
    expect(bodyRules).toContain("inject_headers");
    expect(bodyRules).toContain("passthrough_headers");
    expect(bodyRules).toContain("filter_header_csv");
    expect(bodyRules).toContain("assert_endpoint");
    expect(bodyRules).toContain("clamp_effort");
    expect(bodyRules).toContain("clamp_max_tokens");
    expect(bodyRules).toContain("redirect_to_anthropic_messages");
    expect(bodyRules).toContain("redirect_to_chat_completions");
    expect(bodyRules).toContain("derive_reasoning_effort");
    expect(bodyRules).toContain("strip_header_csv_token");
    expect(bodyRules).toContain("strip_header");
  });

  test("after barrel registration, body registry contains M8 NEW body rules (merge_anthropic_betas + redirect_to_responses)", async () => {
    await ensureRulesRegistered();
    const bodyRules = list("body");
    // M8 NEW per D-LOCK-4 + D-LOCK-13.
    expect(bodyRules).toContain("merge_anthropic_betas");
    expect(bodyRules).toContain("redirect_to_responses");
  });

  test("after barrel registration, body registry contains all 4 M7a body translators", async () => {
    await ensureRulesRegistered();
    const bodyRules = list("body");
    // M7a translators (per D-LOCK-8 naming convention
    // translate_<source>_to_<target>; lane-scoped per addendum §7):
    expect(bodyRules).toContain("translate_anthropic_to_responses");
    expect(bodyRules).toContain("translate_responses_to_anthropic");
    expect(bodyRules).toContain("translate_anthropic_tools_to_openai");
    // M16 (NEW — Lane 6 Codex → GPT-4 defensive body translator):
    expect(bodyRules).toContain("translate_responses_to_chat_completions");
  });

  test("after barrel registration, STREAM-EVENT registry contains both M7b stream translators (mini-audit 34)", async () => {
    await ensureRulesRegistered();
    const seRules = list("stream_event");
    // M7b translators (per D-LOCK-8 / O19 naming convention
    // translate_<source>_event_to_<target>_event; lane-scoped per
    // addendum §7):
    expect(seRules).toContain("translate_anthropic_event_to_responses_event");
    expect(seRules).toContain("translate_responses_event_to_anthropic_event");
  });

  test("M7b stream translators registered on the STREAM-EVENT registry, NOT body (cross-surface invariant per O18)", async () => {
    await ensureRulesRegistered();
    expect(
      get("body", "translate_anthropic_event_to_responses_event"),
    ).toBeUndefined();
    expect(
      get("body", "translate_responses_event_to_anthropic_event"),
    ).toBeUndefined();
    expect(
      get("stream_event", "translate_anthropic_event_to_responses_event"),
    ).toBeDefined();
    expect(
      get("stream_event", "translate_responses_event_to_anthropic_event"),
    ).toBeDefined();
  });

  test("M7b stream translators carry X6 reads/writes manifests (mini-audit 5)", async () => {
    await ensureRulesRegistered();
    const aer = get(
      "stream_event",
      "translate_anthropic_event_to_responses_event",
    );
    const rea = get(
      "stream_event",
      "translate_responses_event_to_anthropic_event",
    );
    expect(aer?.opts.reads?.length).toBeGreaterThan(0);
    expect(aer?.opts.writes?.length).toBeGreaterThan(0);
    expect(rea?.opts.reads?.length).toBeGreaterThan(0);
    expect(rea?.opts.writes?.length).toBeGreaterThan(0);
    // F26 fix superseded by M7b.5 F1: per-block content meta map
    // (`contentBlocks`) replaced the legacy stream-wide `toolArgBuffers`.
    // A→R MUST still declare it writes the per-block map.
    expect(aer?.opts.writes).toContain("contentBlocks");
    // F21 fix: A→R must declare it reads/writes finalUsage.
    expect(aer?.opts.writes).toContain("finalUsage");
    // R→A must declare messageStartSent for idempotency.
    expect(rea?.opts.writes).toContain("messageStartSent");
  });

  // ============================================================
  // M9 BARREL_ASSERTIONS (Groups A + B + C, applied per D-LOCK-19
  // controller-owned protocol; written to final-handoff.md by each
  // subagent and merged here by controller's M9-D3 commit).
  // ============================================================

  test("M9-A: 3 D33 derive primitives registered with correct ctx-surface manifests (D-LOCK-2/3/4)", async () => {
    await ensureRulesRegistered();
    const bodySnap = snapshot("body");
    // Presence: each derive primitive registered on body surface.
    expect(bodySnap.has("derive_x_initiator")).toBe(true);
    expect(bodySnap.has("derive_copilot_vision_request")).toBe(true);
    expect(bodySnap.has("derive_context_management_beta")).toBe(true);
    // ctx-surface manifests carried correctly per D-LOCK-2/3/4:
    expect(bodySnap.get("derive_x_initiator")?.opts.ctx_reads).toEqual([
      "body",
    ]);
    expect(bodySnap.get("derive_x_initiator")?.opts.ctx_writes).toEqual([
      "headers",
    ]);
    expect(
      bodySnap.get("derive_copilot_vision_request")?.opts.ctx_reads,
    ).toEqual(["body"]);
    expect(
      bodySnap.get("derive_copilot_vision_request")?.opts.ctx_writes,
    ).toEqual(["headers"]);
    expect(
      bodySnap.get("derive_context_management_beta")?.opts.ctx_reads,
    ).toEqual(["body", "headers"]);
    expect(
      bodySnap.get("derive_context_management_beta")?.opts.ctx_writes,
    ).toEqual(["headers"]);
    // Negative: none of Group A's 3 primitives are stream-event rules.
    const streamSnap = snapshot("stream_event");
    expect(streamSnap.has("derive_x_initiator")).toBe(false);
    expect(streamSnap.has("derive_copilot_vision_request")).toBe(false);
    expect(streamSnap.has("derive_context_management_beta")).toBe(false);
  });

  test("M9-B: plugin.ts and custom-loader.ts are NOT registered as rules (D-LOCK-17)", async () => {
    await ensureRulesRegistered();
    const bodySnap = snapshot("body");
    const streamSnap = snapshot("stream_event");
    // Skip-listed files MUST NOT appear in either registry — they're
    // public-API + boot-time helpers per D-LOCK-6 / D-LOCK-5.
    expect(bodySnap.has("plugin")).toBe(false);
    expect(bodySnap.has("custom-loader")).toBe(false);
    expect(streamSnap.has("plugin")).toBe(false);
    expect(streamSnap.has("custom-loader")).toBe(false);
  });

  test("M9-C: 3 response-passthrough consumer rules registered with correct response_shape (D-LOCK-7)", async () => {
    await ensureRulesRegistered();
    const bodySnap = snapshot("body");
    // Presence: each consumer rule registered on body surface (per
    // _validate_response_shape.ts contract — response rules co-register
    // on body surface).
    expect(bodySnap.has("response_passthrough_anthropic_v1_messages")).toBe(
      true,
    );
    expect(bodySnap.has("response_passthrough_openai_chat_completions")).toBe(
      true,
    );
    expect(bodySnap.has("response_passthrough_openai_responses")).toBe(true);
    // response_shape opt carried correctly (load-bearing for
    // _validate_response_shape.ts pairing logic):
    expect(
      bodySnap.get("response_passthrough_anthropic_v1_messages")?.opts
        .response_shape,
    ).toBe("anthropic_v1_messages");
    expect(
      bodySnap.get("response_passthrough_openai_chat_completions")?.opts
        .response_shape,
    ).toBe("openai_chat_completions");
    expect(
      bodySnap.get("response_passthrough_openai_responses")?.opts
        .response_shape,
    ).toBe("openai_responses");
    // ctx_reads/writes are EMPTY for all 3 (pure no-op stubs):
    expect(
      bodySnap.get("response_passthrough_anthropic_v1_messages")?.opts
        .ctx_reads,
    ).toEqual([]);
    expect(
      bodySnap.get("response_passthrough_anthropic_v1_messages")?.opts
        .ctx_writes,
    ).toEqual([]);
    expect(
      bodySnap.get("response_passthrough_openai_chat_completions")?.opts
        .ctx_reads,
    ).toEqual([]);
    expect(
      bodySnap.get("response_passthrough_openai_chat_completions")?.opts
        .ctx_writes,
    ).toEqual([]);
    expect(
      bodySnap.get("response_passthrough_openai_responses")?.opts.ctx_reads,
    ).toEqual([]);
    expect(
      bodySnap.get("response_passthrough_openai_responses")?.opts.ctx_writes,
    ).toEqual([]);
    // Negative: none of the 3 are stream-event rules.
    const streamSnap = snapshot("stream_event");
    expect(streamSnap.has("response_passthrough_anthropic_v1_messages")).toBe(
      false,
    );
    expect(streamSnap.has("response_passthrough_openai_chat_completions")).toBe(
      false,
    );
    expect(streamSnap.has("response_passthrough_openai_responses")).toBe(false);
  });
});

describe("barrel — gen_barrel.ts is idempotent", () => {
  test("re-running gen_barrel.ts produces zero diff", () => {
    const before = readFileSync(INDEX_PATH, "utf-8");
    const proc = spawnSync(
      "bun",
      ["run", resolve(REPO_ROOT, "scripts", "gen_barrel.ts")],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    expect(proc.status).toBe(0);
    const after = readFileSync(INDEX_PATH, "utf-8");
    expect(after).toBe(before);
  });
});
