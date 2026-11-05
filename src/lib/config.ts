/**
 * config.ts — YAML config loader with hot-reload, LKG fallback, and per-stream
 * snapshot semantics.
 *
 * **Scope (M1a + M1b + M5 D-LOCK-3):**
 *   - Parse YAML → zod-validate → expose typed `Config`.
 *   - Hot-reload via a 3-tier watcher fallback chain (M1b extension):
 *       1. **chokidar fast-path** (preferred) — dynamic import; reliable on
 *          Bun-on-Windows where bare `fs.watch` misses rename events (O8).
 *       2. **polling fallback** — `setInterval` + `fs.stat` mtime check
 *          (default 5000ms, configurable via `pollIntervalMs`). Used when
 *          chokidar import fails OR chokidar's `add()` errors at runtime.
 *       3. **bare `fs.watch`** — final fallback if both above fail. Same
 *          behavior as the M1a-original implementation. Belt-and-suspenders.
 *     The chosen path is logged via `debug.ts`. Disabled by `watch: false`
 *     constructor opt or by setting env `COPILOT_PROXY_NO_WATCH=1`.
 *   - LKG (last-known-good) fallback: if a reload's parse OR validate fails,
 *     log via `debug.ts` and retain the previously-validated config in memory.
 *     Never throw on a bad config update mid-run (N9). On a SUCCESSFUL
 *     reload (per F6 in M3), `doReload` ALSO clears the predicate compile
 *     cache via `transform/predicate.reset()` so listeners that immediately
 *     re-evaluate predicates see a fresh cache (no stale glob/regex from
 *     the old config interpretation).
 *   - Per-stream snapshot semantics (D-REQ-3, refined by D23 + C1 fix):
 *     stream-id is opaque to this module; caller (M2 engine) provides it.
 *     `snapshot(streamId)` returns the current `{config}` tuple and stores it
 *     in a `Map<string, ConfigSnapshot>`. `release(streamId)` removes it.
 *     **Deliberately NOT a `WeakMap<string, ...>`** — WeakMap requires object
 *     keys; passing a string throws TypeError at runtime. C1 fix.
 *
 * **M5 D-LOCK-3 schema unification:** The canonical `ConfigSchema` lives in
 * `~/types/config-schema.ts` (the M4-shipped full schema with routes +
 * transforms + logging + auth + the M5-added server section + M1a-compat
 * preprocess for top-level `debug` / `trace_dir`). M1a's previous inline
 * schema was deleted; this module now re-exports the canonical one for
 * back-compat.
 *
 * **Side-effect import note (per M5 spec § D-LOCK-3 M9 / Bootstrap step 5
 * removal):** importing this module transitively imports
 * `~/types/config-schema.ts` which side-effect-imports
 * `~/lib/transform/index.ts` (the auto-generated rule barrel). M5's
 * `main.ts` therefore does NOT need a separate "side-effect import barrel"
 * step — the rule registry is populated as a side effect of importing this
 * config module.
 *
 * **Out of scope:**
 *   - Full per-route + body_rules schemas (now in `~/types/config-schema.ts`)
 *   - Rule registry snapshot (M2 — `ConfigSnapshot` will gain a `rules`
 *     field then; for M1a it carries `config` only)
 */

import {
  promises as fs,
  watch as fsWatch,
  type FSWatcher,
  type Stats,
} from "node:fs";

import YAML from "yaml";

import { LEVEL_ON, debug } from "./debug.ts";
import { validateResponseShape } from "./transform/_validate_response_shape.ts";
import { snapshot, list } from "./transform/registry.ts";

// M5 D-LOCK-3: canonical ConfigSchema is in ~/types/config-schema.ts. We
// re-export it (and the inferred Config type) so M1a-vintage importers of
// `lib/config.ts` keep compiling. The hot-reload + LKG + watcher machinery
// below is schema-agnostic.
import { ConfigSchema, type Config, type Rule } from "~/types/config-schema.ts";

export { ConfigSchema };
export type { Config };

