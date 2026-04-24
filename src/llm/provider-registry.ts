/**
 * Provider Registry — manages built-in LLM provider factories.
 *
 * All providers are curated and ship with the codebase. No external
 * plugin loading or dynamic imports — this eliminates supply chain risk.
 *
 * OpenAI-compatible providers (OpenRouter, Groq, Mistral, DeepSeek,
 * Together, xAI, Google Gemini) reuse the OpenAIProvider with
 * appropriate defaults.
 */

import type { LLMProvider } from './types.js';
import type { LLMConfig } from '../config/types.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import {
  getDefaultBaseUrlForProviderType,
  listProviderTypeMetadata,
  providerRequiresCredential,
  type ProviderLocality,
  type ProviderTier,
} from './provider-metadata.js';

export interface ProviderTypeInfo {
  name: string;
  displayName: string;
  compatible: boolean;
  locality: ProviderLocality;
  tier: ProviderTier;
  requiresCredential: boolean;
  defaultBaseUrl?: string;
}

type ProviderFactory = (config: LLMConfig) => LLMProvider;

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>();
  private typeInfo = new Map<string, ProviderTypeInfo>();

  constructor() {
    // Core providers
    this.register('ollama', (config) => new OllamaProvider(config, 'ollama'));
    this.register('ollama_cloud', (config) => new OllamaProvider(config, 'ollama_cloud'));
    this.register('anthropic', (config) => new AnthropicProvider(config), 'Anthropic');
    this.register('openai', (config) => new OpenAIProvider(config), 'OpenAI');

    // OpenAI-compatible providers — same SDK, different base URL
    for (const type of listProviderTypeMetadata().filter((entry) => entry.compatible)) {
      this.register(
        type.name,
        (config) => new OpenAIProvider(
          { ...config, baseUrl: config.baseUrl ?? getDefaultBaseUrlForProviderType(type.name) },
          type.name,
        ),
        type.displayName,
      );
    }
  }

  /** Register a provider factory. */
  private register(name: string, factory: ProviderFactory, displayName?: string): void {
    this.factories.set(name, factory);
    const metadata = listProviderTypeMetadata().find((type) => type.name === name);
    if (!metadata) {
      throw new Error(`No provider metadata registered for '${name}'`);
    }
    this.typeInfo.set(name, {
      name,
      displayName: displayName ?? metadata.displayName,
      compatible: metadata.compatible,
      locality: metadata.locality,
      tier: metadata.tier,
      requiresCredential: metadata.requiresCredential,
      defaultBaseUrl: metadata.defaultBaseUrl,
    });
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
      if (providerRequiresCredential(config.provider) && !config.apiKey) {
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
    return listProviderTypeMetadata().map((type) => ({
      name: type.name,
      displayName: this.typeInfo.get(type.name)?.displayName ?? type.displayName,
      compatible: type.compatible,
      locality: type.locality,
      tier: type.tier,
      requiresCredential: type.requiresCredential,
      defaultBaseUrl: type.defaultBaseUrl,
    }));
  }
}
