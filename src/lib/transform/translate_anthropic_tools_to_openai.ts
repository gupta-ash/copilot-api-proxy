/**
 * translate_anthropic_tools_to_openai.ts — body-engine rule: rewrite the
 * `tools` array on `ctx.body` from Anthropic shape to OpenAI Chat
 * Completions shape, optionally also rewriting `tool_choice`.
 *
 * **M7a primitive (built-in).** Self-registers at module load. Naming
 * convention `translate_<source>_to_<target>` per D-LOCK-8 / O19.
 *
 * **Lane (per addendum §7).** Consumed by **CC→GPT-4.x legacy** ONLY
 * (Tools-only shape; full messages-shape translation is OUT OF SCOPE for
 * M7a per plan v4 line 462).
 *
 * Lane: CC→GPT-4.x legacy (consumer); NOT CC→Claude / CC→GPT-5.x / Codex→Claude.
 *
 *   - **NOT** consumed by CC→Claude (passthrough, no translator).
 *   - **NOT** consumed by CC→GPT-5.x (uses Responses shape with
 *     `tools`-as-function-array; the
 *     `translate_anthropic_to_responses` translator handles its tool
 *     shape inline since `web_search_20250305` requires special mapping).
 *   - **NOT** consumed by Codex→Claude (Anthropic→OpenAI direction;
 *     Codex sends OpenAI shape natively).
 *
 * **BODY-ONLY scope (D-LOCK-7).** Receives a complete request body and
 * returns a translated body. NO streaming / SSE concerns.
 *
 * **Cribbed from** `xianml/copilot-api-pro@f212832` bundle SHA
 * `f4f9bbdb087ceb79572cc060db2decf2ece388c543fef90575ae9be3e2437775`,
 * `dist/main.js § translateAnthropicToolsToOpenAI` (line 1217) +
 * `translateAnthropicToolChoiceToOpenAI` (line 1228). Bundle's behavior:
 *   - Tools: `[{name, description, input_schema}]` →
 *     `[{type:"function", function:{name, description, parameters}}]`.
 *   - Tool-choice: `{type:"auto"}` → `"auto"`; `{type:"any"}` →
 *     `"required"`; `{type:"tool", name}` →
 *     `{type:"function", function:{name}}`; `{type:"none"}` → `"none"`;
 *     anything else → strip.
 *
 * **Ctx surfaces (per F5/M6 D-LOCK-2).**
 *   - `ctx_reads: ["body"]` — reads `ctx.body.tools` and `ctx.body.tool_choice`.
 *   - `ctx_writes: ["body"]` — mutates `ctx.body.tools` and (optionally) `ctx.body.tool_choice`.
 *
 * **Behavior.**
 *   - If `ctx.body` is not a plain object OR `ctx.body.tools` is not an
 *     array → `applied: false` (predicate matched but rule chose not to
 *     fire). Mirrors M3 day-1 convention.
 *   - Else: replace `body.tools` with the OpenAI-shape array. If
 *     `translate_tool_choice` is true (default `true`) AND
 *     `body.tool_choice` is set, also rewrite it.
 *   - Empty `tools: []` → translates to empty array; `applied: true`
 *     (the SHAPE was rewritten even if the array is empty — the consumer
 *     downstream sees the OpenAI-shape rather than the Anthropic-shape).
 *
 * **Example config.**
 *
 * ```yaml
 * - name: translate_tools_for_gpt4
 *   use: translate_anthropic_tools_to_openai
 *   when:
 *     route: /v1/messages
 *     model_glob: "gpt-4*"
 * ```
 *
 * **Cross-references.**
 *   - Plan v4 § M7a — body translators (lane-scoped).
 *   - addendum §7 — lane-scoping discipline.
 *   - `lib/transform/registry.ts § register` — registration API.
 */

import { z } from "zod";

import { register } from "./registry.ts";
import type {
  TransformContext,
  TransformFn,
  TransformResult,
} from "./types.ts";

