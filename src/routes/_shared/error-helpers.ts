/**
 * error-helpers.ts — Hono-coupled route-layer error mapping.
 *
 * Per design.md M4 + discriminator H7: M5 owns the route-layer error
 * mapping. This module is the single source of truth for status mapping;
 * route handlers `try { ... } catch (err) { return forwardError(c, err); }`.
 *
 * **Status mapping contract (discriminator M-status-mapping; supersedes the
 * stale `lib/error.ts:54-56` commentary, which is also updated to match):**
 *
 *   | Error class                  | HTTP status | Notes                              |
 *   |------------------------------|-------------|-----------------------------------|
 *   | TokenManagerDisposedError    | 503         | + Connection: close. Shutting down|
 *   | TokenRefreshExhaustedError   | 503         | UNIFIED across /health + upstream |
 *   | HTTPError (upstream non-OK)  | forward     | preserve content-type, x-request-id, retry-after |
 *   | EngineAbort500Error          | 500         | engine-rule abort_with_500        |
 *   | EngineAbort502Error          | 502         | engine-rule abort_with_502        |
 *   | UnregisteredRuleError        | 500         | config-error class                |
 *   | RuleSchemaInvalidError       | 500         | defense-in-depth (engine wraps)   |
 *   | unknown                      | 500         | log + generic message             |
 *
 * Hono-coupled (uses `Context`). Imports error classes from `~/lib/error.ts`
 * + `~/lib/transform/apply.ts`.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { consola } from "consola";

import {
  HTTPError,
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "~/lib/error.ts";
import {
  EngineAbort500Error,
  EngineAbort502Error,
  RuleSchemaInvalidError,
  UnregisteredRuleError,
} from "~/lib/transform/apply.ts";
import { DEFAULT_BETA_DENY } from "~/types/config-schema.ts";

/**
 * Stringify an arbitrary non-Error thrown value without EVER throwing. Plain
 * `String(x)` is NOT total: `String(Object.create(null))` throws a TypeError
 * ("Cannot convert object to primitive value" — a null-prototype object has no
 * `toString`/`valueOf`), and an object whose `toString`/`Symbol.toPrimitive`
 * itself throws propagates that throw. In the mid-stream error path this crashes
 * the stream callback with NO terminal frame emitted — the exact silent
 * truncation this module exists to prevent. Fallback chain (each guarded):
 * `String(err)` → `Object.prototype.toString.call(err)` (the built-in, which
 * does NOT invoke the value's own `toString`) → the literal
 * `"[unstringifiable value]"`.
 */
export function safeStringify(err: unknown): string {
  try {
    return String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "[unstringifiable value]";
    }
  }
}

/** Format an error and its (undici) `.cause` chain into one diagnostic line.
 *  TOTAL — never throws for any input (see `safeStringify`). */
export function formatErrorChain(err: unknown): string {
  try {
    // C1/F1 — the `instanceof Error` probe MUST live INSIDE the try. A thrown
    // value that is a `Proxy` with a throwing `getPrototypeOf` trap (or a
    // revoked `Proxy.revocable`) makes `instanceof` ITSELF throw; pre-fix that
    // throw escaped `formatErrorChain` and crashed the terminal-error path
    // (the verbatim/translated catches throw while building their log →
    // NO SSE error frame written = the exact silent truncation this module
    // exists to prevent). Guarding the whole body — the `instanceof` probe AND
    // the `.cause instanceof Error` probe — makes it total for ANY input.
    if (!(err instanceof Error)) return safeStringify(err);
    let s = `${err.name}: ${err.message}`;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      const syscall = (cause as { syscall?: string }).syscall;
      s += ` — cause: ${code ? code + ": " : ""}${cause.message}`;
      if (syscall) s += ` (syscall=${syscall})`;
    } else if (cause !== undefined && cause !== null) {
      s += ` — cause: ${safeStringify(cause)}`;
    }
    return s;
  } catch {
    // A throwing `instanceof` (hostile/revoked Proxy) OR a throwing
    // `name`/`message`/`cause` getter on the Error itself falls back to the
    // total `safeStringify(err)`, so the "never throws for any input" contract
    // holds. `safeStringify` is itself total (guards `String`,
    // `Object.prototype.toString`, and the final literal), so even a hostile
    // Proxy cannot make the fallback throw.
    return safeStringify(err);
  }
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const CONN_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
  "UND_ERR_ABORTED",
]);
/** HTTP statuses that MUST NOT carry a response body (RFC 9110 §6.4.1 +
 *  §15.4.5): 1xx informational, 204 No Content, 205 Reset Content, 304 Not
 *  Modified. For an empty upstream body at one of these statuses, forward a
 *  bodyless response instead of synthesizing a JSON error body — a synthesized
 *  body here violates the spec and wedges strict HTTP clients (M2). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Classify an upstream fetch failure → diagnostic status + type + full-cause
 *  message. `null` = not a transport error (caller keeps 500). */
