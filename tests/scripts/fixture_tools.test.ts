import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..", "..");
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "proxy-fixture-tools-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 15_000,
  });
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("extract_fixture explicit input and digest", () => {
  test("requires input, output and a well-formed expected SHA-256", () => {
    for (const args of [[], ["input.json"], ["input.json", "output.json"], ["input.json", "output.json", "not-a-digest"]]) {
      const result = run("extract_fixture.ts", args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("usage:");
    }
  });

  test("extracts exactly the synthetic body after validating upstream bytes", () => {
    const body = {
      model: "claude-test",
      system: [{ type: "text", text: "Use the fictional blue and gold palette." }],
      messages: [{ role: "user", content: "Name the two colors." }],
      metadata: { user_id: "synthetic-public-user" },
    };
    const bytes = JSON.stringify({ request: { body } });
    const input = join(scratch, "flow.json");
    const output = join(scratch, "body.json");
    writeFileSync(input, bytes);
    const result = run("extract_fixture.ts", [input, output, digest(bytes).toUpperCase()]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf-8"))).toEqual(body);
    expect(result.stdout).toContain(`input SHA-256=${digest(bytes)}`);
    expect(result.stdout).not.toContain("REDACTION OK");
  });

  test("digest mismatch cannot overwrite output", () => {
    const input = join(scratch, "flow.json");
    const output = join(scratch, "body.json");
    writeFileSync(input, JSON.stringify({ request: { body: { model: "test" } } }));
    writeFileSync(output, "preserve me");
    const result = run("extract_fixture.ts", [input, output, "0".repeat(64)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256 mismatch");
    expect(readFileSync(output, "utf-8")).toBe("preserve me");
  });

  test("rejects a matching-hash flow without an object request body", () => {
    const input = join(scratch, "flow.json");
    const bytes = JSON.stringify({ request: { body: "not an object" } });
    writeFileSync(input, bytes);
    const result = run("extract_fixture.ts", [input, join(scratch, "body.json"), digest(bytes)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body");
  });
});

describe("extract_replay_fixture input selection", () => {
  test("prefers full SSE over the legacy prefix and reports prefix truncation", () => {
    const prefix = 'data: {"type":"response.created"}\n\n';
    const full = prefix + 'data: {"type":"response.completed"}\n\n';
    const input = join(scratch, "flow.json");
    const output = join(scratch, "upstream.sse");
    const response = {
      headers: { "Content-Type": "text/event-stream" },
      body_kind: "sse",
      body: { raw_full: full, raw_first_2k: prefix, raw_full_size: full.length },
    };
    writeFileSync(input, JSON.stringify({ response }));
    const complete = run("extract_replay_fixture.ts", [input, output]);
    expect(complete.status).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(full);
    expect(complete.stdout).not.toContain("TRUNCATED");
    writeFileSync(input, JSON.stringify({ response: { ...response, body: { raw_first_2k: prefix, raw_full_size: full.length } } }));
    const truncated = run("extract_replay_fixture.ts", [input, output]);
    expect(truncated.status).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(prefix);
    expect(truncated.stdout).toContain("TRUNCATED");
  });
});

describe("regen_replay_snapshots explicit bundle gate", () => {
  test("requires both bundle path and expected bundle digest", () => {
    const result = run("regen_replay_snapshots.ts", ["--check-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--bundle and --expected-bundle-sha256 are required");
  });

  test("a wrong digest fails before lane discovery in both modes", () => {
    const bundle = join(scratch, "bundle.js");
    writeFileSync(bundle, "// synthetic bundle provenance bytes\n");
    for (const mode of [[], ["--check-only"]]) {
      const result = run("regen_replay_snapshots.ts", [
        "--bundle", bundle,
        "--expected-bundle-sha256", "0".repeat(64),
        "--lane", "no-such-public-lane",
        ...mode,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Bundle SHA drift detected");
      expect(result.stderr).not.toContain("no lane directory matched");
    }
  });
});
