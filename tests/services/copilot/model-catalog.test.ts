/**
 * model-catalog.test.ts — unit coverage for `parseModelCatalog()`.
 *
 * The network path (`fetchModelCatalog` → `getModels`) is covered by
 * get-models / route-handler coverage; here we pin the pure parse logic that
 * turns the upstream payload into a sorted, de-duplicated id list.
 */

import { describe, expect, it } from "bun:test";

import { parseModelCatalog } from "../../../src/services/copilot/model-catalog.ts";

describe("parseModelCatalog", () => {
  it("parses the OpenAI-style { data: [...] } envelope and sorts ids", () => {
    const out = parseModelCatalog({
      object: "list",
      data: [
        { id: "gpt-5.5" },
        { id: "claude-opus-4.8" },
        { id: "claude-haiku-4.5" },
      ],
    });
    expect(out.ids).toEqual(["claude-haiku-4.5", "claude-opus-4.8", "gpt-5.5"]);
    expect(out.count).toBe(3);
  });

  it("parses a bare array shape", () => {
    const out = parseModelCatalog([{ id: "b-model" }, { id: "a-model" }]);
    expect(out.ids).toEqual(["a-model", "b-model"]);
    expect(out.count).toBe(2);
  });

  it("de-duplicates repeated ids", () => {
    const out = parseModelCatalog({
      data: [{ id: "x" }, { id: "x" }, { id: "y" }],
    });
    expect(out.ids).toEqual(["x", "y"]);
    expect(out.count).toBe(2);
  });

  it("skips entries without a string id (never throws on shape surprise)", () => {
    const out = parseModelCatalog({
      data: [
        { id: "ok" },
        { id: 123 },
        { noId: true },
        null,
        "str",
        { id: "ok2" },
      ],
    });
    expect(out.ids).toEqual(["ok", "ok2"]);
    expect(out.count).toBe(2);
  });

  it("returns an empty list for malformed / empty payloads", () => {
    expect(parseModelCatalog({}).ids).toEqual([]);
    expect(parseModelCatalog({ data: "not-an-array" }).count).toBe(0);
    expect(parseModelCatalog(null).count).toBe(0);
    expect(parseModelCatalog(undefined).count).toBe(0);
    expect(parseModelCatalog(42).count).toBe(0);
  });
});
