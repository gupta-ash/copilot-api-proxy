/**
 * Replay public fixture bytes through the production stream forwarders.
 * lane.json supplies routing/rules and synthetic provenance. The mock upstream
 * yields deterministic 4–8 KB chunks to exercise split SSE/JSON boundaries.
 * Emitted bytes are compared with expected_client.sse when present; an empty
 * expected file is rejected rather than accepted as a vacuous match.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import type { Context } from "hono";

import {
  forwardStream,
  forwardStreamTranslated,
  type StreamCtxBase,
} from "~/routes/_shared/forward-stream.ts";
import {
  snapshot,
  type RegisteredStreamEventRule,
} from "~/lib/transform/registry.ts";
import { ConfigSchema, type Config } from "~/types/config-schema.ts";
import type { Rule } from "~/lib/transform/types.ts";

// ---------------------------------------------------------------------------
// Lane fixture shape (D-LOCK-13 schema; subset consumed here).
// ---------------------------------------------------------------------------

export interface LaneFixture {
  description: string;
  inbound_path: string;
  inbound_method: string;
  model: string;
  body_rules: Array<{ name: string; use: string }>;
  header_rules: Array<{ name: string; use: string }>;
  stream_event_rules: Array<{ name: string; use: string }>;
  response_rules: Array<{ name: string; use: string }>;
  upstream: {
    via: string;
    via_endpoint: string;
    shape: "openai_responses" | "openai_chat" | "anthropic_messages";
  };
  request_body: Record<string, unknown>;
  request_headers: Record<string, string>;
  source: {
    type: "synthetic";
    authoring: string;
    sha256: string;
    expected_client_sha256: string;
  };
}

export interface ReplayResult {
  emittedBytes: Uint8Array;
  match: boolean;
  diff?: string;
}

// ---------------------------------------------------------------------------
// Mock upstream — chunked ReadableStream over `upstream.sse` bytes, with
// signal-honouring cancellation so client-abort propagates to the reader.
// ---------------------------------------------------------------------------

/**
 * Pick a chunk size in [4096, 8192] deterministically from the byte offset
 * so two runs of the same lane produce the same chunk boundaries (replay
 * tests should be deterministic). The cross-chunk-boundary stress comes
 * from the fact that JSON values + SSE event boundaries land mid-chunk.
 */
function pickChunkSize(offset: number): number {
  // 4 KB to 8 KB inclusive; pseudo-random but deterministic.
  return 4096 + ((offset * 2654435761) & 0xfff);
}

/**
 * Build a `Response` whose body is a `ReadableStream<Uint8Array>` that
 * yields `bytes` in 4-8 KB chunks. Honors `signal` — abort triggers
 * `controller.error()` so the proxy's reader-loop sees the cancellation.
 */
function buildMockUpstream(bytes: Uint8Array, signal?: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      const onAbort = (): void => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const pump = (): void => {
        if (offset >= bytes.length) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          return;
        }
        const size = Math.min(pickChunkSize(offset), bytes.length - offset);
        const chunk = bytes.subarray(offset, offset + size);
        offset += size;
        try {
          controller.enqueue(chunk);
        } catch {
          /* already closed */
          return;
        }
        // Microtask scheduling — yields between chunks so the proxy reader
        // sees multi-chunk delivery (single-chunk delivery would not
        // exercise the buffer-state-across-chunks path in sse-codec).
        queueMicrotask(pump);
      };
      pump();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

// ---------------------------------------------------------------------------
// Capture sink — a WritableStream that buffers Uint8Array writes so the
// helper can return the proxy's emitted byte stream as a single buffer.
// ---------------------------------------------------------------------------

interface CaptureSink {
  api: SSEStreamingApi;
  collect: () => Uint8Array;
}

function buildCaptureSink(): CaptureSink {
  const buffers: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk): void {
      // Defensive: copy the chunk into a fresh Uint8Array so later writes
      // can't mutate already-buffered bytes via shared underlying buffer.
      buffers.push(new Uint8Array(chunk));
    },
  });
  // The SSEStreamingApi constructor wants a paired readable; wire one but
  // ignore it — the caller never reads from it (we collect via `buffers`).
  const readable = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.close();
    },
  });
  const api = new SSEStreamingApi(writable, readable);

  const collect = (): Uint8Array => {
    let total = 0;
    for (const b of buffers) total += b.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) {
      out.set(b, off);
      off += b.byteLength;
    }
    return out;
  };

  return { api, collect };
}

// ---------------------------------------------------------------------------
// Build a minimal Hono Context for the lane. We rely on
// `EndpointsSectionSchema.default()` + `UpstreamsSectionSchema.default()`
// (post-D37) to populate canonical wiring; lane.json's inbound_path /
// model determine the `ctxBase` (route + model) passed through to per-
// event applyEvent.
// ---------------------------------------------------------------------------

