/**
 * derive_x_initiator.ts — body-engine rule: derives the PAIR of Copilot
 * client headers `x-initiator` (`"agent"` | `"user"`) and
 * `x-interaction-type` (`"conversation-agent"` | `"conversation-user"`) by
 * inspecting the LAST content block of the LAST USER message on
 * `ctx.body.messages`.
 *
 * **Lane:** any Anthropic-shape lane (CC→Claude, Codex→Claude). The rule
 * mirrors omp's `inferCopilotInitiator` heuristic so the proxy can derive
 * Copilot-Ent–compatible headers from request content when the client did
 * not supply them.
 *
 * **Why BOTH headers, and why from ONE derivation — CLIENT FIDELITY.**
 * GitHub's own Copilot CLI (1.0.74-4) sends the two headers together and in
 * lockstep on the wire: `x-initiator: agent` always accompanies
 * `x-interaction-type: conversation-agent`, and `user` accompanies
 * `conversation-user`. Emitting them from a single `deriveInitiator` call
 * makes that lockstep STRUCTURAL rather than conventional — the second value
 * is the pure string function `` `conversation-${derived}` `` of the first,
 * so nothing in the derivation, the ordering of the two writes, or an engine
 * error path can desync the two VALUES. The rule's OWN options could still
 * desync the PAIR, and did until this was fixed: both names are lowercased
 * before write, so two names equal modulo case address ONE key, the second
 * `setHeader` wins, and the request carries a single malformed half
 * (measured: `header_name: x-initiator` + `interaction_type_header_name:
 * X-Initiator` emitted exactly `{"x-initiator":"conversation-agent"}`).
 * `DeriveXInitiatorSchema` REJECTS an AUTHORED collision at parse time (the
 * `.refine` below, which sees the raw input — both fields present and equal
 * modulo case). A collision that exists only because ONE field was written and
 * the OTHER took its default is TOLERATED at parse time and handled
 * deterministically at apply time: exactly one header is written,
 * `header_name` carrying the initiator value. That asymmetry is deliberate and
 * is the difference between a bad header and a proxy that will not start — see
 * the schema comment and the apply-time comment for the full reasoning.
 *
 * **The resulting guarantee, stated exactly.** For any options this schema
 * accepts whose two RESOLVED names differ, one application of this rule writes
 * BOTH headers or NEITHER, with values in lockstep. For the one tolerated
 * shape whose resolved names COLLIDE, it writes exactly ONE header carrying
 * the initiator value — never the malformed interaction-type-under-the-
 * initiator-key half. It does not — and cannot — promise that some other rule
 * later in the same lane's `header_rules` won't overwrite one of them; a
 * second `derive_x_initiator` entry with crossed names would be such a rule,
 * and what rules THAT out is `lib/apply-initiator-headers.ts`, which strips
 * every `derive_x_initiator` entry from every route at boot and appends
 * exactly one canonical entry on the Anthropic lanes.
 *
 * This is the same class of change as `inject_copilot_static_headers`
 * (`config/default.yaml` `header_rules`), which mimics VSCode's static
 * identification headers.
 *
 * **Wiring (supersedes the original D33 opt-in posture).** `decisions.md § D33`
 * shipped all three M9 derive primitives unwired. This rule is no longer one
 * of them: `config/default.yaml` wires it on both Anthropic lanes, AND
 * `applyInitiatorHeaders` (`src/lib/apply-initiator-headers.ts`) re-injects it
 * into those lanes at boot regardless of what the DEPLOYED `config.yaml`
 * carries — because `scripts/install_bundle.ps1` places `config.yaml` only if
 * absent ("leaving operator config as-is"), so a provisioned machine never
 * picks up a `config/default.yaml` edit. The other two primitives
 * (`derive_copilot_vision_request`, `derive_context_management_beta`) remain
 * opt-in. Wiki/41 `inferCopilotInitiator` (L42) +
 * `verification/wiki41_to_v2_mapping.md § GAP-1` document the heuristic
 * surfaced in operator-side observation.
 *
 * **Logic** (per spec D-LOCK-2; matches omp `inferCopilotInitiator`):
 *   - If `ctx.body` is not an object OR has no `messages` array OR the
 *     messages array is empty → derived value `"user"` (default).
 *   - Else search BACKWARD from the end of `messages` for the LAST entry whose
 *     `role === "user"`, and inspect THAT message's content:
 *     - If its `content` is a non-empty array AND its LAST element has
 *       `.type === "tool_result"` → derived value `"agent"`.
 *     - Otherwise → derived value `"user"`.
 *   - If `messages` contains no user-role message at all → `"user"` (the same
 *     conservative default every other non-qualifying shape returns).
 *   - `x-initiator` := derived; `x-interaction-type` := `conversation-${derived}`.
 *   - Both headers are written together in one expression, or neither is:
 *     the ONLY early return requires BOTH to ALREADY hold their derived
 *     values, so a partially pre-set context (say `x-initiator` present but
 *     `x-interaction-type` absent) is completed rather than skipped.
 *     `applied: true` whenever either header was missing or differed.
 *
 * **Why the ROLE check is load-bearing, not decoration.** An earlier revision
 * read `messages[messages.length - 1]` with no role filter, which is a
 * different function from the one every docblock here describes and disagrees
 * with it on two reachable shapes:
 *   - a qualifying user `tool_result` followed by an assistant message — the
 *     unfiltered read inspects the ASSISTANT turn and derives `"user"`, but
 *     the request IS an agent continuation;
 *   - an assistant-last message whose own final block is `tool_result`-shaped
 *     — the unfiltered read derives `"agent"` off a block the user never sent.
 * Today's Claude Code traffic is always user-last, so neither shape fires on
 * the wire; that made it a LATENT defect plus a false docblock claim, which
 * this repo treats as a defect in its own right. The backward search is what
 * makes the stated contract and the code the same function.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["headers"]`.
 *
 * **D-LOCK-18 (M9 spec):** the rule fn opens with
 * `const opts = DeriveXInitiatorSchema.parse(options);` to materialize the
 * `header_name` + `interaction_type_header_name` defaults at runtime (the
 * engine's safeParse-only validation in `apply.ts:230` does NOT carry parsed
 * defaults through to the rule fn). The defaults are applied by the schema's
 * trailing `.transform()` rather than by per-field `.default()`, so that the
 * collision `.refine()` can run on the pre-default values; `parse()` is the
 * same call either way, so this is invisible to the rule fn. Reference
 * pattern: M8's `merge_anthropic_betas.ts:112`.
 *
 * **No upstream cribbing** — derivation heuristic mirrors omp's
 * `inferCopilotInitiator`; no copilot-api-pro bundle equivalent.
 *
 * **Cross-references.**
 *   - `decisions.md § D33` — the original opt-in default rationale (this rule
 *     is now wired; see the wiring note above).
 *   - `verification/wiki41_to_v2_mapping.md § GAP-1` — gap surfacing.
 *   - `lib/apply-initiator-headers.ts` — boot-time injector for both headers.
 *   - `lib/headers.ts § getHeader/setHeader` — header dict helpers.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { getHeader, setHeader } from "../headers.ts";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

/** Default for `header_name` when the operator omits it. */
const DEFAULT_HEADER_NAME = "x-initiator";
/** Default for `interaction_type_header_name` when the operator omits it. */
const DEFAULT_INTERACTION_TYPE_HEADER_NAME = "x-interaction-type";

