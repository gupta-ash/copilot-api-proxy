/**
 * apply-beta-policy.test.ts — unit tests for applyBetaPolicy (Feature D1/D3).
 *
 * Coverage:
 *   - denylist / allowlist / strip_all each end the beta lanes with the correct
 *     rule-set (right `use` + right token arrays sourced from config.anthropic_beta).
 *   - Non-beta rules (inject_headers) are preserved, in order.
 *   - Idempotent: re-applying the same mode → identical header_rules.
 *   - Mode switching converges (allowlist→denylist == denylist-once).
 *   - GPT lanes (^gpt-*) are never touched.
 *   - Custom deny/allow/merge_append arrays flow through into the injected rules.
 *
 * The registry is populated via the transform barrel side-effect import so
 * applyBetaPolicy's injected-rule RuleSchema validation is real (not the
 * empty-registry test-mode escape).
 */

import { beforeAll, describe, expect, it } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules (first-run case)
import { applyBetaPolicy } from "~/lib/apply-beta-policy.ts";
import { register } from "~/lib/transform/registry.ts";
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
import {
  strip_header,
  StripHeaderSchema,
} from "~/lib/transform/strip_header.ts";
import {
  strip_header_csv_token,
  StripHeaderCsvTokenSchema,
} from "~/lib/transform/strip_header_csv_token.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";

// The body registry is a shared singleton across test files. A prior test file
// may have `reset()` + partially re-registered it, and the barrel import above
// is a cached no-op that won't re-run the self-registrations. Force-(re)register
// the rules these tests exercise (idempotent via allow_override) so
// ConfigSchema.parse + applyBetaPolicy validation see them regardless of the
// order Bun runs test files in. (Same pattern as filter_header_csv.test.ts.)
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

/** A header rule after zod-parse (RuleSchema infers `unknown`; re-narrow here). */
type HRule = { name: string; use: string; [k: string]: unknown };

