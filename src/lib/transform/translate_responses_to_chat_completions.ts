/**
 * Convert a complete OpenAI Responses request body to Chat Completions shape.
 * Independently implemented using the public OpenAI API shapes and the sibling
 * body translators; this is not a port of a legacy bundle conversion routine.
 * It is body-only and does not provide an SSE response translator or enable a
 * default route. Operators must configure compatible routing separately.
 *
 * `instructions` becomes a leading system message; developer messages also
 * become system messages, retaining document order. Message items may omit
 * `type` when role and string/array content identify them. Text parts are
 * combined; image parts retain usable sources, and unsupported shapes use a
 * visible JSON text fallback rather than silently disappearing.
 *
 * Function calls use call_id and consecutive calls coalesce into one assistant
 * message. Function outputs become tool messages without reordering. Reasoning
 * items are omitted because Chat has no equivalent representation. Function
 * tools and tool_choice are converted; unsupported tool types are omitted with
 * snapshot visibility. Unknown input items use a visible text fallback.
 *
 * Only supported top-level fields are forwarded. max_output_tokens is renamed
 * to max_tokens; stream preserves explicit client intent and is omitted when
 * absent. The context body is replaced in place and before/after snapshots are
 * reported. Non-object/array bodies return applied=false.
 *
 * Public specifications:
 * https://platform.openai.com/docs/api-reference/responses
 * https://platform.openai.com/docs/api-reference/chat
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const TranslateResponsesToChatCompletionsSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_responses_to_chat_completions"),
    when: z.unknown().optional(),
    on_error: z
      .enum([
        "continue",
        "continue_passthrough",
        "abort_with_500",
        "abort_with_502",
      ])
      .optional(),
    /** Default `max_tokens` to emit when source body's `max_output_tokens` is missing. Default: 4096. */
    default_max_tokens: z.number().int().positive().optional(),
    /**
     * When true (default), DROP `reasoning` items from input[] (GPT-4
     * doesn't support reasoning). Default-true semantics implemented in
     * body code via `opts.drop_reasoning !== false` pattern (mirrors
     * `src.stream !== false` at translate_anthropic_to_responses.ts:418);
     * zod schema declares this as plain optional (NO `.default(true)`)
     * so the wrapper logic carries the default uniformly and schema
     * introspection stays clean.
     */
    drop_reasoning: z.boolean().optional(),
    /**
     * When true (default), drop the `previous_response_id` field instead
     * of leaving it in output. Same default-true pattern as
     * `drop_reasoning`. Chat Completions has no equivalent of Responses
     * conversation-chaining via `previous_response_id`; passing it
     * through would yield a 400 from upstream.
     */
    drop_previous_response_id: z.boolean().optional(),
  })
  .passthrough();

type TranslateResponsesToChatCompletionsOpts = z.infer<
  typeof TranslateResponsesToChatCompletionsSchema
>;

// -----------------------------------------------------------------------------
// Helper types — Responses input[] item shapes + Chat message shapes
// -----------------------------------------------------------------------------

interface ResponsesContentPart {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  url?: string;
  // M16.5.1 N-3: inline base64 image carrier fields. The OpenAI
  // Responses spec admits both `data + media_type` (newer, OpenAI-doc
  // primary) and `image_data + image_mediatype` (older alternative seen
  // in some clients). The translator accepts either field-name
  // convention and converts to a Chat data URL — see
  // `contentPartToChatPart`.
  data?: string;
  media_type?: string;
  image_data?: string;
  image_mediatype?: string;
  [k: string]: unknown;
}

interface ResponsesMessageItem {
  type: "message";
  role?: string;
  content?: string | ResponsesContentPart[];
  [k: string]: unknown;
}

interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id?: string;
  output?: unknown;
  [k: string]: unknown;
}

