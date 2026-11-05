/**
 * src/main.ts — sole owner of CLI args, config bootstrap, TokenManager
 * lifecycle, and process signals.
 *
 * Bootstrap order (revised per discriminator findings + M5 D-LOCK-2 / D-LOCK-8B):
 *
 *   1. Parse CLI args (via env vars: --port → COPILOT_PROXY_PORT, etc.).
 *   2. Load config from $COPILOT_PROXY_CONFIG path or PATHS.APP_DIR/config.yaml.
 *      Per D-LOCK-2: missing file → load `{}` and let zod defaults populate.
 *      LKG fallback if file present but invalid.
 *   3. Initialize debug logger from config.logging.level.
 *   4. (REMOVED — was "side-effect import barrel") per discriminator M9:
 *      importing ~/lib/config.ts transitively imports ~/types/config-schema.ts
 *      which already side-effect-imports ~/lib/transform/index.ts. Registry
 *      is populated as a side effect of step 2.
 *   5. Log custom_rules_dir status per D-LOCK-9 (count files; do NOT load).
 *   6. Verify port is free per X17. --allow-port-in-use override → skip check.
 *   7. Construct TokenManager from config.auth (resolve githubTokenPath via
 *      config.auth.github_token_path ?? PATHS.GITHUB_TOKEN_PATH per D-LOCK-2 H2).
 *   8. startServer({ port, host, config, tokenManager }) → ServerHandle.
 *      (Stage 1 complete; <1s.)
 *   9. Register SIGTERM + SIGINT handlers (D-LOCK-8B):
 *        - First signal: await serverHandle.close({ graceMs: 30_000 }) →
 *          tokenManager.dispose() → exit(0).
 *        - Second signal in same window: tokenManager.dispose() → exit(0).
 *  10. Stage 2 (async, fire-and-forget for the bootstrap caller):
 *        await tokenManager.start().catch(err => consola.error(...)).
 *      Status transitions from "starting" → "ready" | "failed".
 *
 * All bootstrap messages via consola (one-time terminal events).
 * All per-step diagnostic via debug.on(LEVEL_VERBOSE, () => ...).
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import consola from "consola";
import YAML from "yaml";

import { TokenManager } from "~/auth/token-manager.ts";
import { UPSTREAM_OVERRIDE_ENV } from "~/auth/upstream-override.ts";
import { OVERRIDE } from "~/auth/api-config.ts";
// Importing lib/config.ts transitively pulls in types/config-schema.ts which
// side-effect-imports lib/transform/index.ts (the auto-generated barrel).
// Registry is populated here without an explicit barrel import (D-LOCK-3 M9).
import { ConfigManager, ValidationHardFailError } from "~/lib/config.ts";
import { installCrashHandlers } from "~/lib/crash.ts";
import { LEVEL_ON, LEVEL_RAW, debug, parseLevel } from "~/lib/debug.ts";
import { PATHS, TRACES_DIR_DEFAULT, ensurePaths, expandTilde } from "~/lib/paths.ts";
import { TraceWriter } from "~/lib/trace.ts";
import { startServer, type ServerHandle } from "~/server.ts";
import { loadCustomRules } from "~/lib/transform/custom-loader.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";
import { applyBetaPolicy, type BetaPolicyMode } from "~/lib/apply-beta-policy.ts";
import { applyInitiatorHeaders } from "~/lib/apply-initiator-headers.ts";
import { fetchModelCatalog } from "~/services/copilot/model-catalog.ts";

// ---- CLI / env arg parsing ------------------------------------------------

const allowPortInUse = process.env["COPILOT_PROXY_ALLOW_PORT_IN_USE"] === "1";
const configPathOverride = process.env["COPILOT_PROXY_CONFIG"];
const portOverride = process.env["COPILOT_PROXY_PORT"];
const hostOverride = process.env["COPILOT_PROXY_HOST"];
// Feature D1 — anthropic-beta policy override. When set to a valid mode it wins
// over config.anthropic_beta.policy; an invalid value fails loud + falls back
// to the config default (see applyBetaPolicy wire-in below).
const betaPolicyOverride = process.env["COPILOT_PROXY_BETA_POLICY"];

// ---- Config load ----------------------------------------------------------

interface LoadedConfig {
  config: Config;
  /** Resolved absolute path used to load the config (no `~` expansion). */
  configPath: string;
}