function buildHonoContext(lane: LaneFixture, signal: AbortSignal): Context {
  const app = new Hono();
  // Construct a Request that matches the lane's inbound path + headers so
  // `c.req.raw.signal` resolves to the caller-provided signal (essential
  // for the abort-propagation test path).
  const url = `http://replay.local${lane.inbound_path}`;
  const init: RequestInit = {
    method: lane.inbound_method,
    headers: lane.request_headers,
    body: JSON.stringify(lane.request_body),
    signal,
  };
  // Hono's Context is internal — the supported way to obtain one in tests
  // is to register a route + capture the ctx in the handler. We don't
  // dispatch the full request lifecycle (the proxy's body/header rule
  // application happens inside the route handler we're NOT exercising
  // here); we only need a Context whose `req.raw.signal` matches the
  // caller's AbortSignal so `forwardStreamTranslated`'s
  // `c.req.raw.signal.addEventListener("abort", ...)` wires up correctly.
  let captured: Context | null = null;
  app.post(lane.inbound_path, (c) => {
    captured = c;
    return c.body(null);
  });
  app.get(lane.inbound_path, (c) => {
    captured = c;
    return c.body(null);
  });
  // Fire the request synchronously to capture the ctx. We immediately
  // discard the response (only the ctx matters for replay).
  const reqPromise = app.request(url, init);
  // The handler runs synchronously inside app.request — captured will be
  // set by the time the promise resolves. Wait for it.
  void reqPromise;
  if (captured === null) {
    // Hono runs the handler synchronously for in-process app.request;
    // this branch is defensive. If we reach it the harness needs review.
    throw new Error(
      "_replay_helpers: failed to capture Hono Context for replay",
    );
  }
  return captured;
}

/**
 * Build the Config the replay uses. Relies on schema defaults for
 * `endpoints` + `upstreams` (post-D37 — `copilot_enterprise` upstream +
 * 5 canonical endpoint families). The lane's body / header / response
 * rules are mounted on a single route matching the lane's inbound_path
 * and model.
 */
