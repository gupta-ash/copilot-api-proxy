/**
 * trace_wiring.test.ts — Phase 5 v3.1 Group B integration coverage for the
 * non-streaming `withTrace` middleware AND the bootstrap path in main.ts.
 *
 * Eleven tests:
 *   1. **success path (non-streaming):** Lane-1-style POST /v1/messages with
 *      a non-streaming JSON upstream response → flow file `0001_POST_*.json`
 *      lands under the temp `traces-YYYY-MM-DD/flows/` dir; both
 *      `request.body_kind` and `response.body_kind` resolve to `"json"`;
 *      the bodies round-trip the client / upstream payloads byte-equal.
 *   2. **(F-DISC-6) Bun.clone safety:** the response body the test sees is
 *      byte-equal to what the upstream emitted even after `withTrace` calls
 *      `response.clone().arrayBuffer()` to summarize. Regression gate for
 *      the Bun-on-Node-v24 clone-safety hypothesis.
 *   3. **(F-DISC-13) counter persistence on restart:** pre-write `0001_*` +
 *      `0003_*` flow files into today's bucket; boot a fresh TraceWriter +
 *      withTrace; send 1 request; assert the new file is `0004_*` (NOT
 *      `0002_*` overwriting). Data-loss regression gate.
 *   4. **(F-DISC-15) unwritable trace_dir at startup (main.ts):** spawn the
 *      proxy with `trace_dir` beneath a regular FILE, so `mkdir` fails
 *      ENOTDIR. Assert the proxy STARTUP succeeds (does not crash); assert
 *      stdout/stderr contains "trace writing DISABLED"; assert subsequent
 *      /health succeeds (proxy works without trace). NOTE: ENOTDIR is the
 *      only error induced — EACCES is never exercised, despite F-DISC-15's
 *      name, so this test can stay green with EACCES handling broken.
 *   5. **(F-DISC-3) write-failure visibility:** stub the writer to reject
 *      EACCES on every write; send 1 request; the request still succeeds;
 *      `consola.warn` reports the first failure; the
 *      `copilot_proxy_trace_errors_total{kind="eacces"}` counter ticks.
 *   6. **(F-DISC-9) PII warning at level: raw:** spawn the proxy with
 *      `level: raw`; assert stdout/stderr contains "WARNING: raw mode
 *      captures full request/response bodies".
 *   7. **(F-DISC-11) restart-required banner:** spawn with any level; assert
 *      stdout/stderr contains "config: loaded from ... (changes require
 *      restart)".
 *   8. **default-level=on regression:** with `level: on` (the schema
 *      default), no withTrace middleware is composed; sending a request
 *      writes NO trace files and the trace counters stay at 0.
 *   9. **(F-DISC-12) meta.json sidecar:** spawned proxy writes
 *      `${PATHS.APP_DIR}/logs/copilot-proxy.meta.json`; the file parses;
 *      `config_path` matches the resolved YAML path; `trace_dir` is the
 *      resolved tracedir (when level >= raw) OR `null` (when level < raw).
 *  10. **header redaction:** Authorization header in the request is
 *      `<redacted, len=N>`-style in the persisted flow file (NOT the literal
 *      Bearer token). Regression gate for `redactHeaders` integration.
 *  11. **streaming skip:** a request that triggers a streaming SSE response
 *      DOES NOT cause `withTrace` to write a second flow file. The
 *      streaming forwarder owns the write per Group C; this test proves
 *      the middleware does not double-write.
 *
 * **Mechanism.** Tests 1-3, 5, 8, 10, 11 build a Hono app via `buildApp(...)`
 * and exercise it via `app.request(...)` with `globalThis.fetch` mocked —
 * fast in-process. Tests 4, 6, 7, 9 spawn `bun run src/main.ts` as a child
 * process with `COPILOT_PROXY_CONFIG` pointing at a temp YAML so the real
 * bootstrap path runs. Those four are skipped on Windows (`describe.skipIf`)
 * and depend on `CONSOLA_LEVEL=3` reaching the child — see the note on that
 * key in `spawnProxy`'s env block.
 */

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { LEVEL_ON, LEVEL_RAW, debug } from "../../src/lib/debug.ts";
import {
  getValueForTests,
  resetForTests as resetMetricsForTests,
} from "../../src/lib/metrics.ts";
import { TraceWriter } from "../../src/lib/trace.ts";
import { buildApp } from "../../src/server.ts";
import { _resetFirstFailureForTests } from "../../src/routes/_shared/with-trace.ts";
import { _resetFirstFailureForTests as _resetStreamFirstFailureForTests } from "../../src/routes/_shared/forward-stream.ts";
import { ConfigSchema, type Config } from "../../src/types/config-schema.ts";

