/**
 * redirect_response_shape.test.ts — integration test for the X2 contract
 * (D-LOCK-4): a config that includes a `redirect_to_*` body rule MUST
 * also include a response-side rule that consumes the declared
 * `response_shape`. Otherwise the engine emits a startup error.
 *
 * **M6 SCAFFOLD.** M9's config-load layer is not yet built — this test
 * exercises the standalone validator
 * `src/lib/transform/_validate_response_shape.ts` so M9 can wire it
 * directly. The validator:
 *   - Walks body rules. For each rule whose registry entry declares a
 *     `response_shape`, checks that at least one response rule's registry
 *     entry declares the SAME `response_shape`.
 *   - Returns failures (empty array = clean config).
 *
 * **Spec language asserted (per spec § D-LOCK-4 / verification gate):**
 *
 * > Rule '<name>' redirects to <shape> but no response rules configured for
 * > that shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { validateResponseShape } from "~/lib/transform/_validate_response_shape";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  register,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import "~/lib/transform/redirect_to_anthropic_messages";
import "~/lib/transform/redirect_to_chat_completions";
import type {
  Rule,
  TransformContext,
  TransformFn,
  TransformResult,
} from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

const noopSchema = z
  .object({ name: z.string(), use: z.string() })
  .passthrough();

const noopFn: TransformFn = (ctx: TransformContext): TransformResult => ({
  ctx,
  applied: false,
});

async function registerRedirects(): Promise<void> {
  // Re-register both redirect rules with their canonical metadata. M9
  // consumers will call register() at module-import time; tests must
  // re-register because registry.reset() clears the body registry. The
  // module-level `import` also triggers self-registration which may have
  // already populated the entry — pass allow_override to be robust to
  // either path.
  const m1 = await import("~/lib/transform/redirect_to_anthropic_messages");
  register(
    "redirect_to_anthropic_messages",
    m1.redirect_to_anthropic_messages,
    m1.RedirectToAnthropicMessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m2 = await import("~/lib/transform/redirect_to_chat_completions");
  register(
    "redirect_to_chat_completions",
    m2.redirect_to_chat_completions,
    m2.RedirectToChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
}

describe("redirect_response_shape contract (X2 / D-LOCK-4)", () => {
  test("missing matching response rule for anthropic_v1_messages → emits validation failure", async () => {
    await registerRedirects();
    // Register an unrelated response rule that declares a DIFFERENT shape.
    register("response_handler_chat", noopFn, noopSchema, {
      response_shape: "openai_chat_completions",
    });
    const bodyRules: Rule[] = [
      {
        name: "codex_to_claude",
        use: "redirect_to_anthropic_messages",
        when: { route: "/v1/responses" },
      },
    ];
    const responseRules: Rule[] = [
      { name: "rh", use: "response_handler_chat" },
    ];
    const bodySnap = snapshot("body");
    // Response rules use the same body registry in M2 (no separate
    // response registry yet — that's M7a/M9 territory). Use bodySnap for
    // both arguments; the validator only inspects opts.response_shape.
    const failures = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      bodySnap,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.bodyRuleName).toBe("codex_to_claude");
    expect(failures[0]?.shape).toBe("anthropic_v1_messages");
    expect(failures[0]?.message).toBe(
      "Rule 'codex_to_claude' redirects to anthropic_v1_messages but no response rules configured for that shape.",
    );
  });

  test("matching response rule present → no failures", async () => {
    await registerRedirects();
    register("response_handler_anthropic", noopFn, noopSchema, {
      response_shape: "anthropic_v1_messages",
    });
    const bodyRules: Rule[] = [
      {
        name: "codex_to_claude",
        use: "redirect_to_anthropic_messages",
      },
    ];
    const responseRules: Rule[] = [
      { name: "rh", use: "response_handler_anthropic" },
    ];
    const bodySnap = snapshot("body");
    const failures = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      bodySnap,
    );
    expect(failures).toEqual([]);
  });

  test("missing matching response rule for openai_chat_completions → emits validation failure", async () => {
    await registerRedirects();
    register("response_handler_anthropic", noopFn, noopSchema, {
      response_shape: "anthropic_v1_messages",
    });
    const bodyRules: Rule[] = [
      {
        name: "anthropic_to_chat",
        use: "redirect_to_chat_completions",
      },
    ];
    const responseRules: Rule[] = [
      { name: "rh", use: "response_handler_anthropic" },
    ];
    const bodySnap = snapshot("body");
    const failures = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      bodySnap,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.shape).toBe("openai_chat_completions");
    expect(failures[0]?.message).toContain(
      "but no response rules configured for that shape",
    );
  });

  test("non-redirect body rules (no response_shape) → never produce failures", async () => {
    register("plain_body_rule", noopFn, noopSchema);
    const bodyRules: Rule[] = [{ name: "plain", use: "plain_body_rule" }];
    const bodySnap = snapshot("body");
    const failures = validateResponseShape(bodyRules, [], bodySnap, bodySnap);
    expect(failures).toEqual([]);
  });

  test("multiple redirects with mixed match status — only unmatched ones fail", async () => {
    await registerRedirects();
    register("response_handler_anthropic", noopFn, noopSchema, {
      response_shape: "anthropic_v1_messages",
    });
    const bodyRules: Rule[] = [
      { name: "to_claude", use: "redirect_to_anthropic_messages" }, // OK
      { name: "to_chat", use: "redirect_to_chat_completions" }, // FAILS
    ];
    const responseRules: Rule[] = [
      { name: "rh", use: "response_handler_anthropic" },
    ];
    const bodySnap = snapshot("body");
    const failures = validateResponseShape(
      bodyRules,
      responseRules,
      bodySnap,
      bodySnap,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.bodyRuleName).toBe("to_chat");
    expect(failures[0]?.shape).toBe("openai_chat_completions");
  });
});
