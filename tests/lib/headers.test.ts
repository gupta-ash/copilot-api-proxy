/**
 * Tests for src/lib/headers.ts
 *
 * Coverage map (from M1b spec):
 *   - getHeader: case-insensitive lookup positive + negative cases; missing → undefined
 *   - setHeader: overwrite (case-insensitive collision); insert new; output uses
 *     lowercase canonical key; INPUT NOT MUTATED
 *   - appendHeader: append to existing single-value (becomes "existing,new");
 *     append when missing (becomes single value); INPUT NOT MUTATED
 *   - parseCsv / serializeCsv round-trip + edge cases
 *   - filterCsv: keep only allowlisted; empty input; empty allowlist; all filtered
 *   - unionCsv: empty/empty, left-only, right-only, disjoint, overlap, real
 *     Anthropic-Beta values (H4 fix preview)
 *   - intersectCsv: disjoint, full overlap, partial overlap
 *   - replaceCsv: returns right verbatim
 */

import { describe, expect, it } from "bun:test";

import {
  appendHeader,
  filterCsv,
  getHeader,
  intersectCsv,
  parseCsv,
  replaceCsv,
  serializeCsv,
  setHeader,
  unionCsv,
} from "../../src/lib/headers.ts";

describe("getHeader — case-insensitive lookup", () => {
  it("finds a header by exact-case key", () => {
    expect(
      getHeader({ "content-type": "application/json" }, "content-type"),
    ).toBe("application/json");
  });

  it("finds a header by case-insensitive lookup (uppercase query)", () => {
    expect(
      getHeader({ "content-type": "application/json" }, "Content-Type"),
    ).toBe("application/json");
  });

  it("finds a header when the dict has mixed-case keys", () => {
    expect(getHeader({ "X-Foo": "bar" }, "x-foo")).toBe("bar");
  });

  it("returns undefined when the header is missing", () => {
    expect(
      getHeader({ "content-type": "application/json" }, "authorization"),
    ).toBeUndefined();
  });

  it("returns undefined for an empty dict", () => {
    expect(getHeader({}, "anything")).toBeUndefined();
  });
});

describe("setHeader — overwrite + insert + lowercase canonical + no-mutation", () => {
  it("inserts a new header with lowercase canonical key", () => {
    const input = { "content-type": "application/json" };
    const out = setHeader(input, "X-Foo", "bar");
    expect(out["x-foo"]).toBe("bar");
    expect(out["content-type"]).toBe("application/json");
  });

  it("overwrites an existing header (case-insensitive collision)", () => {
    const input = { "Content-Type": "application/json" };
    const out = setHeader(input, "content-type", "text/plain");
    expect(out["content-type"]).toBe("text/plain");
    // No leftover mixed-case duplicate.
    expect(
      Object.keys(out).filter((k) => k.toLowerCase() === "content-type"),
    ).toHaveLength(1);
  });

  it("output uses lowercase canonical key even when caller passes uppercase", () => {
    const out = setHeader({}, "AUTHORIZATION", "Bearer x");
    expect(out["authorization"]).toBe("Bearer x");
    expect(out["AUTHORIZATION"]).toBeUndefined();
  });

  it("INPUT NOT MUTATED — original dict unchanged after call", () => {
    const input = { "Content-Type": "application/json" };
    const snapshot = { ...input };
    setHeader(input, "Content-Type", "text/plain");
    expect(input).toEqual(snapshot);
  });
});

describe("appendHeader — RFC 7230 list-based combination + no-mutation", () => {
  it("appends to existing single-value (becomes 'existing,new')", () => {
    const input = { "anthropic-beta": "claude-code-20250219" };
    const out = appendHeader(
      input,
      "anthropic-beta",
      "advanced-tool-use-2025-11-20",
    );
    expect(out["anthropic-beta"]).toBe(
      "claude-code-20250219,advanced-tool-use-2025-11-20",
    );
  });

  it("appends to missing header (becomes single value)", () => {
    const input = { "content-type": "application/json" };
    const out = appendHeader(input, "anthropic-beta", "claude-code-20250219");
    expect(out["anthropic-beta"]).toBe("claude-code-20250219");
    expect(out["content-type"]).toBe("application/json");
  });

  it("appends case-insensitively (collides with mixed-case existing)", () => {
    const input = { "Anthropic-Beta": "a" };
    const out = appendHeader(input, "anthropic-beta", "b");
    expect(out["anthropic-beta"]).toBe("a,b");
    expect(
      Object.keys(out).filter((k) => k.toLowerCase() === "anthropic-beta"),
    ).toHaveLength(1);
  });

  it("INPUT NOT MUTATED", () => {
    const input = { "anthropic-beta": "a" };
    const snapshot = { ...input };
    appendHeader(input, "anthropic-beta", "b");
    expect(input).toEqual(snapshot);
  });
});