interface ResponsesReasoningItem {
  type: "reasoning";
  [k: string]: unknown;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | { type?: string; [k: string]: unknown };

/** Chat Completions content-part shapes (when content is array form). */
type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A single `tool_calls[]` entry on a Chat assistant message. */
interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Chat message shape — homogeneous (unlike Responses input[]). */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [k: string]: unknown;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Extract a string from a single Responses content part. Used for the
 * "all parts are text" collapse path. Returns `null` for non-text parts
 * (caller switches to array-form Chat content).
 */
function contentPartToString(part: ResponsesContentPart): string | null {
  if (part.type === "input_text" || part.type === "output_text") {
    return typeof part.text === "string" ? part.text : "";
  }
  return null;
}

/**
 * Extract a Chat content-part from a Responses content part. Used when
 * any non-text part is present and we must emit array-form Chat content.
 * Unknown types are JSON-stringified into a text part (per D9).
 */
function contentPartToChatPart(part: ResponsesContentPart): ChatContentPart {
  if (part.type === "input_text" || part.type === "output_text") {
    return {
      type: "text",
      text: typeof part.text === "string" ? part.text : "",
    };
  }
  if (part.type === "input_image") {
    // FIRST priority (per M16.5.1 N-3 + M16.5 spec R3): inline data +
    // media_type → Chat data URL. Some Responses clients (and OpenAI's
    // own spec) carry images as base64 data with an explicit media type
    // rather than a URL. Convert to a Chat-shape `image_url` whose URL
    // is the synthesized `data:<mediatype>;base64,<data>` form.
    //
    // Defensive field-name handling: the spec hint mentions both
    // `data + media_type` (newer) and `image_data + image_mediatype`
    // (older alternative). Accept either convention — the branch
    // triggers when BOTH a string-typed data field AND a string-typed
    // media-type field are present. Pre-fix M16.5: this priority path
    // was missing, so well-formed base64-inline images fell through to
    // either the legacy `image_url` handling (no match) or the
    // text-JSON fallback (M-2), corrupting the request.
    const partRec = part as Record<string, unknown>;
    const inlineData =
      typeof partRec.data === "string"
        ? partRec.data
        : typeof partRec.image_data === "string"
          ? partRec.image_data
          : null;
    const inlineMediaType =
      typeof partRec.media_type === "string"
        ? partRec.media_type
        : typeof partRec.image_mediatype === "string"
          ? partRec.image_mediatype
          : null;
    // M16.5.3 D-2 (post-exec discriminator iter-4): tightened guard to
    // require non-empty strings. Empty-string inline carriers used to
    // short-circuit valid URL fallbacks, producing malformed
    // `data:;base64,` data URLs. The `length > 0` check is symmetric
    // with the URL branch below (line ~417).
    if (
      inlineData !== null &&
      inlineMediaType !== null &&
      inlineData.length > 0 &&
      inlineMediaType.length > 0
    ) {
      return {
        type: "image_url",
        image_url: { url: `data:${inlineMediaType};base64,${inlineData}` },
      };
    }

    // M16.5.4 D-3 (post-exec discriminator iter-5): per-priority cascade
    // with `length > 0` check at each branch + explicit fall-through.
    // Mirrors the sibling Anthropic translator's pattern at
    // `translate_responses_to_anthropic.ts` `inputContentToBlock` (M16.5.2
    // N-5). Pre-fix: a single shared `url` variable was assigned by the
    // first matching branch even when empty, blocking subsequent
    // fallbacks (e.g., empty `image_url` starved a valid legacy
    // `part.url`, dropping the image as JSON text). Post-fix: each
    // priority is independent and explicitly falls through on empty/
    // missing — cross-translator URL-cascade symmetry achieved.
    //
    // SECOND priority: `image_url` as STRING.
    if (typeof part.image_url === "string" && part.image_url.length > 0) {
      return {
        type: "image_url",
        image_url: { url: part.image_url },
      };
    }
    // THIRD priority: `image_url` as OBJECT with `url` field.
    if (typeof part.image_url === "object" && part.image_url !== null) {
      const inner = (part.image_url as { url?: unknown }).url;
      if (typeof inner === "string" && inner.length > 0) {
        return { type: "image_url", image_url: { url: inner } };
      }
    }
    // FOURTH priority: legacy `url` field as STRING.
    if (typeof part.url === "string" && part.url.length > 0) {
      return { type: "image_url", image_url: { url: part.url } };
    }
    // FALLTHROUGH (per M16.5 M-2, post-exec discriminator iter-1): when
    // no usable URL is present (e.g., the part carries only `file_id` —
    // no Chat Completions equivalent — or is missing every URL field),
    // fall through to the D9 unmapped-text path. JSON-stringify the part
    // into a text block so the trace surfaces the dropped image
    // reference. Pre-fix: emitted invalid `{type:"image_url",
    // image_url:{url:""}}` which upstream Chat would reject (or silently
    // ignore, masking the bug).
    return { type: "text", text: JSON.stringify(part) };
  }
  // Per D9: unknown content part types are JSON-stringified into a text
  // block — preserves the payload (don't silently drop) without throwing.
  return { type: "text", text: JSON.stringify(part) };
}

/**
 * Convert a Responses message item's content into the Chat message
 * `content` field. Pure-text content collapses to a string (Chat allows
 * both string and array forms; string is more compatible). Mixed
 * content (text + image, or anything with a non-text part) emits the
 * array form.
 */
function messageContentToChat(
  content: string | ResponsesContentPart[] | undefined,
): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // First pass: try to collapse to a single string if every part is text.
  const stringParts: string[] = [];
  let allText = true;
  for (const part of content) {
    const s = contentPartToString(part);
    if (s === null) {
      allText = false;
      break;
    }
    stringParts.push(s);
  }
  if (allText) return stringParts.join("");
  // Mixed content: emit array form. Walk all parts (including text ones)
  // through the part converter so each becomes a proper Chat content part.
  return content.map(contentPartToChatPart);
}

