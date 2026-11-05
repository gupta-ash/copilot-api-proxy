/**
 * apply-initiator-headers.ts — inject the `derive_x_initiator` rule into the
 * Anthropic lanes' `header_rules` at boot, so the proxy always emits the
 * `x-initiator` / `x-interaction-type` pair GitHub's own Copilot client sends.
 *
 * **Why (CLIENT FIDELITY).** GitHub's Copilot CLI (1.0.74-4) sends the two
 * headers together and in lockstep on the wire: a request whose last user
 * message's content array ENDS WITH a `tool_result` block carries
 * `x-initiator: agent` + `x-interaction-type: conversation-agent`; anything
 * else carries `user` + `conversation-user`. The proxy already mimics VSCode's
 * static identification headers via `inject_copilot_static_headers`
 * (`config/default.yaml` Lane 1 `header_rules`); this is the same class of
 * change. Both header values come from ONE `deriveInitiator` call inside the
 * rule (`lib/transform/derive_x_initiator.ts`) — this module contains no
 * predicate of its own, only the config splice, so it cannot drift from the
 * derivation.
 *
 * **Why a BOOT-TIME injection rather than only a `config/default.yaml` edit.**
 * `scripts/install_bundle.ps1` § "Place config.yaml (host 127.0.0.1) only if
 * absent" copies `config/default.yaml` to the app dir ONLY when no
 * `config.yaml` is already there, and otherwise logs "config.yaml already
 * present … (leaving operator config as-is)". Every already-provisioned
 * machine therefore keeps its existing `config.yaml` across upgrades, so a
 * shipped-YAML edit alone would reach NEW installs only. The in-memory
 * injection reaches every machine on its next restart. This mirrors D70's
 * `applyBetaPolicy` (`lib/apply-beta-policy.ts`), which supersedes the
 * deployed config's beta rules for the same reason.
 *
 * **Boot-frozen.** `header_rules` are captured by closure in `buildApp`, so
 * `main.ts` must call this BEFORE `startServer` (it does — immediately after
 * `applyBetaPolicy`). Mutates `config.routes[*].header_rules` in place and
 * returns void.
 *
 * **This is an OVERRIDE, not a merge.** On EVERY route the function first
 * REMOVES every existing `header_rules` entry with `use: derive_x_initiator`
 * — including an operator's own entry under a different `name` and/or with a
 * custom `header_name` — and then, on the Anthropic lanes ONLY, APPENDS the
 * canonical pinned rule LAST. That is deliberate: it is the only rule that
 * converges from every input state (absent / present-with-defaults /
 * present-with-custom-options / present twice), so re-applying is idempotent
 * and the deployed lane always ends in exactly one canonical entry. Same
 * supersede-the-deployed-config posture `applyBetaPolicy` documents. Rules
 * that are not `derive_x_initiator` are preserved in their original order.
 *
 * **The STRIP runs on every route; only the APPEND is lane-scoped.** Skipping
 * non-Anthropic routes wholesale would leave an operator's pre-existing
 * `use: derive_x_initiator` rule running on a gpt lane, and the transform
 * itself carries no lane guard — so that lane would start emitting BOTH
 * headers the moment this feature shipped. That is not hypothetical: the
 * premise of the boot-time injection is precisely that a provisioned
 * machine's `config.yaml` is PRESERVED across upgrades
 * (`install_bundle.ps1` places it only if absent), so whatever an operator
 * wired by hand survives. Filtering every route makes the post-boot invariant
 * unconditional: `derive_x_initiator` runs on the Anthropic lanes and nowhere
 * else, whatever the deployed config said.
 *
 * **Lane selection is by UPSTREAM, not by `model_pattern` TEXT — and the
 * strip-then-skip asymmetry above is exactly why.** An earlier revision reused
 * `apply-beta-policy.ts`'s `isBetaLane`, i.e. `model_pattern.startsWith("^claude")`.
 * `decisions.md § D71` had already settled that classify-by-pattern-shape does
 * not converge: `startsWith("^claude")` UNDER-matches an Anthropic lane spelled
 * `^(?:claude-)` / `^[Cc]laude-` / unanchored `claude`, and the obvious
 * broadening to `/claude/i` OVER-matches a gpt pattern that merely CONTAINS the
 * substring (`^(?!claude-)gpt-5\.`). D71 accepted the under-match for BETA
 * policy only because the security invariant there was re-established
 * downstream, at the classification-independent egress guard `stripDeniedBetas`.
 * **This feature has no such downstream guard, and the failure mode is worse:**
 * the strip pass runs unconditionally, so on a false negative the boot pass
 * would DELETE the operator's own working `derive_x_initiator` rule and append
 * nothing — leaving that lane strictly worse off than before this module
 * existed, in direct contradiction of the preserve-deployed-config premise the
 * whole change rests on.
 *
 * So this module classifies on `route.upstream`, the field that actually
 * determines egress: `upstream.via_endpoint` names the endpoint family whose
 * path `resolveUpstreamUrl` composes the request URL from
 * (`config.upstreams[via].paths[via_endpoint]`), and `upstream.shape` names the
 * wire protocol the route speaks to it. Both are CLOSED vocabularies validated
 * by `ConfigSchema` (`shape` is a 3-value zod enum; `via_endpoint` must exist in
 * both `endpoints` and `upstreams[via].paths`, and superRefine check #5 pins the
 * two to each other for the standard families) — there is no spelling to get
 * wrong, so there is no under-match to accept. The third arm covers the
 * marker path: a route whose `body_rules` carry `redirect_to_anthropic_messages`
 * reaches `createAnthropicMessages` via `routes/_shared/marker-dispatch.ts`
 * whatever its declared `via_endpoint` says.
 *
 * Measured against the shipped `config/default.yaml`: Lane 1
 * (`/v1/messages × ^claude-`) and Lane 5 (`/responses × ^claude-`) both declare
 * `via_endpoint: anthropic_messages` + `shape: anthropic_messages`, and Lane 5
 * additionally carries the `redirect_to_anthropic_messages` body rule. The
 * three gpt lanes declare `openai_responses` / `openai_chat_completions` and
 * carry no such body rule — including Lane 4 (`/v1/messages × ^gpt-5\.`), which
 * shares a PATH with Lane 1 and is why classifying on `match.path` would be
 * wrong too. A non-Anthropic lane carrying no `derive_x_initiator` rule is left
 * byte-identical (same array reference).
 *
 * **`isBetaLane` is deliberately NOT reused and NOT re-exported.** It governs
 * SHIPPED beta behaviour (D70/D71, Release `98c7cfe`); changing which lanes it
 * selects would be a functional change to a different feature. The two
 * classifiers are now independent on purpose — they answer different questions
 * ("which lanes does the beta rewrite own" vs "which lanes egress to the
 * Anthropic upstream") and are allowed to disagree on an oddly-spelled lane,
 * which is precisely the case each handles differently.
 */

