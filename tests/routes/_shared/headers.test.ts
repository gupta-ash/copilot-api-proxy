/**
 * headers.test.ts — D-LOCK-10 helper verification.
 *
 * Coverage (≥6 cases per spec):
 *   - mixed-case merge produces single lowercase key
 *   - later source wins on case-insensitive collision
 *   - setAuthorization removes Authorization + authorization + AUTHORIZATION
 *   - empty input returns empty object
 *   - numeric/boolean values stringified
 *   - preserves multi-value headers (CSV string preserved verbatim)
 */

import { describe, expect, it } from "bun:test";

import {
  OUTBOUND_DROP_HEADERS,
  canonicalHeaders,
  dropOutboundHopHeaders,
  setAuthorization,
} from "../../../src/routes/_shared/headers.ts";

describe("canonicalHeaders", () => {
  it("lowercases all keys", () => {
    const out = canonicalHeaders({
      "Content-Type": "application/json",
      "X-Request-Id": "abc",
    });
    expect(Object.keys(out).sort()).toEqual(["content-type", "x-request-id"]);
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-request-id"]).toBe("abc");
  });

  it("merges sources later-wins on collision", () => {
    const out = canonicalHeaders(
      { Authorization: "Bearer base", "X-Trace": "1" },
      { authorization: "Bearer override" },
    );
    expect(out["authorization"]).toBe("Bearer override");
    expect(out["x-trace"]).toBe("1");
    // Should NOT have both Authorization AND authorization keys.
    const authKeys = Object.keys(out).filter(
      (k) => k.toLowerCase() === "authorization",
    );
    expect(authKeys.length).toBe(1);
    expect(authKeys[0]).toBe("authorization");
  });

  it("returns empty object for no inputs", () => {
    expect(canonicalHeaders()).toEqual({});
  });

  it("returns empty object for empty input", () => {
    expect(canonicalHeaders({})).toEqual({});
  });

  it("stringifies numeric and boolean values", () => {
    const out = canonicalHeaders({
      "x-int": 42,
      "x-bool": true,
    });
    expect(out["x-int"]).toBe("42");
    expect(out["x-bool"]).toBe("true");
  });

  it("preserves CSV multi-value headers verbatim", () => {
    const out = canonicalHeaders({
      "Anthropic-Beta": "tools-2024-04-04, prompt-caching-2024-07-31",
    });
    expect(out["anthropic-beta"]).toBe(
      "tools-2024-04-04, prompt-caching-2024-07-31",
    );
  });
});

describe("setAuthorization", () => {
  it("removes ALL case variants of authorization before setting new one", () => {
    const input = {
      Authorization: "old-1",
      authorization: "old-2",
      AUTHORIZATION: "old-3",
      "x-other": "keep",
    };
    const out = setAuthorization(input, "fresh-token");
    const authKeys = Object.keys(out).filter(
      (k) => k.toLowerCase() === "authorization",
    );
    expect(authKeys.length).toBe(1);
    expect(out["authorization"]).toBe("Bearer fresh-token");
    expect(out["x-other"]).toBe("keep");
  });

  it("input is not mutated", () => {
    const input = { Authorization: "Bearer original" };
    const beforeKeys = Object.keys(input);
    const out = setAuthorization(input, "new");
    expect(Object.keys(input)).toEqual(beforeKeys);
    expect(input.Authorization).toBe("Bearer original");
    expect(out["authorization"]).toBe("Bearer new");
  });

  it("works on empty input", () => {
    expect(setAuthorization({}, "tok")).toEqual({
      authorization: "Bearer tok",
    });
  });
});

describe("dropOutboundHopHeaders", () => {
  it("drops content-length / content-encoding / transfer-encoding (body-encoding entity headers)", () => {
    const out = dropOutboundHopHeaders({
      "content-length": "123",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
      "content-type": "application/json",
      "x-keep": "yes",
    });
    expect(out["content-length"]).toBeUndefined();
    expect(out["content-encoding"]).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-keep"]).toBe("yes");
  });

  it("drops RFC 7230 §6.1 hop-by-hop headers", () => {
    const out = dropOutboundHopHeaders({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      te: "trailers",
      trailer: "Expires",
      upgrade: "websocket",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Bearer x",
      "x-keep": "yes",
    });
    for (const k of [
      "connection",
      "keep-alive",
      "te",
      "trailer",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
    ]) {
      expect(out[k]).toBeUndefined();
    }
    expect(out["x-keep"]).toBe("yes");
  });

  it("drops host so undici computes from upstream URL", () => {
    const out = dropOutboundHopHeaders({
      host: "127.0.0.1:4143",
      authorization: "Bearer t",
    });
    expect(out["host"]).toBeUndefined();
    expect(out["authorization"]).toBe("Bearer t");
  });

  it("matches case-insensitively (defensive even though canonicalHeaders lowercases)", () => {
    const out = dropOutboundHopHeaders({
      "Content-Length": "999",
      Connection: "close",
      Host: "evil.example",
    });
    expect(Object.keys(out).length).toBe(0);
  });

  it("input is not mutated", () => {
    const input = { "content-length": "123", "x-other": "keep" };
    const beforeKeys = Object.keys(input);
    dropOutboundHopHeaders(input);
    expect(Object.keys(input)).toEqual(beforeKeys);
    expect(input["content-length"]).toBe("123");
  });

  it("preserves Authorization, Anthropic-Beta, copilot-* headers (positive control)", () => {
    const out = dropOutboundHopHeaders({
      authorization: "Bearer tid=abc;exp=1234",
      "anthropic-beta": "claude-code-20250219, oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "copilot-integration-id": "vscode-chat",
      "editor-version": "vscode/1.117.0",
      "x-github-api-version": "2025-10-01",
    });
    expect(out["authorization"]).toBe("Bearer tid=abc;exp=1234");
    expect(out["anthropic-beta"]).toBe(
      "claude-code-20250219, oauth-2025-04-20",
    );
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["copilot-integration-id"]).toBe("vscode-chat");
    expect(out["editor-version"]).toBe("vscode/1.117.0");
    expect(out["x-github-api-version"]).toBe("2025-10-01");
  });

  it("OUTBOUND_DROP_HEADERS contains the documented set verbatim (regression guard)", () => {
    const expected = new Set([
      "content-length",
      "content-encoding",
      "transfer-encoding",
      "connection",
      "keep-alive",
      "te",
      "trailer",
      "upgrade",
      "host",
      "proxy-authenticate",
      "proxy-authorization",
    ]);
    expect(OUTBOUND_DROP_HEADERS.size).toBe(expected.size);
    for (const k of expected) {
      expect(OUTBOUND_DROP_HEADERS.has(k)).toBe(true);
    }
  });

  it("returns empty object for empty input", () => {
    expect(dropOutboundHopHeaders({})).toEqual({});
  });
});
