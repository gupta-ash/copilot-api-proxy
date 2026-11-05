/**
 * route-match.ts — exact-method + exact-path + optional model_pattern matcher.
 *
 * Per M5 spec § route-matching contract:
 *   - method: exact match (default `"POST"` if route omits it)
 *   - path:   exact-string equality with the request URL pathname
 *   - model_pattern: optional. Treated as a JS regex; compiled lazily;
 *     invalid regex → predicate fails closed (no match).
 *
 * Precedence: routes are evaluated in declared order; FIRST match wins.
 * No-match → caller returns 404 `no_route`.
 *
 * `route.upstream.endpoint` is documentation-only in M5 (per spec).
 */

import type { Route } from "~/types/config-schema.ts";

/**
 * Find the first route (in declared order) whose `match` clause matches the
 * given request properties. Returns `undefined` if no route matches.
 *
 * `model` may be `undefined` (e.g. for `/v1/models` GET, or any route that
 * the caller has no model context for). When undefined, routes that DO
 * declare a `model_pattern` simply skip — they cannot match.
 */
export function findMatchingRoute(
  routes: ReadonlyArray<Route>,
  method: string,
  pathname: string,
  model: string | undefined,
): Route | undefined {
  for (const route of routes) {
    const wantMethod = (route.match.method ?? "POST").toUpperCase();
    if (method.toUpperCase() !== wantMethod) continue;
    if (route.match.path !== pathname) continue;
    const pattern = route.match.model_pattern;
    if (pattern !== undefined) {
      if (model === undefined) continue;
      let re: RegExp | null = null;
      try {
        re = new RegExp(pattern);
      } catch {
        // Invalid regex → fail closed (skip this route).
        continue;
      }
      if (!re.test(model)) continue;
    }
    return route;
  }
  return undefined;
}
