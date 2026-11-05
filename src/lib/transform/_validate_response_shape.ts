/**
 * _validate_response_shape.ts — engine-internal helper that walks a config's
 * rule list and verifies every `redirect_to_*` body rule (which declares
 * `response_shape: "anthropic_v1_messages" | "openai_chat_completions"`)
 * has a matching response-side rule consumer for the declared shape.
 *
 * **Scope.** Per D-LOCK-4: M9's config-load layer will import and consume
 * this; M2's apply.ts does NOT call it. M6 ships the function + scaffold
 * test (`tests/integration/redirect_response_shape.test.ts`) so M9 has a
 * shovel-ready validator.
 *
 * **Why an underscore prefix.** Per `scripts/gen_barrel.ts § isRuleFile`:
 * files prefixed with `_` are private modules (not rules) and never get
 * side-effect imported into the body/stream_event registry. This file
 * exports a pure validator function — no `register()` call.
 *
 * **Contract.**
 *
 * ```ts
 * export function validateResponseShape(
 *   bodyRules: Rule[],
 *   responseRules: Rule[],
 *   bodyRegistrySnapshot: ReadonlyMap<string, RegisteredBodyRule>,
 * ): ValidationFailure[]
 * ```
 *
 * Returns an empty array when the config is consistent. Each
 * `ValidationFailure` describes one rule that redirects to a shape with
 * no matching response-side consumer rule. M9 will turn these into
 * config-load errors:
 *
 * > `Rule '<rule.name>' redirects to <shape> but no response rules
 * > configured for that shape.`
 *
 * **Response-rule contract (M9 will refine).** A response-side rule
 * "consumes" a shape when its registry entry's `opts.response_shape`
 * MATCHES the redirect's declared shape. M6 doesn't ship any such
 * response rules — they're M7a/M7b territory. For M6, the validator
 * simply checks that each `response_shape` declared by a body redirect
 * rule appears in `responseRules`' set of `response_shape` values.
 *
 * **Stdlib only. No external deps.**
 */

import type { RegisteredBodyRule } from "./registry.ts";
import type { Rule } from "./types.ts";

export interface ValidationFailure {
  /** The body rule that declared the unmatched response_shape. */
  bodyRuleName: string;
  /** The unmatched shape name (e.g., "anthropic_v1_messages"). */
  shape: string;
  /** Human-readable message — same wording M9's config loader will use. */
  message: string;
}

/**
 * Walk `bodyRules`. For each rule whose registry entry declares a
 * `response_shape`, check `responseRules` for at least one entry whose
 * registry entry declares the SAME `response_shape`. Return failures.
 *
 * Side-effect free; safe to call from any code path (including tests).
 */
export function validateResponseShape(
  bodyRules: Rule[],
  responseRules: Rule[],
  bodyRegistrySnapshot: ReadonlyMap<string, RegisteredBodyRule>,
  responseRegistrySnapshot: ReadonlyMap<string, RegisteredBodyRule>,
): ValidationFailure[] {
  // Collect all shapes claimed by response-side rules.
  const offeredShapes = new Set<string>();
  for (const r of responseRules) {
    const reg = responseRegistrySnapshot.get(r.use);
    if (reg === undefined) continue;
    if (reg.opts.response_shape !== undefined) {
      offeredShapes.add(reg.opts.response_shape);
    }
  }

  const failures: ValidationFailure[] = [];
  for (const r of bodyRules) {
    const reg = bodyRegistrySnapshot.get(r.use);
    if (reg === undefined) continue;
    const declaredShape = reg.opts.response_shape;
    if (declaredShape === undefined) continue;
    if (!offeredShapes.has(declaredShape)) {
      failures.push({
        bodyRuleName: r.name,
        shape: declaredShape,
        message: `Rule '${r.name}' redirects to ${declaredShape} but no response rules configured for that shape.`,
      });
    }
  }
  return failures;
}