import { RuleSchema, type Config, type Route } from "~/types/config-schema.ts";

/**
 * The Anthropic-Messages upstream, spelled the two ways `RouteSchema` records
 * it: as an endpoint-family name (`upstream.via_endpoint`, the key
 * `resolveUpstreamUrl` looks the upstream path up under) and as an upstream
 * shape (`upstream.shape`, the `UpstreamShapeSchema` enum member). They are the
 * same string, and `ConfigSchema`'s superRefine check #5 pins them together for
 * this family — but they are read from two independent fields below so a config
 * that satisfies only one still classifies.
 */
const ANTHROPIC_MESSAGES = "anthropic_messages";

/**
 * The body rule that re-routes a request to the Anthropic Messages upstream at
 * dispatch time by setting the `x-proxy-redirect-to` marker
 * (`lib/transform/redirect_to_anthropic_messages.ts` →
 * `routes/_shared/marker-dispatch.ts`). A route carrying it reaches
 * `createAnthropicMessages` regardless of what its own `upstream` block
 * declares, so it is an Anthropic lane for this feature's purposes.
 */
function redirectsToAnthropicMessages(rule: unknown): boolean {
  if (rule === null || typeof rule !== "object") return false;
  return (rule as { use?: unknown }).use === "redirect_to_anthropic_messages";
}

