/**
 * translate_anthropic_to_responses.ts — body-engine rule: rewrite the
 * entire `ctx.body` from Anthropic `/v1/messages` shape to OpenAI
 * `/responses` shape (the "Responses API" used by GPT-5.x).
 *
 * **M7a primitive (built-in).** Self-registers at module load. Naming
 * convention `translate_<source>_to_<target>` per D-LOCK-8 / O19.
 *
 * **Lane (per addendum §7).** Consumed by **CC→GPT-5.x** ONLY.
 *
 * Lane: CC→GPT-5.x (consumer); NOT CC→Claude / CC→GPT-4.x legacy / Codex→Claude.
 *
 *   - **NOT** consumed by CC→Claude (passthrough, no translator).
 *   - **NOT** consumed by CC→GPT-4.x legacy (uses Chat Completions
 *     shape; the `translate_anthropic_tools_to_openai` translator
 *     covers that lane's tools-only rewrite).
 *   - **NOT** consumed by Codex→Claude (reverse direction; see
 *     `translate_responses_to_anthropic.ts`).
 *
 * **BODY-ONLY scope (D-LOCK-7).** Receives a complete request body and
 * returns a translated body. NO streaming / SSE concerns. The paired
 * SSE event-stream translator (Anthropic event → Responses events)
 * lives in M7b's `translateAnthropicEventToResponsesEvents` (bundle
 * line 2232) — separate primitive, separate engine surface.
 *
 * **Pure shape conversion.** Per D-LOCK-2, this rule does NOT call
 * `translate_model_name` (that's M6's `rename_model` rule, applied
 * separately in the YAML chain) and does NOT call `derive_effort`
 * (that's M6's `derive_reasoning_effort` rule). Its responsibility is
 * exclusively the `messages[]` ↔ `input[]` plus `system` →
 * `developer-message` shape rewrite.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § translateAnthropicToResponses` (line 1470). Bundle's
 * behavior plus deviations:
 *
 *   - **System** → prepend a `{type:"message", role:"developer",
 *     content:[{type:"input_text", text:...}]}` item to `input[]`.
 *     Bundle accepts both `string` and `Array<{text}>` shapes; v2 also
 *     ignores blocks where `text` is missing (the bundle would emit
 *     `undefined`).
 *   - **User messages** → split content into `tool_result` (become
 *     `function_call_output` items) and other blocks (become a
 *     `message` item with `input_text`/`input_image` content parts).
 *   - **Assistant messages** → split into text/thinking blocks (become
 *     a single `message` item with `output_text` content) and
 *     `tool_use` blocks (become individual `function_call` items).
 *   - **Tools** — bundle inlines its own translation (special-cases
 *     Anthropic `web_search_20250305` → OpenAI `web_search`). v2
 *     mirrors the bundle's inlined logic because the OpenAI Responses
 *     `tools` shape (`{type:"function", name, description, parameters,
 *     strict:false}` for functions; `{type:"web_search",
 *     search_context_size:"medium"}` for web_search) differs from the
 *     OpenAI Chat shape that `translate_anthropic_tools_to_openai`
 *     produces (`{type:"function", function:{...}}`). They are NOT
 *     interchangeable; do not delegate.
 *   - **`max_tokens`** → `max_output_tokens` (unchanged value).
 *   - **`stream`** preserved (default true if absent — bundle does
 *     `stream !== false`; v2 mirrors).
 *   - **Reasoning** — bundle wires `reasoning: { effort, summary }`
 *     using `deriveReasoningEffort` + `applyEffortOverride`. v2
 *     creates a `reasoning: { effort: "medium", summary: "detailed" }`
 *     placeholder so the body shape is well-formed; downstream rules
 *     (`derive_reasoning_effort` + `clamp_effort`) override `effort`
 *     in the YAML chain. Operators wanting bundle-equivalent default
 *     effort should chain `derive_reasoning_effort` AFTER this rule.
 *   - **`store: false`, `truncation: "disabled"`,
 *     `include: [...]`** — fixed defaults from the bundle.
 *   - **`tool_choice`, `parallel_tool_calls`, `prompt_cache_key`,
 *     `client_metadata`** — NOT emitted by the bundle's translator.
 *     v2 also does NOT emit them; rules that need to inject them can
 *     do so via `add_body_block` / `modify_body_block` later in the
 *     chain.
 *
 * **Call-id shortening.** Anthropic `tool_use.id` strings can exceed
 * OpenAI's 64-char `call_id` limit. Bundle's `shortenCallId` (line
 * 1457) maintains a process-global bidirectional map; v2 uses a
 * per-call local map (no cross-request state) since each request body
 * is self-consistent. The reverse mapping needed for stream-event
 * translation lives in M7b.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]`.
 *   - `ctx_writes: ["body"]` — mutates `ctx.body` IN PLACE by
 *     replacing the entire object's enumerable keys.
 *
 * **Behavior.**
 *   - If `ctx.body` is not a plain object → `applied: false`.
 *   - Else: build the translated payload, replace `ctx.body`'s keys
 *     in place (mutate-in-place semantics per O3), return
 *     `applied: true` with `before`/`after` snapshots.
 *
 * **Example config.**
 *
 * ```yaml
 * - name: translate_for_gpt5
 *   use: translate_anthropic_to_responses
 *   when:
 *     route: /v1/messages
 *     model_glob: "gpt-5*"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M7a — body translators (lane-scoped).
 *   - addendum §7 — lane-scoping discipline.
 *   - `translate_responses_to_anthropic.ts` — reverse direction.
 *   - M7b (planned) — paired SSE event-stream translator.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const TranslateAnthropicToResponsesSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_anthropic_to_responses"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    /**
     * Default `reasoning.effort` to emit. Operators typically chain
     * `derive_reasoning_effort` after this rule to override based on
     * the original request shape; this default is only the seed.
     */
    default_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    /**
     * Default `max_output_tokens` when source body's `max_tokens` is
     * missing. Bundle hardcodes 128000; v2 makes it overridable.
     */
    default_max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

