import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { buildChatDirectRouteHandlers, type ChatDirectRouteHandlerCallbacks } from './direct-route-handlers.js';
import type { DirectRuntimeDepsInput } from './direct-runtime-deps.js';

const originalMessage: UserMessage = {
  id: 'original-message',
  userId: 'owner',
  channel: 'web',
  content: 'original request',
  timestamp: 1_700_000_000_000,
};

const routedMessage: UserMessage = {
  ...originalMessage,
  id: 'routed-message',
  content: 'show configured providers',
};

const ctx = {
  checkAction: vi.fn(),
} as unknown as AgentContext;

function runtimeDeps(tools: DirectRuntimeDepsInput['tools']): DirectRuntimeDepsInput {
  return {
    agentId: 'chat',
    tools,
    conversationService: { getHistoryForContext: vi.fn(() => []) },
    setApprovalFollowUp: vi.fn(),
    getPendingApprovals: vi.fn(() => null),
    formatPendingApprovalPrompt: vi.fn(() => 'approve'),
    parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
    setClarificationPendingAction: vi.fn(() => ({ action: null })),
    setPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    buildPendingApprovalBlockedResponse: vi.fn(() => ({ content: 'blocked' })),
  };
}

function callbacks(): ChatDirectRouteHandlerCallbacks {
  return {
    personalAssistant: vi.fn(async () => 'personal'),
    codingSessionControl: vi.fn(async () => 'session-control'),
    codingBackend: vi.fn(async () => 'coding'),
    filesystem: vi.fn(async () => 'filesystem'),
    memoryWrite: vi.fn(async () => 'memory-write'),
    memoryRead: vi.fn(async () => 'memory-read'),
  };
}

function providerDecision(): IntentGatewayDecision {
  return {
    route: 'provider_task',
    confidence: 'high',
    operation: 'read',
    summary: 'Reads provider configuration.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'provider_crud',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    entities: {},
  } as IntentGatewayDecision;
}

describe('chat direct route handlers', () => {
  it('keeps ChatAgent-owned routes as explicit callbacks', async () => {
    const ownedCallbacks = callbacks();
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools: { isEnabled: vi.fn(() => false) } as never,
      runtimeDeps: runtimeDeps({ isEnabled: vi.fn(() => false) } as never),
      message: originalMessage,
      routedMessage,
      ctx,
      userKey: 'owner:web',
      stateAgentId: 'chat',
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      callbacks: ownedCallbacks,
    });

    await expect(handlers.personal_assistant?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    })).resolves.toBe('personal');
    await expect(handlers.coding_backend?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    })).resolves.toBe('coding');
    await expect(handlers.filesystem?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    })).resolves.toBe('filesystem');
    await expect(handlers.memory_write?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    })).resolves.toBe('memory-write');

    expect(ownedCallbacks.personalAssistant).toHaveBeenCalledOnce();
    expect(ownedCallbacks.codingBackend).toHaveBeenCalledOnce();
    expect(ownedCallbacks.filesystem).toHaveBeenCalledOnce();
    expect(ownedCallbacks.memoryWrite).toHaveBeenCalledOnce();
  });

  it('wires shared direct runtime routes without ChatAgent wrappers', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: {
        providers: [{
          name: 'OpenAI',
          type: 'openai',
          model: 'gpt-oss-120b',
          tier: 'frontier',
          connected: true,
          isDefault: true,
        }],
      },
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
    } as never;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message: originalMessage,
      routedMessage,
      ctx,
      userKey: 'owner:web',
      stateAgentId: 'chat',
      decision: providerDecision(),
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      callbacks: callbacks(),
    });

    const result = await handlers.provider_read?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toContain('Configured AI providers:');
    expect(executeModelTool).toHaveBeenCalledWith(
      'llm_provider_list',
      {},
      expect.objectContaining({
        agentId: 'chat',
        requestId: 'routed-message',
      }),
    );
  });
});
