/**
 * custom_loader.test.ts — integration tests for `loadCustomRules`
 * (M9 D-LOCK-5 + D-LOCK-15, mini-audit items 42-47).
 *
 * Coverage:
 *   42. non-existent customDir → returns clean LoadResult, no throw.
 *   43. customDir with valid plugin → loaded[].length===1 + rule in registry.
 *   44. customDir with syntax-broken plugin → skipped[] entry; OTHER plugins
 *       in same dir still load.
 *   45. customDir with plugin throwing inside register() → caught, skipped[]
 *       entry; OTHER plugins still load.
 *   46. (D-LOCK-15 #2) syntactically-valid plugin that registers nothing →
 *       skipped[] with documented reason.
 *   47. loader does NOT recurse into subdirs (R15 sandbox boundary).
 *
 * Added later (no mini-audit item — the defect postdates that audit):
 *   - a leading `~` in customDir resolves against HOME rather than CWD, and
 *     a non-tilde path is passed through unchanged.
 *
 * Strategy:
 *   - Each test creates a fresh tmpdir via `mkdtemp` and writes plugin
 *     source files via `writeFile`.
 *   - Plugin source uses ABSOLUTE paths (file:// URLs converted from the
 *     project's src/lib/... paths) for engine-module imports — the `~/`
 *     tsconfig alias does NOT resolve from tmpdir-located files, so the
 *     spec's "tmpdir copies of fixture" is implemented by generating
 *     fixture content with the right import paths instead of literally
 *     copying the canonical fixture (which uses `~/` and only works when
 *     loaded from inside the project tree).
 *   - Each test calls `resetRegistry()` in afterEach to keep the global
 *     body / stream-event registry clean across tests.
 *
 * D-LOCK-15 #1 verification — `pathToFileURL` is used in the loader on
 * Windows; the integration tests further verify the loaded paths show
 * up as native filesystem paths in `LoadResult.loaded` (NOT as
 * `file:///...` URLs — the loader converts back to absolute paths
 * before returning).
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { loadCustomRules } from "~/lib/transform/custom-loader";
import { list, reset as resetRegistry, get } from "~/lib/transform/registry";

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
  resetRegistry();
});

async function makeTempCustomDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-cl-"));
  tempDirs.push(d);
  return d;
}

/**
 * Same, but rooted at `os.homedir()` so the directory is addressable as
 * `~/<basename>`. Required by the tilde-expansion test: `tmpdir()` is NOT
 * under home on any platform we run on, so a `~`-prefixed path could not
 * name it. Registered in `tempDirs`, so afterEach removes it.
 */
async function makeTempHomeDir(): Promise<string> {
  const d = await mkdtemp(path.join(homedir(), ".copilot-proxy-cl-"));
  tempDirs.push(d);
  return d;
}

/**
 * Resolve the absolute path of an engine module so a tmpdir-located
 * plugin can import it without relying on tsconfig path aliases.
 * Returns a file:// URL string suitable for inlining into a plugin's
 * `import "..."` statement.
 */
function engineModuleHref(relPathFromSrc: string): string {
  // tests/integration/X.test.ts → ../../src/<relPathFromSrc>
  const abs = path.resolve(import.meta.dir, "..", "..", "src", relPathFromSrc);
  return pathToFileURL(abs).href;
}

/**
 * Produce a valid plugin source-file content that registers a rule
 * with the given `ruleName`. Uses absolute file:// URL imports so the
 * file works when located in any directory (including OS tmpdir).
 */
function validPluginSource(ruleName: string): string {
  const pluginHref = engineModuleHref("lib/transform/plugin.ts");
  // A bare "zod" specifier does NOT resolve from a tmpdir-located plugin:
  // nothing on the upward walk from the OS temp dir has a node_modules.
  // Resolve it here — from inside the project tree — and inline the
  // absolute href, exactly as `pluginHref` above does for engine modules.
  const zodHref = import.meta.resolve("zod");
  // Convert the rule name to a JS-safe identifier for the binding.
  const ident = ruleName.replace(/[^A-Za-z0-9_]/g, "_");
  return `import { z } from "${zodHref}";
import { register } from "${pluginHref}";

const ${ident}Schema = z
  .object({
    name: z.string().min(1),
    use: z.literal("${ruleName}"),
  })
  .passthrough();

const ${ident} = (ctx, _options) => {
  return { ctx, applied: false };
};

register("${ruleName}", ${ident}, ${ident}Schema, {
  ctx_reads: ["body"],
  ctx_writes: ["body"],
});

export { ${ident}, ${ident}Schema };
`;
}

/**
 * Plugin source that imports cleanly + executes top-level code but
 * does NOT call `register()` — exercises D-LOCK-15 #2 counts-changed
 * skip behavior.
 */
function noRegisterPluginSource(): string {
  return `// Valid TS that does NOT call register(). Plugin author wrote a
// helper module by mistake (or intentionally — but the loader has
// no way to know).
export const SOMETHING = 42;
`;
}

/**
 * Plugin source with a syntax error. Bun's import will throw at
 * parse-time — the loader catches and pushes to skipped[].
 */
