/**
 * config_unification.test.ts — D-LOCK-3 verification.
 *
 * Verifies:
 *   1. lib/config.ts now uses types/config-schema.ts schema (canonical Config
 *      shape: routes + transforms + logging + auth + server).
 *   2. Hot-reload works against the full schema.
 *   3. M1a-compat preprocess: legacy YAML with top-level `debug` and
 *      `trace_dir` parses successfully and surfaces under `logging.*`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { ConfigManager } from "../../src/lib/config.ts";

let tempDirs: Array<string> = [];

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-uni-"));
  tempDirs.push(d);
  return d;
}

const M4_FULL_YAML = `
server:
  port: 4143
  host: 0.0.0.0
logging:
  level: raw
  trace_dir: ./traces-uni
  warn_size_mb: 100
auth:
  account_type: enterprise
  vs_code_version: "1.95.0"
transforms:
  custom_dir: /tmp/transforms-uni
routes: []
`;

const M1A_LEGACY_YAML = `
debug: raw
trace_dir: ./legacy-traces
server:
  port: 4145
  host: 0.0.0.0
`;

describe("D-LOCK-3 config unification", () => {
  it("loads a full M4-shape config via lib/config.ts (canonical schema)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeFile(fpath, M4_FULL_YAML, "utf-8");
    const cm = new ConfigManager({ path: fpath, watch: false });
    await cm.start();
    const c = cm.get();
    expect(c.server.port).toBe(4143);
    expect(c.logging.level).toBe("raw");
    expect(c.logging.trace_dir).toBe("./traces-uni");
    expect(c.auth.account_type).toBe("enterprise");
    expect(c.routes).toEqual([]);
    expect(c.transforms.custom_dir).toBe("/tmp/transforms-uni");
    await cm.dispose();
  });

  it("M1a-compat preprocess folds top-level debug/trace_dir into logging.*", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeFile(fpath, M1A_LEGACY_YAML, "utf-8");
    const cm = new ConfigManager({ path: fpath, watch: false });
    await cm.start();
    const c = cm.get();
    // The preprocess should have moved these to logging.*.
    expect(c.logging.level).toBe("raw");
    expect(c.logging.trace_dir).toBe("./legacy-traces");
    expect(c.server.port).toBe(4145);
    await cm.dispose();
  });

  it("hot-reload works against the full schema (write → reload → new value)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeFile(fpath, M4_FULL_YAML, "utf-8");
    const cm = new ConfigManager({ path: fpath, watch: true, debounceMs: 50 });
    await cm.start();
    expect(cm.get().server.port).toBe(4143);

    const updated = M4_FULL_YAML.replace("port: 4143", "port: 4146");
    await writeFile(fpath, updated, "utf-8");
    await new Promise((r) => setTimeout(r, 400));
    expect(cm.get().server.port).toBe(4146);
    await cm.dispose();
  });
});
