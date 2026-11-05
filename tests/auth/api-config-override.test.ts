/**
 * Tests for the COPILOT_PROXY_UPSTREAM_BASE_URL capture in src/auth/api-config.ts.
 *
 * WHY THESE SPAWN CHILDREN. `api-config.ts` reads the environment ONCE, at module
 * load. In-process mutation of `process.env` therefore cannot exercise the
 * positive cases: the module has already captured its value, and Bun shares the
 * module graph across a test file. A child process with the variable exported
 * before start is the only thing that can observe an override in force — so the
 * positive cases spawn, and the one in-process case asserts INERTNESS, which is
 * the property that makes the split necessary in the first place.
 *
 * The env keys below are written as LITERALS rather than imported from the
 * source. Importing the constant would make a typo in the source agree with the
 * test perfectly — the failure mode where every test is green and the operator's
 * documented variable does nothing.
 */

import path from "node:path";

import { describe, expect, it } from "bun:test";

const REPO = path.resolve(import.meta.dir, "..", "..");

const REAL_ENTERPRISE = "https://api.enterprise.githubcopilot.com";
const REAL_INDIVIDUAL = "https://api.githubcopilot.com";
const REAL_BUSINESS = "https://api.business.githubcopilot.com";

interface Probe {
  enterprise: string;
  individual: string;
  business: string;
  kind: string;
}

/**
 * Run a child that imports api-config.ts in a FRESH module graph and reports what
 * `copilotBaseUrl` resolves to for each account type.
 *
 * `env` is applied on top of the current environment; passing `undefined` for a
 * key deletes it, so the unset case is genuinely unset rather than empty.
 */
function probe(env: Record<string, string | undefined>): Probe {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }

  const script = `
    const m = await import("./src/auth/api-config.ts");
    process.stdout.write(JSON.stringify({
      enterprise: m.copilotBaseUrl("enterprise"),
      individual: m.copilotBaseUrl("individual"),
      business:   m.copilotBaseUrl("business"),
      kind:       m.OVERRIDE.kind,
    }));
  `;

  const r = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: REPO,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || out === "") {
    throw new Error(
      `probe child failed (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 800)}`,
    );
  }
  return JSON.parse(out) as Probe;
}

describe("copilotBaseUrl — override absent", () => {
  it("returns the real per-account-type hosts, byte-identical to pre-override behaviour", () => {
    const p = probe({ COPILOT_PROXY_UPSTREAM_BASE_URL: undefined });
    expect(p.kind).toBe("unset");
    expect(p.enterprise).toBe(REAL_ENTERPRISE);
    expect(p.individual).toBe(REAL_INDIVIDUAL);
    expect(p.business).toBe(REAL_BUSINESS);
  });

  it("treats an exported-but-empty variable exactly like an absent one", () => {
    const p = probe({ COPILOT_PROXY_UPSTREAM_BASE_URL: "" });
    expect(p.kind).toBe("unset");
    expect(p.enterprise).toBe(REAL_ENTERPRISE);
  });
});

describe("copilotBaseUrl — override in force", () => {
  it("wins for enterprise", () => {
    const p = probe({
      COPILOT_PROXY_UPSTREAM_BASE_URL: "http://127.0.0.1:9999",
    });
    expect(p.kind).toBe("ok");
    expect(p.enterprise).toBe("http://127.0.0.1:9999");
  });

  it("wins for individual AND business — it is a whole-upstream repoint, not per-tier", () => {
    const p = probe({
      COPILOT_PROXY_UPSTREAM_BASE_URL: "http://127.0.0.1:9999",
    });
    expect(p.individual).toBe("http://127.0.0.1:9999");
    expect(p.business).toBe("http://127.0.0.1:9999");
  });

  it("returns the override for every account type at once", () => {
    const p = probe({
      COPILOT_PROXY_UPSTREAM_BASE_URL: "https://stub.internal",
    });
    expect(new Set([p.enterprise, p.individual, p.business])).toEqual(
      new Set(["https://stub.internal"]),
    );
  });
});

describe("copilotBaseUrl — malformed override fails SAFE", () => {
  /**
   * The fail-safe direction is *ignore and keep the real host*, never *forward
   * the garbage*. `main.ts` refuses to boot on this, but `copilotBaseUrl` must
   * not depend on that: a caller reaching it with a malformed value in the
   * environment still gets the real upstream, not the operator's typo.
   */
  it("keeps the real host when the value is unparseable", () => {
    const p = probe({ COPILOT_PROXY_UPSTREAM_BASE_URL: "not a url" });
    expect(p.kind).toBe("error");
    expect(p.enterprise).toBe(REAL_ENTERPRISE);
    expect(p.individual).toBe(REAL_INDIVIDUAL);
  });

  it("keeps the real host when the value carries credentials", () => {
    const p = probe({
      COPILOT_PROXY_UPSTREAM_BASE_URL: "http://user:pw@127.0.0.1:9999",
    });
    expect(p.kind).toBe("error");
    expect(p.enterprise).toBe(REAL_ENTERPRISE);
  });

  it("never returns the raw offending string as a base URL", () => {
    for (const bad of [
      "not a url",
      "http://user:pw@h",
      "https://h/v1",
      "ftp://h",
    ]) {
      const p = probe({ COPILOT_PROXY_UPSTREAM_BASE_URL: bad });
      expect(p.enterprise).toBe(REAL_ENTERPRISE);
      expect(p.enterprise).not.toContain("@");
    }
  });
});

describe("the capture is at MODULE SCOPE, so an in-process set is inert", () => {
  /**
   * This is the property row 19 of the plan's Table 1 was reaching for, and the
   * wording that misled two independent readers: the override IS set here, in
   * this process, and it does NOTHING — because `api-config.ts` captured its
   * value when this file imported it. Both halves live in one test: assert the
   * real hosts, set the variable, assert they have not moved.
   */
  it("assigning the variable inside the test body does not move the resolved hosts", async () => {
    const m = await import("../../src/auth/api-config.ts");
    expect(m.copilotBaseUrl("enterprise")).toBe(REAL_ENTERPRISE);

    process.env["COPILOT_PROXY_UPSTREAM_BASE_URL"] = "http://127.0.0.1:1";
    try {
      expect(m.copilotBaseUrl("enterprise")).toBe(REAL_ENTERPRISE);
      expect(m.copilotBaseUrl("individual")).toBe(REAL_INDIVIDUAL);
      expect(m.OVERRIDE.kind).toBe("unset");
    } finally {
      delete process.env["COPILOT_PROXY_UPSTREAM_BASE_URL"];
    }
  });
});