function syntaxBrokenPluginSource(): string {
  return `import { register from "@@@@";  // syntax error
register(no_quotes, missing_args);
`;
}

/**
 * Plugin source that throws inside the body of register() invocation
 * (e.g. bad schema → engine throws on registration). We simulate this
 * by throwing in module top-level code BEFORE register would be
 * called.
 */
function throwAtImportPluginSource(): string {
  return `// Plugin that throws at import time (simulates register() throwing,
// since register's own throw would happen at the same lifecycle stage:
// during the dynamic import's promise resolution).
throw new Error("intentional throw at plugin top-level for test");
`;
}

// ---------------------------------------------------------------------------
// Mini-audit item 42 — non-existent customDir
// ---------------------------------------------------------------------------

describe("loadCustomRules — non-existent customDir (item 42)", () => {
  test("returns {loaded: [], skipped: []} without throw", async () => {
    const phantomPath = path.join(
      tmpdir(),
      `nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const result = await loadCustomRules(phantomPath);
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("returns {loaded: [], skipped: []} for an unreadable / missing dir on Windows path syntax", async () => {
    // Windows: a path with an invalid drive letter is missing rather
    // than unreadable. Either way the loader returns clean.
    const result = await loadCustomRules("Q:/nonexistent/copilot-proxy-test");
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tilde expansion — a `~`-prefixed customDir resolves against HOME, not CWD
// ---------------------------------------------------------------------------

describe("loadCustomRules — leading `~` in customDir", () => {
  test("`~/<dir>` loads plugins from HOME, not from the process CWD", async () => {
    // The shipped `config/default.yaml` writes
    // `custom_dir: ~/.local/share/copilot-proxy/transforms` literally, and
    // config.yaml is placed only-if-absent, so this is the shape every
    // deployed box actually has. Unexpanded, `fs.readdir` resolved the raw
    // string against CWD, the loader reported `loaded 0, skipped 0`, and the
    // proxy booted normally — a silent no-op with no error anywhere.
    const homeDir = await makeTempHomeDir();
    const plugin = path.join(homeDir, "test_rule_tilde.ts");
    await writeFile(plugin, validPluginSource("test_rule_tilde"));

    // Address it the way a config file does: `~/` + basename.
    const tildePath = `~/${path.basename(homeDir)}`;
    const result = await loadCustomRules(tildePath);

    expect(result.skipped).toEqual([]);
    expect(result.loaded.length).toBe(1);
    // Pins WHERE it resolved, not merely that something loaded: the returned
    // path must be the home-rooted absolute one. Without expansion this whole
    // test sees an empty ENOENT result instead.
    expect(result.loaded[0]).toBe(plugin);
    expect(list("body")).toContain("test_rule_tilde");
  });

  test("a non-tilde absolute path is passed through unchanged", async () => {
    // Guards the other direction: expansion must not rewrite a path that has
    // no leading `~`. Without this, a fix that unconditionally joined against
    // home would break every operator using an absolute custom_dir.
    const dir = await makeTempCustomDir();
    const plugin = path.join(dir, "test_rule_abs.ts");
    await writeFile(plugin, validPluginSource("test_rule_abs"));

    const result = await loadCustomRules(dir);

    expect(result.skipped).toEqual([]);
    expect(result.loaded[0]).toBe(plugin);
  });
});

// ---------------------------------------------------------------------------
// Mini-audit item 43 — valid plugin loads + registers
// ---------------------------------------------------------------------------

describe("loadCustomRules — valid plugin (item 43)", () => {
  test("loaded contains the path; rule appears in body registry", async () => {
    const dir = await makeTempCustomDir();
    const plugin = path.join(dir, "test_rule_43.ts");
    await writeFile(plugin, validPluginSource("test_rule_43"));

    const result = await loadCustomRules(dir);

    expect(result.skipped).toEqual([]);
    expect(result.loaded.length).toBe(1);
    // D-LOCK-15 #1: returned path is a native absolute path, NOT a
    // file:// URL (loader converts back).
    expect(result.loaded[0]).toBe(plugin);
    // Rule actually landed in the body registry.
    expect(list("body")).toContain("test_rule_43");
    expect(get("body", "test_rule_43")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mini-audit item 44 — syntax-broken plugin → skipped, others still load
// ---------------------------------------------------------------------------

describe("loadCustomRules — syntax-broken plugin (item 44)", () => {
  test("broken plugin → skipped[] entry; valid plugin in same dir still loads", async () => {
    const dir = await makeTempCustomDir();
    const broken = path.join(dir, "a_broken_44.ts");
    const good = path.join(dir, "z_good_44.ts");
    await writeFile(broken, syntaxBrokenPluginSource());
    await writeFile(good, validPluginSource("test_rule_44_good"));

    const result = await loadCustomRules(dir);

    expect(result.loaded.length).toBe(1);
    expect(result.loaded[0]).toBe(good);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(broken);
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
    // Good plugin still in registry.
    expect(list("body")).toContain("test_rule_44_good");
  });
});

// ---------------------------------------------------------------------------
// Mini-audit item 45 — plugin throws at register() time
// ---------------------------------------------------------------------------

describe("loadCustomRules — plugin throws at import time (item 45)", () => {
  test("throw caught + skipped[] entry; OTHER plugins in same dir still load", async () => {
    const dir = await makeTempCustomDir();
    const throwy = path.join(dir, "a_throwy_45.ts");
    const good = path.join(dir, "z_good_45.ts");
    await writeFile(throwy, throwAtImportPluginSource());
    await writeFile(good, validPluginSource("test_rule_45_good"));

    const result = await loadCustomRules(dir);

    expect(result.loaded.length).toBe(1);
    expect(result.loaded[0]).toBe(good);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(throwy);
    expect(result.skipped[0]?.reason).toContain("intentional throw");
    expect(list("body")).toContain("test_rule_45_good");
  });
});

// ---------------------------------------------------------------------------
// Mini-audit item 46 — D-LOCK-15 #2 counts-changed semantics
// ---------------------------------------------------------------------------

describe("loadCustomRules — plugin with no register() call (item 46, D-LOCK-15 #2)", () => {
  test("syntactically valid but no side effect → skipped with documented reason", async () => {
    const dir = await makeTempCustomDir();
    const noregister = path.join(dir, "no_register_46.ts");
    await writeFile(noregister, noRegisterPluginSource());

    const result = await loadCustomRules(dir);

    expect(result.loaded).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(noregister);
    expect(result.skipped[0]?.reason).toBe(
      "no register/registerStreamEvent side effect observed",
    );
  });

  test("counts-changed succeeds when EITHER body OR stream_event grew", async () => {
    // Body-rule plugin → body count grows → loaded.
    const dir = await makeTempCustomDir();
    const body = path.join(dir, "body_46_grow.ts");
    await writeFile(body, validPluginSource("test_rule_46_body_grow"));
    const result = await loadCustomRules(dir);
    expect(result.loaded.length).toBe(1);
    expect(result.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mini-audit item 47 — sandbox boundary (no recursion)
// ---------------------------------------------------------------------------

describe("loadCustomRules — sandbox boundary (item 47, R15)", () => {
  test("subdirectory plugins are NOT loaded", async () => {
    const dir = await makeTempCustomDir();
    const subdir = path.join(dir, "nested");
    await mkdir(subdir, { recursive: true });
    // Plugin in subdir — should be IGNORED.
    const nested = path.join(subdir, "nested_rule_47.ts");
    await writeFile(nested, validPluginSource("test_rule_47_nested"));
    // Plugin at top level — should be LOADED.
    const top = path.join(dir, "top_rule_47.ts");
    await writeFile(top, validPluginSource("test_rule_47_top"));

    const result = await loadCustomRules(dir);

    expect(result.loaded.length).toBe(1);
    expect(result.loaded[0]).toBe(top);
    expect(list("body")).toContain("test_rule_47_top");
    expect(list("body")).not.toContain("test_rule_47_nested");
  });

  test("non-.ts files (e.g. .js, .d.ts, .test.ts, dotfiles) are ignored", async () => {
    const dir = await makeTempCustomDir();
    // These should all be ignored.
    await writeFile(
      path.join(dir, "ignored.js"),
      "console.log('should not load');",
    );
    await writeFile(path.join(dir, "ignored.d.ts"), "export type T = number;");
    await writeFile(
      path.join(dir, "ignored.test.ts"),
      "// test file should not load as a plugin",
    );
    await writeFile(path.join(dir, ".dotfile"), "ignored");
    await writeFile(path.join(dir, "_private.ts"), "// underscore-prefixed");
    // This one IS a real plugin and should load.
    const good = path.join(dir, "real_rule_47.ts");
    await writeFile(good, validPluginSource("test_rule_47_real"));

    const result = await loadCustomRules(dir);

    expect(result.loaded.length).toBe(1);
    expect(result.loaded[0]).toBe(good);
  });
});

// ---------------------------------------------------------------------------
// Regression guard — generated plugin source must carry NO bare specifiers
// ---------------------------------------------------------------------------

describe("validPluginSource — generated import specifiers", () => {
  test("every emitted specifier is an absolute file:// URL", () => {
    const src = validPluginSource("guard_rule");
    const specifiers = [...src.matchAll(/\bfrom "([^"]*)";/g)].map(
      (m) => m[1] ?? "",
    );

    // Non-vacuity: the template emits exactly two imports (zod + plugin.ts).
    // Without this, a regex that matched nothing would pass the check below.
    // Note this count is 2 both BEFORE and AFTER the fix, so it is NOT the
    // detector — the `bare` assertion below is.
    expect(specifiers.length).toBe(2);

    // A bare specifier resolves relative to the tmpdir the plugin is written
    // into, where no node_modules exists — which is how a bare
    // `import { z } from "zod"` broke six of these tests on Linux CI.
    const bare = specifiers.filter((s) => !s.startsWith("file://"));
    expect(bare).toEqual([]);
  });
});