/** Fresh raw config: 2 beta lanes (^claude on /v1/messages + /responses) + 1 gpt lane. */
function makeRawConfig(anthropic_beta?: Record<string, unknown>): unknown {
  const injectStatic = {
    name: "inject_static",
    use: "inject_headers",
    force: false,
    set: { "x-github-api-version": "2026-06-01" },
  };
  return {
    ...(anthropic_beta ? { anthropic_beta } : {}),
    routes: [
      // Beta lane 1 — mirrors config/default.yaml Lane 1 (with the OLD allowlist
      // rule-set, so we prove the rewrite REPLACES it).
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        header_rules: [
          injectStatic,
          {
            name: "old_allowlist",
            use: "filter_header_csv",
            header: "anthropic-beta",
            allow: ["claude-code-20250219"],
          },
          {
            name: "old_strip",
            use: "strip_header_csv_token",
            header: "anthropic-beta",
            deny: ["context-1m-2025-08-07"],
          },
          {
            name: "old_merge",
            use: "merge_anthropic_betas",
            mode: "union",
            append: ["advanced-tool-use-2025-11-20"],
          },
        ],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
      // GPT lane — must be left untouched.
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
      // Beta lane 5 — mirrors config/default.yaml Lane 5 (no inject_static).
      {
        match: {
          method: "POST",
          path: "/responses",
          model_pattern: "^claude-",
        },
        header_rules: [
          {
            name: "old_allowlist",
            use: "filter_header_csv",
            header: "anthropic-beta",
            allow: ["claude-code-20250219"],
          },
          {
            name: "old_merge",
            use: "merge_anthropic_betas",
            mode: "union",
            append: ["advanced-tool-use-2025-11-20"],
          },
        ],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  };
}

function makeConfig(anthropic_beta?: Record<string, unknown>): Config {
  return ConfigSchema.parse(makeRawConfig(anthropic_beta));
}

const hrules = (config: Config, idx: number): HRule[] =>
  config.routes[idx]!.header_rules as HRule[];
const names = (config: Config, idx: number): string[] =>
  hrules(config, idx).map((r) => r.name);
const uses = (config: Config, idx: number): string[] =>
  hrules(config, idx).map((r) => r.use);
const byName = (config: Config, idx: number, name: string): HRule | undefined =>
  hrules(config, idx).find((r) => r.name === name);

const LANE1 = 0;
const GPT_LANE = 1;
const LANE5 = 2;

describe("applyBetaPolicy — denylist", () => {
  it("beta lanes end with [preserved..., beta_policy_merge, beta_policy_deny]", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "denylist");

    // Lane 1: inject_static preserved first, then merge, then the fail-closed
    // trailing deny (deny is the last word — see buildRuleSet invariant).
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
    expect(uses(config, LANE1)).toEqual([
      "inject_headers",
      "merge_anthropic_betas",
      "strip_header_csv_token",
    ]);

    // Lane 5: no non-beta rule → just [merge, deny].
    expect(names(config, LANE5)).toEqual([
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
  });

  it("beta_policy_deny.deny === config.anthropic_beta.deny; merge is mode=union + append", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "denylist");
    const deny = byName(config, LANE1, "beta_policy_deny")!;
    expect(deny.header).toBe("anthropic-beta");
    expect(deny.deny).toEqual(config.anthropic_beta.deny);
    expect(deny.deny).toEqual(["advisor-tool-2026-03-01"]);
    const merge = byName(config, LANE1, "beta_policy_merge")!;
    expect(merge.mode).toBe("union");
    expect(merge.append).toEqual(config.anthropic_beta.merge_append);
  });

  it("preserves the non-beta inject_headers rule unchanged", () => {
    const config = makeConfig();
    const before = { ...(byName(config, LANE1, "inject_static") as HRule) };
    applyBetaPolicy(config, "denylist");
    expect(byName(config, LANE1, "inject_static")).toEqual(before);
  });

  it("does NOT touch the gpt lane", () => {
    const config = makeConfig();
    const gptBefore = JSON.parse(JSON.stringify(hrules(config, GPT_LANE)));
    applyBetaPolicy(config, "denylist");
    expect(hrules(config, GPT_LANE)).toEqual(gptBefore);
    expect(names(config, GPT_LANE)).toEqual(["inject_static"]);
  });

  it("custom deny/merge_append flow through into the injected rules", () => {
    const config = makeConfig({
      policy: "denylist",
      deny: ["custom-bad-2099-01-01", "another-2099-02-02"],
      merge_append: ["advanced-tool-use-2025-11-20", "extra-2099-03-03"],
    });
    applyBetaPolicy(config, "denylist");
    expect(byName(config, LANE1, "beta_policy_deny")!.deny).toEqual([
      "custom-bad-2099-01-01",
      "another-2099-02-02",
    ]);
    expect(byName(config, LANE1, "beta_policy_merge")!.append).toEqual([
      "advanced-tool-use-2025-11-20",
      "extra-2099-03-03",
    ]);
  });
});

describe("applyBetaPolicy — allowlist", () => {
  it("beta lanes end with [preserved..., beta_policy_allow, beta_policy_merge, beta_policy_deny]", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "allowlist");
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "beta_policy_allow",
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
    const allow = byName(config, LANE1, "beta_policy_allow")!;
    expect(allow.use).toBe("filter_header_csv");
    expect(allow.header).toBe("anthropic-beta");
    expect(allow.allow).toEqual(config.anthropic_beta.allow);
    // The default allow-list carries the 8 pre-D1 tokens.
    expect((allow.allow as string[]).length).toBe(8);
    // Fail-closed invariant: allowlist mode ALSO ends with the trailing deny, so
    // a token in both `allow` and `deny` is still stripped (deny wins).
    const deny = byName(config, LANE1, "beta_policy_deny")!;
    expect(deny.use).toBe("strip_header_csv_token");
    expect(deny.header).toBe("anthropic-beta");
    expect(deny.deny).toEqual(config.anthropic_beta.deny);
  });

  it("does NOT touch the gpt lane", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "allowlist");
    expect(names(config, GPT_LANE)).toEqual(["inject_static"]);
  });
});

