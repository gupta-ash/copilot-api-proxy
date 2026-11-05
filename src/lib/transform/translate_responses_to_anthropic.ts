/**
 * translate_responses_to_anthropic.ts — body-engine rule: rewrite the
 * entire `ctx.body` from OpenAI `/responses` shape to Anthropic
 * `/v1/messages` shape (the reverse of `translate_anthropic_to_responses`).
 *
 * **M7a primitive (built-in).** Self-registers at module load. Naming
 * convention `translate_<source>_to_<target>` per D-LOCK-8 / O19.
 *
 * **Lane (per addendum §7).** Consumed by **Codex→Claude reverse** ONLY.
 *
 * Lane: Codex→Claude reverse (consumer); NOT CC→Claude / CC→GPT-5.x / CC→GPT-4.x.
 *
 *   - **NOT** consumed by CC→Claude (passthrough, no translator).
 *   - **NOT** consumed by CC→GPT-5.x (forward direction; see
 *     `translate_anthropic_to_responses.ts`).
 *   - **NOT** consumed by CC→GPT-4.x (Chat shape, not Responses).
 *
 * **BODY-ONLY scope (D-LOCK-7).** Receives a complete request body and
 * returns a translated body. NO streaming / SSE concerns.
 *
 * **F26 scope clarification.** F26 (`OQ-PROXY-EMPTY-TOOL-ARGS`) is the
 * empty-`arguments: ""` bug in the bundle's SSE event-stream
 * translator (`translateAnthropicEventToResponsesEvents`, bundle line
 * 2232 — M7b territory). It is NOT a body-translator bug:
 * `translateResponsesToAnthropic` (line 2089, what THIS file
 * re-implements) already handles tool-use args correctly via
 * `JSON.parse(item.arguments || '{}')` (line 2136). The body
 * translator assumes `input[].function_call.arguments` arrives as a
 * complete string from the upstream caller; if a caller sends an
 * empty string, it parses to `{}` (per the `|| '{}'` fallback). The
 * SSE-side fix (assembling `input_json_delta.partial_json` chunks)
 * lives in M7b and does not affect this body translator.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § translateResponsesToAnthropic` (line 2089). Bundle
 * behavior plus deviations:
 *
 *   - **input[]** items dispatched by `type`:
 *     - `message` with role `developer`/`system` → push to `system[]`
 *       (one entry per content text, OR one entry for string content).
 *     - `message` with role `user` → push as `messages[]` user item
 *       with content blocks (`input_text` → `text`, `input_image` →
 *       `image`).
 *     - `message` with role `assistant` → push as `messages[]`
 *       assistant item with content blocks (`output_text` → `text`).
 *     - `function_call` → push as `messages[]` assistant item with a
 *       `tool_use` content block.
 *     - `function_call_output` → push as `messages[]` user item with
 *       a `tool_result` content block.
 *     - Unknown `type` → preserved as `text` block with JSON-stringified
 *       payload (per D9). Bundle silently drops; v2 surfaces.
 *   - **`instructions` top-level field** is IGNORED — bundle does NOT
 *     read it (only reads `input[]`). Mirrored. Codex emits its
 *     instructions inside `input[0]` as a developer message anyway.
 *   - **Consecutive same-role messages** are merged (Anthropic
 *     requires strict role alternation).
 *   - **`cache_control: {type: "ephemeral"}`** added to the LAST
 *     `system[]` block when one or more system entries exist.
 *   - **Tools** — bundle filters non-`function`-typed tools (per F25,
 *     2026-04-29 rationale: Codex emits `{type:"web_search"}` server
 *     tools that Anthropic `/v1/messages` rejects as
 *     `400 tools.N.custom.name: Field required`). Mirrored. Stripped
 *     tool types are NOT logged in v2 (operators get observability
 *     via the engine's per-rule trace + the rule's `before`/`after`
 *     snapshot showing the dropped tools).
 *   - **`max_output_tokens`** → `max_tokens`. Bundle calls
 *     `clampMaxTokensForModel` here; v2 omits the per-model clamp
 *     (operators chain `clamp_max_tokens` AFTER this rule).
 *   - **`reasoning.effort`** → `output_config.effort` IF the effort is
 *     not `"none"`. Bundle calls `clampEffortForModel` +
 *     `applyEffortOverride`; v2 passes through (operators chain
 *     `clamp_effort` AFTER).
 *   - **`thinking: {type: "adaptive"}`** is a fixed default emitted by
 *     the bundle (line 2203). Mirrored.
 *   - **`stream`** preserved (default true if absent — bundle does
 *     `stream !== false`).
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
 * - name: translate_codex_to_claude
 *   use: translate_responses_to_anthropic
 *   when:
 *     route: /v1/responses
 *     model_glob: "claude-*"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M7a — body translators (lane-scoped).
 *   - addendum §7 — lane-scoping discipline.
 *   - research.md § F25 — function-only filter rationale.
 *   - research.md § F26 + open_questions.md § OQ-PROXY-EMPTY-TOOL-ARGS
 *     — SSE-side empty-args bug (M7b territory; not this file's bug).
 *   - `translate_anthropic_to_responses.ts` — forward direction.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const TranslateResponsesToAnthropicSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_responses_to_anthropic"),
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
     * Default `max_tokens` when source `max_output_tokens` is missing
     * or non-numeric. Bundle clamps via `clampMaxTokensForModel`; v2
     * defers to `clamp_max_tokens` rule downstream and uses this opt
     * only as the seed default.
     */
    default_max_tokens: z.number().int().positive().optional(),
    /**
     * Default `output_config.effort` when source `reasoning.effort` is
     * missing. Bundle defaults to `"medium"` (line 2169); v2 mirrors
     * but allows operators to override.
     */
    default_effort: z.enum(["low", "medium", "high", "minimal"]).optional(),
    /**
     * Whether to emit `thinking: {type: "adaptive"}` on the output.
     * Bundle always emits (line 2203). Default `true`. Operators
     * targeting non-thinking-capable models can disable.
     */
    emit_thinking: z.boolean().optional(),
    /**
     * Whether to add `cache_control: {type: "ephemeral"}` to the LAST
     * system block. Bundle always adds (line 2164-2166). Default
     * `true`.
     */
    cache_control_last_system: z.boolean().optional(),
  })
  .passthrough();

