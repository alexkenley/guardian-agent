import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProvider, createProviders } from './provider.js';
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
});

describe('OllamaProvider', () => {
  it('should handle chat API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));

    const config: LLMConfig = { provider: 'ollama', model: 'llama3.2' };
    const provider = createProvider(config);

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow('Ollama API error 500');

    vi.unstubAllGlobals();
  });

  it('should parse successful chat response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'test',
        model: 'llama3.2',
        choices: [{
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }));

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2', size: 1000 },
          { name: 'mistral', size: 2000 },
        ],
      }),
    }));

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
