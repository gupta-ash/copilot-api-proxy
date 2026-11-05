/**
 * crash.ts — process-level crash diagnosability (task #4, Option B).
 *
 * copilot-proxy had no `uncaughtException` / `unhandledRejection` handlers, so an
 * uncaught throw — or a stray rejection from the codebase's fire-and-forget promises
 * (`tokenManager.start()`, the retention `setInterval`, trace writes) — killed the
 * process with only Node's default stack and no structured record.
 *
 * This module adds FORENSICS, not restart/supervision. Per operator scope: the proxy
 * died once in ~2 months of heavy use, and its death kills every connected harness
 * session anyway, so auto-restarting the proxy underneath dead clients buys nothing.
 * On either event we write a structured crash marker, log rich context, then `exit(1)`
 * — which MATCHES Node >=15's default (an unhandled rejection already terminates the
 * process). We only make the death diagnosable; we do not keep the process limping.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import consola from "consola";

export type CrashKind = "uncaughtException" | "unhandledRejection";

export interface CrashRecord {
  at: string;
  kind: CrashKind;
  message: string;
  stack: string | null;
  pid: number;
}

const UNSERIALIZABLE = "[unserializable thrown value]";

/**
 * Coerce to string WITHOUT ever throwing. `String(x)` can throw for a null-prototype
 * object, a throwing `toString`, or a throwing `Symbol.toPrimitive`.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * `JSON.stringify` WITHOUT throwing (circular / bigint). Returns undefined for values
 * it cannot represent (function / symbol / undefined) OR when it throws.
 */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Coerce a (possibly non-string) value to a string. A Proxy-backed Error getter can
 * return a BigInt / circular / null-prototype value; left un-normalized it would make
 * `JSON.stringify(record)` throw (silent, no marker) or the log template throw. This
 * guarantees the CrashRecord's `message`/`stack` are always plain, serializable strings.
 */
function normalizeToString(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJson(value) ?? safeString(value);
}

/**
 * Normalize any thrown value (Error, string, plain object, null/undefined, number,
 * Proxy, throwing-getter, circular null-prototype) into a serializable crash record.
 * Pure — no I/O. TOTAL: it MUST NEVER throw — a throw here would let the crash handler
 * exit with no marker and no stack, i.e. the exact masking this module exists to prevent.
 */
export function buildCrashRecord(kind: CrashKind, err: unknown): CrashRecord {
  let message = UNSERIALIZABLE;
  let stack: string | null = null;

  try {
    let rawMessage: unknown = UNSERIALIZABLE;
    let rawStack: unknown = null;

    if (err instanceof Error) {
      // `.message` / `.stack` are getters — a subclass or Proxy can make them THROW
      // or return a non-string. Guard the access here; normalize the value below.
      try {
        rawMessage = err.message || err.name || "Error";
      } catch {
        rawMessage = "Error (message accessor threw)";
      }
      try {
        rawStack = err.stack ?? null;
      } catch {
        rawStack = null;
      }
    } else if (typeof err === "string") {
      rawMessage = err;
    } else if (err === undefined) {
      rawMessage = "undefined";
    } else if (err === null) {
      rawMessage = "null";
    } else {
      rawMessage = safeJson(err) ?? safeString(err);
    }

    // A Proxy Error getter can hand back a NON-string (BigInt / circular / null-proto).
    // Normalize so the record is ALWAYS serializable + interpolatable downstream — an
    // un-normalized non-string would make JSON.stringify(record) or the log template
    // throw, masking the crash (the exact failure this module prevents).
    message = normalizeToString(rawMessage);
    stack = rawStack === null ? null : normalizeToString(rawStack);
  } catch {
    // Absolute last resort — buildCrashRecord must NEVER throw.
    message = UNSERIALIZABLE;
    stack = null;
  }

  return {
    at: new Date().toISOString(),
    kind,
    message,
    stack,
    pid: process.pid,
  };
}

/**
 * Write the crash marker synchronously. BEST-EFFORT: every failure is swallowed so a
 * marker-write problem can never mask the original crash. Synchronous because the
 * caller exits immediately after — an async write would be lost on `process.exit`.
 *
 * Atomic: write a sibling temp file first, then rename over the canonical marker (an
 * overwriting rename on POSIX and Windows/libuv). A mid-write failure therefore leaves
 * the PRIOR valid marker intact rather than a truncated/partial one.
 */
export function writeCrashMarkerSync(
  crashPath: string,
  record: CrashRecord,
): void {
  try {
    mkdirSync(path.dirname(crashPath), { recursive: true });
    const tmp = `${crashPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmp, crashPath);
  } catch {
    /* never mask the original crash */
  }
}

let handling = false;

/**
 * Install `uncaughtException` + `unhandledRejection` handlers. On either event: record
 * a structured marker at `crashPath`, log, then `exit(1)`. Register EARLY (top of
 * `main()`) so it covers bootstrap + the un-awaited background work.
 *
 * We deliberately do NOT convert `unhandledRejection` to log-and-continue: that would
 * change Node's crash semantics and risk masking real bugs. Forensics only.
 */
export function installCrashHandlers(opts: { crashPath: string }): void {
  const { crashPath } = opts;

  const handle = (kind: CrashKind, err: unknown): void => {
    if (handling) {
      // A crash while handling a crash — do not recurse; just exit.
      process.exit(1);
      return;
    }
    handling = true;
    try {
      const record = buildCrashRecord(kind, err);
      writeCrashMarkerSync(crashPath, record);
      consola.error(
        `FATAL ${kind}: ${record.message}\n${record.stack ?? "(no stack)"}\n(crash marker: ${crashPath})`,
      );
    } catch {
      /* the handler itself must never throw */
    } finally {
      process.exit(1);
    }
  };

  process.on("uncaughtException", (err) => {
    handle("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    handle("unhandledRejection", reason);
  });
}