describe("applyBetaPolicy — strip_all", () => {
  it("beta lanes end with [preserved..., beta_policy_strip_all] and NO merge", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "strip_all");
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "beta_policy_strip_all",
    ]);
    expect(names(config, LANE5)).toEqual(["beta_policy_strip_all"]);
    // No merge rule in strip_all.
    expect(uses(config, LANE1)).not.toContain("merge_anthropic_betas");
  });

  it("strip_all rule uses the plural `headers: [anthropic-beta]` shape (strip_header schema)", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "strip_all");
    const strip = byName(config, LANE1, "beta_policy_strip_all")!;
    expect(strip.use).toBe("strip_header");
    // The strip_header rule schema requires `headers: string[]`, NOT a singular
    // `header` — a singular field would fail schema validation + throw at runtime.
    expect(strip.headers).toEqual(["anthropic-beta"]);
    expect(strip.header).toBeUndefined();
  });

  it("does NOT touch the gpt lane", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "strip_all");
    expect(names(config, GPT_LANE)).toEqual(["inject_static"]);
  });
});

describe("applyBetaPolicy — idempotency + mode switching", () => {
  it("re-applying denylist is a no-op (identical header_rules)", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "denylist");
    const once = JSON.parse(
      JSON.stringify(config.routes.map((r) => r.header_rules)),
    );
    applyBetaPolicy(config, "denylist");
    const twice = config.routes.map((r) => r.header_rules);
    expect(twice).toEqual(once);
  });

  it("allowlist→denylist converges to denylist-once", () => {
    const cycled = makeConfig();
    applyBetaPolicy(cycled, "allowlist");
    applyBetaPolicy(cycled, "denylist");

    const fresh = makeConfig();
    applyBetaPolicy(fresh, "denylist");

    expect(cycled.routes.map((r) => r.header_rules)).toEqual(
      fresh.routes.map((r) => r.header_rules),
    );
  });

  it("denylist→allowlist converges to allowlist-once (no leftover deny-only rules)", () => {
    // GAN iter-2: allowlist now also injects a trailing deny, so switching
    // denylist→allowlist must remove the prior mode's [merge, deny] and reinject
    // [allow, merge, deny] — no duplicate/leftover rules from the denylist pass.
    const cycled = makeConfig();
    applyBetaPolicy(cycled, "denylist");
    applyBetaPolicy(cycled, "allowlist");

    const fresh = makeConfig();
    applyBetaPolicy(fresh, "allowlist");

    expect(cycled.routes.map((r) => r.header_rules)).toEqual(
      fresh.routes.map((r) => r.header_rules),
    );
    // Explicit: beta lane converges to exactly the allowlist rule-set.
    expect(names(cycled, LANE1)).toEqual([
      "inject_static",
      "beta_policy_allow",
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
  });

  it("denylist→strip_all→denylist converges to denylist-once (strip_header removal)", () => {
    const cycled = makeConfig();
    applyBetaPolicy(cycled, "denylist");
    applyBetaPolicy(cycled, "strip_all");
    applyBetaPolicy(cycled, "denylist");

    const fresh = makeConfig();
    applyBetaPolicy(fresh, "denylist");

    expect(cycled.routes.map((r) => r.header_rules)).toEqual(
      fresh.routes.map((r) => r.header_rules),
    );
  });

  it("re-applying strip_all is a no-op (no duplicate strip_header)", () => {
    const config = makeConfig();
    applyBetaPolicy(config, "strip_all");
    applyBetaPolicy(config, "strip_all");
    // Exactly one strip_header on the beta lane, not two.
    expect(
      uses(config, LANE1).filter((u) => u === "strip_header"),
    ).toHaveLength(1);
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "beta_policy_strip_all",
    ]);
  });
});

