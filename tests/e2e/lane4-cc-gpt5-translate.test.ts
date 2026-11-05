/**
 * lane4-cc-gpt5-translate.test.ts — Lane 4 (CC → GPT-5.x cross-vendor).
 *
 * Lane: `POST /v1/messages` × `^gpt-5\.` (per `config/default.yaml`
 * Lane 4). Cross-vendor:
 *
 *   - Forward path: client posts an Anthropic-shape body to /v1/messages
 *     with a GPT-5.x model. The proxy applies `redirect_to_responses`
 *     (marker rule) + `translate_anthropic_to_responses` (body
 *     translator), then dispatches to upstream `/responses`.
 *   - Reverse path: upstream returns Responses-shape body / SSE events.
 *     Non-streaming bodies are passed back without response-shape conversion.
 *     For the stream test the proxy applies
 *     `translate_responses_event_to_anthropic_event` per-event so CC's
 *     SSE consumer sees an Anthropic-shape stream.
 *
 * Why this lane matters: Lane 4 is the first lane to exercise BOTH the
 * forward body translator AND the reverse SSE translator. A regression
 * in either direction breaks the CC + GPT-5.x cross-vendor flow.
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
  "Lane 4 — CC → GPT-5.x cross-vendor (real upstream)",
  () => {
    beforeAll(async () => {
      handle = await startProxy();
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopProxy(handle);
    }, 30_000);

    it("non-stream: POST /v1/messages × gpt-5.5 returns assistant text (real upstream may upgrade to SSE)", async () => {
      const resp = await fetch(`${handle.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      const ct = resp.headers.get("content-type") ?? "";
      // EMPIRICAL (Phase 4 verification): the upstream Responses path
      // sometimes returns text/event-stream EVEN when stream:true is not
      // in the request body — the upstream forces a streamed response
      // for certain model+config combinations. Tests must accept both
      // shapes. The structural invariant is "assistant text was
      // produced", regardless of transport (JSON vs SSE).
      let assistantText = "";
      let inputCount = 0;
      let outputCount = 0;
      if (ct.includes("text/event-stream")) {
        const text = await resp.text();
        // Extract assistant text from any text-bearing event in either
        // Anthropic-shape (content_block_delta) or Responses-shape
        // (response.output_text.delta) — Lane 4 SSE may carry either.
        const blocks = text.split("\n\n");
        for (const block of blocks) {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (dataLine === undefined) continue;
          try {
            const payload = JSON.parse(dataLine.slice("data: ".length)) as {
              delta?: { type?: string; text?: string } | string;
              type?: string;
              usage?: Record<string, number | undefined>;
              response?: { usage?: Record<string, number | undefined> };
              message?: { usage?: Record<string, number | undefined> };
            };
            const d = payload.delta;
            if (typeof d === "string" && d.length > 0) assistantText += d;
            else if (
              typeof d === "object" &&
              d !== null &&
              typeof d.text === "string" &&
              d.text.length > 0
            ) {
              assistantText += d.text;
            }
            const u =
              payload.usage ??
              payload.response?.usage ??
              payload.message?.usage;
            if (u !== undefined) {
              inputCount = Math.max(
                inputCount,
                u["input_tokens"] ?? u["prompt_tokens"] ?? 0,
              );
              outputCount = Math.max(
                outputCount,
                u["output_tokens"] ?? u["completion_tokens"] ?? 0,
              );
            }
          } catch {
            /* skip non-JSON */
          }
        }
      } else {
        const body = (await resp.json()) as {
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
          object?: string;
          output?: Array<{
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
          usage?: Record<string, number | undefined>;
        };
        if (body.type === "message") {
          assistantText =
            body.content?.[0]?.type === "text"
              ? (body.content[0].text ?? "")
              : "";
        } else {
          const messageItem = (body.output ?? []).find(
            (o) => o.type === "message",
          );
          assistantText = (messageItem?.content ?? [])
            .filter((c) => typeof c.text === "string")
            .map((c) => c.text ?? "")
            .join("");
        }
        const usage = body.usage ?? {};
        inputCount = usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0;
        outputCount = usage["output_tokens"] ?? usage["completion_tokens"] ?? 0;
      }
      expect(assistantText.length).toBeGreaterThan(0);
      // EMPIRICAL: Lane 4 SSE may surface usage across multiple events
      // (message_start carries {input:0,output:0}; message_delta carries
      // {output:N}); upstream sometimes omits input_tokens entirely. The
      // total of (input + output) > 0 is a real-upstream-call invariant
      // (proves real tokens were billed), and is more robust to the
      // multi-event usage layout than asserting both individually.
      expect(inputCount + outputCount).toBeGreaterThan(0);
    }, 60_000);

    it("stream: POST /v1/messages × gpt-5.5 emits Anthropic SSE event sequence (reverse-translated)", async () => {
      const resp = await fetch(`${handle.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
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
      // Reverse SSE translator (`translate_responses_event_to_anthropic_event`)
      // converts upstream Responses-shape events into Anthropic-shape events.
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: content_block_delta");
      expect(text).toContain("event: message_stop");
      // Verify at least one content_block_delta carried non-empty text — the
      // delta payload's `text` field is what CC's SSE consumer renders.
      const blocks = text.split("\n\n");
      let sawNonEmptyTextDelta = false;
      for (const block of blocks) {
        if (!block.includes("event: content_block_delta")) continue;
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine === undefined) continue;
        try {
          const parsed = JSON.parse(dataLine.slice("data: ".length)) as {
            delta?: { type?: string; text?: string };
          };
          if (
            parsed.delta?.type === "text_delta" &&
            typeof parsed.delta.text === "string" &&
            parsed.delta.text.length > 0
          ) {
            sawNonEmptyTextDelta = true;
            break;
          }
        } catch {
          /* skip */
        }
      }
      expect(sawNonEmptyTextDelta).toBe(true);
    }, 60_000);
  },
);

describe("Lane 4 — e2e gating notice", () => {
  it.skipIf(RUN_E2E)(
    "default-skipped behind RUN_E2E=1; run via `bun run test:e2e`",
    () => {
      expect(RUN_E2E).toBe(false);
    },
  );
});
