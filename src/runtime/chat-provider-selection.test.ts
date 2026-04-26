import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import {
  attachChatProviderSelectionMetadata,
  buildChatProviderSelectorOptions,
  normalizeChatProviderSelectionValue,
  readChatProviderSelectionMetadata,
} from './chat-provider-selection.js';

function createConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud-direct'] = {
    provider: 'ollama_cloud',
    model: 'minimax-m2.1',
    credentialRef: 'llm.ollama_cloud.direct',
  };
  config.llm['ollama-cloud-tools'] = {
    provider: 'ollama_cloud',
    model: 'qwen3:32b',
    credentialRef: 'llm.ollama_cloud.tools',
  };
  config.llm.openai = {
    provider: 'openai',
    model: 'gpt-5.1',
    credentialRef: 'llm.openai.primary',
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud-direct',
    frontier: 'openai',
  };
  return config;
}

describe('chat provider selection', () => {
  it('lists enabled provider profiles with automatic first', () => {
    const config = createConfig();
    config.llm['ollama-cloud-tools'].enabled = false;

    expect(buildChatProviderSelectorOptions(config)).toEqual([
      {
        value: 'auto',
        label: 'Automatic',
      },
      {
        value: 'ollama',
        label: 'Ollama (local · gpt-oss:120b)',
        providerName: 'ollama',
        providerType: 'ollama',
        providerTier: 'local',
        providerLocality: 'local',
        model: 'gpt-oss:120b',
      },
      {
        value: 'ollama-cloud-direct',
        label: 'ollama-cloud-direct (managed cloud · Ollama Cloud · minimax-m2.1)',
        providerName: 'ollama-cloud-direct',
        providerType: 'ollama_cloud',
        providerTier: 'managed_cloud',
        providerLocality: 'external',
        model: 'minimax-m2.1',
      },
      {
        value: 'openai',
        label: 'OpenAI (frontier · gpt-5.1)',
        providerName: 'openai',
        providerType: 'openai',
        providerTier: 'frontier',
        providerLocality: 'external',
        model: 'gpt-5.1',
      },
    ]);
  });

  it('round-trips request-scoped provider selection metadata for enabled providers', () => {
    const config = createConfig();
    const metadata = attachChatProviderSelectionMetadata({ existing: true }, 'ollama-cloud-direct');

    expect(normalizeChatProviderSelectionValue(config, 'ollama-cloud-direct')).toBe('ollama-cloud-direct');
    expect(readChatProviderSelectionMetadata(metadata, config)).toEqual({
      providerName: 'ollama-cloud-direct',
      providerType: 'ollama_cloud',
      providerTier: 'managed_cloud',
      providerLocality: 'external',
      model: 'minimax-m2.1',
    });
  });

  it('falls back to automatic for missing or disabled providers', () => {
    const config = createConfig();
    config.llm.openai.enabled = false;

    expect(normalizeChatProviderSelectionValue(config, 'openai')).toBe('auto');
    expect(readChatProviderSelectionMetadata(
      attachChatProviderSelectionMetadata({}, 'openai'),
      config,
    )).toBeNull();
  });

  it('labels OpenRouter profiles as managed cloud in selector options', () => {
    const config = createConfig();
    config.llm.openrouter = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-plus',
      credentialRef: 'llm.openrouter.primary',
    };
    config.assistant.tools.preferredProviders = {
      ...config.assistant.tools.preferredProviders,
      managedCloud: 'openrouter',
    };

    expect(buildChatProviderSelectorOptions(config)).toContainEqual({
      value: 'openrouter',
      label: 'OpenRouter (managed cloud · qwen/qwen3.6-plus)',
      providerName: 'openrouter',
      providerType: 'openrouter',
      providerTier: 'managed_cloud',
      providerLocality: 'external',
      model: 'qwen/qwen3.6-plus',
    });
  });

  it('labels NVIDIA Cloud profiles as managed cloud in selector options', () => {
    const config = createConfig();
    config.llm.nvidia = {
      provider: 'nvidia',
      model: 'qwen/qwen3-coder-480b-a35b-instruct',
      credentialRef: 'llm.nvidia.primary',
    };
    config.assistant.tools.preferredProviders = {
      ...config.assistant.tools.preferredProviders,
      managedCloud: 'nvidia',
    };

    expect(buildChatProviderSelectorOptions(config)).toContainEqual({
      value: 'nvidia',
      label: 'NVIDIA Cloud (managed cloud · qwen/qwen3-coder-480b-a35b-instruct)',
      providerName: 'nvidia',
      providerType: 'nvidia',
      providerTier: 'managed_cloud',
      providerLocality: 'external',
      model: 'qwen/qwen3-coder-480b-a35b-instruct',
    });
  });
});
