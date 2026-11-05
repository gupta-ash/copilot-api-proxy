/**
 * forward-stream-stall.test.ts — W2 content-phase stall detector integration
 * tests for BOTH forwarders.
 *
 * Determinism (no real waiting, no `setSystemTime`): the injected fake
 * `StallTimer.arm()` resolves via `setTimeout(0)` — a MACROTASK. When a chunk
 * is already queued, `reader.read()` resolves on a MICROTASK and wins the race;
 * when the upstream is silent, the macrotask fires and the stall path runs.
 * The fake also records every armed period + logged record for assertions.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  boundedLabelValue,
  getValueForTests,
  resetForTests,
} from "../../../src/lib/metrics.ts";
import type {
  IncidentConfig,
  IncidentRecord,
} from "../../../src/lib/incident-log.ts";
import {
  registerStreamEvent,
  snapshot,
  type RegisteredStreamEventRule,
} from "../../../src/lib/transform/registry.ts";
import type { Rule } from "../../../src/lib/transform/types.ts";
import {
  forwardStream,
  forwardStreamTranslated,
  requestBytesOf,
} from "../../../src/routes/_shared/forward-stream.ts";
import { makeStallTimer } from "../../../src/routes/_shared/stall-detect.ts";
import type {
  KeepAliveConfig,
  StallConfig,
  StallRecord,
  StallTimer,
} from "../../../src/routes/_shared/stall-detect.ts";

const enc = new TextEncoder();

/**
 * Upstream that emits `chunks` SYNCHRONOUSLY (so they are queued before the
 * first read) then HANGS — never closes — so the read after the last chunk
 * pends forever and the stall timer can win.
 */
function makeHangingResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const c of chunks) controller.enqueue(c);
      // Deliberately NOT closed.
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Fake `StallConfig` whose timer resolves on a `setTimeout(delayMs)` macrotask
 * (loses to a queued-chunk microtask read, wins against a silent upstream).
 * Records the armed periods + logged records.
 *
 * `delayMs` defaults to 0, which is what every pre-keep-alive case wants. Slice
 * (d) needs it NON-ZERO: `stallP` is armed one statement before `kaP`, so with
 * both at `setTimeout(0)` the stall timer is queued first, fires first, and the
 * keep-alive can never win a single round — the fixture would then assert the
 * feature's ABSENCE while looking like it asserted its behaviour, which is
 * exactly the defect that made the plan's own B3 arm nothing.
 */
function makeFakeStall(delayMs = 0): {
  config: StallConfig;
  armedPeriods: number[];
  logged: StallRecord[];
} {
  const armedPeriods: number[] = [];
  const logged: StallRecord[] = [];
  const makeTimer = (): StallTimer => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    return {
      arm(ms: number): Promise<void> {
        armedPeriods.push(ms);
        if (handle !== undefined) clearTimeout(handle);
        return new Promise<void>((resolve) => {
          handle = setTimeout(resolve, delayMs);
        });
      },
      cancel(): void {
        if (handle !== undefined) {
          clearTimeout(handle);
          handle = undefined;
        }
      },
    };
  };
  return {
    config: {
      noResponseWaitMs: 1_140_000,
      responseWaitMs: 600_000,
      makeTimer,
      log: (r: StallRecord): void => {
        logged.push(r);
      },
    },
    armedPeriods,
    logged,
  };
}

function verbatimApp(
  upstream: Response,
  stall: StallConfig,
  requestId?: string,
  incident?: IncidentConfig,
): Hono {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStream(c, upstream, {
        route: "/v1/messages",
        model: "claude-test",
        metricRoute: "messages",
        stall,
        requestId,
        incident,
      }),
    ),
  );
  return app;
}

/** Upstream that emits `chunks` synchronously then CLOSES — a clean stream. */
function makeClosingResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Upstream that waits `firstByteDelayMs`, emits `first`, waits `gapMs` of REAL
 * wall-clock silence, emits `second`, then closes.
 *
 * The gap has to be real. Every other fixture in this file completes in well
 * under a millisecond, which makes `_sum` assertions on the silence histogram
 * indistinguishable from an implementation that records a constant zero — the
 * exact vacuity this fixture exists to remove. `gapMs` is chosen so the sample
 * can be bounded from BELOW (a zero implementation fails) and from ABOVE (a
 * milliseconds-not-seconds implementation fails).
 *
 * `firstByteDelayMs` is what separates the THREE quantities a max-silence
 * assertion can confuse: time-to-first-byte, the inter-byte gap, and total
 * stream duration. With the first byte queued immediately they collapse —
 * upstream first-byte is ~0 and duration ~= the gap, so an implementation that measured
 * start-to-completion instead of the inter-byte gap produced an almost
 * identical number and no assertion here could tell them apart. Delaying the
 * first byte makes duration ~= firstByteDelayMs + gapMs, i.e. distinguishable
 * from gapMs by a wide margin. (Caught by the round-2 cross-family gate: the
 * previous revision NAMED that mutation in a comment and did not catch it.)
 */
function makeGappyResponse(
  first: Uint8Array,
  second: Uint8Array,
  gapMs: number,
  firstByteDelayMs = 0,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      setTimeout(() => {
        controller.enqueue(first);
        setTimeout(() => {
          controller.enqueue(second);
          controller.close();
        }, gapMs);
      }, firstByteDelayMs);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Per-stream knobs both lane runners accept, so a case reads identically twice. */
interface LaneOpts {
  stall?: StallConfig;
  requestId?: string;
  incident?: IncidentConfig;
  model?: string;
  requestBytes?: number;
  /**
   * F159 — the end-to-end dispatch anchor a handler would thread from
   * `dispatchStartedMsOf(c)`. Omitted by default so the ABSENT-anchor case is
   * the one every pre-existing test exercises.
   */
  dispatchStartedMs?: number;
  /**
   * The metric route, which also SELECTS THE CLIENT PROTOCOL
   * (`protocolFromMetricRoute`). Both runners hardcoded `"messages"` until slice
   * (b), which made `route="chat_completions"` — the only structurally
   * content-blind lane — unreachable from this harness.
   */
  metricRoute?: string;
  /**
   * F165 — the keep-alive, threaded into BOTH runners in one edit. A field added
   * to one runner only reproduces exactly the defect this file's pairing device
   * exists to catch, which is why the obligation was recorded here by slice (c)
   * rather than half-applied.
   */
  keepAlive?: KeepAliveConfig;
}

/**
 * Drive one stream through the VERBATIM forwarder and return the client body.
 *
 * Paired with {@link runTranslated} so a D47 mirror is one identifier apart:
 * a case that exists on only one lane is visible as such at a glance, which is
 * what the previous revision of this file could not offer — every forwarder
 * integration test it added exercised `forwardStream` alone, so deleting the
 * translated lane's `noteUpstreamBytes` call left the whole suite green.
 */
async function runVerbatim(
  upstream: Response,
  o: LaneOpts = {},
): Promise<string> {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStream(c, upstream, {
        route: "/v1/messages",
        model: o.model ?? "claude-test",
        metricRoute: o.metricRoute ?? "messages",
        stall: o.stall,
        keepAlive: o.keepAlive,
        requestId: o.requestId,
        incident: o.incident,
        requestBytes: o.requestBytes,
        dispatchStartedMs: o.dispatchStartedMs,
      }),
    ),
  );
  return await (await app.request("/sse")).text();
}

/** Drive one stream through the TRANSLATED forwarder. Mirror of {@link runVerbatim}. */
async function runTranslated(
  upstream: Response,
  o: LaneOpts = {},
): Promise<string> {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStreamTranslated(
        c,
        upstream,
        [],
        new Map(),
        o.requestId ?? "tx-req",
        {
          route: "/v1/messages",
          model: o.model ?? "claude-test",
          metricRoute: o.metricRoute ?? "messages",
          stall: o.stall,
          keepAlive: o.keepAlive,
          requestId: o.requestId,
          incident: o.incident,
          requestBytes: o.requestBytes,
          dispatchStartedMs: o.dispatchStartedMs,
        },
      ),
    ),
  );
  return await (await app.request("/sse")).text();
}

/**
 * Upstream that emits every chunk immediately, then holds the stream OPEN for
 * `idleMs` before closing. The last chunk is a terminal event, so this is the
 * post-terminal idle case.
 */
function makeIdleBeforeCloseResponse(
  chunks: Uint8Array[],
  idleMs: number,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const c of chunks) controller.enqueue(c);
      setTimeout(() => controller.close(), idleMs);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A well-formed Anthropic text delta — decodable by the translated lane. */
const TEXT_DELTA = enc.encode(
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
);
/** A well-formed Anthropic terminal — decodable by the translated lane. */
const MESSAGE_STOP = enc.encode(
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
);
/**
 * A well-formed Anthropic `message_start` — a RAW first byte that is NOT
 * content. It is the whole reason `first_content_seconds` is not `upstream_first_byte`.
 */
const MESSAGE_START = enc.encode(
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test"}}\n\n',
);
/** Opens an Anthropic thinking block — suspends the tight window. */
const THINKING_START = enc.encode(
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
);
/**
 * A chat-completions content delta, deliberately SHORT so the `"content"`
 * substring lands well inside `STALL_PEEK_CAP` (200). A realistic chunk carrying
 * an id, created, model and `system_fingerprint` puts it at byte ~199-230 — see
 * that constant's docblock for the measurement — so a longer fixture here would
 * silently stop testing what it claims to.
 */
const CHAT_DELTA = enc.encode(
  'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
);
/** The chat terminal sentinel. */
const CHAT_DONE = enc.encode("data: [DONE]\n\n");

/**
 * A `StallConfig` whose timer is armed but NEVER fires. The detector is fully
 * live — every read is raced and every wait is measured — but the stall arm can
 * never win, so a fixture can exercise detector-wait accounting on a stream that
 * completes NORMALLY. `makeFakeStall`'s `setTimeout(0)` timer cannot do this: it
 * wins the moment the upstream pauses, which is the opposite case.
 */
function makeNeverFiringStall(): StallConfig {
  return {
    noResponseWaitMs: 1_140_000,
    responseWaitMs: 600_000,
    makeTimer: (): StallTimer => ({
      arm: (): Promise<void> => new Promise<void>(() => {}),
      cancel: (): void => {
        /* nothing to cancel — the promise never settles */
      },
    }),
    log: (): void => {
      /* a never-firing timer logs nothing */
    },
  };
}

/**
 * An upstream whose `ReadableStream` ERRORS after `errMs` — i.e. `reader.read()`
 * REJECTS rather than resolving. The only fixture that can reach the race
 * block's `finally` via a throw, which is what the M1 try/finally exists for.
 */
function makeErroringResponse(errMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      setTimeout(() => controller.error(new Error("upstream RST")), errMs);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Emits `message_start` IMMEDIATELY, waits `deltaMs` of real silence, then a
 * content delta, then the terminal, then closes.
 *
 * This is the fixture that separates first-BYTE from first-CONTENT: the raw byte
 * lands at ~0 while content lands at ~`deltaMs`. Every other fixture in this
 * file collapses the two, which is why none of them could catch an
 * implementation that aliased one to the other.
 */
function makeGreetThenContentResponse(deltaMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(MESSAGE_START);
      setTimeout(() => {
        controller.enqueue(TEXT_DELTA);
        controller.enqueue(MESSAGE_STOP);
        controller.close();
      }, deltaMs);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * `message_start` IMMEDIATELY, then `deltaMs` of real silence, then a content
 * delta, then `errMs` later an upstream ERROR — so the stream ends with a
 * non-success outcome and therefore WRITES an incident record.
 *
 * `makeGreetThenContentResponse` closes cleanly, which produces no record at
 * all (records are appended only when `outcome !== "success"`), so it cannot
 * pin the RECORD's `firstContentMs`. The error is scheduled on a later
 * macrotask rather than immediately after the enqueue because
 * `ReadableStreamDefaultController.error()` RESETS the queue — erroring in the
 * same tick would discard the delta this fixture exists to deliver.
 */
function makeGreetThenContentThenErrorResponse(
  deltaMs: number,
  errMs: number,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(MESSAGE_START);
      setTimeout(() => {
        controller.enqueue(TEXT_DELTA);
        setTimeout(() => controller.error(new Error("upstream RST")), errMs);
      }, deltaMs);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  resetForTests();
});

describe("W2 stall detector — verbatim forwardStream", () => {
  it("pre-content silence → Case-1 window → upstream_stall 504 frame + no_response log", async () => {
    const fake = makeFakeStall();
    const app = verbatimApp(makeHangingResponse([]), fake.config);
    const resp = await app.request("/sse");
    const text = await resp.text();

    // Anthropic gateway-shaped error frame injected.
    expect(text).toContain("event: error");
    expect(text).toContain("upstream stall");
    // Only the generous Case-1 window was ever armed.
    expect(fake.armedPeriods).toEqual([1_140_000]);
    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]!.phase).toBe("no_response");
    expect(fake.logged[0]!.waitedMs).toBe(1_140_000);
    expect(fake.logged[0]!.protocol).toBe("anthropic");
  });

  it("content then silence → tight Case-2 window armed after the first delta → response log", async () => {
    const delta = enc.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    );
    const fake = makeFakeStall();
    const app = verbatimApp(makeHangingResponse([delta]), fake.config);
    const resp = await app.request("/sse");
    const text = await resp.text();

    // The content delta was forwarded, then the stall frame appended.
    expect(text).toContain("text_delta");
    expect(text).toContain("event: error");
    // First arm = generous (pre-content); second arm = tight (content started).
    expect(fake.armedPeriods).toEqual([1_140_000, 600_000]);
    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]!.phase).toBe("response");
    expect(fake.logged[0]!.waitedMs).toBe(600_000);
  });

  it("thinking block after content suspends the tight window (thinking-pause)", async () => {
    const textDelta = enc.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    );
    const thinkStart = enc.encode(
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
    );
    const fake = makeFakeStall();
    const app = verbatimApp(
      makeHangingResponse([textDelta, thinkStart]),
      fake.config,
    );
    const resp = await app.request("/sse");
    await resp.text();

    // arm[0] pre-content generous; arm[1] tight (content started, not thinking);
    // arm[2] generous AGAIN because a thinking block is open — the pause proof.
    expect(fake.armedPeriods).toEqual([1_140_000, 600_000, 1_140_000]);
    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]!.waitedMs).toBe(1_140_000);
    // Slice (b) — the LABEL must agree with the BUDGET. Before the phase was
    // derived from `detectorPhase`, this record said "response" while
    // `waitedMs` was the 1,140,000 ms NO-RESPONSE budget, and the client-visible
    // frame read `upstream stall: no further content within 1140000ms (response
    // phase)`. MUTATION ARMED: revert to `peek.contentStarted ? "response" :
    // "no_response"` and this is the assertion that goes red.
    expect(fake.logged[0]!.phase).toBe("no_response");
  });

  it("feature OFF (no stall config) → legacy path, no stall frame, clean close", async () => {
    // A normal, CLOSING stream: with no timer the read loop drains + closes
    // exactly as before (additivity).
    const chunks = [
      enc.encode("event: message_start\ndata: {}\n\n"),
      enc.encode("event: message_stop\ndata: {}\n\n"),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(c, upstream, {
          route: "/v1/messages",
          model: "claude-test",
          metricRoute: "messages",
          // no `stall` → feature off
        }),
      ),
    );
    const resp = await app.request("/sse");
    const text = await resp.text();
    expect(text).toBe(
      "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
    );
    expect(text).not.toContain("upstream stall");
  });

  it("fix#1 — terminal then close: no post-terminal stall re-arm", async () => {
    // A stream that emits ONE terminal SSE event then closes. Once the terminal
    // is committed (sawTerminal), the read loop must NOT arm another stall timer
    // (fix#1): the post-terminal read falls through to the plain read. Buggy code
    // armed a SECOND timer after the terminal (a hung-but-complete upstream would
    // then trip a spurious 504 on an already-complete stream).
    const term = enc.encode("event: message_stop\ndata: {}\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(term);
        controller.close();
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fake = makeFakeStall();
    const app = verbatimApp(upstream, fake.config);
    const resp = await app.request("/sse");
    const text = await resp.text();

    // Exactly ONE pre-terminal arm — no post-terminal re-arm.
    expect(fake.armedPeriods).toEqual([1_140_000]);
    expect(fake.logged.length).toBe(0);
    expect(text).not.toContain("upstream stall");
  });

  it("fix#2 — abort under stall reclassifies to client_abort (499, not 504)", async () => {
    // The stall timer wins the read race, but the client already tore down
    // (stream.aborted) as the window elapsed. The abort-precedence guard (fix#2)
    // must classify this as client_abort (499), NOT upstream_stall (504), and log
    // no stall. Uses the mock-stream harness so `stream.aborted` can be flipped by
    // the timer's arm() immediately before it resolves (the timer wins the race
    // with stream.aborted already true).
    const mockCtx = {
      req: { raw: { signal: new AbortController().signal } },
    } as unknown as Parameters<typeof forwardStream>[0];

    const mockStream = {
      aborted: false,
      write: async (_v: Uint8Array | string): Promise<void> => {
        /* no-op */
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof forwardStream>>>[0];

    const logged: StallRecord[] = [];
    const stall: StallConfig = {
      noResponseWaitMs: 1_140_000,
      responseWaitMs: 600_000,
      makeTimer: (): StallTimer => ({
        arm(_ms: number): Promise<void> {
          return new Promise<void>((resolve) => {
            // Model a client socket close that beat the stall window: mark the
            // writer aborted the instant before the timer resolves.
            (mockStream as { aborted: boolean }).aborted = true;
            setTimeout(resolve, 0);
          });
        },
        cancel(): void {
          /* no-op */
        },
      }),
      log: (r: StallRecord): void => {
        logged.push(r);
      },
    };

    const cb = forwardStream(mockCtx, makeHangingResponse([]), {
      route: "/v1/messages",
      model: "claude-test",
      metricRoute: "stall-abort-precedence-route",
      stall,
    });
    await cb(mockStream);

    // client_abort (499) recorded, NOT a stall (504); no stall logged.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "stall-abort-precedence-route",
        status: "499",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "stall-abort-precedence-route",
        status: "504",
      }),
    ).toBeUndefined();
    expect(logged.length).toBe(0);
  });
});

