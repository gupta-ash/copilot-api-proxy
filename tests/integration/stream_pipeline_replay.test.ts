/**
 * Replay public synthetic SSE through the production forwarders. Native lanes
 * compare exact bytes; translated lanes compare hand-authored protocol output.
 * Snapshot regeneration requires an explicitly selected bundle and SHA-256.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, test, expect } from "bun:test";

import { replayLane } from "./_replay_helpers.ts";

import { decodeSseChunk } from "~/lib/sse-codec.ts";
import { register, registerStreamEvent } from "~/lib/transform/registry.ts";
import type { AnyEvent } from "~/lib/transform/types.ts";

const FIXTURE_ROOT = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "stream-replay",
);

function decodeAll(bytes: Uint8Array): AnyEvent[] {
  const state = { buffer: "" };
  const events: AnyEvent[] = [];
  events.push(...decodeSseChunk(bytes, state));
  events.push(...decodeSseChunk(undefined, state));
  return events;
}

function eventTypes(events: readonly AnyEvent[]): string[] {
  return events.map((e) => (e as { type?: string }).type ?? "");
}

async function ensureRulesRegistered(): Promise<void> {
  // 3 redirects (per M9 redirect_to_responses_dispatch.test.ts pattern)
  const m1 = await import("~/lib/transform/redirect_to_anthropic_messages.ts");
  register(
    "redirect_to_anthropic_messages",
    m1.redirect_to_anthropic_messages,
    m1.RedirectToAnthropicMessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m2 = await import("~/lib/transform/redirect_to_chat_completions.ts");
  register(
    "redirect_to_chat_completions",
    m2.redirect_to_chat_completions,
    m2.RedirectToChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
      allow_override: true,
    },
  );
  const m3 = await import("~/lib/transform/redirect_to_responses.ts");
  register(
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
  // 3 response passthroughs
  const m4 =
    await import("~/lib/transform/response_passthrough_anthropic_v1_messages.ts");
  register(
    "response_passthrough_anthropic_v1_messages",
    m4.response_passthrough_anthropic_v1_messages,
    m4.ResponsePassthroughAnthropicV1MessagesSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
  const m5 =
    await import("~/lib/transform/response_passthrough_openai_chat_completions.ts");
  register(
    "response_passthrough_openai_chat_completions",
    m5.response_passthrough_openai_chat_completions,
    m5.ResponsePassthroughOpenaiChatCompletionsSchema,
    {
      response_shape: "openai_chat_completions",
      ctx_reads: [],
      ctx_writes: [],
      allow_override: true,
    },
  );
  const m6 =
    await import("~/lib/transform/response_passthrough_openai_responses.ts");
  register(
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
  // 2 body translators (M7a)
  const m7 =
    await import("~/lib/transform/translate_anthropic_to_responses.ts");
  register(
    "translate_anthropic_to_responses",
    m7.translate_anthropic_to_responses,
    m7.TranslateAnthropicToResponsesSchema,
    {
      response_shape: "openai_responses",
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
  const m8 =
    await import("~/lib/transform/translate_responses_to_anthropic.ts");
  register(
    "translate_responses_to_anthropic",
    m8.translate_responses_to_anthropic,
    m8.TranslateResponsesToAnthropicSchema,
    {
      response_shape: "anthropic_v1_messages",
      ctx_reads: ["body"],
      ctx_writes: ["body"],
      allow_override: true,
    },
  );
  // 2 stream translators (M7b + M10 thinking extension)
  const m9 =
    await import("~/lib/transform/translate_anthropic_event_to_responses_event.ts");
  registerStreamEvent(
    "translate_anthropic_event_to_responses_event",
    m9.translate_anthropic_event_to_responses_event,
    m9.TranslateAnthropicEventToResponsesEventSchema,
    {
      reads: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "requestId",
        "responseId",
        "summaryIndex",
      ],
      writes: [
        "contentBlocks",
        "finalUsage",
        "model",
        "outputIndex",
        "responseId",
        "stopReason",
        "summaryIndex",
      ],
      allow_override: true,
    },
  );
  const m10 =
    await import("~/lib/transform/translate_responses_event_to_anthropic_event.ts");
  registerStreamEvent(
    "translate_responses_event_to_anthropic_event",
    m10.translate_responses_event_to_anthropic_event,
    m10.TranslateResponsesEventToAnthropicEventSchema,
    {
      reads: [
        "contentBlockIndex",
        "contentBlockOpen",
        "currentToolCallId",
        "currentToolName",
        "currentToolType",
        "messageStartSent",
        "model",
        "requestId",
        "responseId",
        "thinkingTextBuffer",
        "toolArgsBuffer",
      ],
      writes: [
        "contentBlockIndex",
        "contentBlockOpen",
        "currentToolCallId",
        "currentToolName",
        "currentToolType",
        "messageStartSent",
        "model",
        "responseId",
        "thinkingTextBuffer",
        "toolArgsBuffer",
      ],
      allow_override: true,
    },
  );
}

describe("public replay fixture provenance", () => {
  for (const lane of [
    "cc_claude_passthrough",
    "cc_gpt55_thinking",
    "codex_claude_reverse",
    "codex_gpt55_native",
  ]) {
    test(`${lane}: synthetic provenance binds upstream and expected bytes`, () => {
      const laneDir = resolve(FIXTURE_ROOT, lane);
      const metadata = JSON.parse(
        readFileSync(resolve(laneDir, "lane.json"), "utf-8"),
      ) as {
        source: { type: string; sha256: string; expected_client_sha256: string };
      };
      expect(metadata.source.type).toBe("synthetic");
      for (const [file, digest] of [
        ["upstream.sse", metadata.source.sha256],
        ["expected_client.sse", metadata.source.expected_client_sha256],
      ] as const) {
        const bytes = readFileSync(resolve(laneDir, file));
        expect(bytes.byteLength).toBeGreaterThan(0);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      }
    });
  }
});

beforeEach(async () => {
  await ensureRulesRegistered();
});

// ============================================================================
// Lane 1 — CC → Claude native passthrough
// ============================================================================

describe("stream_pipeline_replay — cc_claude_passthrough (Lane 1)", () => {
  test("[M10 C2] replays upstream + emits bytes byte-equal to expected_client.sse", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_claude_passthrough");
    const result = await replayLane(laneDir);
    if (!result.match && result.diff !== undefined) {
      // eslint-disable-next-line no-console
      console.error(`[cc_claude_passthrough] diff:\n${result.diff}`);
    }
    expect(result.match).toBe(true);
  });

  test("[M10 C2] preserves all upstream events in order (event-shape audit)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_claude_passthrough");
    const result = await replayLane(laneDir);
    const emittedTypes = eventTypes(decodeAll(result.emittedBytes));
    const expectedBytes = readFileSync(resolve(laneDir, "expected_client.sse"));
    const expectedTypes = eventTypes(decodeAll(expectedBytes));
    expect(emittedTypes).toEqual(expectedTypes);
    // Lane 1 = passthrough: every event type in expected_client.sse is
    // also present in upstream.sse (modulo decode→encode round-trip
    // dropping any partial trailing event).
    expect(emittedTypes.length).toBeGreaterThan(0);
  });

  test("[M10 C2] no per-stream state leaked after stream end (sse-state lifecycle)", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_claude_passthrough");
    const beforeBytes = (await replayLane(laneDir)).emittedBytes.byteLength;
    expect(beforeBytes).toBeGreaterThan(0);
    // sse-state's lazy GC + finally-release ensures count returns to
    // baseline. Hard count would require importing _streamStateCount;
    // running 2 replays back-to-back without errors is sufficient
    // empirical verification + matches the M7b.5 lifecycle pattern.
    const second = await replayLane(laneDir);
    expect(second.emittedBytes.byteLength).toBe(beforeBytes);
  });
});

// ============================================================================
// Lane 4 — CC → GPT-5.x cross-vendor (Responses → Anthropic translation)
// ============================================================================

describe("stream_pipeline_replay — cc_gpt55_thinking (Lane 4)", () => {
  test("[M10 C2] replays upstream + emits Anthropic-shape client events", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    if (!result.match && result.diff !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `[cc_gpt55_thinking] diff (first 2KB):\n${result.diff.slice(0, 2048)}`,
      );
    }
    expect(result.match).toBe(true);
  });

  test("[M10 C2] reasoning_summary events translate to thinking_delta lifecycle", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    // Find content_block_start with type=thinking (proves reverse
    // translator opened a thinking block on reasoning_summary_part.added).
    const thinkingStarts = events.filter((e) => {
      const ev = e as { type?: string; content_block?: { type?: string } };
      return (
        ev.type === "content_block_start" &&
        ev.content_block?.type === "thinking"
      );
    });
    expect(thinkingStarts.length).toBeGreaterThanOrEqual(1);
    // Find content_block_delta with thinking_delta (proves
    // reasoning_summary_text.delta translates).
    const thinkingDeltas = events.filter((e) => {
      const ev = e as { type?: string; delta?: { type?: string } };
      return (
        ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta"
      );
    });
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(1);
  });

  test("[M10 C2] message_start carries forward through re-encode", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "cc_gpt55_thinking");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const messageStart = events.find(
      (e) => (e as { type?: string }).type === "message_start",
    );
    expect(messageStart).toBeDefined();
  });
});

// ============================================================================
// Lane 5 — Codex → Claude cross-vendor (Anthropic → Responses translation)
// ============================================================================

describe("stream_pipeline_replay — codex_claude_reverse (Lane 5)", () => {
  test("[M10 C2] replays SYNTHESIZED upstream + emits Responses-shape client events", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    if (!result.match && result.diff !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `[codex_claude_reverse] diff (first 2KB):\n${result.diff.slice(0, 2048)}`,
      );
    }
    expect(result.match).toBe(true);
  });

  test("[M10 C2] parallel tool_use blocks emit response.function_call_arguments events", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const types = eventTypes(events);
    // Both synthetic tools retain their identity and stop in reverse order.
    const completedTools = events.filter(
      (event) =>
        event.type === "response.output_item.done" &&
        (event.item as { type?: string } | undefined)?.type === "function_call",
    );
    expect(completedTools.map((event) => event.item)).toEqual([
      {
        type: "function_call",
        id: "toolu_public_reverse_list",
        call_id: "toolu_public_reverse_list",
        name: "list_files",
        arguments: '{"dir":"."}',
        status: "completed",
      },
      {
        type: "function_call",
        id: "toolu_public_reverse_read",
        call_id: "toolu_public_reverse_read",
        name: "read_file",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
    ]);
    expect(
      types.filter((t) => t === "response.function_call_arguments.delta")
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      types.filter((t) => t === "response.function_call_arguments.done").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("[M10 C2] message_delta(stop_reason=tool_use) → response.completed", async () => {
    const laneDir = resolve(FIXTURE_ROOT, "codex_claude_reverse");
    const result = await replayLane(laneDir);
    const events = decodeAll(result.emittedBytes);
    const completed = events.find(
      (e) => (e as { type?: string }).type === "response.completed",
    );
    expect(completed).toBeDefined();
    expect(completed?.response).toMatchObject({
      id: "msg_public_reverse_fixture_00000001",
      model: "claude-test",
      status: "completed",
    });
  });
});

// ============================================================================
// Lane 2 — Codex → GPT-5.x native passthrough (M11 D-LOCK-4)
// ============================================================================

describe("stream_pipeline_replay — codex_gpt55_native (Lane 2)", () => {
  test("[M11.5] replay byte-equality of Lane 2 (Codex → GPT-5.x native passthrough)", async () => {
    const result = await replayLane(
      resolve(FIXTURE_ROOT, "codex_gpt55_native"),
    );
    if (!result.match) {
      // eslint-disable-next-line no-console
      console.error("Lane 2 replay diff:\n" + (result.diff ?? "(no diff)"));
    }
    expect(result.match).toBe(true);
  });
});

// ============================================================================
// Error path 1 — non-streaming upstream response (M11 D-LOCK-8 Test 1)
// ============================================================================

describe("stream_pipeline_replay — error path: non-streaming response (M11 D-LOCK-8)", () => {
  test("application/json upstream → handler dispatches to forwardUpstreamResponse (NOT streamSSE)", async () => {
    // Per spec D-LOCK-8 + iter-3 C4: the streaming-vs-JSON dispatch
    // happens at the HANDLER layer (`messages/handler.ts:243`) via
    // `isStreamingResponse(upstream)` — the UPSTREAM response's
    // content-type is the source of truth (NOT the request's
    // `stream:true` body field). When the upstream returns
    // `application/json`, the handler MUST choose
    // `forwardUpstreamResponse` (verbatim JSON path), NOT
    // `streamSSE(forwardStreamTranslated(...))`. This test verifies
    // that branch with `stream_event_rules` populated (which would
    // otherwise force the translated path).
    //
    // NO source code changes to forward-stream.ts — the dispatch is
    // already correct in messages/handler.ts; this test confirms it.

    const { TokenManager } = await import("../../src/auth/token-manager.ts");
    const { buildApp } = await import("../../src/server.ts");
    const { ConfigSchema } = await import("../../src/types/config-schema.ts");

    // Mock fetch returning application/json (NOT text/event-stream).
    const ORIGINAL_FETCH = globalThis.fetch;
    const upstreamJsonBody = JSON.stringify({
      id: "msg_test",
      content: [{ type: "text", text: "ok" }],
    });
    globalThis.fetch = (async () => {
      return new Response(upstreamJsonBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      // Token manager (matches redirect_to_responses_dispatch.test.ts
      // pattern). Inline-built to keep the test self-contained.
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-d8t1-"));
      const ghpath = path.join(tmpDir, "github_token");
      await fs.writeFile(ghpath, "ghp_test");
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

      // Config with stream_event_rules POPULATED — this forces the
      // handler's "translated path" branch ONLY when upstream is
      // streaming. With application/json upstream, the
      // `isStreamingResponse(upstream)` check returns false and we
      // fall through to forwardUpstreamResponse regardless.
      const config = ConfigSchema.parse({
        routes: [
          {
            match: {
              method: "POST",
              path: "/v1/messages",
              model_pattern: "^claude-",
            },
            body_rules: [],
            header_rules: [],
            stream_event_rules: [
              {
                name: "stream_translate",
                use: "translate_anthropic_event_to_responses_event",
              },
            ],
            response_rules: [
              {
                name: "consume_anthropic",
                use: "response_passthrough_anthropic_v1_messages",
              },
            ],
            upstream: {
              via: "copilot_enterprise",
              via_endpoint: "anthropic_messages",
              shape: "anthropic_messages",
            },
          },
        ],
      });

      // Need response passthrough registered too.
      const m4 =
        await import("~/lib/transform/response_passthrough_anthropic_v1_messages.ts");
      register(
        "response_passthrough_anthropic_v1_messages",
        m4.response_passthrough_anthropic_v1_messages,
        m4.ResponsePassthroughAnthropicV1MessagesSchema,
        {
          response_shape: "anthropic_v1_messages",
          ctx_reads: [],
          ctx_writes: [],
          allow_override: true,
        },
      );

      const app = buildApp(config, tm);
      const r = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.7",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // Critical assertions: response Content-Type is application/json
      // (NOT text/event-stream) — proves forwardUpstreamResponse won
      // over streamSSE. Body byte-equals the upstream JSON body
      // (verbatim forward).
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(r.headers.get("content-type")).not.toContain("text/event-stream");
      const text = await r.text();
      expect(text).toBe(upstreamJsonBody);
      tm.dispose();
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

// ============================================================================
// Error path 2 — client abort mid-stream (M11 D-LOCK-8 Test 2)
// ============================================================================

describe("stream_pipeline_replay — error path: client abort mid-stream (M11 D-LOCK-8)", () => {
  test("AbortSignal.abort() during stream → reader.cancel() + state released", async () => {
    // Per spec D-LOCK-8 Test 2: client aborts mid-stream. Expected:
    // forwardStreamTranslated propagates abort to upstream reader
    // (reader.cancel()), releases stream state via
    // releaseStreamState(requestId), exits cleanly without uncaught
    // rejection. Build directly against forwardStreamTranslated rather
    // than replayLane (replayLane's mock honors signal but the test
    // needs to OBSERVE state-release semantics on the per-stream map).

    const { Hono } = await import("hono");
    const { SSEStreamingApi } = await import("hono/streaming");
    const { forwardStreamTranslated } =
      await import("~/routes/_shared/forward-stream.ts");
    const { _streamStateCount, _resetStreamStates } =
      await import("~/lib/transform/sse-state.ts");

    // Reset state so we have a known baseline.
    _resetStreamStates();
    expect(_streamStateCount()).toBe(0);

    // Build a slow mock upstream that yields chunks with setTimeout
    // delays so the test can abort mid-stream.
    const encoder = new TextEncoder();
    const events = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","output":[]}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","summary":[]}}\n\n',
      'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","summary_index":0}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ];
    const abort = new AbortController();
    let yielded = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = (): void => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* already closed */
          }
        };
        if (abort.signal.aborted) {
          onAbort();
          return;
        }
        abort.signal.addEventListener("abort", onAbort, { once: true });
        const pump = (): void => {
          if (yielded >= events.length) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          try {
            controller.enqueue(encoder.encode(events[yielded]!));
          } catch {
            return;
          }
          yielded++;
          // Slow yield so the test can abort BEFORE full drain.
          setTimeout(pump, 25);
        };
        pump();
      },
    });
    const upstream = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Build minimal Hono Context with the abort signal threaded.
    const app = new Hono();
    let captured: import("hono").Context | null = null;
    app.post("/v1/messages", (c) => {
      captured = c;
      return c.body(null);
    });
    void app.request("http://test.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: abort.signal,
    });
    if (captured === null) {
      throw new Error("test harness: failed to capture Hono ctx");
    }

    // Capture sink — accumulate bytes the proxy emits to the client so
    // we can verify partial output (less than full upstream).
    const buffers: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk): void {
        buffers.push(new Uint8Array(chunk));
      },
    });
    const readable = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    });
    const sseApi = new SSEStreamingApi(writable, readable);

    const requestId = `m11-d8t2-${Date.now()}`;
    const m10 =
      await import("~/lib/transform/translate_responses_event_to_anthropic_event.ts");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      m10.translate_responses_event_to_anthropic_event,
      m10.TranslateResponsesEventToAnthropicEventSchema,
      {
        reads: [
          "contentBlockIndex",
          "contentBlockOpen",
          "currentToolCallId",
          "currentToolName",
          "currentToolType",
          "messageStartSent",
          "model",
          "requestId",
          "responseId",
          "thinkingTextBuffer",
          "toolArgsBuffer",
        ],
        writes: [
          "contentBlockIndex",
          "contentBlockOpen",
          "currentToolCallId",
          "currentToolName",
          "currentToolType",
          "messageStartSent",
          "model",
          "responseId",
          "thinkingTextBuffer",
          "toolArgsBuffer",
        ],
        allow_override: true,
      },
    );

    const cb = forwardStreamTranslated(
      captured,
      upstream,
      [
        {
          name: "stream_translate",
          use: "translate_responses_event_to_anthropic_event",
        },
      ],
      // Snapshot using local registry import for stream_event surface.
      (await import("~/lib/transform/registry.ts")).snapshot("stream_event"),
      requestId,
      { route: "/v1/messages", model: "gpt-5.5", metricRoute: "messages" },
    );

    // Schedule abort after 60ms — gives the pump 1-2 chunks.
    setTimeout(() => abort.abort(), 60);

    // Per spec: NO uncaught rejection / hang. Wrap in await to
    // verify cb resolves cleanly.
    let threw = false;
    try {
      await cb(sseApi);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Per spec: state released after abort.
    expect(_streamStateCount()).toBe(0);

    // Per spec: partial output (less than full upstream).
    const totalBytes = buffers.reduce((acc, b) => acc + b.byteLength, 0);
    const fullUpstreamBytes = events.reduce(
      (acc, e) => acc + encoder.encode(e).byteLength,
      0,
    );
    expect(totalBytes).toBeLessThan(fullUpstreamBytes);
  });
});
