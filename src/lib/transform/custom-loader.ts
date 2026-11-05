/**
 * custom-loader.ts — boot-time lazy-loader for drop-in plugin rules
 * (D-LOCK-5 + D-LOCK-15 + R11-R15 from Plan v4).
 *
 * **Lane:** ALL lanes — operators drop `*.ts` files into
 * `${transforms.custom_dir}` (default `~/.local/share/copilot-proxy/
 * transforms/`) and the loader dynamic-imports each at boot. Each
 * file's side-effect `register()` / `registerStreamEvent()` populates
 * the rule registry just like a built-in rule.
 *
 * **NEW per M9 (D-LOCK-5 — drop-in code lazy-loader).** No upstream
 * cribbing (the bundle has no plugin concept). Cribs the structural
 * decision from `Plan v4 § R11-R15` (drop-in code support) +
 * `decisions.md § D-REQ-3` (per-stream snapshot semantics — the
 * loader runs ONCE at boot; mid-process plugin reload is OUT OF
 * SCOPE). Per `Plan v4 § R15` (sandbox boundary): operator-supplied
 * code from the operator-owned directory is treated as trusted (the
 * operator running the proxy implicitly trusts code they put in their
 * own home directory).
 *
 * **Contract (D-LOCK-5):**
 *
 *   loadCustomRules(customDir) →
 *     {loaded: string[], skipped: Array<{path, reason}>}
 *
 *   - If `customDir` does not exist OR is unreadable → returns
 *     `{loaded: [], skipped: []}` AND logs at `LEVEL_ON`. NOT an
 *     error — operators may legitimately have no custom rules.
 *   - For each `*.ts` file in `customDir` (ONE level only — no
 *     recursive walk per R15 sandbox boundary):
 *       1. Snapshot `list("body").length` + `list("stream_event").length`
 *          BEFORE the import (D-LOCK-15 #2).
 *       2. Dynamic-import via `import(pathToFileURL(absPath).href)` —
 *          NOT raw path (D-LOCK-15 #1; Bun's Windows ESM resolver
 *          accepts both today, but the locked contract uses URL form
 *          for cross-version safety).
 *       3. After import: if EITHER count grew → push to `loaded`.
 *          If NEITHER count changed → push to `skipped` with reason
 *          `"no register/registerStreamEvent side effect observed"`
 *          (D-LOCK-15 #2 — a plugin file that imports cleanly but
 *          registers nothing has unmet operator intent; surface it).
 *       4. On thrown exception: push to `skipped` with `err.message`.
 *          Continue to next file. The proxy NEVER crashes on a bad
 *          plugin (LKG-style; per Plan v4 R12-R14).
 *
 * **Sandbox boundary (R15).** ONE level only. Subdirectories are
 * ignored. `customDir` is sourced from `config.transforms.custom_dir`
 * (zod-defaulted to an ALREADY-ABSOLUTE `${APP_DIR}/transforms` per
 * `src/types/config-schema.ts § TransformsSectionSchema` — NOT the
 * tilde string `config/default.yaml` ships; see the expansion note in
 * `loadCustomRules`); operators own that path so loading from it is
 * equivalent to running operator-supplied code (already trusted).
 *
 * **Engine-version compat (R12, deferred to M10/M11 per D-LOCK-5).**
 * The loader does NOT yet enforce semver compatibility against
 * `ENGINE_VERSION`. Plugin authors MAY tag their `register(...)` call
 * with `version: "<semver-range>"` (the field exists on
 * `RegisteredRuleOpts`); M10/M11 will start enforcing. M9 stores but
 * does not validate.
 *
 * **Mid-stream reload semantics.** Out of scope per D-REQ-3. The
 * loader fires ONCE at boot. Any future hot-reload would need to
 * coordinate with `lib/transform/registry.ts § snapshot()`'s per-stream
 * snapshot semantics — in-flight streams hold frozen registries; only
 * NEW streams would pick up reloaded rules.
 *
 * **PATHS.APP_DIR per platform (B2).** `paths.ts § APP_DIR` resolves
 * to `os.homedir() + /.local/share/copilot-proxy` on ALL platforms
 * (Windows + Linux + macOS) — there is no per-platform branching. On
 * Windows that lands at e.g. `C:\Users\<u>\.local\share\copilot-proxy\
 * transforms\`. Operators on Windows who prefer `%APPDATA%` may
 * override via `transforms.custom_dir` in their `config.yaml`.
 *
 * **Cross-references.**
 *   - `Plan v4 § R11-R15` (drop-in code support + sandbox boundary)
 *   - `decisions.md § D-REQ-3` (per-stream snapshot semantics)
 *   - `interface-contracts.md § 6` (LoadResult shape + signature)
 *   - `plugin.ts` (the public-API surface plugins import from)
 *   - `tests/integration/custom_loader.test.ts` (integration tests — count
 *     deliberately not stated here; it read "7" against an actual 10 for an
 *     unknown span, and a number in a cross-reference decays with every test
 *     added while nothing checks it)
 *   - `tests/fixtures/custom-rules/log_route_summary.ts` (worked example)
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LEVEL_ON, debug } from "../debug.ts";
import { expandTilde } from "../paths.ts";

import { list } from "./registry.ts";

/**
 * Result of a `loadCustomRules` invocation. Caller (typically
 * `src/main.ts`) MAY log a startup summary like
 * `[custom-loader] loaded N, skipped M`.
 */
