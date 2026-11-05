/**
 * server.ts — Hono app builder + lifecycle owner.
 *
 * Per D-LOCK-8B: this module owns the SERVER lifecycle (bind, drain, close).
 * It does NOT touch process signals — that's main.ts's job. Tests inject
 * their own signal handling around `serverHandle.close({ graceMs })`.
 *
 * **D37 (M9-FIX-PATHS-CONFIG): config-driven Hono route registration.**
 * `buildApp` iterates `config.endpoints` and registers each endpoint family's
 * `inbound_paths` (with the matching HTTP method per `methods`) to the
 * factory-built handler. The handler factory map is fixed (5 endpoint
 * families → 5 handler factories); unknown endpoint names in config are
 * skipped with a warn log (operator typo defense).
 *
 * `buildApp` mounts:
 *   - `GET  /health`             — always 200 (no auth gate; D-LOCK-2 stage 1)
 *   - `POST <endpoints.anthropic_messages.inbound_paths[*]>` — auth-gated
 *   - `POST <endpoints.openai_responses.inbound_paths[*]>`   — auth-gated
 *   - `POST <endpoints.openai_chat_completions.inbound_paths[*]>` — auth-gated
 *   - `POST <endpoints.embeddings.inbound_paths[*]>`         — auth-gated
 *   - `GET  <endpoints.models.inbound_paths[*]>`             — auth-gated (option A)
 *
 * `startServer(opts)` returns a `ServerHandle` with `{url, port, close, server}`.
 * `port: 0` ephemeral binding is supported (caller reads back the actual port
 * via `handle.port`).
 *
 * **srvx note (D-LOCK-8 + spec § srvx):** kept per default. The streaming
 * spike (`scripts/spike_hono_streaming.ts`) confirmed `streamSSE` works
 * cleanly under srvx wrapping for all 7 testable scenarios (scenario 6 is
 * srvx interop itself, which the spike implicitly validates by running
 * under srvx).
 */

import { Hono } from "hono";
import { serve as srvxServe } from "srvx";

import type { TokenManager } from "~/auth/token-manager.ts";
import { LEVEL_VERBOSE, debug } from "~/lib/debug.ts";
import { renderPrometheus } from "~/lib/metrics.ts";
import type { TraceWriter } from "~/lib/trace.ts";
import { makeLoggingHandlers } from "~/routes/admin/logging-handler.ts";
import { makeChatCompletionsHandler } from "~/routes/chat-completions/handler.ts";
import { makeEmbeddingsHandler } from "~/routes/embeddings/handler.ts";
import { makeMessagesHandler } from "~/routes/messages/handler.ts";
import { makeModelsHandler } from "~/routes/models/handler.ts";
import { makeResponsesHandler } from "~/routes/responses/handler.ts";
import { withMetrics } from "~/routes/_shared/metrics-middleware.ts";
import { withTrace } from "~/routes/_shared/with-trace.ts";
import type { Config } from "~/types/config-schema.ts";

/**
 * Map endpoint family names (config.endpoints keys) to clean Prometheus
 * route labels. Underscores are stripped from the label per spec § Group
 * A § 3: `anthropic_messages` → `messages`, etc. The label is what shows
 * up in `copilot_proxy_requests_total{route="messages",...}`.
 */
const ROUTE_LABEL_MAP: Readonly<Record<string, string>> = {
  anthropic_messages: "messages",
  openai_responses: "responses",
  openai_chat_completions: "chat_completions",
  embeddings: "embeddings",
  models: "models",
};

export interface ServerOptions {
  /** Port to bind. `0` = ephemeral (caller reads back via handle.port). */
  port: number;
  host: string;
  config: Config;
  tokenManager: TokenManager;
  /**
   * Phase 5 v3.1 Group B — when set, every protected route is wrapped in
   * `withTrace(traceWriter, routeLabel, handler)` INSIDE the existing
   * `withMetrics` wrapper. When unset (the default; level < raw), no
   * trace middleware is composed and behavior is identical to pre-Group-B.
   */
  traceWriter?: TraceWriter;
}

