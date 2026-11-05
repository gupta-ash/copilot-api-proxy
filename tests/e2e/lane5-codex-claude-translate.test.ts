/**
 * Opt-in Responses-to-Claude end-to-end coverage. Requests are translated to
 * Anthropic bodies; streaming responses are translated back to Responses SSE.
 * Checks nonempty text deltas, accumulated done.text and completed output.
 * These proxy-level invariants do not establish any particular CLI rendering.
 * Requires RUN_E2E=1 and real upstream authentication; see README.md.
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
  "Lane 5 — Codex → Claude cross-vendor (real upstream)",
  () => {
    beforeAll(async () => {
      handle = await startProxy();
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopProxy(handle);
    }, 30_000);

    it("non-stream: POST /responses × claude returns assistant text (real upstream may upgrade to SSE)", async () => {
      const resp = await fetch(`${handle.url}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "claude-opus-4.7",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
        }),
      });
      expect(resp.status).toBe(200);
      const ct = resp.headers.get("content-type") ?? "";
      // EMPIRICAL (Phase 4 verification): the upstream Anthropic
      // /v1/messages path sometimes returns text/event-stream EVEN when
      // stream:true is not in the request body — the upstream forces a
      // streamed response in some configurations. Tests must accept
      // both shapes. The structural invariant is "assistant text was
      // produced", regardless of transport.
      let assistantText = "";
      let inputCount = 0;
      let outputCount = 0;
      if (ct.includes("text/event-stream")) {
        const text = await resp.text();
        const blocks = text.split("\n\n");
        for (const block of blocks) {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (dataLine === undefined) continue;
          try {
            const payload = JSON.parse(dataLine.slice("data: ".length)) as {
              delta?: { type?: string; text?: string } | string;
              text?: string;
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
            } else if (
              payload.type === "response.output_text.done" &&
              typeof payload.text === "string" &&
              payload.text.length > 0
            ) {
              // Use the accumulated text from the done event if we
              // didn't see any deltas (some upstream paths only emit
              // the final done with full text).
              if (assistantText.length === 0) assistantText = payload.text;
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
          object?: string;
          type?: string;
          output?: Array<{
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
          content?: Array<{ type?: string; text?: string }>;
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
      // EMPIRICAL: Lane 5 SSE may surface usage across multiple events
      // (message_start / message_delta split for Anthropic upstream);
      // upstream sometimes omits input_tokens or output_tokens
      // individually. (input + output) > 0 is the real-upstream-call
      // invariant — proves real tokens were billed.
      expect(inputCount + outputCount).toBeGreaterThan(0);
    }, 60_000);

    it("stream: POST /responses × claude preserves completed assistant text", async () => {
      // Text deltas must accumulate into both done.text and completed output.
      const resp = await fetch(`${handle.url}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-dummy-will-be-replaced",
        },
        body: JSON.stringify({
          model: "claude-opus-4.7",
          stream: true,
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
        "text/event-stream",
      );
      const text = await resp.text();

      // Parse SSE blocks (separator is "\n\n").
      const blocks = text.split("\n\n");

      // (a) Assert at least one `response.output_text.delta` event with
      //     non-empty delta string — proves the translator IS receiving +
      //     forwarding text_delta events (the source of accumulation).
      let sawNonEmptyDelta = false;
      // The completed text must survive beyond the incremental deltas.
      let sawDoneWithText = false;
      let doneTextLen = 0;
      // Completed output must contain a message item with nonempty text.
      let sawCompletedWithMessage = false;
      let messageText = "";
      for (const block of blocks) {
        if (block.length === 0) continue;
        const lines = block.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (eventLine === undefined || dataLine === undefined) continue;
        const eventName = eventLine.slice("event: ".length).trim();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(dataLine.slice("data: ".length)) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }
        if (eventName === "response.output_text.delta") {
          const delta =
            typeof payload["delta"] === "string"
              ? (payload["delta"] as string)
              : "";
          if (delta.length > 0) sawNonEmptyDelta = true;
        }
        if (eventName === "response.output_text.done") {
          const doneText =
            typeof payload["text"] === "string"
              ? (payload["text"] as string)
              : "";
          if (doneText.length > 0) {
            sawDoneWithText = true;
            doneTextLen = doneText.length;
          }
        }
        if (eventName === "response.completed") {
          const respObj = payload["response"] as
            | Record<string, unknown>
            | undefined;
          const output = respObj?.["output"] as
            | Array<Record<string, unknown>>
            | undefined;
          if (Array.isArray(output)) {
            const messageItem = output.find(
              (item) => item["type"] === "message",
            );
            if (messageItem !== undefined) {
              sawCompletedWithMessage = true;
              const content = messageItem["content"] as
                | Array<Record<string, unknown>>
                | undefined;
              const textPart = content?.find(
                (c) => c["type"] === "output_text",
              );
              messageText = (textPart?.["text"] as string | undefined) ?? "";
            }
          }
        }
      }
      expect(sawNonEmptyDelta).toBe(true);
      // Assert actual accumulated translator output, not merely event presence.
      expect(sawDoneWithText).toBe(true);
      expect(doneTextLen).toBeGreaterThan(0);
      // M17 regression assertion: `response.completed.response.output[]`
      // contains a message item with non-empty text. If this fails, the
      // forward translator's output[] assembly has regressed.
      expect(sawCompletedWithMessage).toBe(true);
      expect(messageText.length).toBeGreaterThan(0);
    }, 60_000);
  },
);

describe("Lane 5 — e2e gating notice", () => {
  it.skipIf(RUN_E2E)(
    "default-skipped behind RUN_E2E=1; run via `bun run test:e2e`",
    () => {
      expect(RUN_E2E).toBe(false);
    },
  );
});
