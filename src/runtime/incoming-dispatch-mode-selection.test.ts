import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { createIncomingDispatchPreparer } from './incoming-dispatch.js';
import type { IntentGatewayRecord } from './intent-gateway.js';
import type { MessageRouter } from './message-router.js';

function createConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud'] = {
    provider: 'ollama_cloud',
    model: 'gpt-oss:120b',
    credentialRef: 'llm.ollama_cloud.primary',
  };
  config.llm.openai = {
    provider: 'openai',
    model: 'gpt-5.1',
    credentialRef: 'llm.openai.primary',
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud',
    frontier: 'openai',
  };
  return config;
}

function createGatewayRecord(): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 12,
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'read',
      summary: 'General question.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'direct_assistant',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      entities: {},
    },
  };
}

function createBaseArgs(config: GuardianAgentConfig) {
  const runtimeGetProvider = vi.fn((providerName: string) => ({
    name: providerName,
    chat: vi.fn(async () => ({ content: 'ok' })),
  }));
  return {
    args: {
      defaultAgentId: 'default-agent',
      configRef: { current: config },
      router: {
        findAgentByRole: vi.fn((role: string) => {
          if (role === 'local') return { id: 'local-agent' };
          if (role === 'external') return { id: 'external-agent' };
          return undefined;
        }),
        route: vi.fn(() => ({ agentId: 'fallback-agent', confidence: 'low', reason: 'fallback' })),
        routeWithTier: vi.fn(() => ({ agentId: 'external-agent', confidence: 'medium', reason: 'tier route', tier: 'external' })),
        routeWithTierFromIntent: vi.fn(() => ({ agentId: 'external-agent', confidence: 'high', reason: 'intent tier route', tier: 'external' })),
      } as unknown as MessageRouter,
      routingIntentGateway: {
        classify: vi.fn(async () => createGatewayRecord()),
      },
      runtime: {
        getProvider: runtimeGetProvider,
      },
      identity: {
        resolveCanonicalUserId: (channel: string, channelUserId: string) => `${channel}:${channelUserId}`,
      },
      conversations: {
        getHistoryForContext: vi.fn(() => []),
      },
      pendingActionStore: {
        resolveActiveForSurface: vi.fn(() => null),
      },
      continuityThreadStore: {
        get: vi.fn(() => null),
      },
      codeSessionStore: {
        resolveForRequest: vi.fn(() => null),
      },
      intentRoutingTrace: {
        record: vi.fn(),
      },
      enabledManagedProviders: new Set(['gws']),
      availableCodingBackends: ['codex'],
      resolveSharedStateAgentId: vi.fn(() => undefined),
      findProviderByLocality: vi.fn((current: GuardianAgentConfig, locality: 'local' | 'external') => {
        if (locality === 'local') return 'ollama';
        return current.assistant.tools.preferredProviders?.managedCloud ?? 'ollama-cloud';
      }),
      getCodeSessionSurfaceId: ({ surfaceId, userId }: { surfaceId?: string; userId?: string }) => (
        surfaceId?.trim() || userId?.trim() || 'default-surface'
      ),
      readMessageSurfaceId: vi.fn(() => undefined),
      readCodeRequestMetadata: vi.fn(() => undefined),
      normalizeTierModeForRouter: vi.fn((_router, currentConfig: GuardianAgentConfig) => currentConfig.routing?.tierMode ?? 'auto'),
      summarizePendingActionForGateway: vi.fn(() => null),
      summarizeContinuityThreadForGateway: vi.fn(() => null),
      now: () => 1_700_000_000_000,
    },
    runtimeGetProvider,
  };
}

describe('createIncomingDispatchPreparer classifier provider selection', () => {
  it('does not touch the local provider when managed-cloud-only mode is active', async () => {
    const config = createConfig();
    config.routing = {
      ...(config.routing ?? {}),
      tierMode: 'managed-cloud-only',
    };
    const { args, runtimeGetProvider } = createBaseArgs(config);
    const prepareIncomingDispatch = createIncomingDispatchPreparer(args);

    await prepareIncomingDispatch(undefined, {
      content: 'Give me a concise plan for organizing my week',
      userId: 'alex',
      channel: 'web',
    });

    expect(runtimeGetProvider).toHaveBeenCalledWith('ollama-cloud');
    expect(runtimeGetProvider).not.toHaveBeenCalledWith('ollama');
  });
});
