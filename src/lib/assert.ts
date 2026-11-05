/**
 * assert.ts — project-canonical re-export of `tiny-invariant`.
 *
 * **Why this module exists.** `tiny-invariant` is already an M0 dep used
 * across the engine core (`registry.ts`, `apply.ts`, `apply_event.ts`).
 * Re-exporting it from a single project path (`~/lib/assert`) gives
 * downstream M3+ rules ONE obvious import for runtime invariants and
 * keeps the per-file import discipline tight.
 *
 * **Project conventions (per O20).**
 *
 *   - Use `invariant()` for **runtime checks of internal invariants** —
 *     engine state, registry consistency, "this should never happen" cases.
 *     The condition gets narrowed by TypeScript via `asserts condition`,
 *     so you also get downstream type narrowing for free.
 *
 *   - Use **zod** at **external boundaries** — config files, request
 *     bodies, upstream responses, custom-rule options. Anywhere bytes
 *     enter from outside the engine, validate with zod and narrow
 *     `unknown` → typed via `safeParse` + discriminated handling.
 *
 *   - Production-mode strips the `message` argument from `tiny-invariant`
 *     to keep bundles small. Messages are developer-readable but should
 *     NEVER be relied on as user-facing error text.
 *
 * @example Internal invariant
 *   invariant(snap !== undefined, "stream snapshot lost mid-flight");
 *   // `snap` is now non-undefined to TypeScript.
 *
 * @example External boundary (use zod, not invariant)
 *   const parsed = MyRuleOptionsSchema.safeParse(rawOptions);
 *   if (!parsed.success) return { ctx, applied: false };
 *   const opts = parsed.data;
 */

export { default as invariant } from "tiny-invariant";
