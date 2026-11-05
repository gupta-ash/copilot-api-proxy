/**
 * lint.ts — diagnostic state-collision detector for rule lists (per F4 in
 * M2.5; ctx-surface extension per F5/M6 D-LOCK-3).
 *
 * **Why this exists.** State-access manifests are RECORDED in
 * `RegisteredRule.opts.{reads, writes}` (per X6) but never ENFORCED until
 * M9 lands cross-rule conflict detection at config-load time. M3-M8 will
 * introduce ~30 stream-event rules that read/write per-stream state; two
 * rules both `writes: ["finalUsage"]` would silently collide for five
 * milestones with first detection at M9. `lint.ts` closes that visibility
 * gap NOW: it runs once per `applyRules`/`applyEvent` invocation and
 * surfaces findings via `debug.on(LEVEL_ON)` so an operator running with
 * debug ON sees the collision immediately. Production (debug OFF) stays
 * silent.
 *
 * **Diagnostic, not enforcement.** This module NEVER throws and NEVER
 * aborts apply. It writes to the engine debug stream only. M9 will layer
 * config-load-time enforcement on top of this exact same detection logic
 * (the lint findings will be promoted to errors).
 *
 * **Cost.** O(n + r×w) per call where n = rule list length, r = total
 * reads, w = total writes. n is 10-20 in production; r/w typically <50.
 * Runs ONCE per stream-open (body) or once per apply call — NOT per
 * event in the per-event hot path.
 *
 * **Detected:**
 *   - **WARN dup_use** — duplicate `use:` in the rule list (same fn
 *     registered twice; usually a config typo, harmless if intended).
 *   - **WARN write_after_write** — two rules both `writes: ["X"]` where
 *     X is the same state field (the second silently shadows the first;
 *     rarely intended).
 *   - **INFO read_without_writer** — rule reads X without any prior rule
 *     in the list writing X (allowed but worth flagging — usually means
 *     a missing upstream rule).
 *   - **(F5/M6) WARN ctx_write_after_write** — two rules both write the
 *     same ctx surface (e.g. both `ctx_writes: ["headers"]`). Emitted for
 *     the **`headers`** surface only — the `body` surface is intentionally
 *     skipped because every body rule writes body in some sense
 *     (e.g. `rename_model` then `clamp_effort`) and the noise > signal
 *     ratio would be poor. M9's config-load enforcement may revisit.
 *   - **(F5/M6) INFO ctx_read_without_writer** — rule reads a ctx surface
 *     without any prior rule in the list writing it. Emitted for the
 *     **`headers`** surface only (same rationale as above — `body` always
 *     starts populated, so the finding is rarely actionable).
 *
 * **No external deps.** Stdlib-only TypeScript.
 */

import type {
  CtxSurface,
  RegisteredBodyRule,
  RegisteredStreamEventRule,
} from "./registry.ts";
import type { Rule } from "./types.ts";

/**
 * A single lint finding. Severity is informational; consumers (M2.5
 * `apply.ts`/`apply_event.ts`) emit them via `debug.on(LEVEL_ON)`. M9
 * will use the same shape but promote to throw at config-load time.
 */
export interface LintResult {
  /** `"warn"` for collision-class issues; `"info"` for advisories. */
  severity: "warn" | "info";
  /** Stable code for grep / dashboard categorization. */
  code:
    | "dup_use"
    | "write_after_write"
    | "read_without_writer"
    | "ctx_write_after_write"
    | "ctx_read_without_writer";
  /** Human-readable explanation. */
  message: string;
  /** Rule names involved (display-name, NOT `use:`). */
  ruleNames: string[];
}

type RegisteredAny = RegisteredBodyRule | RegisteredStreamEventRule;

/**
 * Detect state-collision and config-typo patterns in a rule list.
 *
 * @param rules             — the declared rule list (in order)
 * @param registrySnapshot  — the surface registry snapshot (manifests live here)
 * @param surface           — surface label used in diagnostic messages only;
 *                            does not change detection logic
 * @returns                  — array of findings (empty when clean)
 */