/**
 * Map a Responses role to a Chat role. Chat doesn't have `developer` —
 * map to `system`. `system`/`user`/`assistant` pass through.
 */
function mapRole(role: string | undefined): "system" | "user" | "assistant" {
  if (role === "developer") return "system";
  if (role === "system") return "system";
  if (role === "assistant") return "assistant";
  // Default to "user" for unknown/missing roles (most defensive).
  return "user";
}

/**
 * Stringify a `function_call.arguments` value into the Chat
 * `tool_calls[].function.arguments` string form. If already a string,
 * pass through. If an object/array, JSON-stringify. If null/undefined,
 * emit `"{}"` (Chat expects a valid JSON string).
 */
function argsToString(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || args === undefined) return "{}";
  return JSON.stringify(args);
}

/**
 * Stringify a `function_call_output.output` value to the Chat tool
 * message `content` string form. Mirrors the inverse-direction
 * normalization at `translate_responses_to_anthropic.ts:282-286`:
 *
 *   - string → passthrough.
 *   - null/undefined → empty string (NOT `JSON.stringify(null)` which
 *     would yield the literal `"null"`).
 *   - object → JSON.stringify (per D9 defensive normalization).
 */
function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/**
 * Build a Chat assistant message with `tool_calls[]` from one OR more
 * consecutive Responses `function_call` items. Used by both the
 * single-item path and the coalescing path (R2.4).
 */
function buildAssistantToolCallMessage(
  fcs: ResponsesFunctionCallItem[],
): ChatMessage {
  const toolCalls: ChatToolCall[] = fcs.map((fc) => ({
    // Use call_id (NOT id) — fc.id is internal Responses bookkeeping;
    // call_id is what subsequent function_call_output items reference.
    id: fc.call_id ?? fc.id ?? "",
    type: "function",
    function: {
      name: fc.name ?? "",
      arguments: argsToString(fc.arguments),
    },
  }));
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  };
}

