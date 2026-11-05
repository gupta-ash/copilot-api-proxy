/**
 * apply_event.test.ts — verifies the stream-event apply loop:
 *   - happy path with event_types predicate
 *   - default passthrough when no rule fires
 *   - declared-order multi-rule fires
 *   - state mutation via ctx.state visible to downstream rules in chain
 *   - state-access manifest captured (reads/writes) on AppliedRule
 *   - rule emits 0 events (suppression) → events_out excludes original
 *   - rule emits multiple events → all appear
 *   - event_types predicate filters by event.type
 *   - cross-namespace: body rule NOT visible in stream_event registry
 *   - on_error semantics same as apply.ts
 *   - state_changes propagated to AppliedRule.state_changes
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  EngineAbort500Error,
  EngineAbort502Error,
  RuleSchemaInvalidError,
  UnregisteredRuleError,
} from "~/lib/transform/apply";
import { applyEvent } from "~/lib/transform/apply_event";
import {
  get,
  register,
  registerStreamEvent,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import type {
  Rule,
  StreamEventContext,
  StreamEventResult,
  TransformResult,
} from "~/lib/transform/types";

const noopSchema = z
  .object({
    name: z.string(),
    use: z.string(),
  })
  .passthrough();

function makeEventCtx(
  overrides: Partial<StreamEventContext> = {},
): StreamEventContext {
  return {
    event: { type: "message_start" },
    state: {},
    route: "/v1/messages",
    model: "claude-opus-4.7",
    ...overrides,
  };
}

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

describe("applyEvent — happy path", () => {
  test("single noop rule fires; AppliedRule emitted; events_out is rule output", () => {
    registerStreamEvent(
      "noop-evt",
      (): StreamEventResult => ({
        events_out: [{ type: "transformed_event" }],
        applied: true,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "noop-evt",
        use: "noop-evt",
        when: { event_types: ["message_start"] },
      },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("noop-evt");
    expect(events_out).toEqual([{ type: "transformed_event" }]);
  });

  test("default passthrough when no rule fires", () => {
    registerStreamEvent(
      "no-fire",
      (): StreamEventResult => ({
        events_out: [{ type: "should-not-appear" }],
        applied: true,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    // Predicate excludes this event type → rule does not fire.
    const rules: Rule[] = [
      {
        name: "no-fire",
        use: "no-fire",
        when: { event_types: ["different_type"] },
      },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toEqual([]);
    expect(events_out).toEqual([{ type: "message_start" }]);
  });

  test("multiple rules fire in declared order", () => {
    const order: string[] = [];
    registerStreamEvent(
      "evt-a",
      (): StreamEventResult => {
        order.push("a");
        return { events_out: [{ type: "from_a" }], applied: true };
      },
      noopSchema,
    );
    registerStreamEvent(
      "evt-b",
      (): StreamEventResult => {
        order.push("b");
        return { events_out: [{ type: "from_b" }], applied: true };
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "evt-a", use: "evt-a" },
      { name: "evt-b", use: "evt-b" },
    ];
    const { events_out } = applyEvent(makeEventCtx(), rules, snap);
    expect(order).toEqual(["a", "b"]);
    // Both rules fired; passthrough is suppressed; both emissions concatenate.
    expect(events_out).toEqual([{ type: "from_a" }, { type: "from_b" }]);
  });

  test("rule emits 0 events (suppression) → events_out excludes original", () => {
    registerStreamEvent(
      "suppress",
      (): StreamEventResult => ({ events_out: [], applied: true }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "suppress", use: "suppress" }];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(events_out).toEqual([]);
  });

  test("rule emits multiple events → all appear in events_out in emit order", () => {
    registerStreamEvent(
      "multi",
      (): StreamEventResult => ({
        events_out: [{ type: "first" }, { type: "second" }, { type: "third" }],
        applied: true,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "multi", use: "multi" }];
    const { events_out } = applyEvent(makeEventCtx(), rules, snap);
    expect(events_out).toEqual([
      { type: "first" },
      { type: "second" },
      { type: "third" },
    ]);
  });
});

describe("applyEvent — event_types predicate filtering", () => {
  test("rule with event_types: ['message_start'] does NOT fire on message_delta", () => {
    registerStreamEvent(
      "start-only",
      (): StreamEventResult => ({
        events_out: [{ type: "transformed" }],
        applied: true,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "start-only",
        use: "start-only",
        when: { event_types: ["message_start"] },
      },
    ];
    const ctx = makeEventCtx({ event: { type: "message_delta" } });
    const { events_out, applied } = applyEvent(ctx, rules, snap);
    expect(applied).toEqual([]);
    expect(events_out).toEqual([{ type: "message_delta" }]);
  });

  test("multi-type event_types fires on EITHER event type (per O9)", () => {
    let firedOn = "";
    registerStreamEvent(
      "multi-type",
      (ctx): StreamEventResult => {
        firedOn = ctx.event.type;
        return { events_out: [{ type: "out" }], applied: true };
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "multi-type",
        use: "multi-type",
        when: { event_types: ["response.created", "response.completed"] },
      },
    ];
    const ctxA = makeEventCtx({ event: { type: "response.created" } });
    applyEvent(ctxA, rules, snap);
    expect(firedOn).toBe("response.created");

    const ctxB = makeEventCtx({ event: { type: "response.completed" } });
    applyEvent(ctxB, rules, snap);
    expect(firedOn).toBe("response.completed");
  });
});

describe("applyEvent — state semantics (per X6, Phase-1.6-class regression guard)", () => {
  test("rule writes ctx.state; downstream rule in chain reads the write", () => {
    let downstreamSawValue: unknown = "NOT-SET";
    registerStreamEvent(
      "writer",
      (ctx): StreamEventResult => {
        ctx.state.finalUsage = { input_tokens: 42 };
        return {
          events_out: [],
          state_changes: { finalUsage: { input_tokens: 42 } },
          applied: true,
        };
      },
      noopSchema,
      { writes: ["finalUsage"] },
    );
    registerStreamEvent(
      "reader",
      (ctx): StreamEventResult => {
        downstreamSawValue = ctx.state.finalUsage;
        return { events_out: [], applied: true };
      },
      noopSchema,
      { reads: ["finalUsage"] },
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "writer", use: "writer" },
      { name: "reader", use: "reader" },
    ];
    applyEvent(makeEventCtx(), rules, snap);
    expect(downstreamSawValue).toEqual({ input_tokens: 42 });
  });

  test("state_changes accumulator collects all rule writes", () => {
    registerStreamEvent(
      "writer-1",
      (): StreamEventResult => ({
        events_out: [],
        state_changes: { finalUsage: { input_tokens: 10 } },
        applied: true,
      }),
      noopSchema,
      { writes: ["finalUsage"] },
    );
    registerStreamEvent(
      "writer-2",
      (): StreamEventResult => ({
        events_out: [],
        state_changes: { delta_count: 5 },
        applied: true,
      }),
      noopSchema,
      { writes: ["delta_count"] },
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "writer-1", use: "writer-1" },
      { name: "writer-2", use: "writer-2" },
    ];
    const { state_changes } = applyEvent(makeEventCtx(), rules, snap);
    expect(state_changes).toEqual({
      finalUsage: { input_tokens: 10 },
      delta_count: 5,
    });
  });

  test("AppliedRule carries reads/writes from manifest + state_changes from result", () => {
    registerStreamEvent(
      "manifest-rule",
      (): StreamEventResult => ({
        events_out: [],
        state_changes: { finalUsage: 1 },
        applied: true,
      }),
      noopSchema,
      { reads: ["finalUsage"], writes: ["finalUsage"] },
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "manifest-rule", use: "manifest-rule" }];
    const { applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied[0]?.reads).toEqual(["finalUsage"]);
    expect(applied[0]?.writes).toEqual(["finalUsage"]);
    expect(applied[0]?.state_changes).toEqual({ finalUsage: 1 });
  });
});

describe("applyEvent — error semantics", () => {
  test("on_error: continue (default) records error, NEXT rule still fires", () => {
    registerStreamEvent(
      "boom-evt",
      (): StreamEventResult => {
        throw new Error("evt-kaboom");
      },
      noopSchema,
    );
    registerStreamEvent(
      "after-evt",
      (): StreamEventResult => ({
        events_out: [{ type: "after-fired" }],
        applied: true,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "boom-evt", use: "boom-evt" },
      { name: "after-evt", use: "after-evt" },
    ];
    const { applied, events_out } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toHaveLength(2);
    expect(applied[0]?.error).toBe("evt-kaboom");
    expect(applied[1]?.error).toBeUndefined();
    expect(events_out).toEqual([{ type: "after-fired" }]);
  });

  test("on_error: abort_with_500 throws EngineAbort500Error", () => {
    registerStreamEvent(
      "boom-500-evt",
      (): StreamEventResult => {
        throw new Error("evt-five-hundred");
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "boom-500-evt",
        use: "boom-500-evt",
        on_error: "abort_with_500",
      },
    ];
    expect(() => applyEvent(makeEventCtx(), rules, snap)).toThrow(
      EngineAbort500Error,
    );
  });

  test("on_error: abort_with_502 throws EngineAbort502Error", () => {
    registerStreamEvent(
      "boom-502-evt",
      (): StreamEventResult => {
        throw new Error("evt-five-oh-two");
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "boom-502-evt",
        use: "boom-502-evt",
        on_error: "abort_with_502",
      },
    ];
    expect(() => applyEvent(makeEventCtx(), rules, snap)).toThrow(
      EngineAbort502Error,
    );
  });
});

describe("applyEvent — cross-namespace independence", () => {
  test("body rule registered in body_registry is NOT visible in stream_event_registry", () => {
    register(
      "body-only",
      (ctx): TransformResult => ({ ctx, applied: true }),
      noopSchema,
    );
    // Confirm body lookup works
    expect(get("body", "body-only")).toBeDefined();
    // Confirm stream-event lookup does NOT see it
    expect(get("stream_event", "body-only")).toBeUndefined();

    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "body-only", use: "body-only" }];
    expect(() => applyEvent(makeEventCtx(), rules, snap)).toThrow(
      UnregisteredRuleError,
    );
  });
});

describe("applyEvent — defensive lookup", () => {
  test("unregistered rule.use → UnregisteredRuleError", () => {
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "ghost", use: "ghost" }];
    expect(() => applyEvent(makeEventCtx(), rules, snap)).toThrow(
      UnregisteredRuleError,
    );
  });
});

describe("applyEvent — F2 fix (M2.5): continue-error policy is fail-closed by default; continue_passthrough opt-in is fail-open", () => {
  test("F2 — single throwing rule, on_error: continue (default) → original event SUPPRESSED (fail-closed); AppliedRule has error", () => {
    registerStreamEvent(
      "boom-only",
      (): StreamEventResult => {
        throw new Error("evt-fail-closed-kaboom");
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      // Default on_error (no override) → "continue" = fail-closed.
      { name: "boom-only", use: "boom-only" },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);

    // Fail-closed contract: original event MUST NOT pass through.
    expect(events_out).toEqual([]);
    // AppliedRule still records the error for trace + observability.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("boom-only");
    expect(applied[0]?.error).toBe("evt-fail-closed-kaboom");
  });

  test("F2 — single throwing rule, on_error: continue_passthrough → original event PRESERVED (fail-open opt-in); AppliedRule has error", () => {
    registerStreamEvent(
      "boom-passthrough",
      (): StreamEventResult => {
        throw new Error("evt-fail-open-kaboom");
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "boom-passthrough",
        use: "boom-passthrough",
        on_error: "continue_passthrough",
      },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);

    // Fail-open opt-in: original event passes through unchanged.
    expect(events_out).toEqual([{ type: "message_start" }]);
    // AppliedRule still carries the error so the failure is visible in trace.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("boom-passthrough");
    expect(applied[0]?.error).toBe("evt-fail-open-kaboom");
  });

  test("F2 — abort_with_500 / abort_with_502 still throw under M2.5 (regression check on the fail-closed-by-default change)", () => {
    registerStreamEvent(
      "boom-still-500",
      (): StreamEventResult => {
        throw new Error("five-hundred-still-aborts");
      },
      noopSchema,
    );
    registerStreamEvent(
      "boom-still-502",
      (): StreamEventResult => {
        throw new Error("five-oh-two-still-aborts");
      },
      noopSchema,
    );
    const snap = snapshot("stream_event");

    const rules500: Rule[] = [
      {
        name: "boom-still-500",
        use: "boom-still-500",
        on_error: "abort_with_500",
      },
    ];
    expect(() => applyEvent(makeEventCtx(), rules500, snap)).toThrow(
      EngineAbort500Error,
    );

    const rules502: Rule[] = [
      {
        name: "boom-still-502",
        use: "boom-still-502",
        on_error: "abort_with_502",
      },
    ];
    expect(() => applyEvent(makeEventCtx(), rules502, snap)).toThrow(
      EngineAbort502Error,
    );
  });
});

describe("applyEvent — F7 fix (M3): schema-invalid honors on_error policy with D26 fail-closed default", () => {
  test("F7 — schema-invalid + on_error: 'continue' (default) → AppliedRule has error + ORIGINAL EVENT SUPPRESSED (fail-closed per D26)", () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    registerStreamEvent(
      "evt-strict-continue",
      (): StreamEventResult => ({
        events_out: [{ type: "should-not-fire" }],
        applied: true,
      }),
      strictSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "evt-strict-continue",
        use: "evt-strict-continue",
        // No on_error → defaults to "continue"
        max_count: "not-a-number",
      },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.error).toContain("schema validation failed");
    // Fail-closed: original event MUST NOT pass through.
    expect(events_out).toEqual([]);
  });

  test("F7 — schema-invalid + on_error: 'continue_passthrough' → AppliedRule has error + ORIGINAL EVENT PRESERVED (fail-open opt-in)", () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    registerStreamEvent(
      "evt-strict-passthrough",
      (): StreamEventResult => ({
        events_out: [{ type: "unused" }],
        applied: true,
      }),
      strictSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "evt-strict-passthrough",
        use: "evt-strict-passthrough",
        on_error: "continue_passthrough",
        max_count: 0,
      },
    ];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.error).toContain("schema validation failed");
    // Fail-open: original event passes through.
    expect(events_out).toEqual([{ type: "message_start" }]);
  });

  test("F7 — schema-invalid + on_error: 'abort_with_500' → throws EngineAbort500Error wrapping RuleSchemaInvalidError", () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    registerStreamEvent(
      "evt-strict-abort",
      (): StreamEventResult => ({ events_out: [], applied: true }),
      strictSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "evt-strict-abort",
        use: "evt-strict-abort",
        on_error: "abort_with_500",
        max_count: "nope",
      },
    ];
    let caught: unknown;
    try {
      applyEvent(makeEventCtx(), rules, snap);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineAbort500Error);
    expect((caught as EngineAbort500Error).originalError).toBeInstanceOf(
      RuleSchemaInvalidError,
    );
  });

  test("F7 — schema-invalid + on_error: 'abort_with_502' → throws EngineAbort502Error", () => {
    const strictSchema = z
      .object({
        name: z.string(),
        use: z.string(),
        max_count: z.number().int().min(1),
      })
      .passthrough();
    registerStreamEvent(
      "evt-strict-abort-502",
      (): StreamEventResult => ({ events_out: [], applied: true }),
      strictSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      {
        name: "evt-strict-abort-502",
        use: "evt-strict-abort-502",
        on_error: "abort_with_502",
        max_count: "nope",
      },
    ];
    expect(() => applyEvent(makeEventCtx(), rules, snap)).toThrow(
      EngineAbort502Error,
    );
  });
});

describe("applyEvent — applied:false semantics", () => {
  test("predicate matches but rule.applied = false → no AppliedRule, default passthrough", () => {
    registerStreamEvent(
      "noop-no-fire",
      (): StreamEventResult => ({
        events_out: [{ type: "should-not-appear" }],
        applied: false,
      }),
      noopSchema,
    );
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "noop-no-fire", use: "noop-no-fire" }];
    const { events_out, applied } = applyEvent(makeEventCtx(), rules, snap);
    expect(applied).toEqual([]);
    // No rule fired → default passthrough emits original event.
    expect(events_out).toEqual([{ type: "message_start" }]);
  });
});