export function lintRules(
  rules: Rule[],
  registrySnapshot: ReadonlyMap<string, RegisteredAny>,
  surface: "body" | "stream_event",
): LintResult[] {
  const findings: LintResult[] = [];

  // 1. Duplicate `use:` detection — independent of manifests.
  const useToNames = new Map<string, string[]>();
  for (const r of rules) {
    const names = useToNames.get(r.use) ?? [];
    names.push(r.name);
    useToNames.set(r.use, names);
  }
  for (const [useKey, names] of useToNames) {
    if (names.length > 1) {
      findings.push({
        severity: "warn",
        code: "dup_use",
        message: `[${surface}] rule "use: ${useKey}" registered ${names.length} times in the rule list (rule names: ${names.join(", ")}). Usually a config typo; harmless if intended.`,
        ruleNames: names,
      });
    }
  }

  // 2. Write-after-write + read-without-writer detection — uses the
  //    registry's reads/writes manifests.
  const fieldToWriters = new Map<string, string[]>();
  for (const r of rules) {
    const reg = registrySnapshot.get(r.use);
    // Unregistered rules are caught loudly by apply{,_event}.ts; lint just
    // skips them so we don't double-emit.
    if (reg === undefined) continue;

    // Reader-without-writer check FIRST (uses prior writers only — does
    // not include this rule's own writes, even if it both reads and writes).
    if (reg.opts.reads !== undefined) {
      for (const field of reg.opts.reads) {
        if (!fieldToWriters.has(field)) {
          findings.push({
            severity: "info",
            code: "read_without_writer",
            message: `[${surface}] rule "${r.name}" reads state field "${field}" but no prior rule in the list writes it. (Allowed; flagging for visibility — usually means a missing upstream rule.)`,
            ruleNames: [r.name],
          });
        }
      }
    }

    // Now record this rule's writes — and detect collisions against prior
    // writers of the same field.
    if (reg.opts.writes !== undefined) {
      for (const field of reg.opts.writes) {
        const priorWriters = fieldToWriters.get(field);
        if (priorWriters !== undefined && priorWriters.length > 0) {
          findings.push({
            severity: "warn",
            code: "write_after_write",
            message: `[${surface}] state field "${field}" is written by multiple rules (${[...priorWriters, r.name].join(" → ")}). The later writer silently shadows the earlier one — verify this is intentional.`,
            ruleNames: [...priorWriters, r.name],
          });
          priorWriters.push(r.name);
        } else {
          fieldToWriters.set(field, [r.name]);
        }
      }
    }
  }

  // 3. Ctx-surface read-after-write + write-after-write detection (per
  //    F5/M6 D-LOCK-3). Mirrors the state-field logic above but operates
  //    on `reg.opts.ctx_reads` / `reg.opts.ctx_writes` and only emits for
  //    the `headers` surface — `body` is intentionally suppressed (every
  //    rule writes/reads body in some sense; noise > signal).
  //
  //    Only meaningful on the body surface (stream-event rules have no
  //    ctx-surface concept). Skip cleanly when called with surface
  //    `"stream_event"` so callers don't have to special-case.
  if (surface === "body") {
    const EMITTED_SURFACES: ReadonlyArray<CtxSurface> = ["headers"];
    for (const ctxSurface of EMITTED_SURFACES) {
      const surfaceWriters: string[] = [];
      for (const r of rules) {
        const reg = registrySnapshot.get(r.use);
        if (reg === undefined) continue;

        // Reader-without-writer check FIRST (uses prior writers only).
        if (reg.opts.ctx_reads.includes(ctxSurface)) {
          if (surfaceWriters.length === 0) {
            findings.push({
              severity: "info",
              code: "ctx_read_without_writer",
              message: `[${surface}] rule "${r.name}" reads ctx surface "${ctxSurface}" but no prior rule in the list writes it. (Allowed; flagging for visibility — usually means a missing upstream rule.)`,
              ruleNames: [r.name],
            });
          }
        }

        // Now record this rule's ctx-surface writes — detect collisions
        // against prior writers of the same surface.
        if (reg.opts.ctx_writes.includes(ctxSurface)) {
          if (surfaceWriters.length > 0) {
            findings.push({
              severity: "warn",
              code: "ctx_write_after_write",
              message: `[${surface}] ctx surface "${ctxSurface}" is written by multiple rules (${[...surfaceWriters, r.name].join(" → ")}). The later writer silently shadows the earlier one — verify this is intentional.`,
              ruleNames: [...surfaceWriters, r.name],
            });
          }
          surfaceWriters.push(r.name);
        }
      }
    }
  }

  return findings;
}