/**
 * **M9 D-LOCK-14 — hard-fail validation error class.**
 *
 * Thrown by `loadAndValidate` (post-zod-parse) when `validateResponseShape`
 * reports any failures (a body `redirect_to_*` rule declares a
 * `response_shape` that no `response_rules` entry on the same route
 * consumes).
 *
 * The class is distinguished from generic config errors so that
 * `src/main.ts loadConfig()`'s catch block (per D-LOCK-14) can distinguish
 * a hard-fail (`process.exit(1)`) from a transient parse error (LKG
 * fallback). Without this distinction the silent LKG-fallback path would
 * defeat the validator's purpose by booting with empty defaults.
 *
 * Cross-references: M9 task spec § D-LOCK-13 / D-LOCK-14;
 * `_validate_response_shape.ts` for the underlying validator.
 */
export class ValidationHardFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationHardFailError";
  }
}

/** Reloaded-config event listener type. */
export type ReloadListener = () => void;

/**
 * Snapshot of the config at a given moment in time. Held by per-stream state
 * in the M2 engine so that mid-stream reloads don't surprise in-flight requests.
 *
 * M2 will extend this with `rules: Map<string, RegisteredRule>` per O4. For M1a
 * the snapshot is config-only.
 */
export interface ConfigSnapshot {
  config: Config;
}

/** Constructor options for `ConfigManager`. */
export interface ConfigManagerOptions {
  /** Absolute path to the YAML file. */
  path: string;
  /** Default true; pass false to disable fs.watch (test ergonomics). */
  watch?: boolean;
  /** Debounce window (ms) for fs.watch coalescing. Default 200. */
  debounceMs?: number;
  /**
   * Polling interval (ms) for the polling fallback tier. Default 5000.
   * Only consulted when chokidar is unavailable OR `forcePolling: true`.
   */
  pollIntervalMs?: number;
  /**
   * Skip the chokidar fast-path and go straight to the polling fallback.
   * Test ergonomics — lets `tests/lib/config.test.ts` exercise the polling
   * branch without needing to uninstall chokidar.
   */
  forcePolling?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Synchronous load + validate cycle. Returns the validated Config, or throws
 * on parse / validate failure. Used internally by `ConfigManager`.
 *
 * **M9 D-LOCK-13/14 post-zod-parse validation.** After zod accepts the
 * config, walk each route and call `validateResponseShape(body_rules,
 * response_rules, bodySnap, bodySnap)` (the validator co-registers on the
 * body surface; per `_validate_response_shape.ts` both args use the same
 * snapshot). Any failures are joined into a single `ValidationHardFailError`
 * with a descriptive message identifying the offending route + rule + the
 * unmet shape. `src/main.ts loadConfig()` catches this class specifically
 * and `process.exit(1)`s rather than silently LKG-falling-back to defaults.
 */
async function loadAndValidate(filePath: string): Promise<Config> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed: unknown = YAML.parse(raw);
  // zod returns a typed object; treat parse failure as throw.
  const cfg = ConfigSchema.parse(parsed ?? {});

  // M9 D-LOCK-13/14: per-route response-shape validation. Co-located with
  // load so a bad config never reaches in-flight requests.
  const bodySnap = snapshot("body");
  const streamEventSnap = snapshot("stream_event");
  const allFailures: string[] = [];
  for (const route of cfg.routes) {
    const failures = validateResponseShape(
      route.body_rules as unknown as Rule[],
      route.response_rules as unknown as Rule[],
      bodySnap,
      bodySnap, // response rules co-register on body surface per D-LOCK-13
    );
    if (failures.length > 0) {
      const routeLabel = `${route.match.method ?? "POST"} ${route.match.path}${
        route.match.model_pattern !== undefined
          ? ` (model_pattern=${route.match.model_pattern})`
          : ""
      }`;
      for (const f of failures) {
        allFailures.push(`route ${routeLabel}: ${f.message}`);
      }
    }

    // M10 D-LOCK-6 / C2 fix: validate stream_event_rules against the
    // stream-event registry. The zod-parse layer ALREADY rejects unknown
    // names + names that are body-registered; this is the secondary
    // structural defense (mirrors `validateResponseShape` pattern).
    const streamFailures = validateStreamEventRules(
      route.stream_event_rules as unknown as Rule[],
      streamEventSnap,
      bodySnap,
    );
    if (streamFailures.length > 0) {
      const routeLabel = `${route.match.method ?? "POST"} ${route.match.path}${
        route.match.model_pattern !== undefined
          ? ` (model_pattern=${route.match.model_pattern})`
          : ""
      }`;
      for (const f of streamFailures) {
        allFailures.push(`route ${routeLabel}: ${f}`);
      }
    }
  }
  if (allFailures.length > 0) {
    throw new ValidationHardFailError(
      `Config validation failed (${allFailures.length} issue${allFailures.length === 1 ? "" : "s"}):\n  ${allFailures.join("\n  ")}`,
    );
  }
  return cfg;
}

