/**
 * Tests for src/lib/redact.ts
 *
 * Coverage map (from spec):
 *   1. Per-header allowlist: each of the 9 sensitive headers wholesale-redacted
 *   2. Per-body-field allowlist: each of the 4 sensitive body fields redacted,
 *      including 3-level deep walks
 *   3. ghu_xxx pattern in any string
 *   4. IDE token full enum: tid, ssc, exp, sku, sts, st — all 6 redacted with
 *      length parity preserved
 *   5. Length parity: <redacted, len=N> matches original length
 *   6. Headers come back lowercased; input not mutated
 */

import { describe, expect, it } from "bun:test";

import { redactBody, redactHeaders } from "../../src/lib/redact.ts";

const SENSITIVE_HEADERS: Array<[string, string]> = [
  ["Authorization", "Bearer abc123"],
  ["X-Api-Key", "sk-test-12345"],
  ["Anthropic-Api-Key", "sk-ant-XXXXXXXXXX"],
  ["X-Github-Token", "ghu_thisIsATokenValue"],
  ["Cookie", "session=abcdefghij"],
  ["Set-Cookie", "session=abcdefghij; Path=/"],
  ["OpenAI-Organization", "org-XXXXXXXX"],
  ["X-Goog-Api-Key", "AIzaSyXXXXXXXXXX"],
  ["Proxy-Authorization", "Basic dXNlcjpwYXNz"],
];

describe("redactHeaders — sensitive header allowlist", () => {
  for (const [name, value] of SENSITIVE_HEADERS) {
    it(`redacts ${name} wholesale and preserves length`, () => {
      const out = redactHeaders({ [name]: value });
      const k = name.toLowerCase();
      expect(out[k]).toBe(`<redacted, len=${value.length}>`);
    });
  }

  it("lowercases header keys in the output", () => {
    const out = redactHeaders({ "Content-Type": "application/json" });
    expect(out["content-type"]).toBe("application/json");
    expect(out["Content-Type"]).toBeUndefined();
  });

  it("does not mutate the input header dictionary", () => {
    const input = { Authorization: "Bearer secret" };
    const before = { ...input };
    redactHeaders(input);
    expect(input).toEqual(before);
  });

  it("passes non-sensitive headers through unchanged (modulo key case)", () => {
    const out = redactHeaders({
      Accept: "application/json",
      "X-Stainless-Lang": "js",
    });
    expect(out["accept"]).toBe("application/json");
    expect(out["x-stainless-lang"]).toBe("js");
  });
});

describe("redactHeaders — IDE token full enum (H3 review fix)", () => {
  it("redacts ALL 6 sub-fields tid/ssc/exp/sku/sts/st with length parity", () => {
    const value = "tid=abc;ssc=defg;exp=12345;sku=xyz;sts=ok;st=99";
    const out = redactHeaders({ "X-Ide-Token": value });
    const got = out["x-ide-token"];
    expect(got).toBe(
      `tid=<redacted, len=3>;ssc=<redacted, len=4>;exp=<redacted, len=5>;sku=<redacted, len=3>;sts=<redacted, len=2>;st=<redacted, len=2>`,
    );
  });

  it("handles any subset / ordering / mixed-case keys", () => {
    const value = "EXP=999;OTHER=keep;Tid=hello";
    const out = redactHeaders({ "X-Misc": value });
    const got = out["x-misc"];
    // EXP and Tid match (case-insensitive); OTHER passes through
    expect(got).toBe(`EXP=<redacted, len=3>;OTHER=keep;Tid=<redacted, len=5>`);
  });

  it("leaves non-IDE-token semicolon-delimited values alone", () => {
    const out = redactHeaders({
      "Set-Cookie-Like-Custom": "foo=bar;baz=qux",
    });
    expect(out["set-cookie-like-custom"]).toBe("foo=bar;baz=qux");
  });

  it("redacts a sensitive header wholesale even when it contains IDE sub-fields", () => {
    // Wholesale redaction wins; we don't try to parse internal structure.
    const value = "tid=abc;ssc=def";
    const out = redactHeaders({ Authorization: value });
    expect(out["authorization"]).toBe(`<redacted, len=${value.length}>`);
  });
});

describe("redactHeaders — ghu_ pattern scan in headers", () => {
  it("redacts a ghu_xxx token embedded in a non-sensitive header value", () => {
    const out = redactHeaders({
      "X-Custom-Trace": "trace-id=ghu_abcDEF123 step=1",
    });
    expect(out["x-custom-trace"]).toBe("trace-id=<redacted, len=13> step=1");
  });
});

const BODY_FIELDS: Array<string> = [
  "client_secret",
  "refresh_token",
  "id_token",
  "access_token",
];

describe("redactBody — body field allowlist", () => {
  for (const field of BODY_FIELDS) {
    it(`redacts top-level ${field} string value`, () => {
      const value = "verysecretvalue";
      const out = redactBody({ [field]: value }) as Record<string, string>;
      expect(out[field]).toBe(`<redacted, len=${value.length}>`);
    });
  }

  it("deep-walks 3 levels and redacts a sensitive field at the leaf", () => {
    const input = {
      a: {
        b: {
          c: { refresh_token: "abcd" },
        },
      },
    };
    const out = redactBody(input) as {
      a: { b: { c: { refresh_token: string } } };
    };
    expect(out.a.b.c.refresh_token).toBe(`<redacted, len=4>`);
  });

  it("walks through arrays and redacts inside them", () => {
    const input = {
      items: [
        { ok: "yes" },
        { client_secret: "topsecret", inner: { id_token: "leaf" } },
      ],
    };
    type Out = {
      items: Array<{
        ok?: string;
        client_secret?: string;
        inner?: { id_token: string };
      }>;
    };
    const out = redactBody(input) as Out;
    expect(out.items[0]?.ok).toBe("yes");
    expect(out.items[1]?.client_secret).toBe(`<redacted, len=9>`);
    expect(out.items[1]?.inner?.id_token).toBe(`<redacted, len=4>`);
  });

  it("does not mutate the input body", () => {
    const input = { refresh_token: "abc", nested: { id_token: "xyz" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactBody(input);
    expect(input).toEqual(snapshot);
  });

  it("handles non-string sensitive values via JSON length", () => {
    const out = redactBody({ access_token: { weird: 1 } }) as {
      access_token: string;
    };
    // {"weird":1} → 11 chars
    expect(out.access_token).toBe(`<redacted, len=11>`);
  });

  it("preserves null / undefined / boolean / number scalars", () => {
    const input = { a: null, b: 1, c: true, d: undefined };
    const out = redactBody(input) as Record<string, unknown>;
    expect(out.a).toBeNull();
    expect(out.b).toBe(1);
    expect(out.c).toBe(true);
    expect(out.d).toBeUndefined();
  });
});

describe("redactBody — ghu_ pattern scan in body strings", () => {
  it("redacts a ghu_xxx token embedded in a deep string value", () => {
    const input = {
      logs: [{ message: "saw token ghu_abc123XYZ pls help" }],
    };
    const out = redactBody(input) as { logs: Array<{ message: string }> };
    expect(out.logs[0]?.message).toBe("saw token <redacted, len=13> pls help");
  });

  it("redacts multiple ghu_ matches in one string", () => {
    const out = redactBody({ s: "a ghu_111 b ghu_2222 c" }) as { s: string };
    expect(out.s).toBe("a <redacted, len=7> b <redacted, len=8> c");
  });

  it("leaves strings without the pattern unchanged", () => {
    const out = redactBody({ s: "no secrets here" }) as { s: string };
    expect(out.s).toBe("no secrets here");
  });
});