describe("parseCsv / serializeCsv round-trip + edges", () => {
  it("'a, b, c' → ['a','b','c'] → 'a, b, c'", () => {
    const parsed = parseCsv("a, b, c");
    expect(parsed).toEqual(["a", "b", "c"]);
    expect(serializeCsv(parsed)).toBe("a, b, c");
  });

  it("'' → [] → ''", () => {
    const parsed = parseCsv("");
    expect(parsed).toEqual([]);
    expect(serializeCsv(parsed)).toBe("");
  });

  it("'   a  ,  b ,c  ' → ['a','b','c'] → 'a, b, c'", () => {
    const parsed = parseCsv("   a  ,  b ,c  ");
    expect(parsed).toEqual(["a", "b", "c"]);
    expect(serializeCsv(parsed)).toBe("a, b, c");
  });

  it("single-value 'foo' → ['foo'] → 'foo'", () => {
    const parsed = parseCsv("foo");
    expect(parsed).toEqual(["foo"]);
    expect(serializeCsv(parsed)).toBe("foo");
  });

  it("trailing-comma edge 'a,b,' → ['a','b']", () => {
    expect(parseCsv("a,b,")).toEqual(["a", "b"]);
  });
});

describe("filterCsv — allowlist filtering", () => {
  it("keeps only allowlisted entries", () => {
    expect(filterCsv("a, b, c", new Set(["a", "c"]))).toBe("a, c");
  });

  it("empty input → empty output", () => {
    expect(filterCsv("", new Set(["a"]))).toBe("");
  });

  it("empty allowlist → empty output", () => {
    expect(filterCsv("a, b", new Set<string>())).toBe("");
  });

  it("all filtered → empty output", () => {
    expect(filterCsv("a, b", new Set(["x", "y"]))).toBe("");
  });

  it("preserves left order in output", () => {
    expect(filterCsv("c, a, b", new Set(["a", "b", "c"]))).toBe("c, a, b");
  });
});

describe("unionCsv — left order then right-only, deduped", () => {
  it("both empty → empty", () => {
    expect(unionCsv("", "")).toBe("");
  });

  it("left only → left", () => {
    expect(unionCsv("a, b", "")).toBe("a, b");
  });

  it("right only → right", () => {
    expect(unionCsv("", "a, b")).toBe("a, b");
  });

  it("disjoint sets → left then right (in order)", () => {
    expect(unionCsv("a, b", "c, d")).toBe("a, b, c, d");
  });

  it("overlap → no duplicates (preserve left order, append right-only)", () => {
    expect(unionCsv("a, b, c", "b, d, a, e")).toBe("a, b, c, d, e");
  });

  it("realistic Anthropic-Beta values (H4 fix preview)", () => {
    const left = "claude-code-20250219, oauth-2025-04-20"; // from CC
    const right = "advanced-tool-use-2025-11-20"; // bundle's hardcoded inject
    const out = unionCsv(left, right);
    const entries = parseCsv(out);
    expect(entries).toContain("claude-code-20250219");
    expect(entries).toContain("oauth-2025-04-20");
    expect(entries).toContain("advanced-tool-use-2025-11-20");
    expect(entries).toHaveLength(3);
    // Order: left entries first (in left order), then right-only.
    expect(entries[0]).toBe("claude-code-20250219");
    expect(entries[1]).toBe("oauth-2025-04-20");
    expect(entries[2]).toBe("advanced-tool-use-2025-11-20");
  });
});

describe("intersectCsv — entries in BOTH inputs, left order", () => {
  it("disjoint → empty", () => {
    expect(intersectCsv("a, b", "c, d")).toBe("");
  });

  it("full overlap → left order", () => {
    expect(intersectCsv("a, b, c", "c, b, a")).toBe("a, b, c");
  });

  it("partial overlap → only common entries in left order", () => {
    expect(intersectCsv("a, b, c, d", "c, a, e")).toBe("a, c");
  });

  it("empty left → empty output", () => {
    expect(intersectCsv("", "a, b")).toBe("");
  });

  it("empty right → empty output", () => {
    expect(intersectCsv("a, b", "")).toBe("");
  });

  it("dedupe within left input collapses duplicates", () => {
    expect(intersectCsv("a, a, b", "a, b")).toBe("a, b");
  });
});

describe("replaceCsv — returns right verbatim", () => {
  it("returns right verbatim regardless of left", () => {
    expect(replaceCsv("a, b, c", "x, y")).toBe("x, y");
  });

  it("empty right yields empty output", () => {
    expect(replaceCsv("a, b, c", "")).toBe("");
  });

  it("left value irrelevant (empty left, populated right)", () => {
    expect(replaceCsv("", "x, y")).toBe("x, y");
  });
});
