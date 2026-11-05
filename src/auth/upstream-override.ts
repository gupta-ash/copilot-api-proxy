/**
 * upstream-override.ts — parse the `COPILOT_PROXY_UPSTREAM_BASE_URL` escape hatch.
 *
 * WHY THIS EXISTS. The Copilot upstream host is derived from `account_type` in
 * `api-config.ts` and has no config input (F164). A gate-1 harness that wants to
 * drive a deterministic LOCAL upstream — the Arm B keep-alive experiment is the
 * immediate consumer — therefore has no sanctioned way to repoint the proxy, and
 * the alternative is a hand-patched throwaway build, which is NOT the build being
 * shipped. That gap is exactly what let F159 survive five gate rounds.
 *
 * WHY IT IS A PURE FUNCTION OVER `raw`, and this is the load-bearing shape:
 * it takes the value as an ARGUMENT and never reads `process.env` itself. A
 * function that reaches for the environment internally can only be exercised by
 * mutating the environment of the running test process, which in Bun is shared
 * across the whole file. Taking `raw` makes every case below an ordinary
 * in-process unit test with no environment mutation at all.
 *
 * THE `ok` VARIANT CARRIES `u.origin`, NOT `raw`, AND THAT IS A SAFETY PROPERTY
 * RATHER THAN A CONVENIENCE (F203). WHATWG `URL.origin` is scheme + host + port
 * and EXCLUDES userinfo, so a value that reaches a consumer can never carry a
 * username or password even if the credentials guard below were deleted. The
 * `error` variant carries `safeValue` — a description BUILT FROM PARSED
 * COMPONENTS (see `safeDescribe`), never a filtered copy of the operator's
 * input. **The guarantee is SCOPED, not absolute** (see `safeDescribe`'s own
 * docblock): userinfo, path, query and fragment cannot survive, while the
 * scheme and host DO. **It is for DIAGNOSTICS ONLY and must never be
 * composed into a URL.** `copilotBaseUrl` reads `.baseUrl`; nothing reads
 * `.safeValue`, and `upstream-override.test.ts` pins both halves.
 *
 * Single-user, localhost-scoped tool (C-2): this is an operator affordance, not
 * an attack surface. It is loud by design — see `main.ts`, which refuses to boot
 * on a malformed value and announces a live override at WARN.
 */

/** The operator-facing environment variable. The NAME is the interface. */
export const UPSTREAM_OVERRIDE_ENV = "COPILOT_PROXY_UPSTREAM_BASE_URL";

export type UpstreamOverride =
  | { kind: "unset" }
  | { kind: "ok"; baseUrl: string }
  | { kind: "error"; reason: string; safeValue: string };

