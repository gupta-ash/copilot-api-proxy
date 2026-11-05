// NEW — no upstream equivalent.
// Source: OpenAI public Chat Completions API spec (https://platform.openai.com/docs/api-reference/chat).

/**
 * openai-chat.ts — TypeScript types for the OpenAI `/chat/completions` endpoint.
 *
 * The proxy speaks `/chat/completions` to GitHub Copilot Enterprise upstream
 * for legacy clients (Cursor, the OpenAI SDK, etc.). For the modern
 * `/responses` surface see `openai-responses.ts`.
 *
 * Field shapes mirror the public OpenAI spec; unknown / vendor-extension
 * fields are typed as `Record<string, unknown>` rather than `any` so strict
 * mode + `noUncheckedIndexedAccess` never have to be relaxed.
 */

// ============================================================================
// Shared building blocks
// ============================================================================

export type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

export type ChatContent = string | Array<ChatContentPart>;

export type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    }
  | {
      type: "input_audio";
      input_audio: { data: string; format: "wav" | "mp3" };
    }
  | {
      // Vendor-extension content parts (e.g. cache_control wrapped — Copilot deviation).
      type: string;
      [k: string]: unknown;
    };

/** A function-tool definition: `{ type: "function", function: {...} }`. */
export interface ChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/** Catch-all for non-function tools (e.g. server tools the proxy may forward). */
export interface ChatGenericTool {
  type: string;
  [k: string]: unknown;
}

export type ChatTool = ChatFunctionTool | ChatGenericTool;

export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | { type: string; [k: string]: unknown };

/** A tool_call emitted by the assistant in a streamed delta or full response. */
export interface ChatToolCall {
  index?: number; // present on streaming deltas
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string; // partial JSON in deltas; full JSON in final
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: ChatContent | null;
  name?: string;
  tool_call_id?: string; // when role === "tool"
  tool_calls?: Array<ChatToolCall>;
  refusal?: string | null;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export type ChatFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | null;

// ============================================================================
// Request
// ============================================================================

export interface ChatRequest {
  model: string;
  messages: Array<ChatMessage>;
  tools?: Array<ChatTool>;
  tool_choice?: ChatToolChoice;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  stop?: string | Array<string>;
  max_tokens?: number; // legacy alias for max_completion_tokens
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  seed?: number;
  response_format?:
    | { type: "text" | "json_object" }
    | { type: "json_schema"; json_schema: Record<string, unknown> };
  parallel_tool_calls?: boolean;
  /** Reasoning hint — present on Copilot-Ent for o-series-style models. */
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  metadata?: Record<string, string>;
}

// ============================================================================
// Non-streaming response
// ============================================================================

export interface ChatResponseChoice {
  index: number;
  message: ChatMessage;
  finish_reason: ChatFinishReason;
  logprobs?: Record<string, unknown> | null;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<ChatResponseChoice>;
  usage: ChatUsage;
}

// ============================================================================
// Streaming chunk
// ============================================================================

export interface ChatStreamChoiceDelta {
  role?: ChatRole;
  content?: string | null;
  refusal?: string | null;
  tool_calls?: Array<ChatToolCall>;
}

export interface ChatStreamChoice {
  index: number;
  delta: ChatStreamChoiceDelta;
  finish_reason?: ChatFinishReason;
  logprobs?: Record<string, unknown> | null;
}

export interface ChatStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<ChatStreamChoice>;
  /** Final chunk only when `stream_options.include_usage === true`. */
  usage?: ChatUsage | null;
}
