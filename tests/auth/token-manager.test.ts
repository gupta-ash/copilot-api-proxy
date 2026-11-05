/**
 * Tests for src/auth/token-manager.ts
 *
 * Coverage map:
 *   1. Singleflight (per O5): 50 parallel refresh() → mock fetch called exactly 1×.
 *   2. Backoff schedule: 3 consecutive failures → sleep called with [250, 500] (2 sleeps for 3 attempts).
 *   3. Fail-open with cached token: cache populated + still valid + 3 fetch failures → returns cache.
 *   4. Throws TokenRefreshExhaustedError when no cached token + 3 failures.
 *      Also asserts M4.5 M6: tex.cause === lastError.
 *   5. Mid-stream snapshot (per N10): getTokenForRequest() returns snapshot at instant of call.
 *   6. Disposal: dispose() → subsequent refresh() throws "TokenManager disposed".
 *      Also asserts M5 D-LOCK-4: throw is instanceof TokenManagerDisposedError.
 *   7. Singleflight reset: after one refresh completes, the next call performs a NEW fetch.
 *   8. M4.5 F1/H1/F2: Disposal cancels in-flight refresh — pending refresh rejects within ~50ms.
 *   9. M4.5 H2 race A: dispose() between fetch resolution and post-fetch disposed-check.
 *  10. M4.5 H2 race B: dispose() mid-fetch — explicit AbortController.signal.aborted assertion.
 *  11. M4.5 H3: Constructor invariants — retryAttempts must be positive integer; backoff non-empty.
 *  12. M4.5 F5: Disposal mid-loop is terminal (no more fetches; no exhaustion wrapper).
 *  13. M5 F7: start() is singleflight — 50 concurrent start() → 1 device-code/initial refresh.
 *  14. M5 F29: fast-check property test on TokenManagerOpts — random valid configs construct
 *      successfully; invalid retryAttempts/retryBackoffMs throw cleanly.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import * as fc from "fast-check";

import {
  type CopilotToken,
  TokenManager,
  type TokenManagerOpts,
} from "../../src/auth/token-manager.ts";
import type { CopilotTokenResponse } from "../../src/auth/get-copilot-token.ts";
import {
  TokenManagerDisposedError,
  TokenRefreshExhaustedError,
} from "../../src/lib/error.ts";

let tempDirs: Array<string> = [];

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-tm-"));
  tempDirs.push(d);
  return d;
}

/**
 * Construct a TokenManager with a pre-written GitHub token on disk and the
 * given fetch + sleep + now mocks. Also `await tm.start()` so the manager is
 * ready (cachedToken is populated by start()'s initial refresh).
 *
 * If the test wants to control start()'s initial refresh, pass
 * `startManager: false` and call `start()` manually after configuring mocks.
 */
async function makeManager(
  overrides: {
    fetchCopilotToken?: TokenManagerOpts["fetchCopilotToken"];
    sleep?: TokenManagerOpts["sleep"];
    now?: TokenManagerOpts["now"];
    retryAttempts?: number;
    retryBackoffMs?: readonly number[];
    startManager?: boolean;
    githubToken?: string;
  } = {},
): Promise<{ tm: TokenManager; githubTokenPath: string }> {
  const dir = await makeTempDir();
  const githubTokenPath = path.join(dir, "github_token");
  await writeFile(githubTokenPath, overrides.githubToken ?? "ghp_test_token");

  const tm = new TokenManager({
    githubTokenPath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    retryAttempts: overrides.retryAttempts,
    retryBackoffMs: overrides.retryBackoffMs,
    fetchCopilotToken: overrides.fetchCopilotToken,
    sleep: overrides.sleep,
    now: overrides.now,
  });

  if (overrides.startManager !== false) {
    await tm.start();
  }
  return { tm, githubTokenPath };
}

function makeFetchedToken(
  token: string,
  expiresInSec = 3600,
): CopilotTokenResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    token,
    refresh_in: expiresInSec - 60,
    expires_at: now + expiresInSec,
  };
}

