/**
 * Tests for src/lib/selector.ts
 *
 * Coverage map (from spec):
 *   - Path syntax: foo, foo[0], foo[], foo[].bar, foo[0].bar, foo.bar.baz
 *   - Matcher coverage: equals/startsWith/endsWith/contains/regex (positive + negative each)
 *   - jsonpath throws JsonPathNotImplemented
 *   - R10 acceptance selectors against a synthetic CC inner-call body
 *   - Edge cases: empty array, missing path, non-array indexed with [] — all return no matches
 */

import { describe, expect, it } from "bun:test";

import {
  JsonPathNotImplemented,
  type MatchResult,
  select,
} from "../../src/lib/selector.ts";

describe("path syntax", () => {
  it("matches a top-level field", () => {
    const out = select(
      { foo: "bar" },
      { path: "foo", matcher: { equals: "bar" } },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("bar");
    expect(out[0]!.path).toBe("foo");
    expect(out[0]!.index).toBe("foo");
  });

  it("matches a dotted nested field (foo.bar.baz)", () => {
    const body = { foo: { bar: { baz: "hello" } } };
    const out = select(body, {
      path: "foo.bar.baz",
      matcher: { equals: "hello" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("foo.bar.baz");
    expect(out[0]!.index).toBe("baz");
  });

  it("matches a specific array index (foo[0])", () => {
    const body = { foo: ["a", "b", "c"] };
    const out = select(body, { path: "foo[0]", matcher: { equals: "a" } });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("foo[0]");
    expect(out[0]!.index).toBe(0);
    expect(Array.isArray(out[0]!.parent)).toBe(true);
  });

  it("matches every element with wildcard (foo[])", () => {
    const body = { foo: ["a", "b", "c"] };
    const out = select(body, { path: "foo[]", matcher: { contains: "" } });
    expect(out).toHaveLength(3);
    expect(out.map((r: MatchResult) => r.value)).toEqual(["a", "b", "c"]);
    expect(out.map((r: MatchResult) => r.path)).toEqual([
      "foo[0]",
      "foo[1]",
      "foo[2]",
    ]);
  });

  it("matches nested field through wildcard (foo[].bar)", () => {
    const body = { foo: [{ bar: "x" }, { bar: "y" }] };
    const out = select(body, { path: "foo[].bar", matcher: { contains: "" } });
    expect(out).toHaveLength(2);
    expect(out[0]!.path).toBe("foo[0].bar");
    expect(out[1]!.path).toBe("foo[1].bar");
  });

  it("matches indexed dot-field combo (foo[0].bar)", () => {
    const body = { foo: [{ bar: "z" }, { bar: "q" }] };
    const out = select(body, { path: "foo[0].bar", matcher: { equals: "z" } });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("foo[0].bar");
  });
});

describe("matchers — positive + negative cases", () => {
  const body = { s: "hello world" };

  it("equals — positive + negative", () => {
    expect(
      select(body, { path: "s", matcher: { equals: "hello world" } }).length,
    ).toBe(1);
    expect(
      select(body, { path: "s", matcher: { equals: "hello" } }).length,
    ).toBe(0);
  });

  it("startsWith — positive + negative", () => {
    expect(
      select(body, { path: "s", matcher: { startsWith: "hello" } }).length,
    ).toBe(1);
    expect(
      select(body, { path: "s", matcher: { startsWith: "world" } }).length,
    ).toBe(0);
  });

  it("endsWith — positive + negative", () => {
    expect(
      select(body, { path: "s", matcher: { endsWith: "world" } }).length,
    ).toBe(1);
    expect(
      select(body, { path: "s", matcher: { endsWith: "hello" } }).length,
    ).toBe(0);
  });

  it("contains — positive + negative", () => {
    expect(
      select(body, { path: "s", matcher: { contains: "lo wo" } }).length,
    ).toBe(1);
    expect(
      select(body, { path: "s", matcher: { contains: "nope" } }).length,
    ).toBe(0);
  });

  it("regex — positive + negative", () => {
    expect(
      select(body, { path: "s", matcher: { regex: "^h.*d$" } }).length,
    ).toBe(1);
    expect(select(body, { path: "s", matcher: { regex: "^xyz" } }).length).toBe(
      0,
    );
  });

  it("non-string leaves never match", () => {
    expect(
      select({ n: 5 }, { path: "n", matcher: { equals: "5" } }).length,
    ).toBe(0);
    expect(
      select({ b: true }, { path: "b", matcher: { contains: "true" } }).length,
    ).toBe(0);
  });
});

describe("jsonpath placeholder", () => {
  it("throws JsonPathNotImplemented when used", () => {
    expect(() =>
      select({ a: 1 }, { path: "a", matcher: { jsonpath: "$.a" } }),
    ).toThrow(JsonPathNotImplemented);
  });
});

describe("edge cases", () => {
  it("empty path throws (programmer input contract)", () => {
    expect(() => select({}, { path: "", matcher: { equals: "x" } })).toThrow();
  });

  it("missing field returns no matches (no throw)", () => {
    const out = select({}, { path: "foo.bar", matcher: { equals: "x" } });
    expect(out).toEqual([]);
  });

  it("empty array under [] returns no matches", () => {
    const out = select(
      { items: [] },
      { path: "items[]", matcher: { contains: "" } },
    );
    expect(out).toEqual([]);
  });

  it("non-array addressed with [] returns no matches", () => {
    const out = select(
      { items: { not: "array" } },
      {
        path: "items[]",
        matcher: { contains: "" },
      },
    );
    expect(out).toEqual([]);
  });

  it("out-of-range index returns no matches", () => {
    const out = select(
      { a: [1, 2] },
      { path: "a[5]", matcher: { equals: "x" } },
    );
    expect(out).toEqual([]);
  });

  it("matcher with no variant throws", () => {
    expect(() => select({ a: "b" }, { path: "a", matcher: {} })).toThrow();
  });
});

describe("F11 (M3) — leading [0] / [] permitted on top-level array bodies", () => {
  it("[0].text selects element 0 of a top-level array body", () => {
    const body = [{ text: "a" }, { text: "b" }];
    const out = select(body, {
      path: "[0].text",
      matcher: { equals: "a" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("a");
    expect(out[0]!.path).toBe("[0].text");
    expect(out[0]!.index).toBe("text");
  });

  it("[].text selects every element of a top-level array body", () => {
    const body = [{ text: "a" }];
    const out = select(body, {
      path: "[].text",
      matcher: { equals: "a" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("a");
  });
});

describe("R10 acceptance selectors against synthetic CC inner-call body", () => {
  // Independently authored protocol blocks; no captured prompts.
  const ccBody = {
    model: "claude-haiku-4-5-20251001",
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=fixture; cch=00000;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "The sample palette contains blue and gold.",
      },
    ],
  };

  it("R10-A: strip x-anthropic-billing-header system block", () => {
    const out = select(ccBody, {
      path: "system[].text",
      matcher: { startsWith: "x-anthropic-billing-header:" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("system[0].text");
    // Mutation rehearsal: the parent is the system[0] object so a downstream
    // strip rule could splice ccBody.system[0] out via parent-of-parent.
    expect(out[0]!.index).toBe("text");
  });

  it("R10-B: strip CC identity system block", () => {
    const out = select(ccBody, {
      path: "system[].text",
      matcher: {
        equals: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("system[1].text");
    expect(out[0]!.value).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  it("R10-A negative: an opus billing header doesn't match haiku-style equals selector", () => {
    const out = select(ccBody, {
      path: "system[].text",
      matcher: { equals: "x-anthropic-billing-header:" },
    });
    // equals requires exact match; the actual leaf has more text after the prefix
    expect(out).toEqual([]);
  });
});
