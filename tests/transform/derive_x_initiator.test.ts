/**
 * derive_x_initiator.test.ts — per-rule unit tests for the M9 (D33)
 * `derive_x_initiator` body rule (M9 D-LOCK-2 + D-LOCK-18).
 *
 * Coverage maps to M9 mini-audit items 3-9:
 *   - schema validation + registry metadata (ctx_reads/ctx_writes)
 *   - per-content-shape derivation (empty body, no messages, empty array,
 *     last-block tool_result vs text)
 *   - idempotency: pre-set matching value → applied:false
 *   - D-LOCK-18 default materialization: omit header_name → writes
 *     "x-initiator" literal at runtime
 *
 * Plus the x-interaction-type pairing (Copilot client fidelity): the lockstep
 * property across every body shape, both explicit agent/user cases, the
 * partial-preset regression guard, the paired schema default + trace keys, the
 * schema-level rejection of two AUTHORED header names that collide
 * case-insensitively (the one remaining way a config could emit half the
 * pair), and — at the end of the file — the boot regression guard: a legacy
 * single-header rule whose name collides with the OTHER field's DEFAULT must
 * PARSE (rejecting it would stop the proxy starting) and must then write
 * exactly one header at runtime.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { DeriveXInitiatorSchema } from "~/lib/transform/derive_x_initiator";
import "~/lib/transform/derive_x_initiator";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/derive_x_initiator");
  const { register } = await import("~/lib/transform/registry");
  register(
    "derive_x_initiator",
    mod.derive_x_initiator,
    mod.DeriveXInitiatorSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["headers"],
      allow_override: true,
    },
  );
}

function makeCtx(
  body: unknown,
  headers: Record<string, string> = {},
): TransformContext {
  return {
    body,
    headers,
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("derive_x_initiator — schema validation", () => {
  test("minimal valid config (defaults applied)", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-initiator");
    }
  });

  test("custom header_name accepted", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "x-custom-initiator",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-custom-initiator");
    }
  });

  test("wrong use literal → invalid", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "wrong_name",
    });
    expect(r.success).toBe(false);
  });
});

describe("derive_x_initiator — AUTHORED colliding header names are REJECTED", () => {
  // The two names are independent strings, and both are lowercased before
  // `setHeader`. Equal-modulo-case names therefore address ONE header key: the
  // nested setHeader calls collapse to a single write and the request carries
  // `x-initiator: conversation-agent` — one malformed half of the pair. The
  // file docblock states the rule's guarantee as "for any options this schema
  // accepts whose two RESOLVED names differ, both headers are written or
  // neither"; this schema guard is what makes that true, so these cases are
  // load-bearing.
  //
  // "AUTHORED" is the operative word: the guard fires only when the operator
  // WROTE both fields. A collision that exists only because one field was
  // written and the other DEFAULTED must parse — see the boot-regression guard
  // block near the end of this file for why.

  test("IDENTICAL names → rejected", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "x-both",
      interaction_type_header_name: "x-both",
    });
    expect(r.success).toBe(false);
  });

  test("names differing ONLY in case → rejected (both are lowercased before write)", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "X-Initiator",
      interaction_type_header_name: "x-INITIATOR",
    });
    expect(r.success).toBe(false);
  });

  test("rejection message names BOTH option fields (operator can act on it)", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "x-both",
      interaction_type_header_name: "X-BOTH",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toContain("header_name");
      expect(msg).toContain("interaction_type_header_name");
    }
  });

  test("DISTINCT names still accepted (the guard is not over-broad)", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "x-custom-initiator",
      interaction_type_header_name: "x-custom-interaction",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-custom-initiator");
      expect(r.data.interaction_type_header_name).toBe("x-custom-interaction");
    }
  });

  test("the SHIPPED pair (x-initiator / x-interaction-type) is accepted", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "derive_initiator_headers",
      use: "derive_x_initiator",
      header_name: "x-initiator",
      interaction_type_header_name: "x-interaction-type",
    });
    expect(r.success).toBe(true);
  });
});

describe("derive_x_initiator — registry metadata (mini-audit 1)", () => {
  test("ctx_reads = ['body'], ctx_writes = ['headers']", async () => {
    await registerRule();
    const reg = get("body", "derive_x_initiator");
    expect(reg).toBeDefined();
    expect(reg?.opts.ctx_reads).toEqual(["body"]);
    expect(reg?.opts.ctx_writes).toEqual(["headers"]);
  });

  test("no response_shape declared (this is a request-side header derive)", async () => {
    await registerRule();
    const reg = get("body", "derive_x_initiator");
    expect(reg?.opts.response_shape).toBeUndefined();
  });
});

describe("derive_x_initiator — derivation behavior (D-LOCK-2 mini-audit 3-7)", () => {
  test("mini-audit 3: empty / non-object body → 'user', applied:true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(null);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("mini-audit 4: body with no messages field → 'user'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({ model: "claude-opus-4.7" });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("mini-audit 5: body with messages: [] → 'user'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({ messages: [] });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("mini-audit 6: last message's last content block is tool_result → 'agent'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "tool_result", tool_use_id: "x", content: "ok" },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
  });

  test("mini-audit 7: last message's last content block is text → 'user'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "earlier" },
            { type: "text", text: "follow-up" },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("string content (not array) on last message → 'user' (defensive)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [{ role: "user", content: "plain string" }],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });
});

describe("derive_x_initiator — idempotency (mini-audit 8)", () => {
  // NOTE: idempotency is now a property of the PAIR. Pre-setting only
  // `x-initiator` no longer short-circuits the rule — it completes the missing
  // `x-interaction-type` instead (see the partial-preset regression guard
  // below), so these tests pre-set both headers.
  test("pre-set 'agent' pair + body shape that derives 'agent' → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      ],
    };
    const ctx = makeCtx(body, {
      "x-initiator": "agent",
      "x-interaction-type": "conversation-agent",
    });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
  });

  test("pre-set 'user' pair + body shape that derives 'user' → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(
      {},
      {
        "x-initiator": "user",
        "x-interaction-type": "conversation-user",
      },
    );
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("emits before/after snapshots when value changes (pre-set 'user' pair → derived 'agent')", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      ],
    };
    const ctx = makeCtx(body, {
      "x-initiator": "user",
      "x-interaction-type": "conversation-user",
    });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    const ar = result.applied[0];
    expect(ar?.before).toEqual({
      "x-initiator": "user",
      "x-interaction-type": "conversation-user",
    });
    expect(ar?.after).toEqual({
      "x-initiator": "agent",
      "x-interaction-type": "conversation-agent",
    });
  });
});

describe("derive_x_initiator — D-LOCK-18 default materialization (mini-audit 9)", () => {
  test("omitting header_name → rule writes to literal 'x-initiator' at runtime", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({});
    // Rule config explicitly OMITS header_name — proves the
    // .default("x-initiator") was materialized at runtime via Schema.parse.
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
  });

  test("custom header_name writes to that key (not 'x-initiator')", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({});
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_x_initiator",
        header_name: "x-custom-initiator",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-custom-initiator"]).toBe("user");
    expect(result.ctx.headers["x-initiator"]).toBeUndefined();
  });
});

// ===========================================================================
// x-interaction-type pairing (Copilot client fidelity).
//
// The rule emits BOTH `x-initiator` and `x-interaction-type` from ONE
// deriveInitiator() call, the way GitHub's own Copilot CLI sends them. The
// tests below pin the lockstep property, both explicit cases, and the
// partial-preset trap the single-header early return used to create.
// ===========================================================================

/** Body whose last message's content array ENDS WITH a tool_result block. */
const toolResultLastBody = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "tool_result", tool_use_id: "x", content: "ok" },
      ],
    },
  ],
};

