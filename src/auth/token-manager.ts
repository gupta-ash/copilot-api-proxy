// NEW — no upstream equivalent.
// Replaces upstream's bare `setInterval`-based refresh pattern (src/lib/token.ts in
// xianml/copilot-api-pro@f212832) with an explicit class that enforces:
//   - O5: singleflight refresh dedup (50 concurrent refresh() calls → 1 fetch).
//   - O11 Layer A: bounded retry with exponential backoff + fail-open with cached token.
//   - N10 (revised): getTokenForRequest() returns the cache snapshot at the instant of
//     call. M5 builds the mid-stream re-issue loop on top.
//   - D17 P3: no global state singleton. All inputs come through the constructor.
//
// M4.5 amendments (audit reports m4-audit-2026-04-30/{same-family,cross-model}):
//   - F1/H1/H4: AbortSignal threaded through `fetchCopilotToken` and `sleep`; one
//     unified `abortController` field allocated by `newAbortController()`, reset
//     per `_doRefresh` invocation, and reused inside `loadOrAcquireGithubToken`.
//   - H2: explicit dispose-during-refresh policy. dispose() rejects pending refresh;
//     a successful fetch that resolves AFTER dispose is detected by the post-fetch
//     disposal check and discarded with `TokenManagerDisposedError`.
//   - H3: constructor invariants — `retryAttempts >= 1` (positive integer) and
//     `retryBackoffMs.length >= 1`. Operator misconfig fails fast at construction.
//   - F5: disposal mid-loop is terminal (re-thrown) rather than treated as transient
//     retry-able failure.
//   - F6/F12: `defaultSleep` removed; canonical signal-aware `sleep` lives in
//     `~/lib/sleep.ts` and is shared with `poll-access-token.ts`.
//   - F8/M1: cached token is `Object.freeze`d before assignment + `CopilotToken`
//     fields are `readonly`. Snapshot semantics enforced structurally.
//
// M5 amendments (m5-routes-services.md):
//   - D-LOCK-4: 3 plain-Error throws of "TokenManager disposed" replaced with
//     `throw new TokenManagerDisposedError()` (sentinel class). Message preserved.
//   - D-LOCK-2: NEW `getStatus()` method returning the lifecycle enum
//     "uninitialized" | "starting" | "ready" | "failed" | "disposed". Does NOT
//     consult `throwIfDisposed()` (route handlers call it synchronously to gate
//     503 vs proceed; throwing would crash the handler with 500). Status reflects
//     last-observed start/refresh/dispose ONLY; per-request 401-retry failures do
//     NOT flip ready→failed (those surface 401 to the client; status only tracks
//     auth subsystem bootstrap + disposal).
//   - F7: `start()` is now singleflight (in-flight inflightStart promise dedups
//     concurrent callers). Existing idempotent semantics preserved (started → return).
//   - F10/M2/M5 log hygiene: per-attempt `consola.error` demoted to
//     `debug.on(LEVEL_VERBOSE, () => ...)` with structured payload
//     `{ attempt, total, error, request_id? }`. Final fail-open `consola.warn` and
//     exhausted `TokenRefreshExhaustedError` throw stay as user-visible terminal events.