describe("W2 stall detector — translated forwardStreamTranslated", () => {
  it("pre-content silence → upstream_stall 504 frame + no_response log", async () => {
    const fake = makeFakeStall();
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          makeHangingResponse([]),
          [],
          new Map(),
          "stall-tx-req",
          {
            route: "/v1/messages",
            model: "claude-test",
            metricRoute: "messages",
            stall: fake.config,
          },
        ),
      ),
    );
    const resp = await app.request("/sse");
    const text = await resp.text();

    expect(text).toContain("event: error");
    expect(text).toContain("upstream stall");
    expect(fake.armedPeriods).toEqual([1_140_000]);
    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]!.phase).toBe("no_response");
  });

  it("fix#1 — terminal then close: no post-terminal stall re-arm", async () => {
    // Mirror of the verbatim fix#1 test through the translated forwarder: a real
    // message_stop event (passed through with empty rules) commits sawTerminal, so
    // the post-terminal read must NOT arm a second timer. Its only arm is the
    // pre-terminal one.
    const term = enc.encode(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(term);
        controller.close();
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fake = makeFakeStall();
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStreamTranslated(
          c,
          upstream,
          [],
          new Map(),
          "stall-tx-term-req",
          {
            route: "/v1/messages",
            model: "claude-test",
            metricRoute: "messages",
            stall: fake.config,
          },
        ),
      ),
    );
    const resp = await app.request("/sse");
    const text = await resp.text();

    // Exactly ONE pre-terminal arm — no extra post-terminal entry.
    expect(fake.armedPeriods).toEqual([1_140_000]);
    expect(fake.logged.length).toBe(0);
    expect(text).not.toContain("upstream stall");
  });
});

/**
 * The join key must reach the stall record without `traceMeta`.
 * `with-trace.ts` populates that object only at raw logging levels; request
 * identity must remain available when routine tracing is disabled. Both the
 * verbatim and translated forwarders must carry the independently resolved key.
 *
 * The first case FAILS on the pre-fix code (`undefined !== "join-key-abc"`),
 * which is what makes this a detector rather than a restatement.
 */
describe("stall record join key — level-independent", () => {
  it("carries ctxBase.requestId into the record when traceMeta is absent", async () => {
    const fake = makeFakeStall();
    const app = verbatimApp(
      makeHangingResponse([]),
      fake.config,
      "join-key-abc",
    );

    const resp = await app.request("/sse");
    await resp.text();

    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]?.requestId).toBe("join-key-abc");
  });

  it("omits requestId entirely — never a placeholder — when no id source exists", async () => {
    const fake = makeFakeStall();
    const app = verbatimApp(makeHangingResponse([]), fake.config);

    const resp = await app.request("/sse");
    await resp.text();

    expect(fake.logged.length).toBe(1);
    // Deliberately `undefined`, NOT the "<unknown>" display placeholder: a
    // record asserting a false id is worse than one that omits the field,
    // because a consumer cannot tell the difference after the fact.
    expect(fake.logged[0]?.requestId).toBeUndefined();
  });
});

/**
 * D96 Phase 1 — the always-on incident log, exercised through the forwarder.
 *
 * These assert the two properties the record exists for, and each fails under
 * an obvious wrong implementation: recording successes (test 3), or stamping
 * `ttfbMs` unconditionally (tests 1 vs 2). The `ttfbMs` pair is the load-bearing
 * one — absent-vs-present is the ONLY thing that separates "the upstream never
 * spoke" from "the stream started and then broke", and collapsing them is what
 * made a peer's 48 stalls look like two classes when they were one.
 */
function collectIncidents(): {
  config: IncidentConfig;
  seen: IncidentRecord[];
} {
  const seen: IncidentRecord[] = [];
  return {
    config: {
      log: (r: IncidentRecord): void => {
        seen.push(r);
      },
    },
    seen,
  };
}

describe("D96 incident log — verbatim forwardStream", () => {
  it("pre-content stall → ttfbMs ABSENT, phase pre_content, joinable by requestId", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const app = verbatimApp(
      makeHangingResponse([]),
      fake.config,
      "req-abc-123",
      inc.config,
    );

    await (await app.request("/sse")).text();

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    // The discriminator: no upstream byte ever arrived, so the field is absent
    // rather than zero. A `0` here would read as "answered instantly".
    expect(rec.ttfbMs).toBeUndefined();
    expect(rec.phase).toBe("pre_content");
    expect(rec.bytesReceived).toBe(0);
    // Outcome + status come from the forwarder's own mapping, not a second one.
    expect(rec.outcome).toBe("upstream_stall");
    expect(rec.status).toBe(504);
    // The join key, threaded level-independently (abf553f).
    expect(rec.requestId).toBe("req-abc-123");
    expect(rec.route).toBe("messages");
    expect(rec.protocol).toBe("anthropic");
    expect(rec.model).toBe("claude-test");
    // elapsedMs is always present and is a DIFFERENT quantity from ttfbMs.
    expect(typeof rec.elapsedMs).toBe("number");
    expect(rec.ts).toContain("T");
  });

  it("content then stall → ttfbMs PRESENT and bytes counted, phase mid_stream", async () => {
    const delta = enc.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    );
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const app = verbatimApp(
      makeHangingResponse([delta]),
      fake.config,
      "req-def-456",
      inc.config,
    );

    await (await app.request("/sse")).text();

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(typeof rec.ttfbMs).toBe("number");
    expect(rec.phase).toBe("mid_stream");
    // Counted UNCONDITIONALLY — `bytesActuallyReceived` is trace-gated and
    // would be 0 here, which is exactly the blind spot this field replaces.
    expect(rec.bytesReceived).toBe(delta.byteLength);
    expect(rec.elapsedMs).toBeGreaterThanOrEqual(rec.ttfbMs!);
  });

  it("clean success → NO record (the file is bounded by the failure rate, not by traffic)", async () => {
    const inc = collectIncidents();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        controller.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
        controller.close();
      },
    });
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(
          c,
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
          {
            route: "/v1/messages",
            model: "claude-test",
            metricRoute: "messages",
            requestId: "req-ok",
            incident: inc.config,
          },
        ),
      ),
    );

    await (await app.request("/sse")).text();

    expect(inc.seen.length).toBe(0);
  });

  it("feature OFF (no incident config) → nothing recorded, stall path unaffected", async () => {
    const fake = makeFakeStall();
    const app = verbatimApp(makeHangingResponse([]), fake.config, "req-off");

    const text = await (await app.request("/sse")).text();

    // The stall detector still fires; only the incident record is absent.
    expect(text).toContain("event: error");
    expect(fake.logged.length).toBe(1);
  });
});

/**
 * D96 Phase 1 — the histograms, exercised through the forwarder.
 *
 * The load-bearing property is that they cover SUCCESSFUL streams, which is
 * precisely where the incident log is silent. A threshold is set from the
 * healthy population's distribution; recording only failures would leave the
 * ladder exactly as unmeasured as it is today.
 */
describe("D96 histograms — verbatim forwardStream", () => {
  function okStream(requestBytes?: number): Hono {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        controller.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
        controller.close();
      },
    });
    const app = new Hono();
    app.get("/sse", (c) =>
      streamSSE(
        c,
        forwardStream(
          c,
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
          {
            route: "/v1/messages",
            model: "claude-test",
            metricRoute: "messages",
            requestId: "req-hist",
            requestBytes,
          },
        ),
      ),
    );
    return app;
  }

  it("observes ttfb + max-silence on a SUCCESSFUL stream — where the incident log is silent", async () => {
    await (await okStream().request("/sse")).text();

    const labels = { route: "messages", model: "claude-test" };
    expect(
      getValueForTests(
        "copilot_proxy_upstream_first_byte_seconds_count",
        labels,
      ),
    ).toBe(1);
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBe(1);
    // A local stream is fast, so both land in the smallest bucket — which is
    // also the check that the value is a duration in SECONDS, not milliseconds.
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(1);
    // Seconds, not milliseconds, on the silence family too: 0.5 s is its
    // SMALLEST boundary, so a millisecond value would miss every bucket and
    // land only in `+Inf`.
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_bucket", {
        ...labels,
        le: "0.5",
      }),
    ).toBe(1);
    // This stream ANSWERED, so it is not part of the excluded population.
    // Catches an unconditional `incCounter` — i.e. the first-byte branch being
    // dropped in favour of always ticking the counter.
    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", labels),
    ).toBeUndefined();
  });

  it("observes request_bytes only when the handler threaded a size", async () => {
    await (await okStream(812_004).request("/sse")).text();
    expect(
      getValueForTests("copilot_proxy_request_bytes_count", {
        route: "messages",
      }),
    ).toBe(1);
    // 812,004 is > 500k and <= 1M. The lower bucket is PRESENT AT ZERO, not
    // absent — every registered boundary is emitted once a series exists, so
    // histogram_quantile interpolates over the real range.
    expect(
      getValueForTests("copilot_proxy_request_bytes_bucket", {
        route: "messages",
        le: "500000",
      }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_request_bytes_bucket", {
        route: "messages",
        le: "1000000",
      }),
    ).toBe(1);

    resetForTests();
    await (await okStream().request("/sse")).text();
    expect(
      getValueForTests("copilot_proxy_request_bytes_count", {
        route: "messages",
      }),
    ).toBeUndefined();
  });

  it("a stalled stream that DID answer is still a max-silence sample", async () => {
    const fake = makeFakeStall();
    await runVerbatim(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "req-stalled",
    });

    const labels = { route: "messages", model: "claude-test" };
    // A stall AFTER the first byte is a sample of the gap distribution, not an
    // exclusion from it — the gap is exactly what the metric exists to size.
    //
    // NOTE (deliberate correction). The comment this replaces read "a stall is
    // a sample of the distribution, not an exclusion from it", full stop. That
    // is no longer true of every stall: a stall BEFORE the first byte is now
    // excluded (see the population tests below), because its only available
    // number is the whole stream duration, which is not an inter-byte gap. The
    // ASSERTION was and remains correct for this case; the sentence justifying
    // it had generalized past what the code does.
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBe(1);
    // ... and it is NOT in the never-answered population.
    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", labels),
    ).toBeUndefined();
  });
});

/**
 * D96 Phase 1 — the same incident-record properties, through the TRANSLATED
 * forwarder.
 *
 * D47 requires a guard applied to one forwarder to be mirrored in its sibling
 * in the same change. The previous revision of this file asserted the incident
 * record on `forwardStream` only, so the translated lane's identical
 * `noteUpstreamBytes` block was unguarded: deleting it left every test green.
 * These are the mirrors. Each one fails with that call removed — `ttfbMs`
 * becomes absent and `bytesReceived` becomes 0.
 */
describe("D96 incident log — translated forwardStreamTranslated", () => {
  it("pre-content stall → ttfbMs ABSENT, phase pre_content, joinable by requestId", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "tx-abc-123",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.ttfbMs).toBeUndefined();
    expect(rec.phase).toBe("pre_content");
    expect(rec.bytesReceived).toBe(0);
    expect(rec.outcome).toBe("upstream_stall");
    expect(rec.status).toBe(504);
    expect(rec.requestId).toBe("tx-abc-123");
    expect(rec.route).toBe("messages");
    expect(rec.protocol).toBe("anthropic");
    expect(rec.model).toBe("claude-test");
  });

  it("content then stall → ttfbMs PRESENT and RAW upstream bytes counted, phase mid_stream", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    await runTranslated(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "tx-def-456",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    // MUTATION ARMED: delete `noteUpstreamBytes(value.byteLength)` from the
    // translated read loop and both of these fail (undefined, and 0).
    expect(typeof rec.ttfbMs).toBe("number");
    expect(rec.phase).toBe("mid_stream");
    // The RAW upstream chunk length, counted before decode/translate, so the
    // field means the same thing on both lanes. A translated-output byte count
    // would differ from this number.
    expect(rec.bytesReceived).toBe(TEXT_DELTA.byteLength);
    expect(rec.elapsedMs).toBeGreaterThanOrEqual(rec.ttfbMs!);
  });

  it("clean success → NO record on this lane either", async () => {
    const inc = collectIncidents();
    await runTranslated(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "tx-ok",
      incident: inc.config,
    });
    expect(inc.seen.length).toBe(0);
  });
});

/**
 * D96 Phase 1 — the histograms through the TRANSLATED forwarder. Mirrors of the
 * verbatim block above; same D47 argument.
 */
describe("D96 histograms — translated forwardStreamTranslated", () => {
  it("observes ttfb + max-silence on a SUCCESSFUL translated stream", async () => {
    await runTranslated(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "tx-hist",
    });

    const labels = { route: "messages", model: "claude-test" };
    // MUTATION ARMED: delete the translated lane's `noteUpstreamBytes` call and
    // `firstByteMs` stays undefined — both counts vanish and the never-answered
    // counter appears instead. All three of these flip.
    expect(
      getValueForTests(
        "copilot_proxy_upstream_first_byte_seconds_count",
        labels,
      ),
    ).toBe(1);
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", labels),
    ).toBeUndefined();
    // Seconds, not milliseconds.
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_bucket", {
        ...labels,
        le: "0.5",
      }),
    ).toBe(1);
  });

  it("observes request_bytes when the handler threaded a size", async () => {
    await runTranslated(makeClosingResponse([MESSAGE_STOP]), {
      requestId: "tx-bytes",
      requestBytes: 812_004,
    });
    expect(
      getValueForTests("copilot_proxy_request_bytes_count", {
        route: "messages",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_request_bytes_bucket", {
        route: "messages",
        le: "500000",
      }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_request_bytes_bucket", {
        route: "messages",
        le: "1000000",
      }),
    ).toBe(1);
  });
});

