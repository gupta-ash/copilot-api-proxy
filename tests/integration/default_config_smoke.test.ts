/**
 * tests/integration/default_config_smoke.test.ts — M9-FIX-PATHS-CONFIG (D37) smoke test
 * for the production-grade `config/default.yaml`.
 *
 * Per M9-FIX-PATHS-CONFIG spec § default.yaml + Acceptance Criteria:
 *   1. Loads `config/default.yaml`, asserts zod validation passes.
 *   2. Asserts the new `endpoints` + `upstreams` sections are present with
 *      the canonical 5 endpoint families + `copilot_enterprise` service.
 *   3. Asserts 6 lanes per PATH_MATRIX (was 4 in M9; +2 new in D37).
 *   4. Per-lane assertions: match + upstream symbolic refs + shape.
 *   5. NEGATIVE: no `route.upstream.endpoint` (URL string) field anywhere.
 *   6. NEGATIVE: production Claude lane does NOT include R10 strip_body_block.
 *   7. Asserts derive_x_initiator is wired on the ^claude- lanes only, and the
 *      other 2 D33 derive primitives appear ONLY as commented-out reference.
 *   8. Asserts `merge_anthropic_betas` wired with mode=union + advanced-tool-use.
 *   9. Asserts `validateResponseShape` returns 0 failures across all 6 routes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, test } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules
import { ConfigSchema } from "~/types/config-schema.ts";
import { snapshot } from "~/lib/transform/registry.ts";
import { validateResponseShape } from "~/lib/transform/_validate_response_shape.ts";
import type { Rule } from "~/types/config-schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_YAML_PATH = path.join(REPO_ROOT, "config", "default.yaml");

/** Read default.yaml from disk + return its raw text (for substring asserts). */
function readDefaultYamlText(): string {
  return readFileSync(DEFAULT_YAML_PATH, "utf-8");
}

/** Read + zod-parse default.yaml; returns the typed Config. */
function loadDefaultConfig(): ReturnType<typeof ConfigSchema.parse> {
  const text = readDefaultYamlText();
  const parsed = YAML.parse(text) as unknown;
  return ConfigSchema.parse(parsed);
}