export interface LoadResult {
  /**
   * Absolute paths of files successfully loaded — the import did not
   * throw AND at least one of `body` / `stream_event` registry counts
   * changed (D-LOCK-15 #2).
   */
  loaded: string[];
  /**
   * Per-file failures with reason. The proxy boots without these
   * (LKG-style per Plan v4 R12-R14). Common reasons:
   *   - `"no register/registerStreamEvent side effect observed"` —
   *     plugin imported cleanly but registered nothing (D-LOCK-15 #2).
   *   - thrown error message — syntax error, register() throw, etc.
   */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Boot-time loader. Enumerates `*.ts` files in `customDir` (ONE level
 * only) and dynamic-imports each. Side-effect `register()` /
 * `registerStreamEvent()` calls inside each file populate the rule
 * registry.
 *
 * Returns `LoadResult`. The caller (main.ts) is responsible for
 * surfacing the result to the operator (e.g. via consola).
 *
 * **Throws nothing.** All per-file errors go into `skipped`. If
 * `customDir` is missing/unreadable, returns `{loaded: [], skipped: []}`
 * (legitimate operator state — no custom rules).
 *
 * @param customDir — path to the drop-in directory, absolute or
 *                    `~`-prefixed. Sourced from
 *                    `config.transforms.custom_dir`. A leading `~` is
 *                    expanded HERE, so callers pass the config value
 *                    straight through.
 */
export async function loadCustomRules(customDir: string): Promise<LoadResult> {
  const loaded: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  // Expand `~` BEFORE any filesystem call; `dir` is used for every one of
  // them below. Unexpanded, `fs.readdir` resolves the literal string against
  // CWD and the loader reports an empty directory — no error, no throw, just
  // `loaded 0, skipped 0` and a boot that looks normal.
  //
  // Only ONE of the two defaults is a tilde string, which is why this stayed
  // invisible: zod defaults to an already-absolute `${APP_DIR}/transforms`,
  // while the shipped `config/default.yaml:144` writes
  // `~/.local/share/copilot-proxy/transforms` literally — and config.yaml is
  // placed only-if-absent (F128/D95), so a box with NO `custom_dir` key or an
  // absolute one was always fine, and every box carrying that tilde string -
  // the fleet master's value, so every deployed box - was silently loading
  // nothing.
  //
  // Expanded here rather than at the `main.ts` call site, matching
  // `stall-detect.ts:195` and `incident-log.ts:437` — both expand inside the
  // module that owns the path. `main.ts:442` (trace_dir) is the third site.
  const dir = expandTilde(customDir);

  // --- Probe directory existence/readability -----------------------------
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(dir);
  } catch (err) {
    // ENOENT (no dir), EACCES (unreadable), etc. → legitimate empty
    // state. Log once at LEVEL_ON and return clean.
    const reason = err instanceof Error ? err.message : String(err);
    debug.on(
      LEVEL_ON,
      () =>
        `[custom-loader] ${dir}: dir not present or unreadable (${reason}); skipping`,
    );
    return { loaded, skipped };
  }

  // --- Enumerate *.ts files (ONE level only — R15 sandbox) ---------------
  // Filter:
  //   - .ts only (not .js, not .d.ts, not .test.ts — those are not the
  //     operator-rule shape we expect)
  //   - Skip subdirectories (R15: no recursion).
  //   - Skip dotfiles + leading-underscore "private" convention.
  const ruleFiles: string[] = [];
  for (const entry of dirEntries) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".d.ts") || entry.endsWith(".test.ts")) continue;
    const absolutePath = resolve(dir, entry);
    // Stat to skip subdirectories with a `.ts` name (rare but possible).
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;
    } catch {
      // Stat failed — skip without recording (the readdir already
      // succeeded, so this is a transient race; not the operator's
      // fault and not worth surfacing).
      continue;
    }
    ruleFiles.push(absolutePath);
  }

  // --- Dynamic-import each, with counts-changed success semantics --------
  for (const absolutePath of ruleFiles) {
    // Snapshot registry counts BEFORE import (D-LOCK-15 #2).
    const beforeBody = list("body").length;
    const beforeStream = list("stream_event").length;

    try {
      // D-LOCK-15 #1: pathToFileURL on Windows for Bun's ESM resolver.
      // Both raw path and file:// URL work in current Bun, but the
      // URL form is the documented cross-platform pattern; lock it.
      await import(pathToFileURL(absolutePath).href);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      debug.on(
        LEVEL_ON,
        () => `[custom-loader] skipped ${absolutePath}: ${reason}`,
      );
      skipped.push({ path: absolutePath, reason });
      continue;
    }

    // Counts-changed success semantics (D-LOCK-15 #2). A plugin that
    // imports cleanly but registers nothing has unmet operator intent
    // — surface it as a skip with a documented reason rather than
    // silently treating it as a successful load.
    const afterBody = list("body").length;
    const afterStream = list("stream_event").length;
    if (afterBody === beforeBody && afterStream === beforeStream) {
      const reason = "no register/registerStreamEvent side effect observed";
      debug.on(
        LEVEL_ON,
        () => `[custom-loader] skipped ${absolutePath}: ${reason}`,
      );
      skipped.push({ path: absolutePath, reason });
      continue;
    }

    loaded.push(absolutePath);
  }

  return { loaded, skipped };
}