describe("derive_x_initiator — x-interaction-type lockstep", () => {
  // Every shape the derivation can see. Whatever it derives, the two headers
  // must agree: x-interaction-type === "conversation-" + x-initiator.
  const shapes: Array<{ label: string; body: unknown }> = [
    { label: "tool_result last → agent", body: toolResultLastBody },
    {
      label: "text after tool_result → user",
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "x", content: "earlier" },
              { type: "text", text: "follow-up" },
            ],
          },
        ],
      },
    },
    {
      label: "text only",
      body: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    },
    {
      label: "string content",
      body: { messages: [{ role: "user", content: "plain string" }] },
    },
    {
      label: "empty content array",
      body: { messages: [{ role: "user", content: [] }] },
    },
    { label: "messages: []", body: { messages: [] } },
    { label: "no messages field", body: { model: "claude-opus-4.7" } },
    { label: "null body", body: null },
    {
      label: "multi-message, only the LAST ends with tool_result",
      body: {
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "calling a tool" }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: "42" }],
          },
        ],
      },
    },
  ];

  for (const { label, body } of shapes) {
    test(`lockstep holds for: ${label}`, async () => {
      await registerRule();
      const snap = snapshot("body");
      const ctx = makeCtx(body);
      const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
      const result = await applyRules(ctx, rules, snap);
      const h = result.ctx.headers;
      const initiator = h["x-initiator"];
      // Derivation produced one of the two legal values...
      expect(initiator === "agent" || initiator === "user").toBe(true);
      // ...and the paired header is exactly "conversation-" + that value.
      expect(h["x-interaction-type"]).toBe(`conversation-${initiator}`);
    });
  }
});