async function loadConfig(): Promise<LoadedConfig> {
  const configPath =
    configPathOverride ?? path.join(PATHS.APP_DIR, "config.yaml");

  // Per D-LOCK-2 H1: missing file → defaults; never throw on missing config.
  if (!existsSync(configPath)) {
    consola.info(
      `config: no config.yaml found at ${configPath}; using zod defaults (no routes; passthrough only)`,
    );
    return { config: ConfigSchema.parse({}), configPath };
  }

  // File present — load + validate. Use ConfigManager for hot-reload + LKG.
  // For M5 we just need the snapshot; ConfigManager lifecycle is set up below.
  try {
    const cm = new ConfigManager({ path: configPath, watch: false });
    await cm.start();
    const cfg = cm.get();
    await cm.dispose();
    return { config: cfg, configPath };
  } catch (err) {
    // Per M9 D-LOCK-14: ValidationHardFailError MUST exit non-zero
    // (don't fall back to LKG). The validator's purpose is to refuse
    // to boot a config that wires redirect rules without matching
    // response-side consumer rules — silently LKG-falling-back to
    // empty defaults defeats that purpose by booting with no routes
    // and silently mis-forwarding traffic.
    if (err instanceof ValidationHardFailError) {
      consola.error(`config: hard-fail validation:\n${err.message}`);
      process.exit(1);
    }
    // Existing LKG-fallback for other (transient) errors per D-LOCK-2 H1.
    consola.error(
      `config: failed to load ${configPath}; falling back to defaults. Error:`,
      err instanceof Error ? err.message : String(err),
    );
    return { config: ConfigSchema.parse({}), configPath };
  }
}

// ---- Port-free check (per X17) -------------------------------------------

async function ensurePortFree(port: number, host: string): Promise<void> {
  if (allowPortInUse || port === 0) return;
  try {
    // Try Bun.serve first (fast path).
    const probe = (Bun as unknown as {
      serve: (opts: {
        port: number;
        hostname: string;
        fetch: () => Response;
      }) => { stop: (closeActiveConnections: boolean) => void };
    }).serve({
      port,
      hostname: host,
      fetch: () => new Response("probe"),
    });
    probe.stop(true);
    return;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "EADDRINUSE") {
      consola.error(
        `Port ${port} is already in use. Pass COPILOT_PROXY_ALLOW_PORT_IN_USE=1 to skip this check, or stop the existing listener.`,
      );
      process.exit(1);
    }
    // Fall back to net.createServer probe if Bun.serve probe failed for a
    // different reason.
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve) => {
      const probe2 = createServer();
      probe2.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          consola.error(
            `Port ${port} is already in use. Pass COPILOT_PROXY_ALLOW_PORT_IN_USE=1 to skip this check.`,
          );
          process.exit(1);
        }
        resolve();
      });
      probe2.once("listening", () => {
        probe2.close(() => resolve());
      });
      probe2.listen(port, host);
    });
  }
}

// Make YAML name-only used so eslint doesn't flag (we keep the import for
// potential future schema dump; harmless).
void YAML;

// ---- Main ----------------------------------------------------------------

interface ProxyMeta {
  pid: number;
  port: number;
  host: string;
  config_path: string;
  trace_dir: string | null;
  started_at: string;
  schema_version: number;
  models: string[] | null;
  models_count: number | null;
  models_fetched_at: string | null;
}