export function describeFetchError(
  err: unknown,
): { status: 502 | 504 | 499; type: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const name = err.name;
  // H2 provenance gate (F3): classify as a transport error ONLY when the error
  // actually originated at the upstream-fetch boundary. undici surfaces a
  // genuine transport failure as a `TypeError: fetch failed` (the real socket/
  // TLS/undici-timeout error on `.cause`); the wall-clock deadline
  // (`AbortSignal.timeout()` in _retry.ts) throws a bare `TimeoutError`; a
  // client disconnect aborts the composed signal with a bare `AbortError`.
  // An INTERNAL proxy bug — a `new Error(msg, { cause })` that merely CARRIES a
  // transport-ish cause, or an Error whose message happens to mention
  // "tls"/"ssl"/"certificate" — is NOT a transport failure and MUST fall
  // through to null so the caller keeps the generic 500. Without this gate the
  // `.cause.name` and TLS-message checks below would mislabel such internal
  // errors as 499/504/502 despite never touching the fetch boundary.
  const looksFetchFailed =
    name === "TypeError" && /fetch failed/i.test(err.message);
  if (!(looksFetchFailed || name === "TimeoutError" || name === "AbortError")) {
    return null;
  }
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  const code = cause?.code;
  const causeName = cause?.name;
  const message = formatErrorChain(err);
  // Timeout + abort are checked FIRST (and BEFORE the CONN_CODES/tls→502
  // branch) so a `.cause.name` of TimeoutError/AbortError wins over a code
  // that also appears in CONN_CODES. NOTE: `UND_ERR_ABORTED` lives in
  // CONN_CODES (→502) but undici sets its `.cause.name` to `AbortError`;
  // the name check now runs first, so such aborts reclassify to 499. That is
  // intended — an abort is a client-close/deadline, not a bad gateway.
  if (
    name === "TimeoutError" ||
    causeName === "TimeoutError" ||
    (code !== undefined && TIMEOUT_CODES.has(code))
  ) {
    return { status: 504, type: "upstream_timeout", message };
  }
  if (name === "AbortError" || causeName === "AbortError") {
    return { status: 499, type: "client_closed_request", message };
  }
  const tlsish =
    (code !== undefined && /^(ERR_TLS|CERT_|ERR_SSL)/.test(code)) ||
    /certificate|tls|ssl/i.test(err.message);
  if (
    looksFetchFailed ||
    (code !== undefined && CONN_CODES.has(code)) ||
    tlsish
  ) {
    return { status: 502, type: "upstream_unreachable", message };
  }
  // Type-totality fallback. The provenance gate above already returns null for
  // any non-fetch-boundary error, and every error that passes the gate resolves
  // to a status in one of the three branches above (a gated `TypeError: fetch
  // failed` always satisfies the 502 branch's `looksFetchFailed` disjunct; a
  // bare TimeoutError/AbortError is caught by the 504/499 branch). Kept so the
  // function stays total for the type-checker.
  return null;
}

/**
 * Read an upstream Response body safely without crashing on `bodyUsed` or
 * null body. Returns the raw text (caller decides JSON-parse vs forward
 * verbatim). If `response.body` is null OR already consumed, returns "".
 */
