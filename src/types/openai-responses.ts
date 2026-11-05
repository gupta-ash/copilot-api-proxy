// NEW — no upstream equivalent.
// Field shapes follow the public OpenAI Responses API documentation:
// https://platform.openai.com/docs/api-reference/responses
// Unknown vendor-extension payloads retain unknown/Record<string, unknown> types.

/**
 * openai-responses.ts — TypeScript types for the OpenAI `/responses` endpoint.
 *
 * The proxy speaks `/responses` to Codex (and any OpenAI-shape harness). This
 * module defines the request body, the non-streaming response, and the SSE
 * event union that streaming responses produce.
 *
 * An example Copilot `/responses` event ordering with web search is:
 *
 *   response.created
 *   response.in_progress
 *   response.output_item.added (reasoning summary item)
 *   response.output_item.done
 *   response.output_item.added (web_search_call item)
 *   response.web_search_call.in_progress
 *   response.web_search_call.searching
 *   response.web_search_call.completed
 *   response.output_item.done
 *   response.output_item.added (message item)
 *   response.content_part.added (output_text part)
 *   response.output_text.delta x N
 *   response.output_text.annotation.added (citation)
 *   response.output_text.done
 *   response.content_part.done
 *   response.output_item.done
 *   response.completed
 *
 * The `ResponsesStreamEvent` discriminated union below covers every event in
 * that ordering plus terminal `response.failed` and the per-segment events
 * `function_call_arguments.delta` / `.done`.
 */

// ============================================================================
// Shared building blocks
// ============================================================================

/** OpenAI tool definition — function or web_search. */
export type ResponsesTool =
  | {
      type: "function";
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }
  | {
      type: "web_search";
      // The web_search server tool takes no params; field reserved for future use.
    }
  | {
      // Arbitrary other server tools (per F22 ecosystem — bash, text_editor, etc.).
      type: string;
    };

/** Input message in the request body. Roles + content surface only the fields the proxy reads. */
export interface ResponsesInputMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | Array<ResponsesContentPart>;
}

/** Content part inside a request message. */
export type ResponsesContentPart =
  | { type: "input_text" | "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  | {
      // Catch-all for content-part shapes the proxy doesn't introspect.
      type: string;
      [k: string]: unknown;
    };

/** Usage shape returned in `response.completed` / non-streaming responses. */
export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

// ============================================================================
// Request
// ============================================================================

export interface ResponsesRequest {
  model: string;
  input: string | Array<ResponsesInputMessage>;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<ResponsesTool>;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
    | { type: "web_search" };
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed";
  };
  text?: {
    format?: { type: "text" | "json_schema"; [k: string]: unknown };
  };
  stream?: boolean;
  parallel_tool_calls?: boolean;
  store?: boolean;
  /** Optional include flags (e.g. `["web_search_call.action.sources"]`). */
  include?: Array<string>;
  metadata?: Record<string, string>;
}

// ============================================================================
// Output items (returned in `output[]` of a non-streaming response and emitted
// via `response.output_item.added/done` events)
// ============================================================================

export interface ResponsesReasoningItem {
  type: "reasoning";
  id: string;
  /** A reasoning item carries one or more summary segments. */
  summary?: Array<{ type: "summary_text"; text: string }>;
}

export interface ResponsesMessageItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: Array<{
    type: "output_text";
    text: string;
    annotations?: Array<ResponsesAnnotation>;
  }>;
}

export interface ResponsesWebSearchCallItem {
  type: "web_search_call";
  id: string;
  status: "in_progress" | "searching" | "completed" | "failed";
  /** Per F22 + OQ-SKL-6: action carries `{type: "search", queries?: string[]}` etc. */
  action?: {
    type: string;
    queries?: Array<string>;
    sources?: Array<{ type: "url"; url: string }>;
    [k: string]: unknown;
  };
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string; // JSON string
  status?: "in_progress" | "completed";
}

export type ResponsesOutputItem =
  | ResponsesReasoningItem
  | ResponsesMessageItem
  | ResponsesWebSearchCallItem
  | ResponsesFunctionCallItem
  | { type: string; id: string; [k: string]: unknown };

/** Annotation attached to an `output_text` content part. */
export interface ResponsesAnnotation {
  type: "url_citation" | string;
  start_index?: number;
  end_index?: number;
  url?: string;
  title?: string;
  [k: string]: unknown;
}

