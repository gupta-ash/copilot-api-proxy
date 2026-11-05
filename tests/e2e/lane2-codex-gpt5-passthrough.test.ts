/**
 * lane2-codex-gpt5-passthrough.test.ts — Lane 2 (Codex → GPT-5 / GPT-6 passthrough).
 *
 * Lane: `POST /responses` × `^gpt-[56]` (per `config/default.yaml` Lane 2).
 * Passthrough except `service_tier` (stripped) — no body translation; the proxy forwards the
 * Responses-shape request to upstream `/responses` and forwards the
 * Responses-shape response back unchanged (modulo header rules).
 *
 * Client placeholder authorization must be replaced with the Copilot bearer
 * before initial dispatch as well as retry. This path exercises that boundary.
 *
 * Per spec, Lane 2 has no separate stream variant — the upstream
 * `/responses` SSE shape is exercised by Lane 4's stream test (which
 * shares the same upstream + adds the reverse-translator dimension).
 *
 * Default-skip: gated behind `RUN_E2E=1`. See `tests/e2e/README.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  type ProxyHandle,
  RUN_E2E,
  startProxy,
  stopProxy,
} from "./_harness.ts";

let handle: ProxyHandle;

describe.skipIf(!RUN_E2E)(
  "Lane 2 — Codex → GPT-5.x passthrough (real upstream)",
  () => {
    beforeAll(async () => {
      handle = await startProxy();
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopProxy(handle);
    }, 30_000);

    it("non-stream: POST /responses × gpt-5.5 returns valid Responses object", async () => {
      const resp = await fetch(`${handle.url}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = (await resp.json()) as {
        object?: string;
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      expect(body.object).toBe("response");
      expect(Array.isArray(body.output)).toBe(true);
      expect(body.output?.length ?? 0).toBeGreaterThan(0);
      // Find at least one message-type item with non-empty assistant text.
      const messageItem = (body.output ?? []).find((o) => o.type === "message");
      expect(messageItem).toBeDefined();
      const assistantText = (messageItem?.content ?? [])
        .filter((c) => typeof c.text === "string")
        .map((c) => c.text ?? "")
        .join("");
      expect(assistantText.length).toBeGreaterThan(0);
      expect(body.usage?.input_tokens ?? 0).toBeGreaterThan(0);
      expect(body.usage?.output_tokens ?? 0).toBeGreaterThan(0);
    }, 60_000);
  },
);

describe("Lane 2 — e2e gating notice", () => {
  it.skipIf(RUN_E2E)(
    "default-skipped behind RUN_E2E=1; run via `bun run test:e2e`",
    () => {
      expect(RUN_E2E).toBe(false);
    },
  );
});