export async function safeReadBody(response: Response): Promise<string> {
  if (response.body === null || response.bodyUsed) return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Forward selected upstream headers to the client response. Whitelist:
 *   - content-type (preserve type for JSON vs SSE vs plaintext)
 *   - x-request-id (cross-system correlation)
 *   - retry-after (rate-limit signaling)
 * Skips hop-by-hop headers (connection, transfer-encoding, etc.) by
 * NOT including them in the allowlist.
 */
export function forwardUpstreamHeaders(c: Context, upstream: Response): void {
  const allowlist = ["content-type", "x-request-id", "retry-after"];
  for (const name of allowlist) {
    const value = upstream.headers.get(name);
    if (value !== null) c.header(name, value);
  }
}

/**
 * Forward a successful upstream Response (status + headers + body) to the
 * client. Used by route handlers when the upstream returned 2xx (or any
 * non-error response).
 *
 * For SSE streams (content-type: text/event-stream): caller should detect
 * via `~/routes/_shared/streaming.ts` § isStreamingResponse and use the
 * chosen Hono streaming pattern (D-LOCK-6: streamSSE) — this helper is for
 * non-streaming responses only.
 */
export function forwardUpstreamResponse(
  c: Context,
  upstream: Response,
): Response {
  forwardUpstreamHeaders(c, upstream);
  const status = upstream.status as StatusCode;
  // Hono's c.body has split overloads (Data vs literal null); using
  // c.newResponse here because it takes `Data | null` directly, which is
  // exactly what `Response.body` is. Hono pipes ReadableStream natively.
  return c.newResponse(upstream.body, status);
}

/**
 * Build a human-readable, operator-facing description of an upstream error
 * response for logging. Extracts the upstream error message from common JSON
 * shapes (`{error:{message}}` | `{error:"..."}` | `{message}`) and, for known
 * actionable failures, appends a concrete remediation hint.
 *
 * Returns `{ summary, hint }` — `hint` is `undefined` when no specific
 * remediation is known. Pure (no I/O); safe to call regardless of log level.
 */
export function describeUpstreamError(body: string): {
  summary: string;
  hint?: string;
} {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "object" && parsed.error?.message) {
        message = parsed.error.message;
      } else if (typeof parsed.error === "string") {
        message = parsed.error;
      } else if (typeof parsed.message === "string") {
        message = parsed.message;
      }
    }
  } catch {
    // Body wasn't JSON — keep the raw text (may be empty for a consumed
    // stream body, handled below).
  }
  if (message.length === 0) message = "(empty upstream body)";

  let hint: string | undefined;
  // GitHub Copilot upstream rejects unknown anthropic-beta tokens with
  // "unsupported beta header(s): <token[, token...]>". The DURABLE fix is to
  // add the token(s) to the top-level anthropic_beta.deny list — NOT a per-route
  // header rule: applyBetaPolicy rebuilds the beta lanes' anthropic-beta rules
  // from anthropic_beta.deny at every boot, so a hand-added per-route strip rule
  // is wiped on the next restart and the 400s return.
  const betaMatch = /unsupported beta header\(s\):\s*(.+?)\s*$/i.exec(message);
  if (betaMatch) {
    // Parsed rejected token(s): split on commas, strip surrounding quotes/
    // whitespace (and a trailing dot) per token, so the rendered `deny: [...]`
    // YAML sequence stays valid even if the upstream ever quotes the names.
    const parsedTokens = (betaMatch[1] ?? "")
      .split(",")
      .map((t) => t.replace(/^["'\s]+|["'\s.]+$/g, "").trim())
      .filter((t) => t.length > 0);
    const tokens = parsedTokens.join(", ");
    // Render the deny snippet as the UNION of the built-in DEFAULT deny tokens +
    // the newly-rejected tokens (defaults first, deduped, order-stable). Pasting
    // `deny: [<only the new tokens>]` would REPLACE the schema default and
    // silently un-deny the built-ins (e.g. advisor-tool-2026-03-01) → new outage.
    const denyUnion = [
      ...DEFAULT_BETA_DENY,
      ...parsedTokens.filter((t) => !DEFAULT_BETA_DENY.includes(t)),
    ];
    hint =
      `upstream rejected anthropic-beta token(s): ${tokens}. Durable fix: add ` +
      `the token(s) to your top-level anthropic_beta.deny list in config.yaml, ` +
      `then restart (the snippet below already includes the built-in defaults — ` +
      `keep any custom entries you have added):\n` +
      `  anthropic_beta:\n` +
      `    deny: [${denyUnion.join(", ")}]\n` +
      `Instant no-edit escape hatch, GUARANTEED to stop the outage no matter ` +
      `which token upstream revoked: relaunch with strip_all (drops the ` +
      `anthropic-beta header entirely) — start_proxy.ps1 -BetaPolicy strip_all ` +
      `(or env COPILOT_PROXY_BETA_POLICY=strip_all). Situational alternative: ` +
      `-BetaPolicy allowlist restores the known-good allowlist posture, but only ` +
      `stops the outage if the rejected token is NOT itself in allow/merge_append.`;
  } else if (/unsupported header/i.test(message)) {
    hint =
      `upstream rejected a request header. Add a per-route header rule ` +
      `(use: strip_header_csv_token, deny: [<token>]) to config.yaml to strip ` +
      `the offending header before forwarding.`;
  }
  return { summary: message, hint };
}

/**
 * Map an error to a Hono Response. The single source of truth for status
 * mapping per the table at the top of this file.
 *
 * NOT to be called for upstream success responses — those are forwarded
 * directly via `forwardUpstreamResponse`, which handles status + headers
 * + body.
 */
export async function forwardError(
  c: Context,
  err: unknown,
): Promise<Response> {
  if (err instanceof TokenManagerDisposedError) {
    c.header("Connection", "close");
    return c.json(
      {
        error: {
          type: "service_unavailable",
          message: "Proxy is shutting down",
        },
      },
      503,
    );
  }
  if (err instanceof TokenRefreshExhaustedError) {
    return c.json(
      { error: { type: "service_unavailable", message: err.message } },
      503,
    );
  }
  if (err instanceof HTTPError) {
    // Forward upstream status (any 4xx/5xx) + body + selected headers.
    forwardUpstreamHeaders(c, err.response);
    const body = await safeReadBody(err.response);
    const status = err.response.status as StatusCode;
    if (body.length === 0) {
      if (NULL_BODY_STATUSES.has(err.response.status)) {
        // M2: body-forbidden status (1xx/204/205/304) — forward a bodyless
        // response (upstream headers already forwarded above). Synthesizing a
        // JSON body here would be spec-violating and can wedge strict clients.
        return c.newResponse(null, status as StatusCode);
      }
      c.header("content-type", "application/json");
      const synthesized = JSON.stringify({
        error: {
          type: "upstream_error",
          message: `upstream returned ${err.response.status}${err.response.statusText ? " " + err.response.statusText : ""} with an empty body`,
        },
      });
      return c.body(synthesized, status as ContentfulStatusCode);
    }
    // #7a/#7c: surface the upstream failure in the proxy log. Emitted via
    // consola.error so it shows regardless of the proxy debug-level system
    // (which gates only debug.on/consola.debug). Previously the body was
    // forwarded verbatim with NOTHING logged, so an upstream 400 (e.g.
    // "unsupported beta header(s): ...") reached the client as an opaque
    // "API Error" and left no trace of the cause or the fix in the log.
    const { summary, hint } = describeUpstreamError(body);
    // Cap only the LOGGED summary (not the forwarded body) so a large HTML or
    // binary upstream error page can't flood the console.
    const loggedSummary =
      summary.length > 8192
        ? `${summary.slice(0, 8192)}… (truncated)`
        : summary;
    consola.error(
      `upstream ${err.response.status}: ${loggedSummary}` +
        (hint ? `\n  remediation: ${hint}` : ""),
    );
    return c.body(body, status as ContentfulStatusCode);
  }
  if (err instanceof EngineAbort500Error) {
    return c.json(
      { error: { type: "internal_error", message: err.message } },
      500,
    );
  }
  if (err instanceof EngineAbort502Error) {
    return c.json(
      { error: { type: "bad_gateway", message: err.message } },
      502,
    );
  }
  if (err instanceof UnregisteredRuleError) {
    return c.json(
      { error: { type: "config_error", message: err.message } },
      500,
    );
  }
  if (err instanceof RuleSchemaInvalidError) {
    return c.json(
      { error: { type: "config_error", message: err.message } },
      500,
    );
  }
  // Network / timeout / abort from the upstream fetch: surface the real cause
  // + a diagnostic status instead of an opaque "fetch failed" 500 — so the
  // harness (and operator log) can tell network vs throttle vs timeout.
  const fetchErr = describeFetchError(err);
  if (fetchErr !== null) {
    consola.error(`upstream fetch failure: ${fetchErr.message}`);
    return c.json(
      { error: { type: fetchErr.type, message: fetchErr.message } },
      fetchErr.status as ContentfulStatusCode,
    );
  }
  // Genuine internal error (proxy bug) — keep the generic 500.
  consola.error(`internal error: ${formatErrorChain(err)}`);
  return c.json(
    {
      error: {
        type: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      },
    },
    500,
  );
}