/**
 * Describe an operator-supplied value safely enough to put in a log line.
 *
 * WHY THIS IS A CONSTRUCTION AND NOT A REDACTION, which is the whole point.
 * The first version of this function took the raw string and stripped userinfo,
 * query and fragment with regexes. The cross-family gate refuted it and three
 * concrete leaks were then MEASURED, not argued:
 *
 *   http://first@name:hunter2@127.0.0.1   ->  http://***@name:hunter2@127.0.0.1
 *   http://127.0.0.1/?a=1 token=SECRET    ->  http://127.0.0.1/?*** token=SECRET
 *   http://127.0.0.1/# SECRET             ->  http://127.0.0.1/#*** SECRET
 *
 * The first is the killer: WHATWG URL treats the LAST `@` in the authority as
 * the host separator while the regex stopped at the FIRST, so a password
 * survived on a value that `new URL()` happily parses and that therefore reaches
 * this function through the `credentials` branch. The other two are the same
 * shape one level down — the regexes terminated at whitespace, which URL parsing
 * percent-encodes rather than rejects.
 *
 * A filter has to anticipate every construct that can carry a secret. A
 * construction only ever emits fields it chose in advance, which is the same
 * move as the `ok` variant returning `u.origin` instead of the raw string:
 * prefer a PROPERTY over a judgement about which inputs are dangerous.
 *
 * ⚠ THE CONTRACT IS SCOPED AND THE SCOPE IS THE HONEST PART. Round 3 of the
 * cross-family gate refuted the absolute form this comment used to claim
 * ("nothing operator-typed is copied except the host" — which contradicted the
 * very next sentence, and omitted the scheme besides). What is guaranteed:
 *
 *   EXCLUDED BY CONSTRUCTION — userinfo, path, query, fragment. These are where
 *     a secret realistically lands, and none of them can survive.
 *   COPIED THROUGH — the scheme and the host. `hunter2://example.invalid`
 *     parses (non-special schemes are legal), reaches the protocol branch, and
 *     both this function AND the `unsupported protocol "…"` reason echo
 *     `hunter2:`. A host is echoed the same way.
 *
 * The scheme and host are kept deliberately: `reason` names the offending
 * construct but not the value, so without them the operator cannot tell WHICH
 * of several exported variables was rejected. Under C-2 the operator sets this
 * variable themselves and reads their own boot log, so echoing back the host
 * they typed is a diagnostic rather than a disclosure. The claim is scoped
 * rather than dropped because a scoped true claim beats an absolute false one.
 *
 * What survives into the log: the scheme, the host, and MARKERS naming which
 * offending constructs were present. The path is deliberately dropped with the
 * rest, because a path is operator-typed free text like any other.
 *
 * When `new URL()` itself threw there is no parse to build from, so nothing is
 * echoed at all beyond a length. Withholding beats guessing.
 *
 * TOTAL: it never throws and never parses. It is given an already-parsed `URL`
 * or nothing.
 */
export function safeDescribe(value: string, u?: URL): string {
  if (u === undefined) {
    return `(withheld — unparseable, ${value.length} chars)`;
  }
  const marks: string[] = [];
  if (u.username !== "" || u.password !== "") marks.push("credentials");
  if (u.pathname !== "/") marks.push("path");
  if (u.search !== "") marks.push("query");
  if (u.hash !== "") marks.push("fragment");
  const base = `${u.protocol}//${u.host}`;
  const out = marks.length > 0 ? `${base} [+${marks.join(" +")}]` : base;
  // A hostname is not free text, but bound it anyway — a boot log line should
  // never be unbounded regardless of where the bytes came from.
  return out.length > 200 ? out.slice(0, 200) + "…(truncated)" : out;
}

/**
 * Parse the override value.
 *
 * Accepts an absolute `http:` or `https:` origin with no path, query, fragment
 * or credentials. `http` is accepted as well as `https` deliberately: the
 * intended consumer is a loopback stub on `127.0.0.1`.
 *
 * Absent, empty and whitespace-only are all `unset` — a shell profile that
 * clears a variable produces the empty string, and treating that as an error
 * would refuse to boot on a perfectly ordinary environment.
 *
 * Each `error` reason carries a keyword the tests match on rather than the whole
 * sentence: `absolute`, `protocol`, `credentials`, `path`, `query`. The prose may
 * be reworded freely; the keyword may not.
 */
export function parseUpstreamOverride(
  raw: string | undefined,
): UpstreamOverride {
  if (raw === undefined || raw.trim() === "") return { kind: "unset" };
  const value = raw.trim();

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return {
      kind: "error",
      reason: "not an absolute http(s) URL",
      // No `u` — this is the branch where `new URL()` threw, so there is
      // nothing parsed to build a description from and nothing is echoed.
      safeValue: safeDescribe(value),
    };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      kind: "error",
      reason: `unsupported protocol "${u.protocol}"`,
      safeValue: safeDescribe(value, u),
    };
  }
  if (u.username !== "" || u.password !== "") {
    return {
      kind: "error",
      reason: "must not contain credentials",
      safeValue: safeDescribe(value, u),
    };
  }
  if (u.pathname !== "/") {
    return {
      kind: "error",
      reason: "must not contain a path",
      safeValue: safeDescribe(value, u),
    };
  }
  if (u.search !== "" || u.hash !== "") {
    return {
      kind: "error",
      reason: "must not contain a query or fragment",
      safeValue: safeDescribe(value, u),
    };
  }

  return { kind: "ok", baseUrl: u.origin };
}
