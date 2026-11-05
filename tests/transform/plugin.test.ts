/**
 * plugin.test.ts — pins the public-API export surface of
 * `~/lib/transform/plugin` per D-LOCK-6 + interface-contracts.md § 5.
 *
 * Two assertions:
 *   1. EXACT-SET assertion — every documented name exists on the
 *      imported namespace.
 *   2. ANTI-SET assertion — engine-internal names that MUST NOT leak
 *      through plugin.ts are absent from the namespace.
 *
 * Failure modes guarded against:
 *   - Accidentally re-exporting an internal (`apply`, `applyEvent`,
 *     `snapshot`, `reset`, `RegisteredBodyRule`, etc.) breaks the
 *     plugin contract by exposing a moving target.
 *   - Accidentally dropping a documented export silently breaks every
 *     operator's drop-in rule on the next upgrade.
 *
 * Test runs at TYPE-ERASURE time: type-only exports do NOT survive
 * runtime introspection, so we use `import * as plugin` + value-shape
 * checks for runtime exports, and a separate compile-time check via
 * a typed import for the type exports.
 */

import { describe, expect, test } from "bun:test";

import * as plugin from "~/lib/transform/plugin";
// Type-only imports — pinned compile-time. If any of the 14 documented
// types disappears from plugin.ts (or is renamed), the imports fail
// `bun run typecheck` — surfacing the regression at build time rather
// than at operator-onboarding time.
import type {
  RegisteredRuleOpts as _T_RegisteredRuleOpts,
  CtxSurface as _T_CtxSurface,
  TransformContext as _T_TransformContext,
  TransformFn as _T_TransformFn,
  TransformResult as _T_TransformResult,
  Rule as _T_Rule,
  When as _T_When,
  AppliedRule as _T_AppliedRule,
  StreamEventContext as _T_StreamEventContext,
  StreamEventTransformFn as _T_StreamEventTransformFn,
  StreamEventResult as _T_StreamEventResult,
  AnyEvent as _T_AnyEvent,
  BaseEvent as _T_BaseEvent,
  StreamState as _T_StreamState,
} from "~/lib/transform/plugin";

// ---------------------------------------------------------------------------
// Runtime export set (per D-LOCK-6)
// ---------------------------------------------------------------------------

/**
 * Names that MUST be present at runtime on the `plugin` namespace.
 * Type-only exports (interfaces, type aliases) are erased at runtime
 * so they DO NOT appear here — they're checked at compile-time below
 * via a typed import that would fail tsc if any name disappeared.
 */
const REQUIRED_RUNTIME_EXPORTS = [
  // Registration functions
  "register",
  "registerStreamEvent",
  // Engine version constant
  "ENGINE_VERSION",
  // Header utilities
  "getHeader",
  "setHeader",
  "parseCsv",
  "serializeCsv",
  "unionCsv",
  "intersectCsv",
  "replaceCsv",
  "filterCsv",
] as const;

/**
 * Type-only names per D-LOCK-6. Erased at runtime — checked at
 * compile-time via the typed import below; this list is documentation
 * for the locked set.
 */
const REQUIRED_TYPE_EXPORTS = [
  "RegisteredRuleOpts",
  "CtxSurface",
  "TransformContext",
  "TransformFn",
  "TransformResult",
  "Rule",
  "When",
  "AppliedRule",
  "StreamEventContext",
  "StreamEventTransformFn",
  "StreamEventResult",
  "AnyEvent",
  "BaseEvent",
  "StreamState",
] as const;

/**
 * Anti-export list per D-LOCK-6. Engine-internals that MUST NOT appear
 * on the plugin namespace at runtime (and would be type errors if
 * imported as types from plugin.ts).
 */
const ANTI_EXPORTS = [
  "apply",
  "applyEvent",
  "snapshot",
  "reset",
  "get",
  "list",
  "RegisteredBodyRule",
  "RegisteredStreamEventRule",
  "RuleAlreadyRegisteredError",
  "validateResponseShape",
  "ValidationFailure",
] as const;

describe("plugin.ts — public API surface (D-LOCK-6)", () => {
  test("every required runtime export is present", () => {
    const ns = plugin as unknown as Record<string, unknown>;
    for (const name of REQUIRED_RUNTIME_EXPORTS) {
      expect(ns[name]).toBeDefined();
    }
  });

  test("register is a function", () => {
    expect(typeof plugin.register).toBe("function");
  });

  test("registerStreamEvent is a function", () => {
    expect(typeof plugin.registerStreamEvent).toBe("function");
  });

  test("ENGINE_VERSION is a non-empty string", () => {
    expect(typeof plugin.ENGINE_VERSION).toBe("string");
    expect(plugin.ENGINE_VERSION.length).toBeGreaterThan(0);
  });

  test("header utilities are functions", () => {
    expect(typeof plugin.getHeader).toBe("function");
    expect(typeof plugin.setHeader).toBe("function");
    expect(typeof plugin.parseCsv).toBe("function");
    expect(typeof plugin.serializeCsv).toBe("function");
    expect(typeof plugin.unionCsv).toBe("function");
    expect(typeof plugin.intersectCsv).toBe("function");
    expect(typeof plugin.replaceCsv).toBe("function");
    expect(typeof plugin.filterCsv).toBe("function");
  });
});

describe("plugin.ts — anti-export surface (D-LOCK-6)", () => {
  test("engine internals are NOT exported from plugin.ts", () => {
    const ns = plugin as unknown as Record<string, unknown>;
    for (const name of ANTI_EXPORTS) {
      expect(ns[name]).toBeUndefined();
    }
  });
});

describe("plugin.ts — runtime export count is bounded", () => {
  test("only the documented runtime names are present (no accidental drift)", () => {
    // Bun's `import * as` namespace exposes ONLY explicitly-exported
    // runtime values. Type-only exports are erased. So the runtime
    // namespace's own keys should equal the REQUIRED_RUNTIME_EXPORTS
    // set exactly. If a future hand-edit re-exports an extra runtime
    // name that's not in the locked set, this test catches it.
    const ns = plugin as unknown as Record<string, unknown>;
    const actual = Object.keys(ns).sort();
    const expected = [...REQUIRED_RUNTIME_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });
});

describe("plugin.ts — type-export documentation (D-LOCK-6)", () => {
  test("the locked type-export list is documented", () => {
    // No runtime check possible (TS types erase). This test is
    // documentation: if a future commit changes plugin.ts's type
    // re-exports, the change MUST also update REQUIRED_TYPE_EXPORTS.
    // The list below mirrors interface-contracts.md § 5 verbatim.
    expect(REQUIRED_TYPE_EXPORTS.length).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Compile-time type-export check
// ---------------------------------------------------------------------------
//
// The type-only imports at the top of the file pin the 14 documented
// type exports. The tuple footprint below references each so TS
// doesn't flag them as unused.

// Reference each imported type so TS doesn't flag them as unused.
type _PluginTypeFootprint = [
  _T_RegisteredRuleOpts,
  _T_CtxSurface,
  _T_TransformContext,
  _T_TransformFn,
  _T_TransformResult,
  _T_Rule,
  _T_When,
  _T_AppliedRule,
  _T_StreamEventContext,
  _T_StreamEventTransformFn,
  _T_StreamEventResult,
  _T_AnyEvent,
  _T_BaseEvent,
  _T_StreamState,
];

// Ensure the type alias is "used" so it doesn't trip noUnusedLocals.
const _pluginTypeFootprintWitness: _PluginTypeFootprint | undefined = undefined;
void _pluginTypeFootprintWitness;
