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
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
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
    expect(ownedCallbacks.personalAssistant).toHaveBeenCalledOnce();
    expect(ownedCallbacks.codingBackend).toHaveBeenCalledOnce();
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
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      decision: providerDecision(),
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
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

  it('keeps direct memory approvals on the shared pending-action path', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: false,
      status: 'pending_approval',
      approvalId: 'approval-1',
    }));
    const getApprovalSummaries = vi.fn(() => new Map([
      ['approval-1', { toolName: 'memory_save', argsPreview: '{"content":"launch code is 123"}' }],
    ]));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries,
    } as never;
    const deps = runtimeDeps(tools);
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: deps,
      message: { ...originalMessage, content: 'remember launch code is 123' },
      routedMessage: { ...routedMessage, content: 'remember launch code is 123' },
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      callbacks: callbacks(),
    });

    const result = await handlers.memory_write?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toEqual({ content: 'blocked' });
    expect(executeModelTool).toHaveBeenCalledWith(
      'memory_save',
      expect.objectContaining({
        content: 'launch code is 123',
        scope: 'global',
      }),
      expect.objectContaining({
        agentId: 'chat',
        agentContext: { checkAction: ctx.checkAction },
        requestId: 'routed-message',
      }),
    );
    expect(deps.setApprovalFollowUp).toHaveBeenCalledWith(
      'approval-1',
      expect.objectContaining({
        approved: 'I saved that to global memory.',
        denied: 'I did not save that to global memory.',
      }),
    );
    expect(deps.setPendingApprovalActionForRequest).toHaveBeenCalledWith(
      'owner:web',
      undefined,
      expect.objectContaining({
        approvalIds: ['approval-1'],
        route: 'memory_task',
        operation: 'save',
      }),
    );
    expect(deps.buildPendingApprovalBlockedResponse).toHaveBeenCalled();
  });

  it('keeps direct filesystem saves on stored-save orchestration instead of raw tools', async () => {
    const executeModelTool = vi.fn();
    const executeStoredFilesystemSave = vi.fn(async () => ({ content: 'stored' }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries: vi.fn(),
      getPolicy: vi.fn(() => ({})),
    } as never;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message: { ...originalMessage, content: 'save that as notes.txt' },
      routedMessage: { ...routedMessage, content: 'save that as notes.txt' },
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      conversationService: {
        getSessionHistory: vi.fn(() => [{ role: 'assistant', content: 'draft content' }]),
      },
      stateAgentId: 'chat',
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave,
      callbacks: callbacks(),
    });

    const result = await handlers.filesystem?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toEqual({ content: 'stored' });
    expect(executeStoredFilesystemSave).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: expect.stringMatching(/S:[\\/]Development[\\/]GuardianAgent[\\/]notes\.txt$/),
      content: 'draft content',
      userKey: 'owner:web',
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      allowPathRemediation: true,
    }));
    expect(executeModelTool).not.toHaveBeenCalled();
  });
});
