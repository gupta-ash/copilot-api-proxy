/**
 * beta-egress-guard.test.ts — Feature D1 (Option 1) classification-INDEPENDENT
 * egress deny guard (`stripDeniedBetas` in
 * `services/copilot/create-anthropic-messages.ts`).
 *
 * `createAnthropicMessages` is the SINGLE choke-point through which both
 * Anthropic-upstream lanes egress (Lane 1 native `/v1/messages`, Lane 5
 * `/responses`→Anthropic redirect). The guard strips `config.anthropic_beta.deny`
 * from the outbound `anthropic-beta` header there, regardless of how (or whether)
 * `isBetaLane` classified the route — closing the isBetaLane UNDER-match hole at
 * the boundary.
 *
 * Coverage:
 *   (a) unit — strips deny tokens, preserves non-denied tokens + order; no-op on
 *       absent header / no-match / empty deny; drops the header when empty after
 *       strip; case-sensitive; input never mutated.
 *   (b) KEY — a claude lane NOT classified as a beta lane (no denyTail injected)
 *       STILL has denied tokens stripped at egress by the guard.
 *   (c) a correctly-classified lane (denyTail already stripped deny upstream) →
 *       the guard is a clean no-op: no double-strip, no corruption of survivors.
 *
 * The body registry is a shared singleton across test files; force-(re)register
 * the two rules the injected denylist rule-set uses (idempotent via
 * allow_override) so applyBetaPolicy validation + applyRules see them regardless
 * of Bun's file ordering. (Same pattern as apply-beta-policy.test.ts.)
 */

import { beforeAll, describe, expect, it } from "bun:test";

import "~/lib/transform/index.ts"; // side-effect: register all rules
import { applyBetaPolicy } from "~/lib/apply-beta-policy.ts";
import { applyRules } from "~/lib/transform/apply.ts";
import {
  merge_anthropic_betas,
  MergeAnthropicBetasSchema,
} from "~/lib/transform/merge_anthropic_betas.ts";
import { register, snapshot } from "~/lib/transform/registry.ts";
import {
  strip_header_csv_token,
  StripHeaderCsvTokenSchema,
} from "~/lib/transform/strip_header_csv_token.ts";
import type { Rule, TransformContext } from "~/lib/transform/types.ts";
import { stripDeniedBetas } from "~/services/copilot/create-anthropic-messages.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";

beforeAll(() => {
  register(
    "merge_anthropic_betas",
    merge_anthropic_betas,
    MergeAnthropicBetasSchema,
    { allow_override: true },
  );
  register(
    "strip_header_csv_token",
    strip_header_csv_token,
    StripHeaderCsvTokenSchema,
    { allow_override: true },
  );
});

/** The default-denylist token (config.anthropic_beta.deny === [DENIED]). */
const DENIED = "advisor-tool-2026-03-01";

