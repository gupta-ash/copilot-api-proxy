/**
 * Parse-only assertions for the stream_event_rules in config/default.yaml:
 *
 *   - Lane 1 (CC → Claude native passthrough): stream_event_rules: []
 *     (verbatim byte path; preserves CC→Claude passthrough)
 *   - Lane 2 (Codex → GPT-5 / GPT-6 native): stream_event_rules: []
 *     (native Responses-shape; no translation)
 *   - Lane 3 (native chat → GPT-4): stream_event_rules: []
 *     (chat completions upstream; no translation)
 *   - Lane 4 (CC → GPT-5 / GPT-6 cross-vendor): stream_event_rules:
 *     [{ use: translate_responses_event_to_anthropic_event }]
 *   - Lane 5 (Codex → Claude cross-vendor): stream_event_rules:
 *     [{ use: translate_anthropic_event_to_responses_event }]
 *
 * **Why YAML-parse only (not full ConfigSchema validation):** the
 * production loader (`loadAndValidate`) is exercised by other tests
 * (`tests/lib/config.test.ts`, `tests/integration/redirect_to_responses_dispatch.test.ts`)
 * with fresh-spawned configs covering subsets of rule registrations.
 * This file's mission is structural wiring assertion: the YAML reads,
 * the lanes exist, the `stream_event_rules` arrays are exactly what
 * D-LOCK-7 specifies. Full schema validation here would require
 * registering all 18 rules used in default.yaml (rename_model,
 * clamp_effort, strip_body_field, strip_body_block, inject_headers,
 * filter_header_csv, strip_header_csv_token, merge_anthropic_betas,
 * + the 10 my ensureRulesRegistered already covered) — and would
 * duplicate coverage of the schema-validation pipeline.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, test, expect } from "bun:test";
import { parse } from "yaml";

const DEFAULT_YAML_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "config",
  "default.yaml",
);

interface RouteUseable {
  use?: string;
}

interface RouteShape {
  match: { path: string; model_pattern?: string };
  body_rules?: RouteUseable[];
  header_rules?: RouteUseable[];
  stream_event_rules?: RouteUseable[];
  response_rules?: RouteUseable[];
}

interface ConfigShape {
  routes: RouteShape[];
}

async function loadDefault(): Promise<RouteShape[]> {
  const text = await readFile(DEFAULT_YAML_PATH, "utf-8");
  const cfg = parse(text) as ConfigShape;
  return cfg.routes;
}

describe("default_config_stream_smoke — D-LOCK-7 stream_event_rules wiring", () => {
  test("default.yaml parses and has five supported lanes", async () => {
    const routes = await loadDefault();
    expect(routes.length).toBe(5);
  });

  test("[M10 D] Lane 1 (CC → Claude native; /v1/messages × ^claude-) has stream_event_rules: [] (verbatim byte path)", async () => {
    const routes = await loadDefault();
    const lane1 = routes.find(
      (r) =>
        r.match.path === "/v1/messages" && r.match.model_pattern === "^claude-",
    );
    expect(lane1).toBeDefined();
    // YAML-omitted = undefined; explicit-empty = []. Either is acceptable
    // (RouteSchema defaults to []); but for forward-clarity we expect
    // either undefined OR an empty array. Assert via length-zero.
    const rules = lane1?.stream_event_rules ?? [];
    expect(rules.length).toBe(0);
  });

  test("[M10 D] Lane 2 (Codex → GPT-5 / GPT-6 native; /responses × ^gpt-[56]) has stream_event_rules: [] (native shape)", async () => {
    const routes = await loadDefault();
    const lane2 = routes.find(
      (r) =>
        r.match.path === "/responses" && r.match.model_pattern === "^gpt-[56]",
    );
    expect(lane2).toBeDefined();
    const rules = lane2?.stream_event_rules ?? [];
    expect(rules.length).toBe(0);
  });

  test("[M10 D] Lane 3 (native chat → GPT-4; /chat/completions × ^gpt-4) has stream_event_rules: [] (chat upstream shape)", async () => {
    const routes = await loadDefault();
    const lane3 = routes.find(
      (r) =>
        r.match.path === "/chat/completions" &&
        r.match.model_pattern === "^gpt-4",
    );
    expect(lane3).toBeDefined();
    const rules = lane3?.stream_event_rules ?? [];
    expect(rules.length).toBe(0);
  });

  test("[M10 D] Lane 4 (CC → GPT-5 / GPT-6 cross-vendor; /v1/messages × ^gpt-[56]) wires translate_responses_event_to_anthropic_event", async () => {
    const routes = await loadDefault();
    const lane4 = routes.find(
      (r) =>
        r.match.path === "/v1/messages" &&
        r.match.model_pattern === "^gpt-[56]",
    );
    expect(lane4).toBeDefined();
    const uses = (lane4?.stream_event_rules ?? []).map((r) => r.use);
    expect(uses).toEqual(["translate_responses_event_to_anthropic_event"]);
  });

  test("[M10 D] Lane 5 (Codex → Claude cross-vendor; /responses × ^claude-) wires translate_anthropic_event_to_responses_event", async () => {
    const routes = await loadDefault();
    const lane5 = routes.find(
      (r) =>
        r.match.path === "/responses" && r.match.model_pattern === "^claude-",
    );
    expect(lane5).toBeDefined();
    const uses = (lane5?.stream_event_rules ?? []).map((r) => r.use);
    expect(uses).toEqual(["translate_anthropic_event_to_responses_event"]);
  });

});
