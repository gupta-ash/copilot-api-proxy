/**
 * apply-initiator-headers.test.ts — unit tests for applyInitiatorHeaders, the
 * boot-time injector that puts the `derive_x_initiator` rule (x-initiator +
 * x-interaction-type, Copilot client fidelity) on the Anthropic lanes.
 *
 * Coverage:
 *   - Injected LAST on both ^claude- lanes, preserving existing rules in order.
 *   - GPT lanes never RECEIVE the rule; a GPT lane that already carries one
 *     (operator config, custom name) has it STRIPPED.
 *   - The injected rule pins both header names explicitly.
 *   - Idempotent re-apply; an operator's own derive_x_initiator entry (any
 *     name, any custom header_name) is REPLACED by the canonical rule.
 *   - The injected object satisfies the rule's OWN schema.
 *   - Combined boot order with applyBetaPolicy (as main.ts calls them).
 *   - The real config/default.yaml: exactly the 2 ^claude- lanes get it.
 *   - CLASSIFY-BY-UPSTREAM (D71): lanes are selected by `route.upstream`, not
 *     by `match.model_pattern` text, so an Anthropic lane spelled `^(?:claude-)`
 *     still gets the rule and a gpt lane whose pattern merely CONTAINS "claude"
 *     still does not.
 *
 * The registry is populated via the transform barrel side-effect import PLUS a
 * beforeAll force-registration, so the injector's RuleSchema validation is real
 * rather than the empty-registry test-mode escape (`config-schema.ts`
 * buildRuleSchema accepts any `use` when the registry is empty outside
 * NODE_ENV=production) — mirrors tests/lib/apply-beta-policy.test.ts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { beforeAll, describe, expect, it } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules (first-run case)
import { applyBetaPolicy } from "~/lib/apply-beta-policy.ts";
import { applyInitiatorHeaders } from "~/lib/apply-initiator-headers.ts";
import {
  derive_x_initiator,
  DeriveXInitiatorSchema,
} from "~/lib/transform/derive_x_initiator.ts";
import {
  inject_headers,
  InjectHeadersSchema,
} from "~/lib/transform/inject_headers.ts";
import {
  merge_anthropic_betas,
  MergeAnthropicBetasSchema,
} from "~/lib/transform/merge_anthropic_betas.ts";
import {
  redirect_to_anthropic_messages,
  RedirectToAnthropicMessagesSchema,
} from "~/lib/transform/redirect_to_anthropic_messages.ts";
import { register } from "~/lib/transform/registry.ts";
import {
  strip_header_csv_token,
  StripHeaderCsvTokenSchema,
} from "~/lib/transform/strip_header_csv_token.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";

// The body registry is a shared singleton across test files; a prior file may
// have reset() + partially re-registered it, and the barrel import above is a
// cached no-op. Force-(re)register the rules these tests exercise (idempotent
// via allow_override) so ConfigSchema.parse + the injector's own RuleSchema
// validation are REAL regardless of the order Bun runs test files in.
beforeAll(() => {
  register("derive_x_initiator", derive_x_initiator, DeriveXInitiatorSchema, {
    ctx_reads: ["body"],
    ctx_writes: ["headers"],
    allow_override: true,
  });
  register("inject_headers", inject_headers, InjectHeadersSchema, {
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
  register(
    "redirect_to_anthropic_messages",
    redirect_to_anthropic_messages,
    RedirectToAnthropicMessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
});

/** A header rule after zod-parse (RuleSchema infers `unknown`; re-narrow here). */
type HRule = { name: string; use: string; [k: string]: unknown };

const injectStatic = {
  name: "inject_static",
  use: "inject_headers",
  force: false,
  set: { "x-github-api-version": "2026-06-01" },
};

/** Fresh config: Lane 1 (^claude /v1/messages) + gpt lane + Lane 5 (^claude /responses). */
function makeConfig(
  lane1Extra: Array<Record<string, unknown>> = [],
  gptExtra: Array<Record<string, unknown>> = [],
): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        header_rules: [injectStatic, ...lane1Extra],
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
        header_rules: [injectStatic, ...gptExtra],
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
        header_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

const LANE1 = 0;
const GPT_LANE = 1;
const LANE5 = 2;