/** Parse a CSV header value into a Set of trimmed tokens. */
function toSet(csv: string | undefined): Set<string> {
  if (csv === undefined) return new Set();
  return new Set(
    csv
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

/** Single-route config with the given model_pattern (header_rules default []). */
function laneConfig(
  model_pattern: string,
  header_rules: unknown[] = [],
): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: { method: "POST", path: "/v1/messages", model_pattern },
        header_rules,
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

/** Rule names on a route's header_rules after zod-parse (RuleSchema → unknown). */
function ruleNames(config: Config): (string | undefined)[] {
  return (config.routes[0]!.header_rules as Array<{ name?: string }>).map(
    (r) => r.name,
  );
}

describe("stripDeniedBetas — unit (classification-independent guard behavior)", () => {
  it("(a) strips the deny token and preserves non-denied tokens IN ORDER", () => {
    const out = stripDeniedBetas(
      { "anthropic-beta": `alpha, ${DENIED}, beta, gamma` },
      [DENIED],
    );
    // Exact survivor order preserved (serializeCsv joins with ", ").
    expect(out["anthropic-beta"]).toBe("alpha, beta, gamma");
  });

  it("(a) strips MULTIPLE deny tokens; leaves unrelated headers untouched", () => {
    const out = stripDeniedBetas(
      {
        "anthropic-beta": "a, bad1, b, bad2, c",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer x",
      },
      ["bad1", "bad2"],
    );
    expect(out["anthropic-beta"]).toBe("a, b, c");
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["authorization"]).toBe("Bearer x");
  });

  it("no anthropic-beta header → no-op (same reference returned)", () => {
    const input = { "anthropic-version": "2023-06-01" };
    expect(stripDeniedBetas(input, [DENIED])).toBe(input);
  });

  it("no denied token present → no-op (same reference, value byte-for-byte)", () => {
    const input = { "anthropic-beta": "alpha,  beta ,gamma" };
    const out = stripDeniedBetas(input, [DENIED]);
    expect(out).toBe(input);
    expect(out["anthropic-beta"]).toBe("alpha,  beta ,gamma");
  });

  it("empty deny list → no-op (same reference)", () => {
    const input = { "anthropic-beta": `alpha, ${DENIED}` };
    expect(stripDeniedBetas(input, [])).toBe(input);
  });

  it("empty after strip → the anthropic-beta header is DROPPED entirely (never send empty)", () => {
    const out = stripDeniedBetas(
      { "anthropic-beta": DENIED, "anthropic-version": "2023-06-01" },
      [DENIED],
    );
    expect("anthropic-beta" in out).toBe(false);
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("empty after stripping ALL (multiple) tokens → header dropped", () => {
    const out = stripDeniedBetas({ "anthropic-beta": "bad1, bad2" }, [
      "bad1",
      "bad2",
    ]);
    expect("anthropic-beta" in out).toBe(false);
  });

  it("header ARRIVED already-empty ('') → dropped, not forwarded (GAN iter-5 LOW: denyTail-stripped-all edge)", () => {
    // An upstream denyTail (strip_header_csv_token) that strips every token
    // serializes [] -> "" and writes `anthropic-beta: ""` back rather than
    // dropping the header. That already-empty header (before=[], kept=[], so
    // 0 === 0) must NOT slip through the no-match no-op and be forwarded as "".
    const out = stripDeniedBetas(
      { "anthropic-beta": "", "anthropic-version": "2023-06-01" },
      [DENIED],
    );
    expect("anthropic-beta" in out).toBe(false);
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("header arrives whitespace/comma-only (parses to zero tokens) → dropped", () => {
    // parseCsv(" , , ") === [] — same empty-result path; the header is dropped,
    // never forwarded as a blank value.
    const out = stripDeniedBetas({ "anthropic-beta": " , , " }, [DENIED]);
    expect("anthropic-beta" in out).toBe(false);
  });

  it("EMPTY header with an EMPTY deny list → still dropped (GAN iter-6: deny-independent empty drop)", () => {
    // The empty-header drop is INDEPENDENT of the deny list. `deny: []` must NOT
    // short-circuit before it: an allowlist filter (empty allow) can reduce
    // anthropic-beta to "" even with an empty deny list, and that empty header
    // must not be forwarded as `anthropic-beta: ""`.
    const out = stripDeniedBetas({ "anthropic-beta": "", "x-keep": "1" }, []);
    expect("anthropic-beta" in out).toBe(false);
    expect(out["x-keep"]).toBe("1");
  });

  it("token match is CASE-SENSITIVE (matches strip_header_csv_token / filter_header_csv)", () => {
    // A deny entry differing only in case must NOT match the header token.
    const out = stripDeniedBetas(
      { "anthropic-beta": "Advisor-Tool-2026-03-01, keep" },
      [DENIED],
    );
    expect(toSet(out["anthropic-beta"]).has("Advisor-Tool-2026-03-01")).toBe(
      true,
    );
    expect(toSet(out["anthropic-beta"]).has("keep")).toBe(true);
  });

  it("does not mutate the input dict", () => {
    const input = { "anthropic-beta": `keep, ${DENIED}` };
    stripDeniedBetas(input, [DENIED]);
    expect(input["anthropic-beta"]).toBe(`keep, ${DENIED}`);
  });
});

describe("egress guard × lane classification (Option 1 — closes the under-match hole)", () => {
  it("(b) KEY: a claude lane NOT classified as a beta lane STILL has denied tokens stripped at egress", async () => {
    // A claude-targeting lane whose pattern does NOT literally start with
    // "^claude" (regex-group spelling). Post-Option-1, isBetaLane (startsWith)
    // does NOT classify it → applyBetaPolicy injects NO denyTail → the transform
    // pipeline leaves the denied token in the outbound header. The
    // classification-INDEPENDENT egress guard is the ONLY thing that strips it.
    const config = laneConfig("^(?:claude-)");
    applyBetaPolicy(config, "denylist");
    const lane = config.routes[0]!;

    // Precondition: the under-matched lane received NO denyTail.
    expect(ruleNames(config)).not.toContain("beta_policy_deny");

    // Run the lane's (empty) header pipeline over a header carrying a denied
    // token — it survives precisely because no denyTail exists on this lane.
    const ctx: TransformContext = {
      body: {},
      headers: { "anthropic-beta": `${DENIED}, claude-code-20250219` },
      route: "/v1/messages",
      model: "claude-opus-4.8",
    };
    const piped = await applyRules(
      ctx,
      lane.header_rules as unknown as Rule[],
      snapshot("body"),
    );
    expect(toSet(piped.ctx.headers["anthropic-beta"]).has(DENIED)).toBe(true);

    // The egress guard strips it regardless of the (missing) classification.
    const guarded = stripDeniedBetas(
      piped.ctx.headers,
      config.anthropic_beta.deny,
    );
    const out = toSet(guarded["anthropic-beta"]);
    expect(out.has(DENIED)).toBe(false);
    expect(out.has("claude-code-20250219")).toBe(true);
  });

  it("(c) correctly-classified beta lane: denyTail already stripped deny → guard is a clean no-op", async () => {
    // A properly-anchored ^claude- lane IS classified → applyBetaPolicy injects
    // [beta_policy_merge, beta_policy_deny]. The denyTail strips the denied
    // token during the pipeline, so by egress the header carries none. The guard
    // must then be a pure no-op: NO double-strip, NO corruption of survivors.
    const config = laneConfig("^claude-");
    applyBetaPolicy(config, "denylist");
    const lane = config.routes[0]!;
    expect(ruleNames(config)).toContain("beta_policy_deny");

    const ctx: TransformContext = {
      body: {},
      headers: { "anthropic-beta": `${DENIED}, claude-code-20250219` },
      route: "/v1/messages",
      model: "claude-opus-4.8",
    };
    const piped = await applyRules(
      ctx,
      lane.header_rules as unknown as Rule[],
      snapshot("body"),
    );
    // Pipeline (denyTail) already removed the denied token.
    expect(toSet(piped.ctx.headers["anthropic-beta"]).has(DENIED)).toBe(false);

    // Guard sees nothing to strip → returns the SAME dict reference, unchanged.
    const guarded = stripDeniedBetas(
      piped.ctx.headers,
      config.anthropic_beta.deny,
    );
    expect(guarded).toBe(piped.ctx.headers);
    // Survivors intact: client token + the merged proxy-required beta.
    const out = toSet(guarded["anthropic-beta"]);
    expect(out.has("claude-code-20250219")).toBe(true);
    expect(out.has("advanced-tool-use-2025-11-20")).toBe(true);
  });
});
