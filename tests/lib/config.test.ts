/**
 * Tests for src/lib/config.ts
 *
 * Coverage map (from spec):
 *   - Valid config: parses + validates + accessible via get()
 *   - Invalid config: falls back to LKG (initial valid → write invalid → get() still returns initial)
 *   - Hot-reload: write file → wait 250ms (covers 200ms debounce + buffer) → get() returns new content
 *   - Per-stream snapshot test (X1/O4 + D23): snapshot a stream → reload config →
 *     snapshotted stream still sees old config; new stream sees new config
 *   - Map-not-WeakMap regression test: snapshot+overwrite then release behavior
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// M10 D-LOCK-6: side-effect imports register the M7b stream-event
// translators + the body rules referenced by the M10 test configs below.
// The barrel auto-imports all rules in production; here we explicitly
// import to keep the test file self-documenting and resilient to
// test-ordering registry resets.
import "../../src/lib/transform/translate_anthropic_event_to_responses_event.ts";
import "../../src/lib/transform/translate_responses_event_to_anthropic_event.ts";
import "../../src/lib/transform/redirect_to_responses.ts";
import "../../src/lib/transform/redirect_to_anthropic_messages.ts";
import "../../src/lib/transform/response_passthrough_anthropic_v1_messages.ts";
import "../../src/lib/transform/response_passthrough_openai_responses.ts";

import {
  ConfigManager,
  ValidationHardFailError,
  validateStreamEventRules,
} from "../../src/lib/config.ts";
import {
  _cacheSize,
  _hasGlob,
  evaluate,
  reset as resetPredicate,
} from "../../src/lib/transform/predicate.ts";
import {
  list as registryList,
  reset as resetRegistry,
  snapshot as registrySnapshot,
  register as registryRegister,
  registerStreamEvent,
} from "../../src/lib/transform/registry.ts";
import {
  ConfigSchema as ConfigSchemaForM10,
  StreamEventRuleSchema,
  RuleSchema as BodyRuleSchemaForM10,
} from "../../src/types/config-schema.ts";

let tempDirs: Array<string> = [];

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "copilot-proxy-config-"));
  tempDirs.push(d);
  return d;
}

async function writeYaml(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf-8");
}

const VALID_YAML_A = `logging:\n  level: on\n  trace_dir: ./traces-a\nserver:\n  port: 4143\n  host: 0.0.0.0\n`;
const VALID_YAML_B = `logging:\n  level: raw\n  trace_dir: ./traces-b\nserver:\n  port: 4144\n  host: 127.0.0.1\n`;
const INVALID_YAML = `logging:\n  level: not_a_real_level\nserver:\n  port: 99999999\n`; // both fields invalid

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ConfigManager — basic load + validate", () => {
  it("parses + validates a valid YAML file and exposes via get()", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await cm.start();
    const c = cm.get();
    expect(c.logging.level).toBe("on");
    expect(c.logging.trace_dir).toBe("./traces-a");
    expect(c.server.port).toBe(4143);
    expect(c.server.host).toBe("0.0.0.0");
    await cm.dispose();
  });

  it("throws on initial-load if config is invalid (no LKG yet at boot)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await expect(cm.start()).rejects.toBeDefined();
  });

  it("get() throws if called before start()", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: false });
    expect(() => cm.get()).toThrow();
  });
});

describe("ConfigManager — LKG fallback on invalid mid-run reload", () => {
  it("retains the last-known-good config when a reload validation fails", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: true, debounceMs: 50 });
    await cm.start();
    expect(cm.get().logging.trace_dir).toBe("./traces-a");

    // Write an invalid update; LKG should hold.
    await writeYaml(fpath, INVALID_YAML);
    await sleep(200);
    expect(cm.get().logging.trace_dir).toBe("./traces-a");
    expect(cm.get().logging.level).toBe("on");
    await cm.dispose();
  });
});

describe("ConfigManager — hot reload picks up new content", () => {
  it("emits the new content within debounce + buffer when YAML is rewritten", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: true, debounceMs: 100 });
    await cm.start();

    let reloadFired = 0;
    cm.on("reload", () => {
      reloadFired++;
    });

    // Trigger reload — wait long enough for fs.watch + debounce + parse.
    await writeYaml(fpath, VALID_YAML_B);
    await sleep(400);
    expect(cm.get().logging.trace_dir).toBe("./traces-b");
    expect(cm.get().server.port).toBe(4144);
    expect(reloadFired).toBeGreaterThanOrEqual(1);
    await cm.dispose();
  });
});

describe("ConfigManager — per-stream snapshot semantics (D23 / O4)", () => {
  it("snapshotted stream sees the config it captured even after reload; new snapshots see the new config", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: true, debounceMs: 50 });
    await cm.start();

    const snapStream1 = cm.snapshot("stream-1");
    expect(snapStream1.config.logging.trace_dir).toBe("./traces-a");

    // Reload to YAML_B
    await writeYaml(fpath, VALID_YAML_B);
    await sleep(300);
    expect(cm.get().logging.trace_dir).toBe("./traces-b");

    // Existing snapshot is unchanged.
    expect(snapStream1.config.logging.trace_dir).toBe("./traces-a");
    expect(cm.getSnapshot("stream-1")?.config.logging.trace_dir).toBe(
      "./traces-a",
    );

    // New snapshot picks up new config.
    const snapStream2 = cm.snapshot("stream-2");
    expect(snapStream2.config.logging.trace_dir).toBe("./traces-b");

    await cm.dispose();
  });

  it("Map-not-WeakMap regression: snapshot('abc') then snapshot('abc') overwrites; release('abc') clears", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await cm.start();

    // First snapshot.
    const first = cm.snapshot("abc");
    expect(first.config.logging.trace_dir).toBe("./traces-a");

    // Reload manually via dispose+rebuild would be heavy; simulate by mutating
    // the source file then forcing get() to a new value via a fresh manager
    // would also be heavy. Instead, test the simpler invariant: a second
    // snapshot returns a NEW snapshot object (overwrite semantics).
    const second = cm.snapshot("abc");
    expect(second).not.toBe(first);
    expect(cm.getSnapshot("abc")).toBe(second);

    // Release.
    cm.release("abc");
    expect(cm.getSnapshot("abc")).toBeUndefined();

    // Release is idempotent.
    cm.release("abc");
    expect(cm.getSnapshot("abc")).toBeUndefined();

    await cm.dispose();
  });
});

describe("ConfigManager — F6 (M3) — predicate cache reset on successful reload", () => {
  it("calls predicate.reset() (cache empties) after a successful reload", async () => {
    resetPredicate(); // clean slate
    // Seed the predicate cache with a glob.
    evaluate(
      { model_glob: "test-glob-for-cache-*" },
      {
        body: null,
        headers: {},
        route: "/x",
        model: "test-glob-for-cache-yes",
      },
    );
    expect(_hasGlob("test-glob-for-cache-*")).toBe(true);
    expect(_cacheSize()).toBeGreaterThanOrEqual(1);

    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    const cm = new ConfigManager({ path: fpath, watch: true, debounceMs: 50 });
    await cm.start();

    // Trigger a successful reload — must clear the predicate cache as
    // a side-effect (per F6 wiring in M3).
    await writeYaml(fpath, VALID_YAML_B);
    await sleep(400);

    expect(cm.get().logging.trace_dir).toBe("./traces-b");
    expect(_hasGlob("test-glob-for-cache-*")).toBe(false);
    expect(_cacheSize()).toBe(0);

    await cm.dispose();
  });
});

describe("ConfigManager — polling fallback (M1b tier 2)", () => {
  it("polling-fallback fires reload when mtime changes after pollIntervalMs", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_A);
    // Force the polling tier (skip chokidar) and use a short interval.
    const cm = new ConfigManager({
      path: fpath,
      watch: true,
      debounceMs: 50,
      pollIntervalMs: 200,
      forcePolling: true,
    });
    await cm.start();
    expect(cm.get().logging.trace_dir).toBe("./traces-a");

    let reloadFired = 0;
    cm.on("reload", () => {
      reloadFired++;
    });

    // Wait briefly so polling baseline mtime is captured.
    await sleep(100);
    // Bump mtime by an explicit margin to defeat coarse-grained FS clocks.
    await sleep(50);
    await writeYaml(fpath, VALID_YAML_B);

    // Wait pollIntervalMs (200) + debounceMs (50) + comfortable buffer.
    await sleep(600);

    expect(cm.get().logging.trace_dir).toBe("./traces-b");
    expect(cm.get().server.port).toBe(4144);
    expect(reloadFired).toBeGreaterThanOrEqual(1);
    await cm.dispose();
  });
});

// ============================================================================
// M9 D-LOCK-13/14 — ValidationHardFailError + validateResponseShape wiring
// ============================================================================
//
// Coverage maps to M9 mini-audit items 57-60:
//   - ValidationHardFailError class is exported.
//   - Valid config with all consumer pairings → no throw at boot.
//   - Invalid config (missing consumer for a redirect shape) → throws
//     ValidationHardFailError with descriptive message naming the route +
//     rule + unmet shape.
//   - Multi-failure config aggregates ALL issues into one error message.
//
// We use ConfigManager.start() (which calls loadAndValidate internally) so
// the test exercises the exact code path main.ts loadConfig() hits.

// Valid config with the gpt-5.x lane wired correctly: redirect_to_responses
// on body side + response_passthrough_openai_responses on response side.
const VALID_YAML_M9_PAIRED = `
routes:
  - match:
      method: POST
      path: /chat/completions
      model_pattern: "^gpt-5\\\\."
    body_rules:
      - name: gpt5_to_responses
        use: redirect_to_responses
    header_rules: []
    response_rules:
      - name: consume_openai_responses
        use: response_passthrough_openai_responses
    upstream:
      via: copilot_enterprise
      via_endpoint: openai_responses
      shape: openai_responses
`;

// Invalid config: gpt-5.x lane has redirect_to_responses on body side but
// NO matching response_passthrough_openai_responses on response side.
// validateResponseShape MUST report 1 failure → ValidationHardFailError.
const INVALID_YAML_M9_MISSING_CONSUMER = `
routes:
  - match:
      method: POST
      path: /chat/completions
      model_pattern: "^gpt-5\\\\."
    body_rules:
      - name: gpt5_to_responses
        use: redirect_to_responses
    header_rules: []
    response_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: openai_responses
      shape: openai_responses
`;

// Invalid config: 3 routes each missing their consumer → 3 failures.
const INVALID_YAML_M9_MULTI_MISSING = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-"
    body_rules:
      - name: claude_to_anthropic
        use: redirect_to_anthropic_messages
    header_rules: []
    response_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: anthropic_messages
      shape: anthropic_messages
  - match:
      method: POST
      path: /chat/completions
      model_pattern: "^gpt-4"
    body_rules:
      - name: gpt4_to_chat
        use: redirect_to_chat_completions
    header_rules: []
    response_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: openai_chat_completions
      shape: openai_chat
  - match:
      method: POST
      path: /chat/completions
      model_pattern: "^gpt-5\\\\."
    body_rules:
      - name: gpt5_to_responses
        use: redirect_to_responses
    header_rules: []
    response_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: openai_responses
      shape: openai_responses
`;

// Valid config: passthrough lane (no redirect rule, no consumer needed).
const VALID_YAML_M9_PASSTHROUGH = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-"
    body_rules: []
    header_rules: []
    response_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: anthropic_messages
      shape: anthropic_messages
`;

describe("ConfigManager — M9 D-LOCK-14 ValidationHardFailError wiring", () => {
  it("exports ValidationHardFailError class with name='ValidationHardFailError'", () => {
    const err = new ValidationHardFailError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationHardFailError");
    expect(err.message).toBe("test");
  });

  it("valid config with redirect+consumer pairing → no throw (mini-audit 59)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_M9_PAIRED);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await expect(cm.start()).resolves.toBeUndefined();
    const cfg = cm.get();
    expect(cfg.routes).toHaveLength(1);
    expect(cfg.routes[0]?.response_rules).toHaveLength(1);
    const responseRule = cfg.routes[0]?.response_rules[0] as
      | { use: string }
      | undefined;
    expect(responseRule?.use).toBe("response_passthrough_openai_responses");
    await cm.dispose();
  });

  it("passthrough lane (no redirect rules) → no throw (mini-audit 59)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_M9_PASSTHROUGH);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await expect(cm.start()).resolves.toBeUndefined();
    await cm.dispose();
  });

  it("invalid config (missing consumer for redirect shape) → throws ValidationHardFailError (mini-audit 60)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M9_MISSING_CONSUMER);
    const cm = new ConfigManager({ path: fpath, watch: false });
    let caught: unknown;
    try {
      await cm.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationHardFailError);
    expect((caught as Error).message).toContain("openai_responses");
    expect((caught as Error).message).toContain("gpt5_to_responses");
    expect((caught as Error).message).toContain("/chat/completions");
  });

  it("invalid config with multiple missing consumers → throws ValidationHardFailError aggregating ALL failures", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M9_MULTI_MISSING);
    const cm = new ConfigManager({ path: fpath, watch: false });
    let caught: unknown;
    try {
      await cm.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationHardFailError);
    const msg = (caught as Error).message;
    // All 3 unmet shapes appear in the aggregated message.
    expect(msg).toContain("anthropic_v1_messages");
    expect(msg).toContain("openai_chat_completions");
    expect(msg).toContain("openai_responses");
    // Header summary mentions 3 issues.
    expect(msg).toMatch(/3 issues/);
  });

  it("ValidationHardFailError is distinguishable from generic Error (per D-LOCK-14 main.ts catch-block selectivity)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M9_MISSING_CONSUMER);
    const cm = new ConfigManager({ path: fpath, watch: false });
    try {
      await cm.start();
      throw new Error("expected throw");
    } catch (err) {
      // The catch block in main.ts should distinguish via instanceof.
      expect(err instanceof ValidationHardFailError).toBe(true);
      // Sanity: it's also an Error subclass.
      expect(err instanceof Error).toBe(true);
    }
  });
});

// ============================================================================
// M10 D-LOCK-6 / C2 fix — stream_event_rules cross-registry validation
// ============================================================================
//
// Coverage maps to M10 spec § D-LOCK-6 § Files to modify (Group A scope) item 5
// Test cases:
//   1. Valid stream rule (translate_responses_event_to_anthropic_event) passes
//      zod + validateStreamEventRules.
//   2. Body rule name in stream_event_rules → zod rejects with cross-registry
//      suggestion ("'redirect_to_responses' IS registered as a body rule —
//      did you mean ...").
//   3. Stream rule name in body_rules → existing RuleSchema rejects (the
//      symmetric case; assert with the body registry's own suggestion).
//   4. Unknown name in stream_event_rules → zod rejects with stream-event
//      registry's suggestion list.
//   5. Empty registry in production mode → both schemas hard-fail (mirrors
//      M5 F3 guard).

// Valid CC → GPT-5.x lane wired with stream_event_rules (per default.yaml
// LANE 4 wiring per M10 D-LOCK-7).
const VALID_YAML_M10_STREAM_TRANSLATE = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^gpt-5\\\\."
    body_rules:
      - name: gpt5_redirect
        use: redirect_to_responses
    header_rules: []
    response_rules:
      - name: consume_openai_responses
        use: response_passthrough_openai_responses
    stream_event_rules:
      - name: gpt5_stream_translate
        use: translate_responses_event_to_anthropic_event
    upstream:
      via: copilot_enterprise
      via_endpoint: openai_responses
      shape: openai_responses
`;

// Invalid: body-rule name in stream_event_rules → zod rejects with
// cross-registry suggestion.
const INVALID_YAML_M10_BODY_RULE_IN_STREAM = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-"
    body_rules: []
    header_rules: []
    response_rules:
      - name: consume_anthropic
        use: response_passthrough_anthropic_v1_messages
    stream_event_rules:
      - name: misplaced
        use: redirect_to_responses
    upstream:
      via: copilot_enterprise
      via_endpoint: anthropic_messages
      shape: anthropic_messages
`;

// Invalid: stream-rule name in body_rules → existing RuleSchema rejects.
const INVALID_YAML_M10_STREAM_RULE_IN_BODY = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-"
    body_rules:
      - name: misplaced_stream
        use: translate_responses_event_to_anthropic_event
    header_rules: []
    response_rules:
      - name: consume_anthropic
        use: response_passthrough_anthropic_v1_messages
    stream_event_rules: []
    upstream:
      via: copilot_enterprise
      via_endpoint: anthropic_messages
      shape: anthropic_messages
`;

// Invalid: unknown name in stream_event_rules → zod rejects with stream
// registry suggestion list.
const INVALID_YAML_M10_UNKNOWN_STREAM_NAME = `
routes:
  - match:
      method: POST
      path: /v1/messages
      model_pattern: "^claude-"
    body_rules: []
    header_rules: []
    response_rules:
      - name: consume_anthropic
        use: response_passthrough_anthropic_v1_messages
    stream_event_rules:
      - name: gibberish
        use: completely_made_up_rule_name
    upstream:
      via: copilot_enterprise
      via_endpoint: anthropic_messages
      shape: anthropic_messages
`;

describe("ConfigManager — M10 D-LOCK-6 stream_event_rules cross-registry validation", () => {
  // Defensive re-registration. Other test files reset the registry in their
  // afterEach hooks; ESM-import side-effect cannot re-fire on subsequent
  // imports (module cache). Explicit register() with allow_override:true
  // handles both cold-start (registry empty) and warm-start (already
  // registered by side-effect import). Pattern matches
  // tests/integration/redirect_to_responses_dispatch.test.ts:64-142.
  beforeEach(async () => {
    const m1 =
      await import("../../src/lib/transform/translate_anthropic_event_to_responses_event.ts");
    registerStreamEvent(
      "translate_anthropic_event_to_responses_event",
      m1.translate_anthropic_event_to_responses_event,
      m1.TranslateAnthropicEventToResponsesEventSchema,
      { allow_override: true },
    );
    const m2 =
      await import("../../src/lib/transform/translate_responses_event_to_anthropic_event.ts");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      m2.translate_responses_event_to_anthropic_event,
      m2.TranslateResponsesEventToAnthropicEventSchema,
      { allow_override: true },
    );
    const m3 = await import("../../src/lib/transform/redirect_to_responses.ts");
    registryRegister(
      "redirect_to_responses",
      m3.redirect_to_responses,
      m3.RedirectToResponsesSchema,
      {
        response_shape: "openai_responses",
        ctx_reads: ["body"],
        ctx_writes: ["body", "headers"],
        allow_override: true,
      },
    );
    const m4 =
      await import("../../src/lib/transform/redirect_to_anthropic_messages.ts");
    registryRegister(
      "redirect_to_anthropic_messages",
      m4.redirect_to_anthropic_messages,
      m4.RedirectToAnthropicMessagesSchema,
      {
        response_shape: "anthropic_v1_messages",
        ctx_reads: ["body"],
        ctx_writes: ["body", "headers"],
        allow_override: true,
      },
    );
    const m5 =
      await import("../../src/lib/transform/response_passthrough_anthropic_v1_messages.ts");
    registryRegister(
      "response_passthrough_anthropic_v1_messages",
      m5.response_passthrough_anthropic_v1_messages,
      m5.ResponsePassthroughAnthropicV1MessagesSchema,
      {
        response_shape: "anthropic_v1_messages",
        ctx_reads: [],
        ctx_writes: [],
        allow_override: true,
      },
    );
    const m6 =
      await import("../../src/lib/transform/response_passthrough_openai_responses.ts");
    registryRegister(
      "response_passthrough_openai_responses",
      m6.response_passthrough_openai_responses,
      m6.ResponsePassthroughOpenaiResponsesSchema,
      {
        response_shape: "openai_responses",
        ctx_reads: [],
        ctx_writes: [],
        allow_override: true,
      },
    );
  });

  it("(M10/1) valid stream rule passes zod + validateStreamEventRules (no throw)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, VALID_YAML_M10_STREAM_TRANSLATE);
    const cm = new ConfigManager({ path: fpath, watch: false });
    await expect(cm.start()).resolves.toBeUndefined();
    const cfg = cm.get();
    expect(cfg.routes[0]?.stream_event_rules).toHaveLength(1);
    const streamRule = cfg.routes[0]?.stream_event_rules[0] as
      | { use: string }
      | undefined;
    expect(streamRule?.use).toBe(
      "translate_responses_event_to_anthropic_event",
    );
    await cm.dispose();
  });

  it("(M10/2) body-rule name in stream_event_rules → zod rejects with cross-registry suggestion", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M10_BODY_RULE_IN_STREAM);
    const cm = new ConfigManager({ path: fpath, watch: false });
    let caught: unknown;
    try {
      await cm.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toContain("redirect_to_responses");
    expect(msg).toMatch(/IS registered as a body rule/);
    expect(msg).toMatch(/body_rules or header_rules/);
  });

  it("(M10/3) stream-rule name in body_rules → existing RuleSchema rejects (symmetric case)", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M10_STREAM_RULE_IN_BODY);
    const cm = new ConfigManager({ path: fpath, watch: false });
    let caught: unknown;
    try {
      await cm.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    // The body-engine RuleSchema rejects with "Unknown rule" (it does not
    // know about the stream registry). Suggestion list MUST mention the
    // unknown name itself in the diagnostic.
    expect(msg).toMatch(/Unknown rule/);
    expect(msg).toContain("translate_responses_event_to_anthropic_event");
  });

  it("(M10/4) unknown name in stream_event_rules → zod rejects with stream-event registry suggestion list", async () => {
    const dir = await makeTempDir();
    const fpath = path.join(dir, "config.yaml");
    await writeYaml(fpath, INVALID_YAML_M10_UNKNOWN_STREAM_NAME);
    const cm = new ConfigManager({ path: fpath, watch: false });
    let caught: unknown;
    try {
      await cm.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toMatch(/Unknown stream-event rule/);
    expect(msg).toContain("completely_made_up_rule_name");
    // Either a "Did you mean" or a "Registered stream-event rules" line
    // appears (depends on whether any registered names are within
    // Levenshtein distance 3 of `completely_made_up_rule_name`).
    expect(msg).toMatch(/Registered stream-event rules:|Did you mean:/);
  });

  it("(M10/5) empty stream-event registry in production mode → schema hard-fails", () => {
    // Save the current registry contents so we can restore after the test.
    const streamSnap = registrySnapshot("stream_event");
    const bodySnap = registrySnapshot("body");

    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      // Wipe BOTH registries for this test (resetRegistry clears both).
      resetRegistry();

      // Stream-event schema: any rule input now fails because the
      // registry is empty + production-mode is enabled.
      const streamResult = StreamEventRuleSchema.safeParse({
        name: "x",
        use: "anything",
      });
      expect(streamResult.success).toBe(false);
      const streamMsg = streamResult.success
        ? ""
        : (streamResult.error.issues[0]?.message ?? "");
      expect(streamMsg).toContain("stream_event registry is empty");

      // Body schema: same parity check (mirrors M5 F3).
      const bodyResult = BodyRuleSchemaForM10.safeParse({
        name: "x",
        use: "anything",
      });
      expect(bodyResult.success).toBe(false);
      const bodyMsg = bodyResult.success
        ? ""
        : (bodyResult.error.issues[0]?.message ?? "");
      expect(bodyMsg).toContain("body registry is empty");
    } finally {
      // Restore env + restore registries by re-registering each entry.
      if (originalEnv === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = originalEnv;
      }
      // Restore body registry.
      for (const [name, reg] of bodySnap.entries()) {
        registryRegister(name, reg.fn, reg.schema, {
          ...reg.opts,
          allow_override: true,
        });
      }
      // Restore stream-event registry.
      for (const [name, reg] of streamSnap.entries()) {
        registerStreamEvent(name, reg.fn, reg.schema, {
          ...reg.opts,
          allow_override: true,
        });
      }
    }
  });

  // Bonus coverage: validateStreamEventRules direct unit test (mirrors
  // validateResponseShape direct test pattern).
  it("(M10/extra) validateStreamEventRules direct: valid rule returns []; body-name returns NOTE; unknown returns list", () => {
    const streamSnap = registrySnapshot("stream_event");
    const bodySnap = registrySnapshot("body");
    // Valid: a registered stream-event rule returns no failures.
    const valid = validateStreamEventRules(
      [
        {
          name: "stream",
          use: "translate_responses_event_to_anthropic_event",
        },
      ],
      streamSnap,
      bodySnap,
    );
    expect(valid).toEqual([]);

    // Body-name in stream rules: cross-registry NOTE message returned.
    const crossReg = validateStreamEventRules(
      [{ name: "misplaced", use: "redirect_to_responses" }],
      streamSnap,
      bodySnap,
    );
    expect(crossReg.length).toBe(1);
    expect(crossReg[0]).toMatch(/IS registered as a body rule/);

    // Unknown rule: registered-list-mention.
    const unknown = validateStreamEventRules(
      [{ name: "unknown", use: "totally_unknown_rule" }],
      streamSnap,
      bodySnap,
    );
    expect(unknown.length).toBe(1);
    expect(unknown[0]).toMatch(/unknown stream-event rule/);
  });

  // Side-effect-free: silence unused-import lint hint for the dynamic
  // ConfigSchema reference (we use it implicitly via ConfigManager).
  it("(M10/sanity) ConfigSchema + stream-event registry are reachable", () => {
    expect(typeof ConfigSchemaForM10.parse).toBe("function");
    expect(registryList("stream_event").length).toBeGreaterThan(0);
  });
});
