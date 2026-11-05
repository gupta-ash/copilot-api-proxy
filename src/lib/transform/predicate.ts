/**
 * predicate.ts — `when` clause evaluator for both engine surfaces.
 *
 * **Semantics (per R3 + O1 stream-event extension).**
 *
 *   - All set fields are AND'd; an empty `When` matches everything.
 *   - `route`, `method`, `model`, `harness`, `request_endpoint` — exact
 *     case-sensitive equality.
 *   - `model_in: string[]` — `Array.includes(ctx.model)`. Empty array
 *     fails (no entries to match).
 *   - `model_glob` — tiny matcher: `*` = any chars, `?` = single char,
 *     anchored at both ends. Regex meta chars OTHER than `*`/`?` are
 *     escaped, so `model_glob: "claude.4.7"` requires a literal `.`
 *     in the model id (NOT the regex any-char). Compiled regex cached
 *     per glob string.
 *   - `model_regex` — `new RegExp(when.model_regex)`; compilation
 *     errors are caught at evaluate-time, logged via `debug.on(LEVEL_ON)`,
 *     and the predicate returns `false` (rule does NOT fire). This
 *     keeps a malformed config from killing requests at runtime.
 *   - `request_endpoint` / `request_model_glob` — meaningful only on
 *     RESPONSE rules. If the context lacks the field, the predicate
 *     fails.
 *   - `event_types: string[]` — meaningful only on stream-event rules.
 *     If the context isn't a `StreamEventContext` (no `event` field),
 *     the predicate fails.
 *
 * **Compile cache.** `model_glob` and `model_regex` results are cached in
 * a single `Map<string, RegExp>` keyed by `glob:<src>` / `regex:<src>` to
 * avoid re-compilation on every request. `reset()` clears the cache (used
 * by tests AND by `lib/config.ts § doReload` per F6, M3 — every successful
 * config reload clears the cache so glob/regex strings get re-evaluated
 * against the new config interpretation).
 *
 * **LRU eviction (per F6, M3).** The compile cache is bounded at
 * `CACHE_BOUND` entries (default 256). When `compileCache.set(...)` would
 * push the cache past the bound, the OLDEST entry (Map insertion order) is
 * evicted. JS Map preserves insertion order, so this is FIFO/insertion-LRU
 * — sufficient for the workload (config-supplied predicate strings are a
 * small set repeating across many requests; access-tracking would add
 * per-eval bookkeeping for negligible benefit). Tests can override the
 * bound via `setCacheBound(n)` (which also clears the cache).
 *
 * **No throws to the caller.** Every error path (invalid regex, missing
 * context fields) returns `false`. Rule authors who need stricter
 * validation should layer their own zod schema at the `options` level.
 */

import { LEVEL_ON, debug } from "../debug.ts";

import type { StreamEventContext, TransformContext, When } from "./types.ts";

/** Compile cache for model_glob + model_regex. */
const compileCache: Map<string, RegExp> = new Map();

/**
 * Maximum number of entries the compile cache will hold before evicting
 * the oldest (insertion-LRU). Default 256 — overridable via
 * `setCacheBound(n)` for tests. F6 (M3) caps unbounded growth from
 * config-driven glob/regex churn.
 */
let CACHE_BOUND = 256;

/**
 * Override the LRU bound. Clears the cache as a side-effect (so prior
 * entries don't accidentally survive a tighter bound). **For tests only.**
 */
export function setCacheBound(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `predicate.setCacheBound: n must be a positive integer (got ${n})`,
    );
  }
  CACHE_BOUND = n;
  compileCache.clear();
}

/**
 * Insert a value into the compile cache, evicting the oldest entry if the
 * cache is already at `CACHE_BOUND` and the key is not already present.
 * Map insertion order makes the first-inserted key the "oldest" — calling
 * `compileCache.keys().next().value` returns it.
 */
function setWithEviction(key: string, value: RegExp): void {
  if (!compileCache.has(key) && compileCache.size >= CACHE_BOUND) {
    const oldestKey = compileCache.keys().next().value;
    if (oldestKey !== undefined) {
      compileCache.delete(oldestKey);
    }
  }
  compileCache.set(key, value);
}

/**
 * Convert a glob (with `*` / `?` and escaped regex meta chars) into an
 * anchored RegExp. Cached per source string with LRU eviction at
 * `CACHE_BOUND` (per F6, M3).
 */
function compileGlob(src: string): RegExp {
  const key = `glob:${src}`;
  const cached = compileCache.get(key);
  if (cached !== undefined) return cached;
  // Escape ALL regex meta chars first; THEN translate \* and \? back to .* / .
  const escaped = src.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  const re = new RegExp(`^${translated}$`);
  setWithEviction(key, re);
  return re;
}