/**
 * Rejection message for an AUTHORED collision. Names both option fields so the
 * operator can act on it without reading this file.
 */
const COLLIDING_NAMES_MESSAGE =
  "derive_x_initiator: `header_name` and `interaction_type_header_name` must name DIFFERENT headers (compared case-insensitively — both are lowercased before write). Equal names collapse to a single header carrying only the interaction-type value.";

const DeriveXInitiatorSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("derive_x_initiator"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    /**
     * Header name to write (default `"x-initiator"`, applied by the
     * `.transform()` below rather than by `.default()` — see the collision
     * note). Lowercased before set.
     */
    header_name: z.string().optional(),
    /**
     * Header name for the paired interaction-type value (default
     * `"x-interaction-type"`, likewise applied by the `.transform()`).
     * Lowercased before set. Its VALUE is always `conversation-${derived}` —
     * not separately configurable, because the lockstep with `header_name`'s
     * value is the point of the rule. It MUST NOT be set to `header_name`'s
     * value case-insensitively; see the `.refine` below.
     */
    interaction_type_header_name: z.string().optional(),
  })
  .passthrough()
  // Both names are lowercased before `setHeader`, so two names that differ
  // only in case address the SAME header key: the nested setHeader calls
  // would then collapse to one write and emit `x-initiator:
  // conversation-agent` — one malformed half of the pair, which is exactly
  // the desync the rule exists to make impossible. The derivation cannot
  // desync the two VALUES; only a colliding pair of configured NAMES can, so
  // an AUTHORED collision is rejected here, at config-parse time, rather than
  // papered over at apply time. Comparison is case-INSENSITIVE for the same
  // reason.
  //
  // **Why the two fields are `.optional()` here and defaulted in the
  // `.transform()` below, rather than carrying `.default()` on the object.**
  // A zod `.default()` materializes DURING object parsing, so a `.refine()`
  // stacked on the object sees the DEFAULTED value, not what the operator
  // wrote. That made this guard reject a config the operator never authored a
  // collision in: the legacy single-header rule `{header_name:
  // x-interaction-type}` — valid under the pre-pair schema, and still parsed
  // by any deployed `config.yaml` that predates the pairing — collided with
  // the freshly materialized `interaction_type_header_name` default and FAILED
  // VALIDATION. Config parsing happens at BOOT, strictly before
  // `applyInitiatorHeaders` gets to strip that rule, so the proxy would not
  // start at all: an upgrade turns a working deployment into a dead one and
  // takes every connected Claude Code / Codex session with it. Low
  // probability, maximal consequence — so the guard now fires ONLY on a
  // collision the operator actually WROTE, i.e. only when BOTH fields are
  // present in the raw input. A collision that exists only because one field
  // was set and the other DEFAULTED parses successfully and is handled
  // deterministically at apply time (see `derive_x_initiator` below).
  .refine(
    (o) =>
      o.header_name === undefined ||
      o.interaction_type_header_name === undefined ||
      o.header_name.toLowerCase() !==
        o.interaction_type_header_name.toLowerCase(),
    COLLIDING_NAMES_MESSAGE,
  )
  // Defaults are applied AFTER the collision check, so the check can only ever
  // see operator-authored values. Unknown keys survive (`.passthrough()`).
  .transform((o) => ({
    ...o,
    header_name: o.header_name ?? DEFAULT_HEADER_NAME,
    interaction_type_header_name:
      o.interaction_type_header_name ?? DEFAULT_INTERACTION_TYPE_HEADER_NAME,
  }));

