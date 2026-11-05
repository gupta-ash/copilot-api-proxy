/**
 * headers.ts — case-insensitive HTTP header dictionary helpers + RFC 7230
 * CSV (list-based field-value) operations.
 *
 * **Why a separate module from `selector.ts` (per O2/D23):** headers are
 * case-insensitive, may repeat (Set-Cookie) and use CSV semantics for some
 * field values (Anthropic-Beta) — none of which `selector.ts`'s JSON path
 * syntax handles. Headers get their own focused selector here so each
 * module stays single-purpose.
 *
 * **Canonical case = lowercase.** Every output dict uses lowercased keys,
 * matching the `out[kl] = ...` convention in `redact.ts § redactHeaders`
 * (line ~131). This guarantees that the M1a redact output and any M1b/M6/M8
 * header transforms compose cleanly without case-collision surprises.
 *
 * **Mutation discipline.** Every function that returns a `Record<string,
 * string>` returns a NEW object. The input dict is never mutated. Same
 * convention as `redact.ts § redactHeaders` so callers can rely on
 * referential safety across the redact + transform pipeline.
 *
 * **Multi-value caveat (per F5 in M2.5).** This module's
 * `Record<string, string>` representation collapses multi-value headers
 * (e.g. RFC 6265 `Set-Cookie`, which by spec sends ONE field per cookie
 * rather than CSV-joining them) to last-write-wins. Callers must account for
 * this representation limit when forwarding multi-value upstream headers.
 *
 * If a future Copilot Ent release introduces multi-value response
 * headers, the M5 response handler must either log-and-continue OR
 * migrate the proxy-internal type to `Record<string, string | string[]>`.
 * **TODO(M5):** the response-side handler should do
 * `if (rawHeaders["set-cookie"] !== undefined) { debug.on(LEVEL_ON, () =>
 * "WARN: upstream sent Set-Cookie; verify proxy assumptions"); }` so a
 * regression is caught immediately rather than silently dropping cookies.
 *
 * **Empty-value semantics for CSV ops.** `parseCsv("")` returns `[]`.
 * `serializeCsv([])` returns `""`. `unionCsv` / `intersectCsv` / `filterCsv`
 * all handle empty inputs without throwing — empty in, empty (or trivial)
 * out.
 *
 * **Consumers (downstream):**
 *   - M6 `filter_header_csv` rule → `filterCsv` (Anthropic-Beta strict
 *     allowlist per F14).
 *   - M8 `merge_anthropic_betas` rule → `unionCsv` (default per H4 fix
 *     for the bundle line 1274 silent REPLACE bug), `intersectCsv`
 *     (`mode: intersect`), `replaceCsv` (`mode: replace`).
 *
 * **No external deps.** Stdlib-only TypeScript.
 */

/**
 * Look up a header value by name (case-insensitive). Returns the value of
 * the first matching key (insertion order if multiple keys collide, which
 * shouldn't happen if all writes go through this module). Returns
 * `undefined` if no key matches.
 *
 * The input dict is read-only; not mutated.
 */
export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Set (overwrite) a header value by name (case-insensitive). Returns a NEW
 * dict — the input is not mutated. The output uses the lowercased canonical
 * key, and any pre-existing keys that collide case-insensitively with `name`
 * are removed (so the result has a single canonical entry for that header).
 *
 * Multi-value semantics are NOT supported; see module header (F5 caveat).
 */
export function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const target = name.toLowerCase();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) continue;
    out[k.toLowerCase()] = v;
  }
  out[target] = value;
  return out;
}

/**
 * Append a value to a header (case-insensitive). Returns a NEW dict — the
 * input is not mutated. If the header already exists, the new value is
 * appended using RFC 7230 §3.2.2 list-based field-value combination
 * (`existing,new`). If it does not exist, the header is created with the
 * given value.
 *
 * The output uses the lowercased canonical key.
 *
 * Multi-value semantics are NOT supported; see module header (F5 caveat).
 * Use this only for headers whose CSV-combine is RFC-legal (e.g.
 * `Anthropic-Beta`, `Vary`); do NOT use for `Set-Cookie`, which the spec
 * forbids combining.
 */