/** Parse the REAL shipped `config/default.yaml` (all 5 lanes, as deployed). */
function loadShippedConfig(): Config {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const yamlPath = path.resolve(here, "..", "..", "config", "default.yaml");
  return ConfigSchema.parse(
    YAML.parse(readFileSync(yamlPath, "utf-8")) as unknown,
  );
}

const hrules = (config: Config, idx: number): HRule[] =>
  config.routes[idx]!.header_rules as HRule[];
const names = (config: Config, idx: number): string[] =>
  hrules(config, idx).map((r) => r.name);
const initiatorRules = (config: Config, idx: number): HRule[] =>
  hrules(config, idx).filter((r) => r.use === "derive_x_initiator");

describe("applyInitiatorHeaders — lane targeting", () => {
  it("injects LAST on BOTH Anthropic lanes, preserving existing rules in order", () => {
    const config = makeConfig();
    applyInitiatorHeaders(config);
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "derive_initiator_headers",
    ]);
    expect(names(config, LANE5)).toEqual(["derive_initiator_headers"]);
  });

  it("never ADDS the rule to a gpt lane (one carrying no derive rule is untouched)", () => {
    const config = makeConfig();
    const gptBefore = JSON.parse(JSON.stringify(hrules(config, GPT_LANE)));
    applyInitiatorHeaders(config);
    expect(hrules(config, GPT_LANE)).toEqual(gptBefore);
    expect(initiatorRules(config, GPT_LANE)).toHaveLength(0);
  });

  it("STRIPS a pre-existing derive_x_initiator rule from a gpt lane (operator config)", () => {
    // The test above starts from a gpt lane with NO derive rule, so it is
    // structurally incapable of catching this fault. This one starts from the
    // realistic deployed state: install_bundle.ps1 PRESERVES an existing
    // config.yaml, so an operator's hand-wired derive_x_initiator rule on a
    // gpt route survives every upgrade. The transform itself has no lane
    // guard, so leaving it there would emit BOTH headers on the gpt lane.
    // Custom NAME + custom header names, to prove the match is on `use`.
    const config = makeConfig(
      [],
      [
        {
          name: "operator_gpt_initiator",
          use: "derive_x_initiator",
          header_name: "x-gpt-initiator",
          interaction_type_header_name: "x-gpt-interaction-type",
        },
      ],
    );
    // Precondition: the rule really is on the gpt lane before the call.
    expect(initiatorRules(config, GPT_LANE)).toHaveLength(1);

    applyInitiatorHeaders(config);

    // Stripped, not replaced — the gpt lane must end with NO derive rule at all.
    expect(initiatorRules(config, GPT_LANE)).toHaveLength(0);
    expect(names(config, GPT_LANE)).toEqual(["inject_static"]);
    // The unrelated rule survived unchanged.
    expect(hrules(config, GPT_LANE)[0]).toEqual(injectStatic);
    // And the Anthropic lane still got the canonical rule.
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "derive_initiator_headers",
    ]);
  });
});

describe("applyInitiatorHeaders — the injected rule", () => {
  it("pins use + BOTH header names explicitly (not left to zod defaults)", () => {
    const config = makeConfig();
    applyInitiatorHeaders(config);
    const rule = initiatorRules(config, LANE1)[0]!;
    expect(rule.use).toBe("derive_x_initiator");
    expect(rule.header_name).toBe("x-initiator");
    expect(rule.interaction_type_header_name).toBe("x-interaction-type");
  });

  it("satisfies the rule's OWN schema (registry-independent check)", () => {
    // Asserted against DeriveXInitiatorSchema directly, NOT via RuleSchema:
    // RuleSchema accepts any `use` when the body registry is empty outside
    // NODE_ENV=production, so a RuleSchema-only assertion could be hollowed
    // out by test-file ordering. This one cannot.
    const config = makeConfig();
    applyInitiatorHeaders(config);
    const parsed = DeriveXInitiatorSchema.safeParse(
      initiatorRules(config, LANE1)[0],
    );
    expect(parsed.success).toBe(true);
  });
});

