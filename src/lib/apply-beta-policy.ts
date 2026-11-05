/**
 * apply-beta-policy.ts — rewrite the beta lanes' `anthropic-beta` `header_rules`
 * per a resolved policy (`denylist` | `allowlist` | `strip_all`).
 *
 * **Why (Feature D1).** GitHub Copilot's upstream is now a DENYLIST for
 * `anthropic-beta`: it rejects specific tokens by name (400 "unsupported beta
 * header(s): ...") and passes everything else (an unknown/nonsense beta returns
 * 200 — verified). The pre-D1 posture was a per-lane ALLOWLIST that silently
 * dropped every beta not on a hand-maintained list, so a new upstream-accepted
 * beta could never be used until someone re-tested + expanded the list. Moving
 * to a denylist lets new betas flow for free.
 *
 * **The two escape hatches are NOT equivalent — reach for `strip_all`.** On the
 * rare day upstream rejects a NEW beta CC sends, every CC request 400s until the
 * token is dealt with. `strip_all` is GUARANTEED to stop that outage whichever
 * token upstream revoked, because it drops the `anthropic-beta` header entirely.
 * `allowlist` is only SITUATIONAL: it restores the pre-D1 known-good posture but
 * still FORWARDS the rejected token when that token is in `allow`/`merge_append`
 * — and `advanced-tool-use-2025-11-20` is in both (`config/default.yaml:132`,
 * `:135`; merge-appended at `:238` Lane 1 / `:400` Lane 5), so `allowlist` would
 * NOT have stopped an outage caused by it. This asymmetry is the wording the
 * proxy actually prints to the operator at `routes/_shared/error-helpers.ts:306-311`
 * and the recovery order in `docs/runbook.md`; keep all three in agreement.
 *
 * **In-memory, boot-time application (per plan finding #4).** `header_rules` are
 * boot-frozen: handlers capture `config` by closure in `buildApp`. `main.ts`
 * calls `applyBetaPolicy(config, mode)` BEFORE `startServer`, so the rewrite is
 * captured by every handler. This is a schema-default single-channel design (W2
 * precedent): the policy layer supersedes whatever beta `header_rules` the
 * deployed `config.yaml` carries — no per-machine config edit needed.
 *
 * **Beta lanes** = routes whose `match.model_pattern` targets Claude (starts
 * with `^claude`): Lane 1 (`/v1/messages`) + Lane 5 (`/responses` cross-vendor).
 * The gpt lanes (`^gpt-*`: Lanes 2/3/4) are left untouched.
 *
 * **Idempotent.** For each beta lane the function first REMOVES every existing
 * `header_rules` entry that targets `anthropic-beta` (across all four
 * beta-related rule types), then INJECTS the mode's canonical rule-set. So
 * re-applying the same mode — or switching modes — always converges to exactly
 * the mode's rule-set, whether the input carried the old allowlist rules,
 * already-denylist rules, or a prior `strip_all` rule. Non-beta rules (esp.
 * `inject_copilot_static_headers`, which sets `anthropic-version` — NOT a beta)
 * are preserved in order.
 */

import { RuleSchema, type Config, type Route } from "~/types/config-schema.ts";

/** The three beta-policy modes. Mirrors `config.anthropic_beta.policy`. */
export type BetaPolicyMode = "denylist" | "allowlist" | "strip_all";

/**
 * A beta lane targets the Claude upstream — its `match.model_pattern` literally
 * starts with `^claude` (the shape the shipped `config/default.yaml` uses:
 * Lane 1 `/v1/messages × ^claude-`, Lane 5 `/responses × ^claude-`).
 *
 * **Why `startsWith("^claude")` and not `/claude/i`:** this is the provably-safe
 * classifier — it matches exactly the anchored `^claude…` patterns the proxy
 * actually ships and nothing else.
 *   (a) It cannot OVER-match. A gpt pattern that merely CONTAINS the substring
 *       "claude" — e.g. a negative lookahead `^(?!claude-)gpt-5\.` — does NOT
 *       start with `^claude`, so it is correctly left untouched (a `/claude/i`
 *       test would have wrongly rewritten it). All `^gpt-*` lanes are excluded,
 *       incl. Lane 4 (`/v1/messages × ^gpt-5\.`) which shares a path with Lane 1.
 *   (b) A route with NO `model_pattern` (a catch-all) is intentionally NOT a beta
 *       lane — the proxy has no catch-all claude route, and a catch-all is not
 *       Anthropic-specific, so it must not be force-rewritten.
 *
 * **Spelling-robustness is now the egress guard's job, not this function's.** A
 * claude-targeting lane written in a spelling that does NOT start with `^claude`
 * (a regex group `^(?:claude-)`, char-class `^[Cc]laude-`, or an unanchored
 * `claude`) is deliberately NOT classified here — so `applyBetaPolicy` injects no
 * denyTail on it. The security invariant (a denied token never reaches the
 * Anthropic upstream) is instead upheld for such an under-matched lane at the
 * boundary, by the classification-INDEPENDENT egress guard `stripDeniedBetas`
 * (`services/copilot/create-anthropic-messages.ts`): it strips `deny` from the
 * outbound `anthropic-beta` header regardless of how the route was classified.
 * This removes the fragile text-matching from `isBetaLane` while keeping the
 * invariant fail-closed at the single Anthropic-upstream egress choke-point.
 */
