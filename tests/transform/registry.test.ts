/**
 * registry.test.ts — verifies the two-engine registry contract:
 *   - register / registerStreamEvent happy path
 *   - get(surface, name) for both surfaces
 *   - list(surface) returns insertion-order names
 *   - snapshot(surface) returns a frozen-by-type Map
 *   - RuleAlreadyRegisteredError thrown on duplicate name
 *   - allow_override: true permits replacement
 *   - same name in body + stream_event registries simultaneously (cross-surface)
 *   - reset() clears both
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  RuleAlreadyRegisteredError,
  get,
  list,
  register,
  registerStreamEvent,
  reset,
  snapshot,
} from "~/lib/transform/registry";
import type { StreamEventResult, TransformResult } from "~/lib/transform/types";

const noopSchema = z
  .object({
    name: z.string(),
    use: z.string(),
  })
  .passthrough();

const noopBodyFn = (): TransformResult => ({
  ctx: { body: null, headers: {}, route: "/", model: "x" },
  applied: false,
});

const noopStreamFn = (): StreamEventResult => ({
  events_out: [],
  applied: false,
});

afterEach(() => {
  reset();
});

describe("registry — body surface", () => {
  test("register + get round-trips the fn, schema, and opts", () => {
    register("noop", noopBodyFn, noopSchema);
    const r = get("body", "noop");
    expect(r).toBeDefined();
    expect(r?.fn).toBe(noopBodyFn);
    expect(r?.schema).toBe(noopSchema);
    // mutate_in_place defaults to true for built-ins per O3
    expect(r?.opts.mutate_in_place).toBe(true);
    expect(r?.opts.allow_override).toBe(false);
  });

  test("register honors explicit mutate_in_place: false", () => {
    register("clone-rule", noopBodyFn, noopSchema, { mutate_in_place: false });
    const r = get("body", "clone-rule");
    expect(r?.opts.mutate_in_place).toBe(false);
  });

  test("register stores reads/writes/response_shape/version on opts", () => {
    register("manifest-rule", noopBodyFn, noopSchema, {
      reads: ["finalUsage"],
      writes: ["finalUsage", "delta_count"],
      response_shape: "anthropic_v1_messages",
      version: "^1.0.0",
    });
    const r = get("body", "manifest-rule");
    expect(r?.opts.reads).toEqual(["finalUsage"]);
    expect(r?.opts.writes).toEqual(["finalUsage", "delta_count"]);
    expect(r?.opts.response_shape).toBe("anthropic_v1_messages");
    expect(r?.opts.version).toBe("^1.0.0");
  });

  test("duplicate name without allow_override throws RuleAlreadyRegisteredError", () => {
    register("dup", noopBodyFn, noopSchema);
    expect(() => register("dup", noopBodyFn, noopSchema)).toThrow(
      RuleAlreadyRegisteredError,
    );
  });

  test("duplicate name with allow_override: true replaces", () => {
    register("override-me", noopBodyFn, noopSchema);
    const newFn = (): TransformResult => ({
      ctx: { body: "new", headers: {}, route: "/", model: "x" },
      applied: true,
    });
    register("override-me", newFn, noopSchema, { allow_override: true });
    const r = get("body", "override-me");
    expect(r?.fn).toBe(newFn);
  });

  test("get returns undefined for missing name", () => {
    expect(get("body", "nonexistent")).toBeUndefined();
  });

  test("list returns registered names in insertion order", () => {
    reset();
    register("a", noopBodyFn, noopSchema);
    register("b", noopBodyFn, noopSchema);
    register("c", noopBodyFn, noopSchema);
    expect(list("body")).toEqual(["a", "b", "c"]);
  });
});

describe("registry — stream-event surface", () => {
  test("registerStreamEvent + get round-trips", () => {
    registerStreamEvent("noop-event", noopStreamFn, noopSchema);
    const r = get("stream_event", "noop-event");
    expect(r).toBeDefined();
    expect(r?.fn).toBe(noopStreamFn);
    expect(r?.opts.mutate_in_place).toBe(true);
  });

  test("duplicate stream-event name throws RuleAlreadyRegisteredError", () => {
    registerStreamEvent("dup-event", noopStreamFn, noopSchema);
    expect(() =>
      registerStreamEvent("dup-event", noopStreamFn, noopSchema),
    ).toThrow(RuleAlreadyRegisteredError);
  });

  test("list('stream_event') is independent of list('body')", () => {
    reset();
    register("body-only", noopBodyFn, noopSchema);
    registerStreamEvent("event-only", noopStreamFn, noopSchema);
    expect(list("body")).toEqual(["body-only"]);
    expect(list("stream_event")).toEqual(["event-only"]);
  });
});

describe("registry — cross-surface independence", () => {
  test("same name CAN exist in both registries (different namespaces)", () => {
    register("shared-name", noopBodyFn, noopSchema);
    registerStreamEvent("shared-name", noopStreamFn, noopSchema);
    expect(get("body", "shared-name")?.fn).toBe(noopBodyFn);
    expect(get("stream_event", "shared-name")?.fn).toBe(noopStreamFn);
  });
});

describe("registry — snapshot semantics (per O4)", () => {
  test("snapshot('body') returns a frozen-by-type ReadonlyMap", () => {
    register("snap-target", noopBodyFn, noopSchema);
    const snap = snapshot("body");
    expect(snap.get("snap-target")?.fn).toBe(noopBodyFn);
    // ReadonlyMap doesn't expose `set`/`clear`/`delete` in the type system.
    // The runtime Map is mutable in JS, but TypeScript blocks accidental writes.
    // Verify the value at runtime: snap is a separate Map instance from
    // body_registry, so registering more rules does NOT affect it.
    register("post-snap", noopBodyFn, noopSchema);
    expect(snap.has("post-snap")).toBe(false);
    expect(get("body", "post-snap")).toBeDefined();
  });

  test("snapshot('stream_event') is independent of body snapshot", () => {
    register("body-rule", noopBodyFn, noopSchema);
    registerStreamEvent("event-rule", noopStreamFn, noopSchema);
    const bodySnap = snapshot("body");
    const eventSnap = snapshot("stream_event");
    expect(bodySnap.has("body-rule")).toBe(true);
    expect(bodySnap.has("event-rule")).toBe(false);
    expect(eventSnap.has("event-rule")).toBe(true);
    expect(eventSnap.has("body-rule")).toBe(false);
  });
});

describe("registry — reset()", () => {
  test("reset clears both registries", () => {
    register("body-x", noopBodyFn, noopSchema);
    registerStreamEvent("event-x", noopStreamFn, noopSchema);
    reset();
    expect(list("body")).toEqual([]);
    expect(list("stream_event")).toEqual([]);
    expect(get("body", "body-x")).toBeUndefined();
    expect(get("stream_event", "event-x")).toBeUndefined();
  });
});
