/**
 * config-schema.production.test.ts — F3 production-mode guard verification.
 *
 * Per M5 spec § F3 fold-in: when `NODE_ENV === "production"` AND the body
 * registry is empty (broken barrel), `RuleSchema` REJECTS the input rather
 * than silently accepting it.
 *
 * This test is in its own file so we can manipulate `NODE_ENV` + reset the
 * registry without polluting sibling test files.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { reset as resetRegistry } from "../../src/lib/transform/registry.ts";
import { ConfigSchema } from "../../src/types/config-schema.ts";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  }
  // Re-import barrel to repopulate registry for sibling tests.
  // (Side-effect import; safe to call repeatedly.)
  // We can't synchronously re-await an import here in bun:test's hooks, but
  // tests/types/config-schema.test.ts has a beforeEach that re-registers
  // the 4 day-1 rules. This test only resets at the end, so other suites
  // that need the registry will repopulate via their own beforeEach.
});

describe("RuleSchema F3 production guard", () => {
  it("NODE_ENV=production + empty registry rejects with helpful diagnostic", () => {
    resetRegistry();
    process.env["NODE_ENV"] = "production";
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { path: "/v1/messages" },
          body_rules: [{ name: "x", use: "anything" }],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    const matched = messages.find((m) => m.includes("body registry is empty"));
    expect(matched).toBeDefined();
  });

  it("non-production + empty registry still accepts (test-mode tolerance)", () => {
    resetRegistry();
    delete process.env["NODE_ENV"];
    const result = ConfigSchema.safeParse({
      routes: [
        {
          match: { path: "/v1/messages" },
          body_rules: [{ name: "x", use: "anything" }],
          upstream: {
            via: "copilot_enterprise",
            via_endpoint: "anthropic_messages",
            shape: "anthropic_messages",
          },
        },
      ],
    });
    // Test-mode: empty registry → accept (per F3 fallback comment).
    expect(result.success).toBe(true);
  });
});