/**
 * **M10 D-LOCK-6 — secondary structural validator for `stream_event_rules`.**
 *
 * Walks each rule in `streamEventRules` and verifies its `use:` value is
 * present in the stream-event registry. The zod-parse layer (per
 * `config-schema.ts § buildStreamEventRuleSchema`) already rejects unknown
 * names + emits cross-registry suggestions when a body-rule name lands in
 * `stream_event_rules`. This helper exists so a future code path that
 * constructs a Route in code (bypassing zod-parse) still gets the same
 * structural guarantees, and so `loadAndValidate`'s failure-collection
 * loop has parity with `validateResponseShape`.
 *
 * Returns human-readable error messages (one per failed rule). Empty array
 * = all rules valid.
 *
 * **Error message contract.** Body-rule-name in `stream_event_rules`
 * carries the SAME cross-registry NOTE as the zod-parse layer; unknown
 * names list registered alternatives.
 */
export function validateStreamEventRules(
  streamEventRules: Rule[],
  streamEventSnapshot: ReadonlyMap<string, { fn: unknown; schema: unknown }>,
  bodySnapshot: ReadonlyMap<string, { fn: unknown; schema: unknown }>,
): string[] {
  const failures: string[] = [];
  const streamRegisteredNames = list("stream_event");
  const bodyRegisteredNames = list("body");
  for (const rule of streamEventRules) {
    if (typeof rule.use !== "string") {
      failures.push(`stream_event_rules entry missing 'use' field`);
      continue;
    }
    if (!streamEventSnapshot.has(rule.use)) {
      // Cross-registry: if it IS a body-rule name, point operator to the
      // right config section.
      if (
        bodySnapshot.has(rule.use) ||
        bodyRegisteredNames.includes(rule.use)
      ) {
        failures.push(
          `stream_event_rules entry '${rule.name ?? rule.use}' uses '${rule.use}' which IS registered as a body rule — did you mean to put it in body_rules or header_rules instead of stream_event_rules?`,
        );
        continue;
      }
      failures.push(
        `stream_event_rules entry '${rule.name ?? rule.use}' uses unknown stream-event rule '${rule.use}'. Registered stream-event rules: ${streamRegisteredNames.length > 0 ? streamRegisteredNames.map((r) => `'${r}'`).join(", ") : "(none)"}`,
      );
    }
  }
  return failures;
}

/** Internal disposer signature for whichever watcher tier attached. */
type WatcherDisposer = () => Promise<void> | void;

/**
 * The configuration manager. One instance per running process.
 *
 * Lifecycle:
 *   const cm = new ConfigManager({ path: "config.yaml" });
 *   await cm.start();
 *   const c = cm.get();
 *   const snap = cm.snapshot("stream-id");  // freeze for in-flight stream
 *   ... do work ...
 *   cm.release("stream-id");                // free the snapshot
 *   await cm.dispose();                     // clean shutdown
 */
export class ConfigManager {
  private readonly opts: Required<ConfigManagerOptions>;
  private current: Config | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<ReloadListener> = new Set();
  // Per-stream snapshots — Map (NOT WeakMap; string key would throw).
  private snapshots: Map<string, ConfigSnapshot> = new Map();
  private started = false;
  // Disposer for whichever watcher tier attached (chokidar / polling / fs.watch).
  private watcherDisposer: WatcherDisposer | null = null;

