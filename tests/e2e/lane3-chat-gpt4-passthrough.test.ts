/**
 * lane3-chat-gpt4-passthrough.test.ts — Lane 3 (chat-completions GPT-4
 * passthrough).
 *
 * Lane: `POST /chat/completions` × `^gpt-4` (per `config/default.yaml`
 * Lane 3). Pure passthrough — the proxy forwards the OpenAI Chat
 * Completions-shape request to upstream `/chat/completions` and forwards
 * the response back unchanged (modulo header rules).
 *
 * Why this lane matters: this is the legacy OpenAI Chat Completions
 * surface. Some operator tooling (older harnesses, library probes,
 * embedded SDKs) only speaks Chat Completions; the proxy must keep this
 * passthrough working. The upstream emits Chat Completions SSE shape
 * (NOT Responses; NOT Anthropic) — the stream test below pins that
 * shape so a future translator misroute would be caught.
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
  "Lane 3 — chat-completions GPT-4 passthrough (real upstream)",
  () => {
    beforeAll(async () => {
      handle = await startProxy();
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopProxy(handle);
    }, 30_000);

    it("non-stream: POST /chat/completions × gpt-4o-mini returns chat.completion object", async () => {
      const resp = await fetch(`${handle.url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = (await resp.json()) as {
        object?: string;
        choices?: Array<{ message?: { role?: string; content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // NOTE: real Copilot Enterprise upstream sometimes OMITS the
      // `object: "chat.completion"` field on /chat/completions responses
      // (observed empirically in Phase 4 verification). Per spec: assert
      // structural invariants (choices[].message + usage), NOT model-
      // specific identity fields. The presence of choices[0].message is
      // a stronger invariant than the literal `object` string.
      expect(Array.isArray(body.choices)).toBe(true);
      expect(body.choices?.length ?? 0).toBeGreaterThan(0);
      expect(body.choices?.[0]?.message?.role).toBe("assistant");
      expect(
        (body.choices?.[0]?.message?.content ?? "").length,
      ).toBeGreaterThan(0);
      expect(body.usage?.prompt_tokens ?? 0).toBeGreaterThan(0);
      expect(body.usage?.completion_tokens ?? 0).toBeGreaterThan(0);
    }, 60_000);

    it("stream: POST /chat/completions × gpt-4o-mini emits Chat Completions SSE chunks + [DONE]", async () => {
      const resp = await fetch(`${handle.url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type") ?? "").toContain(
        "text/event-stream",
      );
      const text = await resp.text();
      // Chat Completions SSE: each chunk is `data: {...}` (no `event:` lines);
      // the terminator is `data: [DONE]`.
      expect(text).toContain("data: [DONE]");
      // At least one chunk must carry a non-empty `delta.content` string.
      const lines = text.split("\n");
      let sawContentDelta = false;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length).trim();
        if (payload === "[DONE]" || payload.length === 0) continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            sawContentDelta = true;
            break;
          }
        } catch {
          /* skip non-JSON payloads */
        }
      }
      expect(sawContentDelta).toBe(true);
    }, 60_000);
  },
);

describe("Lane 3 — e2e gating notice", () => {
  it.skipIf(RUN_E2E)(
    "default-skipped behind RUN_E2E=1; run via `bun run test:e2e`",
    () => {
      expect(RUN_E2E).toBe(false);
    },
  );
});
