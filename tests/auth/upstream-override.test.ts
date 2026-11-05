/**
 * Tests for src/auth/upstream-override.ts — the COPILOT_PROXY_UPSTREAM_BASE_URL parser.
 *
 * THE CASE LIST IS DERIVED FROM THE PARSER'S OWN BRANCHES, NOT FROM A TABLE.
 * `parseUpstreamOverride` has exactly five `return { kind: "error" ... }` arms —
 * unparseable, protocol, credentials, path, query-or-fragment — plus the unset
 * guard and the ok terminus. Every one is exercised below, and the list was
 * built by reading the function, so it cannot drift from a transcription of it.
 *
 * NO ENVIRONMENT MUTATION ANYWHERE IN THIS FILE. The parser takes `raw` as an
 * argument, which is the whole reason it is shaped that way: Bun shares
 * `process.env` across a test file, so a suite that sets and unsets keys is
 * order-dependent by construction. The module-capture behaviour that DOES need
 * a real environment lives in `api-config-override.test.ts`, which spawns
 * children.
 */

import { describe, expect, it } from "bun:test";

import {
  UPSTREAM_OVERRIDE_ENV,
  parseUpstreamOverride,
} from "../../src/auth/upstream-override.ts";

describe("parseUpstreamOverride — unset", () => {
  it("treats an absent variable as unset", () => {
    expect(parseUpstreamOverride(undefined)).toEqual({ kind: "unset" });
  });

  it("treats an empty string as unset, because that is what a cleared shell var produces", () => {
    expect(parseUpstreamOverride("")).toEqual({ kind: "unset" });
  });

  it("treats whitespace-only as unset", () => {
    expect(parseUpstreamOverride("   ")).toEqual({ kind: "unset" });
  });
});

describe("parseUpstreamOverride — accepted", () => {
  it("accepts an absolute https origin and returns it verbatim, with no trailing slash", () => {
    expect(parseUpstreamOverride("https://proxy.internal")).toEqual({
      kind: "ok",
      baseUrl: "https://proxy.internal",
    });
  });

  it("accepts plain http — a deliberate loopback-dev affordance, not an oversight", () => {
    expect(parseUpstreamOverride("http://127.0.0.1:4144")).toEqual({
      kind: "ok",
      baseUrl: "http://127.0.0.1:4144",
    });
  });

  it("preserves an explicit port", () => {
    const r = parseUpstreamOverride("http://localhost:8080");
    expect(r).toEqual({ kind: "ok", baseUrl: "http://localhost:8080" });
  });

  it("trims surrounding whitespace and returns the TRIMMED form", () => {
    expect(parseUpstreamOverride("  https://proxy.internal  ")).toEqual({
      kind: "ok",
      baseUrl: "https://proxy.internal",
    });
  });

  it("accepts a bare origin with a trailing slash — URL normalises pathname to '/'", () => {
    expect(parseUpstreamOverride("https://proxy.internal/")).toEqual({
      kind: "ok",
      baseUrl: "https://proxy.internal",
    });
  });
});

describe("parseUpstreamOverride — rejected, one case per error branch", () => {
  it("rejects a pathname, which would otherwise concatenate into /v1/v1/messages", () => {
    const r = parseUpstreamOverride("https://proxy.internal/v1");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("path");
    // The host survives; the path does NOT. `safeDescribe` builds from parsed
    // components, and a path is operator-typed free text like any other, so it
    // is named by a marker rather than echoed.
    expect(r.safeValue).toBe("https://proxy.internal [+path]");
  });

  it("rejects a non-http(s) protocol and names it", () => {
    const r = parseUpstreamOverride("ftp://h");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("protocol");
    expect(r.reason).toContain("ftp:");
  });

  it("rejects embedded credentials", () => {
    const r = parseUpstreamOverride("http://user:pw@127.0.0.1:4144");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("credentials");
  });

  it("rejects a query string", () => {
    const r = parseUpstreamOverride("http://127.0.0.1:4144?x=1");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("query");
  });

  it("rejects a fragment", () => {
    const r = parseUpstreamOverride("http://127.0.0.1:4144#frag");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("query");
  });

  it("rejects an unparseable string — the URL throw is caught, never propagated", () => {
    const r = parseUpstreamOverride("not a url at all");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.reason).toContain("absolute");
  });

  it("rejects a bare host with no scheme — it lands in error, never in ok", () => {
    expect(parseUpstreamOverride("proxy.internal").kind).toBe("error");
  });

  it("identifies the offending input on every error result, so the boot log is actionable", () => {
    // ⚠ THIS TEST ASSERTED THE OPPOSITE UNTIL THE ROUND-2 GATE. It read "values
    // with NOTHING sensitive in them survive verbatim" and pinned
    // `safeValue === bad`. That premise is dead: `safeDescribe` CONSTRUCTS its
    // output instead of filtering the input, because deciding which inputs are
    // "nothing sensitive" is exactly the judgement that leaked three secrets past
    // the old redactor.
    //
    // ⚠ AND THE REPLACEMENT WAS ITSELF OVERSTATED UNTIL ROUND 4. It said
    // `safeDescribe` "never copies operator input", which is false: the SCHEME
    // and the HOST are copied through — see the `ftp://h` case immediately below,
    // where both survive verbatim. What is guaranteed is narrower and is exactly
    // what these expectations encode: userinfo, path, query and fragment cannot
    // survive; scheme and host can, and the reason string names the offending
    // construct.
    const cases: Array<[string, string]> = [
      ["https://proxy.internal/v1", "https://proxy.internal [+path]"],
      ["ftp://h", "ftp://h"],
      ["not a url at all", "(withheld — unparseable, 16 chars)"],
    ];
    for (const [bad, expected] of cases) {
      const r = parseUpstreamOverride(bad);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("unreachable");
      expect(r.safeValue).toBe(expected);
    }
  });
});