describe("M9-FIX-PATHS-CONFIG smoke: config/default.yaml", () => {
  test("zod validates the production default.yaml without errors", () => {
    expect(() => loadDefaultConfig()).not.toThrow();
  });

  test("endpoints section: 5 families with canonical inbound paths (D37)", () => {
    const cfg = loadDefaultConfig();
    expect(Object.keys(cfg.endpoints).sort()).toEqual(
      [
        "anthropic_messages",
        "embeddings",
        "models",
        "openai_chat_completions",
        "openai_responses",
      ].sort(),
    );
    expect(cfg.endpoints["anthropic_messages"]?.inbound_paths).toEqual([
      "/v1/messages",
    ]);
    expect(cfg.endpoints["openai_responses"]?.inbound_paths).toEqual([
      "/responses",
      "/v1/responses",
    ]);
    expect(cfg.endpoints["openai_chat_completions"]?.inbound_paths).toEqual([
      "/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(cfg.endpoints["embeddings"]?.inbound_paths).toEqual([
      "/embeddings",
      "/v1/embeddings",
    ]);
    expect(cfg.endpoints["models"]?.inbound_paths).toEqual([
      "/models",
      "/v1/models",
    ]);
    expect(cfg.endpoints["models"]?.methods).toEqual(["GET"]);
  });

  test("upstreams.copilot_enterprise.paths: per-family canonical upstream paths (D37)", () => {
    const cfg = loadDefaultConfig();
    const paths = cfg.upstreams["copilot_enterprise"]?.paths;
    expect(paths).toBeDefined();
    expect(paths?.["anthropic_messages"]).toBe("/v1/messages");
    expect(paths?.["openai_responses"]).toBe("/responses");
    expect(paths?.["openai_chat_completions"]).toBe("/chat/completions");
    expect(paths?.["embeddings"]).toBe("/embeddings");
    expect(paths?.["models"]).toBe("/models");
  });

  test("five supported lanes are wired in declared order", () => {
    const cfg = loadDefaultConfig();
    expect(cfg.routes).toHaveLength(5);

    // Lane 1 — CC → Claude (native passthrough)
    const lane1 = cfg.routes[0]!;
    expect(lane1.match.path).toBe("/v1/messages");
    expect(lane1.match.method).toBe("POST");
    expect(lane1.match.model_pattern).toBe("^claude-");
    expect(lane1.upstream.via).toBe("copilot_enterprise");
    expect(lane1.upstream.via_endpoint).toBe("anthropic_messages");
    expect(lane1.upstream.shape).toBe("anthropic_messages");

    // Lane 2 — Codex → GPT-5 / GPT-6 families (native passthrough on /responses).
    // `^gpt-[56]` admits gpt-5-mini (no dot after the 5) and the gpt-6 family.
    const lane2 = cfg.routes[1]!;
    expect(lane2.match.path).toBe("/responses");
    expect(lane2.match.model_pattern).toBe("^gpt-[56]");
    // strip_body_field removes `service_tier`: Copilot 400s on it with ANY value
    // and Codex sends "priority" whenever its fast tier is on.
    const lane2Bodies = lane2.body_rules as Rule[];
    expect(lane2Bodies.map((r) => r.use)).toEqual(["strip_body_field"]);
    expect((lane2Bodies[0] as { paths?: unknown }).paths).toEqual([
      "service_tier",
    ]);
    expect(lane2.upstream.via_endpoint).toBe("openai_responses");
    expect(lane2.upstream.shape).toBe("openai_responses");

    // Lane 3 — Native /chat/completions for GPT-4 only
    const lane3 = cfg.routes[2]!;
    expect(lane3.match.path).toBe("/chat/completions");
    expect(lane3.match.model_pattern).toBe("^gpt-4");
    expect(lane3.upstream.via_endpoint).toBe("openai_chat_completions");
    expect(lane3.upstream.shape).toBe("openai_chat");

    // Lane 4 — CC → GPT-5 / GPT-6 families cross-vendor (translated to /responses).
    // `^gpt-[56]` is Lane 2's pattern: it admits gpt-5-mini and the gpt-6 family.
    const lane4 = cfg.routes[3]!;
    expect(lane4.match.path).toBe("/v1/messages");
    expect(lane4.match.model_pattern).toBe("^gpt-[56]");
    expect(lane4.upstream.via_endpoint).toBe("openai_responses");
    expect(lane4.upstream.shape).toBe("openai_responses");

    // Lane 5 — Codex → Claude cross-vendor (canonical inbound /responses)
    const lane5 = cfg.routes[4]!;
    expect(lane5.match.path).toBe("/responses");
    expect(lane5.match.model_pattern).toBe("^claude-");
    expect(lane5.upstream.via_endpoint).toBe("anthropic_messages");
    expect(lane5.upstream.shape).toBe("anthropic_messages");

    // No additional route is implicitly enabled.
    expect(cfg.routes.length).toBe(5);
  });

  test("NEGATIVE: no route.upstream.endpoint URL field (D37 — symbolic refs only)", () => {
    const cfg = loadDefaultConfig();
    for (const route of cfg.routes) {
      // The new schema has stripped the `endpoint` field; assert it's not
      // present even via the as-cast escape hatch.
      const ups = route.upstream as Record<string, unknown>;
      expect(ups["endpoint"]).toBeUndefined();
      // And the new symbolic refs MUST be present.
      expect(typeof ups["via"]).toBe("string");
      expect(typeof ups["via_endpoint"]).toBe("string");
    }
  });

  test("validateResponseShape returns 0 failures across all 5 routes", () => {
    const cfg = loadDefaultConfig();
    const bodySnap = snapshot("body");
    const allFailures: unknown[] = [];
    for (const route of cfg.routes) {
      const failures = validateResponseShape(
        route.body_rules as Rule[],
        route.response_rules as Rule[],
        bodySnap,
        bodySnap,
      );
      allFailures.push(...failures);
    }
    if (allFailures.length > 0) {
      throw new Error(
        `validateResponseShape returned ${allFailures.length} failures: ${JSON.stringify(allFailures, null, 2)}`,
      );
    }
    expect(allFailures).toHaveLength(0);
  });

  test("each redirected lane has its matching response_passthrough_* consumer (D-LOCK-7 + D-LOCK-13)", () => {
    const cfg = loadDefaultConfig();

    // Lane 1 (Claude passthrough): NO redirect → empty response_rules.
    expect(cfg.routes[0]!.response_rules).toEqual([]);

    // Lane 2 (Codex GPT-5 / GPT-6 passthrough): no redirect, but has a consumer.
    const lane2Consumers = (cfg.routes[1]!.response_rules as Rule[]).map(
      (r) => r.use,
    );
    expect(lane2Consumers).toContain("response_passthrough_openai_responses");

    // Lane 3 (native /chat/completions GPT-4): no redirect, has consumer.
    const lane3Consumers = (cfg.routes[2]!.response_rules as Rule[]).map(
      (r) => r.use,
    );
    expect(lane3Consumers).toContain(
      "response_passthrough_openai_chat_completions",
    );

    // Lane 4 (CC→GPT-5 / GPT-6 cross-vendor): redirect_to_responses + consumer.
    const lane4Bodies = (cfg.routes[3]!.body_rules as Rule[]).map((r) => r.use);
    expect(lane4Bodies).toContain("redirect_to_responses");
    const lane4Consumers = (cfg.routes[3]!.response_rules as Rule[]).map(
      (r) => r.use,
    );
    expect(lane4Consumers).toContain("response_passthrough_openai_responses");

    // Lane 5 (Codex→Claude cross-vendor): redirect_to_anthropic_messages + consumer.
    const lane5Bodies = (cfg.routes[4]!.body_rules as Rule[]).map((r) => r.use);
    expect(lane5Bodies).toContain("redirect_to_anthropic_messages");
    const lane5Consumers = (cfg.routes[4]!.response_rules as Rule[]).map(
      (r) => r.use,
    );
    expect(lane5Consumers).toContain(
      "response_passthrough_anthropic_v1_messages",
    );

  });

  test("NEGATIVE: production Claude system blocks are not stripped by the fixture-demo rule", () => {
    const cfg = loadDefaultConfig();
    const claudeLane = cfg.routes[0]!;
    const claudeBodies = (claudeLane.body_rules as Rule[]).filter(
      (r) => r.use === "strip_body_block",
    );
    for (const rule of claudeBodies) {
      const selector = (rule as { selector?: { path?: string } }).selector;
      expect(selector?.path).not.toBe("system[].text");
    }
  });

  test("derive_x_initiator is WIRED on the ^claude- lanes only; the other 2 D33 primitives stay commented-out", () => {
    const cfg = loadDefaultConfig();

    // POSITIVE, route-scoped: each Anthropic lane (^claude-) carries exactly
    // one derive_x_initiator header rule; each gpt lane carries none. This is
    // strictly stronger than the old `allRules).not.toContain(...)` negative it
    // replaces — it pins WHERE the rule is wired, not merely that it exists.
    for (const route of cfg.routes) {
      const initiatorRules = (route.header_rules as Rule[]).filter(
        (r) => r.use === "derive_x_initiator",
      );
      const isAnthropicLane = (route.match.model_pattern ?? "").startsWith(
        "^claude",
      );
      expect(initiatorRules).toHaveLength(isAnthropicLane ? 1 : 0);
    }
    // Exactly the 2 documented Anthropic lanes (Lane 1 + Lane 5).
    const wiredLanes = cfg.routes.filter((route) =>
      (route.header_rules as Rule[]).some(
        (r) => r.use === "derive_x_initiator",
      ),
    );
    expect(wiredLanes).toHaveLength(2);
    expect(wiredLanes.map((r) => r.match.path)).toEqual([
      "/v1/messages",
      "/responses",
    ]);

    // The other two D33 primitives remain unwired.
    const allRules: string[] = [];
    for (const route of cfg.routes) {
      for (const r of route.body_rules as Rule[]) allRules.push(r.use);
      for (const r of route.header_rules as Rule[]) allRules.push(r.use);
      for (const r of route.response_rules as Rule[]) allRules.push(r.use);
    }
    expect(allRules).not.toContain("derive_copilot_vision_request");
    expect(allRules).not.toContain("derive_context_management_beta");

    const text = readDefaultYamlText();
    // The commented-out reference entry for derive_x_initiator is GONE (the
    // rule is wired now). NOTE: the wired form cannot be asserted by substring
    // — a commented `# - name: derive_initiator_headers` line would contain it
    // too. The parsed-config assertions above are what prove it is wired,
    // because YAML.parse drops comments.
    expect(text).not.toContain("# - name: derive_x_initiator");
    expect(text).toContain("# - name: derive_copilot_vision_request");
    expect(text).toContain("# - name: derive_context_management_beta");
  });

  test("merge_anthropic_betas wired with mode=union + append=[advanced-tool-use-2025-11-20]", () => {
    const cfg = loadDefaultConfig();
    let found = false;
    for (const route of cfg.routes) {
      for (const r of route.header_rules as Rule[]) {
        if (r.use !== "merge_anthropic_betas") continue;
        const mode = (r as { mode?: string }).mode;
        const append = (r as { append?: string[] }).append;
        if (
          mode === "union" &&
          Array.isArray(append) &&
          append.includes("advanced-tool-use-2025-11-20")
        ) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