/**
 * F159 — the dispatch-anchored histogram measures from the HANDLER-SUPPLIED
 * origin, not from stream start.
 *
 * The defect being pinned is that `copilot_proxy_ttfb_seconds` started its
 * clock INSIDE the stream callback, i.e. after the upstream response headers
 * were already in, so it excluded the dominant latency term while carrying a
 * name that invited an end-to-end reading. The renamed post-header series and
 * the new end-to-end one now coexist, and the only thing that distinguishes
 * them is the origin — so every case here asserts BOTH families at once. A
 * single-family assertion could not tell the two origins apart, which is
 * exactly how the original defect stayed green.
 *
 * The anchor is back-dated 5 s while the fixture stream completes in well under
 * a millisecond, so the two land in different buckets by a wide margin rather
 * than by scheduler luck.
 */
describe("F159 dispatch anchor — end-to-end origin, on both lanes", () => {
  const labels = { route: "messages", model: "claude-test" };
  const BACK_DATED_MS = 5_000;

  function assertOriginsDistinct(): void {
    // Post-header clock: a local stream answers instantly, so the SMALLEST
    // boundary holds it. Unchanged from the pre-rename behaviour.
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(1);
    // End-to-end clock: back-dated 5 s, so it must MISS that boundary...
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(0);
    // ...and land at 10 s. Computing this sample from `ctx.startedMs` — i.e.
    // republishing the post-header origin under the end-to-end name, which is
    // F159 itself — flips both of these, as does swapping the two names.
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_bucket", {
        ...labels,
        le: "10",
      }),
    ).toBe(1);
    expect(
      getValueForTests(
        "copilot_proxy_dispatch_first_byte_seconds_count",
        labels,
      ),
    ).toBe(1);
    // The anchor was usable, so the defect counter must NOT have ticked.
    expect(
      getValueForTests("copilot_proxy_dispatch_anchor_missing_total", {
        route: "messages",
      }),
    ).toBeUndefined();
  }

  it("verbatim: the sample is measured from dispatchStartedMs", async () => {
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "anchor-verbatim",
      dispatchStartedMs: performance.now() - BACK_DATED_MS,
    });
    assertOriginsDistinct();
  });

  it("translated: same — D47 mirror", async () => {
    // Byte-identical assertions through the other forwarder. The anchor is
    // routed via `ctxBase` and read in `observeStreamHistograms`, so a variant
    // that added a lane-local observation instead — or threaded the value
    // through `IncidentContext` and updated one `recordStreamCompletion` call
    // site — fails here and passes above.
    await runTranslated(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "anchor-translated",
      dispatchStartedMs: performance.now() - BACK_DATED_MS,
    });
    assertOriginsDistinct();
  });

  it("an ABSENT anchor yields NO sample and NO manufactured one", async () => {
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "anchor-absent",
    });
    // Not 0, not 1 — the series must not exist at all. Falling back to
    // `ctx.startedMs` would publish a post-header value under the end-to-end
    // name, i.e. reintroduce F159 where nothing could later tell them apart.
    expect(
      getValueForTests(
        "copilot_proxy_dispatch_first_byte_seconds_count",
        labels,
      ),
    ).toBeUndefined();
    // The post-header series is unaffected: this IS an answering stream.
    expect(
      getValueForTests(
        "copilot_proxy_upstream_first_byte_seconds_count",
        labels,
      ),
    ).toBe(1);
    // And the loss is VISIBLE. That is the whole point of the counter —
    // `observeHistogram` drops a bad sample in silence.
    expect(
      getValueForTests("copilot_proxy_dispatch_anchor_missing_total", {
        route: "messages",
      }),
    ).toBe(1);
  });

  it("an INVERTED anchor (later than the first byte) takes the same path", async () => {
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "anchor-inverted",
      dispatchStartedMs: performance.now() + 60_000,
    });
    // Removing the explicit `anchor > ctx.firstByteMs` guard and leaning on
    // `observeHistogram`'s silent negative-value drop keeps THIS assertion
    // green...
    expect(
      getValueForTests(
        "copilot_proxy_dispatch_first_byte_seconds_count",
        labels,
      ),
    ).toBeUndefined();
    // ...and fails THIS one, which is the point: invisible censoring becomes a
    // visible defect signal.
    expect(
      getValueForTests("copilot_proxy_dispatch_anchor_missing_total", {
        route: "messages",
      }),
    ).toBe(1);
  });
});

/**
 * D96 Phase 1 — max silence is a VALUE, not just a count.
 *
 * The assertions the remediation replaced tested
 * `..._max_silence_seconds_count` and nothing else, so an implementation that
 * observed a constant `0` for every stream passed them — the test could not
 * fail on the defect it existed to guard. These bound the recorded sample from
 * both sides using a real wall-clock gap:
 *
 *   - below `GAP_MS` (minus scheduler slack) → a constant-zero implementation,
 *     or one that recorded upstream first-byte by mistake, fails;
 *   - above, well under the 0.5 s smallest boundary → a milliseconds-not-seconds
 *     implementation fails (it would record ~60, not ~0.06).
 *
 * `_sum` rather than bucket placement is what carries the lower bound: the
 * silence histogram's smallest boundary is 0.5 s, so no registered bucket can
 * separate 0.06 s from 0 s. Bucket placement carries the upper bound.
 *
 * THE FIRST BYTE IS DELAYED, and that is what separates the three quantities an
 * assertion here could otherwise confuse. The previous revision queued the first
 * chunk immediately, so upstream first-byte was ~0 and total duration ~= the gap; an
 * implementation that measured start-to-completion instead of the inter-byte
 * gap therefore produced ~the same number, and the mutation this block NAMED
 * ("max silence sourced from `startedMs`") passed. Caught by the round-2
 * cross-family gate. With the first byte held back `FIRST_BYTE_MS`, the three
 * separate cleanly:
 *
 *     first byte     ~= FIRST_BYTE_MS              (~0.12 s)
 *     inter-byte gap ~= GAP_MS                     (~0.06 s)
 *     duration       ~= FIRST_BYTE_MS + GAP_MS     (~0.18 s)
 *
 * so max silence must land near GAP_MS and BELOW upstream first-byte. The `startedMs` mutation
 * yields ~0.18 s, which breaks the upper bound AND inverts the ordering — two
 * independent assertions, both armed.
 */
describe("D96 max-silence — value-sensitive on both lanes", () => {
  const GAP_MS = 60;
  const FIRST_BYTE_MS = 120;
  const labels = { route: "messages", model: "claude-test" };

  function assertGapRecorded(): void {
    const sum = getValueForTests(
      "copilot_proxy_stream_max_silence_seconds_sum",
      labels,
    );
    expect(typeof sum).toBe("number");
    // Lower bound with slack for coarse timer granularity on Windows (~15 ms).
    // ARMED: a constant-zero implementation fails here.
    expect(sum!).toBeGreaterThan(GAP_MS / 1000 - 0.02);
    // ARMED, and this is the `startedMs` arm: total duration is
    // ~(FIRST_BYTE_MS + GAP_MS) = ~0.18 s, so an implementation measuring
    // start-to-completion overshoots this ceiling. The old bound was 0.5 s,
    // which 0.18 s passed — which is why the named mutation went uncaught.
    expect(sum!).toBeLessThan((FIRST_BYTE_MS + GAP_MS) / 1000 - 0.02);
    // Still a milliseconds-not-seconds check: ~60 would blow past every bucket.
    expect(sum!).toBeLessThan(0.5);
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_bucket", {
        ...labels,
        le: "0.5",
      }),
    ).toBe(1);
    // The gap is SILENCE, not latency, and here the first byte is deliberately
    // the SLOWER of the two. ARMED independently of the ceiling above: sourcing
    // max silence from `startedMs` makes it exceed upstream first-byte and inverts this.
    const ttfbSum = getValueForTests(
      "copilot_proxy_upstream_first_byte_seconds_sum",
      labels,
    );
    expect(typeof ttfbSum).toBe("number");
    expect(ttfbSum!).toBeGreaterThan(FIRST_BYTE_MS / 1000 - 0.02);
    expect(sum!).toBeLessThan(ttfbSum!);
  }

  it("verbatim: a real inter-byte gap lands in the histogram as SECONDS", async () => {
    await runVerbatim(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      { requestId: "gap-verbatim" },
    );
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBe(1);
    assertGapRecorded();
  });

  it("translated: the same gap, same value — D47 mirror", async () => {
    await runTranslated(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      { requestId: "gap-translated" },
    );
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBe(1);
    assertGapRecorded();
  });
});

/**
 * D96 Phase 1 — the POPULATIONS. This is the behaviour the remediation changed,
 * and it is a change no count-only assertion can see.
 *
 * `copilot_proxy_stream_max_silence_seconds` is now observed only for streams
 * that produced a first byte, because a stream that never spoke has no
 * inter-byte gap to contribute — its only available number is its whole
 * duration, and pooling that with real gaps corrupts the inter-byte triage
 * distribution outright (90 healthy streams with 1 s gaps plus 10 pre-content
 * stalls ending at 600 s put p95 in the 600 s bucket while no healthy gap ever
 * exceeded 1 s). ⚠ This says nothing about detector tuning: deriving a stall
 * window from this metric is prohibited outright — see `observeStreamHistograms`
 * for the measured span divergences. An earlier revision of this sentence said
 * the pooling "drags the percentile the stall windows are tuned against", which
 * asserts exactly the withdrawn relationship; it was the EIGHTH surviving copy
 * of that claim and the round-5 gate found it here because the round-4 sweep
 * covered `src/` and `docs/` but never `tests/`. The excluded streams are kept
 * visible by `copilot_proxy_stream_no_first_byte_total` instead, so
 * `ttfb_count + no_first_byte_total` is the true stream total.
 *
 * MUTATION ARMED, twice over:
 *   - remove the first-byte gate (observe max silence unconditionally, the
 *     pre-remediation shape) → the "contributes NOTHING" assertions fail on
 *     both lanes;
 *   - remove the `incCounter` → the "exactly once" assertions fail on both.
 */
describe("D96 populations — a stream that never produced a byte", () => {
  const labels = { route: "messages", model: "claude-test" };

  function assertNeverAnswered(): void {
    // Counted exactly once. `toBe(1)` fails at `undefined` if the increment is
    // removed, and at 2+ if it were ever moved inside a loop.
    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", labels),
    ).toBe(1);
    // No upstream first-byte sample: there is no first byte to measure to.
    expect(
      getValueForTests(
        "copilot_proxy_upstream_first_byte_seconds_count",
        labels,
      ),
    ).toBeUndefined();
    // Contributes NOTHING to max silence — not a zero sample, not a
    // whole-duration sample, no bucket row at all. `_count` alone would not
    // catch a zero-valued observation; `_sum` and the bucket row would still
    // exist. All three are asserted absent.
    expect(
      getValueForTests(
        "copilot_proxy_stream_max_silence_seconds_count",
        labels,
      ),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_sum", labels),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_bucket", {
        ...labels,
        le: "0.5",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_bucket", {
        ...labels,
        le: "+Inf",
      }),
    ).toBeUndefined();
  }

  it("verbatim: pre-content stall contributes to the counter, not the gap histogram", async () => {
    const fake = makeFakeStall();
    const text = await runVerbatim(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "silent-verbatim",
    });
    // Sanity: this really is the pre-content stall path, not some other exit.
    expect(text).toContain("upstream stall");
    assertNeverAnswered();
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const text = await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "silent-translated",
    });
    expect(text).toContain("upstream stall");
    assertNeverAnswered();
  });

  it("verbatim: an upstream that closes with ZERO bytes is the same population", async () => {
    // No stall detector involved: the exclusion is a property of "never
    // produced a byte", not of the stall path. A successful-but-empty upstream
    // must be counted and must contribute no gap sample.
    await runVerbatim(makeClosingResponse([]), { requestId: "empty-verbatim" });
    assertNeverAnswered();
    // ...and it completed successfully, so this is not the stall path wearing
    // a different name.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
  });

  it("translated: an upstream that closes with ZERO bytes — D47 mirror", async () => {
    await runTranslated(makeClosingResponse([]), {
      requestId: "empty-translated",
    });
    assertNeverAnswered();
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
  });
});

/**
 * D96 Phase 1 — the `model` label is routed through the bounded distinct-value
 * helper, so a novel model past the ceiling lands on `"other"`.
 *
 * The unit behaviour of `boundedLabelValue` is covered in
 * `tests/lib/metrics.test.ts`. What is covered HERE, and nowhere else, is that
 * the forwarders actually call it — the defect it guards is a request-path
 * label, so a helper that works while the call site bypasses it protects
 * nothing.
 *
 * MUTATION ARMED: revert `labels.model = boundedLabelValue("model", model)` to
 * `labels.model = model` and every `model: "other"` lookup below returns
 * `undefined`.
 *
 * The ceiling is pre-loaded by calling the helper directly 64 times rather than
 * by driving 64 streams: the default limit IS the shipped bound, and admission
 * is process-wide per key, so warming it this way exercises the real ceiling
 * without 64 HTTP round-trips. `beforeEach`'s `resetForTests()` clears the
 * admitted set, so no other test in this file inherits a filled ceiling.
 */
describe("D96 label cardinality — model past the ceiling collapses to 'other'", () => {
  const DEFAULT_LIMIT = 64;
  const NOVEL = "novel-model-past-the-ceiling";

  function fillCeiling(): void {
    for (let i = 0; i < DEFAULT_LIMIT; i++) {
      // Sanity: these are all admitted verbatim, so the ceiling is genuinely
      // reached by this loop rather than by an early collapse.
      expect(boundedLabelValue("model", `warm-${i}`)).toBe(`warm-${i}`);
    }
  }

  it("verbatim: histogram label collapses, and the raw value is NOT emitted", async () => {
    fillCeiling();
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      model: NOVEL,
      requestId: "bounded-verbatim",
      dispatchStartedMs: performance.now(),
    });

    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBe(1);
    // The clamp is applied to the shared label object, so the silence family
    // must collapse identically — one stream cannot land under two spellings.
    expect(
      getValueForTests("copilot_proxy_stream_max_silence_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBe(1);
    // F159 — and so must the dispatch-anchored family, which is observed from a
    // second call site. Building it a fresh labels object instead of reusing
    // the one `observeStreamHistograms` already clamped would emit the raw
    // client-supplied model here and consume a second admission.
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBe(1);
    // The unbounded series does not exist. This is the assertion that fails if
    // the call site stops routing through the helper.
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: NOVEL,
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_count", {
        route: "messages",
        model: NOVEL,
      }),
    ).toBeUndefined();
  });

  it("translated: same clamp — D47 mirror", async () => {
    fillCeiling();
    await runTranslated(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      model: NOVEL,
      requestId: "bounded-translated",
      dispatchStartedMs: performance.now(),
    });

    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: NOVEL,
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_dispatch_first_byte_seconds_count", {
        route: "messages",
        model: NOVEL,
      }),
    ).toBeUndefined();
  });

  it("the never-answered COUNTER is clamped too, on both lanes", async () => {
    // The counter carries the same `model` label as the histograms and is
    // written from the same `labels` object. Catches a partial fix that
    // clamped only the histogram families.
    fillCeiling();
    await runVerbatim(makeClosingResponse([]), {
      model: NOVEL,
      requestId: "bounded-silent-verbatim",
    });
    await runTranslated(makeClosingResponse([]), {
      model: NOVEL,
      requestId: "bounded-silent-translated",
    });

    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", {
        route: "messages",
        model: "other",
      }),
    ).toBe(2);
    expect(
      getValueForTests("copilot_proxy_stream_no_first_byte_total", {
        route: "messages",
        model: NOVEL,
      }),
    ).toBeUndefined();
  });

  it("a model UNDER the ceiling is still emitted verbatim", async () => {
    // The complement, and the reason the bound is a ceiling rather than a hash:
    // real deployments run a handful of models and every one of them must stay
    // attributable. Catches a "fix" that collapses everything to "other".
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      model: "claude-sonnet-4.5",
      requestId: "bounded-under",
    });
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: "claude-sonnet-4.5",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_count", {
        route: "messages",
        model: "other",
      }),
    ).toBeUndefined();
  });
});
/**
 * D96 Phase 1 — post-terminal idle IS folded into max silence, and the stall
 * detector cannot see it. This pins the corrected semantics.
 *
 * The round-3 cross-family gate refuted the claim that this metric and the
 * stall detector observe the same span. This case pins ONE of the measured
 * divergences — there are four so far and the list is not known to be complete
 * (see `observeStreamHistograms`); an earlier revision of this line said "one
 * of its two", which is the completeness framing every round has falsified. The
 * one pinned here: the read loop arms the detector only while `!sawTerminal`
 * (see the `!sawTerminal` guard in the verbatim read loop — arming it after the
 * response is complete would fire a spurious 504 on a hung-but-complete
 * upstream), while the final-gap fold in `observeStreamHistograms` has no such
 * gate. So an upstream that emits its terminal event, idles, and only then
 * closes contributes that idle to the metric against a ZERO-LENGTH detector
 * window.
 *
 * This test exists so the corrected documentation is MEASURED rather than
 * asserted — the previous revision of that documentation claimed the opposite
 * and nothing in the suite contradicted it. It deliberately pins CURRENT
 * behaviour: if a future change excludes post-terminal idle, this fails, and
 * that is the intended signal to re-read the runbook section rather than to
 * "fix" the test.
 *
 * ⚠ **The first revision of this block ran WITHOUT a `StallConfig`, and its
 * status-200 assertion was therefore vacuous — caught by the round-4 gate and
 * PROVEN by running the mutation: deleting `!sawTerminal` from BOTH read-loop
 * gates left both tests green at the identical 8 `expect()` calls.** With no
 * config there is no detector to arm, so a 200 proved only that an absent
 * detector did not fire — not that post-terminal idle sits outside the detector
 * span, which is the whole claim. Each case now attaches its own fake detector,
 * whose timer resolves on a `setTimeout(0)` macrotask and therefore WINS
 * against a silent upstream: armed across the idle it fires, so the mutation
 * now turns each case red. The stall log is asserted empty alongside the 200,
 * because a 504 is not the only way the guard can fail.
 *
 * **Re-measured after the fix, stating the mechanism actually observed rather
 * than the one predicted:** removing `!sawTerminal` arms the detector across the
 * idle, it fires, and the stall path cancels the reader and completes the stream
 * EARLY — so the final gap never accumulates and the `sum` assertion is the one
 * that trips first (`Expected: > 0.07, Received: 0.0079`), before the 200 or the
 * stall-log assertion is ever reached. All three would fail; `sum` is simply
 * evaluated first. Measured: **2 pass / 0 fail before this fix, 0 pass / 2 fail
 * after it**, same mutation both times. The prediction that the 200 assertion
 * would be the detector was wrong, and is corrected here rather than left to
 * read as verified (D75 — docblock claims about one's own work are unreliable).
 *
 * The guard itself was never unprotected — `fix#1 — terminal then close: no
 * post-terminal stall re-arm` on both lanes does catch that mutation. What was
 * false was this block's claim to measure it.
 */