type TranslateAnthropicToResponsesOpts = z.infer<
  typeof TranslateAnthropicToResponsesSchema
>;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Shorten an Anthropic `tool_use.id` to fit OpenAI's 64-char `call_id`
 * limit. Pass-through when already ≤64 chars. Otherwise produce a
 * stable per-request short id; the local Map ensures the same long id
 * always maps to the same short id WITHIN this single body translation
 * (so a later `function_call_output` referencing the same call points
 * at the right shortened id). Cross-request mapping is M7b's concern.
 */
function makeShortener(): (longId: string) => string {
  const cache = new Map<string, string>();
  return (longId: string): string => {
    if (longId.length <= 64) return longId;
    const cached = cache.get(longId);
    if (cached !== undefined) return cached;
    const short = "fc_proxy_" + randomUUID().replace(/-/g, "").slice(0, 20);
    cache.set(longId, short);
    return short;
  };
}

/** Anthropic content block shapes. */
type AnthropicTextBlock = { type: "text"; text?: string };
type AnthropicThinkingBlock = { type: "thinking"; text?: string };
type AnthropicImageBlock = {
  type: "image";
  source?: { data?: string; media_type?: string; type?: string; url?: string };
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | AnthropicContentBlock[];
}

/**
 * Stringify a `tool_result.content` value to the OpenAI
 * `function_call_output.output` string form. Mirrors bundle line 1493.
 */
function toolResultToOutputString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b as { text?: unknown }).text ?? "")
      .map((t) => (typeof t === "string" ? t : JSON.stringify(t)))
      .join("");
  }
  return JSON.stringify(content);
}

/**
 * Translate one Anthropic content block (image or text) into a
 * Responses-API `input_text` / `input_image` content part. Unknown
 * types are JSON-stringified into an `input_text` part — preserves the
 * payload (per D9: don't silently drop) without throwing.
 */
function blockToInputContent(b: AnthropicContentBlock): {
  type: string;
  [k: string]: unknown;
} {
  if (b.type === "text") {
    return { type: "input_text", text: (b as AnthropicTextBlock).text ?? "" };
  }
  if (b.type === "image") {
    const src = (b as AnthropicImageBlock).source ?? {};
    const data = src.data;
    const mediaType = src.media_type;
    const url = src.url;
    if (data && mediaType) {
      return {
        type: "input_image",
        image_url: `data:${mediaType};base64,${data}`,
      };
    }
    return { type: "input_image", image_url: url ?? "" };
  }
  return { type: "input_text", text: JSON.stringify(b) };
}

/**
 * Anthropic → Responses translation core. Returns the new body as a
 * fresh object; caller decides whether to mutate-in-place.
 */