const TranslateAnthropicToolsToOpenaiSchema = z
  .object({
    name: z.string().min(1),
    use: z.literal("translate_anthropic_tools_to_openai"),
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
     * When `true` (default), if `ctx.body.tool_choice` is set, also
     * rewrite it to OpenAI shape. Set `false` to leave `tool_choice`
     * alone (rare — typical lanes want both rewritten together).
     */
    translate_tool_choice: z.boolean().optional(),
  })
  .passthrough();

type TranslateAnthropicToolsToOpenaiOpts = z.infer<
  typeof TranslateAnthropicToolsToOpenaiSchema
>;

/** Anthropic tool shape (input). */
interface AnthropicTool {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  [k: string]: unknown;
}

/** OpenAI Chat Completions tool shape (output). */
interface OpenAITool {
  type: "function";
  function: {
    name: unknown;
    description: unknown;
    parameters: unknown;
  };
}

/**
 * Translate one Anthropic tool to OpenAI Chat shape. Mirrors bundle
 * line 1219-1226. Note: pass-through of `name`/`description`/parameters
 * is unnarrowed — the rule trusts the upstream caller (a CC harness)
 * to send valid Anthropic-shape tools; downstream OpenAI validates.
 */
function toolToOpenAI(tool: AnthropicTool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/**
 * Translate Anthropic `tool_choice` to OpenAI Chat shape. Mirrors
 * bundle line 1228-1242. Returns `undefined` when the input cannot be
 * mapped (caller should DROP `tool_choice` rather than emit garbage).
 */
function toolChoiceToOpenAI(
  toolChoice: unknown,
):
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: unknown } }
  | undefined {
  if (
    toolChoice === null ||
    typeof toolChoice !== "object" ||
    Array.isArray(toolChoice)
  ) {
    return undefined;
  }
  const tc = toolChoice as { type?: unknown; name?: unknown };
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      if (tc.name !== undefined) {
        return { type: "function", function: { name: tc.name } };
      }
      return undefined;
    case "none":
      return "none";
    default:
      return undefined;
  }
}

const translate_anthropic_tools_to_openai: TransformFn = (
  ctx: TransformContext,
  options: unknown,
): TransformResult => {
  const opts = options as TranslateAnthropicToolsToOpenaiOpts;
  if (
    ctx.body === null ||
    typeof ctx.body !== "object" ||
    Array.isArray(ctx.body)
  ) {
    return { ctx, applied: false };
  }
  const body = ctx.body as Record<string, unknown>;
  const beforeTools = body.tools;
  if (!Array.isArray(beforeTools)) {
    return { ctx, applied: false };
  }

  const afterTools: OpenAITool[] = beforeTools.map((t) =>
    toolToOpenAI(t as AnthropicTool),
  );
  body.tools = afterTools;

  // Optional tool_choice rewrite. Default true.
  const doToolChoice = opts.translate_tool_choice ?? true;
  let beforeToolChoice: unknown = undefined;
  let afterToolChoice: unknown = undefined;
  if (doToolChoice && body.tool_choice !== undefined) {
    beforeToolChoice = body.tool_choice;
    const mapped = toolChoiceToOpenAI(body.tool_choice);
    if (mapped !== undefined) {
      body.tool_choice = mapped;
      afterToolChoice = mapped;
    } else {
      // Could not map — drop the field. Downstream OpenAI would reject
      // an Anthropic-shape `tool_choice`; better to drop than forward.
      delete body.tool_choice;
      afterToolChoice = null;
    }
  }

  return {
    ctx,
    applied: true,
    before: { tools: beforeTools, tool_choice: beforeToolChoice },
    after: { tools: afterTools, tool_choice: afterToolChoice },
  };
};

register(
  "translate_anthropic_tools_to_openai",
  translate_anthropic_tools_to_openai,
  TranslateAnthropicToolsToOpenaiSchema,
  {
    ctx_reads: ["body"],
    ctx_writes: ["body"],
  },
);

export {
  translate_anthropic_tools_to_openai,
  TranslateAnthropicToolsToOpenaiSchema,
};
