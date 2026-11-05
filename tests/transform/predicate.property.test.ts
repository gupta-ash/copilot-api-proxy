/**
 * predicate.property.test.ts — L2 design refinement (property-based testing
 * via fast-check). Anchors the predicate engine against future regression
 * as more `When` keys get added in M5+.
 *
 * Two properties:
 *   1. **deterministic** — same inputs produce same output across two
 *      successive calls (tests the compile-cache doesn't have side
 *      effects between calls).
 *   2. **total** — no inputs, however arbitrary, cause `evaluate` to
 *      throw (the contract is "no throws to caller").
 *
 * Budget: 200 iterations × 2 properties = 400 evaluations; must complete
 * in <2s under bun.
 */

import { describe, test } from "bun:test";
import * as fc from "fast-check";

import { evaluate, reset } from "~/lib/transform/predicate";
import type {
  StreamEventContext,
  TransformContext,
  When,
} from "~/lib/transform/types";

/**
 * Arbitrary `When` — every field is optional (withDeletedKeys: true) and
 * contains realistic values. We deliberately include some malformed
 * `model_regex` candidates so the catch-fallback path gets exercised.
 */
const arbWhen = fc.record(
  {
    route: fc.constantFrom(
      "/v1/messages",
      "/responses",
      "/chat/completions",
      "/embeddings",
      "/metrics",
    ),
    method: fc.constantFrom("GET", "POST"),
    model: fc.string({ minLength: 0, maxLength: 32 }),
    model_glob: fc.constantFrom(
      "*",
      "claude-*",
      "*-opus-*",
      "?",
      "claude.4.7",
      "[invalid",
      "",
    ),
    model_regex: fc.constantFrom(
      "^claude-",
      "[unclosed",
      "(",
      ".*",
      "^$",
      "valid|alts",
    ),
    model_in: fc.array(fc.string({ maxLength: 16 }), { maxLength: 5 }),
    harness: fc.constantFrom("cc", "codex", "omp", "vscode-cc-sdk", ""),
    request_endpoint: fc.constantFrom(
      "/v1/messages",
      "/responses",
      "/chat/completions",
    ),
    request_model_glob: fc.constantFrom("claude-*", "*-4.7", "?", "*"),
    event_types: fc.array(
      fc.constantFrom(
        "response.created",
        "response.completed",
        "message_start",
        "message_delta",
        "message_stop",
      ),
      { maxLength: 4 },
    ),
  },
  { withDeletedKeys: true },
) as fc.Arbitrary<When>;

/**
 * Arbitrary `TransformContext` — body/headers/route/model populated with
 * realistic shapes; optional fields randomly present.
 */
const arbBodyCtx = fc.record({
  body: fc.option(fc.anything(), { nil: undefined }),
  headers: fc.dictionary(
    fc.string({ maxLength: 16 }),
    fc.string({ maxLength: 32 }),
  ),
  route: fc.constantFrom(
    "/v1/messages",
    "/responses",
    "/chat/completions",
    "/embeddings",
  ),
  model: fc.string({ maxLength: 32 }),
  harness: fc.option(fc.constantFrom("cc", "codex", "omp", "vscode-cc-sdk"), {
    nil: undefined,
  }),
  request_endpoint: fc.option(fc.constantFrom("/v1/messages", "/responses"), {
    nil: undefined,
  }),
  request_model: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
}) as fc.Arbitrary<TransformContext>;

/**
 * Arbitrary `StreamEventContext` — also exercises the event_types branch.
 */
const arbEventCtx = fc.record({
  event: fc.record({
    type: fc.constantFrom(
      "response.created",
      "response.completed",
      "message_start",
      "message_delta",
      "message_stop",
      "ping",
    ),
  }),
  state: fc.dictionary(fc.string({ maxLength: 16 }), fc.anything()),
  route: fc.constantFrom("/v1/messages", "/responses"),
  model: fc.string({ maxLength: 32 }),
  request_endpoint: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  request_model: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
}) as fc.Arbitrary<StreamEventContext>;

const arbAnyCtx = fc.oneof(arbBodyCtx, arbEventCtx);

describe("predicate.evaluate (property-based)", () => {
  test("deterministic — same inputs produce same output across two calls", () => {
    fc.assert(
      fc.property(arbWhen, arbAnyCtx, (when, ctx) => {
        // Reset cache between iterations so cache state can't bias the
        // second call vs the first.
        reset();
        const a = evaluate(when, ctx);
        const b = evaluate(when, ctx);
        return a === b;
      }),
      { numRuns: 200 },
    );
  });

  test("total — no inputs, however arbitrary, cause evaluate to throw", () => {
    fc.assert(
      fc.property(arbWhen, arbAnyCtx, (when, ctx) => {
        reset();
        // The contract: must not throw. Just calling without a try/catch
        // is the assertion — fast-check shrinks any thrown error to a
        // minimal counterexample.
        evaluate(when, ctx);
      }),
      { numRuns: 200 },
    );
  });
});