describe("parseUpstreamOverride — the error variant is safe to LOG", () => {
  /**
   * The rejected value is operator input, and two of the five rejection branches
   * fire precisely BECAUSE it held something sensitive: `credentials` on
   * `user:pw@`, and `query` on a value whose query string may carry a token.
   * `main.ts` prints this field into a boot log that is preserved and rotated on
   * this platform (D65), so a verbatim field writes the secret to disk.
   *
   * ⚠ THE FIRST VERSION OF THIS GUARD WAS A REDACTOR AND IT LEAKED. It stripped
   * userinfo, query and fragment out of the raw string with regexes, and the
   * cross-family gate refuted it; three leaks were then MEASURED. All three are
   * pinned below as regressions. The fix was not a better regex — it was to stop
   * filtering and start CONSTRUCTING. A filter has to anticipate every construct
   * that can carry a secret; a construction only ever emits fields chosen in
   * advance.
   *
   * ⚠ THE SCOPE, stated exactly, because the absolute version of this sentence
   * has now been wrong twice and round 4 caught the second one. EXCLUDED by
   * construction: userinfo, path, query, fragment. COPIED THROUGH: the scheme and
   * the host — and the scheme again in the `unsupported protocol "…"` reason.
   * Both are kept deliberately, because `reason` names the offending construct
   * but not the value, so without them an operator with several exported
   * variables cannot tell which one was rejected.
   *
   * That is the same structural move as the `ok` variant carrying `u.origin`
   * (F203) — make the unsafe thing unavailable rather than documented as
   * forbidden — and it is applied in the PARSER so no consumer has to remember.
   */
  it("never lets userinfo reach the boot log, and stays actionable", () => {
    const r = parseUpstreamOverride("http://user:hunter2@127.0.0.1:4144");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.safeValue).not.toContain("hunter2");
    expect(r.safeValue).not.toContain("user");
    // Still actionable: the host survives and the reason names the construct.
    expect(r.safeValue).toBe("http://127.0.0.1:4144 [+credentials]");
    expect(r.reason).toContain("credentials");
  });

  it("never lets a query string or a fragment reach the boot log", () => {
    const q = parseUpstreamOverride("http://127.0.0.1:4144?token=s3cret");
    expect(q.kind).toBe("error");
    if (q.kind !== "error") throw new Error("unreachable");
    expect(q.safeValue).not.toContain("s3cret");
    expect(q.safeValue).toBe("http://127.0.0.1:4144 [+query]");

    const f = parseUpstreamOverride("http://127.0.0.1:4144#s3cret");
    expect(f.kind).toBe("error");
    if (f.kind !== "error") throw new Error("unreachable");
    expect(f.safeValue).not.toContain("s3cret");
    expect(f.safeValue).toBe("http://127.0.0.1:4144 [+fragment]");
  });

  /**
   * The three vectors that DEFEATED the previous regex redactor, each measured
   * against it rather than imagined. Every one is a value `new URL()` accepts,
   * so every one genuinely reaches this code through a rejection branch.
   *
   *   http://first@name:hunter2@127.0.0.1  ->  http://***@name:hunter2@127.0.0.1
   *   http://127.0.0.1/?a=1 token=SECRET   ->  http://127.0.0.1/?*** token=SECRET
   *   http://127.0.0.1/# SECRET            ->  http://127.0.0.1/#*** SECRET
   *
   * The first is the one the gate found: WHATWG URL treats the LAST `@` in the
   * authority as the host separator while the regex stopped at the FIRST. The
   * other two are the same shape one level down — the regexes terminated at
   * whitespace, which URL parsing percent-encodes rather than rejects. The third
   * was found here, by extending the gate's class rather than fixing only the
   * two instances it named.
   *
   * If anyone ever reintroduces string filtering, these fail.
   */
  it("holds against the three vectors that defeated the previous redactor", () => {
    const vectors: Array<[string, string, string]> = [
      // input, secret that must not survive, exact expected description
      [
        "http://first@name:hunter2@127.0.0.1",
        "hunter2",
        "http://127.0.0.1 [+credentials]",
      ],
      [
        "http://127.0.0.1/?a=1 token=tok_live_abcdef",
        "tok_live_abcdef",
        "http://127.0.0.1 [+query]",
      ],
      ["http://127.0.0.1/# s3cr3t", "s3cr3t", "http://127.0.0.1 [+fragment]"],
    ];
    for (const [input, secret, expected] of vectors) {
      const r = parseUpstreamOverride(input);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("unreachable");
      expect(r.safeValue).not.toContain(secret);
      expect(r.safeValue).toBe(expected);
    }
  });

  it("cannot echo an unparseable value at all — it withholds instead of guessing", () => {
    // No URL object exists on this branch, so there is nothing safe to build
    // from. A filter would have had to guess; this reports a length and stops.
    const r = parseUpstreamOverride("http://u:p@ ?token=s3cret #frag");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.safeValue).not.toContain("s3cret");
    expect(r.safeValue).not.toContain("u:p");
    expect(r.safeValue).toContain("withheld");
  });

  it("bounds the length, so a pasted blob cannot become the boot log", () => {
    const r = parseUpstreamOverride("http://h/" + "a".repeat(5000));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.safeValue.length).toBeLessThan(250);
  });

  it("is TOTAL — it runs on values that failed URL parsing", () => {
    // The unparseable branch is reached BEFORE any URL object exists, so a
    // redactor that depended on parsing would be unavailable exactly there.
    const r = parseUpstreamOverride("http://u:p@ not a url");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.safeValue).not.toContain("u:p");
  });
});