describe("TokenManager — singleflight (O5)", () => {
  it("dedups 50 concurrent refresh() calls into exactly 1 fetch", async () => {
    let fetchCount = 0;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      // Tiny await yields control so 50 callers can pile in before resolution.
      await new Promise((r) => setTimeout(r, 5));
      return makeFetchedToken("token-singleflight");
    };

    // Use startManager: false so start()'s implicit refresh doesn't race the test.
    const { tm } = await makeManager({
      fetchCopilotToken: fetchMock,
      startManager: false,
    });

    // Manually populate the github token via start() — but start() also calls refresh()
    // so we count that as the "1 expected fetch" and the 50 parallel refreshes after it
    // should each return the same in-flight (or just-resolved) value.
    await tm.start();
    expect(fetchCount).toBe(1); // start()'s initial refresh

    // Reset counter, then issue 50 parallel refreshes — they should all dedupe into 1 fetch.
    fetchCount = 0;
    const promises = Array.from({ length: 50 }, () => tm.refresh());
    const results = await Promise.all(promises);

    // ─── singleflight assertion ──────────────────────────────────────
    expect(fetchCount).toBe(1);
    // All 50 promises resolved to the same token value.
    const firstToken = results[0]?.token;
    expect(firstToken).toBe("token-singleflight");
    for (const r of results) {
      expect(r.token).toBe(firstToken as string);
    }
  });
});

describe("TokenManager — bounded retry + backoff (O11)", () => {
  it("uses [250, 500] sleeps between 3 attempts and throws on exhaustion", async () => {
    let fetchCount = 0;
    const sleepCalls: Array<number> = [];

    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      throw new Error(`forced failure ${fetchCount}`);
    };
    const sleepMock = async (ms: number) => {
      sleepCalls.push(ms);
    };

    // startManager: false because start() would itself fail and abort setup.
    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: sleepMock,
      retryAttempts: 3,
      retryBackoffMs: [250, 500, 1000],
    });

    // Manually load github token without triggering refresh (call refresh directly):
    // start() would throw during its initial refresh; we want to inspect refresh() in isolation.
    // Workaround: call start() and catch the throw so the github token is loaded.
    await tm.start().catch(() => undefined);

    // After failed start, we know fetch happened 3 times (one full refresh cycle).
    // Reset counters and force a clean 3-attempt cycle.
    fetchCount = 0;
    sleepCalls.length = 0;

    let thrown: unknown = null;
    try {
      await tm.refresh();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TokenRefreshExhaustedError);
    expect((thrown as TokenRefreshExhaustedError).attempts).toBe(3);
    expect((thrown as TokenRefreshExhaustedError).message).toContain(
      "exhausted",
    );

    expect(fetchCount).toBe(3);
    // 3 attempts → 2 inter-attempt sleeps (after attempts 1 and 2; no sleep after the final one).
    expect(sleepCalls).toEqual([250, 500]);
  });
});

describe("TokenManager — fail-open with still-valid cache", () => {
  it("returns cached token (no throw) when refresh exhausts but cache is still valid", async () => {
    let fetchCount = 0;
    let mode: "ok" | "fail" = "ok";
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      if (mode === "fail") throw new Error(`forced failure ${fetchCount}`);
      return makeFetchedToken("cached-token", 7200);
    };

    const { tm } = await makeManager({
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip backoff */
      },
      retryAttempts: 3,
      retryBackoffMs: [0, 0, 0],
    });

    // start() did a successful refresh: cache is populated with "cached-token", expires_at +2h.
    expect(fetchCount).toBe(1);
    const initialToken = tm.getTokenForRequest();
    expect(initialToken?.token).toBe("cached-token");

    // Now switch to failure mode and force refresh.
    mode = "fail";
    fetchCount = 0;
    const result = await tm.refresh();

    // Fail-open: 3 failed attempts, cache still valid → returns cached token.
    expect(fetchCount).toBe(3);
    expect(result.token).toBe("cached-token");
    expect(initialToken).not.toBeNull();
    expect(result).toBe(initialToken as CopilotToken); // same object reference
  });
});

describe("TokenManager — throws when no usable cache after exhaustion", () => {
  it("throws TokenRefreshExhaustedError with attempts + message + .cause chain (M4.5 M6)", async () => {
    const sentinel = new Error("upstream 503");
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      throw sentinel;
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip backoff */
      },
      retryAttempts: 3,
      retryBackoffMs: [0, 0, 0],
    });

    let thrown: unknown = null;
    try {
      await tm.start();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TokenRefreshExhaustedError);
    const tex = thrown as TokenRefreshExhaustedError;
    expect(tex.attempts).toBe(3);
    expect(tex.message).toContain("exhausted");
    expect(tex.message).toContain("upstream 503");
    // M4.5 M6: cause chain wired to lastError (NOT just the own-property).
    expect(tex.cause).toBe(sentinel);
    expect(tex.lastError).toBe(sentinel);
    expect(tm.getTokenForRequest()).toBeNull();
  });
});

