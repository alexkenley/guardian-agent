import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GuardianAgentConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import {
  ConfigCredentialProvider,
  resolveLLMCredentialConfig,
  resolveRuntimeCredentialView,
  resolveWebSearchCredentialConfig,
} from './credentials.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ConfigCredentialProvider', () => {
  it('resolves env-backed credential refs', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.openai.primary': { source: 'env', env: 'OPENAI_API_KEY' },
      },
    });

    expect(provider.resolve('llm.openai.primary')).toBe('sk-test-openai');
  });

  it('throws when a referenced env credential is unavailable', () => {
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.openai.primary': { source: 'env', env: 'OPENAI_API_KEY' },
      },
    });

    expect(() => provider.require('llm.openai.primary', 'llm.openai')).toThrow(
      "Credential reference 'llm.openai.primary' for llm.openai did not resolve to a non-empty value. Expected environment variable 'OPENAI_API_KEY'.",
    );
  });
});

describe('resolveLLMCredentialConfig', () => {
  it('prefers credentialRef over inline apiKey for external providers', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-ref-openai');
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.openai.primary': { source: 'env', env: 'OPENAI_API_KEY' },
      },
    });

    const resolved = resolveLLMCredentialConfig({
      openai: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-inline-openai',
        credentialRef: 'llm.openai.primary',
      },
    }, provider);

    expect(resolved.openai.apiKey).toBe('sk-ref-openai');
  });
});

describe('resolveWebSearchCredentialConfig', () => {
  it('resolves search provider keys from credential refs', () => {
    vi.stubEnv('BRAVE_API_KEY', 'brave-key');
    const provider = new ConfigCredentialProvider({
      refs: {
        'search.brave.primary': { source: 'env', env: 'BRAVE_API_KEY' },
      },
    });

    const resolved = resolveWebSearchCredentialConfig({
      provider: 'brave',
      braveCredentialRef: 'search.brave.primary',
    }, provider);

    expect(resolved?.braveApiKey).toBe('brave-key');
  });
});

describe('resolveRuntimeCredentialView', () => {
  it('builds a resolved runtime view for llm and web search credentials', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-runtime-openai');
    vi.stubEnv('BRAVE_API_KEY', 'brave-runtime-key');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        primary: {
          provider: 'openai',
          model: 'gpt-4o',
          credentialRef: 'llm.openai.primary',
        },
      },
      defaultProvider: 'primary',
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openai.primary': { source: 'env', env: 'OPENAI_API_KEY' },
            'search.brave.primary': { source: 'env', env: 'BRAVE_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          webSearch: {
            provider: 'brave',
            braveCredentialRef: 'search.brave.primary',
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedLLM.primary.apiKey).toBe('sk-runtime-openai');
    expect(resolved.resolvedWebSearch?.braveApiKey).toBe('brave-runtime-key');
  });
});
