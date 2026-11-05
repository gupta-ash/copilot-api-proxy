/**
 * Tests for src/types/config-schema.ts
 *
 * Coverage:
 *   1. Valid full YAML config — parses successfully + types match.
 *   2. Missing required field — error path + message correct.
 *   3. Unknown rule with Levenshtein suggestion — error message includes "Did you mean".
 *   4. Default fields — minimal config gets all defaults applied.
 *   5. Per-rule schema reuse — rule-level required fields enforced (e.g. paths).
 *   6. fast-check property tests — random valid configs parse; arbitrary extra keys allowed.
 *   7. semver smoke import — confirms the dep resolves and basic API works.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import semver from "semver";
import { parse as parseYaml } from "yaml";

import {
  add_body_block,
  AddBodyBlockSchema,
} from "../../src/lib/transform/add_body_block.ts";
import {
  modify_body_block,
  ModifyBodyBlockSchema,
} from "../../src/lib/transform/modify_body_block.ts";
import { register, list } from "../../src/lib/transform/registry.ts";
import {
  strip_body_block,
  StripBodyBlockSchema,
} from "../../src/lib/transform/strip_body_block.ts";
import {
  strip_body_field,
  StripBodyFieldSchema,
} from "../../src/lib/transform/strip_body_field.ts";
import {
  ConfigSchema,
  type Config,
  RouteSchema,
  RuleSchema,
  resolveUpstreamUrl,
  suggestRuleName,
} from "../../src/types/config-schema.ts";

/**
 * Re-register the 4 day-1 body rules before every test in this file. Sibling
 * test files (e.g. `tests/transform/strip_body_field.test.ts`) call
 * `resetRegistry()` in their `afterEach`, which would otherwise leave the
 * registry empty for our parses.
 */
beforeEach(() => {
  if (!list("body").includes("add_body_block")) {
    register("add_body_block", add_body_block, AddBodyBlockSchema);
  }
  if (!list("body").includes("modify_body_block")) {
    register("modify_body_block", modify_body_block, ModifyBodyBlockSchema);
  }
  if (!list("body").includes("strip_body_block")) {
    register("strip_body_block", strip_body_block, StripBodyBlockSchema);
  }
  if (!list("body").includes("strip_body_field")) {
    register("strip_body_field", strip_body_field, StripBodyFieldSchema);
  }
});

// ============================================================================
// 1. Valid full YAML config
// ============================================================================