function buildReplayConfig(lane: LaneFixture): Config {
  // Build the route's model_pattern from the lane's model — anchor with
  // `^` + literal text so it matches the lane's exact model only. The
  // lane.model is treated as a regex-safe literal (escape regex meta
  // chars defensively).
  const modelEscaped = lane.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const modelPattern = `^${modelEscaped}$`;

  return ConfigSchema.parse({
    routes: [
      {
        match: {
          method: lane.inbound_method,
          path: lane.inbound_path,
          model_pattern: modelPattern,
        },
        body_rules: lane.body_rules,
        header_rules: lane.header_rules,
        // M10 D-LOCK-6 (Group A): per-route stream-event rule list.
        stream_event_rules: lane.stream_event_rules,
        response_rules: lane.response_rules,
        upstream: lane.upstream,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Diff helper — light-weight unified-style line diff. NOT a true unified
// diff (no hunk grouping); good enough for "what changed?" debugging in
// regen-script + skeleton-test failures.
// ---------------------------------------------------------------------------

function lazyDiff(actual: Uint8Array, expected: Uint8Array): string {
  const td = new TextDecoder("utf-8");
  const a = td.decode(actual).split(/\r?\n/);
  const b = td.decode(expected).split(/\r?\n/);
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    if (ai !== undefined) lines.push(`- ${ai}`);
    if (bi !== undefined) lines.push(`+ ${bi}`);
    if (lines.length > 200) {
      lines.push(`... (truncated; ${max - i} more lines)`);
      break;
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point — `replayLane`.
// ---------------------------------------------------------------------------

export async function replayLane(
  laneDir: string,
  _options?: { checkOnly?: boolean },
): Promise<ReplayResult> {
  const upstreamPath = resolve(laneDir, "upstream.sse");
  const lanePath = resolve(laneDir, "lane.json");
  const expectedPath = resolve(laneDir, "expected_client.sse");

  if (!existsSync(upstreamPath)) {
    throw new Error(`replayLane: missing upstream.sse at ${upstreamPath}`);
  }
  if (!existsSync(lanePath)) {
    throw new Error(`replayLane: missing lane.json at ${lanePath}`);
  }

  const upstreamBytes = new Uint8Array(readFileSync(upstreamPath));
  const lane = JSON.parse(readFileSync(lanePath, "utf-8")) as LaneFixture;

  // Wire ctx + config + abort controller. The AbortController here is the
  // client-side abort signal; tests assert client-abort propagates through
  // forwardStreamTranslated → reader.cancel() → upstream stream.error().
  const abort = new AbortController();
  const ctx = buildHonoContext(lane, abort.signal);
  const config = buildReplayConfig(lane);
  // Reference `config` so the no-unused-vars linter is happy; future
  // expansion (e.g. validateStreamEventRules at build time) will consume
  // the parsed config more deeply.
  void config;

  // Build the mock upstream — the proxy reads from this Response's body.
  const upstreamResponse = buildMockUpstream(upstreamBytes, abort.signal);

  // Build the capture sink + invoke the forwarder.
  //
  // **M11.6 D-LOCK-1 — mirror production handler dispatch.** Per
  // `src/routes/responses/handler.ts:195-216` (and the analogous blocks in
  // `src/routes/messages/handler.ts:243-269` and
  // `src/routes/chat-completions/handler.ts:178-198`), production picks the
  // forwarder per-route on `route.stream_event_rules.length`:
  //   - empty  → `forwardStream` (verbatim byte path; D-LOCK-7)
  //   - non-empty → `forwardStreamTranslated` (decode → applyEvent → re-encode)
  // The pre-M11.6 `replayLane` ALWAYS used `forwardStreamTranslated`, which
  // (a) added `event: TYPE\n` framing for verbatim lanes (Lane 1 + Lane 2)
  // making `expected_client.sse` a 2149B normalized re-encode of the
  // 1869B verbatim bytes production actually emits, and (b) caused the M11
  // post-exec D25 keystone discriminator to flag HIGH (test exercises wrong
  // production path). M11.6 closes that HIGH by branching on
  // `lane.stream_event_rules.length` here, exactly as production does.
  const sink = buildCaptureSink();

  let cb: (stream: SSEStreamingApi) => Promise<void>;
  if (lane.stream_event_rules.length === 0) {
    // M12 D-LOCK-3: forwardStream now takes ctxBase per-route metrics labels.
    // M12.5 H1: also requires `metricRoute` (clean Prometheus label distinct
    // from `route` which is the inbound path). For replay-test scaffolding,
    // synthesize a label from the inbound path stripped of `/v1/` prefix +
    // slashes-to-underscores.
    cb = forwardStream(ctx, upstreamResponse, {
      route: lane.inbound_path,
      model: lane.model,
      metricRoute: lane.inbound_path
        .replace(/^\/?v1\//, "")
        .replace(/\//g, "_"),
    });
  } else {
    // Take a snapshot of the stream-event registry so applyEvent sees a
    // consistent view across the stream. M10 Group A's
    // forwardStreamTranslated takes the snapshot itself; we hand it in
    // explicitly to mirror the locked signature.
    const registrySnapshot: ReadonlyMap<string, RegisteredStreamEventRule> =
      snapshot("stream_event");

    // Project the lane's stream_event_rules into the Rule[] shape
    // applyEvent consumes (per types.ts § Rule).
    const rules: Rule[] = lane.stream_event_rules.map((r) => ({
      name: r.name,
      use: r.use,
    }));

    const ctxBase: StreamCtxBase = {
      route: lane.inbound_path,
      model: lane.model,
      // M12.5 H1: synthesize a clean metric label from the inbound path
      // (replay-test scaffolding does not know the production endpoint
      // family name, so derive a stable label from the path itself).
      metricRoute: lane.inbound_path
        .replace(/^\/?v1\//, "")
        .replace(/\//g, "_"),
    };

    const requestId = `replay-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    cb = forwardStreamTranslated(
      ctx,
      upstreamResponse,
      rules,
      registrySnapshot,
      requestId,
      ctxBase,
    );
  }

  await cb(sink.api);

  const emittedBytes = sink.collect();

  // Compare against expected_client.sse if present. Group C1 ships only
  // upstream.sse + lane.json — expected_client.sse is generated by Group
  // C2 via scripts/regen_replay_snapshots.ts post-A+B.
  //
  // **M11.5 D-LOCK-3 — defensive 0-byte rejection.** The post-exec D25
  // keystone discriminator on M11 surfaced a vacuous Lane 2 pass: the
  // expected_client.sse was 0 bytes (because the upstream.sse capture
  // was a truncated 2 KB prefix with no complete SSE events), and the
  // byte-equality check trivially passed `0 === 0`. To prevent this
  // failure mode from ever recurring silently, we now THROW when
  // expected_client.sse exists but is 0 bytes — refusing to assert a
  // vacuous match. The fixture must either have substantive bytes or
  // be marked DRAFT (omit expected_client.sse entirely; the
  // missing-file branch above returns `match: false`).
  if (!existsSync(expectedPath)) {
    return { emittedBytes, match: false };
  }

  const expectedBytes = new Uint8Array(readFileSync(expectedPath));
  if (expectedBytes.byteLength === 0) {
    throw new Error(
      `replayLane: expected_client.sse at ${expectedPath} is 0 bytes — refusing to assert vacuous match. ` +
        `Re-run scripts/regen_replay_snapshots.ts with --bundle PATH --expected-bundle-sha256 HASH --lane <name> against a non-empty upstream.sse.`,
    );
  }
  if (
    emittedBytes.byteLength === expectedBytes.byteLength &&
    emittedBytes.every((b, i) => b === expectedBytes[i])
  ) {
    return { emittedBytes, match: true };
  }

  return {
    emittedBytes,
    match: false,
    diff: lazyDiff(emittedBytes, expectedBytes),
  };
}
