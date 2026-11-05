/**
 * lane1-cc-claude-passthrough.test.ts — Lane 1 (CC → Claude passthrough).
 *
 * Lane: `POST /v1/messages` × `^claude-` (per `config/default.yaml`
 * Lane 1). Pure passthrough — no body translation; the proxy forwards
 * the Anthropic-shape request to upstream `/v1/messages` and forwards
 * the Anthropic-shape response back unchanged (modulo header rules).
 *
 * Why this lane matters: this is the canonical Claude Code → Claude
 * path used by every CC user. A regression here breaks the primary
 * coding workflow for every operator. This test exercises both the
 * non-stream JSON path and the stream SSE path against real upstream.
 *
 * Default-skip: gated behind `RUN_E2E=1`. See `tests/e2e/README.md`.
 *
 * F-DISC-10 (Phase 5 v3.1 Group D): trace mode runs under the SINGLE
 * `RUN_E2E=1` gate — there is NO secondary `RUN_E2E_TRACE=1` env var.
 * The harness boots a sidecar proxy with `logging.level: raw` + a
 * `mkdtemp`'d `trace_dir`; after the non-stream Lane 1 call, the test
 * asserts that a `traces-YYYY-MM-DD/flows/0001_POST_*.json` file
 * appeared and contains the expected request/response shape with the
 * Authorization header redacted.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  type ProxyHandle,
  RUN_E2E,
  startProxy,
  stopProxy,
} from "./_harness.ts";

let handle: ProxyHandle;
let tempTraceDir: string;

describe.skipIf(!RUN_E2E)(
  "Lane 1 — CC → Claude passthrough (real upstream)",
  () => {
    beforeAll(async () => {
      // (F-DISC-10) `mkdtemp` a per-run trace dir; pass to harness so the
      // spawned proxy boots with `logging.level: raw` + `trace_dir: <temp>`.
      // We tear down `tempTraceDir` in `afterAll` after the proxy stops
      // (avoiding the "still-open file handle" delete race on Windows).
      tempTraceDir = await mkdtemp(path.join(tmpdir(), "lane1-e2e-trace-"));
      handle = await startProxy({ traceDir: tempTraceDir });
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopProxy(handle);
      // Best-effort temp cleanup. On Windows, the proxy must release file
      // handles first (handled by stopProxy's SIGTERM + 10s wait above).
      if (tempTraceDir) {
        try {
          await rm(tempTraceDir, { recursive: true, force: true });
        } catch {
          /* best-effort; OS-temp gets reaped eventually */
        }
      }
    }, 30_000);

    it("non-stream: POST /v1/messages × claude-haiku-4.5 returns valid Anthropic Message", async () => {
      const resp = await fetch(`${handle.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A client placeholder bearer must not replace the upstream token.
          // auth_layer_b.test.ts asserts this boundary directly.
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "claude-haiku-4.5",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = (await resp.json()) as {
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(Array.isArray(body.content)).toBe(true);
      expect(body.content?.length ?? 0).toBeGreaterThan(0);
      expect(body.content?.[0]?.type).toBe("text");
      expect((body.content?.[0]?.text ?? "").length).toBeGreaterThan(0);
      expect(body.usage?.input_tokens ?? 0).toBeGreaterThan(0);
      expect(body.usage?.output_tokens ?? 0).toBeGreaterThan(0);
    }, 60_000);

    it("stream: POST /v1/messages × claude-haiku-4.5 emits Anthropic SSE event sequence", async () => {
      const resp = await fetch(`${handle.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "claude-haiku-4.5",
          max_tokens: 50,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type") ?? "").toContain(
        "text/event-stream",
      );
      const text = await resp.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: content_block_delta");
      expect(text).toContain("event: message_stop");
    }, 60_000);

    it("trace: real-upstream Lane 1 call emits a flow file with redacted authorization + raw .req/.res sidecars", async () => {
      // (F-DISC-10) Trace mode runs under single RUN_E2E=1 gate; no
      // second gate. After the prior real-upstream Lane 1 calls (above),
      // the proxy's TraceWriter has flushed flow manifest + sidecar files
      // to `${tempTraceDir}/traces-YYYY-MM-DD/flows/0001_POST_*.{json,req,res}`.
      const today = new Date().toISOString().split("T")[0];
      const flowsDir = path.join(tempTraceDir, `traces-${today}`, "flows");
      const files = await readdir(flowsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      const flowFile = files.find(
        (f) => f.startsWith("0001_POST_") && f.endsWith(".json"),
      );
      expect(flowFile).toBeDefined();
      const flow = JSON.parse(
        await readFile(path.join(flowsDir, flowFile!), "utf-8"),
      ) as {
        request: {
          method: string;
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
          headers: Record<string, string>;
        };
        response: {
          status: number;
          body_kind: string;
          body_path: string | null;
          body_bytes: number;
        };
      };
      expect(flow.request.method).toBe("POST");
      expect(flow.request.body_kind).toBe("json");
      expect(flow.response.status).toBe(200);
      expect(flow.request.headers.authorization).toMatch(/<redacted/);

      // Phase 6: sidecar files exist; .res content is raw (no JSON wrap).
      expect(flow.request.body_path).toMatch(/\.req$/);
      expect(flow.response.body_path).toMatch(/\.res$/);
      const reqOnDisk = await readFile(
        path.join(flowsDir, flow.request.body_path!),
        "utf-8",
      );
      // Request was JSON; sidecar holds the raw bytes — should parse cleanly.
      const reqParsed = JSON.parse(reqOnDisk) as { model?: string };
      expect(reqParsed.model).toBe("claude-haiku-4.5");
      // Non-stream response was JSON; sidecar holds the raw bytes verbatim.
      const resOnDisk = await readFile(
        path.join(flowsDir, flow.response.body_path!),
        "utf-8",
      );
      const resParsed = JSON.parse(resOnDisk) as { type?: string };
      expect(resParsed.type).toBe("message");
      // body_bytes matches sidecar size.
      expect(flow.request.body_bytes).toBe(
        Buffer.byteLength(reqOnDisk, "utf-8"),
      );
      expect(flow.response.body_bytes).toBe(
        Buffer.byteLength(resOnDisk, "utf-8"),
      );

      // The streaming flow file (test 2 above) MUST have a .res sidecar
      // whose raw bytes start with `event: ` and contain NO `\"` escape
      // sequences — operator-issue #2 regression gate.
      const streamFlowFile = files.find(
        (f) => f.startsWith("0002_POST_") && f.endsWith(".json"),
      );
      if (streamFlowFile !== undefined) {
        const streamFlow = JSON.parse(
          await readFile(path.join(flowsDir, streamFlowFile), "utf-8"),
        ) as {
          response: { body_kind: string; body_path: string | null };
        };
        expect(streamFlow.response.body_kind).toBe("sse");
        expect(streamFlow.response.body_path).toMatch(/\.res$/);
        const sseOnDisk = await readFile(
          path.join(flowsDir, streamFlow.response.body_path!),
          "utf-8",
        );
        // Operator-issue #2 regression gate: raw SSE bytes verbatim.
        expect(sseOnDisk.startsWith("event: ")).toBe(true);
        expect(sseOnDisk).not.toContain('\\"');
        expect(sseOnDisk).toContain("event: message_start");
      }
    }, 30_000);
  },
);

// Sanity placeholder — keeps the file's case-count > 0 even when the e2e
// suite is skipped (matches the pattern at sigterm_drain.test.ts:148).
describe("Lane 1 — e2e gating notice", () => {
  it.skipIf(RUN_E2E)(
    "default-skipped behind RUN_E2E=1; run via `bun run test:e2e`",
    () => {
      expect(RUN_E2E).toBe(false);
    },
  );
});