  constructor(opts: ConfigManagerOptions) {
    const watchEnabled =
      opts.watch !== undefined
        ? opts.watch
        : process.env["COPILOT_PROXY_NO_WATCH"] !== "1";
    this.opts = {
      path: opts.path,
      watch: watchEnabled,
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      forcePolling: opts.forcePolling ?? false,
    };
  }

  /**
   * Initial load + (optionally) attach the file watcher.
   * Throws if the initial config is invalid (caller must handle a hard fail
   * at boot — there is no LKG yet).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.current = await loadAndValidate(this.opts.path);
    this.started = true;
    if (this.opts.watch) await this.attachWatcher();
  }

  /** Read the current (most-recently-validated) config. */
  get(): Config {
    if (!this.current) {
      throw new Error("ConfigManager.get(): not started — call start() first");
    }
    return this.current;
  }

  /**
   * Capture a snapshot of the current config under `streamId`. Subsequent
   * reloads will not affect this snapshot — the M2 engine pins it to an
   * in-flight request/stream.
   *
   * If `streamId` is already snapshotted, this OVERWRITES with a fresh
   * snapshot (the new caller wins; the prior caller is responsible for
   * having released first).
   */
  snapshot(streamId: string): ConfigSnapshot {
    const snap: ConfigSnapshot = { config: this.get() };
    this.snapshots.set(streamId, snap);
    return snap;
  }

  /**
   * Read a previously-captured snapshot. Returns `undefined` if nothing
   * was snapshotted under this id (caller defines whether that's an error).
   */
  getSnapshot(streamId: string): ConfigSnapshot | undefined {
    return this.snapshots.get(streamId);
  }

  /** Release a per-stream snapshot. Idempotent — safe to call twice. */
  release(streamId: string): void {
    this.snapshots.delete(streamId);
  }

