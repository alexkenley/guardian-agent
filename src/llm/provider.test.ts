import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFailoverProvider, createProvider, createProviders } from './provider.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMConfig } from '../config/types.js';

describe('createProvider', () => {
  it('should create OllamaProvider for ollama config', () => {
    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
  });

  it('should create AnthropicProvider for anthropic config', () => {
    const config: LLMConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
  });

  it('should create OpenAIProvider for openai config', () => {
    const config: LLMConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
    };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
  });

  it('should throw for unknown provider', () => {
    const config = { provider: 'unknown', model: 'test' } as LLMConfig;
    expect(() => createProvider(config)).toThrow("Unknown LLM provider: 'unknown'");
  });
});

describe('createProviders', () => {
  it('should create a map of providers from config', () => {
    const configs: Record<string, LLMConfig> = {
      local: { provider: 'ollama', model: 'llama3.2' },
      cloud: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    };

    const providers = createProviders(configs);
    expect(providers.size).toBe(2);
    expect(providers.get('local')).toBeInstanceOf(OllamaProvider);
    expect(providers.get('cloud')).toBeInstanceOf(OpenAIProvider);
  });

  it('skips disabled provider profiles', () => {
    const configs: Record<string, LLMConfig> = {
      local: { provider: 'ollama', model: 'llama3.2' },
      cloud: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test', enabled: false },
    };

    const providers = createProviders(configs);
    expect(providers.size).toBe(1);
    expect(providers.has('local')).toBe(true);
    expect(providers.has('cloud')).toBe(false);
  });
});

describe('createFailoverProvider', () => {
  it('skips disabled provider profiles in failover order', () => {
    const failover = createFailoverProvider({
      local: { provider: 'ollama', model: 'llama3.2' },
      cloud: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test', enabled: false },
    });

    expect(failover.getCircuitStates().map((state) => state.name)).toEqual(['local']);
  });
});

describe('OllamaProvider', () => {
  it('should handle chat API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: {
          'content-type': 'text/plain',
        },
      }),
    ));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow('Ollama API error 500');

    vi.unstubAllGlobals();
  });

  it('should parse successful chat response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        model: 'llama3.2',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Hello!' },
        done: true,
        done_reason: 'stop',
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: 10,
        prompt_eval_duration: 1,
        eval_count: 5,
        eval_duration: 1,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    ));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);
    const response = await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(response.content).toBe('Hello!');
    expect(response.model).toBe('llama3.2');
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.totalTokens).toBe(15);

    vi.unstubAllGlobals();
  });

  it('should surface a helpful connectivity error when Ollama is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow('Could not reach Ollama');

    vi.unstubAllGlobals();
  });

  it('should list models via /api/tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        models: [
          { name: 'llama3.2', size: 1000 },
          { name: 'mistral', size: 2000 },
        ],
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    ));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);
    const models = await provider.listModels();

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'llama3.2', provider: 'ollama' });

    vi.unstubAllGlobals();
  });

  it('should return empty list on connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);
    const models = await provider.listModels();

    expect(models).toEqual([]);

    vi.unstubAllGlobals();
  });
});

describe('AnthropicProvider', () => {
  it('should list known models', async () => {
    const config: LLMConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    };
    const provider = createProvider(config);
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models[0].provider).toBe('anthropic');
  });
});

describe('OpenAIProvider compatibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries with max_completion_tokens when max_tokens is rejected by newer OpenAI models', async () => {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-5.1',
      apiKey: 'sk-test',
    });

    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
        { status: 400 },
      ))
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: 'Hello from GPT-5.1' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 4,
          total_tokens: 9,
        },
        model: 'gpt-5.1',
      });

    (provider as any).client = {
      chat: {
        completions: {
          create,
        },
      },
      models: {
        list: vi.fn(),
      },
    };

    const response = await provider.chat([{ role: 'user', content: 'Hello?' }]);

    expect(response.content).toBe('Hello from GPT-5.1');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.1',
      max_tokens: 4096,
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      model: 'gpt-5.1',
      max_completion_tokens: 4096,
    });
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('max_tokens');
  });

  it('passes JSON response format hints through to OpenAI-compatible providers', async () => {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
    });

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: { content: '{"ok":true}' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      model: 'gpt-4.1-mini',
    });

    (provider as any).client = {
      chat: {
        completions: {
          create,
        },
      },
      models: {
        list: vi.fn(),
      },
    };

    await provider.chat([{ role: 'user', content: 'Return JSON.' }], {
      responseFormat: { type: 'json_object' },
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('surfaces provider-specific model-not-found guidance for xAI', async () => {
    const provider = new OpenAIProvider({
      provider: 'xai',
      model: 'grok-2-latest',
      apiKey: 'xai-test',
      baseUrl: 'https://api.x.ai/v1',
    }, 'xai');

    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error('400 Model not found: grok-2-latest'), { status: 400 }),
    );

    (provider as any).client = {
      chat: {
        completions: {
          create,
        },
      },
      models: {
        list: vi.fn(),
      },
    };

    await expect(
      provider.chat([{ role: 'user', content: 'Hello?' }]),
    ).rejects.toThrow('Model "grok-2-latest" is not available on xAI (Grok)');
  });

  it('throws provider-specific model listing errors instead of silently returning an empty list', async () => {
    const provider = new OpenAIProvider({
      provider: 'xai',
      model: 'grok-4',
      apiKey: 'xai-test',
      baseUrl: 'https://api.x.ai/v1',
    }, 'xai');

    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
      models: {
        list: vi.fn().mockRejectedValue(
          Object.assign(new Error('Unauthorized'), { status: 401 }),
        ),
      },
    };

    await expect(provider.listModels()).rejects.toThrow('xAI (Grok) API key is invalid or expired');
  });
});
