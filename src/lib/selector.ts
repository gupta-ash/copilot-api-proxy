/**
 * selector.ts — JSON-tree path selector + matchers for body transformations.
 *
 * **Scope (per O2 / D23):** This module addresses **JSON body trees only**.
 * HTTP headers are case-insensitive and have multi-value semantics that don't
 * fit a JSON path syntax — they get their own module (`lib/headers.ts`) in M1b.
 *
 * **Path syntax**
 *
 *   foo               — top-level field
 *   foo.bar           — nested field (dot-separated)
 *   foo[]             — every element of foo (which must be an array)
 *   foo[0]            — element 0 of foo
 *   foo[].bar         — bar field of every element of foo
 *   foo[].bar[].baz   — nested arrays
 *   foo[0].bar[]      — mixing index + wildcard works
 *   [0].text          — element 0 of a top-level array body, then field text
 *   [].text           — every element of a top-level array body, then field text
 *
 *   Anything that isn't an array but is addressed with `[]` or `[i]` simply
 *   yields zero matches (no throw — selectors can be optimistic).
 *
 *   **F11 (M3): leading `[0]` / `[]` allowed.** When the body itself is a
 *   top-level array (rather than an object), the path may start with an
 *   index segment or wildcard. The parser already accepted this shape; M3
 *   updates the docstring to match the parser so the syntax is officially
 *   sanctioned.
 *
 * **Matchers**
 *
 *   { equals: <string> }     — strict equality on a string-valued leaf
 *   { startsWith: <string> } — leaf string startsWith prefix
 *   { endsWith: <string> }   — leaf string endsWith suffix
 *   { contains: <string> }   — leaf string includes substring
 *   { regex: <pattern> }     — leaf string matches new RegExp(pattern)
 *   { jsonpath: <expr> }     — placeholder; throws JsonPathNotImplemented
 *
 *   Matchers operate ONLY on string-valued leaves. Non-strings produce no
 *   match (no throw). This is the simplest contract that satisfies R10 and
 *   keeps the matcher unambiguous; richer comparisons land later if needed.
 *
 * **Return shape**
 *
 *   MatchResult[] — each entry carries `{path, parent, index, value}` so a
 *   downstream rule can mutate (delete from array, swap value, etc.) without
 *   re-traversing.
 */

/** A single matcher specification — exactly one variant is set per selector. */
export interface Matcher {
  equals?: string;
  startsWith?: string;
  endsWith?: string;
  contains?: string;
  regex?: string;
  jsonpath?: string;
}

/** A selector is a path + matcher pair. */
export interface Selector {
  path: string;
  matcher: Matcher;
}

/** A match result — enough to read or mutate the matched leaf. */
export interface MatchResult {
  /** Concrete fully-qualified path string of this match (e.g. "system[2].text"). */
  path: string;
  /** The parent container (object or array) holding this leaf. */
  parent: unknown[] | Record<string, unknown>;
  /** The numeric index (when parent is array) or string key (when parent is object). */
  index: number | string;
  /** The matched leaf value. */
  value: unknown;
}

/** Thrown when a selector requests jsonpath, which is intentionally unsupported. */
export class JsonPathNotImplemented extends Error {
  constructor(public readonly expression: string) {
    super(
      `jsonpath matcher not implemented in M1a (expression: ${expression}). ` +
        `Use equals/startsWith/endsWith/contains/regex instead, or revisit in M2+.`,
    );
    this.name = "JsonPathNotImplemented";
  }
}

/** Tokenized path step. */
type Step =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

/**
 * Parse the dotted/bracketed path syntax into a list of Steps.
 *
 * Grammar (simple recursive descent over a regex-tokenized string), per
 * F11 update in M3:
 *   path  = (field | "[" digit+ "]" | "[]") ( "." field | "[" digit+ "]" | "[]" )*
 *   field = [a-zA-Z_$][a-zA-Z_$0-9]*
 *
 * The first segment may be a field, an indexed array element (`[0]`), or
 * a wildcard (`[]`); the indexed/wildcard forms apply when the body itself
 * is a top-level array. Subsequent segments are introduced by `.` (field)
 * or directly by `[N]` / `[]`.
 *
 * Anything else throws — this is a programmer-input contract.
 */
function parsePath(pathStr: string): Step[] {
  if (!pathStr) throw new Error("selector.path: empty path is not allowed");
  const steps: Step[] = [];
  // Tokenize: capture either a dotted field name, a "[N]" index, or a "[]" wildcard.
  // This regex matches one segment at a time from the start of the remaining string.
  const SEG_RE = /^([a-zA-Z_$][a-zA-Z_$0-9]*)|^\[(\d+)\]|^\[\]/;
  let rest = pathStr;
  let first = true;
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      if (first) {
        throw new Error(
          `selector.path: unexpected '.' at start of path (got "${pathStr}")`,
        );
      }
      rest = rest.slice(1);
      // After a dot, the next segment must be a field — `[` is invalid here.
      const m = /^([a-zA-Z_$][a-zA-Z_$0-9]*)/.exec(rest);
      if (!m) {
        throw new Error(
          `selector.path: expected field name after '.' in "${pathStr}"`,
        );
      }
      steps.push({ kind: "field", name: m[1]! });
      rest = rest.slice(m[0].length);
      first = false;
      continue;
    }
    const m = SEG_RE.exec(rest);
    if (!m) {
      throw new Error(
        `selector.path: unparseable segment at "${rest}" in "${pathStr}"`,
      );
    }
    if (m[1] !== undefined) {
      steps.push({ kind: "field", name: m[1] });
    } else if (m[2] !== undefined) {
      steps.push({ kind: "index", index: Number(m[2]) });
    } else {
      // m[0] === "[]"
      steps.push({ kind: "wildcard" });
    }
    rest = rest.slice(m[0].length);
    first = false;
  }
  return steps;
}