describe("D96 max-silence — post-terminal idle is included (NOT a detector span)", () => {
  const IDLE_MS = 90;
  const labels = { route: "messages", model: "claude-test" };

  function assertIdleFolded(fake: ReturnType<typeof makeFakeStall>): void {
    const sum = getValueForTests(
      "copilot_proxy_stream_max_silence_seconds_sum",
      labels,
    );
    expect(typeof sum).toBe("number");
    // ARMED: drop the final-gap fold (observe only inter-chunk gaps) and this
    // collapses toward zero, since every chunk here is enqueued in one tick.
    expect(sum!).toBeGreaterThan(IDLE_MS / 1000 - 0.02);
    // Bounded above so the assertion cannot pass on an unrelated large value.
    expect(sum!).toBeLessThan(0.5);
    // ARMED, and only because a detector is actually configured above: the
    // stream SUCCEEDED across an idle a live detector would have tripped, which
    // is what shows the detector had no armed window over the interval the
    // metric just counted. Remove `!sawTerminal` and the whole block goes red —
    // though `sum` above trips first, since the stall cancels the reader and the
    // fold never accumulates. See the docblock for the measured numbers.
    expect(
      getValueForTests("copilot_proxy_requests_total", {
        route: "messages",
        status: "200",
      }),
    ).toBe(1);
    expect(fake.logged).toEqual([]);
  }

  it("verbatim: idle between the terminal event and close lands in max silence", async () => {
    const fake = makeFakeStall();
    await runVerbatim(
      makeIdleBeforeCloseResponse([TEXT_DELTA, MESSAGE_STOP], IDLE_MS),
      { requestId: "idle-verbatim", stall: fake.config },
    );
    assertIdleFolded(fake);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    await runTranslated(
      makeIdleBeforeCloseResponse([TEXT_DELTA, MESSAGE_STOP], IDLE_MS),
      { requestId: "idle-translated", stall: fake.config },
    );
    assertIdleFolded(fake);
  });
});

/**
 * D96 Phase 1 — `requestBytesOf` header parsing.
 *
 * Added at the round-5 gate. Before it, this function had ZERO tests despite
 * being called by all three handlers, and its docblock guaranteed
 * "absent, malformed or negative → undefined" while `Number.parseInt` alone
 * accepted a numeric PREFIX: `812004junk` was recorded as `812004` and `1e6`
 * as `1`. Conforming traffic cannot produce either — an HTTP parser rejects
 * such a `content-length` before we see it — so this pins a documentation
 * guarantee rather than a reachable defect.
 *
 * MUTATION ARMED: drop the `/^\d+$/` test from `requestBytesOf` and the two
 * numeric-prefix cases below flip from `undefined` to `812004` / `1`.
 */
describe("D96 requestBytesOf — the whole header must be decimal digits", () => {
  async function bytesFor(
    headers: Record<string, string>,
  ): Promise<number | undefined> {
    let seen: number | undefined;
    const app = new Hono();
    app.post("/x", (c) => {
      seen = requestBytesOf(c);
      return c.text("ok");
    });
    await app.request("/x", { method: "POST", headers, body: "hi" });
    return seen;
  }

  it("accepts a well-formed content-length", async () => {
    expect(await bytesFor({ "content-length": "812004" })).toBe(812_004);
  });

  it("rejects a numeric PREFIX rather than truncating to it", async () => {
    // parseInt("812004junk", 10) === 812004 — the defect this guard closes.
    expect(await bytesFor({ "content-length": "812004junk" })).toBeUndefined();
    // parseInt("1e6", 10) === 1 — silently three orders of magnitude wrong.
    expect(await bytesFor({ "content-length": "1e6" })).toBeUndefined();
  });

  it("rejects negative and non-numeric values", async () => {
    expect(await bytesFor({ "content-length": "-5" })).toBeUndefined();
    expect(await bytesFor({ "content-length": "abc" })).toBeUndefined();
  });

  it("omits the field entirely when the header is absent", async () => {
    expect(await bytesFor({})).toBeUndefined();
  });
});

/**
 * Slice (b) — `copilot_proxy_detector_max_wait_seconds` is PER PHASE, and the
 * per-phase split is the entire point.
 *
 * M1 shipped the accumulator as a single scalar. Consuming it unchanged would
 * publish ONE number per stream mixing the pre-content and post-content budgets
 * — `max_silence` divergence #3 reproduced inside the instrument built to
 * replace it — and an un-labelled series can size NEITHER window.
 *
 * The fixture makes the two phases measurably DIFFERENT lengths, in a known
 * ORDER, so the assertions cannot be satisfied by an implementation that files
 * every wait under one label:
 *
 *     read 1  no_response  ~FIRST_BYTE_MS (120 ms) — waiting for the first delta
 *     read 2  response     ~GAP_MS        (60 ms)  — waiting for the terminal
 *     read 3  (not armed: sawTerminal)
 *
 * `makeNeverFiringStall` keeps the detector fully live while guaranteeing the
 * stall arm never wins, so these are genuine detector-active waits on a stream
 * that completes normally.
 *
 * MUTATION ARMED, four ways:
 *   - consume M1's scalar unchanged (no `phase` label) → both `phase`-keyed
 *     lookups return undefined;
 *   - file everything under one phase → the `_count` toBe(1) pair fails;
 *   - milliseconds instead of seconds → 120 and 60, past every bound;
 *   - a constant zero → the two lower bounds fail.
 */
describe("slice (b) detector_max_wait — per phase, value-sensitive on both lanes", () => {
  const GAP_MS = 60;
  const FIRST_BYTE_MS = 120;
  const labels = { route: "messages", model: "claude-test" };

  function waitSum(phase: string): number | undefined {
    return getValueForTests("copilot_proxy_detector_max_wait_seconds_sum", {
      ...labels,
      phase,
    });
  }
  function waitCount(phase: string): number | undefined {
    return getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
      ...labels,
      phase,
    });
  }

  function assertPerPhaseWaits(): void {
    const noResp = waitSum("no_response");
    const resp = waitSum("response");
    expect(typeof noResp).toBe("number");
    // Bounded from BOTH sides: below fails a constant-zero implementation,
    // above fails a milliseconds-not-seconds one.
    expect(noResp!).toBeGreaterThan(FIRST_BYTE_MS / 1000 - 0.02);
    expect(noResp!).toBeLessThan(0.2);
    expect(typeof resp).toBe("number");
    expect(resp!).toBeGreaterThan(GAP_MS / 1000 - 0.02);
    expect(resp!).toBeLessThan(0.1);
    // The ORDERING is the phase-split proof: one accumulator cannot produce two
    // different numbers, so this fails on any implementation that pools them.
    expect(noResp!).toBeGreaterThan(resp!);
    expect(waitCount("no_response")).toBe(1);
    expect(waitCount("response")).toBe(1);
    // A phase never entered contributes NOTHING — not a zero sample. A zero here
    // would drag the low end of the very quantile this series exists to fix.
    expect(waitCount("thinking")).toBeUndefined();
    expect(waitCount("unobservable")).toBeUndefined();
  }

  it("verbatim: the pre-content and post-content waits land under separate phases", async () => {
    await runVerbatim(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      { stall: makeNeverFiringStall(), requestId: "phase-verbatim" },
    );
    assertPerPhaseWaits();
  });

  it("translated: same split, same values — D47 mirror", async () => {
    await runTranslated(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      { stall: makeNeverFiringStall(), requestId: "phase-translated" },
    );
    assertPerPhaseWaits();
  });
});

/**
 * Slice (b) — a REJECTING `reader.read()` still records its wait.
 *
 * M1 wrapped the race in `try/finally` for exactly this, and named it a CRITICAL
 * remedy — but NOTHING read the accumulator, so no assertion could distinguish
 * the `finally` from a plain post-loop call. Slice (b) is the first change that
 * makes it testable, and this is the test.
 *
 * MUTATION ARMED: move `noteDetectorWait(...)` out of the `finally` to after the
 * `for(;;)` loop. The rejection propagates past it, no sample is ever recorded,
 * and `_count` reads `undefined` instead of 1. Without this test a later
 * "simplification" reverts a CRITICAL remedy in silence.
 */
describe("slice (b) detector_max_wait — a REJECTING read still records its wait", () => {
  const ERR_MS = 120;
  const labels = { route: "messages", model: "claude-test" };

  function assertRejectRecorded(): void {
    const sum = getValueForTests(
      "copilot_proxy_detector_max_wait_seconds_sum",
      { ...labels, phase: "no_response" },
    );
    expect(typeof sum).toBe("number");
    expect(sum!).toBeGreaterThan(ERR_MS / 1000 - 0.02);
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "no_response",
      }),
    ).toBe(1);
    // A rejecting read is NOT right-censored: it COMPLETED, with an error, after
    // a wait we actually observed. Only a stall-arm win censors.
    expect(
      getValueForTests("copilot_proxy_detector_wait_censored_total", {
        ...labels,
        phase: "no_response",
      }),
    ).toBeUndefined();
  }

  it("verbatim: an upstream RST mid-wait is a sample, not a lost one", async () => {
    const text = await runVerbatim(makeErroringResponse(ERR_MS), {
      stall: makeNeverFiringStall(),
      requestId: "reject-verbatim",
    });
    expect(text).toContain("event: error");
    assertRejectRecorded();
  });

  it("translated: same — D47 mirror", async () => {
    const text = await runTranslated(makeErroringResponse(ERR_MS), {
      stall: makeNeverFiringStall(),
      requestId: "reject-translated",
    });
    expect(text).toContain("event: error");
    assertRejectRecorded();
  });
});

/**
 * Slice (b) / must-fix #7 — a stall-arm win RIGHT-CENSORS the wait, so it is
 * COUNTED and never histogrammed.
 *
 * `stallTimer.arm(period)` is taken one statement before `waitStart`, so on a
 * stall the `finally` measures ≈the whole window while the read is orphaned and
 * its true wait is only known to be `>= period`. Recorded as if it were a
 * completed wait, an operator's p99 reads back the configured window on every
 * stalling route and calls it saturated demand — the distribution then says "the
 * window is exactly right" no matter what upstream is doing.
 *
 * The fixture stalls in the RESPONSE phase (content flows, then silence) while
 * the first read completes normally in the no_response phase, so one stream
 * carries one censored read AND one uncensored one — an implementation that
 * treats them alike fails whichever way it goes.
 *
 * MUTATION ARMED: drop the `censoredByStall` branch and call
 * `noteDetectorWait` unconditionally. `..._count{phase="response"}` becomes 1
 * (asserted undefined) and `..._censored_total{phase="response"}` becomes
 * undefined (asserted 1).
 */
describe("slice (b) detector_max_wait — the stall arm's wait is censored, not sampled", () => {
  const labels = { route: "messages", model: "claude-test" };

  function assertCensoredNotSampled(): void {
    expect(
      getValueForTests("copilot_proxy_detector_wait_censored_total", {
        ...labels,
        phase: "response",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "response",
      }),
    ).toBeUndefined();
    // The UNCENSORED read on the same stream is still a sample — this is what
    // makes the assertion above a statement about censoring rather than about
    // the histogram being broken.
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "no_response",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_detector_wait_censored_total", {
        ...labels,
        phase: "no_response",
      }),
    ).toBeUndefined();
  }

  it("verbatim: content then stall → the response-phase wait is counted, not sampled", async () => {
    const fake = makeFakeStall();
    const text = await runVerbatim(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "censored-verbatim",
    });
    expect(text).toContain("upstream stall");
    assertCensoredNotSampled();
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const text = await runTranslated(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "censored-translated",
    });
    expect(text).toContain("upstream stall");
    assertCensoredNotSampled();
  });
});

/**
 * Slice (b) remediation — a censored phase publishes NO sample AT ALL, not even
 * the max over the completed reads it also carried.
 *
 * The censoring is applied per READ; the histogram sample is per STREAM×PHASE.
 * The first revision suppressed only the censored read, so a phase holding an
 * uncensored read AND the censored one still published the uncensored max —
 * indistinguishable from a complete measurement, though the stream's true worst
 * wait in that phase is known to be `>= window`. The same stream ALSO ticked the
 * censored counter, so the documented `_count + censored_total` denominator
 * counted it twice while its trivially small sample stayed in the numerator,
 * dragging the quantile toward zero with exactly the stalling streams the window
 * is being sized against.
 *
 * The sibling test above deliberately puts the two reads in DIFFERENT phases and
 * therefore cannot see this; this one puts them in the SAME phase. Two content
 * deltas are queued, so read 2 COMPLETES in the response phase before read 3
 * stalls in it — `armedPeriods` is what proves that, and without it the
 * suppression assertions would be satisfied by a phase that was never entered.
 *
 * MUTATION ARMED: drop the `if (phase === ctx.censoredWaitPhase) continue;`
 * guard in `observeStreamHistograms`. `_count{phase="response"}` becomes 1
 * (asserted undefined) alongside `censored_total{phase="response"}` = 1, i.e.
 * the double count, on both lanes.
 */
