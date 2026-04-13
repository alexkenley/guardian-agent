import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type CredentialRefConfig, type GuardianAgentConfig } from '../../config/types.js';
import { createDirectConfigUpdateHandler } from './direct-config-update.js';

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
  config.defaultProvider = 'ollama-cloud-general';
  config.fallbacks = ['ollama', 'anthropic', 'ollama-cloud-general'];
  config.assistant.credentials.refs = {
    ...config.assistant.credentials.refs,
    'llm.ollama-cloud.general': { source: 'env', env: 'OLLAMA_API_KEY' },
    'llm.ollama-cloud.coding': { source: 'env', env: 'OLLAMA_API_KEY' },
    'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
  };
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
  return config;
}

function createHandlerHarness(config: GuardianAgentConfig) {
  const configRef = {
    current: structuredClone(config) as GuardianAgentConfig,
  };
  const rawState = {
    current: structuredClone(config) as Record<string, unknown>,
  };

  const handler = createDirectConfigUpdateHandler({
    configRef,
    jobTracker: {
      run: async (_job, fn) => fn(),
    } as any,
    loadRawConfig: () => structuredClone(rawState.current) as Record<string, unknown>,
    persistAndApplyConfig: (rawConfig) => {
      rawState.current = structuredClone(rawConfig) as Record<string, unknown>;
      configRef.current = structuredClone(rawConfig) as GuardianAgentConfig;
      return { success: true, message: 'Saved' };
    },
    normalizeCredentialRefUpdates: (refs) => refs as Record<string, CredentialRefConfig>,
    storeSecret: () => {},
    deleteUnusedLocalSecrets: () => {},
    mergeCloudConfigForValidation: (current) => current,
    previewSecurityBaselineViolations: () => [],
    buildSecurityBaselineRejection: () => ({ success: false, message: 'Rejected' }),
    trackSystemAnalytics: () => {},
    upsertLocalCredentialRef: (_rawConfig, refName) => refName,
    existingProfilesById: () => new Map(),
    trimOrUndefined: (value) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed || undefined;
    },
    hasOwn: (value, key) => Object.prototype.hasOwnProperty.call(value, key),
    isRecord: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value),
    sanitizeNormalizedUrlRecord: () => undefined,
  });

  return { configRef, rawState, handler };
}