/**
 * Translate one Responses input[] item into zero or more Chat messages.
 * Returns an array (most items emit one Chat message; some emit zero
 * — e.g. dropped reasoning items).
 *
 * **M16.5 H-1 normalization (post-exec discriminator iter-1).** Per the
 * OpenAI Responses API spec, `type` on `input[]` items is OPTIONAL and
 * defaults to `"message"` when the item carries the canonical
 * `{role, content}` shorthand. Real Codex CLI clients send no-`type`
 * `{role: "user", content: [...]}` items as the bare-minimum request
 * shape (this is also the shape used by the Lane 6 e2e test).
 *
 * Pre-fix: such items fell through to the unknown-item-types branch
 * (R2.7) and were JSON-stringified into `[unmapped responses item: ...]`
 * — an F36-class test-masking bug because the upstream gpt-4o-mini
 * happened to reply coherently to the corrupted marker prompt, so the
 * Lane 6 e2e passed despite producing nonsense translations.
 *
 * Fix: when `item.type === undefined` AND the item has BOTH `role` AND
 * `content` properties, normalize to `type === "message"` BEFORE
 * dispatching. Function-call / function-call-output / reasoning items
 * REQUIRE an explicit `type` per spec — missing `type` on those shapes
 * is genuinely malformed input and still falls through to the D9
 * unknown-fallback path.
 *
 * **M16.5.1 N-1 tightening (post-exec discriminator iter-2).** The
 * iter-1 predicate `content !== undefined` was too loose — it accepted
 * `content: null`, `content: 42`, or any other malformed value, then
 * `messageContentToChat` returned `""` (blank message) and silently
 * dropped sibling fields like `call_id` / `name` / `arguments`. Per
 * the OpenAI Responses spec `content` is either a string OR an array
 * of content parts; anything else is malformed input that should fall
 * through to the D9 unmapped path. The tightened predicate is
 * `(typeof content === "string" || Array.isArray(content))` — this
 * keeps the canonical no-`type` `{role, content}` normalization while
 * rejecting non-string/non-array content shapes.
 */
function inputItemToMessages(item: ResponsesInputItem): ChatMessage[] {
  let t = item.type;
  // Per OpenAI Responses spec: when `type` is omitted but `role` +
  // `content` are present, treat as an implicit `type: "message"`.
  // Only the {role, content} shape gets this default — function_call /
  // function_call_output / reasoning items must carry their explicit
  // `type` to be recognized. Per M16.5.1 N-1: `content` MUST be string
  // or array (NOT null / number / object-that-isn't-array) — otherwise
  // we'd produce a blank message and silently drop sibling fields.
  if (
    t === undefined &&
    typeof (item as { role?: unknown }).role === "string" &&
    (typeof (item as { content?: unknown }).content === "string" ||
      Array.isArray((item as { content?: unknown }).content))
  ) {
    t = "message";
  }
  if (t === "message") {
    const m = item as ResponsesMessageItem;
    const role = mapRole(m.role);
    const content = messageContentToChat(m.content);
    return [{ role, content }];
  }
  if (t === "function_call") {
    const fc = item as ResponsesFunctionCallItem;
    return [buildAssistantToolCallMessage([fc])];
  }
  if (t === "function_call_output") {
    const fco = item as ResponsesFunctionCallOutputItem;
    return [
      {
        role: "tool",
        tool_call_id: fco.call_id ?? "",
        content: outputToString(fco.output),
      },
    ];
  }
  // Reasoning items handled at translateBody-level (so coalescing logic
  // can see them and skip cleanly); we should never reach this path for
  // them, but guard defensively.
  if (t === "reasoning") {
    return [];
  }
  // Unknown item type — JSON-stringify into a user message (per D9 + R2.7).
  return [
    {
      role: "user",
      content: `[unmapped responses item: ${JSON.stringify(item)}]`,
    },
  ];
}

/**
 * Map a Responses tool definition to a Chat tool definition.
 * Returns `null` for non-function tool types (web_search,
 * code_interpreter, file_search, image_generation, mcp, etc.) — these
 * are Responses-only server tools with no Chat equivalent. Per D9,
 * the drop is visible via the `before`/`after` snapshots returned by
 * the rule.
 */
function toolDefinitionToChat(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  if (tool.type !== "function") {
    // web_search / code_interpreter / file_search / image_generation /
    // mcp / etc. — drop with snapshot visibility per D9.
    return null;
  }
  // Chat shape: nest the function fields under `function: {...}`.
  // Drop the Responses `strict` field (Chat `function.strict` exists
  // but is gated on `parallel_tool_calls: false`; safest to omit per
  // M16 spec R3).
  const fn: Record<string, unknown> = {};
  if (tool.name !== undefined) fn.name = tool.name;
  if (tool.description !== undefined) fn.description = tool.description;
  if (tool.parameters !== undefined) fn.parameters = tool.parameters;
  return {
    type: "function",
    function: fn,
  };
}

