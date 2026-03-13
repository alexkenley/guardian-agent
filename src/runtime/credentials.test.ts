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

  it('resolves local-secret credential refs through the secret resolver', () => {
    const secretResolver = { get: vi.fn((secretId: string) => secretId === 'secret-1' ? 'sk-local-openai' : undefined) };
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.openai.local': { source: 'local', secretId: 'secret-1' },
      },
    }, secretResolver);

    expect(provider.resolve('llm.openai.local')).toBe('sk-local-openai');
    expect(secretResolver.get).toHaveBeenCalledWith('secret-1');
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

  it('returns apiKey undefined instead of throwing when credential is unresolvable', () => {
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.openai.local': { source: 'local', secretId: 'missing-secret' },
      },
    });

    const resolved = resolveLLMCredentialConfig({
      openai: {
        provider: 'openai',
        model: 'gpt-4o',
        credentialRef: 'llm.openai.local',
      },
    }, provider);

    expect(resolved.openai.apiKey).toBeUndefined();
    expect(resolved.openai.provider).toBe('openai');
  });

  it('does not crash when credentialRef entry is missing entirely', () => {
    const provider = new ConfigCredentialProvider({ refs: {} });

    const resolved = resolveLLMCredentialConfig({
      openai: {
        provider: 'openai',
        model: 'gpt-4o',
        credentialRef: 'llm.openai.nonexistent',
      },
    }, provider);

    expect(resolved.openai.apiKey).toBeUndefined();
  });

  it('resolves one provider even when another fails', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic-ok');
    const provider = new ConfigCredentialProvider({
      refs: {
        'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
        'llm.openai.local': { source: 'local', secretId: 'missing-secret' },
      },
    });

    const resolved = resolveLLMCredentialConfig({
      anthropic: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        credentialRef: 'llm.anthropic.primary',
      },
      openai: {
        provider: 'openai',
        model: 'gpt-4o',
        credentialRef: 'llm.openai.local',
      },
    }, provider);

    expect(resolved.anthropic.apiKey).toBe('sk-anthropic-ok');
    expect(resolved.openai.apiKey).toBeUndefined();
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

  it('builds a runtime view for local-secret-backed refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        primary: {
          provider: 'openai',
          model: 'gpt-4o',
          credentialRef: 'llm.openai.local',
        },
      },
      defaultProvider: 'primary',
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openai.local': { source: 'local', secretId: 'secret-openai' },
            'search.brave.local': { source: 'local', secretId: 'secret-brave' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          webSearch: {
            provider: 'brave',
            braveCredentialRef: 'search.brave.local',
          },
        },
      },
    };

    const secretResolver = {
      get: vi.fn((secretId: string) => {
        if (secretId === 'secret-openai') return 'sk-local-openai';
        if (secretId === 'secret-brave') return 'brave-local-key';
        return undefined;
      }),
    };

    const resolved = resolveRuntimeCredentialView(config, secretResolver);
    expect(resolved.resolvedLLM.primary.apiKey).toBe('sk-local-openai');
    expect(resolved.resolvedWebSearch?.braveApiKey).toBe('brave-local-key');
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

  it('resolves GCP profile credentials from credential refs', () => {
    vi.stubEnv('GCP_SERVICE_ACCOUNT_JSON', '{"client_email":"guardian@example.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"}');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.gcp.primary.serviceAccount': { source: 'env', env: 'GCP_SERVICE_ACCOUNT_JSON' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            gcpProfiles: [{
              id: 'gcp-main',
              name: 'GCP Main',
              projectId: 'guardian-prod',
              serviceAccountCredentialRef: 'cloud.gcp.primary.serviceAccount',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.gcpProfiles?.[0]?.serviceAccountJson).toContain('guardian@example.iam.gserviceaccount.com');
  });

  it('resolves Azure profile credentials from credential refs', () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'azure-client-id');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'azure-client-secret');
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.azure.primary.clientId': { source: 'env', env: 'AZURE_CLIENT_ID' },
            'cloud.azure.primary.clientSecret': { source: 'env', env: 'AZURE_CLIENT_SECRET' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            azureProfiles: [{
              id: 'azure-main',
              name: 'Azure Main',
              subscriptionId: 'sub-123',
              tenantId: 'tenant-123',
              clientIdCredentialRef: 'cloud.azure.primary.clientId',
              clientSecretCredentialRef: 'cloud.azure.primary.clientSecret',
            }],
          },
        },
      },
    };

    const resolved = resolveRuntimeCredentialView(config);
    expect(resolved.resolvedCloud?.azureProfiles?.[0]?.clientId).toBe('azure-client-id');
    expect(resolved.resolvedCloud?.azureProfiles?.[0]?.clientSecret).toBe('azure-client-secret');
  });
});