/**
 * Does this route egress to the Anthropic Messages upstream? Classified from
 * `route.upstream` (+ the redirect marker rule), NEVER from `model_pattern`
 * text — see the module docblock for why D71 rules the textual test out here.
 */
function isAnthropicLane(route: Route): boolean {
  if (
    route.upstream.via_endpoint === ANTHROPIC_MESSAGES ||
    route.upstream.shape === ANTHROPIC_MESSAGES
  ) {
    return true;
  }
  return route.body_rules.some((r) => redirectsToAnthropicMessages(r));
}

/**
 * The canonical injected rule. Both header names are PINNED explicitly rather
 * than left to `DeriveXInitiatorSchema`'s zod defaults — same reasoning
 * `applyBetaPolicy`'s `baseline: []` pin carries: the injected rule is
 * self-describing in a trace/diff and immune to a future default change.
 */
function buildInitiatorRule(): Record<string, unknown> {
  return {
    name: "derive_initiator_headers",
    use: "derive_x_initiator",
    header_name: "x-initiator",
    interaction_type_header_name: "x-interaction-type",
  };
}

/**
 * Is this `header_rules` entry a `derive_x_initiator` rule? Matched on `use`,
 * NOT on `name` — an operator's own entry can carry any name. On an Anthropic
 * lane, leaving it in place alongside the injected rule would run the
 * derivation twice with possibly different header names; on a gpt lane,
 * leaving it in place would emit the pair on a lane that must not have it.
 */
function isDeriveInitiatorRule(rule: unknown): boolean {
  if (rule === null || typeof rule !== "object") return false;
  return (rule as { use?: unknown }).use === "derive_x_initiator";
}

/**
 * Inject the canonical `derive_x_initiator` rule into every Anthropic lane's
 * `header_rules`, and STRIP any pre-existing entry of that rule type from
 * EVERY route (Anthropic or not). Mutates `config.routes[*].header_rules` in
 * place (the same reference `startServer` captures). A non-Anthropic lane that
 * carries no such rule keeps its original array reference.
 *
 * @throws if the injected rule fails `RuleSchema` validation — an internal
 *   construction bug (the registry-backed schema is the same one the config
 *   loader + transform engine use). Callers run at boot before `startServer`,
 *   so a throw here fails LOUD (bootstrap catch → exit 1) rather than shipping
 *   a malformed rule that would only surface per-request.
 */
export function applyInitiatorHeaders(config: Config): void {
  const rule = buildInitiatorRule();

  // Defense-in-depth: the injected rule MUST parse against the canonical
  // registry-backed RuleSchema before we splice it into a lane.
  const parsed = RuleSchema.safeParse(rule);
  if (!parsed.success) {
    throw new Error(
      `applyInitiatorHeaders: injected rule '${String(rule["name"])}' ` +
        `(use=${String(rule["use"])}) failed RuleSchema validation: ${parsed.error.message}`,
    );
  }

  for (const route of config.routes) {
    // STRIP on every route — a gpt lane that an operator already wired with a
    // derive_x_initiator rule would otherwise keep emitting the pair there
    // (the transform has no lane guard of its own). See the module docblock.
    const kept = route.header_rules.filter((r) => !isDeriveInitiatorRule(r));
    if (isAnthropicLane(route)) {
      route.header_rules = [...kept, rule];
    } else if (kept.length !== route.header_rules.length) {
      route.header_rules = kept;
    }
  }
}