/**
 * Map a Responses `tool_choice` value to a Chat `tool_choice` value.
 *   - String forms (`"auto" | "required" | "none"`) pass through.
 *   - `{type:"function", name:"..."}` (Responses) →
 *     `{type:"function", function:{name:"..."}}` (Chat).
 *   - Unknown shapes pass through; let upstream reject if invalid.
 */
function toolChoiceToChat(tc: unknown): unknown {
  if (tc === null || tc === undefined) return tc;
  if (typeof tc === "string") return tc;
  if (typeof tc === "object" && !Array.isArray(tc)) {
    const obj = tc as Record<string, unknown>;
    if (obj.type === "function" && typeof obj.name === "string") {
      return {
        type: "function",
        function: { name: obj.name },
      };
    }
  }
  return tc;
}

/**
 * Extract `instructions` text from the Responses top-level
 * `instructions` field. Accepts string OR array-of-objects-with-text.
 * Returns the empty string (caller checks length) when missing/empty/
 * malformed.
 */
function extractInstructionsText(instructions: unknown): string {
  if (typeof instructions === "string") return instructions;
  if (Array.isArray(instructions)) {
    const parts: string[] = [];
    for (const block of instructions) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block !== null && typeof block === "object") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * Normalize `src.input` into an array of items. Handles the OpenAI
 * Responses shorthand `input: "hello"` by wrapping into the canonical
 * `[{role:"user", content:[{type:"input_text", text:"hello"}]}]` form
 * BEFORE walking (per R5 / M-1 iter-1).
 */
function normalizeInput(src: Record<string, unknown>): ResponsesInputItem[] {
  const raw = src.input;
  if (typeof raw === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: raw }],
      } as ResponsesMessageItem,
    ];
  }
  if (Array.isArray(raw)) return raw as ResponsesInputItem[];
  return [];
}

/**
 * Responses → Chat translation core. Returns the new body as a fresh
 * object; caller decides whether to mutate-in-place.
 */
