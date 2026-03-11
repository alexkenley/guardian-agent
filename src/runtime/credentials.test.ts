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

  it('resolves cloud profile API tokens from credential refs', () => {
    vi.stubEnv('CPANEL_TOKEN', 'cpanel-runtime-token');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.cpanel.primary': { source: 'env', env: 'CPANEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cpanelProfiles: [{
              id: 'primary',
              name: 'Primary cPanel',
              type: 'cpanel',
              host: 'server.example.com',
              username: 'alice',
              credentialRef: 'cloud.cpanel.primary',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.cpanelProfiles[0]?.apiToken).toBe('cpanel-runtime-token');
  });

  it('resolves Vercel profile API tokens from credential refs', () => {
    vi.stubEnv('VERCEL_TOKEN', 'vercel-runtime-token');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.vercel.primary': { source: 'env', env: 'VERCEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            vercelProfiles: [{
              id: 'vercel-main',
              name: 'Vercel Main',
              credentialRef: 'cloud.vercel.primary',
              teamId: 'team_123',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.vercelProfiles?.[0]?.apiToken).toBe('vercel-runtime-token');
  });

  it('resolves Cloudflare profile API tokens from credential refs', () => {
    vi.stubEnv('CLOUDFLARE_TOKEN', 'cloudflare-runtime-token');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.cloudflare.primary': { source: 'env', env: 'CLOUDFLARE_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cloudflareProfiles: [{
              id: 'cf-main',
              name: 'Cloudflare Main',
              credentialRef: 'cloud.cloudflare.primary',
              accountId: 'acc_123',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.cloudflareProfiles?.[0]?.apiToken).toBe('cloudflare-runtime-token');
  });

  it('resolves AWS profile credentials from credential refs', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATESTRUNTIMEKEY123');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'runtime-secret-key-value');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.aws.primary.accessKeyId': { source: 'env', env: 'AWS_ACCESS_KEY_ID' },
            'cloud.aws.primary.secretAccessKey': { source: 'env', env: 'AWS_SECRET_ACCESS_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            awsProfiles: [{
              id: 'aws-main',
              name: 'AWS Main',
              region: 'us-east-1',
              accessKeyIdCredentialRef: 'cloud.aws.primary.accessKeyId',
              secretAccessKeyCredentialRef: 'cloud.aws.primary.secretAccessKey',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.awsProfiles?.[0]?.accessKeyId).toBe('AKIATESTRUNTIMEKEY123');
    expect(resolved.resolvedCloud?.awsProfiles?.[0]?.secretAccessKey).toBe('runtime-secret-key-value');
  });
});
