/**
 * auth-gate.test.ts — D-LOCK-2 stage-1/2 auth gate behaviour (per
 * discriminator iter-1 M7 extraction).
 *
 * Coverage matrix — one assertion per status branch:
 *   1. status === "ready"        → returns null (caller proceeds)
 *   2. status === "disposed"     → 503 service_unavailable + Connection: close
 *   3. status === "failed"       → 503 auth_failed
 *   4. status === "starting"     → 503 auth_pending
 *   5. status === "uninitialized"→ 503 auth_pending
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import type {
  TokenManager,
  TokenManagerStatus,
} from "../../../src/auth/token-manager.ts";
import { checkAuthGate } from "../../../src/routes/_shared/auth-gate.ts";

/**
 * Build a minimal TokenManager-shaped fake whose getStatus() returns the
 * supplied status. We only care about getStatus() in this helper; other
 * methods are not invoked by checkAuthGate.
 */
function fakeTokenManager(status: TokenManagerStatus): TokenManager {
  return { getStatus: () => status } as unknown as TokenManager;
}

/** Build a Hono app that exposes /probe → returns checkAuthGate result. */
function buildProbeApp(status: TokenManagerStatus): Hono {
  const tm = fakeTokenManager(status);
  const app = new Hono();
  app.get("/probe", (c) => {
    const gateResp = checkAuthGate(c, tm);
    if (gateResp !== null) return gateResp;
    return c.json({ ok: true });
  });
  return app;
}

describe("checkAuthGate — status === 'ready' → null (proceed)", () => {
  it("returns null AND lets the handler body run", async () => {
    const app = buildProbeApp("ready");
    const r = await app.request("/probe");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("checkAuthGate — status === 'disposed' → 503 service_unavailable + Connection: close", () => {
  it("returns a 503 with the disposed-state shape", async () => {
    const app = buildProbeApp("disposed");
    const r = await app.request("/probe");
    expect(r.status).toBe(503);
    expect(r.headers.get("connection")?.toLowerCase()).toBe("close");
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("service_unavailable");
    expect(body.error.message).toBe("Proxy is shutting down");
  });
});

describe("checkAuthGate — status === 'failed' → 503 auth_failed", () => {
  it("returns a 503 with the failed-state shape (NO Connection: close)", async () => {
    const app = buildProbeApp("failed");
    const r = await app.request("/probe");
    expect(r.status).toBe(503);
    // Only "disposed" sets Connection: close; "failed" does not.
    expect(r.headers.get("connection")?.toLowerCase()).not.toBe("close");
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("auth_failed");
    expect(body.error.message).toContain("Copilot");
  });
});

describe("checkAuthGate — status === 'starting' → 503 auth_pending", () => {
  it("returns a 503 with the starting-state shape", async () => {
    const app = buildProbeApp("starting");
    const r = await app.request("/probe");
    expect(r.status).toBe(503);
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("auth_pending");
    expect(body.error.message).toBe("TokenManager initializing");
  });
});

describe("checkAuthGate — status === 'uninitialized' → 503 auth_pending", () => {
  it("returns a 503 with the uninitialized-state shape (same as 'starting')", async () => {
    const app = buildProbeApp("uninitialized");
    const r = await app.request("/probe");
    expect(r.status).toBe(503);
    const body = (await r.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("auth_pending");
    expect(body.error.message).toBe("TokenManager initializing");
  });
});