/**
 * token-manager.ts — Copilot token lifecycle owner.
 *
 * The proxy holds **two** tokens:
 *
 *   1. **GitHub OAuth token** — long-lived, persisted to disk
 *      (`PATHS.GITHUB_TOKEN_PATH`, mode 0o600). Acquired via the device-code
 *      flow on first run; never refreshed (only re-acquired if invalidated).
 *
 *   2. **Copilot-Ent token** — short-lived (~60 minute TTL), in-memory only.
 *      Fetched on-demand from `api.github.com/copilot_internal/v2/token` using
 *      the GitHub OAuth token as the credential.
 *
 * `TokenManager` owns both. Its public surface is:
 *
 *   - `start()` — load (or acquire) the GitHub token, then fetch initial
 *     Copilot token. Idempotent + singleflight (M5 F7).
 *   - `getTokenForRequest()` — return the currently-cached Copilot token
 *     **without** triggering a refresh. Returns `null` before `start()` runs.
 *     Snapshot semantics: the value returned is captured at the instant of
 *     call; subsequent `refresh()` calls do not affect prior return values.
 *     Snapshots are `Object.freeze`d so accidental mutation throws in strict
 *     mode rather than silently corrupting the cache.
 *   - `refresh()` — singleflight + bounded retry + fail-open. Public API
 *     M5's route handler calls before each upstream request (or on 401).
 *   - `getStatus()` — synchronous lifecycle inspector (M5 D-LOCK-2). Returns
 *     "uninitialized" | "starting" | "ready" | "failed" | "disposed". Does
 *     NOT throw after dispose (returns "disposed").
 *   - `dispose()` — cancel pending refresh + clear state. Subsequent calls
 *     to `refresh()` throw `TokenManagerDisposedError`.
 *
 * **Disposal policy (H2):** `dispose()` aborts the in-flight `fetch` via the
 * threaded `AbortSignal` AND wipes `cachedToken`/`githubToken` AND sets
 * `disposed = true`. Any in-flight `_doRefresh` either rejects with
 * `AbortError` (interrupted fetch) or `TokenManagerDisposedError`
 * (caught by the post-fetch disposal check at `_doRefresh`). A successful
 * fetch that resolves AFTER `dispose()` is discarded — the caller gets a
 * disposal rejection rather than a stranded token. Idempotent.
 *
 * **NO `setInterval`.** Background-refresh strategy belongs to M5's route
 * layer (which decides whether on-demand suffices or a separate scheduler
 * is needed). `TokenManager` only fetches when asked.
 */

import fs from "node:fs/promises";
import path from "node:path";

import consola from "consola";

import type { AccountType } from "./api-config.ts";
import { getCopilotToken } from "./get-copilot-token.ts";
import type { CopilotTokenResponse } from "./get-copilot-token.ts";
import { getDeviceCode } from "./get-device-code.ts";
import { pollAccessToken } from "./poll-access-token.ts";

