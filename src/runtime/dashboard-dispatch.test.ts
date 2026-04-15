import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import {
  attachSelectedExecutionProfileMetadata,
  type SelectedExecutionProfile,
} from './execution-profiles.js';
import { readPreRoutedIntentGatewayMetadata, type IntentGatewayRecord } from './intent-gateway.js';
import { createDashboardMessageDispatcher } from './dashboard-dispatch.js';
import type { MessageRouter, RouteDecision } from './message-router.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createGatewayRecord(): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 12,
    decision: {
      route: 'coding_task',
      confidence: 'high',
      operation: 'update',
      summary: 'Update code.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
    },
  };
}

function createSelectedExecutionProfile(
  overrides: Partial<SelectedExecutionProfile> = {},
): SelectedExecutionProfile {
  return {
    id: 'managed_cloud_tool',
    providerName: 'ollama-cloud-coding',
    providerType: 'ollama_cloud',
    providerLocality: 'external',
    providerTier: 'managed_cloud',
    requestedTier: 'external',
    preferredAnswerPath: 'tool_loop',
    expectedContextPressure: 'medium',
    contextBudget: 80_000,
    toolContextMode: 'tight',
    maxAdditionalSections: 1,
    maxRuntimeNotices: 2,
    fallbackProviderOrder: ['ollama-cloud-coding'],
    reason: 'test profile',
    ...overrides,
  };
}

function createDispatchContext() {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    priority: 'high' as const,
    requestType: 'chat',
    runStep: vi.fn(async (_name: string, run: () => Promise<unknown> | unknown) => run()),
    markStep: vi.fn(),
    addNode: vi.fn(),
  };
}

