/**
 * logging.test.ts — unit coverage for the /admin/logging control-plane
 * handlers (Feature: dynamic logging toggle).
 *
 *   GET  → returns the current level name.
 *   POST → total-safe body parse; a valid level flips debug.getLevel() live +
 *          returns {previous,current}; invalid / missing / malformed input →
 *          400 (never a 500), and the level is left unchanged.
 *
 * The handlers are mounted on a throwaway Hono app (mirroring how server.ts
 * mounts them RAW after /metrics) and exercised via `app.request(...)`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";
import { Hono } from "hono";

import {
  LEVEL_OFF,
  LEVEL_ON,
  LEVEL_RAW,
  LEVEL_VERBOSE,
  debug,
  parseLevel,
} from "../../../src/lib/debug.ts";
import { makeLoggingHandlers } from "../../../src/routes/admin/logging-handler.ts";

function buildTestApp(traceCaptureAvailable = true): Hono {
  const app = new Hono();
  const { getHandler, postHandler } = makeLoggingHandlers(
    traceCaptureAvailable,
  );
  app.get("/admin/logging", getHandler);
  app.post("/admin/logging", postHandler);
  return app;
}

// consola.warn capture (POST-to-raw emits the PII warning).
let warnMessages: string[] = [];
let originalWarnFn: typeof consola.warn;

beforeEach(() => {
  warnMessages = [];
  originalWarnFn = consola.warn;
  consola.warn = ((msg: unknown, ...rest: unknown[]): void => {
    const flat = [msg, ...rest]
      .map((m) => (typeof m === "string" ? m : String(m)))
      .join(" ");
    warnMessages.push(flat);
  }) as typeof consola.warn;
  debug.setLevel(LEVEL_ON);
});
afterEach(() => {
  consola.warn = originalWarnFn;
  debug.setLevel(LEVEL_ON);
});

describe("/admin/logging GET", () => {
  it("returns the current level name", async () => {
    debug.setLevel(LEVEL_RAW);
    const app = buildTestApp();
    const r = await app.request("/admin/logging");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ level: "raw" });
  });

  it("reflects each of the 4 level names", async () => {
    const app = buildTestApp();
    const cases = [
      ["off", LEVEL_OFF],
      ["on", LEVEL_ON],
      ["raw", LEVEL_RAW],
      ["verbose", LEVEL_VERBOSE],
    ] as const;
    for (const [name, lvl] of cases) {
      debug.setLevel(lvl);
      const r = await app.request("/admin/logging");
      expect(await r.json()).toEqual({ level: name });
    }
  });
});

describe("/admin/logging POST — valid", () => {
  it("valid level flips the live level + returns {previous,current}", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previous: "on", current: "raw" });
    expect(debug.getLevel()).toBe(LEVEL_RAW);
  });

  it("accepts every valid level name + updates debug.getLevel()", async () => {
    const app = buildTestApp();
    for (const name of ["off", "on", "raw", "verbose"] as const) {
      const r = await app.request("/admin/logging", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: name }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { previous: string; current: string };
      expect(body.current).toBe(name);
      expect(debug.getLevel()).toBe(parseLevel(name));
    }
  });

  it("POST that raises to raw emits the PII warning once", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(200);
    const piiWarns = warnMessages.filter((m) =>
      m.includes("raw mode captures full request/response bodies"),
    );
    expect(piiWarns.length).toBe(1);
  });

  it("POST that lowers to off does NOT emit the PII warning", async () => {
    debug.setLevel(LEVEL_RAW);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "off" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previous: "raw", current: "off" });
    const piiWarns = warnMessages.filter((m) =>
      m.includes("raw mode captures full request/response bodies"),
    );
    expect(piiWarns.length).toBe(0);
  });
});

describe("/admin/logging POST — invalid (400, never 500; level unchanged)", () => {
  it("unknown level name → 400 + valid list; does NOT fall back to LEVEL_ON", async () => {
    debug.setLevel(LEVEL_VERBOSE);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "trace" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; valid: string[] };
    expect(body.error).toContain("invalid level");
    expect(body.valid).toEqual(["off", "on", "raw", "verbose"]);
    // Critically: the rejected value did NOT silently downgrade the level to
    // parseLevel's LEVEL_ON fallback — it stayed exactly what it was.
    expect(debug.getLevel()).toBe(LEVEL_VERBOSE);
  });

  it("missing level field → 400; level unchanged", async () => {
    debug.setLevel(LEVEL_RAW);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(r.status).toBe(400);
    expect(debug.getLevel()).toBe(LEVEL_RAW);
  });

  it("non-string level (number) → 400; level unchanged", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: 2 }),
    });
    expect(r.status).toBe(400);
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });

  it("empty body → 400 (no throw); level unchanged", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect(r.status).toBe(400);
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });

  it("garbage (non-JSON) body → 400 (no throw); level unchanged", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "}{not json at all",
    });
    expect(r.status).toBe(400);
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });

  it("JSON null body → 400; level unchanged", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(r.status).toBe(400);
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });
});

describe("/admin/logging POST — trace capture unavailable (FIX 1: 503 refusal)", () => {
  it("raw requested while capture unavailable → 503; level unchanged; refusal warn; no PII warn", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp(false);
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as {
      error: string;
      requested: string;
      valid: string[];
    };
    expect(body.error).toContain("trace capture unavailable");
    expect(body.requested).toBe("raw");
    expect(body.valid).toEqual(["off", "on", "raw", "verbose"]);
    // The level must NOT have flipped — capture stays structurally off.
    expect(debug.getLevel()).toBe(LEVEL_ON);
    // A server-side refusal warning IS emitted (operator visibility)...
    expect(warnMessages.some((m) => m.includes("refused"))).toBe(true);
    // ...but NOT the PII enablement warning (nothing was enabled).
    const piiWarns = warnMessages.filter((m) =>
      m.includes("raw mode captures full request/response bodies"),
    );
    expect(piiWarns.length).toBe(0);
  });

  it("verbose requested while capture unavailable → 503; level unchanged", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp(false);
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "verbose" }),
    });
    expect(r.status).toBe(503);
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });

  it("off is still allowed while capture unavailable → 200 (needs no writer)", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp(false);
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "off" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previous: "on", current: "off" });
    expect(debug.getLevel()).toBe(LEVEL_OFF);
  });

  it("on is still allowed while capture unavailable → 200 (needs no writer)", async () => {
    debug.setLevel(LEVEL_OFF);
    const app = buildTestApp(false);
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "on" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previous: "off", current: "on" });
    expect(debug.getLevel()).toBe(LEVEL_ON);
  });
});

describe("/admin/logging POST — PII warning only on below-raw→raw+ edge (FIX 2)", () => {
  function piiWarnCount(): number {
    return warnMessages.filter((m) =>
      m.includes("raw mode captures full request/response bodies"),
    ).length;
  }

  it("off → raw warns once", async () => {
    debug.setLevel(LEVEL_OFF);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(200);
    expect(piiWarnCount()).toBe(1);
  });

  it("on → verbose warns once", async () => {
    debug.setLevel(LEVEL_ON);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "verbose" }),
    });
    expect(r.status).toBe(200);
    expect(piiWarnCount()).toBe(1);
  });

  it("raw → raw does NOT warn (no re-spam on re-POST)", async () => {
    debug.setLevel(LEVEL_RAW);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(200);
    expect(piiWarnCount()).toBe(0);
  });

  it("verbose → raw does NOT warn (already above the edge)", async () => {
    debug.setLevel(LEVEL_VERBOSE);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "raw" }),
    });
    expect(r.status).toBe(200);
    expect(piiWarnCount()).toBe(0);
  });

  it("raw → off does NOT warn", async () => {
    debug.setLevel(LEVEL_RAW);
    const app = buildTestApp();
    const r = await app.request("/admin/logging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "off" }),
    });
    expect(r.status).toBe(200);
    expect(piiWarnCount()).toBe(0);
  });
});