describe("derive_x_initiator — explicit agent/user pairs", () => {
  test("AGENT: last block is tool_result → agent + conversation-agent", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("NEGATIVE (user): a text block AFTER a tool_result → user + conversation-user", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "earlier" },
            { type: "text", text: "follow-up" },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.headers["x-initiator"]).toBe("user");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-user");
    // The pair never lands on the agent spelling for a user request.
    expect(result.ctx.headers["x-interaction-type"]).not.toBe(
      "conversation-agent",
    );
  });
});

describe("derive_x_initiator — partial-preset regression guard", () => {
  test("x-initiator pre-set + interaction header ABSENT → the pair is completed, not skipped", async () => {
    // THE TRAP. The pre-pair rule returned early on `before === derived` for
    // the single header. Ported naively, that early return fires here — the
    // context already says `x-initiator: agent` — and the request would go out
    // with only HALF the pair. The early return must require BOTH.
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody, { "x-initiator": "agent" });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("interaction header pre-set + x-initiator ABSENT → the pair is completed too", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody, {
      "x-interaction-type": "conversation-agent",
    });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("a STALE pre-set pair is overwritten with the derived pair", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody, {
      "x-initiator": "user",
      "x-interaction-type": "conversation-user",
    });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("BOTH pre-set correctly → applied:[] no-op, values unchanged", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody, {
      "x-initiator": "agent",
      "x-interaction-type": "conversation-agent",
    });
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });
});

describe("derive_x_initiator — interaction-type schema + trace", () => {
  test("schema default materializes interaction_type_header_name", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.interaction_type_header_name).toBe("x-interaction-type");
    }
  });

  test("omitting interaction_type_header_name → rule still writes 'x-interaction-type' at runtime", async () => {
    // D-LOCK-18: proves the new zod default is carried through the rule fn's
    // own Schema.parse(options) (the engine's safeParse does NOT pass defaults).
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.headers["x-interaction-type"]).toBe("conversation-agent");
  });

  test("custom interaction_type_header_name writes to that key only", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody);
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_x_initiator",
        interaction_type_header_name: "x-custom-it",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.ctx.headers["x-custom-it"]).toBe("conversation-agent");
    expect(result.ctx.headers["x-interaction-type"]).toBeUndefined();
    // The initiator half still lands on its own (default) key.
    expect(result.ctx.headers["x-initiator"]).toBe("agent");
  });

  test("before/after trace snapshots carry BOTH header keys", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    const ar = result.applied[0];
    expect(ar?.before).toEqual({
      "x-initiator": null,
      "x-interaction-type": null,
    });
    expect(ar?.after).toEqual({
      "x-initiator": "agent",
      "x-interaction-type": "conversation-agent",
    });
  });
});

// ===========================================================================
// The predicate inspects the last USER message, not the last message.
//
// Every docblock in derive_x_initiator.ts — and the project spec it cites —
// says "the last USER message". An earlier revision read
// `messages[messages.length - 1]` with NO role check, which is a DIFFERENT
// function: the two disagree on any non-user-last request. Today's Claude Code
// traffic is always user-last, so the disagreement never reaches the wire —
// which is exactly what makes it a LATENT defect + a false docblock claim
// rather than a live outage, and why it needs tests that construct the shapes
// production does not currently produce.
//
// Each test below FAILS against the unfiltered `messages[length - 1]` read.
// ===========================================================================

