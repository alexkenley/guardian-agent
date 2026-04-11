import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { readSelectedExecutionProfileMetadata } from './execution-profiles.js';
import { attachChatProviderSelectionMetadata } from './chat-provider-selection.js';
import { readPreRoutedIntentGatewayMetadata, type IntentGatewayRecord } from './intent-gateway.js';
import { createIncomingDispatchPreparer } from './incoming-dispatch.js';
import type { MessageRouter } from './message-router.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createGatewayRecord(partial: Partial<IntentGatewayRecord['decision']> = {}): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 12,
    decision: {
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect coding task.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
      ...partial,
    },
  };
}

function createBaseArgs(overrides: Partial<Parameters<typeof createIncomingDispatchPreparer>[0]> = {}): Parameters<typeof createIncomingDispatchPreparer>[0] {
  const configRef = { current: createConfig() };
  return {
    defaultAgentId: 'default-agent',
    configRef,
    router: {
      findAgentByRole: vi.fn((role: string) => {
        if (role === 'local') return { id: 'local-agent' };
        if (role === 'external') return { id: 'external-agent' };
        return undefined;
      }),
      route: vi.fn(() => ({ agentId: 'fallback-agent', confidence: 'low', reason: 'fallback' })),
      routeWithTier: vi.fn(() => ({ agentId: 'local-agent', confidence: 'medium', reason: 'tier route', tier: 'local' })),
      routeWithTierFromIntent: vi.fn(() => ({ agentId: 'local-agent', confidence: 'high', reason: 'intent tier route', tier: 'local' })),
    } as unknown as MessageRouter,
    routingIntentGateway: {
      classify: vi.fn(async () => createGatewayRecord()),
    },
    runtime: {
      getProvider: vi.fn(() => ({
        chat: vi.fn(async () => ({ content: 'ok' })),
      })),
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
    availableCodingBackends: ['codex', 'claude-code'],
    resolveSharedStateAgentId: vi.fn(() => undefined),
    findProviderByLocality: vi.fn((config: GuardianAgentConfig, locality: 'local' | 'external') => {
      if (locality === 'local') return config.defaultProvider;
      return 'external-provider';
    }),
    getCodeSessionSurfaceId: ({ surfaceId, userId }: { surfaceId?: string; userId?: string }) => (
      surfaceId?.trim() || userId?.trim() || 'default-surface'
    ),
    readMessageSurfaceId: vi.fn(() => undefined),
    readCodeRequestMetadata: vi.fn(() => undefined),
    normalizeTierModeForRouter: vi.fn((_router, _config, mode) => mode ?? 'auto'),
    summarizePendingActionForGateway: vi.fn(() => null),
    summarizeContinuityThreadForGateway: vi.fn(() => null),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('createIncomingDispatchPreparer', () => {
  it('routes explicit coding sessions through the gateway instead of honoring stored agent pins', async () => {
    const readCodeRequestMetadata = vi.fn(() => ({ sessionId: 'session-1' }));
    const codeSessionStore = {
      resolveForRequest: vi.fn(() => ({
        session: { agentId: 'pinned-worker' },
      })),
    };
    const routingIntentGateway = {
      classify: vi.fn(async () => createGatewayRecord()),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      readCodeRequestMetadata,
      codeSessionStore,
      routingIntentGateway,
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'continue the coding task',
      userId: 'alex',
      channel: 'web',
      metadata: { codeContext: { sessionId: 'session-1' } },
    });

    expect(result.decision).toEqual({
      agentId: 'local-agent',
      confidence: 'high',
      reason: 'explicit attached coding session with gateway-first auto routing',
      tier: 'local',
    });
    expect(result.gateway).toEqual(createGatewayRecord());
    expect(routingIntentGateway.classify).toHaveBeenCalledOnce();
  });

  it('still attaches a forced provider profile when a coding session is active', async () => {
    const config = createConfig();
    config.llm.anthropic = {
      provider: 'anthropic',
      model: 'claude-opus-4.6',
      apiKey: 'test-key',
    };
    const readCodeRequestMetadata = vi.fn(() => ({ sessionId: 'session-1' }));
    const codeSessionStore = {
      resolveForRequest: vi.fn(() => ({
        session: { agentId: 'pinned-worker' },
      })),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      configRef: { current: config },
      readCodeRequestMetadata,
      codeSessionStore,
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'continue the coding task',
      userId: 'alex',
      channel: 'web',
      metadata: attachChatProviderSelectionMetadata({ codeContext: { sessionId: 'session-1' } }, 'anthropic'),
    });

    expect(result.decision).toEqual({
      agentId: 'local-agent',
      confidence: 'high',
      reason: 'explicit attached coding session with gateway-first auto routing',
      tier: 'local',
    });
    expect(readSelectedExecutionProfileMetadata(result.routedMessage.metadata)).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
    });
  });

  it('ignores stored routing aliases on attached code sessions and falls back to routing', async () => {
    const routingIntentGateway = {
      classify: vi.fn(async () => createGatewayRecord()),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      codeSessionStore: {
        resolveForRequest: vi.fn(() => ({
          session: { agentId: 'external' },
        })),
      },
      routingIntentGateway,
      resolveConfiguredAgentId: vi.fn((agentId?: string) => agentId === 'external' ? undefined : agentId),
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'hello',
      userId: 'alex',
      channel: 'web',
    });

    expect(routingIntentGateway.classify).toHaveBeenCalledOnce();
    expect(result.decision).toEqual({
      agentId: 'local-agent',
      confidence: 'high',
      reason: 'attached coding session with gateway-first auto routing',
      tier: 'local',
    });
  });

  it('routes explicit code workspace context through the gateway and execution-profile selector', async () => {
    const config = createConfig();
    config.llm['ollama-cloud'] = {
      provider: 'ollama_cloud',
      model: 'qwen3-coder-next',
      credentialRef: 'llm.ollama_cloud.primary',
    };
    config.llm.anthropic = {
      provider: 'anthropic',
      model: 'claude-opus-4.6',
      apiKey: 'test-key',
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'ollama-cloud',
      frontier: 'anthropic',
    };
    const routingIntentGateway = {
      classify: vi.fn(async () => createGatewayRecord({
        route: 'coding_task',
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      })),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      configRef: { current: config },
      routingIntentGateway,
      readCodeRequestMetadata: vi.fn(() => ({ workspaceRoot: '/tmp/repo' })),
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
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'review the repo and suggest next steps',
      userId: 'alex',
      channel: 'web',
      metadata: { codeContext: { workspaceRoot: '/tmp/repo' } },
    });

    expect(routingIntentGateway.classify).toHaveBeenCalledOnce();
    expect(result.decision).toEqual({
      agentId: 'external-agent',
      confidence: 'high',
      reason: 'code workspace context with gateway-first auto routing',
      tier: 'external',
    });
    expect(readSelectedExecutionProfileMetadata(result.routedMessage.metadata)).toMatchObject({
      providerTier: 'frontier',
      id: 'frontier_deep',
    });
  });

  it('attaches pre-routed gateway metadata and records routing trace entries when classification is available', async () => {
    const gatewayRecord = createGatewayRecord({
      route: 'browser_task',
      operation: 'inspect',
      entities: { codingBackend: 'codex' },
    });
    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      routingIntentGateway: {
        classify: vi.fn(async () => gatewayRecord),
      },
      intentRoutingTrace,
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'check the browser session',
      userId: 'alex',
      channel: 'web',
      metadata: { existing: 'value' },
    });

    expect(result.gateway).toEqual(gatewayRecord);
    expect(result.decision.agentId).toBe('local-agent');
    expect(readPreRoutedIntentGatewayMetadata(result.routedMessage.metadata)).toMatchObject({
      decision: {
        route: 'browser_task',
        operation: 'inspect',
      },
    });
    expect(readSelectedExecutionProfileMetadata(result.routedMessage.metadata)).toMatchObject({
      providerName: 'ollama',
      providerTier: 'local',
    });
    expect(intentRoutingTrace.record).toHaveBeenCalledTimes(6);
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ stage: 'incoming_dispatch' }));
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'gateway_classified' }));
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(3, expect.objectContaining({ stage: 'tier_routing_decided' }));
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(4, expect.objectContaining({ stage: 'profile_selection_decided' }));
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(5, expect.objectContaining({ stage: 'context_budget_decided' }));
    expect(intentRoutingTrace.record).toHaveBeenNthCalledWith(6, expect.objectContaining({ stage: 'pre_routed_metadata_attached' }));
  });

  it('does not treat an unresolved reserved channel default alias as a concrete agent id', async () => {
    const routingIntentGateway = {
      classify: vi.fn(async () => createGatewayRecord()),
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      routingIntentGateway,
      resolveConfiguredAgentId: vi.fn((agentId?: string) => agentId === 'external' ? undefined : agentId),
    }));

    const result = await prepareIncomingDispatch('external', {
      content: 'hello',
      userId: 'alex',
      channel: 'web',
    });

    expect(routingIntentGateway.classify).toHaveBeenCalledOnce();
    expect(result.decision.agentId).toBe('local-agent');
    expect(result.decision.reason).toBe('intent tier route');
  });

  it('strips the web context prefix before classifying and tier-routing the request', async () => {
    const gatewayRecord = createGatewayRecord({
      route: 'personal_assistant_task',
      operation: 'create',
      entities: { personalItemType: 'calendar', calendarTarget: 'local' },
    });
    const routingIntentGateway = {
      classify: vi.fn(async (input: { content: string }) => {
        expect(input.content).toBe('Create a calendar entry for tomorrow at 12 pm called Dentist.');
        return gatewayRecord;
      }),
    };
    const router = {
      findAgentByRole: vi.fn((role: string) => {
        if (role === 'local') return { id: 'local-agent' };
        if (role === 'external') return { id: 'external-agent' };
        return undefined;
      }),
      route: vi.fn(() => ({ agentId: 'fallback-agent', confidence: 'low', reason: 'fallback' })),
      routeWithTier: vi.fn(() => ({ agentId: 'local-agent', confidence: 'medium', reason: 'tier route', tier: 'local' })),
      routeWithTierFromIntent: vi.fn((_decision, content: string) => {
        expect(content).toBe('Create a calendar entry for tomorrow at 12 pm called Dentist.');
        return { agentId: 'local-agent', confidence: 'high', reason: 'intent tier route', tier: 'local' };
      }),
    } as unknown as MessageRouter;
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      router,
      routingIntentGateway,
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: '[Context: User is currently viewing the second-brain panel] Create a calendar entry for tomorrow at 12 pm called Dentist.',
      userId: 'alex',
      channel: 'web',
    });

    expect(result.gateway).toEqual(gatewayRecord);
    expect(result.decision.agentId).toBe('local-agent');
    expect(routingIntentGateway.classify).toHaveBeenCalledTimes(1);
  });

  it('attaches a frontier execution profile for heavier repo-grounded external work', async () => {
    const config = createConfig();
    const intentRoutingTrace = {
      record: vi.fn(),
    };
    config.llm['ollama-cloud'] = {
      provider: 'ollama_cloud',
      model: 'qwen3-coder-next',
      credentialRef: 'llm.ollama_cloud.primary',
    };
    config.llm.anthropic = {
      provider: 'anthropic',
      model: 'claude-opus-4.6',
      apiKey: 'test-key',
    };
    config.assistant.tools.preferredProviders = {
      local: 'ollama',
      managedCloud: 'ollama-cloud',
      frontier: 'anthropic',
    };
    const prepareIncomingDispatch = createIncomingDispatchPreparer(createBaseArgs({
      configRef: { current: config },
      routingIntentGateway: {
        classify: vi.fn(async () => createGatewayRecord({
          route: 'coding_task',
          operation: 'inspect',
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'chat_synthesis',
        })),
      },
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
      intentRoutingTrace,
    }));

    const result = await prepareIncomingDispatch(undefined, {
      content: 'Inspect src/runtime/intent-gateway.ts and review the routing uplift for regressions.',
      userId: 'alex',
      channel: 'web',
    });

    expect(readSelectedExecutionProfileMetadata(result.routedMessage.metadata)).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
      id: 'frontier_deep',
      preferredAnswerPath: 'chat_synthesis',
    });
    expect(intentRoutingTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'profile_selection_decided',
      details: expect.objectContaining({
        providerType: 'anthropic',
        providerModel: 'claude-opus-4.6',
        providerTier: 'frontier',
      }),
    }));
    expect(intentRoutingTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'pre_routed_metadata_attached',
      details: expect.objectContaining({
        selectedProviderType: 'anthropic',
        selectedProviderModel: 'claude-opus-4.6',
        selectedProviderTier: 'frontier',
      }),
    }));
  });
});
