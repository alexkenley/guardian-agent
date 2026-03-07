/**
 * Anthropic LLM provider.
 *
 * Wraps @anthropic-ai/sdk, maps unified ChatMessage to Anthropic format.
 */

import Anthropic from '@anthropic-ai/sdk';
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

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 120_000,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const { systemPrompt, userMessages } = splitMessages(messages);

    const params: Anthropic.MessageCreateParams = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: userMessages,
    };

    if (systemPrompt) {
      // Prompt caching: mark system prompt as ephemeral for Anthropic cache
      params.system = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ] as Anthropic.TextBlockParam[];
    }

    if (options?.tools?.length) {
      params.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      }));
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      throw wrapAnthropicError(err, params.model);
    }

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const usage = response.usage as { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
      },
      model: response.model,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    const { systemPrompt, userMessages } = splitMessages(messages);

    const params: Anthropic.MessageCreateParams = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: userMessages,
      stream: true,
    };

    if (systemPrompt) {
      params.system = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ] as Anthropic.TextBlockParam[];
    }

    let stream: ReturnType<Anthropic['messages']['stream']>;
    try {
      stream = this.client.messages.stream(params);
    } catch (err) {
      throw wrapAnthropicError(err, params.model);
    }

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if ('text' in delta) {
          yield { content: delta.text, done: false };
        }
      } else if (event.type === 'message_stop') {
        const finalMessage = await stream.finalMessage();
        yield {
          content: '',
          done: true,
          usage: {
            promptTokens: finalMessage.usage.input_tokens,
            completionTokens: finalMessage.usage.output_tokens,
            totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
          },
        };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Anthropic doesn't have a model list API — return known models
    return [
      // Latest generation
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000 },
      // Previous generation
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200_000 },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200_000 },
    ];
  }
}

/** Split unified messages into Anthropic system prompt + messages. */
function splitMessages(messages: ChatMessage[]): {
  systemPrompt: string | undefined;
  userMessages: Anthropic.MessageParam[];
} {
  let systemPrompt: string | undefined;
  const userMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = (systemPrompt ? systemPrompt + '\n' : '') + msg.content;
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      // Assistant message with tool calls → include tool_use content blocks
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* empty */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      userMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      userMessages.push({ role: msg.role, content: msg.content });
    } else if (msg.role === 'tool') {
      userMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: msg.content,
          },
        ],
      });
    }
  }

  return { systemPrompt, userMessages };
}

/** Wrap Anthropic SDK errors into user-friendly messages. */
function wrapAnthropicError(err: unknown, model: string): Error {
  const status = (err as { status?: number })?.status ?? 0;
  const raw = err instanceof Error ? err.message : String(err);

  if (status === 404 || raw.includes('not_found')) {
    return Object.assign(
      new Error(`Model "${model}" is not available on your Anthropic API key. Check your plan or choose a different model in /config.`),
      { status },
    );
  }
  if (status === 401) {
    return Object.assign(
      new Error('Anthropic API key is invalid or expired. Update it in Configuration > Providers.'),
      { status },
    );
  }
  if (status === 403) {
    return Object.assign(
      new Error(`Access denied for model "${model}". Your Anthropic API plan may not include this model.`),
      { status },
    );
  }
  if (status === 429) {
    return Object.assign(
      new Error('Anthropic rate limit exceeded. Please wait a moment and try again.'),
      { status },
    );
  }
  if (status === 529 || raw.includes('overloaded')) {
    return Object.assign(
      new Error('Anthropic API is currently overloaded. Please try again shortly.'),
      { status },
    );
  }
  return err instanceof Error ? err : new Error(raw);
}