async function writeMeta(metaPath: string, meta: ProxyMeta): Promise<void> {
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * On TokenManager ready: fetch the upstream Copilot model catalog, log it, and
 * augment meta.json (+ write the full raw catalog to a sibling file). FULLY
 * non-fatal — a `/models` hiccup must never take the proxy down (it swallows
 * its own errors so the Stage-2 `.catch` only sees a `start()` failure).
 */
async function recordModelCatalog(
  config: Config,
  tokenManager: TokenManager,
  metaPath: string,
  baseMeta: ProxyMeta,
): Promise<void> {
  try {
    if (tokenManager.getStatus() !== "ready") return;
    const snapshot = tokenManager.getTokenForRequest();
    if (snapshot === null) return;
    const cat = await fetchModelCatalog({
      config,
      copilotToken: snapshot.token,
      tokenManager,
    });
    consola.info(`Copilot models (${cat.count}): ${cat.ids.join(", ")}`);
    await writeMeta(metaPath, {
      ...baseMeta,
      models: cat.ids,
      models_count: cat.count,
      models_fetched_at: new Date().toISOString(),
    });
    await writeFile(
      path.join(PATHS.APP_DIR, "logs", "copilot-proxy.models.json"),
      JSON.stringify(cat.raw, null, 2),
      "utf-8",
    );
  } catch (err) {
    consola.warn(
      `model catalog fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * `--list-models` path: load config, bring up a TokenManager (may trigger the
 * device-code flow for a fresh OAuth identity — intended, so operators can log
 * in a new login and inspect its catalog), print model ids to stdout (one per
 * line, greppable), and exit. Binds NO port and writes NO meta.json — read-only,
 * safe to run alongside a live proxy.
 */
async function runListModels(): Promise<void> {
  const { config } = await loadConfig();
  debug.setLevel(parseLevel(config.logging.level));
  await ensurePaths();

  const githubTokenPath =
    config.auth.github_token_path ?? PATHS.GITHUB_TOKEN_PATH;
  const tokenManager = new TokenManager({
    githubTokenPath,
    accountType: config.auth.account_type,
    vsCodeVersion: config.auth.vs_code_version,
  });

  try {
    await tokenManager.start();
    const snapshot = tokenManager.getTokenForRequest();
    if (tokenManager.getStatus() !== "ready" || snapshot === null) {
      consola.error(
        `--list-models: token not ready (status=${tokenManager.getStatus()}); cannot list models.`,
      );
      tokenManager.dispose();
      process.exit(1);
    }
    const cat = await fetchModelCatalog({
      config,
      copilotToken: snapshot.token,
      tokenManager,
    });
    tokenManager.dispose();
    // Header on STDERR so STDOUT is ids-only (greppable / diffable between
    // OAuth identities). Single write + flush-then-exit to avoid Windows
    // stdout truncation on process.exit.
    process.stderr.write(
      `# ${cat.count} models for account_type=${config.auth.account_type}\n`,
    );
    const out = cat.ids.length > 0 ? `${cat.ids.join("\n")}\n` : "";
    process.stdout.write(out, () => process.exit(0));
  } catch (err) {
    consola.error(
      `--list-models failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    tokenManager.dispose();
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Install crash handlers FIRST so they cover bootstrap + the un-awaited
  // background work (tokenManager.start, retention sweep, trace writes). They
  // record a structured marker + log + exit(1) — forensics only, no restart
  // (task #4, Option B). writeCrashMarkerSync mkdirs its own dir, so this is
  // safe even before ensurePaths() runs.
  installCrashHandlers({ crashPath: PATHS.CRASH_PATH });

  // Upstream override — refuse a malformed value, announce a live one.
  //
  // PLACED FIRST, before the `--list-models` branch and before config load, auth,
  // or any filesystem side effect. It originally sat after `loadConfig()`, and the
  // cross-family gate showed that left `--list-models` OUTSIDE the gate entirely:
  // that branch returns at the top of `main()`, brings up a TokenManager and calls
  // `fetchModelCatalog`, which composes through `copilotBaseUrl` — so a VALID
  // override silently repointed the model catalog with no warning, and a MALFORMED
  // one was never refused on that path. An operator reading a stub's catalog while
  // believing it is Copilot's is a D9 silent-rewrite. `OVERRIDE` is captured at
  // `api-config.ts` module load and needs no config, so this block CAN run before
  // everything, and therefore does.
  //
  // ⚠ THE TWO ARMS ARE ADJACENT, NOT MACHINE-ENFORCED — an earlier version of this
  // comment claimed they were "two arms of one switch" and therefore that omitting
  // the announcement was structurally impossible. That was FALSE and the gate said
  // so: deleting the `ok` arm leaves `OVERRIDE` still referenced by the `error`
  // arm, so `noUnusedLocals` does not fire, typecheck passes, and the announcement
  // disappears silently — which is precisely the defect this design was supposed to
  // close (a proxy talking to an operator-supplied host while printing nothing).
  // What actually guards it is `tests/auth/main-override-boot.test.ts`, which spawns
  // a child per arm and fails if either behaviour is removed. Detected, not claimed.
  if (OVERRIDE.kind === "error") {
    consola.error(
      `${UPSTREAM_OVERRIDE_ENV} is invalid: ${OVERRIDE.reason} ` +
        `(value: ${JSON.stringify(OVERRIDE.safeValue)}). Refusing to start — unset it ` +
        `or give it an absolute http(s) origin with no path, query or credentials.`,
    );
    // SET THE CODE AND RETURN — do NOT call `process.exit(1)` here.
    //
    // `process.exit()` does not drain an async stdio pipe, and stderr IS a pipe
    // whenever the proxy is spawned rather than attached to a TTY — which is how
    // the start script, the logon Scheduled Task and these tests all run it. So
    // an immediate exit can truncate the one message an operator most needs.
    // This file already knows that hazard: `runListModels` guards it explicitly
    // ("Single write + flush-then-exit to avoid Windows stdout truncation on
    // process.exit"), and the refusal path did not. Same file, same author, one
    // guarded and one not — found by the cross-family gate.
    //
    // Returning is the better of the two available fixes. Nothing has started
    // at this point in `main()` — no server, no TokenManager, no timer — so the
    // loop drains and the process exits with this code on its own. A callback-
    // based flush would still be a promise that the callback fires.
    //
    // ⚠ WHAT THIS DOES *NOT* CLAIM, because round 3 of the gate refuted the
    // absolute form this comment used to state. It ALLOWS normal shutdown to
    // drain stderr; it does not prove truncation is impossible. No test
    // distinguishes the two variants — the mutation reverting this to
    // `process.exit(1)` SURVIVED the suite, because both forms emit the line
    // under test conditions and the difference is timing-dependent. Bun's and
    // consola's flushing semantics are not asserted anywhere here, and neither
    // is the absence of every module-level handle that could hold the loop
    // open. This is a strictly-safer default, not a guarantee.
    process.exitCode = 1;
    return;
  }
  if (OVERRIDE.kind === "ok") {
    consola.warn(
      `UPSTREAM OVERRIDE ACTIVE — every Copilot request goes to ` +
        `${OVERRIDE.baseUrl}, NOT to the real Copilot API.`,
    );
    consola.warn(
      `Set by ${UPSTREAM_OVERRIDE_ENV}. Unset it and restart to reach Copilot.`,
    );
  }

  if (process.argv.includes("--list-models")) {
    await runListModels();
    return;
  }

  const { config, configPath } = await loadConfig();

  // Initialize debug from config.logging.level (canonical path per D-LOCK-3).
  debug.setLevel(parseLevel(config.logging.level));

  // (Step 4 removed — registry populated transitively per D-LOCK-3 M9.)

  // (F-DISC-11) Always announce loaded config path on success — operators
  // need a hard signal that hot-reload is OFF (changes require restart). The
  // one exception is `logging.level`, now runtime-togglable via the admin
  // endpoint (dynamic logging toggle) — called out so operators don't restart
  // just to flip trace capture. (The "(changes require restart)" phrase is
  // kept intact for the trace_wiring restart-banner regression test.)
  consola.info(
    `config: loaded from ${configPath} (changes require restart). ` +
      `Exception: logging.level is runtime-togglable via POST /admin/logging (no restart).`,
  );

  // Feature D1 — resolve + apply the anthropic-beta policy IN-MEMORY, BEFORE
  // startServer captures `config` by closure (header_rules are boot-frozen).
  // Precedence: COPILOT_PROXY_BETA_POLICY env overrides config.anthropic_beta.policy.
  // An invalid env value fails LOUD (consola.error) + falls back to the config
  // default — it never crashes the proxy.
  const BETA_POLICY_MODES: readonly BetaPolicyMode[] = [
    "denylist",
    "allowlist",
    "strip_all",
  ];
  let betaMode: BetaPolicyMode = config.anthropic_beta.policy;
  let betaSource = "config default";
  if (betaPolicyOverride !== undefined) {
    if ((BETA_POLICY_MODES as readonly string[]).includes(betaPolicyOverride)) {
      betaMode = betaPolicyOverride as BetaPolicyMode;
      betaSource = "COPILOT_PROXY_BETA_POLICY env";
    } else {
      consola.error(
        `COPILOT_PROXY_BETA_POLICY='${betaPolicyOverride}' is invalid ` +
          `(expected one of ${BETA_POLICY_MODES.join(", ")}); ` +
          `falling back to config default '${config.anthropic_beta.policy}'.`,
      );
    }
  }
  applyBetaPolicy(config, betaMode);
  consola.info(`anthropic-beta policy: ${betaMode} (source: ${betaSource})`);

  // Copilot client fidelity — inject the x-initiator / x-interaction-type
  // derive rule into the Anthropic lanes IN-MEMORY, also before startServer
  // captures `config`. install_bundle.ps1 places config.yaml only if absent,
  // so a provisioned machine never picks up the config/default.yaml wiring;
  // this injection is what reaches the fleet. See lib/apply-initiator-headers.ts.
  applyInitiatorHeaders(config);

  consola.info(
    "x-initiator / x-interaction-type: derived per-request on the Anthropic lanes (Copilot client fidelity)",
  );

  // (F-DISC-9, F-DISC-13, F-DISC-15, F-DISC-3, F-DISC-8 wiring)
  //
  // Dynamic logging toggle (no restart): the TraceWriter is now created
  // UNCONDITIONALLY — regardless of the boot `logging.level` — and always
  // passed to startServer. This lets `POST /admin/logging {"level":"raw"}`
  // start capturing at runtime with no restart: with-trace.ts / forward-stream.ts
  // gate every write live on `debug.getLevel() >= LEVEL_RAW`, so booting below
  // raw leaves the always-present writer simply never invoked (zero hot-path
  // cost). `init()` (F-DISC-13 counter seed) + the daily retention sweep run
  // regardless — both are cheap + idempotent. The PII warning + "writing to …"
  // line are still emitted ONLY when booting AT raw/verbose; below raw we log
  // that capture is available via the admin endpoint instead.
  const bootAtRaw = parseLevel(config.logging.level) >= LEVEL_RAW;
  let traceWriter: TraceWriter | undefined;
  let resolvedTraceDir: string | undefined;
  if (bootAtRaw) {
    consola.warn(
      "WARNING: raw mode captures full request/response bodies including " +
        "prompt content. Do not enable raw mode in environments processing " +
        "PII without compensating controls.",
    );
  }

  resolvedTraceDir = expandTilde(config.logging.trace_dir ?? TRACES_DIR_DEFAULT);

  try {
    await mkdir(resolvedTraceDir, { recursive: true });
    const w = new TraceWriter(resolvedTraceDir, {
      rotation: {
        daily: true,
        warn_size_mb: config.logging.warn_size_mb,
        retention_days: config.logging.retention_days,
      },
    });
    // (F-DISC-13) seed counter from disk so post-restart writes resume
    // monotonically (never overwrite earlier flow files).
    await w.init();
    traceWriter = w;
    if (bootAtRaw) {
      consola.info(
        `trace: writing to ${resolvedTraceDir} (level=${config.logging.level}, ` +
          `warn_size_mb=${config.logging.warn_size_mb}, ` +
          `retention_days=${config.logging.retention_days}, ` +
          `stream_buffer_mb=${config.logging.stream_buffer_mb})`,
      );
    } else {
      consola.info(
        `trace: capture available via POST /admin/logging (currently ${config.logging.level}); ` +
          `trace_dir=${resolvedTraceDir} (warn_size_mb=${config.logging.warn_size_mb}, ` +
          `retention_days=${config.logging.retention_days}, ` +
          `stream_buffer_mb=${config.logging.stream_buffer_mb})`,
      );
    }

    // (F-DISC-8) schedule retention sweep daily; run once at startup so
    // the first invocation is not 24h after boot. Runs regardless of boot
    // level now (the writer always exists) — cheap + idempotent.
    const intervalHandle = setInterval(
      () => {
        void traceWriter?.runRetention().catch((err) => {
          debug.on(
            LEVEL_ON,
            () => `[trace] retention sweep failed: ${String(err)}`,
          );
        });
      },
      24 * 60 * 60 * 1000,
    );
    // Don't keep the event loop alive just for retention.
    if (typeof intervalHandle.unref === "function") intervalHandle.unref();
    void traceWriter.runRetention().catch((err) => {
      debug.on(
        LEVEL_ON,
        () => `[trace] startup retention sweep failed: ${String(err)}`,
      );
    });
  } catch (err) {
    consola.error(
      `trace: cannot create ${resolvedTraceDir}: ${err instanceof Error ? err.message : String(err)}; trace writing DISABLED for this session`,
    );
    traceWriter = undefined;
  }

  // M9 D-LOCK-5/15: load operator-supplied drop-in rules (LKG-style; never
  // throws — bad plugins are skipped with reason logged). Replaces M5's
  // deferred logCustomRulesStatus stub. The loader uses pathToFileURL for
  // Windows ESM compatibility + counts-changed semantics to detect plugins
  // that imported cleanly but registered nothing.
  const loadResult = await loadCustomRules(config.transforms.custom_dir);
  debug.on(
    LEVEL_ON,
    () =>
      `[custom-loader] loaded ${loadResult.loaded.length}, skipped ${loadResult.skipped.length}`,
  );
  if (loadResult.skipped.length > 0) {
    for (const s of loadResult.skipped) {
      debug.on(LEVEL_ON, () => `[custom-loader] skipped ${s.path}: ${s.reason}`);
    }
  }

  const port = portOverride !== undefined ? Number(portOverride) : config.server.port;
  const host = hostOverride ?? config.server.host;

  await ensurePortFree(port, host);

  // Per discriminator iter-1 C1: ensurePaths() MUST run before constructing
  // TokenManager. Otherwise a fresh install with no
  // ~/.local/share/copilot-proxy/ directory will fail Stage 2 — device-code
  // completes, then writeGithubToken's fs.writeFile throws ENOENT because
  // the parent directory does not exist; status flips to "failed"
  // permanently and restart loops the same failure.
  await ensurePaths();

  // Resolve GitHub token path with config-override fallback per D-LOCK-2 H2.
  const githubTokenPath =
    config.auth.github_token_path ?? PATHS.GITHUB_TOKEN_PATH;

  const tokenManager = new TokenManager({
    githubTokenPath,
    accountType: config.auth.account_type,
    vsCodeVersion: config.auth.vs_code_version,
  });

  // Stage 1: bind server. Routes return 503 auth_pending until status===ready.
  const handle: ServerHandle = await startServer({
    port,
    host,
    config,
    tokenManager,
    traceWriter,
  });
  consola.info(`copilot-proxy listening on ${handle.url} (stage 1; auth pending)`);

  // (F-DISC-12) write meta.json so PowerShell scripts (Group D) can read
  // the resolved config_path + trace_dir without parsing YAML. The existing
  // start_proxy_no_rollback.ps1 writes its OWN meta.json at <repo>/logs/...;
  // ours lives under PATHS.APP_DIR (a different absolute path) so the two
  // don't collide. Group D will reconcile the paths in PowerShell.
  // schema_version 3 adds models/models_count/models_fetched_at (populated
  // asynchronously by recordModelCatalog once auth is ready). PS readers
  // tolerate extra keys, so the bump stays backward-compatible.
  const metaPath = path.join(PATHS.APP_DIR, "logs", "copilot-proxy.meta.json");
  const baseMeta: ProxyMeta = {
    pid: process.pid,
    port: handle.port,
    host,
    config_path: configPath,
    // trace_dir reflects boot-time capture state: the resolved dir when
    // booting at raw+, else null. The writer now always exists (for the
    // runtime toggle), but at boot-below-raw nothing is captured yet — keep
    // the historical "null = not capturing at boot" meta.json contract.
    trace_dir: bootAtRaw ? (resolvedTraceDir ?? null) : null,
    started_at: new Date().toISOString(),
    schema_version: 3,
    models: null,
    models_count: null,
    models_fetched_at: null,
  };
  try {
    await writeMeta(metaPath, baseMeta);
  } catch (err) {
    consola.warn(
      `meta.json sidecar write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Register signal handlers (D-LOCK-8B). main.ts is the SOLE owner.
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (shuttingDown) {
      consola.warn(
        `Second ${sig} received; force-closing without grace period.`,
      );
      try {
        tokenManager.dispose();
      } catch {
        /* idempotent */
      }
      process.exit(0);
      return;
    }
    shuttingDown = true;
    consola.info(`Received ${sig}; draining (30s grace).`);
    void (async () => {
      try {
        await handle.close({ graceMs: 30_000 });
      } catch (err) {
        consola.error("server.close threw:", err);
      }
      try {
        tokenManager.dispose();
      } catch {
        /* idempotent */
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Stage 2: async start TokenManager. Routes start serving when status===ready.
  // On ready, record the upstream model catalog (log + meta.json augment).
  // recordModelCatalog swallows its own errors, so only a genuine start()
  // failure reaches the .catch below.
  void tokenManager
    .start()
    .then(() => recordModelCatalog(config, tokenManager, metaPath, baseMeta))
    .catch((err) => {
      consola.error(
        "TokenManager.start() failed; service will return 503 until restart:",
        err instanceof Error ? err.message : String(err),
      );
    });
}

void main().catch((err) => {
  consola.error("Fatal bootstrap error:", err);
  process.exit(1);
});