export interface ServerHandle {
  /** Resolved bind URL (e.g. `http://0.0.0.0:4143`). Useful for logs. */
  readonly url: string;
  /** Resolved bind port. CRUCIAL for `port: 0` — caller reads the actual port. */
  readonly port: number;
  /**
   * Graceful shutdown. Stops accepting new connections; waits up to `graceMs`
   * for in-flight requests/streams; force-closes after the timeout.
   * Idempotent — second call resolves immediately.
   *
   * Does NOT call `tokenManager.dispose()` — that's main.ts's responsibility
   * (D-LOCK-8B: server.ts owns server lifecycle, main.ts owns process lifecycle).
   */
  close(opts?: { graceMs?: number }): Promise<void>;
  /** The underlying srvx server (escape hatch for tests; do NOT use in prod). */
  readonly server: unknown;
}

/**
 * Build the Hono app with all routes mounted. Pure function (no side
 * effects beyond returning the configured Hono instance).
 *
 * D37: routes are registered by iterating `config.endpoints`. The handler
 * factory map below wires the 5 known endpoint families to their factories;
 * any extra entries in `config.endpoints` (operator typo) are skipped with
 * a debug log. `/health` stays hardcoded (it's not part of the proxy
 * routing surface).
 */
export function buildApp(
  config: Config,
  tokenManager: TokenManager,
  traceWriter?: TraceWriter,
): Hono {
  const app = new Hono();

  // /health is the only route NOT subject to the stage-1 auth gate
  // (D-LOCK-2 — stage 1 means /health serves immediately while the rest
  // return 503 auth_pending until tokenManager.getStatus() === "ready").
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      proxy: "copilot-proxy",
      phase: "m9-fix-paths-config",
      auth_status: tokenManager.getStatus(),
    }),
  );

  // M12 D-LOCK-4: Prometheus /metrics endpoint. Mounted directly after
  // /health and NOT auth-gated — operators must be able to scrape a
  // struggling proxy (token_status=starting/failed) to see what's wrong.
  // The withMetrics wrapper short-circuits when routeName === "metrics"
  // (per D38 iter-1 M2 fix MANDATE) so /metrics scrapes do not inflate
  // requests_total or create a body-size feedback loop.
  app.get("/metrics", () => {
    const body = renderPrometheus();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4",
      },
    });
  });

  // Dynamic logging toggle — runtime logging-level control plane. Mounted
  // directly after /metrics and, like /metrics, mounted RAW (NOT wrapped in
  // withMetrics/withTrace): an operator must be able to read + flip the level
  // on a struggling proxy the same way they scrape it. No auth/loopback/token
  // guard (operator decision — treated like the already-LAN-open /health +
  // /metrics). GET reads the current level; POST flips it live — with-trace.ts
  // / forward-stream.ts read `debug.getLevel()` at each request start, so the
  // NEXT request honors the new level with no restart (in-flight streams keep
  // their snapshot decision). `traceCaptureAvailable` is passed from the
  // in-scope `traceWriter`: when the writer was not created at boot (trace-dir
  // mkdir failed → withTrace is never composed below), a POST asking for raw+
  // is refused with a 503 instead of a silent false-success flip.
  const loggingHandlers = makeLoggingHandlers(traceWriter !== undefined);
  app.get("/admin/logging", loggingHandlers.getHandler);
  app.post("/admin/logging", loggingHandlers.postHandler);

  // D37: handler factory map keyed by endpoint family name. The 5 entries
  // here MUST mirror the 5 default endpoint families in
  // `config-schema.ts § EndpointsSectionSchema.default(...)`. Operators MAY
  // omit any of them in their YAML, but they cannot define new endpoint
  // families that the proxy doesn't know how to handle.
  //
  // M12.5 H1: factory deps include `metricRoute` (the clean canonical
  // Prometheus label resolved from `ROUTE_LABEL_MAP[endpointName]`) so
  // each handler can thread it into `forwardStream` / `forwardStreamTranslated`
  // ctxBase. Without this, stream metrics emitted `route="/v1/messages"`
  // while the wrapping middleware emitted `route="messages"` — split labels
  // broke Prometheus cross-metric joins.
  const handlerFactories: Record<
    string,
    (deps: {
      config: Config;
      tokenManager: TokenManager;
      endpointName: string;
      metricRoute: string;
    }) => (c: import("hono").Context) => Promise<Response>
  > = {
    anthropic_messages: (deps) => makeMessagesHandler(deps),
    openai_responses: (deps) => makeResponsesHandler(deps),
    openai_chat_completions: (deps) => makeChatCompletionsHandler(deps),
    embeddings: (deps) => makeEmbeddingsHandler(deps),
    models: (deps) => makeModelsHandler(deps),
  };

  for (const [endpointName, endpointDef] of Object.entries(config.endpoints)) {
    const factory = handlerFactories[endpointName];
    if (factory === undefined) {
      // Unknown endpoint family in config (operator typo). Log + skip.
      debug.on(
        LEVEL_VERBOSE,
        () =>
          `[server] config.endpoints.${endpointName}: no handler factory; skipping`,
      );
      continue;
    }
    // M12 D-LOCK-3: every handler is wrapped in `withMetrics(routeName, ...)`
    // so requests_total + response_bytes_total + inflight gauges are emitted
    // for every route. Route-label name comes from ROUTE_LABEL_MAP (clean,
    // no underscores per spec).
    //
    // Phase 5 v3.1 Group B: when `traceWriter` is provided, compose
    // `withTrace` INSIDE `withMetrics` so metrics see all requests AND
    // trace runs in the same scope. When unset, the trace middleware is
    // omitted entirely (zero-cost passthrough).
    const routeLabel = ROUTE_LABEL_MAP[endpointName] ?? endpointName;
    const baseHandler = factory({
      config,
      tokenManager,
      endpointName,
      metricRoute: routeLabel,
    });
    const traceWrapped =
      traceWriter !== undefined
        ? withTrace(traceWriter, routeLabel, baseHandler)
        : baseHandler;
    const handler = withMetrics(routeLabel, traceWrapped);
    const methods = endpointDef.methods ?? ["POST"];
    for (const inboundPath of endpointDef.inbound_paths) {
      for (const method of methods) {
        if (method === "GET") {
          app.get(inboundPath, handler);
        } else if (method === "POST") {
          app.post(inboundPath, handler);
        } else if (method === "PUT") {
          app.put(inboundPath, handler);
        } else if (method === "PATCH") {
          app.patch(inboundPath, handler);
        } else if (method === "DELETE") {
          app.delete(inboundPath, handler);
        }
      }
    }
  }

  return app;
}

