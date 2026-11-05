/**
 * predicate.test.ts — verifies the `when` predicate evaluator across all
 * supported keys and edge cases.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  evaluate,
  reset,
  _cacheSize,
  _hasGlob,
  setCacheBound,
} from "~/lib/transform/predicate";
import type {
  StreamEventContext,
  TransformContext,
  When,
} from "~/lib/transform/types";

const baseCtx: TransformContext = {
  body: { foo: "bar" },
  headers: {},
  route: "/v1/messages",
  model: "claude-opus-4.7",
  harness: "cc",
  request_endpoint: "/v1/messages",
  request_model: "claude-opus-4.7",
};

const baseEventCtx: StreamEventContext = {
  event: { type: "response.created" },
  state: {},
  route: "/responses",
  model: "gpt-5.5",
  request_endpoint: "/responses",
  request_model: "gpt-5.5",
};

afterEach(() => {
  reset();
  // Restore the default cache bound (256) so other tests start clean.
  setCacheBound(256);
});

describe("predicate.evaluate — empty / always-true", () => {
  test("undefined when matches everything", () => {
    expect(evaluate(undefined, baseCtx)).toBe(true);
  });

  test("empty when {} matches everything", () => {
    expect(evaluate({}, baseCtx)).toBe(true);
  });
});

describe("predicate.evaluate — exact-match keys", () => {
  test("route exact match", () => {
    expect(evaluate({ route: "/v1/messages" }, baseCtx)).toBe(true);
    expect(evaluate({ route: "/responses" }, baseCtx)).toBe(false);
  });

  test("model exact match", () => {
    expect(evaluate({ model: "claude-opus-4.7" }, baseCtx)).toBe(true);
    expect(evaluate({ model: "claude-sonnet-4.6" }, baseCtx)).toBe(false);
  });

  test("harness exact match", () => {
    expect(evaluate({ harness: "cc" }, baseCtx)).toBe(true);
    expect(evaluate({ harness: "codex" }, baseCtx)).toBe(false);
  });

  test("harness fails when ctx has no harness field", () => {
    const ctx: TransformContext = { ...baseCtx, harness: undefined };
    expect(evaluate({ harness: "cc" }, ctx)).toBe(false);
  });

  test("request_endpoint exact match (response rules)", () => {
    expect(evaluate({ request_endpoint: "/v1/messages" }, baseCtx)).toBe(true);
    expect(evaluate({ request_endpoint: "/responses" }, baseCtx)).toBe(false);
  });

  test("request_endpoint fails when ctx field absent", () => {
    const ctx: TransformContext = { ...baseCtx, request_endpoint: undefined };
    expect(evaluate({ request_endpoint: "/v1/messages" }, ctx)).toBe(false);
  });
});

describe("predicate.evaluate — model_glob", () => {
  test("'*' matches anything", () => {
    expect(evaluate({ model_glob: "*" }, baseCtx)).toBe(true);
  });

  test("prefix glob 'claude-opus-*'", () => {
    expect(evaluate({ model_glob: "claude-opus-*" }, baseCtx)).toBe(true);
    expect(
      evaluate({ model_glob: "claude-opus-*" }, { ...baseCtx, model: "gpt-5" }),
    ).toBe(false);
  });

  test("suffix glob '*-opus-4.7'", () => {
    expect(evaluate({ model_glob: "*-opus-4.7" }, baseCtx)).toBe(true);
  });

  test("'?' matches single char", () => {
    expect(evaluate({ model_glob: "claude-opus-4.?" }, baseCtx)).toBe(true);
    expect(evaluate({ model_glob: "claude-opus-4.??" }, baseCtx)).toBe(false);
  });

  test("regex meta chars in glob are literal — '.' does NOT match any char", () => {
    // `claude.4.7` glob requires a literal `.` between fragments.
    // `claude_4-7` has underscores instead of dots; should NOT match.
    expect(
      evaluate(
        { model_glob: "claude.4.7" },
        { ...baseCtx, model: "claude_4-7" },
      ),
    ).toBe(false);
    // But `claude.4.7` model with literal dots should match.
    expect(
      evaluate(
        { model_glob: "claude.4.7" },
        { ...baseCtx, model: "claude.4.7" },
      ),
    ).toBe(true);
  });
});

describe("predicate.evaluate — model_regex", () => {
  test("valid regex matches", () => {
    expect(
      evaluate({ model_regex: "^claude-opus-\\d+\\.\\d+$" }, baseCtx),
    ).toBe(true);
  });

  test("valid regex non-match", () => {
    expect(evaluate({ model_regex: "^gpt-" }, baseCtx)).toBe(false);
  });

  test("invalid regex syntax → false (no throw)", () => {
    // Unclosed group "[" → RegExp constructor throws; predicate catches.
    expect(() => evaluate({ model_regex: "[unclosed" }, baseCtx)).not.toThrow();
    expect(evaluate({ model_regex: "[unclosed" }, baseCtx)).toBe(false);
  });
});

describe("predicate.evaluate — model_in", () => {
  test("includes ctx.model → true", () => {
    expect(
      evaluate({ model_in: ["claude-sonnet-4.6", "claude-opus-4.7"] }, baseCtx),
    ).toBe(true);
  });

  test("excludes ctx.model → false", () => {
    expect(evaluate({ model_in: ["gpt-5", "gemini-3"] }, baseCtx)).toBe(false);
  });

  test("empty array → false (no entries to match)", () => {
    expect(evaluate({ model_in: [] }, baseCtx)).toBe(false);
  });
});

describe("predicate.evaluate — request_model_glob", () => {
  test("matches against ctx.request_model", () => {
    expect(evaluate({ request_model_glob: "claude-opus-*" }, baseCtx)).toBe(
      true,
    );
    expect(evaluate({ request_model_glob: "gpt-*" }, baseCtx)).toBe(false);
  });

  test("fails when ctx.request_model absent", () => {
    const ctx: TransformContext = { ...baseCtx, request_model: undefined };
    expect(evaluate({ request_model_glob: "claude-*" }, ctx)).toBe(false);
  });
});

describe("predicate.evaluate — event_types (stream-event surface)", () => {
  test("matches when event.type in list", () => {
    expect(evaluate({ event_types: ["response.created"] }, baseEventCtx)).toBe(
      true,
    );
  });

  test("rejects when event.type not in list", () => {
    expect(
      evaluate({ event_types: ["response.completed"] }, baseEventCtx),
    ).toBe(false);
  });

  test("empty event_types array → false", () => {
    expect(evaluate({ event_types: [] }, baseEventCtx)).toBe(false);
  });

  test("event_types fails on body context (no event field)", () => {
    expect(evaluate({ event_types: ["response.created"] }, baseCtx)).toBe(
      false,
    );
  });

  test("event_types matches multi-type list (per O9)", () => {
    expect(
      evaluate(
        { event_types: ["response.created", "response.completed"] },
        baseEventCtx,
      ),
    ).toBe(true);
    expect(
      evaluate(
        { event_types: ["response.created", "response.completed"] },
        { ...baseEventCtx, event: { type: "response.completed" } },
      ),
    ).toBe(true);
    expect(
      evaluate(
        { event_types: ["response.created", "response.completed"] },
        { ...baseEventCtx, event: { type: "response.delta" } },
      ),
    ).toBe(false);
  });
});

describe("predicate.evaluate — AND semantics", () => {
  test("all set fields must match", () => {
    const when: When = {
      route: "/v1/messages",
      model_glob: "claude-opus-*",
      harness: "cc",
    };
    expect(evaluate(when, baseCtx)).toBe(true);
  });

  test("one mismatch fails the whole predicate", () => {
    const when: When = {
      route: "/v1/messages",
      model_glob: "claude-opus-*",
      harness: "codex", // ctx is "cc" → fails
    };
    expect(evaluate(when, baseCtx)).toBe(false);
  });
});

describe("predicate.evaluate — method", () => {
  test("matches when ctx carries method field", () => {
    const ctx = { ...baseCtx, method: "POST" } as TransformContext & {
      method: string;
    };
    expect(evaluate({ method: "POST" }, ctx)).toBe(true);
    expect(evaluate({ method: "GET" }, ctx)).toBe(false);
  });

  test("fails when ctx lacks method but predicate sets it", () => {
    expect(evaluate({ method: "POST" }, baseCtx)).toBe(false);
  });
});

describe("predicate.evaluate — compile cache", () => {
  test("repeated calls with same glob hit the cache (no throw on re-use)", () => {
    expect(evaluate({ model_glob: "claude-*" }, baseCtx)).toBe(true);
    expect(evaluate({ model_glob: "claude-*" }, baseCtx)).toBe(true);
    expect(evaluate({ model_glob: "claude-*" }, baseCtx)).toBe(true);
  });

  test("reset() clears cache (no test-side effect across iterations)", () => {
    evaluate({ model_glob: "x*" }, baseCtx);
    reset();
    // After reset the next evaluate recompiles — must still work
    expect(evaluate({ model_glob: "x*" }, { ...baseCtx, model: "xyz" })).toBe(
      true,
    );
  });
});

describe("predicate.evaluate — F6 (M3) LRU cache eviction + setCacheBound", () => {
  test("F6 — cache hit count under bound: register 10 globs, eval each twice, no eviction", () => {
    setCacheBound(256); // explicit baseline
    for (let i = 0; i < 10; i++) {
      evaluate({ model_glob: `glob-${i}-*` }, baseCtx);
      evaluate({ model_glob: `glob-${i}-*` }, baseCtx);
    }
    expect(_cacheSize()).toBe(10);
  });

  test("F6 — eviction at bound: register 257 distinct globs → cache size = 256, oldest evicted", () => {
    setCacheBound(256);
    // First glob fingerprint we want to verify gets evicted later.
    evaluate({ model_glob: "FIRST-*" }, baseCtx);
    expect(_hasGlob("FIRST-*")).toBe(true);
    // Now register 256 more distinct globs to push past the bound.
    for (let i = 0; i < 256; i++) {
      evaluate({ model_glob: `pad-${i}-*` }, baseCtx);
    }
    expect(_cacheSize()).toBe(256);
    // The very first entry must have been evicted.
    expect(_hasGlob("FIRST-*")).toBe(false);
  });

  test("F6 — reset() clears all entries", () => {
    evaluate({ model_glob: "alpha-*" }, baseCtx);
    evaluate({ model_glob: "beta-*" }, baseCtx);
    expect(_cacheSize()).toBe(2);
    reset();
    expect(_cacheSize()).toBe(0);
  });

  test("F6 — setCacheBound(5) then register 6 → cache size = 5", () => {
    setCacheBound(5);
    for (let i = 0; i < 6; i++) {
      evaluate({ model_glob: `x-${i}-*` }, baseCtx);
    }
    expect(_cacheSize()).toBe(5);
  });

  test("F6 — setCacheBound rejects non-positive integers", () => {
    expect(() => setCacheBound(0)).toThrow();
    expect(() => setCacheBound(-1)).toThrow();
    expect(() => setCacheBound(1.5)).toThrow();
  });
});
