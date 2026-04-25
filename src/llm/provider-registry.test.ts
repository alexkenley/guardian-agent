/**
 * Tests for ProviderRegistry — built-in LLM provider management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from './provider-registry.js';
import type { LLMConfig } from '../config/types.js';

function makeLLMConfig(provider: string, overrides?: Partial<LLMConfig>): LLMConfig {
  return { provider, model: 'test-model', ...overrides };
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  // ─── Core Providers ─────────────────────────────────────

  it('has all three core providers registered', () => {
    expect(registry.hasProvider('ollama')).toBe(true);
    expect(registry.hasProvider('anthropic')).toBe(true);
    expect(registry.hasProvider('openai')).toBe(true);
  });

  it('creates ollama provider', () => {
    const provider = registry.createProvider(makeLLMConfig('ollama'));
    expect(provider.name).toBe('ollama');
  });

  it('creates anthropic provider', () => {
    const provider = registry.createProvider(makeLLMConfig('anthropic', { apiKey: 'test' }));
    expect(provider.name).toBe('anthropic');
  });

  it('creates openai provider', () => {
    const provider = registry.createProvider(makeLLMConfig('openai', { apiKey: 'test' }));
    expect(provider.name).toBe('openai');
  });

  // ─── OpenAI-Compatible Providers ────────────────────────

  it('creates openrouter provider (OpenAI-compatible managed cloud)', () => {
    const provider = registry.createProvider(makeLLMConfig('openrouter', { apiKey: 'test' }));
    expect(provider.name).toBe('openrouter');
  });

  it('creates nvidia provider (OpenAI-compatible managed cloud)', () => {
    const provider = registry.createProvider(makeLLMConfig('nvidia', { apiKey: 'nvapi-test' }));
    expect(provider.name).toBe('nvidia');
  });

  it('creates groq provider (OpenAI-compatible)', () => {
    const provider = registry.createProvider(makeLLMConfig('groq', { apiKey: 'gsk_test' }));
    expect(provider.name).toBe('groq');
  });

  it('creates mistral provider (OpenAI-compatible)', () => {
    const provider = registry.createProvider(makeLLMConfig('mistral', { apiKey: 'test' }));
    expect(provider.name).toBe('mistral');
  });

  it('creates deepseek provider (OpenAI-compatible)', () => {
    const provider = registry.createProvider(makeLLMConfig('deepseek', { apiKey: 'test' }));
    expect(provider.name).toBe('deepseek');
  });

  it('creates together provider (OpenAI-compatible)', () => {
    const provider = registry.createProvider(makeLLMConfig('together', { apiKey: 'test' }));
    expect(provider.name).toBe('together');
  });

  it('creates xai provider (OpenAI-compatible)', () => {
    const provider = registry.createProvider(makeLLMConfig('xai', { apiKey: 'test' }));
    expect(provider.name).toBe('xai');
  });

  it('creates google provider (Gemini via OpenAI-compat)', () => {
    const provider = registry.createProvider(makeLLMConfig('google', { apiKey: 'test' }));
    expect(provider.name).toBe('google');
  });

  it('compatible provider uses custom baseUrl when specified', () => {
    const provider = registry.createProvider(
      makeLLMConfig('groq', { apiKey: 'test', baseUrl: 'https://custom.groq.endpoint/v1' }),
    );
    expect(provider.name).toBe('groq');
  });

  // ─── Error Handling ─────────────────────────────────────

  it('throws on unknown provider type', () => {
    expect(() => registry.createProvider(makeLLMConfig('nonexistent')))
      .toThrow("Unknown LLM provider: 'nonexistent'");
  });

  it('error message lists available providers', () => {
    try {
      registry.createProvider(makeLLMConfig('bad'));
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('ollama');
      expect(message).toContain('groq');
      expect(message).toContain('mistral');
    }
  });

  // ─── Registry Queries ───────────────────────────────────

  it('listProviderNames returns all registered providers', () => {
    const names = registry.listProviderNames();
    expect(names).toContain('ollama');
    expect(names).toContain('ollama_cloud');
    expect(names).toContain('openrouter');
    expect(names).toContain('nvidia');
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
    expect(names).toContain('groq');
    expect(names).toContain('mistral');
    expect(names).toContain('deepseek');
    expect(names).toContain('together');
    expect(names).toContain('xai');
    expect(names).toContain('google');
    expect(names.length).toBe(12);
  });

  it('listProviderTypes returns metadata for all providers', () => {
    const types = registry.listProviderTypes();

    const ollama = types.find(t => t.name === 'ollama');
    expect(ollama?.displayName).toBe('Ollama');
    expect(ollama?.compatible).toBe(false);
    expect(ollama?.tier).toBe('local');

    const ollamaCloud = types.find(t => t.name === 'ollama_cloud');
    expect(ollamaCloud?.displayName).toBe('Ollama Cloud');
    expect(ollamaCloud?.compatible).toBe(false);
    expect(ollamaCloud?.tier).toBe('managed_cloud');
    expect(ollamaCloud?.requiresCredential).toBe(true);

    const openrouter = types.find(t => t.name === 'openrouter');
    expect(openrouter?.displayName).toBe('OpenRouter');
    expect(openrouter?.compatible).toBe(true);
    expect(openrouter?.tier).toBe('managed_cloud');
    expect(openrouter?.requiresCredential).toBe(true);
    expect(openrouter?.defaultBaseUrl).toBe('https://openrouter.ai/api/v1');

    const nvidia = types.find(t => t.name === 'nvidia');
    expect(nvidia?.displayName).toBe('NVIDIA Cloud');
    expect(nvidia?.compatible).toBe(true);
    expect(nvidia?.tier).toBe('managed_cloud');
    expect(nvidia?.requiresCredential).toBe(true);
    expect(nvidia?.defaultBaseUrl).toBe('https://integrate.api.nvidia.com/v1');

    const groq = types.find(t => t.name === 'groq');
    expect(groq?.displayName).toBe('Groq');
    expect(groq?.compatible).toBe(true);

    const google = types.find(t => t.name === 'google');
    expect(google?.displayName).toBe('Google Gemini');
    expect(google?.compatible).toBe(true);
  });

  it('createProviders creates multiple providers from config map', () => {
    const providers = registry.createProviders({
      local: makeLLMConfig('ollama'),
      fast: makeLLMConfig('groq', { apiKey: 'test' }),
    });

    expect(providers.size).toBe(2);
    expect(providers.get('local')?.name).toBe('ollama');
    expect(providers.get('fast')?.name).toBe('groq');
  });
});