function translateBody(
  src: Record<string, unknown>,
  opts: TranslateAnthropicToResponsesOpts,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  const shortenCallId = makeShortener();

  // 1. System → developer message at start of input[].
  const sys = src.system;
  if (sys !== undefined && sys !== null) {
    let texts: string[];
    if (typeof sys === "string") {
      texts = [sys];
    } else if (Array.isArray(sys)) {
      texts = sys
        .map((b) => {
          if (typeof b === "string") return b;
          if (b !== null && typeof b === "object") {
            const t = (b as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          }
          return "";
        })
        .filter((t) => t.length > 0);
    } else {
      texts = [];
    }
    if (texts.length > 0) {
      input.push({
        type: "message",
        role: "developer",
        content: texts.map((t) => ({ type: "input_text", text: t })),
      });
    }
  }

  // 2. Messages → input[] items.
  const messages = Array.isArray(src.messages)
    ? (src.messages as AnthropicMessage[])
    : [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const toolResults: AnthropicToolResultBlock[] = [];
        const otherBlocks: AnthropicContentBlock[] = [];
        for (const b of msg.content) {
          if (b.type === "tool_result") {
            toolResults.push(b as AnthropicToolResultBlock);
          } else {
            otherBlocks.push(b);
          }
        }
        // tool_results → function_call_output items (one per result).
        for (const tr of toolResults) {
          const longId = tr.tool_use_id ?? "";
          input.push({
            type: "function_call_output",
            call_id: shortenCallId(longId),
            output: toolResultToOutputString(tr.content),
          });
        }
        if (otherBlocks.length > 0) {
          input.push({
            type: "message",
            role: "user",
            content: otherBlocks.map((b) => blockToInputContent(b)),
          });
        }
      } else {
        // string content
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textBlocks: Array<AnthropicTextBlock | AnthropicThinkingBlock> =
          [];
        const toolUseBlocks: AnthropicToolUseBlock[] = [];
        for (const b of msg.content) {
          if (b.type === "text" || b.type === "thinking") {
            textBlocks.push(b as AnthropicTextBlock | AnthropicThinkingBlock);
          } else if (b.type === "tool_use") {
            toolUseBlocks.push(b as AnthropicToolUseBlock);
          }
          // Unknown block types in assistant content are dropped (per
          // bundle behavior). Could surface as warning in M9.
        }
        if (textBlocks.length > 0) {
          const text = textBlocks.map((b) => b.text ?? "").join("");
          if (text.length > 0) {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
        }
        // Each tool_use → individual function_call item.
        for (const tu of toolUseBlocks) {
          const longId = tu.id ?? "";
          const safeId = shortenCallId(longId);
          // Bundle (line 1541) wraps non-`fc_`-prefixed safeIds with
          // `fc_${safeId.replace(/^toolu_/,'')}`. Replicate.
          const itemId = safeId.startsWith("fc")
            ? safeId
            : `fc_${safeId.replace(/^toolu_/, "")}`;
          input.push({
            type: "function_call",
            id: itemId,
            call_id: safeId,
            name: tu.name ?? "",
            arguments:
              typeof tu.input === "string"
                ? tu.input
                : JSON.stringify(tu.input ?? {}),
          });
        }
      } else {
        // string content
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      }
    }
    // Unknown role → drop (bundle ignores too). System role is only
    // valid via the `system` field, not as a message.
  }

  // 3. Tools (inline; bundle handles web_search special-case).
  const srcTools = Array.isArray(src.tools) ? src.tools : [];
  const tools: Array<Record<string, unknown>> = [];
  for (const t of srcTools as Array<Record<string, unknown>>) {
    if (t.type === "web_search_20250305") {
      const ws: Record<string, unknown> = {
        type: "web_search",
        search_context_size: "medium",
      };
      if (Array.isArray(t.allowed_domains)) {
        ws.filters = { allowed_domains: t.allowed_domains };
      }
      tools.push(ws);
    } else {
      tools.push({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        strict: false,
      });
    }
  }

  // 4. Build payload.
  const maxTokens =
    typeof src.max_tokens === "number"
      ? src.max_tokens
      : (opts.default_max_output_tokens ?? 128000);
  const stream = src.stream !== false;
  const effort = opts.default_effort ?? "medium";

  const out: Record<string, unknown> = {
    model: src.model,
    input,
    stream,
    max_output_tokens: maxTokens,
    reasoning: { effort, summary: "detailed" },
    store: false,
    truncation: "disabled",
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
  };
  if (tools.length > 0) out.tools = tools;
  return out;
}

const translate_anthropic_to_responses: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as TranslateAnthropicToResponsesOpts;
  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const before = structuredClone(ctx.body);
  const src = ctx.body as Record<string, unknown>;
  const out = translateBody(src, opts);

  // Mutate-in-place: replace src's keys with out's keys.
  for (const k of Object.keys(src)) {
    delete src[k];
  }
  Object.assign(src, out);

  return { ctx, applied: true, before, after: structuredClone(out) };
};

register(
  "translate_anthropic_to_responses",
  translate_anthropic_to_responses,
  TranslateAnthropicToResponsesSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
  },
);

export {
  translate_anthropic_to_responses,
  TranslateAnthropicToResponsesSchema,
};