export function appendHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const target = name.toLowerCase();
  const out: Record<string, string> = {};
  let existing: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      existing = v;
      continue;
    }
    out[k.toLowerCase()] = v;
  }
  out[target] = existing === undefined ? value : `${existing},${value}`;
  return out;
}

/**
 * Parse an RFC 7230 list-based field value into its constituent entries:
 *   - split on `,`
 *   - trim whitespace from each entry
 *   - drop empty entries
 *
 * **Deny-list (per F14, M3).** parseCsv treats the input as RFC 7230
 * §3.2.2 list-based field-value (commas separate values). The following
 * headers use a DIFFERENT grammar where comma-splitting will produce wrong
 * results — DO NOT call parseCsv on their values:
 *
 *   - `Set-Cookie` (RFC 6265 §3) — each cookie attribute may itself
 *     contain commas (e.g. `Expires=Wed, 09 Jun 2021 ...`); RFC 6265
 *     forbids combining multiple Set-Cookie headers into a single
 *     comma-separated value.
 *   - `WWW-Authenticate` (RFC 7235 §4.1) — challenge syntax is a list of
 *     `(scheme [token68 | params])` where `params` is a comma-separated
 *     list of `name=value` pairs; comma-splitting the whole header value
 *     conflates challenge boundaries with parameter boundaries.
 *   - `Proxy-Authenticate` (RFC 7235 §4.3) — same grammar as
 *     `WWW-Authenticate`; same caveat.
 *
 * Examples:
 *   parseCsv("a, b, c")     → ["a", "b", "c"]
 *   parseCsv("")            → []
 *   parseCsv("  a , b ,c ") → ["a", "b", "c"]
 *   parseCsv("a,b,")        → ["a", "b"]   // trailing-comma drops empty
 */
export function parseCsv(value: string): string[] {
  if (value.length === 0) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * Serialize an array of CSV entries back to a single field value using
 * `, ` (comma-space) as the separator. Empty array serializes to `""`.
 */
export function serializeCsv(values: string[]): string {
  if (values.length === 0) return "";
  return values.join(", ");
}

/**
 * Filter a CSV field value to retain only entries present in `allowed`
 * (case-sensitive set membership). Used by the M6 `filter_header_csv`
 * rule (Anthropic-Beta strict allowlist per F14).
 *
 * Empty input → empty output. Empty allowlist → empty output. All
 * filtered → empty output.
 */
export function filterCsv(value: string, allowed: ReadonlySet<string>): string {
  const entries = parseCsv(value);
  const kept = entries.filter((e) => allowed.has(e));
  return serializeCsv(kept);
}

/**
 * Union two CSV field values. Preserves left order, then appends right-only
 * entries in their original right order. Duplicates are eliminated (each
 * entry appears once in the output).
 *
 * Used by the M8 `merge_anthropic_betas` rule's default `mode: union`
 * (per H4 fix for the bundle line 1274 silent REPLACE bug).
 */
export function unionCsv(left: string, right: string): string {
  const leftEntries = parseCsv(left);
  const rightEntries = parseCsv(right);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of leftEntries) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  for (const e of rightEntries) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return serializeCsv(out);
}

/**
 * Intersect two CSV field values. Returns entries present in BOTH inputs,
 * preserving left order. Duplicates within either input are collapsed.
 *
 * Used by the M8 `merge_anthropic_betas` rule's `mode: intersect`.
 */
export function intersectCsv(left: string, right: string): string {
  const leftEntries = parseCsv(left);
  const rightSet = new Set(parseCsv(right));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of leftEntries) {
    if (seen.has(e)) continue;
    if (!rightSet.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return serializeCsv(out);
}

/**
 * Replace `left` wholesale with `right`. Returns `right` unchanged. The
 * `_left` parameter exists for API symmetry with `unionCsv` / `intersectCsv`
 * so call sites can dispatch on `mode` without special-casing the signature.
 *
 * Used by the M8 `merge_anthropic_betas` rule's `mode: replace` (matches
 * the bundle's pre-fix REPLACE behavior).
 */
export function replaceCsv(_left: string, right: string): string {
  return right;
}