// Side-effect imports: ensure the lane-1 / lane-3 rules are registered so
// the in-process tests can wire a route without registry-empty errors.
import "../../src/lib/transform/index.ts";

// ---------------------------------------------------------------------------
// consola.warn capture (so write-failure tests can assert).
// ---------------------------------------------------------------------------

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
  resetMetricsForTests();
  _resetFirstFailureForTests();
  _resetStreamFirstFailureForTests();
  // Dynamic logging toggle: with-trace.ts now arms trace capture only at
  // level >= raw. The in-process app-path tests (1-3, 5, 10, 11) exercise the
  // trace write, so raise the level to raw for the duration of each test.
  // (Test 8 passes no writer, so withTrace is never composed — the level is
  // irrelevant there; the spawn tests run their own child process.)
  debug.setLevel(LEVEL_RAW);
});
afterEach(() => {
  consola.warn = originalWarnFn;
  resetMetricsForTests();
  debug.setLevel(LEVEL_ON);
});

// ---------------------------------------------------------------------------
// Test helpers — TokenManager + fetch mocking.
// ---------------------------------------------------------------------------

async function makeReadyTokenManager(): Promise<{
  tm: TokenManager;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-proxy-tw-"));
  const ghpath = path.join(dir, "github_token");
  await writeFile(ghpath, "ghp_test");
  const tm = new TokenManager({
    githubTokenPath: ghpath,
    accountType: "enterprise",
    vsCodeVersion: "1.95.0",
    fetchCopilotToken: async () => ({
      token: "stub-copilot-token",
      refresh_in: 3540,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await tm.start();
  return {
    tm,
    cleanup: async () => {
      tm.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installStubFetch(responder: (call: FetchCall) => Response): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const call: FetchCall = { url: input.toString(), init };
    calls.push(call);
    return responder(call);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

/**
 * Build a minimal lane-1 Config (POST /v1/messages × ^claude-) with no body
 * rules + no response rules. The trace tests never exercise the rule engine —
 * we just need the route to dispatch.
 */
function configLane1Native(): Config {
  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: "POST",
          path: "/v1/messages",
          model_pattern: "^claude-",
        },
        body_rules: [],
        header_rules: [],
        response_rules: [],
        upstream: {
          via: "copilot_enterprise",
          via_endpoint: "anthropic_messages",
          shape: "anthropic_messages",
        },
      },
    ],
  });
}

/** Locate the only manifest .json file under tempDir/traces-YYYY-MM-DD/flows/. */
async function findOnlyFlowFile(tempDir: string): Promise<string> {
  const entries = await readdir(tempDir);
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) {
    throw new Error(`no traces-YYYY-MM-DD subdir under ${tempDir}`);
  }
  const flowsDir = path.join(tempDir, traceDir, "flows");
  const flowFiles = (await readdir(flowsDir)).filter((n) =>
    n.endsWith(".json"),
  );
  if (flowFiles.length !== 1) {
    throw new Error(
      `expected 1 manifest file, found ${flowFiles.length}: ${flowFiles.join(", ")}`,
    );
  }
  return path.join(flowsDir, flowFiles[0]!);
}

/** List all manifest .json files under tempDir/traces-YYYY-MM-DD/flows/ (sorted). */
async function listFlowFiles(tempDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return [];
  }
  const traceDir = entries.find((n) => n.startsWith("traces-"));
  if (traceDir === undefined) return [];
  const flowsDir = path.join(tempDir, traceDir, "flows");
  let flowFiles: string[];
  try {
    flowFiles = await readdir(flowsDir);
  } catch {
    return [];
  }
  flowFiles = flowFiles.filter((n) => n.endsWith(".json"));
  flowFiles.sort();
  return flowFiles.map((f) => path.join(flowsDir, f));
}

/**
 * Wait for the trace writer's fire-and-forget promise to settle. The
 * middleware kicks off `writer.write(flow).then(...).catch(...)` and returns
 * synchronously; tests must yield several event-loop turns so the writer's
 * mkdir + writeFile + chained .then/.catch all run before assertions.
 */