/** Render a step list back to canonical syntax (used to build MatchResult.path). */
function renderPath(steps: ReadonlyArray<Step>): string {
  let out = "";
  for (const s of steps) {
    if (s.kind === "field") {
      out += out.length === 0 ? s.name : `.${s.name}`;
    } else if (s.kind === "index") {
      out += `[${s.index}]`;
    } else {
      out += "[]";
    }
  }
  return out;
}

/** True if the matcher object specifies exactly one supported matcher variant. */
function hasMatcherVariant(m: Matcher): boolean {
  return (
    m.equals !== undefined ||
    m.startsWith !== undefined ||
    m.endsWith !== undefined ||
    m.contains !== undefined ||
    m.regex !== undefined ||
    m.jsonpath !== undefined
  );
}

/** Apply a matcher to a leaf value; returns true if the leaf matches. */
function matches(value: unknown, m: Matcher): boolean {
  if (m.jsonpath !== undefined) {
    throw new JsonPathNotImplemented(m.jsonpath);
  }
  if (typeof value !== "string") return false;
  if (m.equals !== undefined) return value === m.equals;
  if (m.startsWith !== undefined) return value.startsWith(m.startsWith);
  if (m.endsWith !== undefined) return value.endsWith(m.endsWith);
  if (m.contains !== undefined) return value.includes(m.contains);
  if (m.regex !== undefined) return new RegExp(m.regex).test(value);
  return false;
}

/**
 * Walk the body following `steps`, calling `visit` for each terminal value.
 * `traversed` tracks the concrete path taken so far for MatchResult.path.
 */
function walk(
  node: unknown,
  steps: ReadonlyArray<Step>,
  traversed: Step[],
  visit: (
    value: unknown,
    parent: unknown[] | Record<string, unknown>,
    index: number | string,
    pathSteps: ReadonlyArray<Step>,
  ) => void,
): void {
  // No remaining steps would mean the selector resolves to the root, but our
  // grammar requires at least one step, so this branch is only used when the
  // last step's recursion drops here with no parent. Caller handles results
  // from the inner recursion before this fires; treat as a no-op.
  if (steps.length === 0) return;

  const [step, ...rest] = steps;
  // step is non-null because steps.length > 0 (TS doesn't narrow tuple destructuring).
  if (!step) return;
  const isLast = rest.length === 0;

  if (step.kind === "field") {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, step.name)) return;
    const next = obj[step.name];
    const taken = [...traversed, step];
    if (isLast) {
      visit(next, obj, step.name, taken);
    } else {
      walk(next, rest, taken, visit);
    }
    return;
  }

  if (step.kind === "index") {
    if (!Array.isArray(node)) return;
    if (step.index < 0 || step.index >= node.length) return;
    const next = node[step.index];
    const taken = [...traversed, step];
    if (isLast) {
      visit(next, node, step.index, taken);
    } else {
      walk(next, rest, taken, visit);
    }
    return;
  }

  // wildcard
  if (!Array.isArray(node)) return;
  for (let i = 0; i < node.length; i++) {
    const next = node[i];
    const taken: Step[] = [...traversed, { kind: "index", index: i }];
    if (isLast) {
      visit(next, node, i, taken);
    } else {
      walk(next, rest, taken, visit);
    }
  }
}

/**
 * Run a selector against `body` and return every leaf that matches.
 *
 * Edge cases:
 *   - empty path → throws (programmer input)
 *   - missing field, out-of-range index, non-array under `[]` or `[i]`
 *     → silently produces no matches (selectors are optimistic against
 *     real-world bodies that may or may not have a given field)
 *   - jsonpath matcher → throws JsonPathNotImplemented
 *   - non-string leaf vs string-only matcher → no match (no throw)
 *
 * @throws JsonPathNotImplemented when matcher.jsonpath is set
 * @throws Error when the path is unparseable
 */
export function select(body: unknown, selector: Selector): MatchResult[] {
  if (!hasMatcherVariant(selector.matcher)) {
    throw new Error(
      "selector.matcher: must specify one of equals/startsWith/endsWith/contains/regex/jsonpath",
    );
  }
  const steps = parsePath(selector.path);
  const out: MatchResult[] = [];
  walk(body, steps, [], (value, parent, index, pathSteps) => {
    if (matches(value, selector.matcher)) {
      out.push({
        path: renderPath(pathSteps),
        parent,
        index,
        value,
      });
    }
  });
  return out;
}