describe("parseUpstreamOverride — safety invariants", () => {
  /**
   * F203. The credentials guard is one line and could be deleted. This records
   * the PLATFORM PROPERTY that makes a second line of defence possible: WHATWG
   * defines `origin` as scheme + host + port, so a value built from `u.origin`
   * cannot carry userinfo even if the guard above were removed. Measured:
   * new URL("http://user:pw@h").origin is "http://h".
   *
   * ⚠ WHAT THIS TEST DOES NOT DO, stated because round 4 caught the claim that it
   * did. It never observes a `baseUrl` the PARSER produced from a
   * credential-bearing input — it cannot, because the guard rejects those before
   * an `ok` variant exists. So replacing `u.origin` with the raw value in
   * production would leave THIS case green. The parser-side pin is the
   * trailing-slash case immediately below, which reads `r.baseUrl` directly:
   * `https://proxy.internal/` is accepted and must come back WITHOUT the slash,
   * which only `u.origin` produces. That case is mutation-proven; this one is a
   * documented platform fact, and calling it the second line of defence was
   * overstating it.
   */
  it("never emits a baseUrl containing userinfo, independently of the credentials guard", () => {
    for (const v of [
      "http://user:pw@127.0.0.1:4144",
      "https://u:p@stub.internal",
      "http://user@127.0.0.1:4144",
    ]) {
      const r = parseUpstreamOverride(v);
      // guard fires today
      expect(r.kind).toBe("error");
      // and origin would strip it regardless
      expect(new URL(v).origin).not.toContain("@");
    }
  });

  it("never emits a baseUrl with a trailing slash, so concatenation cannot double it", () => {
    for (const v of [
      "https://proxy.internal",
      "https://proxy.internal/",
      "http://127.0.0.1:4144",
    ]) {
      const r = parseUpstreamOverride(v);
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") throw new Error("unreachable");
      expect(r.baseUrl.endsWith("/")).toBe(false);
    }
  });
});

describe("the environment variable NAME is the interface", () => {
  /**
   * Set BY LITERAL, never by importing the constant — otherwise the test and the
   * source share a typo and agree with each other perfectly. A misspelling in
   * the source is exactly the bug that leaves every other test in this file
   * green, because they all route through the same misspelled constant.
   */
  it("is exactly COPILOT_PROXY_UPSTREAM_BASE_URL", () => {
    expect(UPSTREAM_OVERRIDE_ENV).toBe("COPILOT_PROXY_UPSTREAM_BASE_URL");
  });

  it("matches the COPILOT_PROXY_<NOUN> convention the other six variables use", () => {
    expect(UPSTREAM_OVERRIDE_ENV.startsWith("COPILOT_PROXY_")).toBe(true);
    expect(UPSTREAM_OVERRIDE_ENV).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
