/**
 * OpenAI LLM provider.
 *
 * Wraps the openai SDK with direct mapping to unified types.
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  ChatChunk,
  ChatOptions,
  ModelInfo,
  ToolCall,
} from './types.js';
import type { LLMConfig } from '../config/types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 120_000,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: messages.map(toOpenAIMessage),
    };

    if (options?.tools?.length) {
      params.tools = options.tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    let response: OpenAI.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      throw wrapOpenAIError(err, params.model as string);
    }
    const choice = response.choices[0];

    const toolCalls = choice?.message.tool_calls
      ?.filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
      .map((tc): ToolCall => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

    return {
      content: choice?.message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      model: response.model,
      finishReason: mapFinishReason(choice?.finish_reason),
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err) {
      throw wrapOpenAIError(err, params.model as string);
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const isLast = chunk.choices[0]?.finish_reason !== null && chunk.choices[0]?.finish_reason !== undefined;

      yield {
        content: delta?.content ?? '',
        done: isLast,
        usage: chunk.usage
          ? {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            }
          : undefined,
      };

      if (isLast) return;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const list = await this.client.models.list();
      const models: ModelInfo[] = [];
      for await (const model of list) {
        models.push({
          id: model.id,
          name: model.id,
          provider: 'openai',
        });
      }
      return models;
    } catch {
      return [];
    }
  }
}

function toOpenAIMessage(msg: ChatMessage): OpenAI.ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.toolCallId ?? '',
    };
  }
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: msg.role, content: msg.content } as OpenAI.ChatCompletionMessageParam;
}

function mapFinishReason(reason?: string | null): ChatResponse['finishReason'] {
  switch (reason) {
    case 'stop': return 'stop';
    case 'tool_calls': return 'tool_calls';
    case 'length': return 'length';
    default: return 'stop';
  }
}

/** Wrap OpenAI SDK errors into user-friendly messages. */
function wrapOpenAIError(err: unknown, model: string): Error {
  const status = (err as { status?: number })?.status ?? 0;
  const raw = err instanceof Error ? err.message : String(err);

  if (status === 404 || raw.includes('model_not_found') || raw.includes('does not exist')) {
    return Object.assign(
      new Error(`Model "${model}" is not available on your OpenAI API key. Check your plan or choose a different model in /config.`),
      { status },
    );
  }
  if (status === 401) {
    return Object.assign(
      new Error('OpenAI API key is invalid or expired. Update it in Configuration > Providers.'),
      { status },
    );
  }
  if (status === 403) {
    return Object.assign(
      new Error(`Access denied for model "${model}". Your OpenAI API plan may not include this model.`),
      { status },
    );
  }
  if (status === 429) {
    return Object.assign(
      new Error('OpenAI rate limit exceeded or quota depleted. Check your usage at platform.openai.com.'),
      { status },
    );
  }
  if (status === 503 || raw.includes('overloaded')) {
    return Object.assign(
      new Error('OpenAI API is currently overloaded. Please try again shortly.'),
      { status },
    );
  }
  return err instanceof Error ? err : new Error(raw);
}
