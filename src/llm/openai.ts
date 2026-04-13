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
import { getProviderTypeMetadata } from './provider-metadata.js';

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private providerLabel: string;
  private baseUrl: string | undefined;

  constructor(config: LLMConfig, providerName?: string) {
    this.name = providerName ?? 'openai';
    this.providerLabel = getProviderTypeMetadata(this.name)?.displayName ?? this.name;
    this.baseUrl = config.baseUrl;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: this.baseUrl,
      timeout: config.timeoutMs ?? 120_000,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    let params = this.buildChatParams(messages, options, false, false);
    let response: OpenAI.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params, { signal: options?.signal });
    } catch (err) {
      if (shouldRetryWithMaxCompletionTokens(err)) {
        params = this.buildChatParams(messages, options, false, true);
        try {
          response = await this.client.chat.completions.create(params, { signal: options?.signal });
        } catch (retryErr) {
          throw wrapOpenAIError(retryErr, {
            model: params.model as string,
            providerLabel: this.providerLabel,
            baseUrl: this.baseUrl,
          });
        }
      } else {
        throw wrapOpenAIError(err, {
          model: params.model as string,
          providerLabel: this.providerLabel,
          baseUrl: this.baseUrl,
        });
      }
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
    let params = this.buildChatParams(messages, options, true, false);
    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err) {
      if (shouldRetryWithMaxCompletionTokens(err)) {
        params = this.buildChatParams(messages, options, true, true);
        try {
          stream = await this.client.chat.completions.create(params);
        } catch (retryErr) {
          throw wrapOpenAIError(retryErr, {
            model: params.model as string,
            providerLabel: this.providerLabel,
            baseUrl: this.baseUrl,
          });
        }
      } else {
        throw wrapOpenAIError(err, {
          model: params.model as string,
          providerLabel: this.providerLabel,
          baseUrl: this.baseUrl,
        });
      }
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
          provider: this.name,
        });
      }
      return models;
    } catch (err) {
      throw wrapOpenAIError(err, {
        operation: 'models',
        providerLabel: this.providerLabel,
        baseUrl: this.baseUrl,
      });
    }
  }

  private buildChatParams(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    stream: false,
    useMaxCompletionTokens: boolean,
  ): OpenAI.ChatCompletionCreateParamsNonStreaming;
  private buildChatParams(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    stream: true,
    useMaxCompletionTokens: boolean,
  ): OpenAI.ChatCompletionCreateParamsStreaming;
  private buildChatParams(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    stream: boolean,
    useMaxCompletionTokens: boolean,
  ): OpenAI.ChatCompletionCreateParamsNonStreaming | OpenAI.ChatCompletionCreateParamsStreaming {
    const params = {
      model: options?.model ?? this.model,
      temperature: options?.temperature ?? this.temperature,
      messages: messages.map(toOpenAIMessage),
      ...(stream
        ? {
            stream: true as const,
            stream_options: { include_usage: true },
          }
        : {}),
      ...(useMaxCompletionTokens
        ? { max_completion_tokens: options?.maxTokens ?? this.maxTokens }
        : { max_tokens: options?.maxTokens ?? this.maxTokens }),
    } satisfies Record<string, unknown>;

    if (options?.tools?.length) {
      Object.assign(params, {
        tools: options.tools.map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
      });
    }

    if (options?.responseFormat?.type === 'json_object') {
      Object.assign(params, {
        response_format: { type: 'json_object' as const },
      });
    } else if (options?.responseFormat?.type === 'json_schema') {
      Object.assign(params, {
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: options.responseFormat.name,
            schema: options.responseFormat.schema,
            strict: true,
          },
        },
      });
    }

    return stream
      ? params as OpenAI.ChatCompletionCreateParamsStreaming
      : params as OpenAI.ChatCompletionCreateParamsNonStreaming;
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

function shouldRetryWithMaxCompletionTokens(err: unknown): boolean {
  const status = (err as { status?: number })?.status ?? 0;
  const raw = err instanceof Error ? err.message : String(err);
  return status === 400
    && /max_tokens/i.test(raw)
    && /max_completion_tokens/i.test(raw);
}

/** Wrap OpenAI-compatible SDK errors into user-friendly messages. */
function wrapOpenAIError(err: unknown, context: {
  model?: string;
  operation?: 'chat' | 'models';
  providerLabel: string;
  baseUrl?: string;
}): Error {
  const status = (err as { status?: number })?.status ?? 0;
  const raw = err instanceof Error ? err.message : String(err);
  const provider = context.providerLabel;
  const operationLabel = context.operation === 'models' ? 'load models from' : 'reach';
  const providerLocation = context.baseUrl ? ` at ${context.baseUrl}` : '';

  if (
    status === 404
    || raw.includes('model_not_found')
    || raw.includes('does not exist')
    || /model not found/i.test(raw)
  ) {
    return Object.assign(
      new Error(
        context.model
          ? `Model "${context.model}" is not available on ${provider}. Choose a different model in Configuration > Providers.`
          : `Could not load models from ${provider}. Check the configured model family and API access.`,
      ),
      { status },
    );
  }
  if (status === 401) {
    return Object.assign(
      new Error(`${provider} API key is invalid or expired. Update it in Configuration > Providers.`),
      { status },
    );
  }
  if (status === 403) {
    return Object.assign(
      new Error(
        context.model
          ? `Access denied for model "${context.model}" on ${provider}. Your account may not include this model.`
          : `Access denied while loading models from ${provider}. Check that the API key has access to this account.`,
      ),
      { status },
    );
  }
  if (status === 429) {
    return Object.assign(
      new Error(`${provider} rate limit exceeded or quota depleted. Check the account limits for this provider.`),
      { status },
    );
  }
  if (status === 503 || raw.includes('overloaded')) {
    return Object.assign(
      new Error(`${provider} API is currently overloaded. Please try again shortly.`),
      { status },
    );
  }
  if (/fetch failed|connection error|ECONNREFUSED|ENOTFOUND|network/i.test(raw)) {
    return Object.assign(
      new Error(`Could not ${operationLabel} ${provider}${providerLocation}. Check the base URL, network access, and API status.`),
      { status: status || 0 },
    );
  }
  return err instanceof Error ? err : new Error(raw);
}