  /** Subscribe to validated reload events. Returns an unsubscribe fn. */
  on(event: "reload", cb: ReloadListener): () => void {
    if (event !== "reload") {
      throw new Error(`ConfigManager.on: unknown event "${event}"`);
    }
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Detach the watcher and clear timers. Idempotent. */
  async dispose(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcherDisposer) {
      try {
        await this.watcherDisposer();
      } catch (err) {
        debug.on(
          LEVEL_ON,
          () => `[config] watcher dispose threw: ${String(err)}`,
        );
      }
      this.watcherDisposer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.listeners.clear();
    this.snapshots.clear();
    this.started = false;
  }

  /**
   * Attach a watcher using the 3-tier fallback chain (M1b extension):
   *   1. chokidar fast-path — preferred; reliable on Bun-on-Windows (O8).
   *   2. polling fallback — `fs.stat` mtime check at `pollIntervalMs`.
   *   3. bare `fs.watch` — last-resort fallback; M1a-original behavior.
   *
   * Each tier is tried in order and the first success wins. If `forcePolling`
   * is set, tier 1 is skipped. The chosen tier is logged via `debug.ts`.
   */
  private async attachWatcher(): Promise<void> {
    if (!this.opts.forcePolling) {
      const okChokidar = await this.tryAttachChokidar();
      if (okChokidar) return;
    }
    const okPolling = this.tryAttachPolling();
    if (okPolling) return;
    this.tryAttachFsWatch();
  }

  /**
   * Tier 1: chokidar fast-path. Returns `true` on success, `false` if the
   * dynamic import or `add()` failed. Awaits chokidar's `ready` event before
   * returning so that the caller's first write after `start()` is reliably
   * observed (chokidar swallows changes during its initial scan).
   */
  private async tryAttachChokidar(): Promise<boolean> {
    try {
      const mod = (await import("chokidar")) as {
        watch: (
          paths: string,
          opts?: Record<string, unknown>,
        ) => {
          on: (event: string, cb: (path?: string) => void) => unknown;
          close: () => Promise<void>;
        };
      };
      const watcher = mod.watch(this.opts.path, {
        ignoreInitial: true,
        awaitWriteFinish: false,
      });
      watcher.on("change", () => this.scheduleReload());
      watcher.on("add", () => this.scheduleReload());
      this.watcherDisposer = async () => {
        await watcher.close();
      };
      // Wait for chokidar's initial-scan to complete; otherwise the very first
      // write after start() can be silently dropped. Time-box to 1500ms so a
      // missing-ready-event doesn't hang start().
      await new Promise<void>((resolve) => {
        let settled = false;
        const onReady = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        watcher.on("ready", onReady);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, 1500);
      });
      debug.on(LEVEL_ON, () => `[config] watcher: chokidar (tier 1)`);
      return true;
    } catch (err) {
      debug.on(
        LEVEL_ON,
        () =>
          `[config] chokidar attach failed, trying polling fallback: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * Tier 2: polling fallback. `setInterval` + `fs.stat` mtime check at
   * `pollIntervalMs` cadence. Returns `true` on success.
   */
  private tryAttachPolling(): boolean {
    try {
      let lastMtimeMs = 0;
      // Best-effort initial stat — failures don't abort attach.
      void fs.stat(this.opts.path).then(
        (st: Stats) => {
          lastMtimeMs = st.mtimeMs;
        },
        () => {
          /* ignore */
        },
      );
      const interval = setInterval(() => {
        void fs.stat(this.opts.path).then(
          (st: Stats) => {
            if (st.mtimeMs !== lastMtimeMs) {
              lastMtimeMs = st.mtimeMs;
              this.scheduleReload();
            }
          },
          () => {
            /* missing-file errors during polling are non-fatal */
          },
        );
      }, this.opts.pollIntervalMs);
      this.watcherDisposer = () => {
        clearInterval(interval);
      };
      debug.on(
        LEVEL_ON,
        () =>
          `[config] watcher: polling (tier 2, ${this.opts.pollIntervalMs}ms)`,
      );
      return true;
    } catch (err) {
      debug.on(
        LEVEL_ON,
        () =>
          `[config] polling attach failed, trying fs.watch fallback: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * Tier 3: bare `fs.watch`. Final fallback; same behavior as M1a-original.
   * No return — best-effort; on failure we log and continue with no
   * hot-reload (better than crashing the proxy).
   */
  private tryAttachFsWatch(): void {
    try {
      this.watcher = fsWatch(this.opts.path, () => this.scheduleReload());
      debug.on(LEVEL_ON, () => `[config] watcher: fs.watch (tier 3)`);
    } catch (err) {
      // Watcher attach failed (file missing, FS doesn't support, etc.).
      // Log and continue with no hot-reload — better than crashing the proxy.
      debug.on(LEVEL_ON, () => `[config] fs.watch failed: ${String(err)}`);
    }
  }

  /** Coalesce burst-rename events into a single reload. */
  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.doReload();
    }, this.opts.debounceMs);
  }

  /**
   * Perform a reload. On parse OR validate failure, log + retain LKG.
   * On success, swap in the new config and notify listeners.
   *
   * **F6 (M3): predicate compile cache reset before listener notify.** Any
   * listener that immediately re-evaluates predicates against the new
   * config sees a fresh cache. Dynamic-import keeps the cycle safe at
   * module-load time — the engine consumes config.ts but predicate.ts is
   * an internal optimization, not part of the consumer surface.
   */
  private async doReload(): Promise<void> {
    try {
      const next = await loadAndValidate(this.opts.path);
      this.current = next;
      // F6 (M3): clear predicate compile cache so glob/regex strings get
      // re-evaluated against the new config interpretation. Done BEFORE
      // listener notify so any listener that immediately re-evaluates
      // predicates sees a fresh cache.
      try {
        const predicate = await import("./transform/predicate.ts");
        predicate.reset();
      } catch (err) {
        debug.on(
          LEVEL_ON,
          () => `[config] predicate cache reset failed: ${String(err)}`,
        );
      }
      for (const cb of this.listeners) {
        try {
          cb();
        } catch (err) {
          debug.on(
            LEVEL_ON,
            () => `[config] reload listener threw: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      // Per N9: never throw on bad config update — keep LKG.
      debug.on(
        LEVEL_ON,
        () =>
          `[config] reload failed; retaining last-known-good. Error: ${String(err)}`,
      );
    }
  }
}
