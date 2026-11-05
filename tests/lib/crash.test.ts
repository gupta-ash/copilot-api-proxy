/**
 * crash.test.ts — unit tests for `src/lib/crash.ts` (task #4).
 *
 * Covers the two pure/IO helpers. `installCrashHandlers` is intentionally NOT
 * exercised here: it registers real `process.on('uncaughtException')` handlers
 * and calls `process.exit(1)`, which would tear down the test runner. Its wiring
 * is verified by the isolated out-of-process e2e (see the plan's verification
 * section), not by an in-process unit test.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  buildCrashRecord,
  writeCrashMarkerSync,
  type CrashRecord,
} from "../../src/lib/crash.ts";

describe("buildCrashRecord", () => {
  it("normalizes an Error (message + stack)", () => {
    const rec = buildCrashRecord("uncaughtException", new Error("boom"));
    expect(rec.kind).toBe("uncaughtException");
    expect(rec.message).toBe("boom");
    expect(rec.stack).toContain("boom");
    expect(rec.pid).toBe(process.pid);
    // `at` is a valid ISO-8601 timestamp that round-trips.
    expect(new Date(rec.at).toISOString()).toBe(rec.at);
  });

  it("falls back to the Error name when the message is empty", () => {
    const rec = buildCrashRecord("uncaughtException", new TypeError(""));
    expect(rec.message).toBe("TypeError");
  });

  it("normalizes a string throw", () => {
    const rec = buildCrashRecord("unhandledRejection", "just a string");
    expect(rec.kind).toBe("unhandledRejection");
    expect(rec.message).toBe("just a string");
    expect(rec.stack).toBeNull();
  });

  it("normalizes a plain-object throw without throwing", () => {
    const rec = buildCrashRecord("uncaughtException", { code: 42 });
    expect(rec.message).toBe(JSON.stringify({ code: 42 }));
    expect(rec.stack).toBeNull();
  });

  it("normalizes null and undefined throws", () => {
    expect(buildCrashRecord("uncaughtException", null).message).toBe("null");
    expect(buildCrashRecord("uncaughtException", undefined).message).toBe(
      "undefined",
    );
  });

  it("survives a circular (non-serializable) throw", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const rec = buildCrashRecord("uncaughtException", circular);
    expect(typeof rec.message).toBe("string");
    expect(rec.message.length).toBeGreaterThan(0);
  });

  it("survives an Error whose message/stack getters throw", () => {
    const evil = new Error("orig");
    Object.defineProperty(evil, "message", {
      get() {
        throw new Error("message getter boom");
      },
    });
    Object.defineProperty(evil, "stack", {
      get() {
        throw new Error("stack getter boom");
      },
    });
    // Must not throw — a throw here would let the handler exit with no marker.
    const rec = buildCrashRecord("uncaughtException", evil);
    expect(rec.message.length).toBeGreaterThan(0);
    expect(rec.stack).toBeNull();
  });

  it("survives a null-prototype circular object (String AND JSON both throw)", () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto["self"] = nullProto;
    const rec = buildCrashRecord("unhandledRejection", nullProto);
    expect(rec.message.length).toBeGreaterThan(0);
  });

  it("survives a bigint throw (JSON throws, String succeeds)", () => {
    const rec = buildCrashRecord("uncaughtException", 10n);
    expect(rec.message).toBe("10");
  });

  it("normalizes a symbol throw (JSON undefined -> String fallback)", () => {
    const rec = buildCrashRecord("uncaughtException", Symbol("boom"));
    expect(rec.message).toBe("Symbol(boom)");
  });

  it("normalizes an Error whose getters RETURN non-string values (Proxy-style)", () => {
    const evil = new Error("placeholder");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    // Getters return NON-string values (a Proxy-backed Error can do this at runtime).
    Object.defineProperty(evil, "message", { get: () => 10n });
    Object.defineProperty(evil, "stack", { get: () => circular });
    const rec = buildCrashRecord("uncaughtException", evil);
    // Record fields must be plain strings, so the record stays serializable downstream.
    expect(typeof rec.message).toBe("string");
    expect(typeof rec.stack).toBe("string");
    expect(() => JSON.stringify(rec)).not.toThrow();
  });
});

describe("writeCrashMarkerSync", () => {
  let dir = "";
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("writes a valid JSON marker, creating missing nested dirs", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
    const target = path.join(
      dir,
      "nested",
      "deeper",
      "copilot-proxy.crash.json",
    );
    const rec = buildCrashRecord("uncaughtException", new Error("x"));
    writeCrashMarkerSync(target, rec);

    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as CrashRecord;
    expect(parsed.kind).toBe("uncaughtException");
    expect(parsed.message).toBe("x");
    expect(parsed.pid).toBe(process.pid);
  });

  it("swallows a write to an un-writable path (never throws)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
    // Make a FILE, then aim the marker at a path *under* it → mkdir/write fails.
    const fileAsParent = path.join(dir, "afile");
    writeFileSync(fileAsParent, "i am a file");
    const target = path.join(fileAsParent, "cannot", "crash.json");
    const rec = buildCrashRecord("unhandledRejection", new Error("y"));

    expect(() => {
      writeCrashMarkerSync(target, rec);
    }).not.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("preserves a prior valid marker when the new write fails (atomic)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
    const target = path.join(dir, "copilot-proxy.crash.json");

    // A first, good marker.
    writeCrashMarkerSync(
      target,
      buildCrashRecord("uncaughtException", new Error("first")),
    );
    expect(existsSync(target)).toBe(true);

    // Force the temp-write to fail: pre-create the temp path as a DIRECTORY so
    // writeFileSync(tmp) throws (EISDIR) before the rename could clobber `target`.
    const tmpPath = `${target}.${process.pid}.tmp`;
    mkdirSync(tmpPath, { recursive: true });

    expect(() => {
      writeCrashMarkerSync(
        target,
        buildCrashRecord("unhandledRejection", new Error("second")),
      );
    }).not.toThrow();

    // The prior valid marker must survive intact (not truncated/destroyed).
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as CrashRecord;
    expect(parsed.message).toBe("first");
  });
});