import {
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "~/lib/error.ts";
import { LEVEL_VERBOSE, debug } from "~/lib/debug.ts";
import { incCounter, setGauge } from "~/lib/metrics.ts";
import { sleep as defaultSleep } from "~/lib/sleep.ts";

/** A cached Copilot token plus the local timestamp at which it was fetched.
 *
 * All fields are `readonly` to enforce N10 snapshot semantics structurally
 * (M4.5 F8/M1). The cache also `Object.freeze`s the value before storing it,
 * so a misbehaving caller that bypasses the type system (e.g. casts to `any`)
 * still cannot corrupt the cached snapshot at runtime.
 */
export interface CopilotToken {
  /** The Copilot-Ent token. */
  readonly token: string;
  /** Upstream's recommended seconds until next refresh. */
  readonly refresh_in: number;
  /** Unix-seconds at which the token will hard-expire (per upstream). */
  readonly expires_at: number;
  /** Unix-seconds at which WE fetched this token (for staleness checks). */
  readonly fetched_at: number;
}

/**
 * Lifecycle state of a TokenManager instance (per M5 D-LOCK-2).
 *
 * Transitions:
 *   uninitialized
 *     → starting   (on start() invocation, before first refresh resolves)
 *     → disposed   (if dispose() is called before start() ever runs)
 *
 *   starting
 *     → ready      (on first successful refresh from start()'s _doStart loop)
 *     → failed     (on TokenRefreshExhaustedError from start()'s initial refresh)
 *     → disposed   (if dispose() races _doRefresh's post-fetch check; terminal)
 *
 *   ready / failed
 *     → disposed   (on dispose())
 *
 *   disposed       — terminal. No automatic recovery; restart required.
 *
 * Per-request 401-retry failures do NOT flip ready → failed (per discriminator
 * iter-2 M1). Status only tracks auth subsystem bootstrap + disposal — NOT
 * per-request health.
 */
export type TokenManagerStatus =
  | "uninitialized"
  | "starting"
  | "ready"
  | "failed"
  | "disposed";

/**
 * `TokenManager` constructor opts. `fetchCopilotToken`, `sleep`, `now`
 * are dependency-injected for tests; production callers omit them.
 */
export interface TokenManagerOpts {
  /** Path to the on-disk GitHub OAuth token (mode 0o600). */
  githubTokenPath: string;
  /** Account type — passed to `getCopilotToken` for future per-tier switching. */
  accountType: AccountType;
  /** vsCode version — passed through to header factories. */
  vsCodeVersion: string;
  /**
   * Total attempts per `refresh()` call. Default `3` (per O11). MUST be a
   * positive integer (constructor enforces; M4.5 H3).
   */
  retryAttempts?: number;
  /**
   * Backoff between attempts in ms. Default `[250, 500, 1000]` (per O11).
   * MUST be non-empty (constructor enforces; M4.5 H3). The schedule is
   * literal: sleep `retryBackoffMs[attempt - 1]`, clamped to the last value
   * if `attempt > retryBackoffMs.length`. Use a longer array for longer
   * backoffs; this class does NOT compute exponential schedules itself.
   */
  retryBackoffMs?: readonly number[];
  /**
   * Optional injection of the underlying token-fetcher. Tests pass a mock;
   * production callers omit and get `getCopilotToken`. The optional `signal`
   * arg lets `_doRefresh` cancel an in-flight fetch on dispose (M4.5 F1).
   */
  fetchCopilotToken?: (
    githubToken: string,
    accountType: AccountType,
    vsCodeVersion: string,
    signal?: AbortSignal,
  ) => Promise<CopilotTokenResponse>;
  /**
   * Optional sleep injection (tests use a fake clock). Signal-aware so
   * dispose() can interrupt the inter-attempt backoff (M4.5 F6).
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional `now()` injection — returns unix-seconds. */
  now?: () => number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000];

const defaultNow = (): number => Math.floor(Date.now() / 1000);

/**
 * Map TokenManagerStatus to the integer encoding emitted by the
 * `copilot_proxy_token_status` Prometheus gauge (per M12 spec § Group A § 5):
 *   starting → 0, ready → 1, failed → 2.
 *
 * `uninitialized` predates `start()` ever being called; we treat it as 0
 * (operationally equivalent to starting from the operator's perspective).
 * `disposed` is terminal post-shutdown; we treat it as 2 (mirrors `failed`
 * for alerting purposes — the proxy is no longer serving auth-gated traffic).
 */
function statusToInt(s: TokenManagerStatus): number {
  switch (s) {
    case "ready":
      return 1;
    case "failed":
    case "disposed":
      return 2;
    case "starting":
    case "uninitialized":
    default:
      return 0;
  }
}

export class TokenManager {
  private readonly githubTokenPath: string;
  private readonly accountType: AccountType;
  private readonly vsCodeVersion: string;
  private readonly retryAttempts: number;
  private readonly retryBackoffMs: readonly number[];
  private readonly fetchCopilotToken: NonNullable<
    TokenManagerOpts["fetchCopilotToken"]
  >;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  private inflightRefresh: Promise<CopilotToken> | null = null;
  private inflightStart: Promise<void> | null = null;
  private cachedToken: CopilotToken | null = null;
  private disposed = false;
  /**
   * Unified abort controller (M4.5 H1/H4). Allocated by `newAbortController()`:
   *   - At the top of every `_doRefresh` invocation (so each refresh has a
   *     fresh controller; dispose() during refresh aborts THAT fetch).
   *   - At the top of `loadOrAcquireGithubToken`'s device-code branch (so
   *     dispose() during the device-code poll aborts the poll).
   * `dispose()` calls `abort()` on whichever controller is current.
   */
  private abortController: AbortController | null = null;
  private githubToken: string | null = null;
  private started = false;
  /**
   * M5 D-LOCK-2 lifecycle status. Tracked separately from the existing
   * `started`/`disposed` booleans so route handlers can SYNCHRONOUSLY consult
   * one enum-valued field without reasoning across multiple boolean states.
   *
   * **M12 D-LOCK-3.** All writes go through `setStatus()` so the
   * `copilot_proxy_token_status` Prometheus gauge mirrors transitions
   * automatically. Direct field assignment is forbidden in this file.
   */
  private status: TokenManagerStatus = "uninitialized";

  /**
   * Internal status setter that both updates the field AND emits the
   * `copilot_proxy_token_status` gauge per M12 spec § Group A § 5.
   * All status transitions in this file MUST go through here.
   */
  private setStatus(next: TokenManagerStatus): void {
    this.status = next;
    setGauge("copilot_proxy_token_status", statusToInt(next));
  }

  constructor(opts: TokenManagerOpts) {
    this.githubTokenPath = opts.githubTokenPath;
    this.accountType = opts.accountType;
    this.vsCodeVersion = opts.vsCodeVersion;
    this.retryAttempts = opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.fetchCopilotToken = opts.fetchCopilotToken ?? getCopilotToken;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? defaultNow;

    // M4.5 H3: fail-fast on operator misconfig. Defaults are always valid;
    // only explicit overrides can land here with bad shapes. We guarantee
    // >=1 attempts and >=1 backoff value so _doRefresh's loop and clamp
    // arithmetic are total. (retryAttempts: 0 would silently produce an
    // "after 0 attempts: null" exhaustion error; retryBackoffMs: [] would
    // hit `length - 1 = -1` and tight-spin against GitHub.)
    if (!Number.isInteger(this.retryAttempts) || this.retryAttempts < 1) {
      throw new Error(
        `TokenManagerOpts.retryAttempts must be a positive integer (got ${String(opts.retryAttempts)})`,
      );
    }
    if (this.retryBackoffMs.length === 0) {
      throw new Error(
        "TokenManagerOpts.retryBackoffMs must contain at least one backoff value",
      );
    }
  }

  /**
   * Load the GitHub token from disk; if absent, run the device-code flow and
   * persist the new token. Then fetch the initial Copilot token.
   *
   * Idempotent — calling `start()` again after success is a no-op.
   * Singleflight (M5 F7) — concurrent callers share one in-flight start
   * promise; a second call while the first is pending returns the same promise
   * rather than firing a second device-code flow + initial refresh.
   */
  async start(): Promise<void> {
    this.throwIfDisposed();
    if (this.started) return;
    if (this.inflightStart !== null) return this.inflightStart;

    this.setStatus("starting");
    this.inflightStart = this._doStart().finally(() => {
      this.inflightStart = null;
    });
    return this.inflightStart;
  }

  private async _doStart(): Promise<void> {
    try {
      this.githubToken = await this.loadOrAcquireGithubToken();
      await this.refresh();
      // Per discriminator iter-1 M6: only flip `started=true` if dispose()
      // didn't race in between. If we set `started=true` BEFORE the
      // `!disposed` check, then a race where dispose() arrives between
      // `started = true` and `if (!disposed) status = "ready"` would leave
      // the manager with `started=true` + `status="disposed"`. A subsequent
      // `start()` then returns silently via the `if (this.started) return;`
      // guard rather than throwing TokenManagerDisposedError. Move both
      // mutations under the same check so disposal-during-_doStart cleanly
      // prevents the no-op-start regression.
      if (!this.disposed) {
        this.started = true;
        this.setStatus("ready");
      }
    } catch (err) {
      // dispose() during _doStart wins; status is already "disposed".
      if (this.disposed) {
        throw err;
      }
      this.setStatus("failed");
      throw err;
    }
  }

  /**
   * Synchronous lifecycle inspector (M5 D-LOCK-2). Returns the current
   * status WITHOUT throwing — even after `dispose()`. Route handlers call
   * this to decide 503 (auth_pending / auth_failed / shutting_down) vs
   * proceeding to the upstream call.
   *
   * Per discriminator iter-2 M1:
   *   - Does NOT throw via `throwIfDisposed()` (returning "disposed" is the
   *     correct signal; throwing would crash the handler with 500).
   *   - Reflects last-observed start/refresh/dispose only — per-request
   *     401-retry failures do NOT flip ready → failed.
   *   - Disposal is terminal — no automatic recovery from "disposed" or
   *     "failed". Restart required.
   */
  getStatus(): TokenManagerStatus {
    return this.status;
  }

  /**
   * Return the currently-cached Copilot token (or `null` if `start()` has not
   * yet completed). Snapshot semantics: the returned reference is the
   * cached-token value at this instant; subsequent `refresh()` calls do not
   * mutate this returned object (a fresh frozen object is assigned on
   * refresh, and the returned object is itself `Object.freeze`d so accidental
   * mutation throws in strict mode).
   *
   * Never blocks. Never throws (except after `dispose()`).
   */
  getTokenForRequest(): CopilotToken | null {
    this.throwIfDisposed();
    return this.cachedToken;
  }

  /**
   * Refresh the Copilot token. Singleflight + bounded retry + fail-open:
   *
   *   - If a refresh is already in flight, return the same promise.
   *   - Up to `retryAttempts` total attempts; sleep `retryBackoffMs[i]` between
   *     attempts (clamped to the last value if attempts > backoff length).
   *   - On final failure, if `cachedToken && cachedToken.expires_at > now()`,
   *     return the cached token and emit a warning.
   *   - Otherwise throw `TokenRefreshExhaustedError`.
   */
  async refresh(): Promise<CopilotToken> {
    this.throwIfDisposed();
    if (this.inflightRefresh) return this.inflightRefresh;

    this.inflightRefresh = this._doRefresh().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  /**
   * Cancel any pending refresh + clear state. Idempotent.
   *
   * **Policy (M4.5 H2):** any in-flight `refresh()` call rejects. The threaded
   * `AbortSignal` aborts the underlying `fetch`; the post-fetch disposal check
   * in `_doRefresh` discards racy successful resolves and rejects with
   * `TokenManagerDisposedError`. The caller never receives a stranded
   * token. `getTokenForRequest()` and subsequent `refresh()` calls throw
   * `TokenManagerDisposedError`. `getStatus()` returns `"disposed"` without
   * throwing (per M5 D-LOCK-2 line 181).
   *
   * Order is intentional: set `disposed` BEFORE aborting + wiping cache so any
   * code that wakes up post-abort sees the disposed flag and treats it as
   * terminal.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setStatus("disposed");
    this.abortController?.abort();
    this.cachedToken = null;
    this.githubToken = null;
  }

  // ----- private --------------------------------------------------------

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new TokenManagerDisposedError();
    }
  }

  /**
   * Allocate a fresh `AbortController` and store it on `this.abortController`,
   * replacing whichever one was previously stored. dispose() will abort the
   * current one. Old controllers are already-settled by the time we replace
   * them (each is allocated inside a single _doRefresh call or a single
   * device-code flow), so there's no listener leak.
   */
  private newAbortController(): AbortController {
    this.abortController = new AbortController();
    return this.abortController;
  }

  private async _doRefresh(): Promise<CopilotToken> {
    if (this.githubToken === null) {
      throw new Error("TokenManager not started");
    }

    const controller = this.newAbortController();
    const signal = controller.signal;

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      this.throwIfDisposed();
      try {
        const fetched = await this.fetchCopilotToken(
          this.githubToken,
          this.accountType,
          this.vsCodeVersion,
          signal,
        );
        // M4.5 H2: by the time `fetched` resolves, dispose() may have set
        // disposed=true and aborted the controller. We MUST detect this
        // BEFORE assigning to cachedToken — otherwise we re-populate a cache
        // that dispose() just wiped, leaving the caller with a stranded
        // token while subsequent getTokenForRequest() returns null.
        if (this.disposed) {
          throw new TokenManagerDisposedError();
        }
        const next: Readonly<CopilotToken> = Object.freeze({
          token: fetched.token,
          refresh_in: fetched.refresh_in,
          expires_at: fetched.expires_at,
          fetched_at: this.now(),
        });
        this.cachedToken = next;
        debug.on(LEVEL_VERBOSE, () => "Copilot token refreshed");
        // M12 D-LOCK-3: per-attempt success counter.
        incCounter("copilot_proxy_token_refresh_total", 1, {
          outcome: "success",
        });
        return next;
      } catch (err) {
        // M4.5 F5: disposal is terminal, not transient. Re-throw immediately
        // so the exhaustion path doesn't paper over it with a misleading
        // "Token refresh exhausted after N attempts: TokenManager disposed"
        // wrapper. Also covers the case where the inner fetch threw an
        // AbortError because dispose() aborted the signal mid-fetch.
        if (this.disposed) {
          throw err;
        }
        // M12 D-LOCK-3: per-attempt failure counter (excludes disposed-throws,
        // which are not "refresh failed against upstream" — they're shutdown
        // unwinding).
        incCounter("copilot_proxy_token_refresh_total", 1, {
          outcome: "failure",
        });
        lastError = err;
        // M5 F10/M2/M5 log hygiene: per-attempt failures are diagnostic, not
        // user-visible terminal events. Demoted from consola.error to
        // debug.on(LEVEL_VERBOSE). Final fail-open warn + exhausted error
        // throw stay loud.
        const errMsg = err instanceof Error ? err.message : String(err);
        debug.on(
          LEVEL_VERBOSE,
          () =>
            `Copilot token refresh attempt ${attempt}/${this.retryAttempts} failed: ${errMsg}`,
        );
        if (attempt < this.retryAttempts) {
          // Constructor invariant H3 guarantees retryBackoffMs.length >= 1, so
          // backoffIdx is always a valid index. The `?? 0` fallback is
          // defensive belt-and-suspenders for tsc's noUncheckedIndexedAccess.
          const backoffIdx = Math.min(
            attempt - 1,
            this.retryBackoffMs.length - 1,
          );
          const backoff = this.retryBackoffMs[backoffIdx] ?? 0;
          try {
            await this.sleep(backoff, signal);
          } catch {
            // sleep() rejected because signal aborted (i.e. dispose() was
            // called during the backoff window). Treat as terminal disposal
            // — propagate cleanly rather than retrying.
            if (this.disposed) {
              throw new TokenManagerDisposedError();
            }
            // Defensive: signal aborted but disposed flag isn't set. Should
            // never happen given dispose() is the only abort caller, but
            // surface it explicitly rather than silently retrying.
            throw new Error("Sleep aborted unexpectedly");
          }
        }
      }
    }

    // All attempts exhausted. cachedToken here is necessarily the prior
    // generation (any successful attempt this call would have returned at
    // the assignment site above). M4.5 M3 docs.
    const cached = this.cachedToken;
    if (cached !== null && cached.expires_at > this.now()) {
      consola.warn(
        "Copilot token refresh exhausted; serving still-valid cached token.",
      );
      return cached;
    }

    throw new TokenRefreshExhaustedError(this.retryAttempts, lastError);
  }

  /**
   * Read the GitHub token from disk; if missing/empty, run the device-code
   * flow and persist the result.
   */
  private async loadOrAcquireGithubToken(): Promise<string> {
    const existing = await this.readGithubToken();
    if (existing.length > 0) {
      return existing;
    }

    consola.info("No GitHub token on disk; starting device-code flow.");
    // M4.5 H4: reuse the unified AbortController so dispose() during the
    // device-code poll aborts pollAccessToken correctly.
    const controller = this.newAbortController();
    const deviceCode = await getDeviceCode();
    consola.info(
      `Open ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`,
    );
    const token = await pollAccessToken(deviceCode, controller.signal);
    await this.writeGithubToken(token);
    return token;
  }

  private async readGithubToken(): Promise<string> {
    try {
      return (await fs.readFile(this.githubTokenPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  private async writeGithubToken(token: string): Promise<void> {
    // Defensive mkdir (per discriminator iter-1 C1): even though main.ts
    // now calls ensurePaths() before constructing TokenManager, the
    // belt-and-suspenders mkdir here protects callers (tests, future
    // entrypoints) that construct TokenManager pointing at a github-token
    // path whose parent directory does not exist. Without this, fs.writeFile
    // throws ENOENT and start() flips to "failed" permanently.
    await fs.mkdir(path.dirname(this.githubTokenPath), { recursive: true });
    await fs.writeFile(this.githubTokenPath, token);
    await fs.chmod(this.githubTokenPath, 0o600);
  }
}