describe('direct config update', () => {
  it('rejects manual default-provider updates because the primary provider is derived', async () => {
    const { configRef, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      defaultProvider: 'anthropic' as never,
    } as never);

    expect(result).toEqual({
      success: false,
      message: 'Primary provider is derived automatically from the routed provider configuration. Update the managed-cloud, local, or frontier defaults instead.',
      statusCode: 400,
    });
    expect(configRef.current.defaultProvider).toBe('ollama-cloud-general');
  });

  it('deletes providers and re-derives the primary provider while clearing invalid routing references', async () => {
    const { configRef, rawState, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      llm: {
        'ollama-cloud-general': { remove: true },
      },
    });

    expect(result).toEqual({ success: true, message: 'Saved' });
    expect(configRef.current.defaultProvider).toBe('ollama-cloud-coding');
    expect(configRef.current.llm['ollama-cloud-general']).toBeUndefined();
    expect(configRef.current.fallbacks).toEqual(['ollama', 'anthropic']);
    expect(configRef.current.assistant.tools.preferredProviders).toEqual({
      local: 'ollama',
      frontier: 'anthropic',
    });
    expect(configRef.current.assistant.tools.modelSelection?.managedCloudRouting).toEqual({
      enabled: true,
      roleBindings: {
        coding: 'ollama-cloud-coding',
      },
    });

    const rawConfig = rawState.current as Record<string, unknown>;
    const rawLlm = rawConfig.llm as Record<string, unknown>;
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const rawTools = rawAssistant.tools as Record<string, unknown>;
    const rawModelSelection = rawTools.modelSelection as Record<string, unknown>;
    const rawManagedCloudRouting = rawModelSelection.managedCloudRouting as Record<string, unknown>;

    expect(rawConfig.defaultProvider).toBe('ollama-cloud-coding');
    expect(rawLlm['ollama-cloud-general']).toBeUndefined();
    expect(rawConfig.fallbacks).toEqual(['ollama', 'anthropic']);
    expect(rawTools.preferredProviders).toEqual({
      local: 'ollama',
      frontier: 'anthropic',
    });
    expect(rawManagedCloudRouting.roleBindings).toEqual({
      coding: 'ollama-cloud-coding',
    });
  });

  it('persists provider enabled toggles and re-derives the primary provider from enabled profiles', async () => {
    const { configRef, rawState, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      llm: {
        'ollama-cloud-general': { enabled: false },
      },
    });

    expect(result).toEqual({ success: true, message: 'Saved' });
    expect(configRef.current.llm['ollama-cloud-general'].enabled).toBe(false);
    expect(configRef.current.defaultProvider).toBe('ollama-cloud-coding');

    const rawConfig = rawState.current as Record<string, unknown>;
    const rawLlm = rawConfig.llm as Record<string, Record<string, unknown>>;
    expect(rawLlm['ollama-cloud-general']?.enabled).toBe(false);
    expect(rawConfig.defaultProvider).toBe('ollama-cloud-coding');
  });

  it('rejects updates that would disable every AI provider', async () => {
    const { configRef, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      llm: {
        ollama: { enabled: false },
        'ollama-cloud-general': { enabled: false },
        'ollama-cloud-coding': { enabled: false },
        anthropic: { enabled: false },
      },
    });

    expect(result).toEqual({
      success: false,
      message: 'At least one AI provider must stay enabled.',
      statusCode: 400,
    });
    expect(configRef.current.defaultProvider).toBe('ollama-cloud-general');
  });

  it('persists second-brain preference updates into live and raw config state', async () => {
    const { configRef, rawState, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      assistant: {
        secondBrain: {
          onboarding: {
            completed: true,
            dismissed: false,
          },
          profile: {
            timezone: 'Australia/Brisbane',
            workdayStart: '09:00',
            workdayEnd: '18:00',
            proactivityLevel: 'proactive',
          },
          delivery: {
            defaultChannels: ['telegram', 'web'],
          },
          knowledge: {
            prioritizeConnectedSources: false,
            defaultRetrievalMode: 'library_first',
            rerankerEnabled: false,
          },
        },
      },
    });

    expect(result).toEqual({ success: true, message: 'Saved' });
    expect(configRef.current.assistant.secondBrain.onboarding).toEqual({
      completed: true,
      dismissed: false,
    });
    expect(configRef.current.assistant.secondBrain.profile).toEqual({
      timezone: 'Australia/Brisbane',
      workdayStart: '09:00',
      workdayEnd: '18:00',
      proactivityLevel: 'proactive',
    });
    expect(configRef.current.assistant.secondBrain.delivery.defaultChannels).toEqual(['telegram', 'web']);
    expect(configRef.current.assistant.secondBrain.knowledge).toEqual({
      prioritizeConnectedSources: false,
      defaultRetrievalMode: 'library_first',
      rerankerEnabled: false,
    });

    const rawConfig = rawState.current as Record<string, unknown>;
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    expect(rawAssistant.secondBrain).toEqual({
      enabled: true,
      onboarding: {
        completed: true,
        dismissed: false,
      },
      profile: {
        workdayStart: '09:00',
        workdayEnd: '18:00',
        proactivityLevel: 'proactive',
        timezone: 'Australia/Brisbane',
      },
      delivery: {
        defaultChannels: ['telegram', 'web'],
      },
      knowledge: {
        prioritizeConnectedSources: false,
        defaultRetrievalMode: 'library_first',
        rerankerEnabled: false,
      },
    });
  });

  it('persists response-style settings into live and raw config state', async () => {
    const { configRef, rawState, handler } = createHandlerHarness(createConfig());

    const result = await handler({
      assistant: {
        responseStyle: {
          enabled: false,
          level: 'strong',
        },
      },
    });

    expect(result).toEqual({ success: true, message: 'Saved' });
    expect(configRef.current.assistant.responseStyle).toEqual({
      enabled: false,
      level: 'strong',
    });

    const rawConfig = rawState.current as Record<string, unknown>;
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    expect(rawAssistant.responseStyle).toEqual({
      enabled: false,
      level: 'strong',
    });
  });

  it('persists Vercel sandbox capability updates on the existing Vercel cloud profile model', async () => {
    const config = createConfig();
    config.assistant.tools.cloud = {
      enabled: true,
      cpanelProfiles: [],
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        credentialRef: 'cloud.vercel.main',
        teamId: 'team_123',
      }],
      cloudflareProfiles: [],
      awsProfiles: [],
      gcpProfiles: [],
      azureProfiles: [],
    };

    const { configRef, rawState, handler } = createHandlerHarness(config);
    const result = await handler({
      assistant: {
        tools: {
          cloud: {
            vercelProfiles: [{
              id: 'vercel-main',
              name: 'Main Vercel',
              credentialRef: 'cloud.vercel.main',
              teamId: 'team_123',
              sandbox: {
                enabled: true,
                projectId: 'prj_123',
                defaultTimeoutMs: 300_000,
                defaultVcpus: 2,
                allowNetwork: true,
                allowedDomains: ['Registry.Npmjs.org', 'api.anthropic.com'],
              },
            }],
          },
        },
      },
    });

    expect(result).toEqual({ success: true, message: 'Saved' });
    expect(configRef.current.assistant.tools.cloud?.vercelProfiles?.[0]?.sandbox).toEqual({
      enabled: true,
      projectId: 'prj_123',
      defaultTimeoutMs: 300_000,
      defaultVcpus: 2,
      allowNetwork: true,
      allowedDomains: ['registry.npmjs.org', 'api.anthropic.com'],
    });

    const rawConfig = rawState.current as Record<string, unknown>;
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const rawTools = rawAssistant.tools as Record<string, unknown>;
    const rawCloud = rawTools.cloud as Record<string, unknown>;
    const rawVercel = rawCloud.vercelProfiles as Array<Record<string, unknown>>;
    expect(rawVercel[0]?.sandbox).toEqual({
      enabled: true,
      projectId: 'prj_123',
      defaultTimeoutMs: 300_000,
      defaultVcpus: 2,
      allowNetwork: true,
      allowedDomains: ['registry.npmjs.org', 'api.anthropic.com'],
    });
  });
});