function createOptions(overrides: Partial<Parameters<typeof createDashboardMessageDispatcher>[0]> = {}): Parameters<typeof createDashboardMessageDispatcher>[0] {
  const configRef = { current: createConfig() };
  const dispatchCtx = createDispatchContext();
  return {
    configRef,
    orchestrator: {
      dispatch: vi.fn(async (_input, handler) => handler(dispatchCtx)),
    },
    runtime: {
      dispatchMessage: vi.fn(async () => ({
        content: 'ok',
        metadata: {
          responseSource: {
            locality: 'local',
            providerName: 'ollama',
            model: 'test-model',
            durationMs: 9,
          },
          contextAssembly: {
            summary: 'context summary',
            memoryScope: 'global',
          },
        },
      })),
    },
    analytics: {
      track: vi.fn(),
    },
    router: {
      findAgentByRole: vi.fn((role: string) => {
        if (role === 'local') return { id: 'local-agent' };
        if (role === 'external') return { id: 'fallback-agent' };
        return undefined;
      }),
    } as unknown as MessageRouter,
    identity: {
      resolveCanonicalUserId: vi.fn((_channel: string, userId: string) => `canonical:${userId}`),
    },
    codeSessionStore: {
      resolveForRequest: vi.fn(() => null),
    },
    intentRoutingTrace: {
      record: vi.fn(),
    },
    getCodeSessionSurfaceId: vi.fn(({ surfaceId, userId }: { surfaceId?: string; userId?: string }) => surfaceId ?? userId ?? 'surface'),
    readCodeRequestMetadata: vi.fn(() => undefined),
    createStructuredRequestError: (message: string, statusCode: number, errorCode: string) => {
      const error = new Error(message) as Error & { statusCode: number; errorCode: string };
      error.statusCode = statusCode;
      error.errorCode = errorCode;
      return error;
    },
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('createDashboardMessageDispatcher', () => {
  it('attaches code-session context and pre-routed gateway metadata before runtime dispatch', async () => {
    const gatewayRecord = createGatewayRecord();
    const runtime = {
      dispatchMessage: vi.fn(async () => ({
        content: 'Updated successfully.',
        metadata: {
          responseSource: {
            locality: 'local',
            providerName: 'ollama',
            model: 'test-model',
            durationMs: 12,
          },
        },
      })),
    };
    const options = createOptions({
      runtime,
      codeSessionStore: {
        resolveForRequest: vi.fn(() => ({
          session: {
            id: 'code-session-1',
            resolvedRoot: '/workspace',
            conversationUserId: 'code-session:1',
            conversationChannel: 'code-session',
          },
        })),
      },
    });
    const dispatchDashboardMessage = createDashboardMessageDispatcher(options);

    const result = await dispatchDashboardMessage({
      agentId: 'local-agent',
      msg: {
        content: 'update the selected file',
        userId: 'web-user',
        channel: 'web',
        metadata: { existing: 'value' },
      },
      precomputedIntentGateway: gatewayRecord,
    });

    expect(result.content).toBe('Updated successfully.');
    expect(options.orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'local-agent',
      userId: 'code-session:1',
      channel: 'code-session',
    }), expect.any(Function));
    expect(runtime.dispatchMessage).toHaveBeenCalledOnce();
    const dispatchedMessage = runtime.dispatchMessage.mock.calls[0]?.[1];
    expect(dispatchedMessage.metadata).toMatchObject({
      existing: 'value',
      codeContext: {
        sessionId: 'code-session-1',
        workspaceRoot: '/workspace',
      },
    });
    expect(readPreRoutedIntentGatewayMetadata(dispatchedMessage.metadata)).toMatchObject({
      decision: {
        route: 'coding_task',
        operation: 'update',
      },
    });
    expect(options.analytics.track).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'message_sent' }));
    expect(options.analytics.track).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'message_success' }));
    expect(options.intentRoutingTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'dispatch_response',
      agentId: 'local-agent',
    }));
  });

  it('does not inject shared code-session context into external-path filesystem requests', async () => {
    const runtime = {
      dispatchMessage: vi.fn(async () => ({
        content: 'Created.',
        metadata: {
          responseSource: {
            locality: 'local',
            providerName: 'ollama',
            model: 'test-model',
            durationMs: 11,
          },
        },
      })),
    };
    const options = createOptions({
      runtime,
      codeSessionStore: {
        resolveForRequest: vi.fn(() => ({
          session: {
            id: 'code-session-1',
            resolvedRoot: 'S:\\Development\\GuardianAgent',
            conversationUserId: 'code-session:1',
            conversationChannel: 'code-session',
          },
          attachment: {
            id: 'attachment-1',
            codeSessionId: 'code-session-1',
            userId: 'canonical:web-user',
            channel: 'web',
            surfaceId: 'code-panel',
            mode: 'controller',
            attachedAt: 1,
            lastSeenAt: 1,
            active: true,
          },
        })),
      },
    });
    const dispatchDashboardMessage = createDashboardMessageDispatcher(options);

    await dispatchDashboardMessage({
      agentId: 'local-agent',
      msg: {
        content: 'Create the directory D:\\Temp\\guardian-phase1-test\\phase1-fresh-a.',
        userId: 'web-user',
        channel: 'web',
        surfaceId: 'second-brain',
        metadata: { existing: 'value' },
      },
      precomputedIntentGateway: createGatewayRecord({
        route: 'filesystem_task',
        operation: 'create',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      }),
    });

    expect(options.orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'local-agent',
      userId: 'canonical:web-user',
      channel: 'web',
    }), expect.any(Function));
    const dispatchedMessage = runtime.dispatchMessage.mock.calls[0]?.[1];
    expect(dispatchedMessage.metadata).toMatchObject({
      existing: 'value',
    });
    expect(dispatchedMessage.metadata?.codeContext).toBeUndefined();
  });

  it('falls back to the alternate tier when the primary dispatch fails', async () => {
    const runtime = {
      dispatchMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('primary failed'))
        .mockResolvedValueOnce({
          content: 'Fallback response.',
          metadata: {
            responseSource: {
              locality: 'external',
              providerName: 'anthropic',
              model: 'claude',
              durationMs: 22,
            },
            delegatedHandoff: {
              summary: 'follow-up summary',
              reportingMode: 'inline_response',
            },
          },
        }),
    };
    const options = createOptions({ runtime });
    const dispatchDashboardMessage = createDashboardMessageDispatcher(options);
    const routeDecision: RouteDecision = {
      agentId: 'local-agent',
      confidence: 'high',
      reason: 'tier route',
      tier: 'local',
      fallbackAgentId: 'fallback-agent',
    };

    const result = await dispatchDashboardMessage({
      agentId: 'local-agent',
      msg: {
        content: 'handle this with fallback',
        userId: 'web-user',
        channel: 'web',
      },
      routeDecision,
    });

    expect(runtime.dispatchMessage).toHaveBeenCalledTimes(2);
    expect(runtime.dispatchMessage.mock.calls[0]?.[0]).toBe('local-agent');
    expect(runtime.dispatchMessage.mock.calls[1]?.[0]).toBe('fallback-agent');
    expect(result.metadata?.responseSource).toMatchObject({
      locality: 'external',
      usedFallback: true,
      tier: 'local',
    });
    expect(options.intentRoutingTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'dispatch_response',
      agentId: 'fallback-agent',
      details: expect.objectContaining({
        fallbackUsed: true,
        primaryAgentId: 'local-agent',
      }),
    }));
  });

  it('passes the selected execution profile into orchestrator dispatch metadata', async () => {
    const config = createConfig();
    config.llm['ollama-cloud-coding'] = {
      provider: 'ollama_cloud',
      model: 'qwen3-coder-next',
      credentialRef: 'llm.ollama-cloud-coding',
    };
    const options = createOptions({
      configRef: { current: config },
    });
    const dispatchDashboardMessage = createDashboardMessageDispatcher(options);

    await dispatchDashboardMessage({
      agentId: 'external-agent',
      msg: {
        content: 'inspect the repo',
        userId: 'web-user',
        channel: 'web',
        metadata: attachSelectedExecutionProfileMetadata(undefined, createSelectedExecutionProfile()),
      },
      routeDecision: {
        agentId: 'external-agent',
        confidence: 'high',
        reason: 'tier route',
        tier: 'external',
      },
    });

    expect(options.orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      selectedResponseSource: expect.objectContaining({
        locality: 'external',
        providerName: 'ollama_cloud',
        providerProfileName: 'ollama-cloud-coding',
        providerTier: 'managed_cloud',
        model: 'qwen3-coder-next',
      }),
    }), expect.any(Function));
  });

  it('fills response-source details from the selected execution profile when the runtime only returns locality', async () => {
    const config = createConfig();
    config.llm['ollama-cloud-coding'] = {
      provider: 'ollama_cloud',
      model: 'qwen3-coder-next',
      credentialRef: 'llm.ollama-cloud-coding',
    };
    const options = createOptions({
      configRef: { current: config },
      runtime: {
        dispatchMessage: vi.fn(async () => ({
          content: 'Cloud reply.',
          metadata: {
            responseSource: {
              locality: 'external',
            },
          },
        })),
      },
    });
    const dispatchDashboardMessage = createDashboardMessageDispatcher(options);

    const result = await dispatchDashboardMessage({
      agentId: 'external-agent',
      msg: {
        content: 'check the managed cloud path',
        userId: 'web-user',
        channel: 'web',
        metadata: attachSelectedExecutionProfileMetadata(undefined, createSelectedExecutionProfile()),
      },
      routeDecision: {
        agentId: 'external-agent',
        confidence: 'high',
        reason: 'tier route',
        tier: 'external',
      },
    });

    expect(result.metadata?.responseSource).toMatchObject({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-coding',
      providerTier: 'managed_cloud',
      model: 'qwen3-coder-next',
      tier: 'external',
    });
  });
});