/**
 * Compile a raw regex source. Cached per source string with LRU eviction
 * at `CACHE_BOUND` (per F6, M3). Throws if the regex source is invalid;
 * the caller (`evaluate`) catches and degrades to `false`.
 */
function compileRegex(src: string): RegExp {
  const key = `regex:${src}`;
  const cached = compileCache.get(key);
  if (cached !== undefined) return cached;
  const re = new RegExp(src);
  setWithEviction(key, re);
  return re;
}

/**
 * Type-guard: is the given context a `StreamEventContext` (carries an
 * `event` field with a `type` string)?
 */
function isStreamEventContext(
  ctx: TransformContext | StreamEventContext,
): ctx is StreamEventContext {
  return (
    typeof (ctx as StreamEventContext).event === "object" &&
    (ctx as StreamEventContext).event !== null &&
    typeof (ctx as StreamEventContext).event.type === "string"
  );
}

/**
 * Evaluate a `when` predicate against either surface's context. Returns
 * `true` if the rule should fire, `false` otherwise. Never throws to
 * the caller.
 *
 * @param when - the predicate (empty matches everything)
 * @param ctx  - either a `TransformContext` (body surface) or a
 *               `StreamEventContext` (stream-event surface)
 */
export function evaluate(
  when: When | undefined,
  ctx: TransformContext | StreamEventContext,
): boolean {
  if (!when) return true;

  // route
  if (when.route !== undefined && when.route !== ctx.route) return false;

  // method — only TransformContext / StreamEventContext don't carry method
  // directly; method matching is on (currently absent) request method.
  // For M2 we conservatively read it off the context if present (open
  // shape; not in the formal interface). When absent, the predicate fails
  // iff `when.method` is set.
  if (when.method !== undefined) {
    const method = (ctx as { method?: string }).method;
    if (method !== when.method) return false;
  }

  // model exact
  if (when.model !== undefined && when.model !== ctx.model) return false;

  // model_glob
  if (when.model_glob !== undefined) {
    const re = compileGlob(when.model_glob);
    if (!re.test(ctx.model)) return false;
  }

  // model_regex (caught — no throw to caller)
  if (when.model_regex !== undefined) {
    let re: RegExp;
    try {
      re = compileRegex(when.model_regex);
    } catch (err) {
      debug.on(
        LEVEL_ON,
        () =>
          `predicate: invalid model_regex "${when.model_regex}" — ${
            (err as Error).message
          } — predicate fails (rule will not fire)`,
      );
      return false;
    }
    if (!re.test(ctx.model)) return false;
  }

  // model_in
  if (when.model_in !== undefined) {
    if (when.model_in.length === 0) return false;
    if (!when.model_in.includes(ctx.model)) return false;
  }

  // harness — only TransformContext carries `harness`. For
  // StreamEventContext the field is absent, so an explicit `harness:` in
  // a stream-event predicate fails (the rule does not fire). Read off
  // a structural-typed view so we don't tighten StreamEventContext to
  // require the field.
  if (when.harness !== undefined) {
    const ctxHarness = (ctx as { harness?: string }).harness;
    if (ctxHarness === undefined) return false;
    if (ctxHarness !== when.harness) return false;
  }

  // request_endpoint (response rules only)
  if (when.request_endpoint !== undefined) {
    if (ctx.request_endpoint === undefined) return false;
    if (ctx.request_endpoint !== when.request_endpoint) return false;
  }

  // request_model_glob (response rules only)
  if (when.request_model_glob !== undefined) {
    const reqModel = (ctx as TransformContext).request_model;
    const reqModelGlob = (ctx as TransformContext).request_model_glob;
    // Match against either the actual request_model OR a previously-set
    // request_model_glob (legacy sites). request_model is the canonical
    // field; the glob field is a forward-compat slot per types.ts.
    const candidate = reqModel ?? reqModelGlob;
    if (candidate === undefined) return false;
    const re = compileGlob(when.request_model_glob);
    if (!re.test(candidate)) return false;
  }

  // event_types (stream-event rules only)
  if (when.event_types !== undefined) {
    if (!isStreamEventContext(ctx)) return false;
    if (when.event_types.length === 0) return false;
    if (!when.event_types.includes(ctx.event.type)) return false;
  }

  return true;
}

/**
 * Clear the compile cache. Used by tests AND by `lib/config.ts § doReload`
 * (per F6, M3) — every successful config reload calls this so the new
 * config interpretation gets fresh-compiled glob/regex.
 */
export function reset(): void {
  compileCache.clear();
}

/**
 * Read the current cache size. **For tests only** — callers should not
 * rely on this in production (cache is an internal optimization).
 */
export function _cacheSize(): number {
  return compileCache.size;
}

/**
 * Check whether a glob string is currently cached. **For tests only**.
 */
export function _hasGlob(src: string): boolean {
  return compileCache.has(`glob:${src}`);
}