function isBetaLane(route: Route): boolean {
  const pattern = route.match.model_pattern;
  return typeof pattern === "string" && pattern.startsWith("^claude");
}

/**
 * Does this `header_rules` entry target the `anthropic-beta` header? True for:
 *   - `merge_anthropic_betas` — hardcoded to `anthropic-beta` (no `header` opt).
 *   - `filter_header_csv` / `strip_header_csv_token` with `header` (case-insensitive)
 *     === `anthropic-beta`.
 *   - `strip_header` whose `headers` is EXACTLY `[anthropic-beta]` (case-insensitive) —
 *     the shape this function injects for `strip_all`. Matching exactly-one keeps
 *     re-apply idempotent WITHOUT clobbering an operator's multi-header strip.
 */
function targetsAnthropicBeta(rule: unknown): boolean {
  if (rule === null || typeof rule !== "object") return false;
  const r = rule as { use?: unknown; header?: unknown; headers?: unknown };
  const use = r.use;
  if (use === "merge_anthropic_betas") return true;
  if (use === "filter_header_csv" || use === "strip_header_csv_token") {
    return (
      typeof r.header === "string" &&
      r.header.toLowerCase() === "anthropic-beta"
    );
  }
  if (use === "strip_header") {
    return (
      Array.isArray(r.headers) &&
      r.headers.length === 1 &&
      typeof r.headers[0] === "string" &&
      r.headers[0].toLowerCase() === "anthropic-beta"
    );
  }
  return false;
}

/**
 * Guard against a `strip_header` rule that lists `anthropic-beta` ALONGSIDE
 * other headers (`headers: ["anthropic-beta", "x-foo"]`). Such a rule is NOT
 * caught by `targetsAnthropicBeta` (which matches only the exactly-one-beta
 * shape, to keep re-apply idempotent without clobbering a multi-header strip),
 * so left intact it would strip the WHOLE `anthropic-beta` header before the
 * injected policy runs — silently overriding the policy. Returns:
 *   - a CLONE with `anthropic-beta` removed from `headers` (keeps the rule's
 *     OTHER headers) when the rule is a multi-header strip that includes it;
 *   - `null` when removing `anthropic-beta` would leave `headers` empty (a
 *     degenerate `["anthropic-beta","anthropic-beta"]` shape) — the caller
 *     drops the rule, since the `strip_header` schema requires `headers.min(1)`;
 *   - the rule UNCHANGED for anything else (incl. the exactly-`[anthropic-beta]`
 *     shape, already removed upstream by the `targetsAnthropicBeta` filter).
 * Clones rather than mutating in place, matching the header-pipeline
 * immutability style (`lib/headers.ts`).
 */
function scrubBetaFromMultiStripHeader(rule: unknown): unknown {
  if (rule === null || typeof rule !== "object") return rule;
  const r = rule as { use?: unknown; headers?: unknown };
  if (r.use !== "strip_header" || !Array.isArray(r.headers)) return rule;
  const isBeta = (h: unknown): boolean =>
    typeof h === "string" && h.toLowerCase() === "anthropic-beta";
  if (r.headers.length <= 1 || !r.headers.some(isBeta)) return rule;
  const remaining = r.headers.filter((h) => !isBeta(h));
  if (remaining.length === 0) return null;
  return { ...(rule as Record<string, unknown>), headers: remaining };
}

