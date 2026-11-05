/**
 * model-catalog.ts — fetch + parse the upstream Copilot `/models` catalog.
 *
 * Thin wrapper over `getModels()` (the raw upstream caller used by the
 * `GET /models` route handler). Two consumers, both in `main.ts`:
 *   - startup: log the catalog + record ids in `copilot-proxy.meta.json`;
 *   - `--list-models` CLI flag: print ids to stdout and exit.
 *
 * The upstream catalog is the OAuth identity's authoritative model list — an
 * Anthropic/OpenAI model appears here only after GitHub adds it to Copilot's
 * curated catalog (a model in your Claude subscription is NOT automatically in
 * Copilot's list). This makes the catalog the correct instrument for comparing
 * OAuth identities ("which login has the newest model").
 *
 * The parse step is split into the pure `parseModelCatalog()` so it can be
 * unit-tested without a live token / network.
 */

import { getModels } from "~/services/copilot/get-models.ts";
import type { TokenManager } from "~/auth/token-manager.ts";
import type { Config } from "~/types/config-schema.ts";

/** Config endpoint-family key for the models catalog (see config.endpoints). */
const MODELS_ENDPOINT = "models";
/** Upstream service key (see config.upstreams). */
const UPSTREAM_SERVICE = "copilot_enterprise";

export interface ModelCatalog {
  /** Sorted, de-duplicated model ids. */
  ids: string[];
  /** `ids.length` (convenience for callers writing meta.json). */
  count: number;
  /** The untouched upstream JSON (so no capability data is lost). */
  raw: unknown;
}

export interface FetchModelCatalogDeps {
  config: Config;
  /** Copilot-Ent token (NOT the GitHub OAuth token). */
  copilotToken: string;
  /** Passed through for Layer-B 401 retry (optional). */
  tokenManager?: TokenManager;
  signal?: AbortSignal;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse the upstream `/models` payload into a sorted, de-duplicated id list.
 *
 * Tolerates both observed shapes: `{ data: [{ id, ... }] }` (Copilot-Ent's
 * OpenAI-style envelope) and a bare `[{ id }]` array. Non-object entries and
 * entries without a string `id` are skipped (defensive — never throw on a
 * shape surprise; a malformed catalog yields an empty list, not a crash).
 */
export function parseModelCatalog(json: unknown): {
  ids: string[];
  count: number;
} {
  const list: unknown[] = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json["data"])
      ? (json["data"] as unknown[])
      : [];

  const seen = new Set<string>();
  for (const item of list) {
    if (isRecord(item) && typeof item["id"] === "string") {
      seen.add(item["id"]);
    }
  }
  const ids = [...seen].sort((a, b) => a.localeCompare(b));
  return { ids, count: ids.length };
}

/**
 * Fetch the upstream catalog and parse it. Resolves the upstream path exactly
 * as `routes/models/handler.ts` does (`config.upstreams.copilot_enterprise
 * .paths.models`). Propagates `getModels()`'s `HTTPError` on a non-OK upstream
 * response — the caller decides whether that is fatal (startup: non-fatal;
 * `--list-models`: exit 1).
 */
export async function fetchModelCatalog(
  deps: FetchModelCatalogDeps,
): Promise<ModelCatalog> {
  const { config, copilotToken, tokenManager, signal } = deps;

  const upstreamPath =
    config.upstreams[UPSTREAM_SERVICE]?.paths[MODELS_ENDPOINT];
  if (upstreamPath === undefined) {
    throw new Error(
      `model-catalog: config.upstreams.${UPSTREAM_SERVICE}.paths.${MODELS_ENDPOINT} is undefined`,
    );
  }

  const response = await getModels({
    headers: {},
    copilotToken,
    accountType: config.auth.account_type,
    vsCodeVersion: config.auth.vs_code_version,
    signal,
    tokenManager,
    upstreamPath,
  });

  const raw: unknown = await response.json();
  const { ids, count } = parseModelCatalog(raw);
  return { ids, count, raw };
}