/**
 * Derive `"agent" | "user"` per D-LOCK-2 logic. Pure read of `body`.
 *
 * Inspects the LAST USER message — found by searching `messages` BACKWARD for
 * `role === "user"` — not simply the last message. See the file docblock
 * (§ "Why the ROLE check is load-bearing") for the two shapes on which the two
 * readings disagree.
 */
function deriveInitiator(body: unknown): "agent" | "user" {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "user";
  }
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return "user";
  }
  // Backward scan for the last user-role message. A message that is not an
  // object, or carries any other role, is skipped rather than terminating the
  // scan — an assistant turn after the user's tool_result must not hide it.
  let lastUser: Record<string, unknown> | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate: unknown = messages[i];
    if (candidate === null || typeof candidate !== "object") continue;
    if ((candidate as Record<string, unknown>).role === "user") {
      lastUser = candidate as Record<string, unknown>;
      break;
    }
  }
  // No user-role message anywhere → the conservative default, unchanged.
  if (lastUser === null) {
    return "user";
  }
  const content = lastUser.content;
  if (!Array.isArray(content) || content.length === 0) {
    return "user";
  }
  const lastBlock: unknown = content[content.length - 1];
  if (
    lastBlock !== null &&
    typeof lastBlock === "object" &&
    (lastBlock as Record<string, unknown>).type === "tool_result"
  ) {
    return "agent";
  }
  return "user";
}