/**
 * Build the canonical injected rule-set for `mode`. Each rule carries a stable
 * `name` so it is greppable in traces + diffs.
 *
 * **Fail-closed deny is authoritative in EVERY non-strip mode.** The LAST
 * injected rule is always a `strip_header_csv_token` deny (`beta_policy_deny`),
 * in both `denylist` AND `allowlist` mode. So a token in `anthropic_beta.deny`
 * can never reach upstream — not via the client's header, not via the merge's
 * `append`/`baseline`, and not via an `allow` list that happens to also list it
 * (the documented `-BetaPolicy allowlist` escape hatch must still honor deny).
 * The merge rule pins `baseline: []` so it never relies on
 * `merge_anthropic_betas`' hidden schema-default baseline — the `append` list is
 * the single source of proxy-ensured tokens, and the trailing deny has the final
 * say. This one uniform invariant replaces the iter-1 `append`-minus-`deny`
 * subtraction (no longer needed: the trailing deny strips any denied token from
 * the merged `client ∪ append` result regardless of how it got there).
 *
 * NOTE: `strip_all` injects `strip_header` with `headers: ["anthropic-beta"]`
 * (the plural-array shape the `strip_header` rule schema requires) — NOT a
 * singular `header` field. It emits NO merge/deny rule (the header is being
 * removed entirely; there is nothing to merge into or strip tokens from).
 */
function buildRuleSet(
  config: Config,
  mode: BetaPolicyMode,
): Array<Record<string, unknown>> {
  const ab = config.anthropic_beta;
  // Trailing fail-closed deny — the last word in denylist AND allowlist modes.
  const denyTail: Record<string, unknown> = {
    name: "beta_policy_deny",
    use: "strip_header_csv_token",
    header: "anthropic-beta",
    deny: [...ab.deny],
  };
  // Merge pins baseline: [] (see doc comment) — append is the sole ensured-token
  // source; denyTail below strips anything in deny out of the merged result.
  const merge: Record<string, unknown> = {
    name: "beta_policy_merge",
    use: "merge_anthropic_betas",
    mode: "union",
    append: [...ab.merge_append],
    baseline: [],
  };
  switch (mode) {
    case "denylist":
      return [merge, denyTail];
    case "allowlist":
      return [
        {
          name: "beta_policy_allow",
          use: "filter_header_csv",
          header: "anthropic-beta",
          allow: [...ab.allow],
        },
        merge,
        denyTail,
      ];
    case "strip_all":
      return [
        {
          name: "beta_policy_strip_all",
          use: "strip_header",
          headers: ["anthropic-beta"],
        },
      ];
  }
}

/**
 * Rewrite the beta lanes' `anthropic-beta` `header_rules` in `config` per
 * `mode`. Mutates `config.routes[*].header_rules` in place (the same reference
 * `startServer` captures). Non-beta lanes are untouched.
 *
 * @throws if an injected rule fails `RuleSchema` validation — an internal
 *   construction bug (the registry-backed schema is the same one the config
 *   loader + transform engine use). Callers run at boot before `startServer`,
 *   so a throw here fails LOUD (bootstrap catch → exit 1) rather than shipping
 *   a malformed rule that would only surface per-request.
 */
export function applyBetaPolicy(config: Config, mode: BetaPolicyMode): void {
  const ruleSet = buildRuleSet(config, mode);

  // Defense-in-depth: every injected rule MUST parse against the canonical
  // registry-backed RuleSchema before we splice it into a lane.
  for (const rule of ruleSet) {
    const parsed = RuleSchema.safeParse(rule);
    if (!parsed.success) {
      throw new Error(
        `applyBetaPolicy: injected rule '${String(rule["name"])}' ` +
          `(use=${String(rule["use"])}) failed RuleSchema validation: ${parsed.error.message}`,
      );
    }
  }

  for (const route of config.routes) {
    if (!isBetaLane(route)) continue;
    // Rebuild header_rules: drop single-target anthropic-beta rules entirely,
    // SCRUB anthropic-beta out of any multi-header strip_header rule (so it no
    // longer overrides the injected policy but still strips its OTHER headers),
    // preserve everything else in order, then append the mode's rule-set.
    const preserved: unknown[] = [];
    for (const rule of route.header_rules) {
      if (targetsAnthropicBeta(rule)) continue;
      const scrubbed = scrubBetaFromMultiStripHeader(rule);
      if (scrubbed !== null) preserved.push(scrubbed);
    }
    route.header_rules = [...preserved, ...ruleSet];
  }
}
