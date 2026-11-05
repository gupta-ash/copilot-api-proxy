/**
 * usage.ts — shared helper for Anthropic→Responses usage shape conversion.
 *
 * **M8 extraction (D-LOCK-2).** Previously inlined in
 * `translate_anthropic_event_to_responses_event.ts` as `toResponsesUsage`
 * (re-exported test-only as `_toResponsesUsage`). M8 promotes it to a
 * shared helper so other consumers (M5's non-stream Codex→Claude response
 * path; M9/M10 fixture-replay tests) can reuse the same conversion
 * without duplicating logic. Per D15 req 6 (modularity by structure):
 * shared logic = shared file.
 *
 * **Cribbed-from:** copilot-api-pro@f4f9bbdb dist/main.js
 *   - `_toResponsesUsage` at line 2219 (Phase 1.6 helper; direct port).
 *
 * **Behavior (byte-equivalent to bundle's helper).**
 *   - `input_tokens` ← Anthropic `input_tokens || 0`
 *   - `output_tokens` ← Anthropic `output_tokens || 0`
 *   - `total_tokens` ← input + output (computed; bundle does the same)
 *   - `input_tokens_details.cached_tokens` ← `cache_read_input_tokens || 0`
 *   - `output_tokens_details.reasoning_tokens` ← `0` (Phase 3 placeholder
 *     per M7b D-LOCK-9; not computed from thinking deltas in M8)
 *
 * Tolerates `null` / `undefined` / non-object input by treating fields
 * as missing (defaults to 0). Forward-compat: any other Anthropic usage
 * fields are ignored.
 *
 * **Why a separate file (not a barrel-imported registered rule).**
 * `usage.ts` is a PURE HELPER MODULE — no `register()` call, no schema,
 * no engine surface. Same pattern as `sse-state.ts` (M7b stream-state
 * scaffolding) and the engine-core files (`apply.ts`, `predicate.ts`,
 * etc.). `scripts/gen_barrel.ts` ENGINE_CORE skip-list excludes this
 * file from the auto-barrel.
 *
 * **No external deps.** Stdlib-only TypeScript.
 */

/**
 * Anthropic usage shape — all fields optional + open-extension for
 * forward-compat. The actual Anthropic API shape is documented at
 * https://docs.anthropic.com/api/messages-streaming but this type only
 * names the fields v2 actually consumes.
 */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  /** Forward-compat: any other Anthropic usage fields are ignored. */
  [k: string]: unknown;
}

/**
 * Responses-shaped usage. Mirrors OpenAI Responses API shape (per bundle
 * line 2219 helper). All fields are non-optional in the output: the
 * helper fills them with `0` when missing in the input.
 */
export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

/**
 * Convert an Anthropic-shaped usage object to a Responses-shaped usage
 * object. See module header for byte-equivalence contract with
 * bundle line 2219 `_toResponsesUsage`.
 *
 * Accepts `unknown` to tolerate the various places this is called from
 * (parsed SSE event payloads, message_start.message.usage,
 * message_delta.usage, raw response.usage from non-stream JSON returns).
 */
export function toResponsesUsage(
  anthropicUsage: AnthropicUsage | unknown,
): ResponsesUsage {
  const u =
    anthropicUsage !== null &&
    anthropicUsage !== undefined &&
    typeof anthropicUsage === "object"
      ? (anthropicUsage as Record<string, unknown>)
      : {};
  const inT = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outT = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const cached =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : 0;
  return {
    input_tokens: inT,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: outT,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inT + outT,
  };
}