const derive_x_initiator: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = DeriveXInitiatorSchema.parse(options);
  // ONE derivation. `interaction` is a total function of `derived`, computed
  // in the same expression sequence with no branch between them — that is what
  // makes the two header values impossible to desync.
  const derived = deriveInitiator(ctx.body);
  const interaction = `conversation-${derived}`;
  const initiatorName = opts.header_name;
  const initiatorKey = initiatorName.toLowerCase();
  const interactionName = opts.interaction_type_header_name;
  const interactionKey = interactionName.toLowerCase();
  const beforeInitiator = getHeader(ctx.headers, initiatorName);
  // COLLIDING RESOLVED NAMES — the degraded-but-DETERMINISTIC path.
  //
  // The schema rejects a collision the operator AUTHORED (both fields written
  // and equal modulo case), but deliberately tolerates one that arises because
  // exactly one field was set and the other took its default — a legacy
  // single-header rule such as `{header_name: x-interaction-type}`. Rejecting
  // that at parse time would stop the proxy BOOTING, which is strictly worse
  // than anything a header can do (see the schema comment above).
  //
  // Left to the nested `setHeader(setHeader(...))` below, such a rule would
  // collapse to ONE write whose surviving value is the interaction-type
  // string — `x-interaction-type: conversation-agent` under a key the operator
  // meant to carry `agent`. That is silently malformed: the exact desync this
  // rule exists to prevent, now arriving through the tolerated door. So the
  // collision is handled EXPLICITLY instead: write `header_name` ONLY, with
  // the initiator value, and do not attempt the second write. One header, one
  // value, chosen rather than fallen into.
  //
  // **Why writing only the initiator half is safe here.**
  // `lib/apply-initiator-headers.ts` runs at boot, BEFORE `startServer`
  // captures `header_rules` by closure: it STRIPS every `derive_x_initiator`
  // entry from EVERY route and appends exactly one canonical entry — with both
  // names pinned explicitly, and therefore non-colliding — on the Anthropic
  // lanes. A colliding legacy rule is thus removed before it can ever execute,
  // on every route, whatever the deployed `config.yaml` said. This path exists
  // so the process BOOTS and so the behaviour is defined if the rule is ever
  // invoked directly (a unit test, a future caller that bypasses the
  // injector); the degraded single-header output is NOT desirable and is not a
  // supported configuration.
  if (initiatorKey === interactionKey) {
    if (beforeInitiator === derived) {
      return { ctx, applied: false };
    }
    ctx.headers = setHeader(ctx.headers, initiatorName, derived);
    return {
      ctx,
      applied: true,
      before: { [initiatorKey]: beforeInitiator ?? null },
      after: { [initiatorKey]: derived },
    };
  }
  const beforeInteraction = getHeader(ctx.headers, interactionName);
  // Early return requires BOTH to already match. A single-header check here
  // would skip the write when only `x-initiator` was pre-set, emitting one
  // half of the pair — the exact desync this rule exists to prevent.
  if (beforeInitiator === derived && beforeInteraction === interaction) {
    return { ctx, applied: false };
  }
  ctx.headers = setHeader(
    setHeader(ctx.headers, initiatorName, derived),
    interactionName,
    interaction,
  );
  return {
    ctx,
    applied: true,
    before: {
      [initiatorKey]: beforeInitiator ?? null,
      [interactionKey]: beforeInteraction ?? null,
    },
    after: { [initiatorKey]: derived, [interactionKey]: interaction },
  };
};

register("derive_x_initiator", derive_x_initiator, DeriveXInitiatorSchema, {
  ctx_reads: ["body"],
  ctx_writes: ["headers"],
});

export { derive_x_initiator, DeriveXInitiatorSchema };
