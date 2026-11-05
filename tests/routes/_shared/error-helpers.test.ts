/**
 * error-helpers.test.ts — status-mapping verification.
 *
 * Coverage (≥10 cases per spec):
 *   - TokenManagerDisposedError → 503 + Connection: close
 *   - TokenRefreshExhaustedError → 503
 *   - HTTPError forwards upstream status (401, 403, 429, 500)
 *   - HTTPError forwards whitelist headers (content-type, x-request-id, retry-after)
 *   - EngineAbort500Error → 500
 *   - EngineAbort502Error → 502
 *   - UnregisteredRuleError → 500
 *   - RuleSchemaInvalidError → 500
 *   - Unknown Error → 500 with message preserved
 *   - Non-Error throw → 500 with String(value)
 *   - safeReadBody handles null body
 *   - safeReadBody handles bodyUsed
 *   - forwardUpstreamHeaders only forwards whitelist
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import {
  HTTPError,
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "../../../src/lib/error.ts";
import {
  EngineAbort500Error,
  EngineAbort502Error,
  RuleSchemaInvalidError,
  UnregisteredRuleError,
} from "../../../src/lib/transform/apply.ts";
import {
  describeFetchError,
  describeUpstreamError,
  forwardError,
  formatErrorChain,
  forwardUpstreamHeaders,
  forwardUpstreamResponse,
  safeReadBody,
} from "../../../src/routes/_shared/error-helpers.ts";

async function runHandler(
  err: unknown,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const app = new Hono();
  app.get("/x", (c) => forwardError(c, err));
  const resp = await app.request("/x");
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = await resp.text().catch(() => "");
  }
  return { status: resp.status, body, headers: resp.headers };
}

describe("forwardError — status mapping contract", () => {
  it("TokenManagerDisposedError → 503 + Connection: close", async () => {
    const r = await runHandler(new TokenManagerDisposedError());
    expect(r.status).toBe(503);
    expect(r.headers.get("connection")).toBe("close");
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("service_unavailable");
  });

  it("TokenRefreshExhaustedError → 503", async () => {
    const r = await runHandler(
      new TokenRefreshExhaustedError(3, new Error("upstream 503")),
    );
    expect(r.status).toBe(503);
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("service_unavailable");
  });

  it("HTTPError 401 forwards upstream status", async () => {
    const upstream = new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const r = await runHandler(new HTTPError("upstream 401", upstream));
    expect(r.status).toBe(401);
  });

  it("HTTPError 429 forwards retry-after header", async () => {
    const upstream = new Response('{"error":"rate"}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "60" },
    });
    const r = await runHandler(new HTTPError("upstream 429", upstream));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });

  it("HTTPError 500 forwards upstream status", async () => {
    const upstream = new Response("oops", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const r = await runHandler(new HTTPError("upstream 500", upstream));
    expect(r.status).toBe(500);
  });

  it("EngineAbort500Error → 500 with internal_error type", async () => {
    const r = await runHandler(
      new EngineAbort500Error("rule_a", new Error("x")),
    );
    expect(r.status).toBe(500);
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("internal_error");
  });

  it("EngineAbort502Error → 502 with bad_gateway type", async () => {
    const r = await runHandler(
      new EngineAbort502Error("rule_b", new Error("x")),
    );
    expect(r.status).toBe(502);
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("bad_gateway");
  });

  it("UnregisteredRuleError → 500 with config_error type", async () => {
    const r = await runHandler(new UnregisteredRuleError("missing_rule"));
    expect(r.status).toBe(500);
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("config_error");
  });

  it("RuleSchemaInvalidError → 500 with config_error type", async () => {
    const r = await runHandler(
      new RuleSchemaInvalidError("rule_x", new Error("zod failed")),
    );
    expect(r.status).toBe(500);
    const body = r.body as { error: { type: string } };
    expect(body.error.type).toBe("config_error");
  });

  it("unknown Error → 500 with message preserved", async () => {
    const r = await runHandler(new Error("custom unknown"));
    expect(r.status).toBe(500);
    const body = r.body as { error: { type: string; message: string } };
    expect(body.error.type).toBe("internal_error");
    expect(body.error.message).toBe("custom unknown");
  });

  it("non-Error throw → 500 with String(value)", async () => {
    const r = await runHandler("plain string thrown");
    expect(r.status).toBe(500);
    const body = r.body as { error: { type: string; message: string } };
    expect(body.error.message).toBe("plain string thrown");
  });
});

describe("safeReadBody", () => {
  it("returns '' for null body", async () => {
    const resp = new Response(null);
    expect(await safeReadBody(resp)).toBe("");
  });
  it("returns '' for bodyUsed", async () => {
    const resp = new Response("x");
    await resp.text();
    expect(await safeReadBody(resp)).toBe("");
  });
  it("reads body text otherwise", async () => {
    const resp = new Response("hello world");
    expect(await safeReadBody(resp)).toBe("hello world");
  });
});

describe("forwardUpstreamHeaders + forwardUpstreamResponse", () => {
  it("forwardUpstreamHeaders forwards only the whitelist", async () => {
    const app = new Hono();
    app.get("/x", (c) => {
      const upstream = new Response("body", {
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-1",
          "retry-after": "5",
          "x-secret": "should-not-leak",
          "set-cookie": "should-not-leak",
        },
      });
      forwardUpstreamHeaders(c, upstream);
      // Use newResponse so we don't override the just-set headers (c.text sets
      // its own content-type which would clobber our forwarded content-type).
      return c.newResponse(null, 200);
    });
    const resp = await app.request("/x");
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("x-request-id")).toBe("req-1");
    expect(resp.headers.get("retry-after")).toBe("5");
    expect(resp.headers.get("x-secret")).toBeNull();
    expect(resp.headers.get("set-cookie")).toBeNull();
  });

  it("forwardUpstreamResponse forwards body + status", async () => {
    const app = new Hono();
    app.get("/x", (c) => {
      const upstream = new Response('{"hello":"world"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return forwardUpstreamResponse(c, upstream);
    });
    const resp = await app.request("/x");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ hello: "world" });
  });
});

describe("describeFetchError — upstream transport-error classification", () => {
  it("TimeoutError (name) → 504 / upstream_timeout", () => {
    const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const r = describeFetchError(err);
    expect(r?.status).toBe(504);
    expect(r?.type).toBe("upstream_timeout");
  });

  it("UND_ERR_HEADERS_TIMEOUT (cause.code) → 504 / upstream_timeout", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const r = describeFetchError(err);
    expect(r?.status).toBe(504);
    expect(r?.type).toBe("upstream_timeout");
  });

  it("ECONNRESET cause → 502 / upstream_unreachable; message carries code + syscall", () => {
    // Deviation from the spec's literal example: real undici fetch failures
    // set `.cause` to an Error INSTANCE that carries `.code`/`.syscall` as
    // own-properties (Node socket errors are Error instances). formatErrorChain
    // extracts code/syscall only when `cause instanceof Error`, so a faithful
    // test builds an Error cause here (a plain-object cause would classify as
    // 502 but stringify to "[object Object]", failing the code/syscall assert).
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const r = describeFetchError(err);
    expect(r?.status).toBe(502);
    expect(r?.type).toBe("upstream_unreachable");
    expect(r?.message).toContain("ECONNRESET");
    expect(r?.message).toContain("syscall=read");
  });

  it("AbortError (name) → 499 / client_closed_request", () => {
    const err = Object.assign(new Error("x"), { name: "AbortError" });
    const r = describeFetchError(err);
    expect(r?.status).toBe(499);
    expect(r?.type).toBe("client_closed_request");
  });

  it("TypeError 'fetch failed' with no cause → 502 / upstream_unreachable", () => {
    const r = describeFetchError(new TypeError("fetch failed"));
    expect(r?.status).toBe(502);
    expect(r?.type).toBe("upstream_unreachable");
  });

  it("genuine internal Error (no transport signal) → null (caller keeps 500)", () => {
    expect(describeFetchError(new Error("boom"))).toBeNull();
  });

  it("non-Error throw → null", () => {
    expect(describeFetchError("plain string")).toBeNull();
  });
});

describe("describeFetchError — H2 cause.name + internal-error passthrough", () => {
  it("internal Error carrying a cause (no transport signal) → null (caller keeps 500)", () => {
    // H2: a bare `new Error(msg, { cause })` — e.g. an internal proxy bug that
    // wraps another error — MUST fall through to null, NOT be mislabeled 502
    // by a cause-only catch-all. This is the case the removed catch-all broke.
    const err = new Error("boom", { cause: new Error("internal") });
    expect(describeFetchError(err)).toBeNull();
  });

  it("cause.name = TimeoutError → 504 (wins over the fetch-failed 502 branch)", () => {
    const cause = Object.assign(new Error("upstream timed out"), {
      name: "TimeoutError",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const r = describeFetchError(err);
    expect(r?.status).toBe(504);
    expect(r?.type).toBe("upstream_timeout");
  });

  it("cause.name = AbortError → 499 (wins over the fetch-failed 502 branch)", () => {
    // The outer TypeError "fetch failed" would match the 502 branch, but the
    // abort name-check runs FIRST → 499. Intended reclassification per H2.
    const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const r = describeFetchError(err);
    expect(r?.status).toBe(499);
    expect(r?.type).toBe("client_closed_request");
  });

  it("cause.code = ECONNRESET → 502 (H2 leaves the 502 branch intact)", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const r = describeFetchError(err);
    expect(r?.status).toBe(502);
    expect(r?.type).toBe("upstream_unreachable");
  });
});

describe("describeFetchError — F3 provenance gate", () => {
  // F3: transport classification must prove the error came from the upstream-
  // fetch boundary. An INTERNAL `new Error(msg, { cause })` that merely CARRIES
  // a transport-ish cause, or an Error whose message mentions tls/ssl, is a
  // proxy bug — it MUST fall through to null (caller keeps the generic 500),
  // NOT be reclassified as 499/504/502. Without the gate the `.cause.name` and
  // TLS-message checks reclassify these; each case below fails pre-gate.
  it("internal Error carrying an AbortError cause → null (NOT 499)", () => {
    const err = new Error("x", {
      cause: Object.assign(new Error("a"), { name: "AbortError" }),
    });
    expect(describeFetchError(err)).toBeNull();
  });

  it("internal Error carrying a TimeoutError cause → null (NOT 504)", () => {
    const err = new Error("x", {
      cause: Object.assign(new Error("t"), { name: "TimeoutError" }),
    });
    expect(describeFetchError(err)).toBeNull();
  });

  it("internal Error whose message mentions tls (no fetch-failed outer) → null (NOT 502)", () => {
    expect(describeFetchError(new Error("handshake tls failure"))).toBeNull();
  });

  // Provenance-POSITIVE regressions: genuine fetch-boundary errors must still
  // classify exactly as before — the gate must not over-reject.
  it("REGRESSION: TypeError 'fetch failed' + cause.name=TimeoutError → 504", () => {
    const cause = Object.assign(new Error("upstream timed out"), {
      name: "TimeoutError",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(describeFetchError(err)?.status).toBe(504);
  });

  it("REGRESSION: TypeError 'fetch failed' + cause.name=AbortError → 499", () => {
    const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(describeFetchError(err)?.status).toBe(499);
  });

  it("REGRESSION: TypeError 'fetch failed' + cause.code=ECONNRESET → 502", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(describeFetchError(err)?.status).toBe(502);
  });

  it("REGRESSION: bare outer TimeoutError (own-name provenance) → 504", () => {
    const err = Object.assign(new Error("deadline"), { name: "TimeoutError" });
    expect(describeFetchError(err)?.status).toBe(504);
  });

  it("REGRESSION: bare outer AbortError (own-name provenance) → 499", () => {
    const err = Object.assign(new Error("client closed"), {
      name: "AbortError",
    });
    expect(describeFetchError(err)?.status).toBe(499);
  });
});

describe("formatErrorChain — cause-chain formatting", () => {
  it("includes cause code + syscall when cause is an Error carrying them", () => {
    const cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
      {
        code: "ECONNREFUSED",
        syscall: "connect",
      },
    );
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const out = formatErrorChain(err);
    expect(out).toContain("TypeError: fetch failed");
    expect(out).toContain("ECONNREFUSED");
    expect(out).toContain("syscall=connect");
  });

  it("plain Error with no cause → 'name: message'", () => {
    expect(formatErrorChain(new Error("boom"))).toBe("Error: boom");
  });

  it("non-Error value → String(value)", () => {
    expect(formatErrorChain("just a string")).toBe("just a string");
  });
});

describe("forwardError — empty upstream body (A4 harden)", () => {
  it("HTTPError with an empty upstream body → synthesized upstream_error JSON (not empty)", async () => {
    const upstream = new Response(null, {
      status: 502,
      statusText: "Bad Gateway",
    });
    const r = await runHandler(new HTTPError("upstream 502", upstream));
    expect(r.status).toBe(502);
    const body = r.body as { error: { type: string; message: string } };
    // Body must be the synthesized JSON — not an empty passthrough.
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("502");
    expect(body.error.message).toContain("empty body");
    expect(r.headers.get("content-type")).toContain("application/json");
  });

  it("HTTPError 304 with an empty body → 304 null body, not a synthesized body (M2)", async () => {
    // 304 is a body-forbidden status (RFC 9110). M2: an empty upstream body at
    // such a status must forward a BODYLESS response — NOT the synthesized
    // upstream_error JSON, and NOT a 500. runHandler's json() fails on the
    // empty body then falls back to text() → "".
    const upstream = new Response(null, {
      status: 304,
      statusText: "Not Modified",
    });
    const r = await runHandler(new HTTPError("upstream 304", upstream));
    expect(r.status).toBe(304);
    expect(r.body).toBe("");
  });
});

// ---------------------------------------------------------------------------
// F1 (remediation) — `formatErrorChain` must be TOTAL: it can NEVER throw for
// ANY input. A bare `String(x)` is not total — `String(Object.create(null))`
// throws a TypeError, as does an object whose `toString`/`Symbol.toPrimitive`
// throws. In the mid-stream error path a throw here crashes the stream callback
// with no terminal frame emitted (a silent truncation — the exact failure this
// effort prevents).
// ---------------------------------------------------------------------------

describe("formatErrorChain — totality (F1)", () => {
  it("null-prototype object → returns a string, does not throw", () => {
    const nullProto = Object.create(null) as unknown;
    let out = "";
    expect(() => {
      out = formatErrorChain(nullProto);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("symbol → returns a string, does not throw", () => {
    let out = "";
    expect(() => {
      out = formatErrorChain(Symbol("boom"));
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out).toContain("boom");
  });

  it("bigint → returns a string, does not throw", () => {
    expect(formatErrorChain(42n)).toBe("42");
  });

  it("object whose toString throws → returns a string, does not throw", () => {
    const hostile = {
      toString(): string {
        throw new Error("toString blew up");
      },
    };
    let out = "";
    expect(() => {
      out = formatErrorChain(hostile);
    }).not.toThrow();
    // Falls back to the built-in Object.prototype.toString ("[object Object]"),
    // which does NOT invoke the value's own throwing toString.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("Error whose non-Error cause is a null-prototype object → does not throw", () => {
    const err = new Error("outer", { cause: Object.create(null) as unknown });
    let out = "";
    expect(() => {
      out = formatErrorChain(err);
    }).not.toThrow();
    expect(out).toContain("Error: outer");
  });

  // C1 (remediation) — the `instanceof Error` branch itself must be total. An
  // Error whose `name`/`message`/`cause` getter throws would re-throw straight
  // out of `formatErrorChain` (pre-C1 the Error branch was unguarded), crashing
  // the stream callback with no terminal frame emitted. The branch is now
  // wrapped in try/catch that falls back to `safeStringify(err)`.
  it("Error whose message getter throws → returns a string, does not throw", () => {
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      get(): string {
        throw new Error("message getter blew up");
      },
    });
    let out = "";
    expect(() => {
      out = formatErrorChain(hostile);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("Error whose name getter throws → returns a string, does not throw", () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "name", {
      get(): string {
        throw new Error("name getter blew up");
      },
    });
    let out = "";
    expect(() => {
      out = formatErrorChain(hostile);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("Error whose cause getter throws → returns a string, does not throw", () => {
    const hostile = new Error("outer");
    Object.defineProperty(hostile, "cause", {
      get(): unknown {
        throw new Error("cause getter blew up");
      },
    });
    let out = "";
    expect(() => {
      out = formatErrorChain(hostile);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  // C1 (remediation, iter6/F1) — the `instanceof Error` PROBE itself must be
  // total. A hostile `Proxy` whose `getPrototypeOf`/`get` trap throws makes
  // `err instanceof Error` THROW; pre-F1 that probe sat OUTSIDE the try, so the
  // throw escaped `formatErrorChain` and crashed the terminal-error path with no
  // SSE frame written. The probe now lives inside the try → falls back to the
  // total `safeStringify`.
  it("Proxy whose getPrototypeOf trap throws → returns a string, does not throw", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error("getPrototypeOf blew up");
        },
        get(): never {
          throw new Error("get trap blew up");
        },
      },
    ) as unknown;
    let out = "";
    expect(() => {
      out = formatErrorChain(hostile);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("revoked Proxy → returns a string, does not throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke(); // every trap (incl. the `instanceof` GetPrototypeOf) now throws
    let out = "";
    expect(() => {
      out = formatErrorChain(proxy as unknown);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("Error whose cause is a throwing Proxy → returns a string, does not throw", () => {
    const hostileCause = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error("cause getPrototypeOf blew up");
        },
      },
    );
    const err = new Error("outer", { cause: hostileCause as unknown });
    let out = "";
    expect(() => {
      out = formatErrorChain(err);
    }).not.toThrow();
    // The `cause instanceof Error` probe throws on the hostile Proxy; the whole
    // body is guarded, so it falls back to `safeStringify(err)` — still a string.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// describeUpstreamError — the self-diagnosis behind the anthropic-beta denylist
// loud-fail (Feature D1/D3). On an upstream 400 "unsupported beta header(s):
// <token[, token...]>", the hint must render a copy-paste `deny: [<tokens>]`
// YAML fix so the operator can strip the offending token(s). These cases
// regression-guard the token extraction (single / multi / quoted / plaintext).
// ---------------------------------------------------------------------------

describe("describeUpstreamError — anthropic-beta rejection remediation hint", () => {
  it("single token (JSON {error:{message}}) → hint points at anthropic_beta.deny + escape hatch", () => {
    const body = JSON.stringify({
      error: {
        message: "unsupported beta header(s): foo-2099-01-01",
      },
    });
    const { summary, hint } = describeUpstreamError(body);
    expect(summary).toBe("unsupported beta header(s): foo-2099-01-01");
    expect(hint).toBeDefined();
    // Durable fix: the deny snippet is the UNION of the built-in defaults +
    // the newly-rejected token (pasting new-tokens-only would REPLACE the
    // schema default and silently un-deny advisor-tool-2026-03-01).
    expect(hint).toContain("deny: [advisor-tool-2026-03-01, foo-2099-01-01]");
    expect(hint).toContain("anthropic_beta");
    // Escape hatches: strip_all is the GUARANTEED universal no-edit hatch;
    // allowlist is the situational one. Both are surfaced via -BetaPolicy /
    // COPILOT_PROXY_BETA_POLICY.
    expect(hint).toContain("strip_all");
    expect(hint).toContain("-BetaPolicy allowlist");
    expect(hint).toContain("COPILOT_PROXY_BETA_POLICY");
    // The stale per-route strip recipe is gone from the beta branch — it would
    // be wiped by applyBetaPolicy on the next restart.
    expect(hint).not.toContain("strip_header_csv_token");
  });

  it("multiple tokens → hint lists all in one deny: [...] sequence", () => {
    const body = JSON.stringify({
      error: {
        message:
          "unsupported beta header(s): advisor-tool-2026-03-01, some-other-2099-12-31",
      },
    });
    const { hint } = describeUpstreamError(body);
    expect(hint).toContain(
      "deny: [advisor-tool-2026-03-01, some-other-2099-12-31]",
    );
  });

  it("quoted token(s) → surrounding quotes stripped in deny: [...]", () => {
    // Guard against a future upstream that quotes the token names.
    const body = JSON.stringify({
      error: { message: 'unsupported beta header(s): "quoted-2099-01-01"' },
    });
    const { hint } = describeUpstreamError(body);
    expect(hint).toContain(
      "deny: [advisor-tool-2026-03-01, quoted-2099-01-01]",
    );
    expect(hint).not.toContain('"quoted-2099-01-01"');
  });

  it("quoted multi-token → each quote/space stripped, comma-joined", () => {
    const body = JSON.stringify({
      error: { message: 'unsupported beta header(s): "a-1-2099", "b-2-2099"' },
    });
    const { hint } = describeUpstreamError(body);
    expect(hint).toContain(
      "deny: [advisor-tool-2026-03-01, a-1-2099, b-2-2099]",
    );
  });

  it("plain-text (non-JSON) upstream body still matches + builds the hint", () => {
    const { summary, hint } = describeUpstreamError(
      "unsupported beta header(s): plaintext-2099-01-01",
    );
    expect(summary).toBe("unsupported beta header(s): plaintext-2099-01-01");
    expect(hint).toContain(
      "deny: [advisor-tool-2026-03-01, plaintext-2099-01-01]",
    );
  });

  it("case-insensitive match on the upstream phrase", () => {
    const { hint } = describeUpstreamError(
      "Unsupported Beta Header(s): mixed-case-2099",
    );
    expect(hint).toContain("deny: [advisor-tool-2026-03-01, mixed-case-2099]");
  });

  it("non-beta upstream error → no beta remediation hint", () => {
    const body = JSON.stringify({
      error: { message: "invalid request: model not found" },
    });
    const { summary, hint } = describeUpstreamError(body);
    expect(summary).toBe("invalid request: model not found");
    // Not a beta rejection and not an "unsupported header" → no hint at all.
    expect(hint).toBeUndefined();
  });
});
