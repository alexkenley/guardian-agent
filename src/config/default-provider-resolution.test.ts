import { describe, expect, it } from 'vitest';

import { resolveDerivedDefaultProvider } from './default-provider-resolution.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from './types.js';

function createConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud-general'] = {
    provider: 'ollama_cloud',
    model: 'gpt-oss:120b',
    credentialRef: 'llm.ollama-cloud.general',
  };
  config.llm['ollama-cloud-coding'] = {
    provider: 'ollama_cloud',
    model: 'qwen3-coder:480b',
    credentialRef: 'llm.ollama-cloud.coding',
  };
  config.llm.anthropic = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    credentialRef: 'llm.anthropic.primary',
  };
  return config;
}

describe('resolveDerivedDefaultProvider', () => {
  it('prefers the managed-cloud general binding when it exists', () => {
    const config = createConfig();
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'ollama-cloud-coding',
      frontier: 'anthropic',
    };
    config.assistant.tools.modelSelection = {
      ...config.assistant.tools.modelSelection,
      managedCloudRouting: {
        enabled: true,
        roleBindings: {
          general: 'ollama-cloud-general',
        },
      },
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('ollama-cloud-general');
  });

  it('prefers the managed-cloud routed default when no general binding exists', () => {
    const config = createConfig();
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'ollama-cloud-coding',
      frontier: 'anthropic',
    };
    config.assistant.tools.modelSelection = {
      ...config.assistant.tools.modelSelection,
      managedCloudRouting: {
        enabled: true,
        roleBindings: {},
      },
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('ollama-cloud-coding');
  });

  it('falls back to local and then frontier when managed cloud is unavailable', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.llm = {
      ollama: config.llm.ollama,
      anthropic: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        credentialRef: 'llm.anthropic.primary',
      },
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      frontier: 'anthropic',
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('ollama');

    delete config.llm.ollama;
    expect(resolveDerivedDefaultProvider(config)).toBe('anthropic');
  });

  it('ignores disabled providers when deriving the primary provider', () => {
    const config = createConfig();
    config.llm['ollama-cloud-general'].enabled = false;
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'ollama-cloud-general',
      frontier: 'anthropic',
    };
    config.assistant.tools.modelSelection = {
      ...config.assistant.tools.modelSelection,
      managedCloudRouting: {
        enabled: true,
        roleBindings: {
          general: 'ollama-cloud-general',
          coding: 'ollama-cloud-coding',
        },
      },
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('ollama-cloud-coding');
  });

  it('treats OpenRouter profiles as managed-cloud candidates', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.llm = {
      ollama: config.llm.ollama,
      openrouterGeneral: {
        provider: 'openrouter',
        model: 'qwen/qwen3.6-plus',
        credentialRef: 'llm.openrouter.primary',
      },
      anthropic: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        credentialRef: 'llm.anthropic.primary',
      },
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'openrouterGeneral',
      frontier: 'anthropic',
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('openrouterGeneral');
  });

  it('treats NVIDIA Cloud profiles as managed-cloud candidates', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.llm = {
      ollama: config.llm.ollama,
      nvidiaGeneral: {
        provider: 'nvidia',
        model: 'qwen/qwen3-5-122b-a10b',
        credentialRef: 'llm.nvidia.primary',
      },
      anthropic: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        credentialRef: 'llm.anthropic.primary',
      },
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'nvidia',
      frontier: 'anthropic',
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('nvidiaGeneral');
  });

  it('uses the selected managed-cloud provider family general binding', () => {
    const config = createConfig();
    config.llm.openrouterGeneral = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-plus',
      credentialRef: 'llm.openrouter.primary',
    };
    config.llm.openrouterCoding = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-coder',
      credentialRef: 'llm.openrouter.primary',
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'openrouter',
      frontier: 'anthropic',
    };
    config.assistant.tools.modelSelection = {
      ...config.assistant.tools.modelSelection,
      managedCloudRouting: {
        enabled: true,
        providerRoleBindings: {
          ollama_cloud: {
            general: 'ollama-cloud-general',
          },
          openrouter: {
            general: 'openrouterGeneral',
            coding: 'openrouterCoding',
          },
        },
        roleBindings: {
          general: 'ollama-cloud-general',
        },
      },
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('openrouterGeneral');
  });

  it('falls back to the first enabled profile inside the selected managed-cloud family', () => {
    const config = createConfig();
    config.llm.openrouterGeneral = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-plus',
      credentialRef: 'llm.openrouter.primary',
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'openrouter',
      frontier: 'anthropic',
    };
    config.assistant.tools.modelSelection = {
      ...config.assistant.tools.modelSelection,
      managedCloudRouting: {
        enabled: true,
        providerRoleBindings: {
          openrouter: {},
        },
        roleBindings: {
          general: 'ollama-cloud-general',
        },
      },
    };

    expect(resolveDerivedDefaultProvider(config)).toBe('openrouterGeneral');
  });
});
