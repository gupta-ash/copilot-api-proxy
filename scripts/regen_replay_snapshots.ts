/**
 * Regenerate or check public SSE snapshots using the source replay pipeline.
 *
 * Usage:
 *   bun run scripts/regen_replay_snapshots.ts --bundle PATH --expected-bundle-sha256 HASH [--lane LANE] [--check-only] [--force]
 *
 * Both bundle arguments are required. The exact bundle bytes must match the
 * operator-selected SHA-256 before any lane is replayed or snapshot changed.
 * This is a provenance gate, not a bundle executor: replayLane still exercises
 * this checkout's forwarders and transformation rules. Review source changes
 * and snapshot differences together when intentionally selecting a new baseline.
 *
 * --force may remove an empty expected file only in regeneration mode; ordinary
 * replay and --check-only retain the guard against vacuous empty snapshots.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replayLane } from "../tests/integration/_replay_helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "tests/fixtures/stream-replay");

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

interface CliArgs {
  bundlePath: string;
  expectedBundleSha: string;
  lane: string | null;
  checkOnly: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let bundlePath: string | null = null;
  let expectedBundleSha: string | null = null;
  let lane: string | null = null;
  let checkOnly = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle" || a === "--expected-bundle-sha256") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`${a} requires a value`);
      }
      if (a === "--bundle") bundlePath = resolve(next);
      else expectedBundleSha = next.toLowerCase();
      i++;
      continue;
    }
    if (a === "--lane") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail("--lane requires a value (e.g. --lane cc_gpt55_thinking)");
      }
      lane = next;
      i++;
      continue;
    }
    if (a === "--check-only") {
      checkOnly = true;
      continue;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "usage: bun run scripts/regen_replay_snapshots.ts --bundle PATH --expected-bundle-sha256 HASH [--lane LANE] [--check-only] [--force]",
      );
      process.exit(0);
    }
    fail(`unknown argument: ${a}`);
  }
  if (bundlePath === null || expectedBundleSha === null) {
    fail("--bundle and --expected-bundle-sha256 are required");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedBundleSha)) {
    fail("--expected-bundle-sha256 must contain 64 hexadecimal digits");
  }
  return { bundlePath, expectedBundleSha, lane, checkOnly, force };
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`regen_replay_snapshots: ERROR — ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bundle SHA gate — refuse to replay or regenerate on drift.
// ---------------------------------------------------------------------------

function verifyBundleSha(bundlePath: string, expectedBundleSha: string): void {
  if (!existsSync(bundlePath)) {
    fail(`bundle not found at ${bundlePath}`);
  }
  const bytes = readFileSync(bundlePath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== expectedBundleSha) {
    fail(
      `Bundle SHA drift detected; refusing to replay or regenerate fixtures. ` +
        `expected=${expectedBundleSha} got=${sha} bundle=${bundlePath}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `regen_replay_snapshots: bundle SHA verified (${expectedBundleSha})`,
  );
}

// ---------------------------------------------------------------------------
// Lane discovery — list every subdir of FIXTURES_ROOT containing both
// `upstream.sse` and `lane.json`.
// ---------------------------------------------------------------------------

function listLanes(filter: string | null): string[] {
  if (!existsSync(FIXTURES_ROOT)) {
    fail(`fixtures root not found at ${FIXTURES_ROOT}`);
  }
  const entries = readdirSync(FIXTURES_ROOT, { withFileTypes: true });
  const dirs: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (filter !== null && ent.name !== filter) continue;
    const dir = resolve(FIXTURES_ROOT, ent.name);
    if (!existsSync(resolve(dir, "upstream.sse"))) continue;
    if (!existsSync(resolve(dir, "lane.json"))) continue;
    dirs.push(dir);
  }
  if (filter !== null && dirs.length === 0) {
    fail(`no lane directory matched --lane ${filter}`);
  }
  if (dirs.length === 0) {
    fail(`no lane fixtures found under ${FIXTURES_ROOT}`);
  }
  return dirs.sort();
}

// ---------------------------------------------------------------------------
// Per-lane regen.
// ---------------------------------------------------------------------------

interface LaneOutcome {
  laneDir: string;
  lane: string;
  emittedBytes: number;
  wrote: boolean;
  matched: boolean;
  message: string;
}

/** Regenerate or check one lane, preserving the opt-in empty-file repair. */
async function regenOne(
  laneDir: string,
  checkOnly: boolean,
  force: boolean,
): Promise<LaneOutcome> {
  const lane = laneDir.split(/[\\/]/).pop() ?? laneDir;
  const expectedPath = resolve(laneDir, "expected_client.sse");

  // Only an explicit regeneration request may remove an empty snapshot.
  if (
    !checkOnly &&
    force &&
    existsSync(expectedPath) &&
    readFileSync(expectedPath).byteLength === 0
  ) {
    unlinkSync(expectedPath);
    // eslint-disable-next-line no-console
    console.error(
      `regen_replay_snapshots: --force removed 0-byte ${expectedPath}`,
    );
  }

  // The replay helper is the canonical entry point — it reads the lane
  // dir, constructs the mock upstream + ctx + config, and invokes
  // forwardStreamTranslated. We then write/compare the emitted bytes.
  const result = await replayLane(laneDir);
  const { emittedBytes } = result;

  if (checkOnly) {
    if (!existsSync(expectedPath)) {
      return {
        laneDir,
        lane,
        emittedBytes: emittedBytes.byteLength,
        wrote: false,
        matched: false,
        message: `MISSING expected_client.sse (run without --check-only to seed)`,
      };
    }
    if (result.match) {
      return {
        laneDir,
        lane,
        emittedBytes: emittedBytes.byteLength,
        wrote: false,
        matched: true,
        message: "MATCH",
      };
    }
    return {
      laneDir,
      lane,
      emittedBytes: emittedBytes.byteLength,
      wrote: false,
      matched: false,
      message: `MISMATCH (diff${
        result.diff !== undefined ? `:\n${result.diff}` : " not computed"
      })`,
    };
  }

  // Regen mode — overwrite expected_client.sse with the freshly emitted
  // bytes. Operator review of the diff is the human gate; CI runs in
  // --check-only mode to flag accidental drift.
  writeFileSync(expectedPath, emittedBytes);
  const lanePath = resolve(laneDir, "lane.json");
  const metadata = JSON.parse(readFileSync(lanePath, "utf-8")) as {
    source: { expected_client_sha256: string };
  };
  metadata.source.expected_client_sha256 = createHash("sha256")
    .update(emittedBytes)
    .digest("hex");
  writeFileSync(lanePath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
  return {
    laneDir,
    lane,
    emittedBytes: emittedBytes.byteLength,
    wrote: true,
    matched: true,
    message: `WROTE ${expectedPath} (${emittedBytes.byteLength} bytes)`,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Gate both modes before discovering or changing any lane snapshots.
  verifyBundleSha(args.bundlePath, args.expectedBundleSha);

  const lanes = listLanes(args.lane);
  // eslint-disable-next-line no-console
  console.log(
    `regen_replay_snapshots: ${args.checkOnly ? "checking" : "regenerating"} ${lanes.length} lane(s)`,
  );

  const outcomes: LaneOutcome[] = [];
  for (const laneDir of lanes) {
    try {
      const outcome = await regenOne(laneDir, args.checkOnly, args.force);
      outcomes.push(outcome);
      // eslint-disable-next-line no-console
      console.log(
        `  [${outcome.lane}] ${outcome.message} (emitted=${outcome.emittedBytes}B)`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `  [${laneDir}] FAILED: ${(e as Error).message}\n${(e as Error).stack ?? ""}`,
      );
      outcomes.push({
        laneDir,
        lane: laneDir.split(/[\\/]/).pop() ?? laneDir,
        emittedBytes: 0,
        wrote: false,
        matched: false,
        message: `FAILED: ${(e as Error).message}`,
      });
    }
  }

  const failed = outcomes.filter((o) => !o.matched);
  // eslint-disable-next-line no-console
  console.log(
    `regen_replay_snapshots: ${outcomes.length - failed.length}/${outcomes.length} ${
      args.checkOnly ? "matched" : "wrote"
    }; ${failed.length} failed/missing`,
  );

  if (args.checkOnly && failed.length > 0) {
    process.exit(1);
  }
  // Non-check-only mode: even if some lanes failed (e.g. replay helper
  // threw), exit 1 so the operator notices.
  if (!args.checkOnly && failed.length > 0) {
    process.exit(1);
  }
}

void main();