describe("applyBetaPolicy — multi-header strip_header scrubbing (MEDIUM #3)", () => {
  /** Build a beta lane whose header_rules carry a single custom rule. */
  function laneWith(rule: Record<string, unknown>): Config {
    return ConfigSchema.parse({
      routes: [
        {
          match: {
            method: "POST",
            path: "/v1/messages",
            model_pattern: "^claude-",
          },
          header_rules: [rule],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
  }

  it("scrubs anthropic-beta out of a multi-header strip_header, keeps its other headers", () => {
    // {strip_header, headers:[anthropic-beta, x-foo]} is NOT caught by the
    // single-target filter (length !== 1); left intact it would strip the WHOLE
    // anthropic-beta header before the injected policy runs. applyBetaPolicy
    // must scrub anthropic-beta out while keeping x-foo.
    const config = laneWith({
      name: "multi_strip",
      use: "strip_header",
      headers: ["anthropic-beta", "x-foo"],
    });
    applyBetaPolicy(config, "denylist");
    const multi = byName(config, LANE1, "multi_strip")!;
    expect(multi).toBeDefined();
    expect(multi.use).toBe("strip_header");
    // anthropic-beta removed; x-foo still stripped by the preserved rule.
    expect(multi.headers).toEqual(["x-foo"]);
    // The injected denylist rule-set is present, after the preserved rule.
    expect(names(config, LANE1)).toEqual([
      "multi_strip",
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
  });

  it("drops a degenerate strip_header that lists ONLY anthropic-beta (twice)", () => {
    // headers:[anthropic-beta, anthropic-beta] — length>1 so it dodges the
    // single-target filter, but scrubbing beta leaves headers empty. The rule
    // is dropped entirely (strip_header schema requires headers.min(1)); only
    // the injected denylist rule-set remains.
    const config = laneWith({
      name: "dup_beta_strip",
      use: "strip_header",
      headers: ["anthropic-beta", "anthropic-beta"],
    });
    applyBetaPolicy(config, "denylist");
    expect(names(config, LANE1)).toEqual([
      "beta_policy_merge",
      "beta_policy_deny",
    ]);
  });
});

describe("applyBetaPolicy — isBetaLane pattern recognition (startsWith(^claude); Option 1 revert)", () => {
  // Build a single-route config with the given model_pattern (or none), apply
  // denylist, and report whether the beta rule-set (beta_policy_deny) was
  // injected. Endpoint/shape are fixed valid scaffolding — only model_pattern
  // varies (the schema does NOT tie model_pattern to shape).
  function isTreatedAsBetaLane(model_pattern: string | undefined): boolean {
    const match: Record<string, unknown> = {
      method: "POST",
      path: "/v1/messages",
    };
    if (model_pattern !== undefined) match.model_pattern = model_pattern;
    const config = ConfigSchema.parse({
      routes: [
        {
          match,
          header_rules: [],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    applyBetaPolicy(config, "denylist");
    const rules = config.routes[0]!.header_rules as HRule[];
    return rules.some((r) => r.name === "beta_policy_deny");
  }

  it("treats a ^claude-prefixed pattern as a beta lane", () => {
    for (const p of ["^claude", "^claude-", "^claude-.*"]) {
      expect(isTreatedAsBetaLane(p)).toBe(true);
    }
  });

  it("does NOT classify a claude pattern that fails to literally start with ^claude (egress guard covers these — Option 1)", () => {
    // Post-Option-1: isBetaLane is the provably-safe startsWith("^claude"). A
    // claude-targeting pattern written in a spelling that does NOT literally
    // begin with "^claude" (regex group, char-class, or unanchored) is NOT
    // classified as a beta lane, so applyBetaPolicy injects no denyTail on it.
    // These were asserted TRUE under the iter-3 /claude/i test; they flip to
    // FALSE here. The security invariant for such under-matched lanes is upheld
    // by the classification-INDEPENDENT egress guard (stripDeniedBetas in
    // services/copilot/create-anthropic-messages.ts), NOT by isBetaLane.
    for (const p of ["^(?:claude-)", "^cl(?:aude)-", "^[Cc]laude-", "claude"]) {
      expect(isTreatedAsBetaLane(p)).toBe(false);
    }
  });

  it("does NOT treat gpt lanes as beta lanes (incl. a lookahead pattern that literally contains 'claude')", () => {
    for (const p of [
      "^gpt-5\\.",
      "^gpt-4",
      "^gpt-4o",
      // OVER-match regression guard (Option 1): this GPT pattern literally
      // contains the substring "claude" via a negative lookahead. Under the
      // iter-3 /claude/i classifier it was WRONGLY treated as a beta lane;
      // startsWith("^claude") correctly excludes it (it starts with "^(?!").
      "^(?!claude-)gpt-5\\.",
    ]) {
      expect(isTreatedAsBetaLane(p)).toBe(false);
    }
  });

  it("does NOT treat a route with no model_pattern as a beta lane (catch-all — by design)", () => {
    // A catch-all (no model_pattern) is not Anthropic-specific, so it is
    // intentionally left untouched — the proxy has no catch-all claude route,
    // and force-injecting anthropic-beta rules onto a catch-all would be wrong.
    expect(isTreatedAsBetaLane(undefined)).toBe(false);
  });
});