// ============================================================================
// Non-streaming response
// ============================================================================

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "in_progress" | "failed" | "incomplete";
  model: string;
  output: Array<ResponsesOutputItem>;
  usage: ResponsesUsage;
  /** Echoed from request when supplied. */
  metadata?: Record<string, string>;
  /** Only present when `status === "failed"`. */
  error?: { code?: string; message: string };
}

// ============================================================================
// Streaming events (discriminated union on `type`)
// ============================================================================

interface BaseStreamEvent {
  /** Monotonically-increasing sequence number per stream. */
  sequence_number?: number;
}

export interface ResponsesCreatedEvent extends BaseStreamEvent {
  type: "response.created";
  response: ResponsesResponse;
}

export interface ResponsesInProgressEvent extends BaseStreamEvent {
  type: "response.in_progress";
  response: ResponsesResponse;
}

export interface ResponsesCompletedEvent extends BaseStreamEvent {
  type: "response.completed";
  response: ResponsesResponse;
}

export interface ResponsesFailedEvent extends BaseStreamEvent {
  type: "response.failed";
  response: ResponsesResponse;
}

export interface ResponsesOutputItemAddedEvent extends BaseStreamEvent {
  type: "response.output_item.added";
  output_index: number;
  item: ResponsesOutputItem;
}

export interface ResponsesOutputItemDoneEvent extends BaseStreamEvent {
  type: "response.output_item.done";
  output_index: number;
  item: ResponsesOutputItem;
}

export interface ResponsesContentPartAddedEvent extends BaseStreamEvent {
  type: "response.content_part.added";
  output_index: number;
  content_index: number;
  item_id: string;
  part: {
    type: "output_text";
    text: string;
    annotations?: Array<ResponsesAnnotation>;
  };
}

export interface ResponsesContentPartDoneEvent extends BaseStreamEvent {
  type: "response.content_part.done";
  output_index: number;
  content_index: number;
  item_id: string;
  part: {
    type: "output_text";
    text: string;
    annotations?: Array<ResponsesAnnotation>;
  };
}

export interface ResponsesOutputTextDeltaEvent extends BaseStreamEvent {
  type: "response.output_text.delta";
  output_index: number;
  content_index: number;
  item_id: string;
  delta: string;
}

export interface ResponsesOutputTextDoneEvent extends BaseStreamEvent {
  type: "response.output_text.done";
  output_index: number;
  content_index: number;
  item_id: string;
  text: string;
}

export interface ResponsesOutputTextAnnotationAddedEvent extends BaseStreamEvent {
  type: "response.output_text.annotation.added";
  output_index: number;
  content_index: number;
  item_id: string;
  annotation_index: number;
  annotation: ResponsesAnnotation;
}

export interface ResponsesWebSearchCallInProgressEvent extends BaseStreamEvent {
  type: "response.web_search_call.in_progress";
  output_index: number;
  item_id: string;
}

export interface ResponsesWebSearchCallSearchingEvent extends BaseStreamEvent {
  type: "response.web_search_call.searching";
  output_index: number;
  item_id: string;
}

export interface ResponsesWebSearchCallCompletedEvent extends BaseStreamEvent {
  type: "response.web_search_call.completed";
  output_index: number;
  item_id: string;
}

export interface ResponsesFunctionCallArgumentsDeltaEvent extends BaseStreamEvent {
  type: "response.function_call_arguments.delta";
  output_index: number;
  item_id: string;
  delta: string;
}

export interface ResponsesFunctionCallArgumentsDoneEvent extends BaseStreamEvent {
  type: "response.function_call_arguments.done";
  output_index: number;
  item_id: string;
  arguments: string;
}

/** Discriminated union of every SSE event the proxy may emit on a `/responses` stream. */
export type ResponsesStreamEvent =
  | ResponsesCreatedEvent
  | ResponsesInProgressEvent
  | ResponsesCompletedEvent
  | ResponsesFailedEvent
  | ResponsesOutputItemAddedEvent
  | ResponsesOutputItemDoneEvent
  | ResponsesContentPartAddedEvent
  | ResponsesContentPartDoneEvent
  | ResponsesOutputTextDeltaEvent
  | ResponsesOutputTextDoneEvent
  | ResponsesOutputTextAnnotationAddedEvent
  | ResponsesWebSearchCallInProgressEvent
  | ResponsesWebSearchCallSearchingEvent
  | ResponsesWebSearchCallCompletedEvent
  | ResponsesFunctionCallArgumentsDeltaEvent
  | ResponsesFunctionCallArgumentsDoneEvent;