interface SrvxServerLike {
  url?: string;
  ready: () => Promise<unknown>;
  close: (closeActiveConnections?: boolean) => Promise<void>;
}

/**
 * Bind the server and return a lifecycle handle. Does NOT register signal
 * handlers — those live in main.ts (D-LOCK-8B).
 */
export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const app = buildApp(opts.config, opts.tokenManager, opts.traceWriter);
  const server = srvxServe({
    port: opts.port,
    hostname: opts.host,
    fetch: app.fetch,
    silent: true,
  }) as SrvxServerLike;

  await server.ready();

  // Resolve bound URL + port (works for port: 0 ephemeral too).
  const rawUrl = (server.url ?? `http://${opts.host}:${opts.port}/`).replace(
    /\/$/,
    "",
  );
  let port = opts.port;
  try {
    const u = new URL(rawUrl);
    if (u.port !== "") port = Number.parseInt(u.port, 10);
  } catch {
    /* keep opts.port */
  }

  let closed = false;
  const close = async (closeOpts?: { graceMs?: number }): Promise<void> => {
    if (closed) return;
    closed = true;
    const graceMs = closeOpts?.graceMs ?? 30_000;
    debug.on(
      LEVEL_VERBOSE,
      () => `server.close: graceMs=${graceMs}; awaiting drain`,
    );
    // srvx's `close(true)` immediately terminates in-flight; `close(false)`
    // is best-effort drain. We race a graceful close against graceMs and
    // fall back to forced close.
    const graceful = server.close(false);
    let forcedTimer: ReturnType<typeof setTimeout> | null = null;
    const forced = new Promise<void>((resolve) => {
      forcedTimer = setTimeout(() => {
        void server.close(true).then(() => resolve());
      }, graceMs);
    });
    try {
      await Promise.race([graceful, forced]);
    } finally {
      if (forcedTimer !== null) clearTimeout(forcedTimer);
    }
    // Make sure server is fully closed even if we raced.
    try {
      await server.close(true);
    } catch {
      /* already closed */
    }
  };

  return {
    url: rawUrl,
    port,
    close,
    server,
  };
}