async function waitForTraceFlush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** Today's UTC date in ISO `YYYY-MM-DD` form (matches TraceWriter's bucket). */
function isoDateUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ---------------------------------------------------------------------------
// In-process tests (use buildApp + app.request + stub fetch).
// ---------------------------------------------------------------------------

describe("withTrace — Phase 5 v3.1 Group B non-streaming wiring (in-process)", () => {
  it("test 1: success path → flow file written; request + response bodies round-trip byte-equal", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-1-"));
    const upstreamPayload = { id: "upstream-001", choices: ["abc"] };
    const stub = installStubFetch(
      () =>
        new Response(JSON.stringify(upstreamPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const cfg = configLane1Native();
      const app = buildApp(cfg, tm, writer);

      const inboundBody = {
        model: "claude-3-opus",
        messages: [{ role: "user", content: "hi" }],
      };
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inboundBody),
      });
      expect(r.status).toBe(200);
      const responseBody = await r.json();
      // Response body byte-for-byte equal to upstream stub.
      expect(responseBody).toEqual(upstreamPayload);
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      const flow = JSON.parse(txt) as {
        request: {
          method: string;
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
          body_truncated: boolean;
          headers: Record<string, string>;
        };
        response: {
          status: number;
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
          body_truncated: boolean;
        };
        n: number;
      };
      expect(flow.n).toBe(1);
      expect(flow.request.method).toBe("POST");
      expect(flow.request.body_kind).toBe("json");
      expect(flow.response.status).toBe(200);
      expect(flow.response.body_kind).toBe("json");
      // Phase 6 anti-pattern guard (F36/F49/F51): walk the .req + .res
      // sidecar files; deep-equal byte content vs sent / upstream-stub bytes.
      expect(flow.request.body_path).toMatch(/\.req$/);
      expect(flow.response.body_path).toMatch(/\.res$/);
      const flowsDir = path.dirname(flowPath);
      const reqOnDisk = await readFile(
        path.join(flowsDir, flow.request.body_path!),
      );
      const resOnDisk = await readFile(
        path.join(flowsDir, flow.response.body_path!),
      );
      expect(JSON.parse(reqOnDisk.toString("utf-8"))).toEqual(inboundBody);
      expect(JSON.parse(resOnDisk.toString("utf-8"))).toEqual(upstreamPayload);
      // body_bytes matches the on-disk sidecar size.
      expect(flow.request.body_bytes).toBe(reqOnDisk.byteLength);
      expect(flow.response.body_bytes).toBe(resOnDisk.byteLength);
      expect(flow.request.body_truncated).toBe(false);
      expect(flow.response.body_truncated).toBe(false);
      // Trace counters ticked.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBe(1);
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 2: (F-DISC-6) Bun.clone safety — response body still drained by framework after withTrace clone", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-2-"));
    const upstreamBody = { id: "clone-safety", payload: "x".repeat(2048) };
    const stub = installStubFetch(
      () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      expect(r.status).toBe(200);
      // The KEY assertion: client can still read the body even though
      // withTrace cloned + drained its mirror copy.
      const text = await r.text();
      expect(text.length).toBeGreaterThan(2000);
      expect(JSON.parse(text)).toEqual(upstreamBody);
      await waitForTraceFlush();

      // The clone path also produced the flow file (the bytes were
      // available to BOTH consumers).
      const flowPath = await findOnlyFlowFile(tempDir);
      const flow = JSON.parse(await readFile(flowPath, "utf-8")) as {
        response: { body_path: string | null };
      };
      expect(flow.response.body_path).toMatch(/\.res$/);
      const resOnDisk = await readFile(
        path.join(path.dirname(flowPath), flow.response.body_path!),
      );
      expect(JSON.parse(resOnDisk.toString("utf-8"))).toEqual(upstreamBody);
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 3: (F-DISC-13) counter persistence on restart — pre-existing files cause new file to land at next monotonic counter", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-3-"));
    const stub = installStubFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      // Pre-seed today's bucket with 0001_* and 0003_* flow files. The
      // writer's init() must scan them and seed counter=3 so the next
      // write lands at 0004 — NOT overwriting 0002.
      const today = isoDateUtc();
      const flowsDir = path.join(tempDir, `traces-${today}`, "flows");
      await mkdir(flowsDir, { recursive: true });
      await writeFile(
        path.join(flowsDir, "0001_POST_localhost-x.json"),
        '{"n":1}',
      );
      await writeFile(
        path.join(flowsDir, "0003_POST_localhost-y.json"),
        '{"n":3}',
      );

      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-sonnet",
          messages: [{ role: "user", content: "x" }],
        }),
      });
      expect(r.status).toBe(200);
      await waitForTraceFlush();

      const all = await listFlowFiles(tempDir);
      const names = all.map((p) => path.basename(p)).sort();
      // The seed files survive; the new write lands at 0004_*.
      expect(names).toContain("0001_POST_localhost-x.json");
      expect(names).toContain("0003_POST_localhost-y.json");
      const newOne = names.find((n) => n.startsWith("0004_"));
      expect(newOne).toBeDefined();
      // Critically: 0002_* did NOT appear (no overwrite of the gap).
      const gap = names.find((n) => n.startsWith("0002_"));
      expect(gap).toBeUndefined();
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 5: (F-DISC-3) write-failure visibility — request still succeeds; first failure surfaces via consola.warn; eacces counter ticks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-5-"));
    const stub = installStubFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      // Stub writer.write to reject EACCES so the failure path runs
      // deterministically across platforms.
      const fakeErr = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
      writer.write = (async () => {
        throw fakeErr;
      }) as typeof writer.write;

      const app = buildApp(configLane1Native(), tm, writer);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "x" }],
        }),
      });
      // Request still drained successfully despite trace-write failure.
      expect(r.status).toBe(200);
      await waitForTraceFlush();

      // Error counter ticked (eacces classification).
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "error",
        }),
      ).toBe(1);
      expect(
        getValueForTests("copilot_proxy_trace_errors_total", {
          kind: "eacces",
        }),
      ).toBe(1);
      // First-failure warn surfaced.
      const failureWarns = warnMessages.filter((m) =>
        m.includes("first write failure"),
      );
      expect(failureWarns.length).toBe(1);
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 8: default level=on regression — no traceWriter passed → no flow files written + counters stay at 0", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-8-"));
    const stub = installStubFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      // No traceWriter argument → withTrace is NOT composed → legacy path.
      const app = buildApp(configLane1Native(), tm /* no traceWriter */);
      for (let i = 0; i < 3; i++) {
        const r = await app.request("/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-3-opus",
            messages: [{ role: "user", content: `r${i}` }],
          }),
        });
        expect(r.status).toBe(200);
      }
      await waitForTraceFlush();

      // Temp dir was never touched.
      const entries = await readdir(tempDir).catch(() => []);
      expect(entries.length).toBe(0);
      // Trace counters never incremented.
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "success",
        }),
      ).toBeUndefined();
      expect(
        getValueForTests("copilot_proxy_trace_writes_total", {
          result: "error",
        }),
      ).toBeUndefined();
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 10: header redaction — Authorization Bearer header is `<redacted, len=N>` in the persisted flow", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-10-"));
    const stub = installStubFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);
      const SECRET = "Bearer test-token-do-not-leak-12345";
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: SECRET,
        },
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "x" }],
        }),
      });
      expect(r.status).toBe(200);
      await waitForTraceFlush();

      const flowPath = await findOnlyFlowFile(tempDir);
      const txt = await readFile(flowPath, "utf-8");
      // The literal token MUST NOT appear anywhere in the persisted flow.
      expect(txt).not.toContain("test-token-do-not-leak-12345");
      const flow = JSON.parse(txt) as {
        request: { headers: Record<string, string> };
      };
      const auth =
        flow.request.headers["authorization"] ??
        flow.request.headers["Authorization"] ??
        "";
      // The redactor produces `<redacted, len=N>` style values; we just
      // assert it doesn't carry the cleartext.
      expect(auth).not.toContain("test-token-do-not-leak-12345");
      expect(auth.toLowerCase()).toContain("redact");
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("test 11: streaming skip — SSE response does NOT cause withTrace to write a flow (forwarder owns it)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "trace-wiring-11-"));
    // Stub fetch returns a streaming SSE response.
    const stub = installStubFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          const enc = new TextEncoder();
          controller.enqueue(
            enc.encode(
              'event: message_start\ndata: {"type":"message_start"}\n\n',
            ),
          );
          controller.enqueue(
            enc.encode(
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { tm, cleanup } = await makeReadyTokenManager();
    try {
      const writer = new TraceWriter(tempDir);
      await writer.init();
      const app = buildApp(configLane1Native(), tm, writer);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "x" }],
          stream: true,
        }),
      });
      expect(r.status).toBe(200);
      // Drain the stream so the forwarder's finally fires.
      await r.text();
      await waitForTraceFlush();

      // EXACTLY ONE flow file (the streaming forwarder's). withTrace did
      // NOT double-write. forwardStream tags status=200 success outcome
      // and writes the SSE-summary flow.
      const all = await listFlowFiles(tempDir);
      expect(all.length).toBe(1);
      const flow = JSON.parse(await readFile(all[0]!, "utf-8")) as {
        response: { body_kind: string };
      };
      // Forwarder writes body_kind=sse for streaming responses.
      expect(flow.response.body_kind).toBe("sse");
    } finally {
      await cleanup();
      stub.restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Spawn-based tests for main.ts bootstrap surfaces (PII warning, restart
// banner, EACCES handling, meta.json sidecar). Skipped on CI environments
// where bun is not on PATH.
// ---------------------------------------------------------------------------

interface SpawnedProxy {
  pid: number;
  /** LIVE view of the child's merged stdout+stderr — grows after spawnProxy returns. */
  readonly outBuf: string;
  appDir: string;
  configPath: string;
  port: number;
  kill: () => Promise<void>;
}

/**
 * Spawn `bun run src/main.ts` with COPILOT_PROXY_CONFIG pointing at a
 * temp YAML and HOME redirected to a temp dir so the process writes
 * everything (logs, traces, github_token) under a sandbox we control.
 *
 * Returns when stdout contains "listening" OR the per-test timeout
 * elapses. Caller must invoke `kill()`.
 */
async function spawnProxy(opts: {
  configYaml: string;
  /**
   * Defaults to TRUE, which overrides HOME so `PATHS.APP_DIR` resolves under a
   * temp sandbox. Passing FALSE lets the child inherit the operator's real
   * HOME, where `writeMeta` (`src/main.ts:498`) unconditionally overwrites the
   * LIVE `:4143` gateway's `copilot-proxy.meta.json` — the production outage
   * commit `3aedd95` exists to prevent. No caller passes false; read
   * `tests/helpers/proxy_sandbox.ts`'s header before adding one.
   */
  sandboxHome?: boolean;
}): Promise<SpawnedProxy> {
  const sandboxHome = opts.sandboxHome ?? true;
  const sandbox = await mkdtemp(path.join(tmpdir(), "trace-wiring-spawn-"));
  const configPath = path.join(sandbox, "config.yaml");
  await writeFile(configPath, opts.configYaml, "utf-8");

  // Pre-seed a dummy GitHub token, mirroring `makeProxySandbox`
  // (`tests/helpers/proxy_sandbox.ts`). Without one the child logs "No GitHub
  // token on disk; starting device-code flow." and begins UNBOUNDED polling of
  // GitHub — outbound traffic from four spawned children on every CI run, and
  // a flake source.
  //
  // What this buys, stated exactly: it BOUNDS that traffic, it does not remove
  // it. A present-but-invalid token skips the device flow but still reaches
  // `TokenManager.start()` → `refresh()` → `getCopilotToken`, which retries 3×
  // (`token-manager.ts`, default per O11) and then goes terminal `failed`. So:
  // 3 bounded requests instead of unbounded polling. These tests are NOT
  // network-isolated, and any claim that they are is false.
  //
  // Written unconditionally. When `sandboxHome` is false the CHILD ignores it —
  // it reads the operator's real APP_DIR — but the directory and file are still
  // created here and `sp.appDir` still points at them, so "inert" would
  // overstate it.
  const appDir = path.join(sandbox, ".local", "share", "copilot-proxy");
  await mkdir(appDir, { recursive: true });
  await writeFile(
    path.join(appDir, "github_token"),
    "ghu_sandbox_dummy_not_a_real_token",
    { mode: 0o600 },
  );

  const env: Record<string, string> = {
    ...process.env,
    COPILOT_PROXY_CONFIG: configPath,
    COPILOT_PROXY_PORT: "0",
    COPILOT_PROXY_HOST: "127.0.0.1",
    COPILOT_PROXY_ALLOW_PORT_IN_USE: "1",
    // ⚠ LOAD-BEARING — do not remove. `bun test` injects NODE_ENV=test, which
    // makes consola clamp its level to warn(1) at import time, dropping every
    // `consola.info` — INCLUDING the "copilot-proxy listening on http://..."
    // banner (`main.ts:470`) that the boot loop below parses the port from.
    // consola reads CONSOLA_LEVEL *after* `_getDefaultLogLevel()`
    // (consola@3.4.2 `dist/index.mjs:623-625`), so this beats the clamp with
    // no `src/` change. Measured: NODE_ENV=test alone -> level 1, info
    // dropped; plus CONSOLA_LEVEL=3 -> level 3, info emitted.
    // Remove it and the loop below burns its full 15 s and returns port 0.
    CONSOLA_LEVEL: "3",
  } as Record<string, string>;
  if (sandboxHome) {
    if (process.platform === "win32") {
      // Bun on Windows reads USERPROFILE for os.homedir(); HOME alone is
      // not enough.
      env["USERPROFILE"] = sandbox;
      env["HOME"] = sandbox;
    } else {
      env["HOME"] = sandbox;
    }
  }

  const proc = spawn("bun", ["run", "src/main.ts"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  // TWO buffers, deliberately. `outBuf` merges both streams because the tests
  // assert on strings from each: the PII warning and the trace-disabled marker
  // are consola.warn/error (stderr), the config banner is consola.info (stdout).
  // But the PORT is parsed from `outStdout` ALONE. The banner is consola.info,
  // so it is stdout-only; against the merged buffer a stderr byte landing
  // between two stdout chunks that split the port would satisfy the `\D`
  // delimiter below and let a TRUNCATED port parse as complete.
  let outBuf = "";
  let outStdout = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8");
    outBuf += s;
    outStdout += s;
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    outBuf += chunk.toString("utf-8");
  });

  // Matched against `outStdout`, never `outBuf` — see above.
  //
  // `[^:\s]+`, not `[^:]+`: in JS a negated class matches `\n` (only `.`
  // excludes it without the `s` flag), so `[^:]+` could span from a truncated
  // `http://127.0.0.1` across a newline to some later `:<digits>` and capture a
  // FOREIGN port. Excluding whitespace confines the host to its own line.
  //
  // The trailing `\D` requires a right delimiter, so a chunk boundary landing
  // mid-digits cannot hand back a truncated port. `main.ts:470` always appends
  // " (stage 1; auth pending)", so that delimiter is guaranteed to arrive.
  // No `/g` flag: unnecessary here, and it keeps `.exec` free of lastIndex state.
  const LISTENING_RE = /listening on http:\/\/[^:\s]+:(\d+)\D/;

  const t0 = Date.now();
  // Wait up to 15s for the listening line OR an obvious failure.
  let match = LISTENING_RE.exec(outStdout);
  while (
    match === null &&
    !outBuf.includes("Fatal bootstrap error") &&
    Date.now() - t0 < 15000
  ) {
    await new Promise<void>((r) => setTimeout(r, 50));
    match = LISTENING_RE.exec(outStdout);
    // `exitCode` alone misses a signal death — a child killed by a signal
    // reports exitCode === null with signalCode set, and testing only exitCode
    // would spin the full 15 s on an already-dead child and then report the
    // least informative value in the diagnostic below.
    if (
      match === null &&
      (proc.exitCode !== null || proc.signalCode !== null)
    ) {
      // 'exit' fires BEFORE stdio is drained ('close' is the drain signal), so
      // give the pipes one more tick before concluding the banner never came.
      // One tick is a mitigation, NOT a synchronisation: a slow final flush can
      // still lose the tail. Closing that properly means racing a `close`
      // promise against the deadline, which is more machinery than this harness
      // has needed so far — if a spurious port-0 throw is ever seen on a child
      // that did boot, this is the line to fix.
      await new Promise<void>((r) => setTimeout(r, 50));
      match = LISTENING_RE.exec(outStdout);
      break;
    }
  }

  // A banner can legitimately carry port 0: `server.ts:262` falls back to a URL
  // built from the REQUESTED port when srvx reports no url, and the port
  // requested here is "0". That parses fine and would sail past a null check,
  // so treat 0 as "no usable port" rather than trusting the parse.
  const port = match === null ? 0 : Number.parseInt(match[1]!, 10);

  // HARNESS PRECONDITION. Every test in the spawned block needs a child that
  // actually reached "listening" on a real port. Throwing here instead of
  // returning 0 turns a silent 15 s degradation into one named diagnostic —
  // and it is what stops a test whose own assertions do not depend on a
  // successful boot from passing vacuously. Clean up first: nothing else will,
  // because the caller has no handle to kill yet.
  if (port === 0) {
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    // Cleanup must never mask the diagnostic: fs.rm does not retry by default,
    // so a still-writing child can make it reject with ENOTEMPTY/EBUSY, and an
    // uncaught rejection here would replace the Error below with an opaque one.
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `spawnProxy: no usable "listening on http://HOST:PORT" line after ` +
        `${Date.now() - t0}ms (parsed port=${port}, child exitCode=` +
        `${String(proc.exitCode)}). Either the child failed to boot, or its ` +
        `banner was suppressed — check that CONSOLA_LEVEL=3 is still set in ` +
        `the env above. Last 500 bytes of child output:\n${outBuf.slice(-500)}`,
    );
  }

  return {
    pid: proc.pid ?? -1,
    // LIVE getter, NOT a snapshot. `outBuf` is a string, so returning it by
    // value would freeze it at this instant and every later `+=` in the
    // stdout/stderr handlers would be invisible to the caller. The tests that
    // sleep and then read `sp.outBuf` depend on this being live.
    get outBuf(): string {
      return outBuf;
    },
    appDir: path.join(sandbox, ".local", "share", "copilot-proxy"),
    configPath,
    port,
    kill: async (): Promise<void> => {
      if (proc.exitCode !== null) {
        await rm(sandbox, { recursive: true, force: true });
        return;
      }
      proc.kill("SIGTERM");
      const closed = new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
      });
      // Force-kill after 5s if SIGTERM doesn't take.
      const timeout = new Promise<void>((resolve) =>
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 5000),
      );
      await Promise.race([closed, timeout]);
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)(
  "withTrace — Phase 5 v3.1 Group B bootstrap (spawned proxy)",
  () => {
    it("test 4: (F-DISC-15) unwritable trace_dir → proxy starts; /health succeeds — NOTE this exercises ENOTDIR only, EACCES is never induced", async () => {
      // Point trace_dir at a regular FILE (cannot be created as a dir).
      // mkdir() with recursive:true on a path whose parent IS a regular
      // file fails ENOTDIR. The bootstrap catches it and disables trace.
      const blocker = await mkdtemp(path.join(tmpdir(), "trace-blocker-"));
      // The outer try starts HERE, before the spawn: spawnProxy throws when
      // the child never reaches "listening", and `blocker` is already on disk
      // by then. Without this it would leak one temp dir per failing run.
      // Tests 6/7/9 need no equivalent — they create nothing before spawning,
      // and spawnProxy removes its own sandbox on the throw path.
      try {
        const blockerFile = path.join(blocker, "not-a-dir");
        await writeFile(blockerFile, "x");
        const traceDir = path.join(blockerFile, "subdir");
        const yaml =
          `logging:\n` + `  level: raw\n` + `  trace_dir: ${traceDir}\n`;
        const sp = await spawnProxy({ configYaml: yaml });
        try {
          // Health probe (proxy is up despite trace failure).
          const r = await fetch(`http://127.0.0.1:${sp.port}/health`);
          expect(r.status).toBe(200);
          // Give stdout an extra beat to flush.
          await new Promise<void>((r) => setTimeout(r, 250));
          expect(sp.outBuf.length).toBeGreaterThan(0);
          // Either trace warning OR health-OK proves the bootstrap recovered.
          // The string "trace writing DISABLED" is the F-DISC-15 marker.
          expect(sp.outBuf).toContain("trace writing DISABLED");
        } finally {
          await sp.kill();
        }
      } finally {
        await rm(blocker, { recursive: true, force: true });
      }
    }, 30000);

    it("test 6: (F-DISC-9) PII warning at level: raw — stdout contains 'WARNING: raw mode captures full request/response bodies'", async () => {
      const yaml = `logging:\n  level: raw\n`;
      const sp = await spawnProxy({ configYaml: yaml });
      try {
        await new Promise<void>((r) => setTimeout(r, 250));
        // NOTE — this string is `consola.warn` (`main.ts:355`), so it survives
        // a boot that never reaches "listening". That is NOT unique to this
        // test. The four markers by consola level:
        //   test 4  "trace writing DISABLED"  error  level 0  main.ts:416
        //   test 6  "WARNING: raw mode…"      warn   level 1  main.ts:355
        //   test 7  "config: loaded from…"    info   level 3  main.ts:307
        //   test 9  (no string — reads meta.json from disk after listening)
        // Test 4's marker sits at level 0, so it survives the NODE_ENV=test
        // warn(1) clamp MORE readily than this one; test 7's is emitted before
        // the banner, so it survives a later boot failure too. Only test 9
        // differs in kind.
        //
        // So non-vacuity has ONE source for all four: spawnProxy's harness
        // precondition, which throws unless a real port parsed. Do not remove
        // it on the theory that any of these assertions proves boot by itself.
        expect(sp.outBuf).toContain(
          "WARNING: raw mode captures full request/response bodies",
        );
      } finally {
        await sp.kill();
      }
    }, 30000);

    it("test 7: (F-DISC-11) restart-required banner — stdout contains 'config: loaded from ... (changes require restart)'", async () => {
      const yaml = `logging:\n  level: on\n`;
      const sp = await spawnProxy({ configYaml: yaml });
      try {
        await new Promise<void>((r) => setTimeout(r, 250));
        expect(sp.outBuf).toMatch(
          /config: loaded from .+ \(changes require restart\)/,
        );
        // Pairs with test 6. That test proves the PII warning APPEARS at
        // `level: raw`; nothing proved it is CONDITIONAL on raw. Were it
        // emitted at every level, test 6 would still pass and no test would
        // notice. This is the other half — same string, `level: on`, absent.
        expect(sp.outBuf).not.toContain(
          "WARNING: raw mode captures full request/response bodies",
        );
      } finally {
        await sp.kill();
      }
    }, 30000);

    it("test 9: (F-DISC-12) meta.json sidecar — file under APP_DIR/logs parses; config_path matches; trace_dir reflects level", async () => {
      const yaml = `logging:\n  level: raw\n`;
      const sp = await spawnProxy({ configYaml: yaml });
      try {
        // Wait briefly for the meta.json write (it happens after listening).
        await new Promise<void>((r) => setTimeout(r, 500));
        const metaPath = path.join(
          sp.appDir,
          "logs",
          "copilot-proxy.meta.json",
        );
        const txt = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(txt) as {
          pid: number;
          port: number;
          host: string;
          config_path: string;
          trace_dir: string | null;
          started_at: string;
          schema_version: number;
        };
        expect(meta.pid).toBe(sp.pid);
        expect(meta.port).toBe(sp.port);
        expect(meta.config_path).toBe(sp.configPath);
        // level: raw → trace_dir is set (default tracedir under sandbox HOME).
        expect(meta.trace_dir).not.toBeNull();
        expect(typeof meta.trace_dir).toBe("string");
        // meta.json is a cross-language contract (the PowerShell scripts read
        // it). Pinned deliberately: `main.ts:492` writes 3 — the documented
        // 2 -> 3 bump. Change this only together with that writer, never to
        // chase a red test.
        expect(meta.schema_version).toBe(3);
        // ...and assert what that bump actually ADDED, so the version number is
        // not pinned alone. Without these, all three fields could be dropped
        // from the writer while `schema_version: 3` kept this green — the
        // number would then certify a shape that no longer exists. Keys, not
        // values: `recordModelCatalog` fills them asynchronously once auth is
        // ready, so the contents are timing-dependent here and the keys are not.
        const metaKeys = Object.keys(meta);
        expect(metaKeys).toContain("models");
        expect(metaKeys).toContain("models_count");
        expect(metaKeys).toContain("models_fetched_at");
      } finally {
        await sp.kill();
      }
    }, 30000);
  },
);

// On Windows we still document the gating so the test count looks the same.
describe.skipIf(!isWindows)(
  "withTrace — Phase 5 v3.1 Group B bootstrap (Windows skip)",
  () => {
    it("Windows: spawned-proxy bootstrap tests skipped (Bun signal compat); covered on Linux CI", () => {
      expect(true).toBe(true);
    });
  },
);