describe("derive_x_initiator — role-aware last-USER-message selection", () => {
  async function deriveVia(body: unknown): Promise<string | undefined> {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_x_initiator" }];
    const result = await applyRules(ctx, rules, snap);
    return result.ctx.headers["x-initiator"];
  }

  test("assistant message AFTER a qualifying user tool_result → still 'agent'", async () => {
    // The user's turn ended with a tool_result (an agent continuation), and an
    // assistant turn follows it. Reading `messages[-1]` inspects the ASSISTANT
    // message, whose last block is text, and derives "user" — wrong.
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "here is what happened" }],
        },
      ],
    };
    expect(await deriveVia(body)).toBe("agent");
  });

  test("assistant-last carrying a tool_result-shaped block → 'user' (not the assistant's block)", async () => {
    // The mirror-image fault. The LAST message is an assistant turn whose own
    // final block is tool_result-shaped; the user's own last turn ends in text.
    // Reading `messages[-1]` derives "agent" off a block the user never sent.
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "explain this" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_result", tool_use_id: "t9", content: "leaked" },
          ],
        },
      ],
    };
    expect(await deriveVia(body)).toBe("user");
  });

  test("no user-role message at all → 'user' (conservative default, unchanged)", async () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done" },
          ],
        },
      ],
    };
    expect(await deriveVia(body)).toBe("user");
  });

  test("a non-object entry after the last user message does not stop the scan", async () => {
    // Defensive: the backward scan must SKIP junk entries rather than treat the
    // first non-user entry as terminal.
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done" },
          ],
        },
        null,
        "not-a-message",
      ],
    };
    expect(await deriveVia(body)).toBe("agent");
  });

  test("user-last traffic (today's Claude Code shape) is UNCHANGED by the role filter", async () => {
    // The non-regression half: the shapes that DO reach the wire today derive
    // exactly what they derived before, so this fix is behaviour-preserving on
    // live traffic and behaviour-correcting only on the latent shapes above.
    expect(await deriveVia(toolResultLastBody)).toBe("agent");
    expect(
      await deriveVia({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "x", content: "earlier" },
              { type: "text", text: "follow-up" },
            ],
          },
        ],
      }),
    ).toBe("user");
  });
});

// ===========================================================================
// BOOT REGRESSION GUARD — a DEFAULTED collision must PARSE.
//
// The collision `.refine()` originally sat on an object whose two header-name
// fields carried zod `.default()`s, so it ran on the POST-default value. That
// made it reject a config the operator never authored a collision in: the
// LEGACY single-header rule `{header_name: x-interaction-type}` — perfectly
// valid under the pre-pair schema, and still sitting in any deployed
// `config.yaml` that predates the pairing (`install_bundle.ps1` places
// `config.yaml` only if ABSENT, so an upgrade never rewrites it) — collided
// with the freshly materialized `interaction_type_header_name` default and
// FAILED VALIDATION.
//
// Config parsing happens at BOOT, strictly before `applyInitiatorHeaders` gets
// the chance to strip that rule, so the injector cannot rescue it: the proxy
// would not START. An upgrade turns a working deployment into a dead one and
// takes every connected Claude Code / Codex session down with it. Low
// probability, maximal consequence — which is why the guard now fires ONLY on
// a collision present in the RAW input (both fields written), and why the
// tolerated case is given a DEFINED runtime behaviour rather than being left
// to the nested-setHeader collapse.
// ===========================================================================

