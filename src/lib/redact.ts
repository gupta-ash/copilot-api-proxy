/**
 * redact.ts — security-boundary module for removing secrets from headers + bodies
 * before they hit a trace file or any other persistent surface.
 *
 * **Routing rule (per spec anti-pattern):** All redaction MUST flow through one
 * of the two exported entry points (`redactHeaders`, `redactBody`). There is
 * intentionally NO general `redactString` export — callers should never have
 * to make ad-hoc decisions about what to redact. New patterns are added here.
 *
 * **What gets redacted:**
 *   - Headers (case-insensitive name match): a 9-name allowlist covering the
 *     usual auth surfaces (Authorization, X-Api-Key, Anthropic-Api-Key,
 *     X-Github-Token, Cookie, Set-Cookie, OpenAI-Organization, X-Goog-Api-Key,
 *     Proxy-Authorization).
 *   - IDE token sub-fields inside ANY header value: `tid, ssc, exp, sku, sts,
 *     st` parsed out of `;`-delimited key=value strings. (The Copilot internal
 *     token format leaks across multiple headers; the H3 review fix added the
 *     missing `sku, sts, st` to close the gap.)
 *   - Body fields by name (deep-walk, recursive): `client_secret, refresh_token,
 *     id_token, access_token`. Match is exact + case-sensitive — these are JSON
 *     field names from documented OAuth flows, all lowercase.
 *   - String pattern scan inside any string body field: `ghu_[a-zA-Z0-9]+`
 *     (GitHub user-token literal prefix).
 *
 * **Replacement format:** `<redacted, len=N>` where N is the original value's
 * length. Preserve that stable shape for consumers of redacted diagnostics.
 *
 * **Mutation discipline:** `redactBody` performs a deep clone — the caller's
 * input is never mutated. `redactHeaders` returns a new lowercased-key dict;
 * the input is not mutated.
 */

/** Stable replacement format preserving the original value length. */
function redactedToken(originalValue: string): string {
  return `<redacted, len=${originalValue.length}>`;
}

/** Header names (lowercase) whose value is replaced wholesale. */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "x-github-token",
  "cookie",
  "set-cookie",
  "openai-organization",
  "x-goog-api-key",
  "proxy-authorization",
]);

/**
 * IDE token sub-field keys parsed out of `;`-delimited header values.
 * Per H3 review fix: original implementation only covered the first 4;
 * the missing `sku, sts, st` closed the leak.
 */
const IDE_TOKEN_SUBFIELDS: ReadonlySet<string> = new Set([
  "tid",
  "ssc",
  "exp",
  "sku",
  "sts",
  "st",
]);

/**
 * Body JSON-field names whose value is replaced wholesale wherever they appear
 * (deep-walk). Match is exact + case-sensitive against object keys.
 */
const SENSITIVE_BODY_FIELDS: ReadonlySet<string> = new Set([
  "client_secret",
  "refresh_token",
  "id_token",
  "access_token",
]);

/** GitHub user-token literal prefix scanned anywhere inside any string. */
const GHU_TOKEN_PATTERN = /ghu_[a-zA-Z0-9]+/g;

/**
 * Redact each `;`-delimited `key=value` substring whose key is in the IDE
 * token subfield set. Preserves length parity per the format contract.
 *
 * Robust to any subset of fields, any order, with or without surrounding
 * whitespace. Non-matching segments are passed through unchanged.
 */
function redactIdeTokenSubfields(value: string): string {
  if (!value.includes("=")) return value;
  const segments = value.split(";");
  let touched = false;
  const out = segments.map((segRaw) => {
    const seg = segRaw;
    const eq = seg.indexOf("=");
    if (eq < 0) return seg;
    // Preserve surrounding whitespace on the key half so the original layout
    // is recovered exactly when no redaction happens.
    const keyRaw = seg.slice(0, eq);
    const valRaw = seg.slice(eq + 1);
    const key = keyRaw.trim().toLowerCase();
    if (!IDE_TOKEN_SUBFIELDS.has(key)) return seg;
    touched = true;
    return `${keyRaw}=${redactedToken(valRaw)}`;
  });
  return touched ? out.join(";") : value;
}

/**
 * Scan a string for the `ghu_*` literal pattern and replace every match with
 * `<redacted, len=N>` where N is the length of the matched substring.
 *
 * F13 audit (M3): we use `String.prototype.replace` with a fresh callback
 * (replace doesn't mutate `lastIndex` of a /g regex when called from
 * String.prototype.replace), AND we use `String.prototype.matchAll` for
 * the prior-detection short-circuit (matchAll returns a fresh iterator
 * each call, no `lastIndex` carry-over). The defensive `lastIndex = 0`
 * resets that the prior implementation carried can therefore be removed
 * without changing behavior.
 */
function redactGhuTokensInString(value: string): string {
  // matchAll returns a fresh iterator each call; no lastIndex carry-over.
  const iter = value.matchAll(GHU_TOKEN_PATTERN);
  const first = iter.next();
  if (first.done) return value;
  return value.replace(GHU_TOKEN_PATTERN, (match) => redactedToken(match));
}

/**
 * Redact a header dictionary. Returns a NEW object with lowercased keys.
 * - Wholesale-redact values whose name is in SENSITIVE_HEADER_NAMES.
 * - For every other header, also scan-and-redact IDE token sub-fields and
 *   `ghu_*` literals inside the value.
 *
 * Input is not mutated.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const kl = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(kl)) {
      out[kl] = redactedToken(v);
      continue;
    }
    let next = redactIdeTokenSubfields(v);
    next = redactGhuTokensInString(next);
    out[kl] = next;
  }
  return out;
}

/**
 * Recursively walk a body value (typically a JSON tree) and return a NEW value
 * with secrets redacted:
 *   - Object keys that match SENSITIVE_BODY_FIELDS get their value replaced.
 *   - String values anywhere are scanned for `ghu_*` literal pattern.
 * Non-string scalars and unknown shapes are returned unchanged.
 *
 * Input is not mutated. Cyclic structures are not expected (this operates on
 * decoded JSON) and not supported.
 */
export function redactBody(body: unknown): unknown {
  return walkRedact(body);
}

function walkRedact(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") return redactGhuTokensInString(node);
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map((el) => walkRedact(el));
  if (typeof node === "object") {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (SENSITIVE_BODY_FIELDS.has(k)) {
        if (typeof v === "string") {
          out[k] = redactedToken(v);
        } else if (v === null || v === undefined) {
          out[k] = v;
        } else {
          // Non-string sensitive value: stringify length-equivalent.
          const s = JSON.stringify(v) ?? "";
          out[k] = redactedToken(s);
        }
      } else {
        out[k] = walkRedact(v);
      }
    }
    return out;
  }
  return node;
}
