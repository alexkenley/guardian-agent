import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  buildChatDirectCodingRouteDeps,
  buildChatDirectRouteHandlers,
  type ChatDirectCodingRouteDeps,
} from './direct-route-handlers.js';
import type { DirectCodingBackendDeps } from './direct-coding-backend.js';
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

function runtimeDeps(
  tools: DirectRuntimeDepsInput['tools'],
  overrides: Partial<DirectRuntimeDepsInput> = {},
): DirectRuntimeDepsInput {
  return {
    agentId: 'chat',
    tools,
    conversationService: { getHistoryForContext: vi.fn(() => []) },
    buildImmediateResponseMetadata: vi.fn(() => undefined),
    setApprovalFollowUp: vi.fn(),
    getPendingApprovals: vi.fn(() => null),
    formatPendingApprovalPrompt: vi.fn(() => 'approve'),
    parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
    setClarificationPendingAction: vi.fn(() => ({ action: null })),
    setPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    buildPendingApprovalBlockedResponse: vi.fn(() => ({ content: 'blocked' })),
    ...overrides,
  };
}

function codingRoutes(
  tools: DirectRuntimeDepsInput['tools'],
  overrides: {
    backendDeps?: Partial<DirectCodingBackendDeps>;
    sessionControlDeps?: Partial<ChatDirectCodingRouteDeps['sessionControlDeps']>;
  } = {},
): ChatDirectCodingRouteDeps {
  return {
    backendDeps: {
      agentId: 'chat',
      tools,
      codeSessionStore: { getSession: vi.fn(() => null) },
      parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
      ensureExplicitCodingTaskWorkspaceTarget: vi.fn(async () => ({ status: 'unchanged' })),
      recordIntentRoutingTrace: vi.fn(),
      getPendingApprovalIds: vi.fn(() => []),
      setPendingApprovals: vi.fn(),
      syncPendingApprovalsFromExecutor: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: null })),
      ...overrides.backendDeps,
    },
    sessionControlDeps: {
      executeDirectCodeSessionTool: vi.fn(async () => ({ success: true, output: {} })),
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      onMessage: vi.fn(async () => ({ content: 'fallback' })),
      ...overrides.sessionControlDeps,
    },
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
  it('builds coding route dependencies with brokered tool authority metadata', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: { currentSessionId: 'code-1' },
    }));
    const getCodeSessionManagedSandboxStatus = vi.fn(() => ({
      sessionId: 'code-1',
      sandboxes: [],
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries: vi.fn(() => new Map()),
      getCodeSessionManagedSandboxStatus,
    } as never;
    const checkAction = vi.fn();
    const deps = buildChatDirectCodingRouteDeps({
      agentId: 'chat',
      tools,
      codeSessionStore: { getSession: vi.fn(() => null), listSessionsForUser: vi.fn(() => []) },
      parsePendingActionUserKey: vi.fn(() => ({ userId: 'owner', channel: 'web' })),
      recordIntentRoutingTrace: vi.fn(),
      getPendingApprovalIds: vi.fn(() => []),
      setPendingApprovals: vi.fn(),
      syncPendingApprovalsFromExecutor: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: null })),
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      onMessage: vi.fn(async () => ({ content: 'fallback' })),
    });

    await deps.sessionControlDeps.executeDirectCodeSessionTool(
      'code_session_current',
      {},
      {
        ...originalMessage,
        id: 'request-1',
        surfaceId: 'surface-1',
        principalId: 'principal-1',
        principalRole: 'owner',
      },
      { checkAction } as unknown as AgentContext,
    );
    const sandboxStatus = deps.sessionControlDeps.getCodeSessionManagedSandboxes?.('code-1', 'owner');

    expect(executeModelTool).toHaveBeenCalledWith(
      'code_session_current',
      {},
      expect.objectContaining({
        origin: 'assistant',
        agentId: 'chat',
        userId: 'owner',
        surfaceId: 'surface-1',
        principalId: 'principal-1',
        principalRole: 'owner',
        channel: 'web',
        requestId: 'request-1',
        agentContext: { checkAction },
      }),
    );
    expect(sandboxStatus).toEqual({ sessionId: 'code-1', sandboxes: [] });
    expect(getCodeSessionManagedSandboxStatus).toHaveBeenCalledWith({
      sessionId: 'code-1',
      ownerUserId: 'owner',
    });
  });

  it('wires personal assistant routing through shared Second Brain dependencies', async () => {
    const getOverview = vi.fn(() => ({
      nextEvent: null,
      topTasks: [],
      recentNotes: [],
      enabledRoutineCount: 0,
      usage: {
        externalTokens: 0,
        monthlyBudget: 10_000,
      },
    }));
    const tools = { isEnabled: vi.fn(() => false) } as never;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      message: originalMessage,
      routedMessage,
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      decision: {
        route: 'personal_assistant_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect Second Brain.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'personal_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        entities: { personalItemType: 'overview' },
      } as IntentGatewayDecision,
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      runtimeDeps: runtimeDeps(tools, {
        secondBrainService: {
          getOverview,
        } as never,
      }),
      codingRoutes: codingRoutes(tools),
    });

    const result = await handlers.personal_assistant?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toContain('Second Brain overview:');
    expect(getOverview).toHaveBeenCalledOnce();
  });

  it('wires coding backend dispatch through shared route dependencies', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        backendId: 'codex',
        backendName: 'Codex',
        assistantResponse: 'Implemented the requested change.',
        codeSessionId: 'code-1',
        durationMs: 32,
      },
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries: vi.fn(() => new Map()),
    } as never;
    const decision: IntentGatewayDecision = {
      route: 'coding_task',
      confidence: 'high',
      operation: 'create',
      summary: 'Run Codex on the task.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'local',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      entities: { codingBackend: 'codex' },
    } as IntentGatewayDecision;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message: { ...originalMessage, content: 'original request' },
      routedMessage: { ...routedMessage, content: 'Fix the failing API regression.' },
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      decision,
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      codingRoutes: codingRoutes(tools),
    });

    const result = await handlers.coding_backend?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toMatchObject({
      content: 'Implemented the requested change.',
      metadata: {
        codingBackendDelegated: true,
        codingBackendId: 'codex',
        codeSessionResolved: true,
        codeSessionId: 'code-1',
      },
    });
    expect(executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'Fix the failing API regression.',
        backend: 'codex',
      },
      expect.objectContaining({
        agentId: 'chat',
        requestId: 'routed-message',
        codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      }),
    );
  });

  it('wires coding session control through shared route dependencies', async () => {
    const executeDirectCodeSessionTool = vi.fn(async () => ({
      success: true,
      output: {
        session: {
          id: 'code-1',
          title: 'GuardianAgent',
          workspaceRoot: 'S:/Development/GuardianAgent',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
    } as never;
    const decision: IntentGatewayDecision = {
      route: 'coding_session_control',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect current coding session.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      entities: {},
    } as IntentGatewayDecision;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message: { ...originalMessage, content: 'what coding workspace is this?' },
      routedMessage: { ...routedMessage, content: 'routed content' },
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      decision,
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      codingRoutes: codingRoutes(tools, {
        sessionControlDeps: {
          executeDirectCodeSessionTool,
        },
      }),
    });

    const result = await handlers.coding_session_control?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toMatchObject({
      content: expect.stringContaining('This chat is currently attached to:'),
      metadata: {
        codeSessionResolved: true,
        codeSessionId: 'code-1',
      },
    });
    expect(executeDirectCodeSessionTool).toHaveBeenCalledWith(
      'code_session_current',
      {},
      expect.objectContaining({
        id: 'original-message',
        content: 'what coding workspace is this?',
      }),
      ctx,
    );
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
      codingRoutes: codingRoutes(tools),
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
      codingRoutes: codingRoutes(tools),
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

  it('honors strict direct memory save acknowledgement constraints without saving the acknowledgement directive', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: {
        scope: 'global',
      },
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries: vi.fn(),
    } as never;
    const message = {
      ...originalMessage,
      content: 'Remember this exact manual test marker: UI-MEM-91827. Reply only with: stored',
    };
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message,
      routedMessage: message,
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      codingRoutes: codingRoutes(tools),
    });

    const result = await handlers.memory_write?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toBe('stored');
    expect(executeModelTool).toHaveBeenCalledWith(
      'memory_save',
      expect.objectContaining({
        content: 'this exact manual test marker: UI-MEM-91827',
        scope: 'global',
      }),
      expect.any(Object),
    );
  });

  it('honors strict direct memory search answer constraints after retrieval', async () => {
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: {
        results: [{
          source: 'global',
          category: 'Manual Tests',
          summary: 'this exact manual test marker: UI-MEM-91827. Reply only with: stored',
          content: 'this exact manual test marker: UI-MEM-91827. Reply only with: stored',
        }],
      },
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool,
      getApprovalSummaries: vi.fn(),
    } as never;
    const handlers = buildChatDirectRouteHandlers({
      agentId: 'chat',
      tools,
      runtimeDeps: runtimeDeps(tools),
      message: { ...originalMessage, content: 'Search memory for UI-MEM-91827 and reply with only the marker if you find it.' },
      routedMessage: { ...routedMessage, content: 'Search memory for UI-MEM-91827 and reply with only the marker if you find it.' },
      ctx,
      userKey: 'owner:web',
      conversationKey: { userId: 'owner', channel: 'web' },
      stateAgentId: 'chat',
      llmMessages: [],
      defaultToolResultProviderKind: 'local',
      sanitizeToolResultForLlm: vi.fn(),
      chatWithFallback: vi.fn(),
      executeStoredFilesystemSave: vi.fn(),
      codingRoutes: codingRoutes(tools),
    });

    const result = await handlers.memory_read?.({
      gatewayDirected: true,
      gatewayUnavailable: false,
      skipDirectWebSearch: false,
    });

    expect(result).toBe('UI-MEM-91827');
    expect(executeModelTool).toHaveBeenCalledWith(
      'memory_search',
      expect.objectContaining({
        query: 'UI-MEM-91827',
      }),
      expect.any(Object),
    );
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
      codingRoutes: codingRoutes(tools),
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
