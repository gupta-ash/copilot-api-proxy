/**
 * beta_policy_apply.test.ts — integration test for the anthropic-beta policy
 * (Feature D1/D3): applyBetaPolicy rewrites a config's beta lanes, then the
 * transform engine (applyRules) is run over a real header context to prove the
 * OUTBOUND `anthropic-beta` value behaves per mode.
 *
 *   - denylist  — a denied token is stripped; UNKNOWN (upstream-accepted) betas
 *     PASS THROUGH (the whole point of the denylist); advanced-tool-use is merged.
 *   - allowlist — only allow-list tokens survive (unknown betas dropped); the
 *     pre-D1 fail-safe posture.
 *   - strip_all — the anthropic-beta header is removed entirely.
 *
 * Uses a minimal 2-beta-lane + 1-gpt-lane config (parse-time registry needs are
 * force-registered in beforeAll — see note there) so the test is robust to the
 * order Bun runs test files in. A separate registry-free text assertion guards
 * config/default.yaml's beta wiring end-to-end.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules (first-run case)
import {
  applyBetaPolicy,
  type BetaPolicyMode,
} from "~/lib/apply-beta-policy.ts";
import { applyRules } from "~/lib/transform/apply.ts";
import {
  filter_header_csv,
  FilterHeaderCsvSchema,
} from "~/lib/transform/filter_header_csv.ts";
import {
  inject_headers,
  InjectHeadersSchema,
} from "~/lib/transform/inject_headers.ts";
import {
  merge_anthropic_betas,
  MergeAnthropicBetasSchema,
} from "~/lib/transform/merge_anthropic_betas.ts";
import { register, snapshot } from "~/lib/transform/registry.ts";
import {
  strip_header,
  StripHeaderSchema,
} from "~/lib/transform/strip_header.ts";
import {
  strip_header_csv_token,
  StripHeaderCsvTokenSchema,
} from "~/lib/transform/strip_header_csv_token.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";
import type { Rule, TransformContext } from "~/lib/transform/types.ts";

// The body registry is a shared singleton across test files; a prior file may
// have reset() + partially re-registered it, and our barrel import is a cached
// no-op. Force-(re)register the rules these tests exercise (at parse time AND in
// applyRules) so the test is robust to file ordering. (Same pattern as
// filter_header_csv.test.ts.)
beforeAll(() => {
  register("inject_headers", inject_headers, InjectHeadersSchema, {
    allow_override: true,
  });
  register("filter_header_csv", filter_header_csv, FilterHeaderCsvSchema, {
    allow_override: true,
  });
  register(
    "strip_header_csv_token",
    strip_header_csv_token,
    StripHeaderCsvTokenSchema,
    { allow_override: true },
  );
  register(
    "merge_anthropic_betas",
    merge_anthropic_betas,
    MergeAnthropicBetasSchema,
    { allow_override: true },
  );
  register("strip_header", strip_header, StripHeaderSchema, {
    allow_override: true,
  });
});

const injectStatic = {
  name: "inject_static",
  use: "inject_headers",
  force: false,
  set: { "anthropic-version": "2023-06-01" },
};
const oldAllow = {
  name: "old_allow",
  use: "filter_header_csv",
  header: "anthropic-beta",
  allow: ["claude-code-20250219"],
};
const oldMerge = {
  name: "old_merge",
  use: "merge_anthropic_betas",
  mode: "union",
  append: ["advanced-tool-use-2025-11-20"],
};

/** Minimal config: Lane 1 (^claude /v1/messages) + gpt lane + Lane 5 (^claude /responses). */
function makeConfig(anthropic_beta?: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    ...(anthropic_beta ? { anthropic_beta } : {}),
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        header_rules: [injectStatic, oldAllow, oldMerge],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
      {
        match: {
          method: "POST",
          path: "/responses",
          model_pattern: "^gpt-5\\.",
        },
        header_rules: [injectStatic],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "openai_responses",
          shape: "openai_responses",
        },
      },
      {
        match: {
          method: "POST",
          path: "/responses",
          model_pattern: "^claude-",
        },
        header_rules: [oldAllow, oldMerge],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

/** Parse a CSV header value into a Set of trimmed tokens. */
function tokens(csv: string | undefined): Set<string> {
  if (csv === undefined) return new Set();
  return new Set(
    csv
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

/** applyBetaPolicy(mode), then run the CC→Claude beta lane's header_rules over
 *  `betaHeader` and return the resulting headers dict. */
async function runBetaLane(
  mode: BetaPolicyMode,
  betaHeader: string,
  anthropic_beta?: Record<string, unknown>,
): Promise<Record<string, string>> {
  const config = makeConfig(anthropic_beta);
  applyBetaPolicy(config, mode);
  const lane = config.routes[0]!; // Lane 1 — /v1/messages × ^claude-
  const ctx: TransformContext = {
    body: {},
    headers: { "anthropic-beta": betaHeader },
    route: "/v1/messages",
    model: "claude-opus-4.8",
  };
  const result = await applyRules(
    ctx,
    lane.header_rules as unknown as Rule[],
    snapshot("body"),
  );
  return result.ctx.headers;
}

describe("beta policy integration — denylist (default)", () => {
  test("strips the denied token, PASSES unknown betas, merges advanced-tool-use", async () => {
    const headers = await runBetaLane(
      "denylist",
      "claude-code-20250219, advisor-tool-2026-03-01, some-new-beta-2099-01-01",
    );
    const out = tokens(headers["anthropic-beta"]);
    // Denied token gone.
    expect(out.has("advisor-tool-2026-03-01")).toBe(false);
    // Client token preserved.
    expect(out.has("claude-code-20250219")).toBe(true);
    // KEY denylist property: an UNKNOWN (upstream-accepted) beta flows through.
    expect(out.has("some-new-beta-2099-01-01")).toBe(true);
    // Proxy-required beta merged in.
    expect(out.has("advanced-tool-use-2025-11-20")).toBe(true);
  });

  test("context-1m-2025-08-07 is NOT denied (accepted no-op passes through)", async () => {
    const headers = await runBetaLane(
      "denylist",
      "context-1m-2025-08-07, claude-code-20250219",
    );
    expect(tokens(headers["anthropic-beta"]).has("context-1m-2025-08-07")).toBe(
      true,
    );
  });
});

describe("beta policy integration — deny is authoritative (regression: baseline/append re-add)", () => {
  test("a token in BOTH deny AND merge_append does NOT reach the outbound header", async () => {
    // Pathological overlap: the operator denies the very token the proxy also
    // lists in merge_append (and which is the transform's hidden baseline
    // default). Pre-fix, the injected merge union-re-added it AFTER the deny
    // rule stripped it — silently defeating the deny for exactly the escape-
    // hatch scenario the feature exists to serve. The fix pins baseline:[] and
    // subtracts the deny set from append, so the denied token can be re-added
    // by neither channel.
    const headers = await runBetaLane(
      "denylist",
      "claude-code-20250219, advanced-tool-use-2025-11-20",
      {
        policy: "denylist",
        deny: ["advanced-tool-use-2025-11-20"],
        merge_append: ["advanced-tool-use-2025-11-20"],
      },
    );
    const out = tokens(headers["anthropic-beta"]);
    // Core invariant: a denied token MUST NOT survive to the outbound header.
    expect(out.has("advanced-tool-use-2025-11-20")).toBe(false);
    // Deny did not over-strip: a non-denied client token is still present.
    expect(out.has("claude-code-20250219")).toBe(true);
  });
});

describe("beta policy integration — allowlist deny is authoritative (GAN iter-2 HIGH#2)", () => {
  test("a token in BOTH allow AND deny is stripped by the trailing fail-closed deny", async () => {
    // The documented escape hatch is `-BetaPolicy allowlist`. If upstream starts
    // rejecting a token that is ALSO in the allow list (e.g. the advanced-tool-use
    // baseline), allowlist mode must STILL honor deny — else the recovery path
    // itself keeps 400ing. Here advanced-tool-use is in allow, merge_append, AND
    // deny; the trailing fail-closed deny must strip it regardless of channel.
    const headers = await runBetaLane(
      "allowlist",
      "claude-code-20250219, advanced-tool-use-2025-11-20",
      {
        policy: "allowlist",
        allow: ["claude-code-20250219", "advanced-tool-use-2025-11-20"],
        deny: ["advanced-tool-use-2025-11-20"],
      },
    );
    const out = tokens(headers["anthropic-beta"]);
    expect(out.has("advanced-tool-use-2025-11-20")).toBe(false);
    // A non-denied allowed token still survives.
    expect(out.has("claude-code-20250219")).toBe(true);
  });

  test("a token re-added via merge_append but also denied is stripped (allowlist)", async () => {
    // Isolate the merge_append ∩ deny path: extra-bad is NOT in allow and NOT
    // sent by the client, but IS in merge_append (the merge rule re-adds it) AND
    // in deny (the trailing deny must remove it).
    const headers = await runBetaLane("allowlist", "claude-code-20250219", {
      policy: "allowlist",
      allow: ["claude-code-20250219"],
      deny: ["extra-bad-2099-01-01"],
      merge_append: ["extra-bad-2099-01-01"],
    });
    const out = tokens(headers["anthropic-beta"]);
    expect(out.has("extra-bad-2099-01-01")).toBe(false);
    expect(out.has("claude-code-20250219")).toBe(true);
  });
});

describe("beta policy integration — allowlist (escape hatch)", () => {
  test("filters to the allow-list — unknown + denied tokens dropped", async () => {
    const headers = await runBetaLane(
      "allowlist",
      "claude-code-20250219, some-new-beta-2099-01-01, advisor-tool-2026-03-01",
    );
    const out = tokens(headers["anthropic-beta"]);
    // In allow-list → kept.
    expect(out.has("claude-code-20250219")).toBe(true);
    // NOT in allow-list → dropped (the pre-D1 fail-safe behavior).
    expect(out.has("some-new-beta-2099-01-01")).toBe(false);
    expect(out.has("advisor-tool-2026-03-01")).toBe(false);
    // Proxy-required beta still merged in.
    expect(out.has("advanced-tool-use-2025-11-20")).toBe(true);
  });
});

describe("beta policy integration — strip_all (nuclear escape hatch)", () => {
  test("removes the anthropic-beta header entirely", async () => {
    const headers = await runBetaLane(
      "strip_all",
      "claude-code-20250219, advisor-tool-2026-03-01",
    );
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("beta policy integration — config wiring", () => {
  test("minimal config defaults to denylist policy with 2 beta lanes", () => {
    const config = makeConfig();
    expect(config.anthropic_beta.policy).toBe("denylist");
    const betaLanes = config.routes.filter((r) =>
      (r.match.model_pattern ?? "").startsWith("^claude"),
    );
    expect(betaLanes).toHaveLength(2);
  });

  test("config/default.yaml ships the anthropic_beta denylist wiring (text guard)", () => {
    // Registry-free text assertion so this guard is robust to file ordering.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const yamlPath = path.resolve(
      __dirname,
      "..",
      "..",
      "config",
      "default.yaml",
    );
    const text = readFileSync(yamlPath, "utf-8");
    // Top-level policy section present + defaults to denylist.
    expect(text).toContain("anthropic_beta:");
    expect(text).toMatch(/anthropic_beta:\s*\n\s*policy:\s*denylist/);
    // Beta lanes wired with the denylist rule-set names.
    expect(text).toContain("name: beta_policy_deny");
    expect(text).toContain("name: beta_policy_merge");
    // The pre-D1 allowlist rule NAME is gone from the shipped file.
    expect(text).not.toContain("name: anthropic_beta_allowlist");
    expect(text).not.toContain("name: strip_unsupported_betas");
  });
});