describe("slice (b) detector_max_wait — a censored phase publishes nothing, even with a completed read in it", () => {
  const labels = { route: "messages", model: "claude-test" };

  function waitValue(suffix: string, phase: string): number | undefined {
    return getValueForTests(
      `copilot_proxy_detector_max_wait_seconds${suffix}`,
      {
        ...labels,
        phase,
      },
    );
  }
  function censoredCount(phase: string): number | undefined {
    return getValueForTests("copilot_proxy_detector_wait_censored_total", {
      ...labels,
      phase,
    });
  }

  function assertSamePhaseSuppressed(armedPeriods: number[]): void {
    // The response phase was entered TWICE — read 2 completed in it, read 3
    // stalled in it. Without this the absence assertions below are also
    // satisfied by a phase the stream never reached, which is a different claim.
    expect(armedPeriods).toEqual([1_140_000, 600_000, 600_000]);
    expect(censoredCount("response")).toBe(1);
    // ...and the completed read in that same phase contributes NOTHING. All
    // three rows are checked: `_count` alone would not catch an implementation
    // that suppressed the count while still writing `_sum` and the buckets.
    expect(waitValue("_count", "response")).toBeUndefined();
    expect(waitValue("_sum", "response")).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_bucket", {
        ...labels,
        phase: "response",
        le: "+Inf",
      }),
    ).toBeUndefined();
    // The UNCENSORED phase is untouched — this is what makes the block above a
    // statement about censoring rather than about the histogram being broken.
    expect(waitValue("_count", "no_response")).toBe(1);
    expect(censoredCount("no_response")).toBeUndefined();
  }

  it("verbatim: a completed and a censored read in ONE phase → counter only", async () => {
    const fake = makeFakeStall();
    const text = await runVerbatim(
      makeHangingResponse([TEXT_DELTA, TEXT_DELTA]),
      { stall: fake.config, requestId: "same-phase-verbatim" },
    );
    expect(text).toContain("upstream stall");
    assertSamePhaseSuppressed(fake.armedPeriods);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const text = await runTranslated(
      makeHangingResponse([TEXT_DELTA, TEXT_DELTA]),
      { stall: fake.config, requestId: "same-phase-translated" },
    );
    expect(text).toContain("upstream stall");
    assertSamePhaseSuppressed(fake.armedPeriods);
  });
});

/**
 * Absence of a `copilot_proxy_first_content_seconds` sample, asserted the way
 * `assertNeverAnswered` asserts it: `_count` ALONE would not catch a zero-valued
 * observation, because `_sum` and the bucket rows would still exist. All four
 * are checked.
 */
function assertNoFirstContentSample(
  labels: Record<string, string> = { route: "messages", model: "claude-test" },
): void {
  expect(
    getValueForTests("copilot_proxy_first_content_seconds_count", labels),
  ).toBeUndefined();
  expect(
    getValueForTests("copilot_proxy_first_content_seconds_sum", labels),
  ).toBeUndefined();
  expect(
    getValueForTests("copilot_proxy_first_content_seconds_bucket", {
      ...labels,
      le: "0.1",
    }),
  ).toBeUndefined();
  expect(
    getValueForTests("copilot_proxy_first_content_seconds_bucket", {
      ...labels,
      le: "+Inf",
    }),
  ).toBeUndefined();
}

/**
 * Slice (b) — `copilot_proxy_first_content_seconds` measures the CONTENT
 * boundary, not the first raw byte. This is the single mutation the whole series
 * exists to exclude.
 *
 * `message_start` is a raw chunk and is NOT content. The detector's phase flips
 * on `peek.contentStarted`, which needs a content DELTA — so an upstream that
 * greets immediately and then thinks for 300 s has upstream first-byte ≈ 0 while the detector
 * applies its generous no-response budget throughout. That gap is `max_silence`
 * divergence #3, and until this series existed nothing on the metric surface
 * could see it.
 *
 * The fixture makes the two quantities differ by an order of magnitude, and the
 * assertions bound BOTH and assert an ORDERING between them, so no single wrong
 * clock satisfies all of them.
 *
 * MUTATION ARMED: implement `first_content_seconds` from `ctx.firstByteMs`
 * instead of the peek-site stamp — i.e. alias the first-byte stamp. The sum collapses to ~0, so
 * the lower bound, the strict inequality and the `le="0.1"` bucket assertion all
 * go red at once.
 */
describe("slice (b) first_content_seconds — the CONTENT boundary, not the first byte", () => {
  const DELTA_MS = 120;
  const labels = { route: "messages", model: "claude-test" };

  function assertContentBoundary(): void {
    const fbSum = getValueForTests(
      "copilot_proxy_upstream_first_byte_seconds_sum",
      labels,
    );
    const fcSum = getValueForTests(
      "copilot_proxy_first_content_seconds_sum",
      labels,
    );
    // The raw first byte was immediate: `message_start` was queued before the
    // first read even ran.
    expect(typeof fbSum).toBe("number");
    expect(fbSum!).toBeLessThan(0.04);
    // Content was not.
    expect(typeof fcSum).toBe("number");
    expect(fcSum!).toBeGreaterThan(DELTA_MS / 1000 - 0.02);
    // ARMED independently of the two bounds: an aliased implementation makes
    // these equal, not merely small.
    expect(fcSum!).toBeGreaterThan(fbSum! + 0.08);
    // Bucket placement carries the same claim without depending on `_sum`
    // arithmetic. `observeHistogram` touches EVERY bucket, so a lower bucket a
    // sample missed reads 0 rather than undefined — which is why `toBe(0)` here
    // is a real assertion and not an absence check.
    expect(
      getValueForTests("copilot_proxy_first_content_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(0);
    expect(
      getValueForTests("copilot_proxy_upstream_first_byte_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(1);
    expect(
      getValueForTests("copilot_proxy_first_content_seconds_count", labels),
    ).toBe(1);
    // Content WAS observed, so the excluded-population counter must stay silent.
    expect(
      getValueForTests("copilot_proxy_stream_no_content_total", {
        ...labels,
        reason: "never_started",
      }),
    ).toBeUndefined();
  }

  it("verbatim: message_start then a delayed delta — the two clocks separate", async () => {
    await runVerbatim(makeGreetThenContentResponse(DELTA_MS), {
      stall: makeNeverFiringStall(),
      requestId: "content-verbatim",
    });
    assertContentBoundary();
  });

  it("translated: same — D47 mirror", async () => {
    await runTranslated(makeGreetThenContentResponse(DELTA_MS), {
      stall: makeNeverFiringStall(),
      requestId: "content-translated",
    });
    assertContentBoundary();
  });
});

/**
 * Slice (b) — `copilot_proxy_stream_no_content_total{reason}` is the population
 * `first_content_seconds` structurally excludes, and the three reasons are
 * genuinely distinct.
 *
 * `never_started` means the detector RAN, on a lane that CAN see content, and
 * none arrived. `detector_off` means nothing looked at all — and note that the
 * detector-off case below has content flowing freely: the counter is a statement
 * about what was OBSERVED, not about what the upstream sent.
 *
 * MUTATION ARMED, twice:
 *   - observe a zero-valued `first_content_seconds` for a stream that never had
 *     content (the censored-denominator defect, fifth recurrence) → the four
 *     absence assertions fail;
 *   - collapse the reason label to one value → the cross-checks that the OTHER
 *     reason is undefined fail on both cases.
 */
describe("slice (b) no_content_total — never_started vs detector_off", () => {
  const labels = { route: "messages", model: "claude-test" };

  function reasonCount(reason: string): number | undefined {
    return getValueForTests("copilot_proxy_stream_no_content_total", {
      ...labels,
      reason,
    });
  }

  function assertNeverStarted(): void {
    expect(reasonCount("never_started")).toBe(1);
    expect(reasonCount("detector_off")).toBeUndefined();
    assertNoFirstContentSample();
  }

  function assertDetectorOff(): void {
    expect(reasonCount("detector_off")).toBe(1);
    expect(reasonCount("never_started")).toBeUndefined();
    assertNoFirstContentSample();
    // A stream with no detector has no detector-active wait to report, and a 0
    // there would drag every quantile toward zero.
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "no_response",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "thinking",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "response",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
        ...labels,
        phase: "unobservable",
      }),
    ).toBeUndefined();
  }

  it("verbatim: a pre-content stall is never_started, with NO first_content sample", async () => {
    const fake = makeFakeStall();
    const text = await runVerbatim(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "nostart-verbatim",
    });
    expect(text).toContain("upstream stall");
    assertNeverStarted();
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const text = await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "nostart-translated",
    });
    expect(text).toContain("upstream stall");
    assertNeverStarted();
  });

  it("verbatim: content flowing with the detector OFF is detector_off, not never_started", async () => {
    await runVerbatim(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "off-verbatim",
    });
    assertDetectorOff();
  });

  it("translated: same — D47 mirror", async () => {
    await runTranslated(makeClosingResponse([TEXT_DELTA, MESSAGE_STOP]), {
      requestId: "off-translated",
    });
    assertDetectorOff();
  });
});

/**
 * Slice (b) — `reason="lane_unobservable"` and `phase="unobservable"` on the one
 * lane that is STRUCTURALLY blind, with content flowing the whole time.
 *
 * The translated × `openai_chat` lane cannot classify content at all, for two
 * independent reasons (`peekObservesContent`'s docblock has both). Without a
 * predicate saying so, its streams file as `never_started` and its waits under
 * `phase="no_response"` — a mislabel that is wrong 100 % of the time and that
 * nothing on that lane ever contradicts. The source comment that used to sit
 * there, "not exercised in practice", is precisely what would have kept it
 * invisible.
 *
 * The VERBATIM chat case is the contrast, and it is what makes this a test of
 * the LANE rather than of the protocol: same route, same bytes, same fixture —
 * and because `peekVerbatimLine` CAN match a chat `"content"` field, that lane
 * produces a real `first_content_seconds` sample and no `no_content` tick at
 * all.
 *
 * MUTATION ARMED, from both sides:
 *   - make `peekObservesContent` return `true` unconditionally → the translated
 *     reason flips to `never_started` and its waits move to
 *     `phase="no_response"`; three assertions go red;
 *   - make it return `false` unconditionally → the verbatim case loses its
 *     `first_content_seconds` sample and gains a `lane_unobservable` tick.
 */
describe("slice (b) lane_unobservable — the translated openai_chat lane, with content flowing", () => {
  const chatLabels = { route: "chat_completions", model: "claude-test" };

  function chatReason(reason: string): number | undefined {
    return getValueForTests("copilot_proxy_stream_no_content_total", {
      ...chatLabels,
      reason,
    });
  }
  function chatWaitCount(phase: string): number | undefined {
    return getValueForTests("copilot_proxy_detector_max_wait_seconds_count", {
      ...chatLabels,
      phase,
    });
  }

  it("translated: content flows, but the lane cannot see it — lane_unobservable + phase=unobservable", async () => {
    const text = await runTranslated(
      makeClosingResponse([CHAT_DELTA, CHAT_DONE]),
      {
        stall: makeNeverFiringStall(),
        metricRoute: "chat_completions",
        requestId: "chat-translated",
      },
    );
    // Sanity: real chat content really did reach the client. The counter below
    // is a claim about what was OBSERVED, and it is only interesting if the
    // stream genuinely carried content.
    expect(text).toContain('"content"');
    expect(chatReason("lane_unobservable")).toBe(1);
    expect(chatReason("never_started")).toBeUndefined();
    assertNoFirstContentSample(chatLabels);
    // Every detector wait on this stream is filed under the honest label, and
    // NONE under a phase that would read as evidence about content latency.
    expect(typeof chatWaitCount("unobservable")).toBe("number");
    expect(chatWaitCount("unobservable")!).toBeGreaterThanOrEqual(1);
    expect(chatWaitCount("no_response")).toBeUndefined();
    expect(chatWaitCount("response")).toBeUndefined();
    expect(chatWaitCount("thinking")).toBeUndefined();
  });

  it("verbatim: the SAME route and bytes ARE observable — the predicate is per-lane", async () => {
    await runVerbatim(makeClosingResponse([CHAT_DELTA, CHAT_DONE]), {
      stall: makeNeverFiringStall(),
      metricRoute: "chat_completions",
      requestId: "chat-verbatim",
    });
    expect(chatReason("lane_unobservable")).toBeUndefined();
    expect(chatReason("never_started")).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_first_content_seconds_count", chatLabels),
    ).toBe(1);
    expect(chatWaitCount("unobservable")).toBeUndefined();
    expect(typeof chatWaitCount("no_response")).toBe("number");
  });
});

/**
 * Slice (b) — post-terminal idle contributes NO detector-wait sample, so the new
 * series does not inherit `max_silence` divergence #2.
 *
 * The race is gated on `!sawTerminal` (W2 F#1: arming post-terminal would fire a
 * spurious 504 on a hung-but-complete upstream), while `max_silence`'s final-gap
 * fold has no such gate. This is the only test that positively demonstrates the
 * two series measure DIFFERENT spans on the SAME stream, in the documented
 * direction — rather than the new one being a rename of the old.
 *
 * MUTATION ARMED: remove the `!sawTerminal` gate (or race post-terminal reads
 * "for symmetry"). The 150 ms idle lands in the detector-wait histogram and both
 * `< 0.10` bounds fail while `max_silence` is unchanged.
 */
describe("slice (b) detector_max_wait — post-terminal idle is NOT a detector wait", () => {
  const IDLE_MS = 150;
  const labels = { route: "messages", model: "claude-test" };

  function assertIdleExcluded(): void {
    const noResp = getValueForTests(
      "copilot_proxy_detector_max_wait_seconds_sum",
      { ...labels, phase: "no_response" },
    );
    const resp = getValueForTests(
      "copilot_proxy_detector_max_wait_seconds_sum",
      { ...labels, phase: "response" },
    );
    // Both phases WERE entered — so these are real samples that simply do not
    // contain the idle, not absent ones.
    expect(typeof noResp).toBe("number");
    expect(noResp!).toBeLessThan(IDLE_MS / 1000 - 0.05);
    expect(typeof resp).toBe("number");
    expect(resp!).toBeLessThan(IDLE_MS / 1000 - 0.05);
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_sum", {
        ...labels,
        phase: "thinking",
      }),
    ).toBeUndefined();
    expect(
      getValueForTests("copilot_proxy_detector_max_wait_seconds_sum", {
        ...labels,
        phase: "unobservable",
      }),
    ).toBeUndefined();
    // ...while max_silence DOES contain it. The two series measurably disagree
    // on the same stream, which is the point.
    const silence = getValueForTests(
      "copilot_proxy_stream_max_silence_seconds_sum",
      labels,
    );
    expect(typeof silence).toBe("number");
    expect(silence!).toBeGreaterThan(IDLE_MS / 1000 - 0.03);
  }

  it("verbatim: idle between the terminal event and close is invisible to the detector", async () => {
    await runVerbatim(
      makeIdleBeforeCloseResponse([TEXT_DELTA, MESSAGE_STOP], IDLE_MS),
      { stall: makeNeverFiringStall(), requestId: "idle-verbatim" },
    );
    assertIdleExcluded();
  });

  it("translated: same — D47 mirror", async () => {
    await runTranslated(
      makeIdleBeforeCloseResponse([TEXT_DELTA, MESSAGE_STOP], IDLE_MS),
      { stall: makeNeverFiringStall(), requestId: "idle-translated" },
    );
    assertIdleExcluded();
  });
});

/**
 * Slice (b) — the thinking-pause case on the TRANSLATED lane. The verbatim twin
 * lives at the top of this file; the stall branch's `const phase` derivation is
 * duplicated per lane, so a one-lane assertion leaves the twin unpinned — which
 * is exactly the defect this file's runner pairing exists to catch.
 */
describe("slice (b) stall record phase — thinking, translated lane", () => {
  it("a thinking-block stall logs no_response, matching the budget in force", async () => {
    const fake = makeFakeStall();
    await runTranslated(makeHangingResponse([TEXT_DELTA, THINKING_START]), {
      stall: fake.config,
      requestId: "think-translated",
    });
    expect(fake.armedPeriods).toEqual([1_140_000, 600_000, 1_140_000]);
    expect(fake.logged.length).toBe(1);
    expect(fake.logged[0]!.waitedMs).toBe(1_140_000);
    expect(fake.logged[0]!.phase).toBe("no_response");
  });
});

