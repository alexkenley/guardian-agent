/**
 * LLM provider abstraction types.
 *
 * Unified interface for Ollama Local, Ollama Cloud, Anthropic, OpenAI,
 * and OpenAI-compatible providers.
 * No LangChain — direct SDK calls for debuggability.
 */

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool call ID (for tool result messages). */
  toolCallId?: string;
  /** Tool calls requested by the assistant. */
  toolCalls?: ToolCall[];
}

/** Response from a chat completion. */
export interface ChatResponse {
  /** The assistant's response content. */
  content: string;
  /** Tool calls requested by the assistant (if any). */
  toolCalls?: ToolCall[];
  /** Token usage information. */
  usage?: TokenUsage;
  /** The model that generated the response. */
  model: string;
  /** Provider-specific finish reason. */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/** A streamed chunk from a chat completion. */
export interface ChatChunk {
  /** Incremental content delta. */
  content: string;
  /** Whether this is the final chunk. */
  done: boolean;
  /** Token usage (only on final chunk, if available). */
  usage?: TokenUsage;
}

/** Token usage information. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens written to Anthropic prompt cache (first request only). */
  cacheCreationTokens?: number;
  /** Tokens read from Anthropic prompt cache (cache hit). */
  cacheReadTokens?: number;
}

/** Information about an available model. */
export interface ModelInfo {
  /** Model identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider that offers this model. */
  provider: string;
  /** Context window size (tokens). */
  contextWindow?: number;
}

/** Definition of a tool the LLM can call. */
export interface ToolDefinition {
  /** Tool name (function name). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

/** A tool call requested by the LLM. */
export interface ToolCall {
  /** Unique ID for this tool call. */
  id: string;
  /** Tool/function name. */
  name: string;
  /** Arguments as a JSON string or parsed object. */
  arguments: string;
}

/** Options for a chat completion request. */
export interface ChatOptions {
  /** Override the default model. */
  model?: string;
  /** Override max tokens. */
  maxTokens?: number;
  /** Override temperature. */
  temperature?: number;
  /** Ask the provider to constrain the response shape when supported. */
  responseFormat?: (
    | { type: 'json_object' }
    | { type: 'json_schema'; name: string; schema: Record<string, unknown> }
  );
  /** Tools available for the LLM to call. */
  tools?: ToolDefinition[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** Unified LLM provider interface. */
export interface LLMProvider {
  /** Provider type name (for example 'ollama', 'ollama_cloud', 'anthropic', or 'openai'). */
  readonly name: string;

  /** Send a chat completion request. */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a chat completion as an async generator. */
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatChunk>;

  /** List available models. */
  listModels(): Promise<ModelInfo[]>;
}