function translateBody(
  src: Record<string, unknown>,
  opts: TranslateResponsesToChatCompletionsOpts,
): Record<string, unknown> {
  // Default-true policies (per H-1 iter-1: default lives in body code,
  // NOT in zod schema, so introspection accurately reflects "optional").
  const dropReasoning = opts.drop_reasoning !== false;
  const dropPreviousResponseId = opts.drop_previous_response_id !== false;

  const messages: ChatMessage[] = [];

  // 1. instructions → leading system message (R2.1). Emit FIRST so any
  //    developer-role message that follows in input[] becomes a SECOND
  //    system message in document order (R2.1 conflict resolution).
  const instructionsText = extractInstructionsText(src.instructions);
  if (instructionsText.length > 0) {
    messages.push({ role: "system", content: instructionsText });
  }

  // 2. Walk input[] with strictly-positional function_call coalescing
  //    (R2.4). Reasoning items are skipped when drop_reasoning is true.
  const input = normalizeInput(src);
  let i = 0;
  while (i < input.length) {
    const item = input[i];
    if (item === undefined) {
      i++;
      continue;
    }
    const t = item.type;

    // Reasoning items: skip (default drop). Even when drop_reasoning is
    // false, we still skip — Chat Completions has no place to put
    // reasoning, and emitting it as a system message could confuse the
    // model (executor's documented choice; see file header R2.6).
    if (t === "reasoning") {
      // Snapshot visibility: the `before` snapshot still contains the
      // reasoning item; the trace shows what was dropped.
      if (!dropReasoning) {
        // Honor the opt by emitting nothing here too — explicit comment
        // for the future executor who tries `drop_reasoning: false`.
      }
      i++;
      continue;
    }

    // Function-call coalescing: scan ahead for consecutive function_call
    // items at adjacent indices (no other item type may interleave).
    if (t === "function_call") {
      const run: ResponsesFunctionCallItem[] = [];
      let j = i;
      while (j < input.length) {
        const nxt = input[j];
        if (nxt === undefined || nxt.type !== "function_call") break;
        run.push(nxt as ResponsesFunctionCallItem);
        j++;
      }
      messages.push(buildAssistantToolCallMessage(run));
      i = j;
      continue;
    }

    // All other item types (message, function_call_output, unknown)
    // dispatch through the per-item translator.
    const emitted = inputItemToMessages(item);
    for (const m of emitted) messages.push(m);
    i++;
  }

  // 3. Tools translation (R3). Drop non-function types with snapshot
  //    visibility; map function tools to nested `function:{...}` shape.
  const srcTools = Array.isArray(src.tools)
    ? (src.tools as Array<Record<string, unknown>>)
    : [];
  const tools: Array<Record<string, unknown>> = [];
  for (const tool of srcTools) {
    const mapped = toolDefinitionToChat(tool);
    if (mapped !== null) tools.push(mapped);
  }

  // 4. Build the Chat output body (R4).
  const out: Record<string, unknown> = {};
  out.model = src.model;
  out.messages = messages;

  // tools — omit if empty (per R3 / R4).
  if (tools.length > 0) out.tools = tools;

  // tool_choice — translated per R3.
  if (src.tool_choice !== undefined) {
    out.tool_choice = toolChoiceToChat(src.tool_choice);
  }

  // max_output_tokens → max_tokens (rename); fallback to opts default.
  // Default 4096 is conservative; operators wanting more should set
  // `default_max_tokens` explicitly in the rule config.
  const srcMax = src.max_output_tokens;
  if (typeof srcMax === "number") {
    out.max_tokens = srcMax;
  } else if (typeof opts.default_max_tokens === "number") {
    out.max_tokens = opts.default_max_tokens;
  } else {
    out.max_tokens = 4096;
  }

  // stream — preserve client intent. OpenAI Chat Completions defaults
  // `stream: false` when absent (mirrors OpenAI Responses spec). Per
  // M16.5 M-1 (post-exec discriminator iter-1): pass through ONLY when
  // explicitly set by client; do NOT inject a default `true`. Pre-fix
  // M16 inherited M7a's `src.stream !== false` pattern which auto-set
  // `stream: true` when the source body omitted the field — surprising
  // for OpenAI clients that expect the OpenAI-documented `false`
  // default and the reason the Lane 6 e2e had to override `stream:
  // false` explicitly.
  if (src.stream !== undefined) {
    out.stream = src.stream;
  }

  // Whitelisted passthrough fields.
  if (src.temperature !== undefined) out.temperature = src.temperature;
  if (src.top_p !== undefined) out.top_p = src.top_p;
  if (src.n !== undefined) out.n = src.n;
  if (src.seed !== undefined) out.seed = src.seed;
  if (src.parallel_tool_calls !== undefined) {
    out.parallel_tool_calls = src.parallel_tool_calls;
  }
  if (src.response_format !== undefined) {
    out.response_format = src.response_format;
  }
  if (src.metadata !== undefined) out.metadata = src.metadata;
  if (src.top_logprobs !== undefined) out.top_logprobs = src.top_logprobs;

  // previous_response_id — drop by default (R4 + Schema).
  if (!dropPreviousResponseId && src.previous_response_id !== undefined) {
    out.previous_response_id = src.previous_response_id;
  }

  // Responses-only fields explicitly DROPPED (R4): instructions
  // (consumed into messages above), reasoning, store, truncation, text,
  // include. These are not added to `out`.

  // Defensive principle (D9): unrecognized top-level fields are
  // DROPPED (snapshot shows the drop). We do NOT pass through unknown
  // top-level fields — Chat upstream may 400 on unknown fields.

  return out;
}

const translate_responses_to_chat_completions: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as TranslateResponsesToChatCompletionsOpts;
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

  // Mutate-in-place: replace src's keys with out's keys (mirrors
  // translate_anthropic_to_responses.ts:451-455).
  for (const k of Object.keys(src)) {
    delete src[k];
  }
  Object.assign(src, out);

  return { ctx, applied: true, before, after: structuredClone(out) };
};

register(
  "translate_responses_to_chat_completions",
  translate_responses_to_chat_completions,
  TranslateResponsesToChatCompletionsSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
  },
);

export {
  translate_responses_to_chat_completions,
  TranslateResponsesToChatCompletionsSchema,
};