describe("derive_x_initiator — DEFAULTED collision parses (boot regression guard)", () => {
  test("legacy `{header_name: x-interaction-type}` with NO interaction field PARSES", () => {
    // THE REGRESSION. Under the post-default refine this returned success:
    // false, and a config carrying this rule killed the proxy at boot.
    const r = DeriveXInitiatorSchema.safeParse({
      name: "legacy_initiator",
      use: "derive_x_initiator",
      header_name: "x-interaction-type",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // The default still materializes — it just does so AFTER the check.
      expect(r.data.header_name).toBe("x-interaction-type");
      expect(r.data.interaction_type_header_name).toBe("x-interaction-type");
    }
  });

  test("the mirror shape — only `interaction_type_header_name` set, colliding with header_name's default — also PARSES", () => {
    const r = DeriveXInitiatorSchema.safeParse({
      name: "legacy_interaction",
      use: "derive_x_initiator",
      interaction_type_header_name: "X-Initiator",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-initiator");
      expect(r.data.interaction_type_header_name).toBe("X-Initiator");
    }
  });

  test("that legacy rule writes EXACTLY ONE header, carrying the INITIATOR value", async () => {
    // Part 2 of the fix. Left to `setHeader(setHeader(...))` the two writes
    // collapse onto the one key and the SECOND wins, emitting
    // `x-interaction-type: conversation-agent` — the interaction-type value
    // under the key the operator meant to carry `agent`. The rule now detects
    // the collision and writes the initiator half only.
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx(toolResultLastBody);
    const rules: Rule[] = [
      {
        name: "legacy_initiator",
        use: "derive_x_initiator",
        header_name: "x-interaction-type",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    const h = result.ctx.headers;
    expect(result.applied).toHaveLength(1);
    expect(h["x-interaction-type"]).toBe("agent");
    // ...and NOT the interaction-type spelling that the collapse produced.
    expect(h["x-interaction-type"]).not.toBe("conversation-agent");
    // Exactly one key — no second header is emitted under any spelling.
    expect(Object.keys(h)).toEqual(["x-interaction-type"]);
    expect(h["x-initiator"]).toBeUndefined();
  });

  test("the collided single write is idempotent + traces only the ONE key", async () => {
    await registerRule();
    const snap = snapshot("body");
    const rules: Rule[] = [
      {
        name: "legacy_initiator",
        use: "derive_x_initiator",
        header_name: "x-interaction-type",
      },
    ];
    // First application records a before/after over the single key only.
    const first = await applyRules(makeCtx(toolResultLastBody), rules, snap);
    expect(first.applied[0]?.before).toEqual({ "x-interaction-type": null });
    expect(first.applied[0]?.after).toEqual({ "x-interaction-type": "agent" });
    // Re-applying over the already-correct value is a no-op, not a rewrite.
    const second = await applyRules(
      makeCtx(toolResultLastBody, { "x-interaction-type": "agent" }),
      rules,
      snap,
    );
    expect(second.applied).toEqual([]);
    expect(second.ctx.headers["x-interaction-type"]).toBe("agent");
  });

  test("NON-colliding custom header_name still parses and emits BOTH headers", async () => {
    // The guard is not over-broad in the other direction: a custom name that
    // does NOT collide with the other field's default keeps the full pair.
    const r = DeriveXInitiatorSchema.safeParse({
      name: "x",
      use: "derive_x_initiator",
      header_name: "x-custom-initiator",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-custom-initiator");
      expect(r.data.interaction_type_header_name).toBe("x-interaction-type");
    }

    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx(toolResultLastBody),
      [
        {
          name: "r",
          use: "derive_x_initiator",
          header_name: "x-custom-initiator",
        },
      ] as Rule[],
      snap,
    );
    const h = result.ctx.headers;
    expect(h["x-custom-initiator"]).toBe("agent");
    expect(h["x-interaction-type"]).toBe("conversation-agent");
    expect(Object.keys(h).sort()).toEqual([
      "x-custom-initiator",
      "x-interaction-type",
    ]);
  });

  test("the SHIPPED canonical pair still parses and emits BOTH headers", async () => {
    // What `applyInitiatorHeaders` actually splices into every Anthropic lane
    // (`buildInitiatorRule`, both names pinned). If this ever stops emitting
    // the pair, the shipped deployment is wrong — everything else in this
    // block is about configs the injector removes before they can run.
    const shipped = {
      name: "derive_initiator_headers",
      use: "derive_x_initiator",
      header_name: "x-initiator",
      interaction_type_header_name: "x-interaction-type",
    };
    const r = DeriveXInitiatorSchema.safeParse(shipped);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("x-initiator");
      expect(r.data.interaction_type_header_name).toBe("x-interaction-type");
    }

    await registerRule();
    const snap = snapshot("body");
    const result = await applyRules(
      makeCtx(toolResultLastBody),
      [shipped] as Rule[],
      snap,
    );
    const h = result.ctx.headers;
    expect(h["x-initiator"]).toBe("agent");
    expect(h["x-interaction-type"]).toBe("conversation-agent");
    expect(Object.keys(h).sort()).toEqual([
      "x-initiator",
      "x-interaction-type",
    ]);
  });
});