describe("applyInitiatorHeaders — convergence", () => {
  it("is idempotent: re-applying yields identical header_rules, one entry", () => {
    const config = makeConfig();
    applyInitiatorHeaders(config);
    const once = JSON.parse(JSON.stringify(hrules(config, LANE1)));
    applyInitiatorHeaders(config);
    expect(hrules(config, LANE1)).toEqual(once);
    expect(initiatorRules(config, LANE1)).toHaveLength(1);
    expect(initiatorRules(config, LANE5)).toHaveLength(1);
  });

  it("REPLACES an operator's own derive_x_initiator entry (any name, custom header_name)", () => {
    // Deliberate override, not a merge — see the module docblock. Matching on
    // `use` (not `name`) is what makes this converge.
    const config = makeConfig([
      {
        name: "operator_initiator",
        use: "derive_x_initiator",
        header_name: "x-something-else",
      },
    ]);
    applyInitiatorHeaders(config);
    const found = initiatorRules(config, LANE1);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("derive_initiator_headers");
    expect(found[0]!.header_name).toBe("x-initiator");
    // The operator's rule is gone entirely, and the canonical one is LAST.
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "derive_initiator_headers",
    ]);
    // The unrelated rule survived unchanged.
    expect(hrules(config, LANE1)[0]).toEqual(injectStatic);
  });
});

describe("applyInitiatorHeaders — combined boot order (as main.ts calls them)", () => {
  it("beta rules then the initiator rule; neither injector eats the other's rules", () => {
    // ORDER-PINNING assertion. If this fails ONLY because the two boot
    // injections were reordered in main.ts, that is COSMETIC — the two rules
    // touch disjoint headers (anthropic-beta vs x-initiator/x-interaction-type)
    // so behavior is unchanged. Update this expectation rather than hunting a
    // functional regression.
    const config = makeConfig();
    applyBetaPolicy(config, "denylist");
    applyInitiatorHeaders(config);
    expect(names(config, LANE1)).toEqual([
      "inject_static",
      "beta_policy_merge",
      "beta_policy_deny",
      "derive_initiator_headers",
    ]);
    expect(names(config, LANE5)).toEqual([
      "beta_policy_merge",
      "beta_policy_deny",
      "derive_initiator_headers",
    ]);
  });
});

/**
 * A route whose Anthropic egress is spelled in a way the OLD textual
 * classifier (`model_pattern.startsWith("^claude")`) misses, but whose
 * `upstream` block names the Anthropic Messages endpoint unambiguously. This
 * is the D71 under-match case, and it is the shape the previous revision made
 * STRICTLY WORSE: the strip pass ran on it (removing the operator's own rule)
 * while the append pass skipped it.
 */
function anthropicLaneSpelledAsGroup(
  headerRules: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    match: {
      method: "POST",
      path: "/v1/messages",
      // Semantically identical to "^claude-", textually invisible to
      // startsWith("^claude").
      model_pattern: "^(?:claude-)",
    },
    header_rules: headerRules,
    upstream: {
      via: "copilot_enterprise",
      via_endpoint: "anthropic_messages",
      shape: "anthropic_messages",
    },
  };
}