type TranslateResponsesToAnthropicOpts = z.infer<
  typeof TranslateResponsesToAnthropicSchema
>;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Responses input-item content-part shapes. */
interface InputContentPart {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  url?: string;
  // M16.5.2 N-5: inline base64 image carrier fields. Mirrors the
  // SIBLING M16.5.1 N-3 carrier-field declarations on the chat
  // translator's `ResponsesContentPart`. The OpenAI Responses spec
  // admits both `data + media_type` (newer, OpenAI-doc primary) and
  // `image_data + image_mediatype` (older alternative seen in some
  // clients). The translator accepts either field-name convention and
  // converts to an Anthropic base64 image source — see
  // `inputContentToBlock`.
  data?: string;
  media_type?: string;
  image_data?: string;
  image_mediatype?: string;
  [k: string]: unknown;
}

interface InputMessageItem {
  type: "message";
  role?: string;
  content?: string | InputContentPart[];
  [k: string]: unknown;
}

interface FunctionCallItem {
  type: "function_call";
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id?: string;
  output?: unknown;
  [k: string]: unknown;
}

type InputItem =
  | InputMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | { type?: string; [k: string]: unknown };

/** Anthropic message shape (output). */
interface AnthropicOutMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

/** Anthropic system block shape (output). */
interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * **M16.5.1 N-2 normalization (post-exec discriminator iter-2).** Mirror
 * of the M16.5 H-1 + M16.5.1 N-1 fix on the SIBLING translator
 * (`translate_responses_to_chat_completions.ts`). Per the OpenAI
 * Responses API spec, `type` on `input[]` items is OPTIONAL and defaults
 * to `"message"` when the item carries the canonical `{role, content}`
 * shorthand. Real Codex CLI clients send no-`type`
 * `{role: "user", content: [...]}` items as the bare-minimum request
 * shape — and Lane 5 (Codex → Claude) was always silently corrupting
 * these by treating them as unknown items and emitting them as a user
 * `[text: <json-dump>]` block. The defect was the same F36-class
 * test-masking pattern as M16.5 H-1; iter-1 was scoped narrowly to
 * Lane 6 / chat translator and missed it.
 *
 * The tightened predicate `(typeof content === "string" || Array.isArray(content))`
 * (per M16.5.1 N-1) keeps the canonical no-`type` `{role, content}`
 * normalization while rejecting non-string/non-array content shapes
 * (`null`, numbers, etc.) which fall through to the D9 unmapped path.
 *
 * Function_call / function_call_output items REQUIRE explicit `type`
 * per spec — missing `type` on those shapes is genuinely malformed
 * input and still falls through to the D9 unknown-fallback path
 * (`translate_responses_to_anthropic`'s `else` branch in `translateBody`).
 */
function normalizeItemType(item: InputItem): string | undefined {
  let t = item.type;
  if (
    t === undefined &&
    typeof (item as { role?: unknown }).role === "string" &&
    (typeof (item as { content?: unknown }).content === "string" ||
      Array.isArray((item as { content?: unknown }).content))
  ) {
    t = "message";
  }
  return t;
}

/**
 * Translate Responses-API content parts (`input_text`, `input_image`)
 * to Anthropic content blocks (`text`, `image`). Unknown types
 * preserved as JSON-stringified `text` (per D9).
 *
 * **M16.5.2 N-5 (post-exec discriminator iter-3, image-content
 * normalization).** Mirror of M16.5.1 N-3 on the SIBLING chat
 * translator (`translate_responses_to_chat_completions.ts`'s
 * `contentPartToChatPart`). Pre-fix, Lane 5 (Codex → Claude)
 * `input_image` parts went through bare
 * `c.image_url ?? c.url ?? ""` which had three corruption defects all
 * in the same F36 class as M16.5.1 N-3 had on Lane 6:
 *   1. Inline `data + media_type` (the OpenAI-doc-primary carrier
 *      shape) was not handled — fell through to `url: ""` empty source
 *      and emitted invalid `{type:"image", source:{type:"url",
 *      url:""}}` that Anthropic upstream rejects.
 *   2. Object-form `image_url: {url: "..."}` (chat-shape) was
 *      type-corrupted — `c.image_url ?? c.url` returned the OBJECT
 *      which then got assigned into the `url` string field, yielding
 *      `source:{type:"url", url:{url:"..."}}` (malformed).
 *   3. Missing-URL fallback emitted invalid empty image source instead
 *      of D9 text-fallback path.
 *
 * Fix mirrors the chat-translator structure adapted to Anthropic image
 * source shape (`{type:"base64", media_type, data}` for inline base64;
 * `{type:"url", url}` for URL forms). 4-priority order:
 *   1. inline base64 (`data + media_type`)
 *   2. `image_url` as STRING
 *   3. `image_url` as OBJECT with `url` field (chat-shape)
 *   4. legacy `url` field as STRING
 *   5. FALLTHROUGH → D9 text fallback (NOT invalid empty image source)
 *
 * Defensive field-name handling: accepts both `data` + `media_type`
 * (newer, OpenAI-doc primary) AND `image_data` + `image_mediatype`
 * (older alternative observed in some clients). Closes the F36-class
 * corruption on input_image symmetrically across M7a (Lane 5) and M16
 * (Lane 6) translators.
 */
function inputContentToBlock(c: InputContentPart): Record<string, unknown> {
  if (c.type === "input_text") {
    return { type: "text", text: c.text ?? "" };
  }
  if (c.type === "input_image") {
    // FIRST priority (per M16.5.2 N-5 + M16.5.1 N-3 mirror): inline
    // base64 `data + media_type` → Anthropic base64 image source.
    // Defensive field-name handling: accept either `data + media_type`
    // (newer, OpenAI-doc primary) OR `image_data + image_mediatype`
    // (older alternative seen in some clients). The branch triggers
    // when BOTH a string-typed data field AND a string-typed
    // media-type field are present.
    const cRec = c as Record<string, unknown>;
    const data =
      typeof cRec.data === "string"
        ? cRec.data
        : typeof cRec.image_data === "string"
          ? cRec.image_data
          : undefined;
    const mediaType =
      typeof cRec.media_type === "string"
        ? cRec.media_type
        : typeof cRec.image_mediatype === "string"
          ? cRec.image_mediatype
          : undefined;
    // M16.5.3 D-1 (post-exec discriminator iter-4): tightened guard to
    // require non-empty strings. Empty-string inline carriers used to
    // short-circuit valid URL fallbacks, producing invalid empty base64
    // source objects that Anthropic upstream rejects. The `length > 0`
    // check is symmetric with the URL branches below.
    if (
      data !== undefined &&
      mediaType !== undefined &&
      data.length > 0 &&
      mediaType.length > 0
    ) {
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      };
    }

    // SECOND priority: `image_url` as STRING.
    if (typeof cRec.image_url === "string" && cRec.image_url.length > 0) {
      return {
        type: "image",
        source: { type: "url", url: cRec.image_url },
      };
    }

    // THIRD priority: `image_url` as OBJECT with `url` field (chat-shape).
    // Pre-fix: bare `c.image_url ?? c.url` returned this object verbatim
    // and type-corrupted the output's `url` field.
    if (typeof cRec.image_url === "object" && cRec.image_url !== null) {
      const inner = (cRec.image_url as Record<string, unknown>).url;
      if (typeof inner === "string" && inner.length > 0) {
        return { type: "image", source: { type: "url", url: inner } };
      }
    }

    // FOURTH priority: legacy `url` field as STRING.
    if (typeof cRec.url === "string" && cRec.url.length > 0) {
      return { type: "image", source: { type: "url", url: cRec.url } };
    }

    // FALLTHROUGH (D9 unmapped): surface as text block (NOT invalid
    // empty image source). Mirrors the chat-side precedent at
    // `translate_responses_to_chat_completions.ts` `contentPartToChatPart`'s
    // M16.5.1 N-3 fallthrough. Pre-fix: emitted
    // `{type:"image", source:{type:"url", url:""}}` which Anthropic
    // upstream rejects (or silently mishandles, masking the bug).
    return { type: "text", text: JSON.stringify(c) };
  }
  return { type: "text", text: JSON.stringify(c) };
}

