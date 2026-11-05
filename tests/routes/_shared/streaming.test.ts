/**
 * streaming.test.ts — isStreamingResponse predicate verification.
 *
 * Mini-audit item 23b: this is the canonical definition; no other module
 * re-defines `isStreamingResponse`. Service callers and route handlers
 * import from here.
 */

import { describe, expect, it } from "bun:test";

import { isStreamingResponse } from "../../../src/routes/_shared/streaming.ts";

function mockResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe("isStreamingResponse", () => {
  it("returns true for content-type: text/event-stream", () => {
    expect(
      isStreamingResponse(
        mockResponse({ "content-type": "text/event-stream" }),
      ),
    ).toBe(true);
  });
  it("returns true for content-type with charset parameter", () => {
    expect(
      isStreamingResponse(
        mockResponse({ "content-type": "text/event-stream; charset=utf-8" }),
      ),
    ).toBe(true);
  });
  it("returns false for application/json", () => {
    expect(
      isStreamingResponse(mockResponse({ "content-type": "application/json" })),
    ).toBe(false);
  });
  it("returns false when content-type missing", () => {
    expect(isStreamingResponse(mockResponse({}))).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(
      isStreamingResponse(
        mockResponse({ "content-type": "Text/Event-Stream" }),
      ),
    ).toBe(true);
  });
});