/**
 * Slice (b) remediation — the RECORD half, which shipped with zero tests.
 *
 * `firstContentMs`, `maxDetectorWaitMs`, `maxDetectorWaitPhase` and
 * `phase: "unobservable"` were written by no assertion anywhere, so the whole
 * join block could be deleted and `bun test` stayed green. Worse, the join was
 * WRONG on the population the record exists for: the censored wait went only
 * into `censoredWaitPhase`, which `emitIncident` never read, so on a pre-content
 * stall — one armed read, censored — the map was empty and the 504's record
 * omitted the detector fields entirely, on exactly the stream the detector
 * killed. `censoredWaitPhase` / `censoredWaitMs` are the fix; these are the
 * assertions.
 *
 * MUTATION ARMED, four ways:
 *   - delete the `censoredWaitPhase`/`censoredWaitMs` block from `emitIncident`
 *     → the pre-content cases lose every detector field they have;
 *   - fold the censored wait into `maxDetectorWaitMs` instead of reporting it
 *     separately → the content-then-stall cases read `"response"` where they
 *     assert `"no_response"`, mixing a bound with a measurement;
 *   - stamp `firstContentMs` from `ctx.firstByteMs` (alias the first-byte stamp) → the ordering
 *     assertion and the `> 120` lower bound fail together;
 *   - delete `if (!contentObservable) return "unobservable";` from
 *     `incidentPhase` → the blind-lane record claims `pre_content`.
 */
describe("slice (b) incident record — the detector fields, and the censored wait", () => {
  it("verbatim: a pre-content stall records the CENSORED wait, not nothing", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const text = await runVerbatim(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "rec-nostart-verbatim",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.outcome).toBe("upstream_stall");
    // The one and only armed read was censored, so NO completed wait exists and
    // these are absent. That absence is NOT evidence the detector never armed —
    // which is precisely what the field's docblock used to claim.
    expect(rec.maxDetectorWaitMs).toBeUndefined();
    expect(rec.maxDetectorWaitPhase).toBeUndefined();
    // ...which is why the censored pair has to be there instead.
    expect(rec.censoredWaitPhase).toBe("no_response");
    expect(typeof rec.censoredWaitMs).toBe("number");
    expect(rec.censoredWaitMs!).toBeGreaterThanOrEqual(0);
    // No content was ever observed, so the content stamp is absent.
    expect(rec.firstContentMs).toBeUndefined();
    expect(rec.phase).toBe("pre_content");
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const text = await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      requestId: "rec-nostart-translated",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.outcome).toBe("upstream_stall");
    expect(rec.maxDetectorWaitMs).toBeUndefined();
    expect(rec.maxDetectorWaitPhase).toBeUndefined();
    expect(rec.censoredWaitPhase).toBe("no_response");
    expect(typeof rec.censoredWaitMs).toBe("number");
    expect(rec.censoredWaitMs!).toBeGreaterThanOrEqual(0);
    expect(rec.firstContentMs).toBeUndefined();
    expect(rec.phase).toBe("pre_content");
  });

  it("verbatim: content then stall — completed max and censored wait are DIFFERENT phases", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const text = await runVerbatim(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "rec-censored-verbatim",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    // The completed-wait join reports the read that COMPLETED, in its own phase.
    expect(rec.maxDetectorWaitPhase).toBe("no_response");
    expect(typeof rec.maxDetectorWaitMs).toBe("number");
    // The wait that actually ended the stream is reported separately, because
    // the two are not comparable: each phase carries its own window.
    expect(rec.censoredWaitPhase).toBe("response");
    expect(typeof rec.censoredWaitMs).toBe("number");
    expect(rec.phase).toBe("mid_stream");
    expect(typeof rec.firstContentMs).toBe("number");
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const text = await runTranslated(makeHangingResponse([TEXT_DELTA]), {
      stall: fake.config,
      requestId: "rec-censored-translated",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.maxDetectorWaitPhase).toBe("no_response");
    expect(typeof rec.maxDetectorWaitMs).toBe("number");
    expect(rec.censoredWaitPhase).toBe("response");
    expect(typeof rec.censoredWaitMs).toBe("number");
    expect(rec.phase).toBe("mid_stream");
    expect(typeof rec.firstContentMs).toBe("number");
  });

  it("verbatim: record firstContentMs is the CONTENT stamp, not an alias of ttfbMs", async () => {
    const inc = collectIncidents();
    await runVerbatim(makeGreetThenContentThenErrorResponse(200, 20), {
      stall: makeNeverFiringStall(),
      requestId: "rec-content-verbatim",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.outcome).toBe("upstream_error");
    // `message_start` was queued before the first read, so the RAW byte is
    // immediate...
    expect(typeof rec.ttfbMs).toBe("number");
    expect(rec.ttfbMs!).toBeLessThan(80);
    // ...and content is not. Bounded from below AND ordered against ttfbMs, so
    // no single wrong clock satisfies both.
    expect(typeof rec.firstContentMs).toBe("number");
    expect(rec.firstContentMs!).toBeGreaterThan(120);
    expect(rec.firstContentMs!).toBeGreaterThan(rec.ttfbMs! + 100);
    expect(rec.firstContentMs!).toBeLessThanOrEqual(rec.elapsedMs);
  });

  it("translated: same — D47 mirror", async () => {
    const inc = collectIncidents();
    await runTranslated(makeGreetThenContentThenErrorResponse(200, 20), {
      stall: makeNeverFiringStall(),
      requestId: "rec-content-translated",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.outcome).toBe("upstream_error");
    expect(typeof rec.ttfbMs).toBe("number");
    expect(rec.ttfbMs!).toBeLessThan(80);
    expect(typeof rec.firstContentMs).toBe("number");
    expect(rec.firstContentMs!).toBeGreaterThan(120);
    expect(rec.firstContentMs!).toBeGreaterThan(rec.ttfbMs! + 100);
    expect(rec.firstContentMs!).toBeLessThanOrEqual(rec.elapsedMs);
  });

  it("translated chat: the record's phase is `unobservable`, not a false pre_content", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    await runTranslated(makeHangingResponse([CHAT_DELTA]), {
      stall: fake.config,
      metricRoute: "chat_completions",
      requestId: "rec-chat-translated",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.route).toBe("chat_completions");
    expect(rec.protocol).toBe("openai_chat");
    // The lane's smart-peek CANNOT classify content, so `pre_content` would be a
    // false measurement rather than a missing one.
    expect(rec.phase).toBe("unobservable");
    expect(rec.firstContentMs).toBeUndefined();
    // The censored wait files under the same honest label.
    expect(rec.censoredWaitPhase).toBe("unobservable");
  });

  it("verbatim chat: the SAME route and bytes record mid_stream — `unobservable` is a LANE claim", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    await runVerbatim(makeHangingResponse([CHAT_DELTA]), {
      stall: fake.config,
      metricRoute: "chat_completions",
      requestId: "rec-chat-verbatim",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    expect(rec.phase).toBe("mid_stream");
    expect(typeof rec.firstContentMs).toBe("number");
    expect(rec.censoredWaitPhase).toBe("response");
  });
});

// ---------------------------------------------------------------------------
// Upstream message-start join-key regressions use public synthetic fixtures.
// The backend-style underscore after `vrtx` is intentional: an alphanumeric-
// only guard would reject a legitimate identifier shape. No real ID is needed.
// ---------------------------------------------------------------------------

const REPLAY_ROOT = resolve(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "stream-replay",
);

function fixtureBytes(lane: string): Uint8Array {
  return new Uint8Array(
    readFileSync(resolve(REPLAY_ROOT, lane, "upstream.sse")),
  );
}

/**
 * The first `\n\n`-delimited SSE frame, sliced on bytes to retain exact framing.
 *
 * Whole-fixture replay is used where the outcome allows it, but a fixture that
 * ends in its protocol's terminal cannot drive a stall: `forwardStream` refuses
 * to arm a post-terminal window (W2 F#1), so the read would hang forever
 * instead. The first frame is also exactly the frame that carries the join key.
 */
function firstSseFrame(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return bytes.subarray(0, i + 2);
    }
  }
  return bytes;
}

const dec = new TextDecoder();

/** Synthetic backend-style identifier pinned in the public Lane-1 fixture. */
const SYNTHETIC_MSG_ID = "msg_vrtx_public_fixture_00000001";

/** Counter labels for the default harness lane. */
const msgIdLabels = { route: "messages", model: "claude-test" };

function msgIdCount(
  result: string,
  labels: Record<string, string> = msgIdLabels,
): number | undefined {
  return getValueForTests("copilot_proxy_upstream_msg_id_total", {
    ...labels,
    result,
  });
}

/** Exactly one increment, on `result` and on nothing else. */
function expectOnlyResult(
  result: string,
  labels: Record<string, string> = msgIdLabels,
): void {
  for (const r of ["captured", "rejected", "absent", "not_observed"]) {
    expect(msgIdCount(r, labels)).toBe(r === result ? 1 : undefined);
  }
}

/**
 * Drive the translated lane with REAL registered stream-event rules, which
 * `runTranslated` (rules `[]`, empty snapshot) deliberately cannot do. Only the
 * Lane-4 upstream-vs-outbound test needs it; everything else wants the no-op
 * transform.
 */
async function runTranslatedWithRules(
  upstream: Response,
  rules: Rule[],
  registrySnapshot: ReadonlyMap<string, RegisteredStreamEventRule>,
  o: LaneOpts = {},
): Promise<string> {
  const app = new Hono();
  app.get("/sse", (c) =>
    streamSSE(
      c,
      forwardStreamTranslated(
        c,
        upstream,
        rules,
        registrySnapshot,
        o.requestId ?? "tx-req",
        {
          route: "/v1/messages",
          model: o.model ?? "claude-test",
          metricRoute: o.metricRoute ?? "messages",
          stall: o.stall,
          requestId: o.requestId,
          incident: o.incident,
        },
      ),
    ),
  );
  return await (await app.request("/sse")).text();
}

