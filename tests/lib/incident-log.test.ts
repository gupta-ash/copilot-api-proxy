/**
 * incident-log.test.ts — D96 Phase 1 always-on stream-incident log.
 *
 * The properties under test are the ones that make the log trustworthy at the
 * level the fleet actually runs, not the ones that are easy to assert:
 *   - it NEVER throws, because it runs inside a live stream's `finally`;
 *   - a record that resists `JSON.stringify` still produces a line, and that
 *     line SAYS it is degraded rather than looking complete;
 *   - it is on by default and off only when explicitly disabled, including on
 *     the minimal-parse path where Zod's outer `.default()` leaves the nested
 *     object absent entirely (the F66 trap).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import consola from "consola";

import {
  appendIncidentLog,
  INCIDENT_LOG_MAX_BYTES_DEFAULT,
  makeIncidentConfig,
  serializeIncident,
  type IncidentRecord,
} from "../../src/lib/incident-log.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "incident-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseRecord(over: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    ts: "2026-08-08T06:18:41.045Z",
    outcome: "upstream_stall",
    status: 504,
    route: "messages",
    protocol: "anthropic",
    model: "claude-opus-4.8",
    requestId: "request_public_fixture_0001",
    elapsedMs: 184_002,
    phase: "pre_content",
    bytesReceived: 0,
    inflightAtStart: 10,
    inflightAtEnd: 9,
    ...over,
  };
}

describe("serializeIncident", () => {
  it("round-trips every field as one parseable JSON line", () => {
    const rec = baseRecord({ ttfbMs: 1234, requestBytes: 812_004 });
    const parsed: unknown = JSON.parse(serializeIncident(rec));
    expect(parsed).toEqual(rec as unknown as Record<string, unknown>);
    expect(serializeIncident(rec)).not.toContain("\n");
  });

  it("OMITS ttfbMs when no first byte arrived — the two stall shapes must stay distinguishable", () => {
    const parsed = JSON.parse(serializeIncident(baseRecord())) as Record<
      string,
      unknown
    >;
    // Absent, not null and not zero: a consumer must be able to tell "the
    // upstream never spoke" from "it answered instantly".
    expect("ttfbMs" in parsed).toBe(false);
    const withByte = JSON.parse(
      serializeIncident(baseRecord({ ttfbMs: 0 })),
    ) as Record<string, unknown>;
    expect(withByte.ttfbMs).toBe(0);
  });

  it("still emits a line for a record that resists JSON.stringify, and marks it degraded", () => {
    const hostile = baseRecord() as IncidentRecord & { self?: unknown };
    hostile.self = hostile; // circular
    const line = serializeIncident(hostile);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // The fallback keeps the fields a triage pass actually needs...
    expect(parsed.requestId).toBe("request_public_fixture_0001");
    expect(parsed.outcome).toBe("upstream_stall");
    expect(parsed.status).toBe(504);
    // ...and says so, so a consumer never reads a partial record as complete.
    expect(parsed.degraded).toBe(true);
  });

  it("the degraded rebuild KEEPS the D99(c) upstream join key", () => {
    // ARMED: drop the `upstreamMessageId` line from `serializeIncident`'s
    // fallback assembly. The line still parses, still says `degraded:true`, and
    // still carries every field the test above checks — only an explicit
    // assertion on the id catches it. A degraded line without the join key is
    // exactly as unjoinable as the `<unknown>` lines D96 was written about,
    // which is why `requestId` was already in the fallback.
    const hostile = baseRecord({
      upstreamMessageId: "msg_vrtx_public_fixture_00000001",
    }) as IncidentRecord & { self?: unknown };
    hostile.self = hostile; // circular → forces the direct stringify to fail
    const parsed = JSON.parse(serializeIncident(hostile)) as Record<
      string,
      unknown
    >;
    expect(parsed.degraded).toBe(true);
    expect(parsed.upstreamMessageId).toBe("msg_vrtx_public_fixture_00000001");
    // Absent stays absent — the fallback must not mint an empty string.
    const plain = baseRecord() as IncidentRecord & { self?: unknown };
    plain.self = plain;
    const noId = JSON.parse(serializeIncident(plain)) as Record<
      string,
      unknown
    >;
    expect(noId.degraded).toBe(true);
    expect("upstreamMessageId" in noId).toBe(false);
  });

  it("returns the constant line when a FIELD READ throws, rather than losing the record", () => {
    // The two guards are not interchangeable. `safeString(record.ts)`
    // evaluates `record.ts` BEFORE `safeString` is entered, so a throwing
    // getter escapes the per-field guard entirely — it is the fallback
    // ASSEMBLY that has to be wrapped, not each value.
    //
    // ARMED: remove the `try`/`catch` around the fallback assembly in
    // `serializeIncident` and this throws instead of returning, which is the
    // pre-fix behaviour — the throw then lands in `appendIncidentLog`'s catch,
    // which warns and appends NOTHING.
    const hostile = baseRecord() as IncidentRecord & { self?: unknown };
    hostile.self = hostile; // circular → forces the direct stringify to fail
    Object.defineProperty(hostile, "ts", {
      get(): string {
        throw new Error("hostile getter");
      },
      enumerable: true,
      configurable: true,
    });

    let line = "";
    expect(() => {
      line = serializeIncident(hostile);
    }).not.toThrow();
    expect(line).toBe('{"incident":"[unserializable record]"}');
    // Still ONE parseable JSONL line — an unparseable line would defeat the
    // whole point of emitting a constant.
    expect(line).not.toContain("\n");
    expect((JSON.parse(line) as Record<string, unknown>).incident).toBe(
      "[unserializable record]",
    );
  });

  it("a throwing field getter still lands a line ON DISK via appendIncidentLog", () => {
    // The unit above proves the return value; this proves the contract the
    // module docblock actually makes — "degrades to a constant line rather
    // than losing the record". Before the fix this file was EMPTY: the throw
    // propagated to `appendIncidentLog`'s catch, which warns and appends
    // nothing, so `UNSERIALIZABLE_LINE` never reached disk at all.
    const p = path.join(dir, "hostile.log");
    const hostile = baseRecord() as IncidentRecord & { self?: unknown };
    hostile.self = hostile;
    Object.defineProperty(hostile, "outcome", {
      get(): string {
        throw new Error("hostile getter");
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => {
      appendIncidentLog(hostile, p);
    }).not.toThrow();
    expect(existsSync(p)).toBe(true);
    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('{"incident":"[unserializable record]"}');
  });
});

describe("appendIncidentLog", () => {
  it("creates the parent dir and appends one line per call", () => {
    const p = path.join(dir, "nested", "deeper", "incidents.log");
    appendIncidentLog(baseRecord(), p);
    appendIncidentLog(baseRecord({ outcome: "client_abort", status: 499 }), p);

    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).outcome).toBe(
      "upstream_stall",
    );
    expect((JSON.parse(lines[1]!) as Record<string, unknown>).outcome).toBe(
      "client_abort",
    );
  });

  it("NEVER throws when the path is unwritable — a stream must not die over its own record", () => {
    // A file where a directory is required: mkdir/append both fail.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    expect(() => {
      appendIncidentLog(baseRecord(), path.join(blocker, "incidents.log"));
    }).not.toThrow();
  });

  it("rotates to a single .1 sibling once past the cap, and keeps writing", () => {
    const p = path.join(dir, "incidents.log");
    // Cap of 1 byte: the first append lands, the second finds an oversized
    // file and rotates it before writing.
    appendIncidentLog(baseRecord({ outcome: "first" }), p, 1);
    appendIncidentLog(baseRecord({ outcome: "second" }), p, 1);

    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(`${p}.1`, "utf8")).toContain('"first"');
    const live = readFileSync(p, "utf8");
    expect(live).toContain('"second"');
    expect(live).not.toContain('"first"');
  });

  it("rotates on the PROJECTED post-append size, so the live file never crosses the cap", () => {
    const p = path.join(dir, "incidents.log");
    const rec = baseRecord({ outcome: "projected" });
    const lineBytes = Buffer.byteLength(serializeIncident(rec) + "\n", "utf8");
    // One byte above a single line: exactly two lines must never coexist.
    const cap = lineBytes + 1;

    for (let i = 0; i < 5; i += 1) {
      appendIncidentLog(rec, p, cap);
      // ARMED: deciding rotation on the CURRENT size instead of the projected
      // one — `if (statSync(logPath).size < maxBytes) return;`, the shape this
      // file shipped with — leaves 2 * lineBytes here and fails on i === 1.
      expect(statSync(p).size).toBeLessThanOrEqual(cap);
    }
    expect(existsSync(`${p}.1`)).toBe(true);
  });

  it("keeps every record when rotation is permanently refused, and says the cap has stopped holding", () => {
    const p = path.join(dir, "incidents.log");
    // A DIRECTORY at the `.1` path — `renameSync` can never succeed onto it,
    // on POSIX (EISDIR) or on Windows (access denied). This REPRODUCES
    // mechanism 1 of the INCIDENT_LOG_MAX_BYTES_DEFAULT docblock rather than
    // asserting the docblock's word for it.
    mkdirSync(`${p}.1`, { recursive: true });

    const warned: Array<string> = [];
    const originalWarn = consola.warn;
    consola.warn = ((msg: unknown): void => {
      warned.push(String(msg));
    }) as typeof consola.warn;

    const n = 6;
    try {
      for (let i = 0; i < n; i += 1) {
        expect(() => {
          appendIncidentLog(baseRecord({ outcome: `refused-${i}` }), p, 1);
        }).not.toThrow();
      }
    } finally {
      consola.warn = originalWarn;
    }

    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    // ARMED, and this is the durability priority itself: make a failed
    // rotation skip the append, abort the write, or let `renameSync` throw out
    // of `rotateIfNeeded` into the outer catch, and this collapses to 0 lines.
    expect(lines.length).toBe(n);
    for (let i = 0; i < n; i += 1) {
      expect((JSON.parse(lines[i]!) as Record<string, unknown>).outcome).toBe(
        `refused-${i}`,
      );
    }
    // The blocker is still a directory, so no rotation slipped through and the
    // growth above really is uncapped rather than merely un-rotated once.
    expect(statSync(`${p}.1`).isDirectory()).toBe(true);
    // ARMED: drop the `consola.warn` from `rotateIfNeeded` and this is []. It
    // is the ONLY signal an operator gets that disk is now unbounded.
    // `n - 1`, measured: the FIRST append has no file to rotate, so `statSync`
    // returns early and never reaches the rename — the normal first-call case
    // stays silent, which is the whole reason ENOENT is handled separately.
    expect(warned.length).toBe(n - 1);
    expect(warned[0]).toContain("no longer capped");
  });

  it("writes a record LARGER than the cap whole rather than dropping it", () => {
    const p = path.join(dir, "incidents.log");
    // ARMED: the obvious way to make the cap "real" is to refuse a record that
    // cannot fit. That is the one remedy this module may not take — it would
    // lose exactly the record a post-mortem needs — and it leaves this empty.
    appendIncidentLog(baseRecord({ outcome: "oversized" }), p, 1);

    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).outcome).toBe(
      "oversized",
    );
  });
});

describe("makeIncidentConfig", () => {
  it("is ON when the nested object is absent entirely (the Zod outer-default trap, F66)", () => {
    // `ConfigSchema.parse({})` can leave `logging.incident_log` undefined
    // because an outer `.default(() => ({...}))` literal does not re-run the
    // inner defaults. Reading it non-defensively would silently disable the
    // feature on exactly the minimal config a fresh install produces.
    expect(makeIncidentConfig(undefined)).toBeDefined();
    expect(makeIncidentConfig({})).toBeDefined();
  });

  it("is OFF only when explicitly disabled", () => {
    expect(makeIncidentConfig({ enabled: false })).toBeUndefined();
    expect(makeIncidentConfig({ enabled: true })).toBeDefined();
  });

  it("writes to the configured path", () => {
    const p = path.join(dir, "custom.log");
    makeIncidentConfig({ log_path: p })?.log(baseRecord());
    expect(readFileSync(p, "utf8")).toContain(
      '"request_public_fixture_0001"',
    );
  });

  it("exposes a cap large enough that rotation is not a routine event", () => {
    // ~40k incident lines — years of a home fleet's failures (C-2
    // calibration). Note this does NOT bound disk: rotation is best-effort by
    // construction, and the two ways past the cap are the subject of the
    // "PROJECTED post-append size" and "rotation is permanently refused" tests
    // above. This asserts the size only.
    expect(INCIDENT_LOG_MAX_BYTES_DEFAULT).toBe(8 * 1024 * 1024);
  });
});