describe("applyInitiatorHeaders — lane selection is by UPSTREAM, not model_pattern text (D71)", () => {
  it("REGRESSION GUARD: an Anthropic lane spelled `^(?:claude-)` still GETS the rule", () => {
    // Under `isBetaLane` (startsWith("^claude")) this lane is a FALSE NEGATIVE:
    // the boot pass strips and appends nothing, so it ends with zero rules.
    // Classifying on route.upstream has no spelling to miss.
    const config = ConfigSchema.parse({
      routes: [anthropicLaneSpelledAsGroup([injectStatic])],
    });
    applyInitiatorHeaders(config);
    expect(names(config, 0)).toEqual([
      "inject_static",
      "derive_initiator_headers",
    ]);
    expect(initiatorRules(config, 0)).toHaveLength(1);
  });

  it("REGRESSION GUARD: strip-then-skip no longer DELETES an operator's rule on such a lane", () => {
    // The sharp edge, stated as the operator sees it. install_bundle.ps1
    // preserves config.yaml, so an operator's hand-wired derive_x_initiator on
    // an oddly-spelled Anthropic lane survives every upgrade — and the previous
    // revision's unconditional strip + text-gated append silently removed it,
    // leaving the lane emitting NEITHER header where it used to emit both.
    const config = ConfigSchema.parse({
      routes: [
        anthropicLaneSpelledAsGroup([
          {
            name: "operator_initiator",
            use: "derive_x_initiator",
            header_name: "x-initiator",
            interaction_type_header_name: "x-interaction-type",
          },
        ]),
      ],
    });
    expect(initiatorRules(config, 0)).toHaveLength(1);

    applyInitiatorHeaders(config);

    // Exactly one rule, and it is the canonical one — NOT zero.
    const found = initiatorRules(config, 0);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("derive_initiator_headers");
    expect(found[0]!.header_name).toBe("x-initiator");
  });

  it("a gpt lane whose model_pattern CONTAINS 'claude' does NOT get the rule", () => {
    // The over-match half of D71: broadening the textual test to /claude/i to
    // fix the case above would wrongly capture this lane. The upstream block is
    // what settles it — openai_responses is not the Anthropic upstream.
    const config = ConfigSchema.parse({
      routes: [
        {
          match: {
            method: "POST",
            path: "/responses",
            // Negative lookahead: matches gpt-5.* and explicitly NOT claude.
            model_pattern: "^(?!claude-)gpt-5\\.",
          },
          header_rules: [injectStatic],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "openai_responses",
            shape: "openai_responses",
          },
        },
      ],
    });
    applyInitiatorHeaders(config);
    expect(initiatorRules(config, 0)).toHaveLength(0);
    expect(names(config, 0)).toEqual(["inject_static"]);
  });

  it("a lane with NO model_pattern at all but an Anthropic upstream GETS the rule", () => {
    // `isBetaLane` returns false for an absent model_pattern by design (a
    // catch-all must not be force-rewritten by the BETA policy). For THIS
    // feature the upstream is what matters, and it says Anthropic.
    const config = ConfigSchema.parse({
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          header_rules: [],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    applyInitiatorHeaders(config);
    expect(initiatorRules(config, 0)).toHaveLength(1);
  });

  it("a lane reaching Anthropic only via the redirect MARKER gets the rule", () => {
    // Lane 5's actual mechanism, isolated: a route declaring an OpenAI
    // via_endpoint but carrying `redirect_to_anthropic_messages` in body_rules
    // is dispatched to createAnthropicMessages by marker-dispatch.ts. The
    // third arm of the classifier exists for exactly this.
    const config = ConfigSchema.parse({
      routes: [
        {
          match: {
            method: "POST",
            path: "/responses",
            model_pattern: "^some-anthropic-alias",
          },
          body_rules: [
            { name: "redirect", use: "redirect_to_anthropic_messages" },
          ],
          header_rules: [],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "openai_responses",
            shape: "openai_responses",
          },
        },
      ],
    });
    applyInitiatorHeaders(config);
    expect(initiatorRules(config, 0)).toHaveLength(1);
  });
});

describe("applyInitiatorHeaders — real config/default.yaml", () => {
  it("selects the SAME 2 lanes the shipped config's upstream blocks name", () => {
    // Cross-check on the real file: the set the upstream-based classifier picks
    // is exactly the set whose `upstream.via_endpoint` is anthropic_messages —
    // asserted from the config's own data rather than from the ^claude- text,
    // so this test does not silently re-encode the classifier it is checking.
    const config = loadShippedConfig();
    applyInitiatorHeaders(config);
    const wired = config.routes.filter((route) =>
      (route.header_rules as HRule[]).some(
        (r) => r.use === "derive_x_initiator",
      ),
    );
    const anthropicUpstream = config.routes.filter(
      (route) => route.upstream.via_endpoint === "anthropic_messages",
    );
    expect(anthropicUpstream).toHaveLength(2);
    expect(wired).toEqual(anthropicUpstream);
  });
  it("targets exactly the 2 ^claude- lanes of the shipped config", () => {
    const config = loadShippedConfig();
    applyInitiatorHeaders(config);

    let claudeLanes = 0;
    let gptLanes = 0;
    for (const route of config.routes) {
      const found = (route.header_rules as HRule[]).filter(
        (r) => r.use === "derive_x_initiator",
      );
      if ((route.match.model_pattern ?? "").startsWith("^claude")) {
        claudeLanes += 1;
        expect(found).toHaveLength(1);
        expect(found[0]!.name).toBe("derive_initiator_headers");
        // Injection is LAST on the real lane too.
        const rules = route.header_rules as HRule[];
        expect(rules[rules.length - 1]!.name).toBe("derive_initiator_headers");
      } else {
        gptLanes += 1;
        expect(found).toHaveLength(0);
      }
    }
    expect(claudeLanes).toBe(2);
    expect(gptLanes).toBe(3);
  });
});
