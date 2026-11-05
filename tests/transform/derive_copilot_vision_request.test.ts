/**
 * derive_copilot_vision_request.test.ts — per-rule unit tests for the M9
 * (D33) `derive_copilot_vision_request` body rule (M9 D-LOCK-3 + D-LOCK-18).
 *
 * Coverage maps to M9 mini-audit items 12-18:
 *   - schema validation + registry metadata (ctx_reads/ctx_writes)
 *   - per-shape detection (Anthropic image, OpenAI Responses input_image,
 *     OpenAI Chat image_url)
 *   - default value_when_absent: null → no header touch
 *   - custom value_when_absent: "false" → header forced
 *   - D-LOCK-18 default materialization: omit header_name +
 *     value_when_present → writes "copilot-vision-request": "true"
 */

import { afterEach, describe, expect, test } from "bun:test";

import { applyRules } from "~/lib/transform/apply";
import { reset as resetPredicate } from "~/lib/transform/predicate";
import {
  get,
  reset as resetRegistry,
  snapshot,
} from "~/lib/transform/registry";
import { DeriveCopilotVisionRequestSchema } from "~/lib/transform/derive_copilot_vision_request";
import "~/lib/transform/derive_copilot_vision_request";
import type { Rule, TransformContext } from "~/lib/transform/types";

afterEach(() => {
  resetRegistry();
  resetPredicate();
});

async function registerRule(): Promise<void> {
  const mod = await import("~/lib/transform/derive_copilot_vision_request");
  const { register } = await import("~/lib/transform/registry");
  register(
    "derive_copilot_vision_request",
    mod.derive_copilot_vision_request,
    mod.DeriveCopilotVisionRequestSchema,
    {
      ctx_reads: ["body"],
      ctx_writes: ["headers"],
      allow_override: true,
    },
  );
}

function makeCtx(
  body: unknown,
  headers: Record<string, string> = {},
): TransformContext {
  return {
    body,
    headers,
    route: "/v1/messages",
    model: "claude-opus-4.7",
  };
}

describe("derive_copilot_vision_request — schema validation", () => {
  test("minimal valid config (all defaults applied)", () => {
    const r = DeriveCopilotVisionRequestSchema.safeParse({
      name: "x",
      use: "derive_copilot_vision_request",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.header_name).toBe("copilot-vision-request");
      expect(r.data.value_when_present).toBe("true");
      expect(r.data.value_when_absent).toBeNull();
    }
  });

  test("custom value_when_absent: 'false' accepted", () => {
    const r = DeriveCopilotVisionRequestSchema.safeParse({
      name: "x",
      use: "derive_copilot_vision_request",
      value_when_absent: "false",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.value_when_absent).toBe("false");
    }
  });
});

describe("derive_copilot_vision_request — registry metadata (mini-audit 10)", () => {
  test("ctx_reads = ['body'], ctx_writes = ['headers']", async () => {
    await registerRule();
    const reg = get("body", "derive_copilot_vision_request");
    expect(reg).toBeDefined();
    expect(reg?.opts.ctx_reads).toEqual(["body"]);
    expect(reg?.opts.ctx_writes).toEqual(["headers"]);
  });

  test("no response_shape declared", async () => {
    await registerRule();
    const reg = get("body", "derive_copilot_vision_request");
    expect(reg?.opts.response_shape).toBeUndefined();
  });
});

describe("derive_copilot_vision_request — detection (D-LOCK-3 mini-audit 12-16)", () => {
  test("mini-audit 12: body with no messages → applied:false (default value_when_absent: null)", async () => {
    await registerRule();
    const snap = snapshot("body");
    const ctx = makeCtx({});
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["copilot-vision-request"]).toBeUndefined();
  });

  test("mini-audit 13: body with text-only content → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["copilot-vision-request"]).toBeUndefined();
  });

  test("mini-audit 14: Anthropic-shape {type: 'image'} block → header 'true'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });

  test("mini-audit 15: OpenAI-Responses-shape {type: 'input_image'} block → header 'true'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: { url: "data:image/png;base64,...", detail: "auto" },
            },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });

  test("mini-audit 16: OpenAI-Chat-shape {image_url: {...}} block → header 'true'", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            // OpenAI Chat shape: image_url field present (type may be "image_url" or omitted)
            { image_url: { url: "https://example.com/x.png" } },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });

  test("image found in non-last message also detected", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "I see it." }] },
        { role: "user", content: [{ type: "text", text: "thanks" }] },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });
});

describe("derive_copilot_vision_request — value_when_absent override (mini-audit 17)", () => {
  test("custom value_when_absent: 'false' + no images → header 'false', applied:true", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_copilot_vision_request",
        value_when_absent: "false",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("false");
  });

  test("idempotency: pre-set 'copilot-vision-request: true' + image found → applied:false", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
          ],
        },
      ],
    };
    const ctx = makeCtx(body, { "copilot-vision-request": "true" });
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toEqual([]);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });
});

describe("derive_copilot_vision_request — D-LOCK-18 default materialization (mini-audit 18)", () => {
  test("omitting header_name + value_when_present → writes literal 'copilot-vision-request': 'true' on image found", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "..." },
            },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    // Rule config OMITS header_name, value_when_present, value_when_absent —
    // proves zod defaults were materialized at runtime via Schema.parse.
    const rules: Rule[] = [{ name: "r", use: "derive_copilot_vision_request" }];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["copilot-vision-request"]).toBe("true");
  });

  test("custom header_name writes to that key (not 'copilot-vision-request')", async () => {
    await registerRule();
    const snap = snapshot("body");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
          ],
        },
      ],
    };
    const ctx = makeCtx(body);
    const rules: Rule[] = [
      {
        name: "r",
        use: "derive_copilot_vision_request",
        header_name: "x-vision",
      },
    ];
    const result = await applyRules(ctx, rules, snap);
    expect(result.applied).toHaveLength(1);
    expect(result.ctx.headers["x-vision"]).toBe("true");
    expect(result.ctx.headers["copilot-vision-request"]).toBeUndefined();
  });
});