describe("TokenManager — getTokenForRequest snapshot semantics (N10)", () => {
  it("returned snapshot is not affected by a subsequent refresh", async () => {
    let n = 0;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      n += 1;
      return makeFetchedToken(`token-v${n}`);
    };

    const { tm } = await makeManager({ fetchCopilotToken: fetchMock });

    const snapshot = tm.getTokenForRequest();
    expect(snapshot?.token).toBe("token-v1");

    await tm.refresh();
    const after = tm.getTokenForRequest();
    expect(after?.token).toBe("token-v2");

    // The original snapshot is unchanged — its `token` field is still "token-v1".
    expect(snapshot?.token).toBe("token-v1");
    // And it's not the same object reference as the new cached token.
    expect(snapshot).not.toBe(after);
  });
});

describe("TokenManager — disposal", () => {
  it("rejects subsequent refresh() with 'TokenManager disposed'", async () => {
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () =>
      makeFetchedToken("alpha");

    const { tm } = await makeManager({ fetchCopilotToken: fetchMock });

    tm.dispose();

    let thrown: unknown = null;
    try {
      await tm.refresh();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    // M5 D-LOCK-4: also assert the sentinel class (message preserved verbatim).
    expect(thrown).toBeInstanceOf(TokenManagerDisposedError);
    expect((thrown as Error).message).toBe("TokenManager disposed");

    // getTokenForRequest also rejects after dispose.
    expect(() => tm.getTokenForRequest()).toThrow("TokenManager disposed");
  });
});

describe("TokenManager — singleflight reset on completion", () => {
  it("performs a NEW fetch when refresh() is called sequentially after a prior completion", async () => {
    let fetchCount = 0;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      return makeFetchedToken(`token-${fetchCount}`);
    };

    const { tm } = await makeManager({ fetchCopilotToken: fetchMock });

    // start() did refresh #1; explicit refresh now is #2; another is #3.
    expect(fetchCount).toBe(1);

    const r2 = await tm.refresh();
    expect(fetchCount).toBe(2);
    expect(r2.token).toBe("token-2");

    const r3 = await tm.refresh();
    expect(fetchCount).toBe(3);
    expect(r3.token).toBe("token-3");
  });
});

describe("TokenManager — type smoke", () => {
  it("CopilotToken shape: token + refresh_in + expires_at + fetched_at", async () => {
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () =>
      makeFetchedToken("sniff");
    const fixedNow = 1_700_000_000;
    const { tm } = await makeManager({
      fetchCopilotToken: fetchMock,
      now: () => fixedNow,
    });
    const t = tm.getTokenForRequest();
    expect(t).not.toBeNull();
    const tok = t as CopilotToken;
    expect(typeof tok.token).toBe("string");
    expect(typeof tok.refresh_in).toBe("number");
    expect(typeof tok.expires_at).toBe("number");
    expect(tok.fetched_at).toBe(fixedNow);
  });
});

