/**
 * lint.test.ts — verifies the F4 (M2.5) state-collision detector + the
 * F5/M6 ctx-surface extension (D-LOCK-3):
 *   - duplicate `use:` → WARN dup_use
 *   - write-after-write → WARN write_after_write
 *   - read-without-writer → INFO read_without_writer
 *   - independent writes → no findings
 *   - reader after writer → no findings
 *   - empty rule list → no findings
 *   - ctx-surface (headers): write-after-write → WARN ctx_write_after_write
 *   - ctx-surface (headers): read-without-writer → INFO ctx_read_without_writer
 *   - ctx-surface (body): NEVER emits ctx_* findings (intentional skip)
 *   - mixed M3 (default ctx) + M6 (declared ctx) rules behave correctly
 *
 * Lint never throws; production-OFF debug means silent. M9 will promote
 * findings to errors at config-load time.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { lintRules } from "~/lib/transform/lint";
import {
  register,
  registerStreamEvent,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import type {
  Rule,
  StreamEventResult,
  TransformResult,
} from "~/lib/transform/types";

const noopSchema = z
  .object({
    name: z.string(),
    use: z.string(),
  })
  .passthrough();

const noopFn = (): StreamEventResult => ({
  events_out: [],
  applied: true,
});

const noopBodyFn = (
  ctx: import("~/lib/transform/types").TransformContext,
): TransformResult => ({
  ctx,
  applied: true,
});

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

describe("lintRules — duplicate use detection", () => {
  test("two rules sharing the same `use:` → WARN dup_use", () => {
    registerStreamEvent("the-rule", noopFn, noopSchema);
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "first-instance", use: "the-rule" },
      { name: "second-instance", use: "the-rule" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    const dups = findings.filter((f) => f.code === "dup_use");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.severity).toBe("warn");
    expect(dups[0]?.ruleNames).toEqual(["first-instance", "second-instance"]);
  });

  test("three rules sharing the same `use:` → single WARN with all 3 names", () => {
    registerStreamEvent("triple", noopFn, noopSchema);
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "a", use: "triple" },
      { name: "b", use: "triple" },
      { name: "c", use: "triple" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    const dups = findings.filter((f) => f.code === "dup_use");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.ruleNames).toEqual(["a", "b", "c"]);
  });
});

describe("lintRules — write-after-write detection", () => {
  test("two rules both writes: ['finalUsage'] → WARN write_after_write", () => {
    registerStreamEvent("writer-1", noopFn, noopSchema, {
      writes: ["finalUsage"],
    });
    registerStreamEvent("writer-2", noopFn, noopSchema, {
      writes: ["finalUsage"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "writer-1", use: "writer-1" },
      { name: "writer-2", use: "writer-2" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    const waw = findings.filter((f) => f.code === "write_after_write");
    expect(waw).toHaveLength(1);
    expect(waw[0]?.severity).toBe("warn");
    expect(waw[0]?.ruleNames).toContain("writer-1");
    expect(waw[0]?.ruleNames).toContain("writer-2");
    expect(waw[0]?.message).toContain("finalUsage");
  });

  test("independent writes (different fields) → no findings", () => {
    registerStreamEvent("writer-A", noopFn, noopSchema, {
      writes: ["fieldA"],
    });
    registerStreamEvent("writer-B", noopFn, noopSchema, {
      writes: ["fieldB"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "writer-A", use: "writer-A" },
      { name: "writer-B", use: "writer-B" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    expect(findings).toEqual([]);
  });
});

describe("lintRules — read-without-writer detection", () => {
  test("rule reads finalUsage, no prior writer → INFO read_without_writer", () => {
    registerStreamEvent("reader", noopFn, noopSchema, {
      reads: ["finalUsage"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "reader", use: "reader" }];
    const findings = lintRules(rules, snap, "stream_event");
    const rww = findings.filter((f) => f.code === "read_without_writer");
    expect(rww).toHaveLength(1);
    expect(rww[0]?.severity).toBe("info");
    expect(rww[0]?.ruleNames).toEqual(["reader"]);
    expect(rww[0]?.message).toContain("finalUsage");
  });

  test("reader after writer (correct ordering) → no read_without_writer finding", () => {
    registerStreamEvent("writer", noopFn, noopSchema, {
      writes: ["finalUsage"],
    });
    registerStreamEvent("reader", noopFn, noopSchema, {
      reads: ["finalUsage"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "writer", use: "writer" },
      { name: "reader", use: "reader" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    expect(findings.filter((f) => f.code === "read_without_writer")).toEqual(
      [],
    );
    // No write-after-write either (only one writer).
    expect(findings.filter((f) => f.code === "write_after_write")).toEqual([]);
  });

  test("reader BEFORE writer (wrong ordering) → INFO read_without_writer fires", () => {
    registerStreamEvent("late-writer", noopFn, noopSchema, {
      writes: ["finalUsage"],
    });
    registerStreamEvent("early-reader", noopFn, noopSchema, {
      reads: ["finalUsage"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "early-reader", use: "early-reader" },
      { name: "late-writer", use: "late-writer" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    const rww = findings.filter((f) => f.code === "read_without_writer");
    expect(rww).toHaveLength(1);
    expect(rww[0]?.ruleNames).toEqual(["early-reader"]);
  });
});

describe("lintRules — edge cases", () => {
  test("empty rule list → no findings, no throws", () => {
    const snap = snapshot("stream_event");
    const findings = lintRules([], snap, "stream_event");
    expect(findings).toEqual([]);
  });

  test("rule with no manifest (no reads/writes) → no findings", () => {
    registerStreamEvent("plain", noopFn, noopSchema);
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "plain", use: "plain" }];
    const findings = lintRules(rules, snap, "stream_event");
    expect(findings).toEqual([]);
  });

  test("unregistered rule.use → silently skipped (apply{,_event}.ts catches it loudly)", () => {
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "ghost", use: "ghost" }];
    // Lint must not throw even though the rule is unregistered.
    expect(() => lintRules(rules, snap, "stream_event")).not.toThrow();
  });

  test("rule both reads AND writes the same field — no spurious read_without_writer when prior writer exists", () => {
    registerStreamEvent("upstream-writer", noopFn, noopSchema, {
      writes: ["counter"],
    });
    registerStreamEvent("rmw", noopFn, noopSchema, {
      reads: ["counter"],
      writes: ["counter"],
    });
    const snap = snapshot("stream_event");
    const rules: Rule[] = [
      { name: "upstream-writer", use: "upstream-writer" },
      { name: "rmw", use: "rmw" },
    ];
    const findings = lintRules(rules, snap, "stream_event");
    // upstream-writer wrote counter before rmw reads it → no read_without_writer.
    expect(findings.filter((f) => f.code === "read_without_writer")).toEqual(
      [],
    );
    // BUT we should see write_after_write because both write counter.
    const waw = findings.filter((f) => f.code === "write_after_write");
    expect(waw).toHaveLength(1);
    expect(waw[0]?.ruleNames).toEqual(["upstream-writer", "rmw"]);
  });
});

// -----------------------------------------------------------------------------
// F5/M6 D-LOCK-3 — ctx-surface read-after-write detection
// -----------------------------------------------------------------------------

describe("lintRules — ctx_write_after_write (headers surface)", () => {
  test("two body rules both ctx_writes: ['headers'] → WARN ctx_write_after_write", () => {
    register("hdr-writer-1", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    register("hdr-writer-2", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "first", use: "hdr-writer-1" },
      { name: "second", use: "hdr-writer-2" },
    ];
    const findings = lintRules(rules, snap, "body");
    const waw = findings.filter((f) => f.code === "ctx_write_after_write");
    expect(waw).toHaveLength(1);
    expect(waw[0]?.severity).toBe("warn");
    expect(waw[0]?.ruleNames).toEqual(["first", "second"]);
    expect(waw[0]?.message).toContain("headers");
  });

  test("body rules with default ctx_writes (= ['body']) do NOT emit ctx_write_after_write (body intentionally skipped)", () => {
    register("body-writer-1", noopBodyFn, noopSchema);
    register("body-writer-2", noopBodyFn, noopSchema);
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "first", use: "body-writer-1" },
      { name: "second", use: "body-writer-2" },
    ];
    const findings = lintRules(rules, snap, "body");
    expect(findings.filter((f) => f.code === "ctx_write_after_write")).toEqual(
      [],
    );
  });
});

describe("lintRules — ctx_read_without_writer (headers surface)", () => {
  test("body rule reads headers, no prior writer → INFO ctx_read_without_writer", () => {
    register("hdr-reader", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: [],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "reader", use: "hdr-reader" }];
    const findings = lintRules(rules, snap, "body");
    const rww = findings.filter((f) => f.code === "ctx_read_without_writer");
    expect(rww).toHaveLength(1);
    expect(rww[0]?.severity).toBe("info");
    expect(rww[0]?.ruleNames).toEqual(["reader"]);
    expect(rww[0]?.message).toContain("headers");
  });

  test("reader after writer (correct ordering) → no ctx_read_without_writer finding", () => {
    register("writer", noopBodyFn, noopSchema, {
      ctx_reads: ["body"],
      ctx_writes: ["headers"],
    });
    register("reader", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: [],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "writer", use: "writer" },
      { name: "reader", use: "reader" },
    ];
    const findings = lintRules(rules, snap, "body");
    expect(
      findings.filter((f) => f.code === "ctx_read_without_writer"),
    ).toEqual([]);
    // No write-after-write since only one writer.
    expect(findings.filter((f) => f.code === "ctx_write_after_write")).toEqual(
      [],
    );
  });

  test("body-only rule reading body (default ctx_reads) does NOT emit ctx_read_without_writer (body intentionally skipped)", () => {
    register("body-only", noopBodyFn, noopSchema);
    const snap = snapshot("body");
    const rules: Rule[] = [{ name: "body-only", use: "body-only" }];
    const findings = lintRules(rules, snap, "body");
    expect(
      findings.filter((f) => f.code === "ctx_read_without_writer"),
    ).toEqual([]);
  });
});

describe("lintRules — ctx-surface mixed M3/M6 + edge cases", () => {
  test("declared ['body','headers'] writer + downstream headers reader → no ctx_read_without_writer", () => {
    register("redirect-like", noopBodyFn, noopSchema, {
      ctx_reads: ["body"],
      ctx_writes: ["body", "headers"],
    });
    register("hdr-reader-2", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: [],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "redirect-like", use: "redirect-like" },
      { name: "hdr-reader-2", use: "hdr-reader-2" },
    ];
    const findings = lintRules(rules, snap, "body");
    expect(
      findings.filter((f) => f.code === "ctx_read_without_writer"),
    ).toEqual([]);
  });

  test("mixed M3 (default) + M6 (declared headers) — only M6 ctx_writes counted, M3 do not collide", () => {
    register("m3-rule", noopBodyFn, noopSchema); // default ctx_writes: ["body"]
    register("m6-hdr-writer", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "m3-rule", use: "m3-rule" },
      { name: "m6-hdr-writer", use: "m6-hdr-writer" },
    ];
    const findings = lintRules(rules, snap, "body");
    // m3-rule writes ["body"] only; body is skipped → no findings.
    // m6-hdr-writer writes headers and reads headers — but is the FIRST
    // headers-writer in the chain. So no ctx_write_after_write, but the
    // reader-without-writer check should NOT fire either since the rule
    // both reads AND writes — and the read check fires BEFORE we record
    // its own write. So it WILL emit ctx_read_without_writer.
    const rww = findings.filter((f) => f.code === "ctx_read_without_writer");
    expect(rww).toHaveLength(1);
    expect(rww[0]?.ruleNames).toEqual(["m6-hdr-writer"]);
  });

  test("stream_event surface — ctx-surface findings never emit (ctx is body-engine concept)", () => {
    registerStreamEvent("se-rule", noopFn, noopSchema);
    const snap = snapshot("stream_event");
    const rules: Rule[] = [{ name: "se-rule", use: "se-rule" }];
    const findings = lintRules(rules, snap, "stream_event");
    expect(findings.filter((f) => f.code === "ctx_write_after_write")).toEqual(
      [],
    );
    expect(
      findings.filter((f) => f.code === "ctx_read_without_writer"),
    ).toEqual([]);
  });

  test("three rules all ctx_writes ['headers'] — emits 2 ctx_write_after_write findings", () => {
    register("w1", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    register("w2", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    register("w3", noopBodyFn, noopSchema, {
      ctx_reads: ["headers"],
      ctx_writes: ["headers"],
    });
    const snap = snapshot("body");
    const rules: Rule[] = [
      { name: "a", use: "w1" },
      { name: "b", use: "w2" },
      { name: "c", use: "w3" },
    ];
    const findings = lintRules(rules, snap, "body");
    const waw = findings.filter((f) => f.code === "ctx_write_after_write");
    // Two collision events: a→b and (a,b)→c.
    expect(waw).toHaveLength(2);
  });
});
