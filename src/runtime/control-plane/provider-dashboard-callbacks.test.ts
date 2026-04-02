import { describe, expect, it, vi } from 'vitest';

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ChatChunk, ModelInfo } from '../../llm/types.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig, type LLMConfig } from '../../config/types.js';
import { createProviderConfigHelpers } from './provider-config-helpers.js';
import { createProviderDashboardCallbacks } from './provider-dashboard-callbacks.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createProvider(
  name: string,
  listModels: () => Promise<ModelInfo[]>,
): LLMProvider {
  return {
    name,
    chat: async (_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> => ({
      content: '',
      model: 'test-model',
      finishReason: 'stop',
    }),
    stream: async function* (_messages: ChatMessage[], _options?: ChatOptions): AsyncGenerator<ChatChunk> {
      yield { content: '', done: true };
    },
    listModels,
  };
}

describe('createProviderConfigHelpers', () => {
  it('builds provider snapshots, connectivity status, and resolved credentials', async () => {
    const config = createConfig();
    config.llm.primary = {
      provider: 'openai',
      model: 'gpt-4o',
      credentialRef: 'llm.primary.local',
    } as LLMConfig;
    config.llm.local = {
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://127.0.0.1:11434',
    } as LLMConfig;
    config.assistant.credentials.refs = {
      'llm.primary.local': {
        source: 'local',
        secretId: 'secret-primary',
        description: 'Primary provider',
      },
    };

    const runtimeProviders = new Map<string, LLMProvider>([
      ['primary', createProvider('openai', async () => [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }])],
      ['local', createProvider('ollama', async () => {
        throw new Error('offline');
      })],
    ]);
    const secretStore = {
      get: vi.fn((secretId: string) => (secretId === 'secret-primary' ? 'resolved-secret' : undefined)),
    };

    const helpers = createProviderConfigHelpers({
      configRef: { current: config },
      runtimeProviders,
      secretStore: secretStore as never,
      isLocalProviderEndpoint: (baseUrl, providerType) => providerType === 'ollama' || !!baseUrl?.includes('127.0.0.1'),
    });

    expect(helpers.getProviderInfoSnapshot()).toEqual([
      {
        name: 'primary',
        type: 'openai',
        model: 'gpt-4o',
        baseUrl: undefined,
        locality: 'external',
        connected: false,
      },
      {
        name: 'local',
        type: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434',
        locality: 'local',
        connected: false,
      },
    ]);

    await expect(helpers.buildProviderInfo(true)).resolves.toEqual([
      {
        name: 'primary',
        type: 'openai',
        model: 'gpt-4o',
        baseUrl: undefined,
        locality: 'external',
        connected: true,
        availableModels: ['gpt-4o'],
      },
      {
        name: 'local',
        type: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434',
        locality: 'local',
        connected: false,
      },
    ]);
    expect(helpers.resolveCredentialForProviderInput('llm.primary.local', undefined)).toBe('resolved-secret');
    expect(helpers.resolveCredentialForProviderInput('llm.primary.local', '  direct-key  ')).toBe('direct-key');
    expect(helpers.getDefaultModelForProviderType('OpenAI')).toBe('gpt-4o');
    expect(helpers.existingProfilesById({
      awsProfiles: [
        { id: 'one', region: 'us-east-1' },
        { region: 'us-west-1' },
        'ignored',
      ],
    }, 'awsProfiles')).toEqual(new Map([
      ['one', { id: 'one', region: 'us-east-1' }],
    ]));
  });
});

describe('createProviderDashboardCallbacks', () => {
  it('delegates snapshot, status, types, and model loading through the provider boundary', async () => {
    const snapshot = [
      {
        name: 'primary',
        type: 'openai',
        model: 'gpt-4o',
        locality: 'external' as const,
        connected: false,
      },
    ];
    const status = [
      {
        ...snapshot[0],
        connected: true,
        availableModels: ['gpt-4o', 'gpt-4.1'],
      },
    ];
    const providerRegistry = {
      listProviderTypes: vi.fn(() => [
        { name: 'ollama', displayName: 'Ollama', compatible: false },
        { name: 'openai', displayName: 'OpenAI', compatible: false },
      ]),
      hasProvider: vi.fn((name: string) => name === 'ollama' || name === 'openai'),
      createProvider: vi.fn((_config: LLMConfig) => ({
        listModels: vi.fn(async () => [
          { id: 'gpt-4o' },
          { id: 'gpt-4.1' },
        ]),
      })),
    };
    const callbacks = createProviderDashboardCallbacks({
      getProviderInfoSnapshot: () => snapshot,
      buildProviderInfo: vi.fn(async () => status),
      resolveCredentialForProviderInput: vi.fn(() => 'resolved-secret'),
      getDefaultModelForProviderType: vi.fn(() => 'gpt-4o'),
      isLocalProviderEndpoint: (_baseUrl, providerType) => providerType === 'ollama',
      providerRegistry,
    });

    expect(callbacks.onProviders?.()).toEqual(snapshot);
    expect(callbacks.onProviderTypes?.()).toEqual([
      { name: 'ollama', displayName: 'Ollama', compatible: false, locality: 'local' },
      { name: 'openai', displayName: 'OpenAI', compatible: false, locality: 'external' },
    ]);
    await expect(callbacks.onProvidersStatus?.()).resolves.toEqual(status);
    await expect(callbacks.onProviderModels?.({
      providerType: 'openai',
      credentialRef: 'llm.primary.local',
    })).resolves.toEqual({
      models: ['gpt-4o', 'gpt-4.1'],
    });
    expect(providerRegistry.createProvider).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: undefined,
      apiKey: 'resolved-secret',
    });
  });

  it('rejects external model discovery without credentials', async () => {
    const callbacks = createProviderDashboardCallbacks({
      getProviderInfoSnapshot: () => [],
      buildProviderInfo: async () => [],
      resolveCredentialForProviderInput: () => undefined,
      getDefaultModelForProviderType: () => 'gpt-4o',
      isLocalProviderEndpoint: () => false,
      providerRegistry: {
        listProviderTypes: () => [],
        hasProvider: (name: string) => name === 'openai',
        createProvider: () => ({
          listModels: async () => [],
        }),
      },
    });

    await expect(callbacks.onProviderModels?.({ providerType: 'openai' })).rejects.toThrow(
      'Provide an API key or credential ref to load models for this provider.',
    );
  });
});