describe("slice (c) join key — the synthetic Lane-1 id reaches the incident record", () => {
  it("the fixture on disk still carries the id these tests pin", () => {
    // Keep the fixture premise explicit so an ID edit cannot weaken this case.
    const text = dec.decode(fixtureBytes("cc_claude_passthrough"));
    expect(text).toContain(`"id":"${SYNTHETIC_MSG_ID}"`);
    // The property that makes this vector load-bearing: the underscore after
    // `vrtx` is what the tight `^msg_[A-Za-z0-9]{20,}$` guard chokes on.
    expect(SYNTHETIC_MSG_ID).toContain("_vrtx_");
  });

  it("verbatim: the record carries the synthetic id, and the counter reads captured", async () => {
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const frame = firstSseFrame(fixtureBytes("cc_claude_passthrough"));
    expect(dec.decode(frame)).toContain("event: message_start");

    const text = await runVerbatim(makeHangingResponse([frame]), {
      stall: fake.config,
      requestId: "msgid-verbatim",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    // A strict alphanumeric-only guard rejects the synthetic underscore shape.
    expect(inc.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
    expectOnlyResult("captured");
  });

  it("translated: the same synthetic bytes through the no-op translated lane", async () => {
    // No-op rules isolate upstream observation from event transformation.
    const fake = makeFakeStall();
    const inc = collectIncidents();
    const frame = firstSseFrame(fixtureBytes("cc_claude_passthrough"));

    const text = await runTranslated(makeHangingResponse([frame]), {
      stall: fake.config,
      requestId: "msgid-translated",
      incident: inc.config,
    });

    expect(text).toContain("upstream stall");
    expect(inc.seen.length).toBe(1);
    // MUTATION ARMED: delete the `peekUpstreamEvent(event, peek)` call from the
    // translated per-chunk decode loop. Without THIS test that deletion leaves
    // the whole suite green — the defect `runVerbatim`/`runTranslated` were
    // paired to prevent.
    expect(inc.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
    expectOnlyResult("captured");
  });

  it("both lanes agree on the value, byte for byte", async () => {
    const frame = firstSseFrame(fixtureBytes("cc_claude_passthrough"));
    const a = collectIncidents();
    await runVerbatim(makeHangingResponse([frame]), {
      stall: makeFakeStall().config,
      requestId: "pair-v",
      incident: a.config,
    });
    resetForTests();
    const b = collectIncidents();
    await runTranslated(makeHangingResponse([frame]), {
      stall: makeFakeStall().config,
      requestId: "pair-t",
      incident: b.config,
    });
    expect(a.seen[0]!.upstreamMessageId).toBe(b.seen[0]!.upstreamMessageId!);
    expect(a.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
  });
});

/**
 * Slice (c) — the D96 "never manufacture" property, which is the whole reason
 * `peekUpstreamEvent` exists as a separate function from `peekOutboundEvent`.
 *
 * On Lane 4 the reverse translator mints the OUTBOUND Anthropic
 * `message_start.message.id` from ``strOr(response, "id", `msg_${Date.now()}`)``
 * — either the upstream Responses `response.id` (a synthetic `resp_` id here)
 * or, absent that, a locally minted value. Reading `result.events_out` would
 * record one of those as if it were an upstream Anthropic id.
 */
describe("slice (c) join key — the id comes from the UPSTREAM event, never the outbound one", () => {
  async function registerReverseTranslator(): Promise<{
    rules: Rule[];
    snap: ReadonlyMap<string, RegisteredStreamEventRule>;
  }> {
    const m =
      await import("../../../src/lib/transform/translate_responses_event_to_anthropic_event.ts");
    registerStreamEvent(
      "translate_responses_event_to_anthropic_event",
      m.translate_responses_event_to_anthropic_event,
      m.TranslateResponsesEventToAnthropicEventSchema,
      {
        reads: ["messageStartSent", "model", "requestId", "responseId"],
        writes: ["messageStartSent", "model", "responseId"],
        allow_override: true,
      },
    );
    return {
      rules: [
        {
          name: "stream_translate",
          use: "translate_responses_event_to_anthropic_event",
        },
      ],
      snap: snapshot("stream_event"),
    };
  }

  it("Lane 4: a Responses upstream records NOTHING, while the outbound stream carries a minted id", async () => {
    const frame = firstSseFrame(fixtureBytes("cc_gpt55_thinking"));
    const frameText = dec.decode(frame);
    expect(frameText).toContain('"type":"response.created"');
    // Read the synthetic response ID from the exact upstream frame.
    const upstreamResponseId = /"id":"([^"]+)"/.exec(frameText)?.[1] ?? "";
    expect(upstreamResponseId.length).toBeGreaterThan(40);
    expect(upstreamResponseId.startsWith("msg_")).toBe(false);

    const { rules, snap } = await registerReverseTranslator();
    const inc = collectIncidents();
    const text = await runTranslatedWithRules(
      makeHangingResponse([frame]),
      rules,
      snap,
      {
        stall: makeFakeStall().config,
        requestId: "msgid-lane4",
        incident: inc.config,
      },
    );

    // The mutation's food is REALLY THERE: the outbound stream does contain an
    // Anthropic `message_start` whose id is the upstream response ID. Without this
    // assertion the test could pass because the translator never ran.
    expect(text).toContain("event: message_start");
    expect(text).toContain(`"id":"${upstreamResponseId}"`);

    expect(inc.seen.length).toBe(1);
    const rec = inc.seen[0]!;
    // MUTATION ARMED: point the capture at `result.events_out` instead of the
    // decoded upstream event. The outbound `message_start` id is either the
    // `resp_` ID above or a locally minted `msg_<Date.now()>` — both FAIL the shape
    // guard, so the counter flips from "absent" to "rejected" and THIS is the
    // assertion that sees it. (`upstreamMessageId` stays undefined either way,
    // which is exactly why the counter has to be asserted too.)
    expect(rec.upstreamMessageId).toBeUndefined();
    expectOnlyResult("absent");
    // And nothing `msg_`-shaped was recorded under any name.
    expect(JSON.stringify(rec)).not.toContain("msg_");
  });
});

describe("slice (c) join key — an `item_id` of msg_ shape is NOT a join key", () => {
  const responsesLabels = { route: "responses", model: "claude-test" };

  it("the Lane-2 fixture really does carry msg_-shaped ids that PASS the shape guard", () => {
    // The premise of the two tests below, measured rather than assumed: the
    // shape guard ALONE is provably insufficient here, and only the
    // `message_start` event gate stops a false capture.
    const text = dec.decode(fixtureBytes("codex_gpt55_native"));
    const ids = [...text.matchAll(/"(?:item_)?id":"(msg_[^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(/^msg_[A-Za-z0-9_]{16,}$/.test(id)).toBe(true);
    // It is a Responses stream: there is no `message_start` anywhere in it.
    expect(text).not.toContain("message_start");
  });

  it("verbatim: result is absent, not captured", async () => {
    // MUTATION ARMED: drop the `message_start` gate and scan any line for a
    // msg_-shaped id — this fixture carries `msg_public_native_palette_00000001` as
    // `item.id` / `item_id`, and it passes the loose guard.
    await runVerbatim(
      makeClosingResponse([fixtureBytes("codex_gpt55_native")]),
      {
        stall: makeNeverFiringStall(),
        metricRoute: "responses",
        requestId: "itemid-verbatim",
      },
    );
    expectOnlyResult("absent", responsesLabels);
  });

  it("translated: same — D47 mirror", async () => {
    await runTranslated(
      makeClosingResponse([fixtureBytes("codex_gpt55_native")]),
      {
        stall: makeNeverFiringStall(),
        metricRoute: "responses",
        requestId: "itemid-translated",
      },
    );
    expectOnlyResult("absent", responsesLabels);
  });
});

describe("slice (c) join key — truncation at STALL_PEEK_CAP is REJECTED, not silently absent", () => {
  const PADDED_FRAME = enc.encode(
    `event: message_start\ndata: {"type":"message_start","pad":"${"a".repeat(260)}","message":{"id":"${SYNTHETIC_MSG_ID}"}}\n\n`,
  );

  it("verbatim: an id past the 200-char cap files as rejected", async () => {
    // The realistic path to this state is an upstream KEY-ORDER change, not a
    // long id: MEASURED on the captured fixture, `"id":"msg_` starts at column
    // 32 of a 410-char `data:` line. A backend that emits `usage` (with its
    // cache_creation sub-object) before `id` pushes it past the cap and every
    // Lane-1 stream then reads `rejected` — which is the point. It must be
    // LOUD.
    //
    // MUTATION ARMED: classify the no-regex-match case as "absent" instead of
    // "rejected" in `captureUpstreamMessageId`.
    const inc = collectIncidents();
    await runVerbatim(makeHangingResponse([PADDED_FRAME]), {
      stall: makeFakeStall().config,
      requestId: "trunc-verbatim",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    expect(inc.seen[0]!.upstreamMessageId).toBeUndefined();
    expectOnlyResult("rejected");
  });

  it("translated: the SAME bytes are CAPTURED there — truncation is a verbatim-lane property", async () => {
    // NOT a D47 asymmetry to fix. The translated lane reads a decoded OBJECT,
    // so `STALL_PEEK_CAP` — which bounds the verbatim byte scanner's line
    // buffer and nothing else — does not apply to it at all. Asserted rather
    // than left implicit, because a reader who assumed the lanes must agree
    // here would "fix" one of them.
    const inc = collectIncidents();
    await runTranslated(makeHangingResponse([PADDED_FRAME]), {
      stall: makeFakeStall().config,
      requestId: "trunc-translated",
      incident: inc.config,
    });

    expect(inc.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
    expectOnlyResult("captured");
  });
});

describe("slice (c) join key — the counter separates captured, rejected and absent", () => {
  // `msg_2` is taken from `codex_claude_reverse/expected_client.sse`, not
  // invented: it is what this repo's own reverse translator emits when the
  // upstream supplies no usable id, and it fails `{16,}`.
  const REJECT_FRAME = enc.encode(
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n',
  );

  async function drive(
    lane: "verbatim" | "translated",
    frames: Uint8Array[],
    id: string,
  ): Promise<void> {
    const run = lane === "verbatim" ? runVerbatim : runTranslated;
    await run(makeHangingResponse(frames), {
      stall: makeFakeStall().config,
      requestId: id,
    });
  }

  for (const lane of ["verbatim", "translated"] as const) {
    it(`${lane}: three streams produce exactly one tick each on captured / rejected / absent`, async () => {
      // MUTATION ARMED: collapse "rejected" into "absent" (a single
      // captured/not boolean). The middle stream then joins the third and this
      // reads 0 / 2 instead of 1 / 1.
      await drive(
        lane,
        [firstSseFrame(fixtureBytes("cc_claude_passthrough"))],
        `sep-${lane}-1`,
      );
      await drive(lane, [REJECT_FRAME], `sep-${lane}-2`);
      await drive(lane, [], `sep-${lane}-3`);

      expect(msgIdCount("captured")).toBe(1);
      expect(msgIdCount("rejected")).toBe(1);
      expect(msgIdCount("absent")).toBe(1);
      expect(msgIdCount("not_observed")).toBeUndefined();
    });
  }
});

describe("slice (c) join key — stall detection OFF is `not_observed`, never `absent`", () => {
  for (const lane of ["verbatim", "translated"] as const) {
    it(`${lane}: no stall config → not_observed, and no id anywhere`, async () => {
      // MUTATION ARMED: emit "absent" when `peek === undefined`. That asserts
      // "no message_start was seen" about a stream whose message_start was
      // right there and simply never examined — a manufactured fact, and it
      // corrupts any fleet-level rejection ratio. Emitting NOTHING is the other
      // wrong answer: it drops exactly the streams most likely to be
      // misconfigured out of the denominator, this project's most-repeated
      // defect.
      const run = lane === "verbatim" ? runVerbatim : runTranslated;
      const inc = collectIncidents();
      await run(makeClosingResponse([fixtureBytes("cc_claude_passthrough")]), {
        requestId: `off-${lane}`,
        incident: inc.config,
      });
      // A clean close writes no record at all, so the id's absence there is not
      // the interesting half — the counter is.
      expect(inc.seen.length).toBe(0);
      expectOnlyResult("not_observed");
    });
  }
});

describe("slice (c) join key — a SUCCESSFUL stream also increments the counter", () => {
  for (const lane of ["verbatim", "translated"] as const) {
    it(`${lane}: the WHOLE captured fixture closes cleanly — no record, still captured`, async () => {
      // MUTATION ARMED: move the `incCounter` inside `emitIncident`, or behind
      // the `outcome !== "success"` guard. The counter would then be a function
      // of the failure rate, so a 100 % rejection on a healthy fleet would be
      // invisible — the censored-denominator defect
      // `copilot_proxy_stream_no_first_byte_total` exists to prevent.
      const run = lane === "verbatim" ? runVerbatim : runTranslated;
      const inc = collectIncidents();
      const text = await run(
        makeClosingResponse([fixtureBytes("cc_claude_passthrough")]),
        {
          stall: makeNeverFiringStall(),
          requestId: `success-${lane}`,
          incident: inc.config,
        },
      );

      expect(text).toContain("message_stop");
      expect(text).not.toContain("upstream stall");
      // The existing invariant: successes write no incident record...
      expect(inc.seen.length).toBe(0);
      // ...and the counter is emitted anyway.
      expectOnlyResult("captured");
    });
  }
});

describe("slice (c) join key — only the FIRST message_start data line wins", () => {
  /** A decoy that PASSES the shape guard, so only "first wins" can exclude it. */
  const LATER_ID = "msg_ZZZZZZZZZZZZZZZZZZZZ";

  it("verbatim: a second data line and a second message_start both lose", async () => {
    // MUTATION ARMED: remove the `peek.upstreamIdStatus === "absent"` gate from
    // the new arm in `peekVerbatimLine`. `peek.lastEvent` is never reset, so
    // every subsequent `data:` line of a multi-line SSE event re-enters the arm
    // — the same latent overwrite the adjacent `content_block_start` arm
    // already has for `inThinking`. Both halves below go red without the gate:
    // the second data line first, then the second event.
    expect(/^msg_[A-Za-z0-9_]{16,}$/.test(LATER_ID)).toBe(true);
    const frames = [
      enc.encode(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"${SYNTHETIC_MSG_ID}"}}\ndata: {"type":"message_start","message":{"id":"${LATER_ID}"}}\n\n`,
      ),
      enc.encode(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"${LATER_ID}"}}\n\n`,
      ),
    ];

    const inc = collectIncidents();
    await runVerbatim(makeHangingResponse(frames), {
      stall: makeFakeStall().config,
      requestId: "first-wins-verbatim",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    expect(inc.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
    expectOnlyResult("captured");
  });

  it("translated: a second message_start event does not overwrite the first", async () => {
    const frames = [
      firstSseFrame(fixtureBytes("cc_claude_passthrough")),
      enc.encode(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"${LATER_ID}"}}\n\n`,
      ),
    ];
    const inc = collectIncidents();
    await runTranslated(makeHangingResponse(frames), {
      stall: makeFakeStall().config,
      requestId: "first-wins-translated",
      incident: inc.config,
    });

    expect(inc.seen.length).toBe(1);
    expect(inc.seen[0]!.upstreamMessageId).toBe(SYNTHETIC_MSG_ID);
    expectOnlyResult("captured");
  });
});

// ===========================================================================
// Slice (d) — F165 / D96 Amendment 1: the proxy-emitted SSE keep-alive.
// ===========================================================================

/** Verbatim upstream bytes that end MID-LINE, so no event boundary is reached. */
const PARTIAL_EVENT = enc.encode('event: content_block_delta\ndata: {"par');

/** The label set every keep-alive assertion below reads. */
const KA_LABELS = { route: "messages", model: "claude-test" };

/** Emitted keep-alive comments for the default lane labels. */
function keepalives(): number | undefined {
  return getValueForTests("copilot_proxy_stream_keepalives_total", KA_LABELS);
}

/**
 * Fake `KeepAliveConfig`.
 *
 * The timer FIRES for the first `fires` arms (on a `setTimeout(fireDelayMs)`
 * macrotask) and returns a never-settling promise thereafter, so the number of
 * keep-alive rounds is EXACT rather than a function of how fast the box is.
 * `armThrowsOnCall` makes the Nth `arm()` throw, which is the only way to reach
 * the closeSegment atomicity path: `writeKeepAliveComment` is total-safe, so the
 * reachable throw in that window comes from the RE-ARM, not from the write.
 *
 * ⚠ The paired `makeFakeStall` must be given a NON-ZERO delay in every case
 * here. `stallP` is armed one statement before `kaP`, so two 0-delay macrotasks
 * settle in arming order and the stall would win round 1 every time.
 */
function makeFakeKeepAlive(o: {
  fires: number;
  fireDelayMs?: number;
  intervalMs?: number;
  requireFirstByte?: boolean;
  maxTotalMs?: number;
  armThrowsOnCall?: number;
}): { config: KeepAliveConfig; arms: number[] } {
  const arms: number[] = [];
  const makeTimer = (): StallTimer => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    return {
      arm(ms: number): Promise<void> {
        arms.push(ms);
        if (arms.length === o.armThrowsOnCall) {
          throw new Error("keep-alive arm failed");
        }
        if (handle !== undefined) clearTimeout(handle);
        if (arms.length > o.fires) {
          return new Promise<void>(() => {
            /* bounded fixture — this arm never fires */
          });
        }
        return new Promise<void>((resolve) => {
          handle = setTimeout(resolve, o.fireDelayMs ?? 0);
        });
      },
      cancel(): void {
        if (handle !== undefined) {
          clearTimeout(handle);
          handle = undefined;
        }
      },
    };
  };
  return {
    config: {
      intervalMs: o.intervalMs ?? 30_000,
      requireFirstByte: o.requireFirstByte ?? false,
      maxTotalMs: o.maxTotalMs ?? 300_000,
      makeTimer,
    },
    arms,
  };
}

/**
 * A `KeepAliveConfig` on the REAL `makeStallTimer`, for the one case that has to
 * measure elapsed time rather than count rounds.
 */
function realKeepAlive(intervalMs: number): KeepAliveConfig {
  return {
    intervalMs,
    requireFirstByte: false,
    maxTotalMs: 3_600_000,
    makeTimer: makeStallTimer,
  };
}

/**
 * TEST 4 — the SHIPPED default (keep-alive off) is byte-identical to the
 * pre-slice baseline.
 *
 * This is the regression guard for the whole rest of this file: every other case
 * in it runs with `keepAlive: undefined`, so if the off path were not inert they
 * would all move at once. Stated explicitly here so the property has a name
 * rather than being an emergent side effect.
 */
describe("slice (d) keep-alive OFF — the shipped default changes nothing", () => {
  function assertNothingEmitted(text: string, armedPeriods: number[]): void {
    expect(text).not.toContain(": keepalive");
    expect(keepalives()).toBeUndefined();
    // Two raced reads: one delivers `message_start`, the next stalls. Neither is
    // affected by a feature that is off.
    expect(armedPeriods).toEqual([1_140_000, 1_140_000]);
    expect(text).toContain("event: error");
  }

  it("verbatim: no comment, no counter, unchanged arming", async () => {
    const fake = makeFakeStall(60);
    const text = await runVerbatim(makeHangingResponse([MESSAGE_START]), {
      stall: fake.config,
      requestId: "ka-off-verbatim",
    });
    assertNothingEmitted(text, fake.armedPeriods);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall(60);
    const text = await runTranslated(makeHangingResponse([MESSAGE_START]), {
      stall: fake.config,
      requestId: "ka-off-translated",
    });
    assertNothingEmitted(text, fake.armedPeriods);
  });
});

/**
 * TEST 5 (G2) — **the stall deadline stays ABSOLUTE across N keep-alive
 * re-entries, and this is the assertion that makes it FALSIFIABLE.**
 *
 * D101 downgraded M1's "INVARIANT" comment on exactly this point: with nothing
 * re-entering the race, no mutation of the forwarder could slide the deadline,
 * so the arm-once property was UNFALSIFIABLE and the real guard was recorded as
 * a NAMED ACCEPTANCE CRITERION OF THIS SLICE. Slice (d) is the first change that
 * re-enters the race, so it is the first that can pin it — and this is that pin:
 * FOUR keep-alive rounds inside ONE read, and `armedPeriods` is length **1**.
 *
 * The fixture is byte-silent from the start, so the boundary gate suppresses
 * every WRITE while the rounds still happen — which is the point here. The
 * rounds are observed through the fake timer's arm log, not through the counter;
 * the emitting case is the separate corrected-B3 block below.
 *
 * MUTATION ARMED: re-arm `stallP` inside the loop (the symmetric reading of the
 * two seams, and the shape M1 deleted). `armedPeriods` grows to length 5 and the
 * deadline slides by one full window per keep-alive tick — the unbounded
 * liveness lie D96 forbids.
 */
describe("slice (d) — the stall deadline is ABSOLUTE across N keep-alive rounds", () => {
  function assertArmedOnce(
    text: string,
    armedPeriods: number[],
    arms: number[],
  ): void {
    // THE criterion: one read, one arm, however many keep-alive re-entries.
    expect(armedPeriods).toEqual([1_140_000]);
    // The re-entries really happened — otherwise the line above is satisfied by
    // the feature's absence, which is the defect the plan's own B3 arm had.
    expect(arms.length).toBe(5);
    // ...and the detector still won.
    expect(text).toContain("event: error");
    expect(text).toContain("upstream stall: no response");
  }

  it("verbatim: four rounds, one armed window", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runVerbatim(makeHangingResponse([]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-absolute-verbatim",
    });
    assertArmedOnce(text, fake.armedPeriods, ka.arms);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-absolute-translated",
    });
    assertArmedOnce(text, fake.armedPeriods, ka.arms);
  });
});

/**
 * TEST 6 — the keep-alive promise is RE-ARMED every round (anti-LIVELOCK).
 *
 * `stallP` is a DEADLINE (armed once, reused); `kaP` is an INTERVAL (re-armed
 * each round). The two live five lines apart and their correct treatments are
 * opposite, which is why the seam's own instructions made the wrong one the
 * SYMMETRIC reading (D101).
 *
 * MUTATION ARMED: delete `kaP = armKeepAlive()` and reuse the settled promise.
 * `Promise.race` then re-selects `keepalive` on a MICROTASK forever, the
 * macrotask queue never drains, `setTimeout` lives there — so the stall timer
 * can never fire and the read can never resolve. **This test HANGS rather than
 * failing an assertion, and a hang is the correct signal: the defect is a
 * livelock, not a miscount.** The bounded arm log is what proves the loop is
 * finite here: one initial arm plus exactly one re-arm per round, all at
 * `interval_ms`.
 */
describe("slice (d) — the keep-alive is RE-ARMED every round, and the loop is bounded", () => {
  const INTERVAL_MS = 7_000;

  function assertRearmed(arms: number[]): void {
    expect(arms).toEqual([
      INTERVAL_MS,
      INTERVAL_MS,
      INTERVAL_MS,
      INTERVAL_MS,
      INTERVAL_MS,
    ]);
  }

  it("verbatim: one initial arm + one re-arm per round", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4, intervalMs: INTERVAL_MS });
    await runVerbatim(makeHangingResponse([]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-rearm-verbatim",
    });
    assertRearmed(ka.arms);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4, intervalMs: INTERVAL_MS });
    await runTranslated(makeHangingResponse([]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-rearm-translated",
    });
    assertRearmed(ka.arms);
  });
});

/**
 * TEST 5b (the CORRECTED B3) — comments are actually EMITTED, and the detector
 * survives them.
 *
 * ⚠ **The plan's own B3 arm proved nothing, and this is why the fixture
 * differs.** It set a 20 s stall window against a 30 s keep-alive interval, so
 * the stall fired before the first tick, ZERO comments were emitted, and the
 * assertion was satisfied by the feature's ABSENCE — indistinguishable from the
 * feature working. Here the interval is far below the window, `>= 3` comments
 * are required, and the stall still has to fire afterwards.
 *
 * MUTATION ARMED: re-arm `stallP` in the loop → `armedPeriods` grows past the
 * two raced reads. Suppress the write → the `>= 3` floor fails.
 */
describe("slice (d) — N comments are emitted and the detector still fires", () => {
  function assertEmittedAndStalled(text: string, armedPeriods: number[]): void {
    expect(keepalives()!).toBeGreaterThanOrEqual(3);
    expect(text).toContain(": keepalive");
    // One arm per raced read — the chunk-delivering one and the stalling one.
    // Unchanged by however many comments went out in between.
    expect(armedPeriods).toEqual([1_140_000, 1_140_000]);
    expect(text).toContain("upstream stall: no response");
  }

  it("verbatim: comments, then the 504", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runVerbatim(makeHangingResponse([MESSAGE_START]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-emit-verbatim",
    });
    assertEmittedAndStalled(text, fake.armedPeriods);
  });

  it("translated: same — D47 mirror", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runTranslated(makeHangingResponse([MESSAGE_START]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-emit-translated",
    });
    assertEmittedAndStalled(text, fake.armedPeriods);
  });
});

/**
 * TEST 7 — a comment can NEVER splice into a half-written event.
 *
 * MUTATION ARMED per lane, and they are different mutations because the two
 * lanes derive the boundary differently:
 *   - verbatim: drop `curLineKind === 0` (or `!sinceBoundaryHasReal`) from
 *     `atSseBoundary()` → the comment lands inside the open `data:` line and the
 *     client's JSON parse breaks on a frame the upstream sent correctly;
 *   - translated: set `atEventBoundary = true` BEFORE `stream.write` instead of
 *     after (or initialise it `true`) → a comment can be emitted between an
 *     event's own bytes, and before the first event at all.
 */
describe("slice (d) — a comment never splices into a half-written event", () => {
  it("verbatim: the mid-line partial stays contiguous", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runVerbatim(makeHangingResponse([PARTIAL_EVENT]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-boundary-verbatim",
    });
    // The rounds DID happen — so this is the boundary gate refusing, not the
    // keep-alive being inert.
    expect(ka.arms.length).toBe(5);
    expect(keepalives()).toBeUndefined();
    expect(text).not.toContain(": keepalive");
    expect(text).toContain('data: {"par');
  });

  it("translated: nothing is written before the first complete event", async () => {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4 });
    const text = await runTranslated(makeHangingResponse([PARTIAL_EVENT]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: "ka-boundary-translated",
    });
    expect(ka.arms.length).toBe(5);
    expect(keepalives()).toBeUndefined();
    expect(text).not.toContain(": keepalive");
  });
});

/**
 * TEST 8 — `require_first_byte`, and the invariant that makes it REDUNDANT.
 *
 * The `true` case is the knob doing its job: no arm at all before the first
 * upstream byte. The `false` MIRROR runs the SAME byte-silent fixture and still
 * emits nothing — because each forwarder's boundary gate independently forbids a
 * pre-first-byte comment (verbatim: `bomIndex === 3` is false until a byte is
 * scanned; translated: `atEventBoundary` initialises `false`).
 *
 * That redundancy is asserted rather than described, because it is currently
 * produced by two UNRELATED mechanisms in another file — precisely the kind of
 * property that disappears silently when one of them is refactored.
 *
 * MUTATION ARMED: drop the `requireFirstByte` conjunct from `armKeepAlive` → the
 * `true` case arms five times instead of zero. (The comment count stays 0 under
 * that mutation, which is why the ARM LOG is the observable here: asserting only
 * the counter would let the mutation through on the strength of a safety net
 * living in another file.)
 */
describe("slice (d) — require_first_byte, and its structural redundancy", () => {
  it("verbatim: true → never armed; false → armed but STILL never emitted", async () => {
    const strictStall = makeFakeStall(120);
    const strict = makeFakeKeepAlive({ fires: 4, requireFirstByte: true });
    const strictText = await runVerbatim(makeHangingResponse([]), {
      stall: strictStall.config,
      keepAlive: strict.config,
      requestId: "ka-firstbyte-strict-verbatim",
    });
    expect(strict.arms).toEqual([]);
    expect(keepalives()).toBeUndefined();
    expect(strictText).not.toContain(": keepalive");

    resetForTests();
    const laxStall = makeFakeStall(120);
    const lax = makeFakeKeepAlive({ fires: 4, requireFirstByte: false });
    const laxText = await runVerbatim(makeHangingResponse([]), {
      stall: laxStall.config,
      keepAlive: lax.config,
      requestId: "ka-firstbyte-lax-verbatim",
    });
    expect(lax.arms.length).toBe(5);
    expect(keepalives()).toBeUndefined();
    expect(laxText).not.toContain(": keepalive");
  });

  it("translated: same — D47 mirror", async () => {
    const strictStall = makeFakeStall(120);
    const strict = makeFakeKeepAlive({ fires: 4, requireFirstByte: true });
    const strictText = await runTranslated(makeHangingResponse([]), {
      stall: strictStall.config,
      keepAlive: strict.config,
      requestId: "ka-firstbyte-strict-translated",
    });
    expect(strict.arms).toEqual([]);
    expect(keepalives()).toBeUndefined();
    expect(strictText).not.toContain(": keepalive");

    resetForTests();
    const laxStall = makeFakeStall(120);
    const lax = makeFakeKeepAlive({ fires: 4, requireFirstByte: false });
    const laxText = await runTranslated(makeHangingResponse([]), {
      stall: laxStall.config,
      keepAlive: lax.config,
      requestId: "ka-firstbyte-lax-translated",
    });
    expect(lax.arms.length).toBe(5);
    expect(keepalives()).toBeUndefined();
    expect(laxText).not.toContain(": keepalive");
  });
});

/**
 * TEST 9 — `max_total_ms` STOPS EMISSION without terminating the stream (Q1).
 *
 * The behaviour at the ceiling was never decided: `decisions.md` records the
 * RATIONALE for having a ceiling and not what happens on reaching one. Reading
 * (ii) — terminate as `upstream_stall` — was rejected because it invents a new
 * kill trigger sized by a window this very edit admits is unmeasured, and makes
 * the effective no-response window `min(no_response_wait_ms, ~max_total_ms)`
 * whenever the keep-alive is on, i.e. it SHORTENS the detector. Reading (i)
 * ships: at the ceiling the loop degenerates to the exact 2-way race the
 * detector already had, and the detector stays the authority.
 *
 * `maxTotalMs: 0` is constructed directly rather than through the schema, which
 * rejects it (`.positive()`) — the schema is not the thing under test here.
 *
 * MUTATION ARMED: delete the ceiling conjunct from `armKeepAlive` → the
 * zero-budget case arms and emits. The mirror at an hour is what stops that
 * being satisfied by a keep-alive that never works at all.
 */
describe("slice (d) — max_total_ms stops emission, and only emission", () => {
  async function runCeiling(
    lane: typeof runVerbatim,
    maxTotalMs: number,
    tag: string,
  ): Promise<{ text: string; armedPeriods: number[]; arms: number[] }> {
    const fake = makeFakeStall(150);
    const ka = makeFakeKeepAlive({ fires: 4, maxTotalMs });
    const text = await lane(makeHangingResponse([MESSAGE_START]), {
      stall: fake.config,
      keepAlive: ka.config,
      requestId: tag,
    });
    return { text, armedPeriods: fake.armedPeriods, arms: ka.arms };
  }

  it("verbatim: a zero budget emits nothing and the stall still fires", async () => {
    const spent = await runCeiling(runVerbatim, 0, "ka-ceiling-verbatim");
    expect(spent.arms).toEqual([]);
    expect(keepalives()).toBeUndefined();
    expect(spent.text).toContain("upstream stall: no response");
    expect(spent.armedPeriods).toEqual([1_140_000, 1_140_000]);

    resetForTests();
    const roomy = await runCeiling(runVerbatim, 3_600_000, "ka-roomy-verbatim");
    expect(keepalives()!).toBeGreaterThanOrEqual(3);
    expect(roomy.armedPeriods).toEqual([1_140_000, 1_140_000]);
  });

  it("translated: same — D47 mirror", async () => {
    const spent = await runCeiling(runTranslated, 0, "ka-ceiling-translated");
    expect(spent.arms).toEqual([]);
    expect(keepalives()).toBeUndefined();
    expect(spent.text).toContain("upstream stall: no response");
    expect(spent.armedPeriods).toEqual([1_140_000, 1_140_000]);

    resetForTests();
    const roomy = await runCeiling(
      runTranslated,
      3_600_000,
      "ka-roomy-translated",
    );
    expect(keepalives()!).toBeGreaterThanOrEqual(3);
    expect(roomy.armedPeriods).toEqual([1_140_000, 1_140_000]);
  });
});

/**
 * TEST 10 (the MERGE PIN) — the recorded detector wait EXCEEDS `interval_ms`
 * with the keep-alive ON.
 *
 * D100 named this test before either slice was written, because BOTH naive
 * merges of (b) and (d) are red under it and green under everything else:
 *   (i) re-stamp the segment per round WITHOUT accumulating → the recorded value
 *       caps at ~`interval_ms`, so a ten-minute wait would report 15 ms;
 *   (ii) never re-stamp → each round re-adds the whole span since the read
 *       began, so the value grows QUADRATICALLY in the number of rounds and the
 *       client-write time is swallowed into the detector's own series.
 * The bounds below are two-sided for exactly that reason: (i) fails the floor,
 * (ii) fails the ceiling, and a correct implementation sits between them.
 *
 * This is the one case that measures ELAPSED TIME, so it runs the REAL timer.
 * The fixture separates the two phases by length and order, and the assertion is
 * on the RESPONSE phase — the gap the keep-alive actually fires inside (the
 * pre-content phase emits no comment, because no byte has been scanned yet).
 */
describe("slice (d) — detector wait exceeds interval_ms with keep-alive ON", () => {
  const KA_INTERVAL_MS = 15;
  const GAP_MS = 100;
  const FIRST_BYTE_MS = 40;

  function assertWaitExceedsInterval(): void {
    const resp = getValueForTests(
      "copilot_proxy_detector_max_wait_seconds_sum",
      { ...KA_LABELS, phase: "response" },
    );
    expect(typeof resp).toBe("number");
    // The D100 wording, asserted literally.
    expect(resp!).toBeGreaterThan(KA_INTERVAL_MS / 1000);
    // Value-sensitive floor — fails merge (i), which caps at ~interval_ms.
    expect(resp!).toBeGreaterThan(0.06);
    // Value-sensitive ceiling — fails merge (ii), whose overlapping segments sum
    // to several times the real gap.
    expect(resp!).toBeLessThan(0.2);
    // Comments really were emitted inside that wait.
    expect(keepalives()!).toBeGreaterThanOrEqual(2);
  }

  it("verbatim: the wait spans many keep-alive rounds, counted once each", async () => {
    await runVerbatim(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      {
        stall: makeNeverFiringStall(),
        keepAlive: realKeepAlive(KA_INTERVAL_MS),
        requestId: "ka-merge-verbatim",
      },
    );
    assertWaitExceedsInterval();
  });

  it("translated: same — D47 mirror", async () => {
    await runTranslated(
      makeGappyResponse(TEXT_DELTA, MESSAGE_STOP, GAP_MS, FIRST_BYTE_MS),
      {
        stall: makeNeverFiringStall(),
        keepAlive: realKeepAlive(KA_INTERVAL_MS),
        requestId: "ka-merge-translated",
      },
    );
    assertWaitExceedsInterval();
  });
});

/**
 * TEST 11 (G1) — a throw in the keep-alive window must NOT double-count the
 * detector wait.
 *
 * D101 assigned `closeSegment()` atomicity to this slice and the edit plan did
 * not carry it. The hazard is real and sits between two statements: the segment
 * is closed, the comment is written, the next interval is armed, the segment is
 * reopened. A throw anywhere in that window used to leave the segment marker at
 * the START of the span just accounted, so the `finally` added THAT SAME SPAN A
 * SECOND TIME — corrupting `detectorWaitMs`, which is the only series licensed
 * to size a stall window.
 *
 * The throw is injected at the RE-ARM, not at the write: `writeKeepAliveComment`
 * is total-safe by construction, so the arm is the reachable failure in that
 * window. `makeTimer` is caller-supplied config, exactly like the stall
 * detector's, so this is a real path and not a contrivance.
 *
 * MUTATION ARMED: replace the closed-over pair with the pre-slice inline shape —
 * `detectorWaitMs += performance.now() - waitStart;` at the top of the round and
 * a bare `waitStart = performance.now();` at the bottom. The `finally` then adds
 * the ~80 ms segment twice and the upper bound fails.
 *
 * ⚠ Deleting only the `if (waitStart === undefined) return;` line does NOT
 * compile under `strictNullChecks` (`waitStart` is `number | undefined` there),
 * so that arm is vacuous and the mutation above is its live equivalent. The
 * guard being TYPE-enforced is the stronger outcome, not a gap.
 */
describe("slice (d) — a throwing re-arm cannot double-count the detector wait", () => {
  const FIRE_MS = 80;

  function assertSingleCount(text: string): void {
    // One comment reached the client BEFORE the throw — which is what makes the
    // double-count reachable at all.
    expect(keepalives()).toBe(1);
    expect(text).toContain(": keepalive");
    const wait = getValueForTests(
      "copilot_proxy_detector_max_wait_seconds_sum",
      { ...KA_LABELS, phase: "no_response" },
    );
    expect(typeof wait).toBe("number");
    expect(wait!).toBeGreaterThan(FIRE_MS / 1000 - 0.02);
    // The double-count lands at ~2x FIRE_MS; an idempotent close stays at ~1x.
    expect(wait!).toBeLessThan((FIRE_MS * 1.6) / 1000);
    // The throw still surfaces to the client as a real failure — the atomicity
    // fix must not swallow it.
    expect(text).toContain("event: error");
  }

  it("verbatim: the segment is closed once, not twice", async () => {
    const ka = makeFakeKeepAlive({
      fires: 2,
      fireDelayMs: FIRE_MS,
      armThrowsOnCall: 3,
    });
    const text = await runVerbatim(makeHangingResponse([MESSAGE_START]), {
      stall: makeNeverFiringStall(),
      keepAlive: ka.config,
      requestId: "ka-atomic-verbatim",
    });
    expect(ka.arms.length).toBe(3);
    assertSingleCount(text);
  });

  it("translated: same — D47 mirror", async () => {
    const ka = makeFakeKeepAlive({
      fires: 2,
      fireDelayMs: FIRE_MS,
      armThrowsOnCall: 3,
    });
    const text = await runTranslated(makeHangingResponse([MESSAGE_START]), {
      stall: makeNeverFiringStall(),
      keepAlive: ka.config,
      requestId: "ka-atomic-translated",
    });
    expect(ka.arms.length).toBe(3);
    assertSingleCount(text);
  });
});