describe("ConfigSchema — valid full YAML", () => {
  it("parses a full multi-route config and resolves types", () => {
    const yamlSrc = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-.*"
    body_rules:
      - name: strip_effort
        use: strip_body_field
        paths:
          - output_config.effort
    header_rules: []
    upstream:
      endpoint: "https://api.enterprise.githubcopilot.com/v1/messages"
      shape: anthropic_messages
  - match:
      path: /responses
    body_rules:
      - name: add_tool
        use: add_body_block
        path: tools
        value:
          type: web_search
        position: end
    header_rules: []
    upstream:
      endpoint: "https://api.enterprise.githubcopilot.com/responses"
      shape: openai_responses

transforms:
  custom_dir: /tmp/transforms-x

logging:
  level: raw
  trace_dir: /tmp/traces
  warn_size_mb: 100

auth:
  account_type: enterprise
  vs_code_version: 1.95.2
`;
    const parsed = parseYaml(yamlSrc);
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      // print zod errors for easy debugging if test fails
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
    if (!result.success) return;

    const cfg: Config = result.data;
    expect(cfg.routes.length).toBe(2);
    expect(cfg.routes[0]?.match.path).toBe("/v1/messages");
    expect(cfg.routes[0]?.upstream.shape).toBe("anthropic_messages");
    expect(cfg.routes[1]?.body_rules.length).toBe(1);
    expect(cfg.transforms.custom_dir).toBe("/tmp/transforms-x");
    expect(cfg.logging.level).toBe("raw");
    expect(cfg.logging.warn_size_mb).toBe(100);
    expect(cfg.auth.account_type).toBe("enterprise");
  });
});

// ============================================================================
// 2. Missing required field
// ============================================================================

describe("ConfigSchema — missing required fields", () => {
  it("rejects a route missing upstream", () => {
    const bad = {
      routes: [
        {
          match: { path: "/v1/messages" },
          // upstream missing
        },
      ],
    };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.startsWith("routes.0"))).toBe(true);
      expect(paths.some((p) => p.includes("upstream"))).toBe(true);
    }
  });

  it("rejects a route with missing match.path", () => {
    const bad = {
      routes: [
        {
          match: {}, // no path
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "openai_chat_completions",
            shape: "openai_chat",
          },
        },
      ],
    };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.endsWith("match.path"))).toBe(true);
    }
  });
});

// ============================================================================
// 3. Unknown rule with Levenshtein suggestion
// ============================================================================

describe("ConfigSchema — unknown rule suggestion", () => {
  it("emits 'Did you mean' for a typo", () => {
    const bad = {
      routes: [
        {
          match: { path: "/v1/messages" },
          body_rules: [
            { name: "x", use: "stripp_body_field", paths: ["a"] }, // typo: extra "p"
          ],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      const matched = messages.find(
        (m) => m.includes("Unknown rule") && m.includes("strip_body_field"),
      );
      expect(matched).toBeDefined();
    }
  });

  it("suggestRuleName returns top matches by Levenshtein distance", () => {
    const registered = [
      "add_body_block",
      "modify_body_block",
      "strip_body_block",
      "strip_body_field",
    ];
    const sugg = suggestRuleName("stripp_body_field", registered);
    expect(sugg[0]).toBe("strip_body_field");

    const sugg2 = suggestRuleName("modfy_body_block", registered);
    expect(sugg2[0]).toBe("modify_body_block");

    // Far-off word → no suggestions returned (distance > 3 to all).
    const sugg3 = suggestRuleName("xyzwabc", registered);
    expect(sugg3).toEqual([]);
  });
});

// ============================================================================
// 4. Defaults
// ============================================================================

describe("ConfigSchema — defaults", () => {
  it("minimal { routes: [] } applies all defaults", () => {
    const result = ConfigSchema.safeParse({ routes: [] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const cfg = result.data;

    expect(cfg.transforms.custom_dir.length).toBeGreaterThan(0);
    expect(cfg.transforms.custom_dir).toContain("transforms");
    expect(cfg.logging.level).toBe("on");
    expect(cfg.logging.warn_size_mb).toBe(50);
    expect(cfg.auth.account_type).toBe("enterprise");
    expect(cfg.auth.vs_code_version).toBe("1.95.0");
  });

  it("empty {} also gets defaults (routes default to [])", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.routes).toEqual([]);
  });

  /**
   * logging.keep_alive must survive a logging-absent parse, and all three
   * schema defaults must agree across supported configuration shapes.
   *
   * Zod does not re-run an inner object's defaults when an outer default supplies
   * the parent, so the polarity is stated three times and a DIFFERENT site
   * answers for each config shape:
   *   S1  inner `enabled: z.boolean().default(...)`   <- `logging.keep_alive: {}`
   *   S2  the keep_alive object's own outer default   <- `logging:` present, no `keep_alive`
   *   S3  the parent logging section's outer literal  <- no `logging:` key at all
   *
   * Updating only one default can leave another valid parsed shape with the
   * opposite behavior. Exercise all three shapes rather than a source literal.
   *
   * Asserted on the PARSED config, never on the factory: `makeKeepAliveConfig`'s
   * own `??` defensiveness cannot see an outer-literal omission.
   */
  it("logging.keep_alive defaults agree across all three parsed configuration shapes", () => {
    const EXPECTED = {
      enabled: true,
      interval_ms: 30_000,
      require_first_byte: true,
      max_total_ms: 300_000,
    };

    // S3 — no `logging:` key at all.
    const absent = ConfigSchema.safeParse({ routes: [] });
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(absent.data.logging.keep_alive).toEqual(EXPECTED);

    // S2 — `logging:` present, `keep_alive` absent. THE DEPLOYED FLEET SHAPE.
    const noKeepAlive = ConfigSchema.safeParse({ routes: [], logging: {} });
    expect(noKeepAlive.success).toBe(true);
    if (!noKeepAlive.success) return;
    expect(noKeepAlive.data.logging.keep_alive).toEqual(EXPECTED);

    // S1 — `keep_alive: {}` present, `enabled` absent. The ONLY shape that
    // reaches the inner `z.object` default.
    const emptyKeepAlive = ConfigSchema.safeParse({
      routes: [],
      logging: { keep_alive: {} },
    });
    expect(emptyKeepAlive.success).toBe(true);
    if (!emptyKeepAlive.success) return;
    expect(emptyKeepAlive.data.logging.keep_alive).toEqual(EXPECTED);

    // An explicit operator `false` still beats all three defaults — the off
    // switch the runbook now points at.
    const off = ConfigSchema.safeParse({
      routes: [],
      logging: { keep_alive: { enabled: false } },
    });
    expect(off.success).toBe(true);
    if (!off.success) return;
    expect(off.data.logging.keep_alive.enabled).toBe(false);
  });
});

// ============================================================================
// 5. Per-rule schema reuse
// ============================================================================

describe("ConfigSchema — per-rule schema reuse", () => {
  it("strip_body_field requires paths", () => {
    const ok = RuleSchema.safeParse({
      name: "rule1",
      use: "strip_body_field",
      paths: ["a", "b"],
    });
    expect(ok.success).toBe(true);

    const missingPaths = RuleSchema.safeParse({
      name: "rule1",
      use: "strip_body_field",
      // paths missing
    });
    expect(missingPaths.success).toBe(false);
    if (!missingPaths.success) {
      // The error is a union-level invalid_union; flatten its sub-errors so we
      // can find the strip_body_field branch's "paths missing" issue.
      const flatten = JSON.stringify(missingPaths.error.issues);
      expect(flatten).toContain("paths");
    }
  });

  it("RouteSchema accepts only known upstream shapes", () => {
    const ok = RouteSchema.safeParse({
      match: { path: "/x" },
      upstream: {
        via: "copilot_enterprise",
        via_endpoint: "openai_chat_completions",
        shape: "openai_chat",
      },
    });
    expect(ok.success).toBe(true);

    const bad = RouteSchema.safeParse({
      match: { path: "/x" },
      upstream: {
        via: "copilot_enterprise",
        via_endpoint: "anthropic_messages",
        shape: "alien_shape",
      },
    });
    expect(bad.success).toBe(false);
  });
});

// ============================================================================
// 6. fast-check property tests
// ============================================================================

describe("ConfigSchema — property tests", () => {
  it("random valid configs (varying routes) parse successfully", () => {
    fc.assert(
      fc.property(
        fc.array(
          // Pick one of the 3 coherent (via_endpoint, shape) pairings; D37
          // superRefine #5 requires them to match.
          fc
            .constantFrom(
              {
                via_endpoint: "anthropic_messages",
                shape: "anthropic_messages",
              },
              { via_endpoint: "openai_responses", shape: "openai_responses" },
              { via_endpoint: "openai_chat_completions", shape: "openai_chat" },
            )
            .chain((pair) =>
              fc.record({
                match: fc.record({
                  path: fc.stringMatching(/^\/[a-z][a-z0-9/_-]*$/),
                }),
                body_rules: fc.constant([]),
                header_rules: fc.constant([]),
                upstream: fc.record({
                  via: fc.constant("copilot_enterprise"),
                  via_endpoint: fc.constant(pair.via_endpoint),
                  shape: fc.constant(pair.shape),
                }),
              }),
            ),
          { maxLength: 5 },
        ),
        (routes) => {
          const result = ConfigSchema.safeParse({ routes });
          return result.success === true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("extra unknown keys at top level do not reject the config (passthrough)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.oneof(fc.integer(), fc.string(), fc.boolean()),
          { maxKeys: 4 },
        ),
        (extras) => {
          // Don't trample known top-level keys.
          for (const k of Object.keys(extras)) {
            if (
              k === "routes" ||
              k === "transforms" ||
              k === "logging" ||
              k === "auth"
            ) {
              return true;
            }
          }
          const input = { routes: [], ...extras };
          const result = ConfigSchema.safeParse(input);
          return result.success === true;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ============================================================================
// 7. semver smoke import
// ============================================================================

describe("semver dep smoke", () => {
  it("imports + basic satisfies works", () => {
    expect(semver.satisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(semver.satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(semver.gt("2.0.0", "1.99.99")).toBe(true);
  });
});

// ============================================================================
// 8. M9-FIX-PATHS-CONFIG (D37): endpoints + upstreams sections + cross-validation
// ============================================================================

describe("ConfigSchema D37 — endpoints + upstreams default", () => {
  it("minimal {} fills endpoints with the 5 canonical families", () => {
    const cfg = ConfigSchema.parse({});
    expect(Object.keys(cfg.endpoints).sort()).toEqual(
      [
        "anthropic_messages",
        "embeddings",
        "models",
        "openai_chat_completions",
        "openai_responses",
      ].sort(),
    );
    // Models defaults to GET method.
    expect(cfg.endpoints["models"]?.methods).toEqual(["GET"]);
  });

  it("minimal {} fills upstreams.copilot_enterprise with 5 canonical paths", () => {
    const cfg = ConfigSchema.parse({});
    const paths = cfg.upstreams["copilot_enterprise"]?.paths;
    expect(paths).toBeDefined();
    expect(paths?.["anthropic_messages"]).toBe("/v1/messages");
    expect(paths?.["openai_responses"]).toBe("/responses");
    expect(paths?.["openai_chat_completions"]).toBe("/chat/completions");
  });
});

describe("ConfigSchema D37 — cross-validation superRefine", () => {
  it("rejects unknown route.upstream.via with 'valid alternatives' list (#1)", () => {
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          upstream: {
            via: "nonexistent_service",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    const matched = messages.find(
      (m) =>
        m.includes("nonexistent_service") && m.includes("copilot_enterprise"),
    );
    expect(matched).toBeDefined();
  });

  it("rejects unknown route.upstream.via_endpoint with 'valid alternatives' list (#2)", () => {
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "bogus_endpoint",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    const matched = messages.find(
      (m) => m.includes("bogus_endpoint") && m.includes("anthropic_messages"),
    );
    expect(matched).toBeDefined();
  });

  it("rejects empty endpoints map (#3)", () => {
    const result = ConfigSchema.safeParse({ endpoints: {} });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("endpoints section is empty"))).toBe(
      true,
    );
  });

  it("rejects method-incoherent route: GET on a POST-only endpoint (#4)", () => {
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { method: "GET", path: "/v1/messages" },
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(
      messages.some(
        (m) => m.includes("GET") && m.includes("anthropic_messages"),
      ),
    ).toBe(true);
  });

  it("rejects shape-mismatched route (anthropic_messages endpoint with openai_chat shape) (#5)", () => {
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "openai_chat",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(
      messages.some(
        (m) =>
          m.includes("openai_chat") &&
          m.includes("anthropic_messages") &&
          m.includes("Suggested shape"),
      ),
    ).toBe(true);
  });

  it("warns (does NOT reject) on dangling endpoint defined-but-unreferenced (#6)", () => {
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      // Add a custom endpoint that nothing references, plus a dummy upstream
      // entry MISSING that endpoint, so the dangling check fires.
      const result = ConfigSchema.safeParse({
        endpoints: {
          anthropic_messages: { inbound_paths: ["/v1/messages"] },
          dangling_family: { inbound_paths: ["/dangling"] },
        },
        upstreams: {
          copilot_enterprise: {
            paths: { anthropic_messages: "/v1/messages" },
          },
        },
        routes: [
          {
            match: { method: "POST", path: "/v1/messages" },
            upstream: {
              via: "copilot_enterprise",
              via_endpoint: "anthropic_messages",
              shape: "anthropic_messages",
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(
        captured.some(
          (m) =>
            m.includes("dangling_family") &&
            m.toLowerCase().includes("dangling"),
        ),
      ).toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });
});

describe("ConfigSchema D37 — legacy preprocess shim (URL → symbolic)", () => {
  it("maps legacy route.upstream.endpoint URL to via/via_endpoint with deprecation warn", () => {
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const result = ConfigSchema.safeParse({
        routes: [
          {
            match: { method: "POST", path: "/v1/messages" },
            upstream: {
              endpoint: "https://api.enterprise.githubcopilot.com/v1/messages",
              shape: "anthropic_messages",
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // Verify the route now has the symbolic refs.
      expect(result.data.routes[0]?.upstream.via).toBe("copilot_enterprise");
      expect(result.data.routes[0]?.upstream.via_endpoint).toBe(
        "anthropic_messages",
      );
      // Verify the deprecation warning was emitted.
      expect(
        captured.some(
          (m) =>
            m.includes("DEPRECATED") &&
            m.includes("via/via_endpoint") &&
            m.includes("/v1/messages"),
        ),
      ).toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });

  it("permissive host matching is INTENTIONAL — non-githubcopilot hosts also map to symbolic (per legacyUpstreamUrlToSymbolic TSDoc § Permissive host matching)", () => {
    // Documents D37 design choice: route.upstream.endpoint was always
    // documentation-only in M5 (services hardcode the upstream URL via
    // copilotBaseUrl(accountType) + suffix). The operator-supplied URL host
    // was never authoritative at runtime, so the preprocess maps by
    // path-suffix alone. This test PROVES the permissive matching is
    // intentional + safe (no security boundary crossed — the host part of
    // the legacy URL was being ignored anyway). If someone later tightens
    // to require `api.{anything}.githubcopilot.com`, they should update
    // BOTH this test AND the legacyUpstreamUrlToSymbolic TSDoc.
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const result = ConfigSchema.safeParse({
        routes: [
          {
            match: { method: "POST", path: "/v1/messages" },
            upstream: {
              // Non-githubcopilot host — preprocess still maps by path-suffix.
              endpoint: "https://api.example.com/v1/messages",
              shape: "anthropic_messages",
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.routes[0]?.upstream.via).toBe("copilot_enterprise");
      expect(result.data.routes[0]?.upstream.via_endpoint).toBe(
        "anthropic_messages",
      );
      // Deprecation warning still fires regardless of host.
      expect(
        captured.some(
          (m) => m.includes("DEPRECATED") && m.includes("api.example.com"),
        ),
      ).toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });
});

describe("ConfigSchema F143 — logging.max_size_mb → warn_size_mb alias", () => {
  it("maps legacy logging.max_size_mb onto warn_size_mb with a deprecation warn", () => {
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const result = ConfigSchema.safeParse({
        logging: { max_size_mb: 100 },
        routes: [],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.logging.warn_size_mb).toBe(100);
      // The legacy spelling must not survive onto the parsed config.
      expect("max_size_mb" in result.data.logging).toBe(false);
      expect(
        captured.some(
          (m) =>
            m.includes("DEPRECATED") &&
            m.includes("max_size_mb") &&
            m.includes("warn_size_mb"),
        ),
      ).toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });

  it("an explicitly-set warn_size_mb WINS when both keys are present", () => {
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const result = ConfigSchema.safeParse({
        logging: { max_size_mb: 100, warn_size_mb: 7 },
        routes: [],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.logging.warn_size_mb).toBe(7);
      // Still deprecated: the legacy key was present, so the operator hears it.
      expect(captured.some((m) => m.includes("DEPRECATED"))).toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });

  it("a config using only warn_size_mb parses with NO deprecation warn", () => {
    const captured: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const result = ConfigSchema.safeParse({
        logging: { warn_size_mb: 12 },
        routes: [],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.logging.warn_size_mb).toBe(12);
      expect(captured.some((m) => m.includes("max_size_mb"))).toBe(false);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = orig;
    }
  });
});

describe("resolveUpstreamUrl helper (D37)", () => {
  it("composes copilotBaseUrl(account_type) + upstream path correctly", () => {
    const cfg = ConfigSchema.parse({
      auth: { account_type: "enterprise" },
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    const route = cfg.routes[0]!;
    expect(resolveUpstreamUrl(cfg, route)).toBe(
      "https://api.enterprise.githubcopilot.com/v1/messages",
    );
  });

  it("composes individual account host correctly (no subdomain prefix)", () => {
    const cfg = ConfigSchema.parse({
      auth: { account_type: "individual" },
      routes: [
        {
          match: { method: "POST", path: "/v1/messages" },
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    const route = cfg.routes[0]!;
    expect(resolveUpstreamUrl(cfg, route)).toBe(
      "https://api.githubcopilot.com/v1/messages",
    );
  });

  it("throws (NOT silent undefined-concat) when via is unresolvable", () => {
    // Build a minimally-valid config + then mutate it to simulate a
    // mid-runtime resolution gap (defense-in-depth check).
    const cfg = ConfigSchema.parse({});
    const route = {
      match: { method: "POST" as const, path: "/v1/messages" },
      body_rules: [] as never[],
      header_rules: [] as never[],
      response_rules: [] as never[],
      stream_event_rules: [] as never[],
      upstream: {
        via: "nonexistent_service",
        via_endpoint: "anthropic_messages",
        shape: "anthropic_messages" as const,
      },
    };
    expect(() =>
      resolveUpstreamUrl(
        cfg,
        route as Parameters<typeof resolveUpstreamUrl>[1],
      ),
    ).toThrow(/unknown upstream service/i);
  });

  it("throws when via_endpoint is unresolvable on a known service", () => {
    const cfg = ConfigSchema.parse({});
    const route = {
      match: { method: "POST" as const, path: "/v1/messages" },
      body_rules: [] as never[],
      header_rules: [] as never[],
      response_rules: [] as never[],
      stream_event_rules: [] as never[],
      upstream: {
        via: "copilot_enterprise",
        via_endpoint: "bogus_endpoint",
        shape: "anthropic_messages" as const,
      },
    };
    expect(() =>
      resolveUpstreamUrl(
        cfg,
        route as Parameters<typeof resolveUpstreamUrl>[1],
      ),
    ).toThrow(/no path for endpoint/i);
  });
});