/**
 * Translate Responses-API output content parts (`output_text`) to
 * Anthropic assistant content blocks (`text`).
 */
function outputContentToBlock(c: InputContentPart): Record<string, unknown> {
  if (c.type === "output_text") {
    return { type: "text", text: c.text ?? "" };
  }
  return { type: "text", text: JSON.stringify(c) };
}

/**
 * Parse `function_call.arguments` to an Anthropic `tool_use.input`
 * object. Mirrors bundle line 2136. The body translator assumes
 * `arguments` is a COMPLETE JSON string (not the streamed-chunk
 * empty-string from F26 — that's M7b's domain).
 */
function parseToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    if (args.length === 0) return {};
    try {
      const parsed = JSON.parse(args);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
      // Non-object JSON parse (number, string, array) — wrap so the
      // shape is a Record<string,unknown>. Anthropic tool_use.input
      // expects an object.
      return { value: parsed };
    } catch {
      return {};
    }
  }
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

/**
 * Stringify a `function_call_output.output` value to the Anthropic
 * `tool_result.content` string form. Bundle does `item.output || ''`.
 * v2 also handles non-string `output` (objects → JSON stringify).
 */
function outputToToolResultContent(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/**
 * Translate a Responses payload to an Anthropic `/v1/messages` body.
 * Pure function; caller decides whether to mutate-in-place.
 */
function translateBody(
  src: Record<string, unknown>,
  opts: TranslateResponsesToAnthropicOpts,
): Record<string, unknown> {
  const system: AnthropicSystemBlock[] = [];
  const messagesRaw: AnthropicOutMessage[] = [];

  const input = Array.isArray(src.input) ? (src.input as InputItem[]) : [];

  for (const item of input) {
    // M16.5.1 N-2: per OpenAI Responses spec, `type` is OPTIONAL when
    // the canonical `{role, content}` shorthand is present (the shape
    // real Codex CLI clients send). Normalize before dispatch — see
    // `normalizeItemType` for the full rationale.
    const t = normalizeItemType(item);
    if (t === "message") {
      const m = item as InputMessageItem;
      const role = m.role;
      if (role === "developer" || role === "system") {
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            const text =
              typeof c === "object" && c !== null && typeof c.text === "string"
                ? c.text
                : "";
            system.push({ type: "text", text });
          }
        } else if (typeof m.content === "string") {
          system.push({ type: "text", text: m.content });
        }
      } else if (role === "user") {
        const content: Array<Record<string, unknown>> = [];
        if (Array.isArray(m.content)) {
          for (const c of m.content) content.push(inputContentToBlock(c));
        } else if (typeof m.content === "string") {
          content.push({ type: "text", text: m.content });
        }
        messagesRaw.push({ role: "user", content });
      } else if (role === "assistant") {
        const content: Array<Record<string, unknown>> = [];
        if (Array.isArray(m.content)) {
          for (const c of m.content) content.push(outputContentToBlock(c));
        } else if (typeof m.content === "string") {
          content.push({ type: "text", text: m.content });
        }
        messagesRaw.push({ role: "assistant", content });
      }
      // Unknown role on a message item — drop (bundle ignores too).
    } else if (t === "function_call") {
      const fc = item as FunctionCallItem;
      messagesRaw.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: fc.call_id ?? fc.id ?? "",
            name: fc.name ?? "",
            input: parseToolArgs(fc.arguments),
          },
        ],
      });
    } else if (t === "function_call_output") {
      const fco = item as FunctionCallOutputItem;
      messagesRaw.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: fco.call_id ?? "",
            content: outputToToolResultContent(fco.output),
          },
        ],
      });
    } else {
      // Unknown item type — preserve as a user `text` block with the
      // JSON dump (per D9: don't silently drop).
      messagesRaw.push({
        role: "user",
        content: [{ type: "text", text: JSON.stringify(item) }],
      });
    }
  }

  // Merge consecutive same-role messages (Anthropic requires
  // strict alternation). Mirrors bundle line 2153-2161.
  const messages: AnthropicOutMessage[] = [];
  for (const msg of messagesRaw) {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === msg.role) {
      last.content = [...last.content, ...msg.content];
    } else {
      messages.push({ role: msg.role, content: [...msg.content] });
    }
  }

  // Add cache_control to last system block (default true).
  const cacheControl = opts.cache_control_last_system ?? true;
  if (cacheControl && system.length > 0) {
    const last = system[system.length - 1] as AnthropicSystemBlock;
    last.cache_control = { type: "ephemeral" };
  }

  // Effort + max_tokens — pure passthrough, no clamping.
  const reasoning = src.reasoning;
  let effort: string | undefined = undefined;
  if (
    reasoning !== null &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning)
  ) {
    const e = (reasoning as { effort?: unknown }).effort;
    if (typeof e === "string") effort = e;
  }
  if (effort === undefined) {
    effort = opts.default_effort ?? "medium";
  }

  const maxTokens =
    typeof src.max_output_tokens === "number"
      ? src.max_output_tokens
      : (opts.default_max_tokens ?? 32000);

  // Tools — strip non-function types (per F25); map function tools to
  // Anthropic shape.
  const srcTools = Array.isArray(src.tools)
    ? (src.tools as Array<Record<string, unknown>>)
    : [];
  const tools = srcTools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t.parameters ?? {}) as unknown,
    }));

  // Build output. Field order mirrors bundle line 2198-2208 for
  // diff-stability against captured fixtures.
  const stream = src.stream !== false;
  const out: Record<string, unknown> = {
    model: src.model,
    messages,
    max_tokens: maxTokens,
    stream,
  };
  if (opts.emit_thinking ?? true) {
    out.thinking = { type: "adaptive" };
  }
  if (effort !== "none") {
    out.output_config = { effort };
  }
  if (system.length > 0) out.system = system;
  if (tools.length > 0) out.tools = tools;

  return out;
}

const translate_responses_to_anthropic: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as TranslateResponsesToAnthropicOpts;
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
  "translate_responses_to_anthropic",
  translate_responses_to_anthropic,
  TranslateResponsesToAnthropicSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
  },
);

export {
  translate_responses_to_anthropic,
  TranslateResponsesToAnthropicSchema,
};
