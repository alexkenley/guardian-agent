/**
 * Provider Registry — manages built-in LLM provider factories.
 *
 * All providers are curated and ship with the codebase. No external
 * plugin loading or dynamic imports — this eliminates supply chain risk.
 *
 * OpenAI-compatible providers (Groq, Mistral, DeepSeek, Together, xAI,
 * Google Gemini) reuse the OpenAIProvider with appropriate defaults.
 */

import type { LLMProvider } from './types.js';
import type { LLMConfig } from '../config/types.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
/** Default base URLs for OpenAI-compatible providers. */
const COMPATIBLE_DEFAULTS: Record<string, { baseUrl: string; displayName: string }> = {
  groq:     { baseUrl: 'https://api.groq.com/openai/v1',                                    displayName: 'Groq' },
  mistral:  { baseUrl: 'https://api.mistral.ai/v1',                                         displayName: 'Mistral AI' },
  deepseek: { baseUrl: 'https://api.deepseek.com',                                          displayName: 'DeepSeek' },
  together: { baseUrl: 'https://api.together.xyz/v1',                                       displayName: 'Together AI' },
  xai:      { baseUrl: 'https://api.x.ai/v1',                                               displayName: 'xAI (Grok)' },
  google:   { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',            displayName: 'Google Gemini' },
};

export interface ProviderTypeInfo {
  name: string;
  displayName: string;
  compatible: boolean;
}

type ProviderFactory = (config: LLMConfig) => LLMProvider;

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>();
  private displayNames = new Map<string, string>();

  constructor() {
    // Core providers
    this.register('ollama', (config) => new OllamaProvider(config), 'Ollama');
    this.register('anthropic', (config) => new AnthropicProvider(config), 'Anthropic');
    this.register('openai', (config) => new OpenAIProvider(config), 'OpenAI');

    // OpenAI-compatible providers — same SDK, different base URL
    for (const [name, defaults] of Object.entries(COMPATIBLE_DEFAULTS)) {
      this.register(
        name,
        (config) => new OpenAIProvider(
          { ...config, baseUrl: config.baseUrl ?? defaults.baseUrl },
          name,
        ),
        defaults.displayName,
      );
    }
  }

  /** Register a provider factory. */
  private register(name: string, factory: ProviderFactory, displayName: string): void {
    this.factories.set(name, factory);
    this.displayNames.set(name, displayName);
  }

  /** Create a provider from config. */
  createProvider(config: LLMConfig): LLMProvider {
    const factory = this.factories.get(config.provider);
    if (!factory) {
      throw new Error(
        `Unknown LLM provider: '${config.provider}'. Available: ${this.listProviderNames().join(', ')}`,
      );
    }
    return factory(config);
  }

  /** Create all providers from a config map. Skips providers that fail to initialize (e.g. missing credentials). */
  createProviders(configs: Record<string, LLMConfig>): Map<string, LLMProvider> {
    const providers = new Map<string, LLMProvider>();
    for (const [name, config] of Object.entries(configs)) {
      // Skip non-Ollama providers with no API key — they'll start disconnected.
      if (config.provider !== 'ollama' && !config.apiKey) {
        continue;
      }
      try {
        providers.set(name, this.createProvider(config));
      } catch {
        // Provider SDK threw on initialization (e.g. missing API key) — skip it.
      }
    }
    return providers;
  }

  /** Check if a provider type is registered. */
  hasProvider(name: string): boolean {
    return this.factories.has(name);
  }

  /** List all registered provider type names. */
  listProviderNames(): string[] {
    return [...this.factories.keys()];
  }

  /** List all registered provider types with metadata. */
  listProviderTypes(): ProviderTypeInfo[] {
    return [...this.factories.keys()].map(name => ({
      name,
      displayName: this.displayNames.get(name) ?? name,
      compatible: name in COMPATIBLE_DEFAULTS,
    }));
  }
}