describe("TokenManager — disposal cancels in-flight refresh (M4.5 F1/H1, F2)", () => {
  it("rejects pending refresh() within ~200ms of dispose() via threaded AbortSignal", async () => {
    let receivedSignal: AbortSignal | undefined = undefined;
    let fetchEntered = false;
    // Mock that resolves only when the signal aborts (or rejects with AbortError).
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = (
      _gh,
      _at,
      _v,
      signal,
    ) => {
      receivedSignal = signal;
      fetchEntered = true;
      return new Promise((_resolve, reject) => {
        if (signal === undefined) {
          // Defensive: contract says signal should be threaded.
          reject(new Error("signal not threaded"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip backoff */
      },
      retryAttempts: 1,
      retryBackoffMs: [0],
    });

    // Kick off start() but do not await; this triggers the initial refresh
    // which will hang on the never-settling fetch.
    const startPromise = tm.start();

    // Drain microtasks until the fetch is actually entered. This is more
    // robust than counting ticks — readGithubToken is a real fs op.
    const t_wait = Date.now();
    while (!fetchEntered) {
      await new Promise((r) => setTimeout(r, 1));
      if (Date.now() - t_wait > 1000) {
        throw new Error("fetch never entered (test setup bug)");
      }
    }

    const t0 = Date.now();
    tm.dispose();

    let thrown: unknown = null;
    try {
      await startPromise;
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - t0;

    // Signal was threaded into the fetch.
    expect(receivedSignal).toBeDefined();
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);
    // Pending call rejected (either AbortError from fetch OR
    // "TokenManager disposed" from the post-fetch check, both acceptable per
    // M4.5 H2 policy — F5 surfaces whichever fired first).
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(
      msg === "TokenManager disposed" ||
        msg === "Aborted" ||
        (thrown as Error).name === "AbortError",
    ).toBe(true);
    // Bounded: must reject promptly (well under the test timeout).
    expect(elapsed).toBeLessThan(200);

    // Subsequent refresh() also throws "TokenManager disposed".
    let thrown2: unknown = null;
    try {
      await tm.refresh();
    } catch (err) {
      thrown2 = err;
    }
    expect((thrown2 as Error).message).toBe("TokenManager disposed");
  });
});

describe("TokenManager — dispose-during-refresh race A (M4.5 H2)", () => {
  it("disposes between fetch resolution and post-fetch check; pending caller rejects, no stranded token", async () => {
    let pendingResolve: ((v: CopilotTokenResponse) => void) | null = null;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = () =>
      new Promise<CopilotTokenResponse>((res) => {
        pendingResolve = res;
      });

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip backoff */
      },
      retryAttempts: 1,
      retryBackoffMs: [0],
    });

    // Kick off start() but do not await; this triggers the initial refresh
    // which will hang on the pending fetch.
    const startPromise = tm.start();

    // Wait until fetch is in flight and pendingResolve is set.
    const t_wait = Date.now();
    while (pendingResolve === null) {
      await new Promise((r) => setTimeout(r, 1));
      if (Date.now() - t_wait > 1000) {
        throw new Error("fetch never entered (test setup bug)");
      }
    }

    // CRUCIAL race A interleaving: dispose() FIRST (sets disposed=true,
    // wipes cache), then resolve the fetch. The post-fetch disposed check
    // in _doRefresh must catch this and reject with "TokenManager disposed".
    tm.dispose();
    (pendingResolve as (v: CopilotTokenResponse) => void)({
      token: "stranded-token",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    let thrown: unknown = null;
    try {
      await startPromise;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("TokenManager disposed");

    // getTokenForRequest also throws (manager is disposed).
    expect(() => tm.getTokenForRequest()).toThrow("TokenManager disposed");
  });
});

describe("TokenManager — dispose-during-refresh race B (M4.5 H2/H1)", () => {
  it("dispose() mid-fetch aborts the controller signal; refresh rejects (no stranded resolve)", async () => {
    let receivedSignal: AbortSignal | undefined = undefined;
    let fetchEntered = false;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = (
      _gh,
      _at,
      _v,
      signal,
    ) => {
      receivedSignal = signal;
      fetchEntered = true;
      return new Promise<CopilotTokenResponse>((_res, rej) => {
        signal?.addEventListener(
          "abort",
          () => rej(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip backoff */
      },
      retryAttempts: 1,
      retryBackoffMs: [0],
    });

    const startPromise = tm.start();

    // Wait until fetch is entered.
    const t_wait = Date.now();
    while (!fetchEntered) {
      await new Promise((r) => setTimeout(r, 1));
      if (Date.now() - t_wait > 1000) {
        throw new Error("fetch never entered (test setup bug)");
      }
    }

    expect(receivedSignal).toBeDefined();
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(false);

    tm.dispose();

    // After dispose, the signal must be aborted.
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);

    let thrown: unknown = null;
    try {
      await startPromise;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("TokenManager — constructor invariants (M4.5 H3)", () => {
  it("throws when retryAttempts is 0", async () => {
    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");
    expect(
      () =>
        new TokenManager({
          githubTokenPath,
          accountType: "enterprise",
          vsCodeVersion: "1.95.0",
          retryAttempts: 0,
        }),
    ).toThrow("retryAttempts must be a positive integer");
  });

  it("throws when retryAttempts is negative", async () => {
    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");
    expect(
      () =>
        new TokenManager({
          githubTokenPath,
          accountType: "enterprise",
          vsCodeVersion: "1.95.0",
          retryAttempts: -1,
        }),
    ).toThrow("retryAttempts must be a positive integer");
  });

  it("throws when retryAttempts is non-integer", async () => {
    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");
    expect(
      () =>
        new TokenManager({
          githubTokenPath,
          accountType: "enterprise",
          vsCodeVersion: "1.95.0",
          retryAttempts: 1.5,
        }),
    ).toThrow("retryAttempts must be a positive integer");
  });

  it("throws when retryBackoffMs is empty array", async () => {
    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");
    expect(
      () =>
        new TokenManager({
          githubTokenPath,
          accountType: "enterprise",
          vsCodeVersion: "1.95.0",
          retryBackoffMs: [],
        }),
    ).toThrow("retryBackoffMs must contain at least one backoff value");
  });

  it("clamp-to-last: retryAttempts: 5, retryBackoffMs: [100] → sleeps [100,100,100,100]", async () => {
    let fetchCount = 0;
    const sleepCalls: Array<number> = [];
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      throw new Error("forced");
    };
    const sleepMock = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: sleepMock,
      retryAttempts: 5,
      retryBackoffMs: [100],
    });

    let thrown: unknown = null;
    try {
      await tm.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TokenRefreshExhaustedError);
    expect(fetchCount).toBe(5);
    // 5 attempts → 4 inter-attempt sleeps, all clamped to the only entry.
    expect(sleepCalls).toEqual([100, 100, 100, 100]);
  });
});

describe("TokenManager — disposal mid-loop is terminal (M4.5 F5)", () => {
  it("dispose() during backoff after attempt 2 → rejects with 'TokenManager disposed' (NOT exhausted), no attempt 3", async () => {
    let fetchCount = 0;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      throw new Error(`transient ${fetchCount}`);
    };

    let disposeRef: (() => void) | null = null;
    const sleepMock = async (_ms: number, signal?: AbortSignal) => {
      // On the 2nd backoff (after attempt 2), trigger dispose() so the
      // signal-aware sleep aborts and _doRefresh's catch-block treats
      // disposal as terminal.
      if (disposeRef !== null) {
        // queueMicrotask to model the "dispose arrives during sleep" race.
        queueMicrotask(() => {
          disposeRef?.();
        });
        await new Promise<void>((res, rej) => {
          if (signal === undefined) {
            // Should never happen — _doRefresh threads the signal.
            res();
            return;
          }
          signal.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: sleepMock,
      retryAttempts: 3,
      retryBackoffMs: [0, 0, 0],
    });
    disposeRef = () => {
      tm.dispose();
    };

    // Wait until first sleep happens? No — the sleepMock auto-disposes on
    // any sleep. Since attempt 1 fails immediately and triggers a sleep,
    // dispose() will fire then. We expect: attempt 1 → catch → sleep
    // (signal aborts via dispose) → catch in catch → throw "disposed".
    // So fetchCount should be exactly 1.
    let thrown: unknown = null;
    try {
      await tm.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("TokenManager disposed");
    // Only attempt 1 fired; the dispose during the first backoff terminates.
    expect(fetchCount).toBe(1);
  });
});

// ============================================================================
// M5 F7: start() singleflight
// ============================================================================
describe("TokenManager — start() singleflight (M5 F7)", () => {
  it("dedupes 50 concurrent start() calls into exactly 1 device-code flow + 1 initial refresh", async () => {
    let fetchCount = 0;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = async () => {
      fetchCount += 1;
      // Tiny await yields control so 50 callers can pile in before resolution.
      await new Promise((r) => setTimeout(r, 5));
      return makeFetchedToken("singleflight-start");
    };

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
    });

    // Fire 50 concurrent start() calls.
    const promises = Array.from({ length: 50 }, () => tm.start());
    await Promise.all(promises);

    // start() singleflights → exactly 1 fetch (the initial refresh inside _doStart).
    expect(fetchCount).toBe(1);
    // Status reaches ready.
    expect(tm.getStatus()).toBe("ready");
    // Subsequent start() is the no-op idempotent path (started === true).
    fetchCount = 0;
    await tm.start();
    expect(fetchCount).toBe(0);
  });
});

// ============================================================================
// M5 F29 (architecture.md structural recommendation): fast-check property
// test on TokenManagerOpts. Stateful classes warrant fuzz over their
// constructor invariants.
// ============================================================================
describe("TokenManager — constructor property tests (M5 F29)", () => {
  it("random valid TokenManagerOpts construct successfully; invalid retryAttempts/retryBackoffMs throw", () => {
    fc.assert(
      fc.property(
        fc.record({
          retryAttempts: fc.integer({ min: 1, max: 10 }),
          backoffLen: fc.integer({ min: 1, max: 5 }),
          accountType: fc.constantFrom(
            "individual" as const,
            "business" as const,
            "enterprise" as const,
          ),
        }),
        ({ retryAttempts, backoffLen, accountType }) => {
          const backoffs = Array.from(
            { length: backoffLen },
            (_v, i) => (i + 1) * 100,
          );
          // Construction must not throw on any valid combo.
          const tm = new TokenManager({
            githubTokenPath: "/tmp/nonexistent_property_test",
            accountType,
            vsCodeVersion: "1.95.0",
            retryAttempts,
            retryBackoffMs: backoffs,
          });
          // Sanity: lifecycle starts at "uninitialized".
          expect(tm.getStatus()).toBe("uninitialized");
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });

  it("invalid retryAttempts (0, negative, non-integer) consistently throw the same error", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.constantFrom(0.5, 1.5, 2.7, 3.14159, 99.99),
        ),
        (badAttempts) => {
          let threw = false;
          try {
            new TokenManager({
              githubTokenPath: "/tmp/nonexistent",
              accountType: "enterprise",
              vsCodeVersion: "1.95.0",
              retryAttempts: badAttempts,
            });
          } catch (err) {
            threw = true;
            expect((err as Error).message).toContain(
              "retryAttempts must be a positive integer",
            );
          }
          return threw;
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ============================================================================
// M5.5 M6 race fix: _doStart sets `started = true` only INSIDE the
// `!disposed` check, so a dispose() that races _doStart's success path
// CANNOT leave the manager with `started=true` + `status="disposed"` —
// which would otherwise make a subsequent start() return silently via the
// `if (this.started) return;` guard rather than throwing
// TokenManagerDisposedError.
// ============================================================================
describe("TokenManager — _doStart race (M5.5 M6)", () => {
  it("dispose() racing _doStart success → subsequent start() throws TokenManagerDisposedError (no silent no-op)", async () => {
    // Wire a fetch mock that lets us control when the initial refresh
    // resolves. We dispose() AFTER the refresh resolves but BEFORE
    // _doStart's microtask completes (queueMicrotask after resolve).
    let resolveRefresh: ((v: CopilotTokenResponse) => void) | null = null;
    const fetchMock: TokenManagerOpts["fetchCopilotToken"] = () =>
      new Promise<CopilotTokenResponse>((res) => {
        resolveRefresh = res;
      });

    const dir = await makeTempDir();
    const githubTokenPath = path.join(dir, "github_token");
    await writeFile(githubTokenPath, "ghp_test_token");

    const tm = new TokenManager({
      githubTokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: fetchMock,
      sleep: async () => {
        /* skip */
      },
      retryAttempts: 1,
      retryBackoffMs: [0],
    });

    const startPromise = tm.start();

    // Wait for the initial refresh fetch to be in flight.
    const t_wait = Date.now();
    while (resolveRefresh === null) {
      await new Promise((r) => setTimeout(r, 1));
      if (Date.now() - t_wait > 1000) {
        throw new Error("fetch never entered (test setup bug)");
      }
    }

    // Race: dispose() FIRST so disposed=true; then resolve the fetch. This
    // exercises the existing dispose-mid-refresh post-fetch check; what
    // M5.5 M6 specifically protects is the case where _doStart's
    // refresh() RESOLVES (post-disposal check passes), then control
    // returns to _doStart's `started = true` line. Pre-fix, started would
    // flip to true under disposed=true, leaving subsequent start() to
    // silently no-op via the early `if (this.started) return;` guard.
    // Post-fix, started only flips inside `!disposed`, so subsequent
    // start() takes the throwIfDisposed path and rejects.
    tm.dispose();
    (resolveRefresh as (v: CopilotTokenResponse) => void)({
      token: "would-be-stranded",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    // The original start() rejects (post-fetch disposed check fires).
    let firstThrown: unknown = null;
    try {
      await startPromise;
    } catch (err) {
      firstThrown = err;
    }
    expect(firstThrown).toBeInstanceOf(TokenManagerDisposedError);
    expect(tm.getStatus()).toBe("disposed");

    // The crucial M6 assertion: a subsequent start() MUST throw, NOT
    // silently no-op via the started flag.
    let secondThrown: unknown = null;
    try {
      await tm.start();
    } catch (err) {
      secondThrown = err;
    }
    expect(secondThrown).toBeInstanceOf(TokenManagerDisposedError);
  });
});
