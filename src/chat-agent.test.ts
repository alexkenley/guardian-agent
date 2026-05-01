import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from './agent/types.js';
import { createChatAgentClass } from './chat-agent.js';
import { ModelFallbackChain } from './llm/model-fallback.js';
import { CodeSessionStore } from './runtime/code-sessions.js';
import { ConversationService } from './runtime/conversation.js';
import { ContinuityThreadStore } from './runtime/continuity-threads.js';
import { attachSelectedExecutionProfileMetadata } from './runtime/execution-profiles.js';
import { ExecutionGraphStore } from './runtime/execution-graph/graph-store.js';
import { recordGraphPendingActionInterrupt } from './runtime/execution-graph/pending-action-adapter.js';
import { attachPreRoutedIntentGatewayMetadata, type IntentGatewayRecord } from './runtime/intent-gateway.js';
import { recordChatContinuationGraphApproval } from './runtime/chat-agent/chat-continuation-graph.js';
import { buildToolLoopContinuationPayload, readToolLoopContinuationPayload } from './runtime/chat-agent/tool-loop-continuation.js';
import { tryDirectAutomationControl } from './runtime/chat-agent/direct-automation.js';
import { tryDirectCodingBackendDelegation } from './runtime/chat-agent/direct-coding-backend.js';
import { buildChatDirectCodingRouteDeps } from './runtime/chat-agent/direct-route-handlers.js';
import { resolveConversationHistoryChannel } from './runtime/channel-surface-ids.js';
import { tryDirectGoogleWorkspaceRead } from './runtime/chat-agent/direct-mailbox-runtime.js';
import {
  tryDirectPersonalAssistantRead,
  tryDirectPersonalAssistantWrite,
} from './runtime/chat-agent/direct-personal-assistant.js';
import {
  buildDirectAutomationDeps,
  buildDirectMailboxDeps,
  buildDirectPersonalAssistantDeps,
  type DirectRuntimeDepsInput,
} from './runtime/chat-agent/direct-runtime-deps.js';
import { PendingActionStore, type PendingActionRecord } from './runtime/pending-actions.js';

function createDirectRuntimeDeps(
  tools: unknown,
  overrides: Partial<DirectRuntimeDepsInput> = {},
): DirectRuntimeDepsInput {
  return {
    agentId: 'chat',
    tools: tools as never,
    setApprovalFollowUp: vi.fn(),
    getPendingApprovals: vi.fn(() => null),
    formatPendingApprovalPrompt: vi.fn(() => ''),
    parsePendingActionUserKey: vi.fn((userKey: string) => {
      const [userId, channel = 'web'] = userKey.split(':');
      return { userId: userId || 'owner', channel };
    }),
    setClarificationPendingAction: vi.fn(() => ({ action: null })),
    setPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    buildPendingApprovalBlockedResponse: vi.fn((_result, fallbackContent) => ({ content: fallbackContent })),
    buildImmediateResponseMetadata: vi.fn(() => undefined),
    ...overrides,
  };
}

function directPersonalAssistantDepsForAgent(agent: any) {
  return buildDirectPersonalAssistantDeps(createDirectRuntimeDeps(agent.tools, {
    agentId: agent.id,
    secondBrainService: agent.secondBrainService,
    setApprovalFollowUp: (approvalId, copy) => agent.setApprovalFollowUp(approvalId, copy),
    getPendingApprovals: (userKey, surfaceId, nowMs) => agent.getPendingApprovals(userKey, surfaceId, nowMs),
    formatPendingApprovalPrompt: (ids, summaries) => agent.formatPendingApprovalPrompt(ids, summaries),
    parsePendingActionUserKey: (userKey) => agent.parsePendingActionUserKey(userKey),
    setClarificationPendingAction: (userId, channel, surfaceId, action, nowMs) => agent.setClarificationPendingAction(
      userId,
      channel,
      surfaceId,
      action,
      nowMs,
    ),
    setPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => agent.setPendingApprovalActionForRequest(
      userKey,
      surfaceId,
      action,
      nowMs,
    ),
    buildPendingApprovalBlockedResponse: (result, fallbackContent) => agent.buildPendingApprovalBlockedResponse(
      result,
      fallbackContent,
    ),
    buildImmediateResponseMetadata: (_pendingApprovalIds, userId, channel, surfaceId, options) => agent.buildImmediateResponseMetadata(
      [],
      userId,
      channel,
      surfaceId,
      options,
    ),
  }));
}

function tryAgentDirectSecondBrainRead(
  agent: any,
  message: UserMessage,
  decision?: any,
  continuityThread?: any,
) {
  return tryDirectPersonalAssistantRead(
    { message, decision, continuityThread },
    directPersonalAssistantDepsForAgent(agent),
  );
}

function tryAgentDirectSecondBrainWrite(
  agent: any,
  message: UserMessage,
  ctx: AgentContext,
  userKey: string,
  decision?: any,
  continuityThread?: any,
) {
  return tryDirectPersonalAssistantWrite(
    { message, ctx, userKey, decision, continuityThread },
    directPersonalAssistantDepsForAgent(agent),
  );
}

function directCodingBackendDepsForAgent(agent: any) {
  return buildChatDirectCodingRouteDeps({
    agentId: agent.id,
    tools: agent.tools,
    codeSessionStore: agent.codeSessionStore,
    parsePendingActionUserKey: (key) => agent.parsePendingActionUserKey(key),
    recordIntentRoutingTrace: (stage, input) => agent.recordIntentRoutingTrace(stage, input),
    getPendingApprovalIds: (userId, channel, surfaceId) => agent.getPendingApprovalIds(userId, channel, surfaceId),
    setPendingApprovals: (key, ids, surfaceId, nowMs) => agent.setPendingApprovals(key, ids, surfaceId, nowMs),
    syncPendingApprovalsFromExecutor: (
      sourceUserId,
      sourceChannel,
      targetUserId,
      targetChannel,
      surfaceId,
      originalUserContent,
    ) => agent.syncPendingApprovalsFromExecutor(
      sourceUserId,
      sourceChannel,
      targetUserId,
      targetChannel,
      surfaceId,
      originalUserContent,
    ),
    setPendingApprovalAction: (userId, channel, surfaceId, actionInput) => agent.setPendingApprovalAction(
      userId,
      channel,
      surfaceId,
      actionInput,
    ),
    getActivePendingAction: (userId, channel, surfaceId) => agent.getActivePendingAction(userId, channel, surfaceId),
    completePendingAction: (actionId) => agent.completePendingAction(actionId),
    onMessage: (nextMessage, nextCtx) => agent.onMessage(nextMessage, nextCtx),
  }).backendDeps;
}

function tryAgentDirectCodingBackendDelegation(
  agent: any,
  message: UserMessage,
  ctx: AgentContext,
  userKey: string,
  decision?: any,
  codeContext?: { sessionId?: string; workspaceRoot: string },
) {
  return tryDirectCodingBackendDelegation(
    { message, ctx, userKey, decision, codeContext },
    directCodingBackendDepsForAgent(agent),
  );
}

function createToolLoopGraphPendingAction(input: {
  executionGraphStore: ExecutionGraphStore;
  pendingActionStore: PendingActionStore;
  agentId: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  requestId: string;
  prompt: string;
  approvalId: string;
  originalUserContent: string;
  route: PendingActionRecord['intent']['route'];
  operation: PendingActionRecord['intent']['operation'];
  summary?: string;
  codeSessionId?: string;
  continuation: Record<string, unknown>;
}): PendingActionRecord {
  const continuation = readToolLoopContinuationPayload(input.continuation);
  if (!continuation) {
    throw new Error('Invalid test tool-loop continuation payload.');
  }
  const result = recordChatContinuationGraphApproval({
    graphStore: input.executionGraphStore,
    userKey: `${input.userId}:${input.channel}`,
    userId: input.userId,
    channel: input.channel,
    surfaceId: input.surfaceId,
    agentId: input.agentId,
    requestId: input.requestId,
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    action: {
      prompt: input.prompt,
      approvalIds: [input.approvalId],
      originalUserContent: input.originalUserContent,
      route: input.route,
      operation: input.operation,
      summary: input.summary,
      continuation,
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    },
    setGraphPendingActionForRequest: (_userKey, surfaceId, action, nowMs) => {
      const pendingAction = recordGraphPendingActionInterrupt({
        store: input.pendingActionStore,
        scope: {
          agentId: input.agentId,
          userId: input.userId,
          channel: input.channel,
          ...(surfaceId ? { surfaceId } : {}),
        },
        event: action.event,
        originalUserContent: action.originalUserContent,
        intent: action.intent,
        artifactRefs: action.artifactRefs,
        approvalSummaries: action.approvalSummaries,
        nowMs,
      });
      if (!pendingAction) {
        throw new Error('Failed to record graph pending action.');
      }
      return { action: pendingAction };
    },
    nowMs: 1,
  });
  if (!result.action) {
    throw new Error('Failed to create graph pending action.');
  }
  return result.action;
}

describe('LLMChatAgent direct intent metadata', () => {
  it('suppresses blocked approval context for unrelated fresh turns before intent-gateway classification', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const nowMs = Date.now();
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-intent-gateway-context-filter.test.sqlite',
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-intent-gateway-context-filter-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    (agent as any).pendingActionStore = pendingActionStore;
    (agent as any).continuityThreadStore = continuityThreadStore;
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Waiting for approval to run Codex.',
        approvalIds: ['approval-codex-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'inspect',
        originalUserContent: 'Use Codex in this coding workspace to inspect README.md and package.json.',
      },
      expiresAt: nowMs + 60_000,
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      focusSummary: 'Inspect the repository summary request.',
      lastActionableRequest: 'Use Codex in this coding workspace to inspect README.md and package.json.',
    }, nowMs);

    const classify = vi.fn(async () => ({
      mode: 'primary',
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'general_assistant',
        confidence: 'low',
        operation: 'inspect',
        summary: 'Treat as a fresh request.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'direct_assistant',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        simpleVsComplex: 'simple',
        entities: {},
      },
    }));
    (agent as any).intentGateway = { classify };

    await (agent as any).classifyIntentGateway(
      {
        id: 'msg-random-word',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
        content: 'Hiroshima',
        timestamp: nowMs,
      },
      {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        llm: { name: 'ollama_cloud' } as never,
        checkAction: vi.fn(),
        capabilities: [],
      },
      {
        recentHistory: [
          { role: 'user', content: 'Use Codex in this coding workspace to inspect README.md and package.json.' },
          { role: 'assistant', content: 'Waiting for approval to run Codex.' },
        ],
        pendingAction: (agent as any).getActivePendingAction('owner', 'web', 'web-guardian-chat', nowMs),
        continuityThread: (agent as any).getContinuityThread('owner', nowMs),
      },
    );

    expect(classify).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hiroshima',
      recentHistory: undefined,
      pendingAction: null,
      continuity: null,
    }), expect.any(Function));
  });

  it('repairs generic managed-cloud tool plans with a configured frontier gateway pass', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const managedChat = vi.fn(async () => ({
      content: '{}',
      toolCalls: [],
      model: 'qwen/qwen3.6-plus',
      finishReason: 'stop',
    }));
    const frontierChat = vi.fn(async () => ({
      content: '{}',
      toolCalls: [],
      model: 'gpt-4o',
      finishReason: 'stop',
    }));
    const fallbackChain = new ModelFallbackChain(new Map([
      ['nvidia-tools', { name: 'nvidia-tools', chat: managedChat } as never],
      ['openai', { name: 'openai', chat: frontierChat } as never],
    ]), ['nvidia-tools', 'openai']);
    const genericRecord: IntentGatewayRecord = {
      mode: 'primary',
      available: true,
      model: 'qwen/qwen3.6-plus',
      latencyMs: 1,
      decision: {
        route: 'general_assistant',
        confidence: 'high',
        operation: 'search',
        summary: 'Find matching automations and routines.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        plannedSteps: [
          {
            kind: 'search',
            summary: 'Find matching automations and routines.',
            expectedToolCategories: ['search'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Suggest one useful automation.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
        entities: {},
      },
    };
    const concreteRecord: IntentGatewayRecord = {
      ...genericRecord,
      model: 'gpt-4o',
      decision: {
        ...genericRecord.decision,
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read existing automations.',
            expectedToolCategories: ['automation_list'],
            required: true,
          },
          {
            kind: 'read',
            summary: 'Read existing Second Brain routines.',
            expectedToolCategories: ['second_brain_routine_list', 'second_brain_routine_catalog'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Suggest one useful automation.',
            required: true,
            dependsOn: ['step_1', 'step_2'],
          },
        ],
      },
    };
    const classify = vi.fn(async (_input: unknown, chat: any) => {
      const response = await chat([{ role: 'user', content: 'classify' }], {
        responseFormat: { type: 'json_object' },
      });
      return response.model === 'gpt-4o' ? concreteRecord : genericRecord;
    });

    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).intentGateway = { classify };
    (agent as any).fallbackChain = fallbackChain;
    (agent as any).readConfig = () => ({
      defaultProvider: 'nvidia-tools',
      llm: {
        'nvidia-tools': {
          provider: 'nvidia',
          model: 'qwen/qwen3.6-plus',
          enabled: true,
        },
        openai: {
          provider: 'openai',
          model: 'gpt-4o',
          enabled: true,
        },
      },
      assistant: {
        tools: {
          preferredProviders: {
            managedCloud: 'nvidia-tools',
            frontier: 'openai',
          },
        },
      },
    });

    const result = await (agent as any).classifyIntentGateway({
      id: 'msg-generic-plan',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Find any automations or routines related to approval, routing, or code review, then suggest one useful automation I could create. Do not create it yet.',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_tool',
        providerName: 'nvidia-tools',
        providerType: 'nvidia',
        providerModel: 'qwen/qwen3.6-plus',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['nvidia-tools', 'openai'],
        reason: 'managed cloud selected for test',
        routingMode: 'auto',
        selectionSource: 'auto',
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'nvidia-tools', chat: managedChat } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(classify).toHaveBeenCalledTimes(2);
    expect(managedChat).toHaveBeenCalledTimes(1);
    expect(frontierChat).toHaveBeenCalledTimes(1);
    expect(result?.decision.plannedSteps?.map((step: { expectedToolCategories?: string[] }) => step.expectedToolCategories)).toEqual([
      ['automation_list'],
      ['second_brain_routine_list', 'second_brain_routine_catalog'],
      undefined,
    ]);
    expect(result?.model).toBe('gpt-4o');
  });

  it('preserves blocked approval context for legitimate correction turns before intent-gateway classification', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const nowMs = 1_710_000_000_000;
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-intent-gateway-context-preserve.test.sqlite',
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-intent-gateway-context-preserve-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    (agent as any).pendingActionStore = pendingActionStore;
    (agent as any).continuityThreadStore = continuityThreadStore;
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Waiting for approval to run Codex.',
        approvalIds: ['approval-codex-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'inspect',
        originalUserContent: 'Use Codex in this coding workspace to inspect README.md and package.json.',
      },
      expiresAt: nowMs + 60_000,
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      focusSummary: 'Inspect the repository summary request.',
      lastActionableRequest: 'Use Codex in this coding workspace to inspect README.md and package.json.',
    }, nowMs);

    const classify = vi.fn(async () => ({
      mode: 'primary',
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Switches the backend for the blocked coding request.',
        turnRelation: 'correction',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        entities: {
          codingBackend: 'claude-code',
        },
      },
    }));
    (agent as any).intentGateway = { classify };

    await (agent as any).classifyIntentGateway(
      {
        id: 'msg-correction',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
        content: 'Can you use Claude Code instead?',
        timestamp: nowMs,
      },
      {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        llm: { name: 'ollama_cloud' } as never,
        checkAction: vi.fn(),
        capabilities: [],
      },
      {
        recentHistory: [
          { role: 'user', content: 'Use Codex in this coding workspace to inspect README.md and package.json.' },
          { role: 'assistant', content: 'Waiting for approval to run Codex.' },
        ],
        pendingAction: (agent as any).getActivePendingAction('owner', 'web', 'web-guardian-chat', nowMs),
        continuityThread: (agent as any).getContinuityThread('owner', nowMs),
      },
    );

    expect(classify).toHaveBeenCalledWith(expect.objectContaining({
      recentHistory: expect.any(Array),
      pendingAction: expect.objectContaining({
        blockerKind: 'approval',
        originalRequest: 'Use Codex in this coding workspace to inspect README.md and package.json.',
      }),
      continuity: expect.objectContaining({
        lastActionableRequest: 'Use Codex in this coding workspace to inspect README.md and package.json.',
      }),
    }), expect.any(Function));
  });

  it('backfills responseSource for direct intent responses so the UI does not show them as system output', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const message: UserMessage = {
      id: 'msg-1',
      userId: 'owner',
      channel: 'web',
      content: 'Search the repo for "ollama_cloud" and tell me which files define its routing.',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-general',
        providerType: 'ollama_cloud',
        providerModel: 'gpt-oss:120b',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 80000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-general'],
        reason: 'managed-cloud role binding',
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'filesystem',
      result: 'I searched "S:\\Development\\GuardianAgent" for "ollama_cloud".',
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'search',
          summary: 'Search the repo.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
    });

    expect(response.metadata?.responseSource).toMatchObject({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-general',
      model: 'gpt-oss:120b',
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
  });

  it('reconciles managed sandbox state before building code-session prompt context', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const root = process.cwd();
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-managed-sandbox-prompt-refresh.test.sqlite',
    });
    const session = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Managed Sandbox Prompt Refresh',
      workspaceRoot: root,
    });
    codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: 'owner',
      workState: {
        managedSandboxes: [{
          leaseId: 'lease-daytona',
          targetId: 'daytona:daytona-main',
          backendKind: 'daytona_sandbox',
          profileId: 'daytona-main',
          profileName: 'Daytona Main',
          sandboxId: 'sandbox-1',
          localWorkspaceRoot: root,
          remoteWorkspaceRoot: '/home/daytona/guardian-workspace',
          status: 'stopped',
          state: 'stopped',
          acquiredAt: 1,
          lastUsedAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
          trackedRemotePaths: [],
          healthState: 'healthy',
          healthReason: 'Managed sandbox is stopped.',
          healthCheckedAt: 1,
        }],
      },
    });

    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).codeSessionStore = codeSessionStore;
    (agent as any).tools = {
      getCodeSessionManagedSandboxStatus: vi.fn(async ({ sessionId, ownerUserId }: { sessionId: string; ownerUserId?: string }) => {
        codeSessionStore.updateSession({
          sessionId,
          ownerUserId,
          workState: {
            managedSandboxes: [{
              leaseId: 'lease-daytona',
              targetId: 'daytona:daytona-main',
              backendKind: 'daytona_sandbox',
              profileId: 'daytona-main',
              profileName: 'Daytona Main',
              sandboxId: 'sandbox-1',
              localWorkspaceRoot: root,
              remoteWorkspaceRoot: '/home/daytona/guardian-workspace',
              status: 'active',
              state: 'started',
              acquiredAt: 1,
              lastUsedAt: 2,
              expiresAt: Number.MAX_SAFE_INTEGER,
              trackedRemotePaths: [],
              healthState: 'healthy',
              healthReason: 'Managed sandbox is execution-ready.',
              healthCheckedAt: 2,
            }],
          },
        });
        return {
          codeSessionId: sessionId,
          defaultTargetId: null,
          targets: [],
          sandboxes: [],
        };
      }),
    };

    const refreshed = await (agent as any).refreshCodeSessionWorkspaceAwareness({
      session: codeSessionStore.getSession(session.id, 'owner')!,
    }, 'Run pwd in the remote sandbox for this workspace.');

    expect((agent as any).tools.getCodeSessionManagedSandboxStatus).toHaveBeenCalledWith({
      sessionId: session.id,
      ownerUserId: 'owner',
    });
    expect(refreshed.session.workState.managedSandboxes[0]?.state).toBe('started');
    expect(refreshed.session.workState.managedSandboxes[0]?.status).toBe('active');
  });

  it('prefers routed execution-profile metadata for direct intent response source labels', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const message: UserMessage = {
      id: 'msg-1',
      userId: 'owner',
      channel: 'web',
      content: 'List my coding workspaces.',
      timestamp: Date.now(),
    };
    const routingMessage: UserMessage = {
      ...message,
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'qwen3-coder-next',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 80000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding'],
        reason: 'managed-cloud coding role binding',
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'coding_session_control',
      result: 'Available coding workspaces:\n- CURRENT: Guardian Agent',
      message,
      routingMessage,
      intentGateway: {
        available: true,
        decision: {
          route: 'coding_session_control',
          operation: 'navigate',
          summary: 'Lists coding workspaces.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
    });

    expect(response.metadata?.responseSource).toMatchObject({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-coding',
      model: 'qwen3-coder-next',
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
  });

  it('reattaches the live approval pending action for delegated held-for-approval responses', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      {
        listPendingApprovalIdsForUser: vi.fn(() => ['approval-gmail-1']),
        getApprovalSummaries: vi.fn(() => new Map([
          ['approval-gmail-1', {
            toolName: 'gws - gmail users messages list',
            argsPreview: '{"userId":"me","maxResults":10}',
            actionLabel: 'run Gmail inbox read',
          }],
        ])),
      } as never,
    );
    const store = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-pending-action-metadata.test.sqlite',
      now: () => nowMs,
    });
    (agent as any).pendingActionStore = store;
    store.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Waiting for approval to run gws - gmail users messages list.',
        approvalIds: ['approval-gmail-1'],
        approvalSummaries: [{
          id: 'approval-gmail-1',
          toolName: 'gws - gmail users messages list',
          argsPreview: '{"userId":"me","maxResults":10}',
          actionLabel: 'run Gmail inbox read',
        }],
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
      expiresAt: nowMs + 60_000,
    });

    const metadata = (agent as any).withCurrentPendingActionMetadata(
      {
        delegatedHandoff: {
          reportingMode: 'held_for_approval',
          unresolvedBlockerKind: 'approval',
          approvalCount: 1,
        },
      },
      'owner',
      'web',
      'web-guardian-chat',
    );

    expect(metadata?.pendingAction).toMatchObject({
      blocker: {
        kind: 'approval',
        approvalIds: ['approval-gmail-1'],
        approvalSummaries: [{
          id: 'approval-gmail-1',
          toolName: 'gws - gmail users messages list',
        }],
      },
    });
  });

  it('replaces a stale clarification blocker with the live approval blocker for delegated held-for-approval responses', async () => {
    const nowMs = Date.now();
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      {
        listPendingApprovalIdsForUser: vi.fn(() => ['approval-gmail-1']),
        getApprovalSummaries: vi.fn(() => new Map([
          ['approval-gmail-1', {
            toolName: 'gws - gmail users messages list',
            argsPreview: '{"userId":"me","maxResults":10}',
            actionLabel: 'run Gmail inbox read',
          }],
        ])),
      } as never,
    );
    const store = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-pending-action-metadata-clarification.test.sqlite',
      now: () => nowMs,
    });
    (agent as any).pendingActionStore = store;
    store.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'clarification',
        prompt: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?',
        field: 'email_provider',
        options: [
          { value: 'gws', label: 'Gmail' },
          { value: 'm365', label: 'Outlook' },
        ],
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
      expiresAt: nowMs + 60_000,
    });

    const metadata = (agent as any).withCurrentPendingActionMetadata(
      {
        delegatedHandoff: {
          reportingMode: 'held_for_approval',
          unresolvedBlockerKind: 'approval',
          approvalCount: 1,
        },
      },
      'owner',
      'web',
      'web-guardian-chat',
    );

    expect(metadata?.pendingAction).toMatchObject({
      blocker: {
        kind: 'approval',
        prompt: 'Waiting for approval to run Gmail inbox read.',
        approvalIds: ['approval-gmail-1'],
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
    });
  });

  it('auto-switches to an explicitly named coding workspace before delegated coding work runs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-code-sessions.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const targetSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'TempInstallTest',
      workspaceRoot: '/tmp/guardian-ui-package-test',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test1 in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-code-target',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use Codex in the TempInstallTest coding workspace to create test1 in the top-level directory.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Create a file in the explicitly named coding workspace.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
            sessionTarget: 'TempInstallTest coding workspace',
          },
        },
      }),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('TempInstallTest');
    expect(response.content).toContain('Created test1 in the requested workspace.');
    expect(response.metadata).toMatchObject({
      codeSessionResolved: true,
      codeSessionId: targetSession.id,
      codeSessionFocusChanged: true,
    });
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(targetSession.id);
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_attach',
      { sessionId: targetSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'coding_backend_run',
      { task: 'Use Codex in the TempInstallTest coding workspace to create test1 in the top-level directory.', backend: 'codex' },
      expect.objectContaining({
        codeContext: {
          sessionId: targetSession.id,
          workspaceRoot: targetSession.resolvedRoot,
        },
      }),
    );
  });

  it('keeps the current attachment when a coding-backend request only says "current attached coding session"', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-current-attached-coding-backend.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              assistantResponse: 'Test run completed in the current workspace.',
              output: 'OpenAI Codex CLI completed.\n\nbash-5.2$ codex exec ...',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-current-attached-coding-backend',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Run the requested test in the current coding session via Codex.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
            sessionTarget: 'current attached',
          },
        },
      }),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Test run completed in the current workspace.');
    expect(response.content).not.toContain('bash-5.2$ codex exec');
    expect(response.metadata).toMatchObject({
      codingBackendDelegated: true,
      codingBackendId: 'codex',
      codeSessionResolved: true,
      codeSessionId: guardianSession.id,
    });
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(guardianSession.id);
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: guardianSession.id,
          workspaceRoot: guardianSession.resolvedRoot,
        },
      }),
    );
  });

  it('scopes direct tool-report answers to the newest request in the attached code session', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = 1_710_000_000_000;
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-tool-report-code-session.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      listJobs: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => [
        {
          id: 'job-external-write',
          toolName: 'fs_write',
          risk: 'medium',
          origin: 'assistant',
          codeSessionId: guardianSession.id,
          userId: 'owner',
          channel: 'web',
          requestId: 'request-external-file',
          argsPreview: '{"path":"C:\\\\Users\\\\kenle\\\\AppData\\\\Local\\\\Temp\\\\guardian-manual-approval-test\\\\brokered-test.txt"}',
          argsRedacted: {
            path: 'C:\\Users\\kenle\\AppData\\Local\\Temp\\guardian-manual-approval-test\\brokered-test.txt',
            content: '',
          },
          status: 'succeeded',
          createdAt: nowMs - 2_000,
          completedAt: nowMs - 1_500,
          requiresApproval: false,
        },
        {
          id: 'job-external-allow',
          toolName: 'update_tool_policy',
          risk: 'medium',
          origin: 'assistant',
          codeSessionId: guardianSession.id,
          userId: 'owner',
          channel: 'web',
          requestId: 'request-external-file',
          argsPreview: '{"action":"add_path","value":"C:\\\\Users\\\\kenle\\\\AppData\\\\Local\\\\Temp\\\\guardian-manual-approval-test"}',
          argsRedacted: {
            action: 'add_path',
            value: 'C:\\Users\\kenle\\AppData\\Local\\Temp\\guardian-manual-approval-test',
          },
          status: 'succeeded',
          createdAt: nowMs - 3_000,
          completedAt: nowMs - 2_500,
          requiresApproval: false,
        },
        {
          id: 'job-workspace-write',
          toolName: 'fs_write',
          risk: 'medium',
          origin: 'assistant',
          codeSessionId: guardianSession.id,
          userId: 'owner',
          channel: 'web',
          requestId: 'request-workspace-file',
          argsPreview: '{"path":"S:\\\\Development\\\\GuardianAgent\\\\brokered-test.txt"}',
          argsRedacted: {
            path: 'S:\\Development\\GuardianAgent\\brokered-test.txt',
            content: '',
          },
          status: 'succeeded',
          createdAt: nowMs - 20_000,
          completedAt: nowMs - 19_500,
          requiresApproval: false,
        },
      ]),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const report = (agent as any).tryDirectRecentToolReport({
      id: 'msg-tool-report-code-session',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'What exact tools did you use for that last file task?',
      timestamp: nowMs,
    } as UserMessage, {
      session: guardianSession,
    });
    nowSpy.mockRestore();

    expect(tools.listJobsForCodeSession).toHaveBeenCalledWith(guardianSession.id, 50);
    expect(tools.listJobs).not.toHaveBeenCalled();
    expect(report).toContain('update_tool_policy');
    expect(report).toContain('guardian-manual-approval-test');
    expect(report).toContain('fs_write');
    expect(report).not.toContain('S:\\Development\\GuardianAgent\\brokered-test.txt');
  });

  it('scopes direct tool-report answers to the newest request outside code sessions', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const tools = {
      isEnabled: vi.fn(() => true),
      listJobs: vi.fn(() => [
        {
          id: 'job-latest',
          toolName: 'gmail_messages_list',
          risk: 'low',
          origin: 'assistant',
          userId: 'owner',
          channel: 'web',
          requestId: 'request-latest',
          argsPreview: '{"maxResults":10}',
          argsRedacted: { maxResults: 10 },
          status: 'succeeded',
          createdAt: nowMs - 2_000,
          completedAt: nowMs - 1_000,
          requiresApproval: false,
        },
        {
          id: 'job-older',
          toolName: 'outlook_send',
          risk: 'medium',
          origin: 'assistant',
          userId: 'owner',
          channel: 'web',
          requestId: 'request-older',
          argsPreview: '{"to":"alex@example.com"}',
          argsRedacted: { to: 'alex@example.com' },
          status: 'succeeded',
          createdAt: nowMs - 30_000,
          completedAt: nowMs - 29_000,
          requiresApproval: false,
        },
      ]),
      listJobsForCodeSession: vi.fn(() => []),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const report = (agent as any).tryDirectRecentToolReport({
      id: 'msg-tool-report-general',
      userId: 'owner',
      channel: 'web',
      content: 'What exact tools did you use for that last task?',
      timestamp: nowMs,
    } as UserMessage, null);
    nowSpy.mockRestore();

    expect(tools.listJobs).toHaveBeenCalledWith(50);
    expect(report).toContain('gmail_messages_list');
    expect(report).not.toContain('outlook_send');
  });

  it('uses the rewritten routed coding task instead of stale gateway resolvedContent for backend-switch follow-ups', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          backendName: 'Claude Code',
          assistantResponse: 'Claude inspected the repo.',
        },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-coding-backend-correction',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use claude-code for this request: Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
      timestamp: Date.now(),
    };

    const response = await tryAgentDirectCodingBackendDelegation(agent,
      message,
      ctx,
      'owner:web',
      {
        route: 'coding_task',
        operation: 'inspect',
        summary: 'Inspect the repo through Claude Code.',
        confidence: 'high',
        turnRelation: 'correction',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        resolvedContent: 'Okay now do the same thing with Claude Code',
        entities: {
          codingBackend: 'claude-code',
        },
      },
      { sessionId: 'session-1', workspaceRoot: '/repo' },
    );

    expect(response?.content).toBe('Claude inspected the repo.');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'Use claude-code for this request: Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
        backend: 'claude-code',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: 'session-1',
          workspaceRoot: '/repo',
        },
      }),
    );
    expect(response?.metadata?.responseSource).toMatchObject({
      locality: 'local',
      providerName: 'Claude Code',
      providerTier: 'local',
      usedFallback: false,
    });
  });

  it('falls back to gateway resolvedContent when a coding-backend follow-up is still ambiguous at execution time', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          backendName: 'Claude Code',
          assistantResponse: 'Claude inspected the repo.',
        },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-coding-backend-ambiguous-follow-up',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Okay now do the same thing with Claude Code',
      timestamp: Date.now(),
    };

    const response = await tryAgentDirectCodingBackendDelegation(agent,
      message,
      ctx,
      'owner:web',
      {
        route: 'coding_task',
        operation: 'inspect',
        summary: 'Inspect the repo through Claude Code.',
        confidence: 'high',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        resolvedContent: 'Use Claude Code in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
        entities: {
          codingBackend: 'claude-code',
        },
      },
      { sessionId: 'session-1', workspaceRoot: '/repo' },
    );

    expect(response?.content).toBe('Claude inspected the repo.');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'Use Claude Code in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
        backend: 'claude-code',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: 'session-1',
          workspaceRoot: '/repo',
        },
      }),
    );
  });

  it('preserves request tracking metadata on approval-blocked coding backend prompts', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-coding-backend-approval-metadata.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: false,
        status: 'pending_approval',
        approvalId: 'approval-codex-1',
      })),
      getApprovalSummaries: vi.fn(() => new Map([
        ['approval-codex-1', {
          toolName: 'coding_backend_run',
          argsPreview: '{"task":"inspect repo"}',
          actionLabel: 'run OpenAI Codex CLI',
          requestId: 'msg-coding-backend-approval',
          codeSessionId: 'session-approve-1',
        }],
      ])),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-coding-backend-approval',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
      timestamp: Date.now(),
    };

    const response = await tryAgentDirectCodingBackendDelegation(agent,
      message,
      ctx,
      'owner:web',
      {
        route: 'coding_task',
        operation: 'inspect',
        summary: 'Inspect the repo through Codex.',
        confidence: 'high',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingBackend: 'codex',
        },
      },
      { sessionId: 'session-approve-1', workspaceRoot: '/repo' },
    );

    expect(response?.metadata?.pendingAction).toMatchObject({
      blocker: {
        kind: 'approval',
        approvalIds: ['approval-codex-1'],
        approvalSummaries: [{
          id: 'approval-codex-1',
          toolName: 'coding_backend_run',
          actionLabel: 'run OpenAI Codex CLI',
          requestId: 'msg-coding-backend-approval',
          codeSessionId: 'session-approve-1',
        }],
      },
    });
  });

  it('auto-switches to an explicitly named coding workspace even when the gateway response is unstructured', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-unstructured-gateway-workspace-switch.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const tacticalSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Test Tactical Game App',
      workspaceRoot: '/tmp/test-tactical-game-app',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test-switch-a in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: vi.fn(async () => ({
          content: 'This looks like a coding request.',
          model: 'test-model',
          finishReason: 'stop',
        })),
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-unstructured-gateway-switch',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
      timestamp: Date.now(),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('Test Tactical Game App');
    expect(response.content).toContain('Created test-switch-a in the requested workspace.');
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(tacticalSession.id);
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_attach',
      { sessionId: tacticalSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'coding_backend_run',
      {
        task: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: tacticalSession.id,
          workspaceRoot: tacticalSession.resolvedRoot,
        },
      }),
    );
  });

  it('accepts affirmative workspace-switch continuations by attaching the target session before resuming the blocked task', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-workspace-switch-continuation.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const tacticalSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Test Tactical Game App',
      workspaceRoot: '/tmp/test-tactical-game-app',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-workspace-switch-pending.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch this chat to Test Tactical Game App first, then ask me to run it there.',
        currentSessionId: guardianSession.id,
        currentSessionLabel: `Guardian Agent — ${guardianSession.workspaceRoot}`,
        targetSessionId: tacticalSession.id,
        targetSessionLabel: `Test Tactical Game App — ${tacticalSession.workspaceRoot}`,
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        summary: 'Create a test file in the tactical game workspace.',
        turnRelation: 'new_request',
        resolution: 'ready',
        originalUserContent: 'Use Codex in the Test Tactical Game App coding workspace to create test 51 in the top-level directory.',
        entities: {
          codingBackend: 'codex',
          codingBackendRequested: true,
          sessionTarget: 'Test Tactical Game App coding workspace',
        },
      },
      codeSessionId: guardianSession.id,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_current') {
          const current = codeSessionStore.resolveForRequest({
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            touchAttachment: false,
          })?.session ?? null;
          return {
            success: true,
            output: {
              session: current
                ? {
                    id: current.id,
                    title: current.title,
                    workspaceRoot: current.workspaceRoot,
                    resolvedRoot: current.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test 51 in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-workspace-switch-continue',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Yes switch to coding session',
      timestamp: Date.now(),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('Test Tactical Game App');
    expect(response.content).toContain('Created test 51 in the requested workspace.');
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(tacticalSession.id);
    expect(pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    })).toBeNull();
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_current',
      {},
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'code_session_attach',
      { sessionId: tacticalSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      3,
      'coding_backend_run',
      {
        task: 'Use Codex in the Test Tactical Game App coding workspace to create test 51 in the top-level directory.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: tacticalSession.id,
          workspaceRoot: tacticalSession.resolvedRoot,
        },
      }),
    );
  });

  it('keeps the selected execution profile on direct Second Brain responses', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const message: UserMessage = {
      id: 'msg-2',
      userId: 'owner',
      channel: 'web',
      content: 'Give me a concise plan for organizing my week.',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-direct',
        providerType: 'ollama_cloud',
        providerModel: 'minimax-m2.1',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 24000,
        toolContextMode: 'tight',
        maxAdditionalSections: 1,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-direct'],
        reason: 'managed-cloud direct role binding',
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'personal_assistant',
      result: 'Second Brain overview:\n- Top tasks: Test',
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'personal_assistant_task',
          operation: 'read',
          summary: 'Reads the Second Brain overview.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'overview' },
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
    });

    expect(response.metadata?.responseSource).toMatchObject({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-direct',
      model: 'minimax-m2.1',
      providerTier: 'managed_cloud',
      usedFallback: false,
      notice: 'Handled directly by Second Brain.',
    });
  });

  it('reuses persisted paged-list continuation state for follow-up automation catalog requests', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-continuity.test.sqlite',
      retentionDays: 30,
      now: () => 1_710_000_000_000,
    });
    const automations = Array.from({ length: 45 }, (_, index) => {
      const ordinal = index + 1;
      return {
        id: `automation-${ordinal}`,
        name: `Automation ${ordinal}`,
        kind: 'assistant_task',
        enabled: true,
        task: {
          id: `automation-${ordinal}`,
          name: `Automation ${ordinal}`,
          type: 'agent',
          target: 'default',
          cron: `${ordinal % 60} 8 * * 1-5`,
          enabled: true,
          createdAt: ordinal,
        },
      };
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        if (toolName === 'automation_list') {
          return {
            success: true,
            output: { automations },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const firstMessage: UserMessage = {
      id: 'msg-1',
      userId: 'code-session:session-1',
      channel: 'web',
      content: 'List my automations.',
      timestamp: Date.now(),
    };
    const secondMessage: UserMessage = {
      id: 'msg-2',
      userId: 'code-session:session-1',
      channel: 'web',
      content: 'Can you list the additional 25 automations?',
      timestamp: Date.now(),
    };

    const automationDeps = buildDirectAutomationDeps(createDirectRuntimeDeps(tools));
    const firstResponse = await tryDirectAutomationControl(
      {
        message: firstMessage,
        ctx,
        userKey: 'owner:web',
        intentDecision: {
          route: 'automation_control',
          confidence: 'high',
          operation: 'read',
          turnRelation: 'new_request',
          resolution: 'ready',
          summary: 'List the automation catalog.',
          missingFields: [],
          entities: {},
        } as never,
        continuityThread: continuityThreadStore.get({ assistantId: 'chat', userId: 'owner' }),
      },
      automationDeps,
    );
    expect(firstResponse?.content).toContain('Automation catalog (45): showing 1-20');
    expect(firstResponse?.metadata?.continuationState).toEqual({
      kind: 'automation_catalog_list',
      payload: { offset: 0, limit: 20, total: 45 },
    });
    const secondResponse = await tryDirectAutomationControl(
      {
        message: secondMessage,
        ctx,
        userKey: 'owner:web',
        intentDecision: {
          route: 'automation_control',
          confidence: 'high',
          operation: 'read',
          turnRelation: 'follow_up',
          resolution: 'ready',
          summary: 'List more automations.',
          missingFields: [],
          entities: {},
        } as never,
        continuityThread: {
          continuityKey: 'chat:owner',
          scope: { assistantId: 'chat', userId: 'owner' },
          linkedSurfaces: [],
          continuationState: {
            kind: 'automation_catalog_list',
            payload: { offset: 0, limit: 20, total: 45 },
          },
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      },
      automationDeps,
    );

    expect(secondResponse?.content).toContain('Automation catalog (45): showing 21-45');
    expect(secondResponse?.content).toContain('Automation 25');
    expect(secondResponse?.content).toContain('Automation 1');
    expect(secondResponse?.content).not.toContain('Automation 45');
    expect(secondResponse?.metadata?.continuationState).toEqual({
      kind: 'automation_catalog_list',
      payload: { offset: 20, limit: 25, total: 45 },
    });
  });

  it('passes explicit direct continuation state to direct handlers even when fresh-turn chat context is isolated', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-direct-continuation-state.test.sqlite',
      retentionDays: 30,
    });
    const automations = Array.from({ length: 38 }, (_, index) => {
      const ordinal = index + 1;
      return {
        id: `automation-${ordinal}`,
        name: `Automation ${ordinal}`,
        kind: 'assistant_task',
        enabled: true,
        task: {
          id: `automation-${ordinal}`,
          name: `Automation ${ordinal}`,
          type: 'agent',
          target: 'default',
          cron: `${ordinal % 60} 8 * * 1-5`,
          enabled: true,
          createdAt: ordinal,
        },
      };
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        if (toolName === 'automation_list') {
          return {
            success: true,
            output: { automations },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      getApprovalSummaries: vi.fn(() => new Map()),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      continuityThreadStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const decision = (content: string): IntentGatewayRecord => ({
      mode: 'primary',
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'automation_control',
        confidence: 'low',
        operation: 'read',
        summary: 'List the automation catalog.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'tool_orchestration',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        entities: {},
      },
      rawResponsePreview: content,
    });

    const first = await agent.onMessage!({
      id: 'msg-automation-page-1',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'List my saved automations.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, decision('List my saved automations.')),
    }, ctx);
    expect((agent as any).getContinuityThread('owner')?.continuationState).toMatchObject({
      kind: 'automation_catalog_list',
      payload: { offset: 0, limit: 20, total: 38 },
    });
    const second = await agent.onMessage!({
      id: 'msg-automation-page-2',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Show the 18 more automations',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, decision('Show the 18 more automations')),
    }, ctx);

    expect(first.content).toContain('Automation catalog (38): showing 1-20');
    expect(second.content).toContain('Automation catalog (38): showing 21-38');
    expect(second.content).toContain('Automation 18');
    expect(second.content).not.toContain('Automation 19 [');
  });

  it('persists shared direct continuation state on the surface scope instead of the code-session scope', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const updateDirectContinuationState = vi
      .spyOn(agent as any, 'updateDirectContinuationState')
      .mockReturnValue(null);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-1',
      userId: 'code-session:session-1',
      channel: 'code-session',
      surfaceId: 'web-guardian-chat',
      content: 'List my automations.',
      timestamp: Date.now(),
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'automation_control',
      result: {
        content: 'Automation catalog (45): showing 1-20',
        metadata: {
          continuationState: {
            kind: 'automation_catalog_list',
            payload: { offset: 0, limit: 20, total: 45 },
          },
        },
      },
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'automation_control',
          operation: 'read',
          summary: 'List the automation catalog.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
      surfaceUserId: 'owner',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
    });

    expect(response.metadata?.continuationState).toBeUndefined();
    expect(updateDirectContinuationState).toHaveBeenCalledWith(
      'owner',
      'web',
      'web-guardian-chat',
      {
        kind: 'automation_catalog_list',
        payload: { offset: 0, limit: 20, total: 45 },
      },
    );
    expect(updateDirectContinuationState).not.toHaveBeenCalledWith(
      'code-session:session-1',
      'code-session',
      'web-guardian-chat',
      {
        kind: 'automation_catalog_list',
        payload: { offset: 0, limit: 20, total: 45 },
      },
    );
  });

  it('continues Gmail unread lists from the prior window on follow-up requests', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: Array.from({ length: 5 }, (_, index) => ({ id: `gmail-${index + 1}` })),
              resultSizeEstimate: 5,
            },
          };
        }
        if (args.method === 'get') {
          const params = args.params as Record<string, unknown>;
          const id = String(params.messageId ?? params.id);
          const ordinal = Number(id.split('-').pop() ?? '0');
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: `Sender ${ordinal} <sender${ordinal}@example.com>` },
                  { name: 'Subject', value: `Subject ${ordinal}` },
                  { name: 'Date', value: `2026-04-0${ordinal}T08:00:00Z` },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const mailboxDeps = buildDirectMailboxDeps(createDirectRuntimeDeps(tools));
    const response = await tryDirectGoogleWorkspaceRead(
      {
        message: {
          id: 'msg-gmail',
          userId: 'owner',
          channel: 'web',
          content: 'Show me the additional 2 emails.',
          timestamp: Date.now(),
        },
        ctx,
        userKey: 'owner:web',
        decision: {
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          turnRelation: 'follow_up',
          resolution: 'ready',
          summary: 'Show more unread Gmail messages.',
          missingFields: [],
          entities: { emailProvider: 'gmail' },
        } as never,
        continuityThread: {
          continuityKey: 'chat:owner',
          scope: { assistantId: 'chat', userId: 'owner' },
          linkedSurfaces: [],
          continuationState: {
            kind: 'gmail_unread_list',
            payload: { offset: 0, limit: 3, total: 5 },
          },
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      },
      mailboxDeps,
    );

    const content = typeof response === 'string' ? response : response?.content ?? '';
    expect(content).toContain('Subject 4');
    expect(content).toContain('Subject 5');
    expect(content).not.toContain('Subject 1');
    expect(content).not.toContain('Subject 2');
    expect(content).not.toContain('Subject 3');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.objectContaining({ maxResults: 5 }),
      }),
      expect.anything(),
    );
  });

  it('returns no additional Gmail messages when a natural follow-up exceeds the prior window', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: [{ id: 'gmail-1' }],
              resultSizeEstimate: 1,
            },
          };
        }
        if (args.method === 'get') {
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: 'Sender 1 <sender1@example.com>' },
                  { name: 'Subject', value: 'Subject 1' },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const mailboxDeps = buildDirectMailboxDeps(createDirectRuntimeDeps(tools));
    const response = await tryDirectGoogleWorkspaceRead(
      {
        message: {
          id: 'msg-gmail-2',
          userId: 'owner',
          channel: 'web',
          content: 'Show me 2 more emails.',
          timestamp: Date.now(),
        },
        ctx,
        userKey: 'owner:web',
        decision: {
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          turnRelation: 'new_request',
          resolution: 'ready',
          summary: 'Show more unread Gmail messages.',
          missingFields: [],
          entities: { emailProvider: 'gmail' },
        } as never,
        continuityThread: {
          continuityKey: 'chat:owner',
          scope: { assistantId: 'chat', userId: 'owner' },
          linkedSurfaces: [],
          continuationState: {
            kind: 'gmail_unread_list',
            payload: { offset: 0, limit: 1, total: 1 },
          },
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      },
      mailboxDeps,
    );

    expect(response).toBe('No additional Gmail messages remain.');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.objectContaining({ maxResults: 2 }),
      }),
      expect.anything(),
    );
  });

  it('uses the gateway mailbox read mode to list the latest Gmail inbox messages', async () => {
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: Array.from({ length: 5 }, (_, index) => ({ id: `gmail-latest-${index + 1}` })),
              resultSizeEstimate: 5,
            },
          };
        }
        if (args.method === 'get') {
          const params = args.params as Record<string, unknown>;
          const id = String(params.messageId ?? params.id);
          const ordinal = Number(id.split('-').pop() ?? '0');
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: `Sender ${ordinal} <sender${ordinal}@example.com>` },
                  { name: 'Subject', value: `Latest Subject ${ordinal}` },
                  { name: 'Date', value: `2026-04-0${ordinal}T08:00:00Z` },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const mailboxDeps = buildDirectMailboxDeps(createDirectRuntimeDeps(tools));
    const response = await tryDirectGoogleWorkspaceRead(
      {
        message: {
          id: 'msg-gmail-latest',
          userId: 'owner',
          channel: 'web',
          content: 'Can you show me the newest five emails in Gmail?',
          timestamp: Date.now(),
        },
        ctx,
        userKey: 'owner:web',
        decision: {
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          turnRelation: 'new_request',
          resolution: 'ready',
          summary: 'Shows the latest Gmail inbox messages.',
          missingFields: [],
          executionClass: 'provider_crud',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: { emailProvider: 'gws', mailboxReadMode: 'latest' },
        } as never,
        continuityThread: null,
      },
      mailboxDeps,
    );

    const content = typeof response === 'string' ? response : response?.content ?? '';
    expect(content).toContain('Here are the last 5 emails:');
    expect(content).toContain('Latest Subject 1');
    expect(content).toContain('Latest Subject 5');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.not.objectContaining({ q: 'is:unread' }),
      }),
      expect.anything(),
    );
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'get',
        params: expect.objectContaining({ messageId: 'gmail-latest-1' }),
      }),
      expect.anything(),
    );
  });

  it('formats direct Second Brain library reads as library items instead of falling back to overview', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listLinks: vi.fn(() => [{
        id: 'link-1',
        title: 'Example Reference',
        kind: 'reference',
        url: 'https://example.com/',
        summary: 'Library smoke test URL',
      }]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-library',
        userId: 'owner',
        channel: 'web',
        content: 'Show my library items.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads Second Brain library items.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Library items:');
    expect(content).toContain('Example Reference [reference] - https://example.com/');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('filters direct Second Brain library reads by a query derived from the user message', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const listLinks = vi.fn((filter?: Record<string, unknown>) => {
      expect(filter).toMatchObject({ limit: 8, query: 'Harbor' });
      return [{
        id: 'link-1',
        title: 'Harbor launch checklist',
        kind: 'reference',
        url: 'https://example.com/',
        summary: 'Reference for the Harbor launch review.',
      }];
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = { listLinks };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-library-query',
        userId: 'owner',
        channel: 'web',
        content: 'Show my library items about Harbor.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads library items related to Harbor.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Library items related to "Harbor":');
    expect(content).toContain('Harbor launch checklist [reference] - https://example.com/');
  });

  it('formats direct Second Brain brief reads as saved briefs instead of falling back to overview', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listBriefs: vi.fn(() => [{
        id: 'brief-1',
        kind: 'manual',
        title: 'Second Brain brief smoke test',
        content: 'This is a brief for smoke testing.',
        generatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      }]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-briefs',
        userId: 'owner',
        channel: 'web',
        content: 'Show my briefs.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads saved Second Brain briefs.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Saved briefs:');
    expect(content).toContain('Second Brain brief smoke test [Manual]');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('returns an explicit empty state for disabled Second Brain routine reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [{
        id: 'morning-brief',
        name: 'Morning Brief',
        category: 'scheduled',
        enabledByDefault: true,
        enabled: true,
        trigger: { mode: 'cron', cron: '0 7 * * *' },
        workloadClass: 'B',
        externalCommMode: 'none',
        budgetProfileId: 'daily-low',
        deliveryDefaults: ['web'],
        defaultRoutingBias: 'local_first',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      listRoutineCatalog: vi.fn(() => []),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-routines-disabled',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my disabled routines.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads disabled routines.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: false },
      },
    );

    expect(result).toBe('Second Brain has no disabled routines.');
  });

  it('filters direct Second Brain routines by topical query', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'morning-brief',
          name: 'Morning Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'cron', cron: '0 7 * * *' },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'local_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'morning-brief',
          name: 'Morning Brief',
          description: 'Creates the daily morning brief after the local workday starts.',
          category: 'daily',
          seedByDefault: true,
          manifest: {
            id: 'morning-brief',
            name: 'Morning Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'cron', cron: '0 7 * * *' },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'local_first',
          },
          configured: true,
          configuredRoutineId: 'morning-brief',
        },
      ]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-routines-email',
        userId: 'owner',
        channel: 'web',
        content: 'What routines are related to email or inbox processing?',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to email.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', query: 'email or inbox processing' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Second Brain routines related to "email inbox":');
    expect(content).toContain('Follow-Up Watch');
    expect(content).not.toContain('Morning Brief');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('filters direct Second Brain person reads to the requested quoted name', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const listPeople = vi.fn((filter?: Record<string, unknown>) => {
      expect(filter).toMatchObject({ limit: 6, query: 'Jordan Lee' });
      return [
        {
          id: 'person-1',
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          title: 'Design Lead',
          company: 'Harbor Labs',
        },
        {
          id: 'person-2',
          name: 'VentraIP Australia',
          email: 'noreply@ventraip.com.au',
        },
      ];
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = { listPeople };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-person-query',
        userId: 'owner',
        channel: 'web',
        content: 'Find the person "Jordan Lee" in my Second Brain.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads the requested person in Second Brain.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Contacts in Second Brain matching "Jordan Lee":');
    expect(content).toContain('Jordan Lee - jordan.lee@example.com · Design Lead · Harbor Labs');
    expect(content).not.toContain('VentraIP Australia');
  });

  it('keeps meeting prep routine retrieval scoped to the pre-meeting routine', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          defaultRoutingBias: 'quality_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web', 'telegram'],
            defaultRoutingBias: 'quality_first',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-routines-meeting-prep',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my enabled routines related to meeting prep.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to meeting prep.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: true, query: 'meeting prep' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Enabled Second Brain routines related to "meeting prep":');
    expect(content).toContain('Pre-Meeting Brief');
    expect(content).not.toContain('Follow-Up Watch');
  });

  it('keeps follow up routine retrieval scoped to follow-up routines', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'next-24-hours-radar',
          name: 'Next 24 Hours Radar',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
          workloadClass: 'A',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'local_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          defaultRoutingBias: 'quality_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'next-24-hours-radar',
          name: 'Next 24 Hours Radar',
          description: 'Marks the horizon scan when upcoming events or open tasks make the next day worth reviewing.',
          category: 'daily',
          seedByDefault: false,
          manifest: {
            id: 'next-24-hours-radar',
            name: 'Next 24 Hours Radar',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
            workloadClass: 'A',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'local_first',
          },
          configured: true,
          configuredRoutineId: 'next-24-hours-radar',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web', 'telegram'],
            defaultRoutingBias: 'quality_first',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-routines-follow-up',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my enabled routines related to follow up.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to follow up.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: true, query: 'follow up' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Enabled Second Brain routines related to "follow up":');
    expect(content).toContain('Follow-Up Watch');
    expect(content).not.toContain('Next 24 Hours Radar');
    expect(content).not.toContain('Pre-Meeting Brief');
  });

  it('returns routine focus metadata for direct Second Brain routine reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-routines-focus',
        userId: 'owner',
        channel: 'web',
        content: 'Show my routines.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads Second Brain routines.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toContain('Second Brain routines:');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
      },
    });
  });

  it('disables the focused Second Brain routine directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          enabled: false,
          defaultRoutingBias: 'balanced',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
      listRoutines: vi.fn(() => [
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      getRoutineById: vi.fn((id: string) => id === 'pre-meeting-brief'
        ? {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            enabled: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
            createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
            updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
            lastRunAt: null,
          }
        : null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-disable',
        userId: 'owner',
        channel: 'web',
        content: 'Disable that routine.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'toggle',
        confidence: 'high',
        summary: 'Disables the focused routine.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: false },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Routine updated: Pre-Meeting Brief');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
      },
    });
  });

  it('updates focused Second Brain routine settings directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          enabled: true,
          defaultRoutingBias: 'quality_first',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          trigger: {
            mode: 'event',
            eventType: 'upcoming_event',
            lookaheadMinutes: 90,
          },
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const routineRecord = {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      enabled: true,
      trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      lastRunAt: null,
    };
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => [routineRecord]),
      getRoutineById: vi.fn(() => routineRecord),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-settings',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to use the quality_first routing bias, deliver on web and telegram, and use a 90 minute lookahead window.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates routine settings.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Pre-Meeting Brief');
  });

  it('canonicalizes legacy routine event trigger values before lookahead updates', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          trigger: {
            mode: 'event',
            eventType: 'upcoming_event',
            lookaheadMinutes: 90,
          },
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const routineRecord = {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      enabled: true,
      trigger: { mode: 'event', eventType: 'upcoming-event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      lastRunAt: null,
    };
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => [routineRecord]),
      getRoutineById: vi.fn(() => routineRecord),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-legacy-lookahead',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to use a 90 minute lookahead window.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates routine lookahead.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Pre-Meeting Brief');
  });

  it('focuses the existing routine when create targets a routine that is already configured', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-existing',
        userId: 'owner',
        channel: 'web',
        content: 'Create the Pre-Meeting Brief routine in Second Brain.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a Second Brain routine.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Routine already exists: Pre-Meeting Brief');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
        items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
      },
    });
  });

  it('creates a topic watch routine from a natural-language notify request', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'topic-watch',
          config: { topicQuery: 'Harbor launch' },
        });
        return {
          success: true,
          output: {
            id: 'topic-watch:harbor-launch',
            name: 'Topic Watch: Harbor launch',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'topic-watch',
        name: 'Topic Watch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'background',
          label: 'Background check across the next 1440 minutes',
          editable: false,
          minutes: 1440,
        },
        supportedTiming: ['background'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: true,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-topic-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Second Brain routine to message me when anything mentions "Harbor launch".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a topic watch routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Topic Watch: Harbor launch');
  });

  it('creates a deadline watch routine from a natural-language notify request', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'deadline-watch',
          config: { dueWithinHours: 24 },
        });
        return {
          success: true,
          output: {
            id: 'deadline-watch:next-24-hours',
            name: 'Deadline Watch: next 24 hours',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'deadline-watch',
        name: 'Deadline Watch',
        description: 'Alerts you when open tasks enter a bounded due-soon window.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'background',
          label: 'Background check across the next 1440 minutes',
          editable: false,
          minutes: 1440,
        },
        supportedTiming: ['background'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: false,
        supportsDeadlineWindow: true,
      }]),
      listRoutines: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-deadline-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Second Brain routine to message me when I have something due tomorrow.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a deadline watch routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Deadline Watch: next 24 hours');
  });

  it('updates a topic watch routine query directly from chat', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'topic-watch:harbor-launch',
          name: 'Topic Watch: Harbor launch',
          config: { topicQuery: 'Board prep' },
          delivery: ['telegram'],
        });
        return {
          success: true,
          output: {
            id: 'topic-watch:harbor-launch',
            name: 'Topic Watch: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'topic-watch',
        name: 'Topic Watch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Daily at 8 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: true,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'topic-watch:harbor-launch',
        templateId: 'topic-watch',
        capability: 'topic_watch',
        name: 'Topic Watch: Harbor launch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Daily at 8 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '08:00' },
        },
        delivery: ['telegram'],
        topicQuery: 'Harbor launch',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-update-topic-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to watch "Board prep".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a topic watch routine.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'topic-watch:harbor-launch',
            items: [{ id: 'topic-watch:harbor-launch', label: 'Topic Watch: Harbor launch' }],
            byType: {
              routine: {
                focusId: 'topic-watch:harbor-launch',
                items: [{ id: 'topic-watch:harbor-launch', label: 'Topic Watch: Harbor launch' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Topic Watch: Board prep');
  });

  it('updates a scheduled routine timing from plain-English chat', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'morning-brief',
          name: 'Morning Brief',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'daily', time: '18:00' },
          },
          delivery: ['telegram', 'web'],
        });
        return {
          success: true,
          output: {
            id: 'morning-brief',
            name: 'Morning Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'morning-brief',
        name: 'Morning Brief',
        description: 'Prepare a morning brief with today’s events, open tasks, and recent context.',
        category: 'daily',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        configuredRoutineId: 'morning-brief',
        defaultTiming: {
          kind: 'scheduled',
          label: 'Daily at 7 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '07:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'morning-brief',
        templateId: 'morning-brief',
        capability: 'morning_brief',
        name: 'Morning Brief',
        description: 'Prepare a morning brief with today’s events, open tasks, and recent context.',
        category: 'daily',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Daily at 7 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '07:00' },
        },
        delivery: ['telegram', 'web'],
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-update-schedule',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to run daily at 6 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a routine schedule.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'morning-brief',
            items: [{ id: 'morning-brief', label: 'Morning Brief' }],
            byType: {
              routine: {
                focusId: 'morning-brief',
                items: [{ id: 'morning-brief', label: 'Morning Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Morning Brief');
  });

  it('creates a scoped weekly review routine from chat', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'weekly-review',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
          },
          config: { focusQuery: 'Board prep' },
        });
        return {
          success: true,
          output: {
            id: 'weekly-review:board-prep',
            name: 'Weekly Review: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'weekly-review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        configuredRoutineId: 'weekly-review',
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'weekly-review',
        templateId: 'weekly-review',
        capability: 'weekly_review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        delivery: ['telegram', 'web'],
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-scoped-weekly-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Weekly Review for Board prep every Monday at 9 am.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scoped weekly review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Weekly Review: Board prep');
  });

  it('creates a scheduled review routine from plain-language chat', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'scheduled-review',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'weekly', dayOfWeek: 'friday', time: '16:00' },
          },
          config: { focusQuery: 'Board prep' },
        });
        return {
          success: true,
          output: {
            id: 'scheduled-review:board-prep',
            name: 'Scheduled Review: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'scheduled-review',
        name: 'Scheduled Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 8 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-scheduled-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a review for Board prep every Friday at 4 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scheduled review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Scheduled Review: Board prep');
  });

  it('reuses an existing matching scheduled review instead of preparing a duplicate create', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => {
        throw new Error('duplicate create should not reach tool execution');
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'scheduled-review',
        name: 'Scheduled Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        seedByDefault: false,
        allowMultiple: true,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 8 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'scheduled-review:board-prep',
        templateId: 'scheduled-review',
        capability: 'scheduled_review',
        name: 'Friday Board Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        enabled: false,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Friday at 4 p.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'friday', time: '16:00' },
        },
        delivery: ['web', 'telegram'],
        focusQuery: 'Board prep',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      listRoutineRecords: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-create-duplicate-scheduled-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a review for Board prep every Friday at 4 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scheduled review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Routine already exists: Friday Board Review');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'scheduled-review:board-prep',
        items: [{ id: 'scheduled-review:board-prep', label: 'Friday Board Review' }],
      },
    });
  });

  it('updates a scoped routine focus from plain-language chat', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'weekly-review:board-prep',
          name: 'Weekly Review: Board prep',
          config: { focusQuery: 'Harbor launch' },
          delivery: ['telegram', 'web'],
        });
        return {
          success: true,
          output: {
            id: 'weekly-review:board-prep',
            name: 'Weekly Review: Harbor launch',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'weekly-review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'weekly-review:board-prep',
        templateId: 'weekly-review',
        capability: 'weekly_review',
        name: 'Weekly Review: Board prep',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        delivery: ['telegram', 'web'],
        focusQuery: 'Board prep',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-routine-update-scoped-focus',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to focus on Harbor launch.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a scoped routine focus.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'weekly-review:board-prep',
            items: [{ id: 'weekly-review:board-prep', label: 'Weekly Review: Board prep' }],
            byType: {
              routine: {
                focusId: 'weekly-review:board-prep',
                items: [{ id: 'weekly-review:board-prep', label: 'Weekly Review: Board prep' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Weekly Review: Harbor launch');
  });

  it('honors a gateway-provided calendar day window for direct Second Brain calendar reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const listEvents = vi.fn(() => [{
      id: 'event-1',
      title: 'Team Check-in',
      startsAt: Date.UTC(2026, 3, 10, 9, 30, 0),
      endsAt: null,
      location: 'Brisbane office',
      description: 'Team check-in at the Brisbane office.',
      source: 'local',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
    }]);
    (agent as any).secondBrainService = { listEvents };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 7, 8, 0, 0));

    try {
      const result = await tryAgentDirectSecondBrainRead(agent,
        {
          id: 'msg-calendar',
          userId: 'owner',
          channel: 'web',
          content: 'Show my calendar events for the next 7 days.',
          timestamp: Date.now(),
        },
        {
          route: 'personal_assistant_task',
          operation: 'read',
          confidence: 'high',
          summary: 'Reads calendar events for the next seven days.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'calendar', calendarWindowDays: 7 },
        },
      );

      const content = typeof result === 'string' ? result : result?.content ?? '';
      expect(content).toContain('Calendar events for the next 7 days:');
      expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({
        includePast: false,
        fromTime: Date.UTC(2026, 3, 7, 8, 0, 0),
        toTime: Date.UTC(2026, 3, 14, 8, 0, 0),
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('creates a titled local Second Brain note directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_note_upsert');
        expect(args).toMatchObject({
          title: 'Second Brain write smoke test note',
          content: 'Second Brain write smoke test note.',
          tags: ['harness', 'chat-crud'],
        });
        return {
          success: true,
          output: {
            id: 'note-create-1',
            title: 'Second Brain write smoke test note',
            content: 'Second Brain write smoke test note.',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-note-create',
        userId: 'owner',
        channel: 'web',
        content: 'Use Second Brain to create a note titled "Second Brain write smoke test note" with content "Second Brain write smoke test note." and tags harness, chat-crud.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local note.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Note created: Second Brain write smoke test note');
  });

  it('updates the focused Second Brain note directly instead of falling through to briefs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_note_upsert');
        expect(args).toMatchObject({
          id: 'note-2',
          title: 'Smoke Test Note Updated',
          content: 'Second Brain write smoke test note updated.',
        });
        return {
          success: true,
          output: {
            id: 'note-2',
            title: 'Smoke Test Note Updated',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-note-update',
        userId: 'owner',
        channel: 'web',
        content: 'Update the note titled "Smoke Test Note" so title becomes "Smoke Test Note Updated" and content becomes "Second Brain write smoke test note updated."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local note.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'note',
            focusId: 'note-2',
            items: [
              { id: 'note-1', label: 'Test' },
              { id: 'note-2', label: 'Smoke Test Note' },
            ],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Note updated: Smoke Test Note Updated');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'note',
        itemType: 'note',
        focusId: 'note-2',
        items: [{ id: 'note-2', label: 'Smoke Test Note Updated' }],
      },
    });
  });

  it('creates a local Second Brain brief directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_brief_upsert');
        expect(args).toMatchObject({
          kind: 'manual',
          title: 'Second Brain brief smoke test',
          content: 'This is a brief for smoke testing.',
        });
        return {
          success: true,
          output: {
            id: 'brief-1',
            title: 'Second Brain brief smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-brief-create',
        userId: 'owner',
        channel: 'web',
        content: 'Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local brief.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Brief created: Second Brain brief smoke test');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'brief',
        itemType: 'brief',
        focusId: 'brief-1',
      },
    });
  });

  it('generates a morning Second Brain brief directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_generate_brief');
        expect(args).toMatchObject({ kind: 'morning' });
        return {
          success: true,
          output: {
            id: 'brief-morning-1',
            title: 'Morning Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-brief-generate',
        userId: 'owner',
        channel: 'web',
        content: 'Generate a morning brief in Second Brain.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Generates a morning brief.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
    );

    expect((result as { content: string }).content).toBe('Brief created: Morning Brief');
  });

  it('updates a focused generated Second Brain brief directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_brief_update');
        expect(args).toMatchObject({
          id: 'brief-morning-1',
          title: 'Morning Brief Updated',
          content: 'Existing morning brief content.\n\nAppended line from chat.',
        });
        return {
          success: true,
          output: {
            id: 'brief-morning-1',
            title: 'Morning Brief Updated',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getBriefById: vi.fn(() => ({
        id: 'brief-morning-1',
        kind: 'morning',
        title: 'Morning Brief',
        content: 'Existing morning brief content.',
        generatedAt: Date.UTC(2026, 3, 7, 8, 0, 0),
        createdAt: Date.UTC(2026, 3, 7, 8, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 8, 0, 0),
      })),
      listBriefs: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-brief-update',
        userId: 'owner',
        channel: 'web',
        content: 'Update the latest morning brief in Second Brain so the title becomes "Morning Brief Updated" and append "Appended line from chat." to the content.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a morning brief.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'brief',
            focusId: 'brief-morning-1',
            items: [{ id: 'brief-morning-1', label: 'Morning Brief' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Brief updated: Morning Brief Updated');
  });

  it('creates a local Second Brain person directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          name: 'Smoke Test Person',
          email: 'smoke@example.com',
        });
        return {
          success: true,
          output: {
            id: 'person-1',
            name: 'Smoke Test Person',
            title: 'Design Lead',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-create',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain named "Smoke Test Person" with email "smoke@example.com".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Smoke Test Person');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'person',
        itemType: 'person',
        focusId: 'person-1',
      },
    });
  });

  it('creates a local Second Brain person from loose unquoted phrasing with long whitespace', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          name: 'Angela Lee',
          phone: '0887 895 687',
        });
        return {
          success: true,
          output: {
            id: 'person-2',
            name: 'Angela Lee',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const longWhitespace = ' '.repeat(2048);

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-create-unquoted',
        userId: 'owner',
        channel: 'web',
        content: `Create a contact in my Second Brain${longWhitespace}Angela Lee ... phone number 0887 895 687`,
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Angela Lee');
  });

  it('creates a local Second Brain person with structured phone and location fields', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          phone: '+61 409 555 111',
          location: 'Brisbane',
          title: 'Design Lead',
          company: 'Harbor Labs',
        });
        return {
          success: true,
          output: {
            id: 'person-structured',
            name: 'Jordan Lee',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-create-structured',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain named "Jordan Lee" with email "jordan.lee@example.com", phone "+61 409 555 111", title "Design Lead", company "Harbor Labs", and location "Brisbane".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Jordan Lee');
  });

  it('creates a local Second Brain person directly from pasted multiline fields', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          title: 'Design Lead',
          company: 'Harbor Labs',
          notes: 'Owner for the Harbor launch review.',
        });
        return {
          success: true,
          output: {
            id: 'person-multiline',
            name: 'Jordan Lee',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain named "Jordan Lee" with  \n  email "jordan.lee@example.com", title "Design Lead", company   \n  "Harbor Labs", and notes "Owner for the Harbor launch review."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Jordan Lee');
  });

  it('creates a clarification pending action when person create is missing both name and email', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-pending-actions.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-create-missing',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain.',
        surfaceId: 'owner',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('To create a local contact, I need at least a name or email address.');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.pendingAction).toMatchObject({
      blocker: {
        kind: 'clarification',
        field: 'person_identity',
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'create',
      },
    });
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('creates a local Second Brain library item directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_library_upsert');
        expect(args).toMatchObject({
          title: 'Harbor launch checklist',
          url: 'C:\\Temp\\harbor-launch-checklist.md',
          summary: 'Reference for the Harbor launch review.',
          tags: ['harness', 'chat-crud'],
          kind: 'file',
        });
        return {
          success: true,
          output: {
            id: 'link-1',
            title: 'Harbor launch checklist',
            url: 'https://example.com/',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getLinkById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-library-create',
        userId: 'owner',
        channel: 'web',
        content: 'Save a Second Brain library item titled "Harbor launch checklist" pointing to "C:\\Temp\\harbor-launch-checklist.md" as a file reference with summary "Reference for the Harbor launch review." and tags harness, chat-crud.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local library item.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Library item created: Harbor launch checklist');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'library',
        itemType: 'library',
        focusId: 'link-1',
      },
    });
  });

  it('creates a local Second Brain library item directly from pasted multiline fields with a wrapped title fragment', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_library_upsert');
        expect(args).toMatchObject({
          title: 'Harbor launch checklist',
          url: 'https://example.com',
          summary: 'Reference for the Harbor launch review.',
        });
        return {
          success: true,
          output: {
            id: 'link-multiline',
            title: 'Harbor launch checklist',
            url: 'https://example.com/',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getLinkById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-library-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Save this link in my library with title "Harbor launch chec \n  klist", url "https://example.com", and notes "Reference for the\nHarbor launch review."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local library item.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Library item created: Harbor launch checklist');
  });

  it('updates the focused Second Brain person directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          id: 'person-1',
          name: 'Smoke Test Person',
          email: 'smoke@example.com',
        });
        return {
          success: true,
          output: {
            id: 'person-1',
            name: 'Smoke Test Person',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => ({
        id: 'person-1',
        name: 'Smoke Test Person',
        relationship: 'other',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-person-update',
        userId: 'owner',
        channel: 'web',
        content: 'Update that person to include email "smoke@example.com".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local contact.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'person',
            focusId: 'person-1',
            items: [{ id: 'person-1', label: 'Smoke Test Person' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact updated: Smoke Test Person');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'person',
        itemType: 'person',
        focusId: 'person-1',
      },
    });
  });

  it('preserves the focused Second Brain note across note list reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listNotes: vi.fn(() => [
        {
          id: 'note-1',
          title: 'Test',
          content: 'Testicles',
        },
        {
          id: 'note-2',
          title: 'Smoke Test Note',
          content: 'Second Brain write smoke test note.',
        },
      ]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-notes',
        userId: 'owner',
        channel: 'web',
        content: 'Show my notes.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads recent notes.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'note',
            focusId: 'note-2',
            items: [{ id: 'note-2', label: 'Smoke Test Note' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toContain('Recent notes:');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'note',
        itemType: 'note',
        focusId: 'note-2',
        items: [
          { id: 'note-1', label: 'Test' },
          { id: 'note-2', label: 'Smoke Test Note' },
        ],
      },
    });
  });

  it('creates a local Second Brain task directly from a pasted multiline prompt', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_task_upsert');
        expect(args).toMatchObject({
          title: 'Send Harbor launch review deck',
          details: 'Initial launch review task details.',
          priority: 'high',
          dueAt: expect.any(Number),
        });
        return {
          success: true,
          output: {
            id: 'task-created',
            title: 'Send Harbor launch review deck',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-task-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Create a task called "Send Harbor launch review deck" with details "Initial launch review task details.", high priority, due   \n  April 9, 2026 at 4 PM.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local task.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'task' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Task created: Send Harbor launch review deck');
  });

  it('marks the focused Second Brain task done directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          id: 'task-1',
          title: 'Second Brain task smoke test',
          status: 'done',
        });
        return {
          success: true,
          output: {
            id: 'task-1',
            title: 'Second Brain task smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => ({
        id: 'task-1',
        title: 'Second Brain task smoke test',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 8, 15, 0, 0),
        status: 'todo',
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-task-done',
        userId: 'owner',
        channel: 'web',
        content: 'Mark that task as done.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Completes a local task.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'task' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'task',
            focusId: 'task-1',
            items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Task completed: Second Brain task smoke test');
  });

  it('stores a Second Brain mutation descriptor instead of replay args for focused task approvals', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          id: 'task-1',
          title: 'Send Harbor launch review deck and notes',
          status: 'todo',
          priority: 'medium',
          dueAt: Date.UTC(2026, 3, 9, 6, 0, 0),
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
        };
      }),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-task-rename-pending.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => ({
        id: 'task-1',
        title: 'Send Harbor launch review deck',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 9, 6, 0, 0),
        status: 'todo',
      })),
    };
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-task-rename',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'Rename the task "Send Harbor launch review deck" to "Send   \n  Harbor launch review deck and notes".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local task.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'task' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'task',
            focusId: 'task-1',
            items: [{ id: 'task-1', label: 'Send Harbor launch review deck' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume).toBeUndefined();
    expect(pending?.intent.entities).toMatchObject({
      secondBrainMutationApproval: {
        itemType: 'task',
        action: 'update',
      },
    });
  });

  it('reconciles stale approval blockers before reusing them in later turns', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-stale-approvals.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const created = pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the calendar update.',
        approvalIds: ['approval-stale-1'],
        approvalSummaries: [
          { id: 'approval-stale-1', toolName: 'second_brain_calendar_upsert', argsPreview: '{"title":"Harbor launch review"}' },
        ],
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'update',
        originalUserContent: 'Move that calendar event to tomorrow at 2 PM.',
      },
      expiresAt: 1_710_000_000_000 + 30 * 60 * 1000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;

    const pendingIds = (agent as any).getPendingApprovalIds('owner', 'telegram', 'telegram-chat', 1_710_000_000_000);

    expect(pendingIds).toEqual([]);
    expect(pendingActionStore.get(created.id)?.status).toBe('completed');
  });

  it('answers approval-status queries from live approval state instead of stale pending-action text', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(),
    };
    const futureBase = Date.now();
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-approval-status.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const created = pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the file write.',
        approvalIds: ['approval-stale-1'],
        approvalSummaries: [
          { id: 'approval-stale-1', toolName: 'fs_write', argsPreview: '{"path":"S:\\\\Development\\\\test.txt"}' },
        ],
      },
      intent: {
        route: 'filesystem_task',
        operation: 'create',
        originalUserContent: 'Create a file in S:\\Development.',
      },
      expiresAt: futureBase + 30 * 60 * 1000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await agent.onMessage!({
      id: 'msg-approval-status',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
      content: 'What pending approvals do I have right now?',
      timestamp: futureBase,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        mode: 'primary',
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'general_assistant',
          operation: 'inspect',
          summary: 'General status question.',
          confidence: 'low',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          entities: {},
        },
      }),
    }, ctx);

    expect(response.content).toBe('There are no pending approvals.');
    expect(pendingActionStore.get(created.id)?.status).toBe('completed');
  });

  it('answers exact approval-status queries before attached coding-session routing', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await agent.onMessage!({
      id: 'msg-exact-approval-status',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'pending approvals?',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        mode: 'primary',
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_task',
          operation: 'inspect',
          summary: 'Attached coding-session routing selected by stale continuity.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'tools',
          entities: {},
        },
      }),
    }, ctx);

    expect(response.content).toBe('There are no pending approvals.');
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('creates a local Second Brain calendar event with place and description directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 7, 8, 0, 0));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_calendar_upsert');
        expect(args).toMatchObject({
          title: 'Second Brain calendar smoke test',
          location: 'Desk',
          description: 'Local calendar write smoke test event.',
          startsAt: expect.any(Number),
          endsAt: expect.any(Number),
        });
        return {
          success: true,
          output: {
            id: 'event-created',
            title: 'Second Brain calendar smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getEventById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    try {
      const result = await tryAgentDirectSecondBrainWrite(agent,
        {
          id: 'msg-event-create',
          userId: 'owner',
          channel: 'web',
          content: 'Using the local Guardian calendar in Second Brain, create an event titled "Second Brain calendar smoke test" on April 9, 2026 at 10 AM through April 9, 2026 at 11 AM at "Desk" with description "Local calendar write smoke test event.".',
          timestamp: Date.now(),
        },
        ctx,
        'owner:web',
        {
          route: 'personal_assistant_task',
          operation: 'create',
          confidence: 'high',
          summary: 'Creates a local calendar event.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'calendar', calendarTarget: 'local' },
        },
      );

      expect((result as { content: string }).content).toBe('Calendar event created: Second Brain calendar smoke test');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('moves the focused local calendar event directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 7, 8, 0, 0));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args.id).toBe('event-1');
        expect(args.title).toBe('Second Brain calendar smoke test updated');
        expect(args.location).toBe('War Room');
        expect(args.description).toBe('Updated calendar smoke test event.');
        expect(args.startsAt).toBe(1775631600000); // Or the correct expected value based on the test

        return {
          success: true,
          output: {
            id: 'event-1',
            title: 'Second Brain calendar smoke test updated',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getEventById: vi.fn(() => ({
        id: 'event-1',
        title: 'Second Brain calendar smoke test',
        startsAt: Date.UTC(2026, 3, 8, 16, 0, 0),
        endsAt: Date.UTC(2026, 3, 8, 17, 0, 0),
        source: 'local',
        createdAt: Date.UTC(2026, 3, 7, 8, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 8, 0, 0),
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    try {
      const result = await tryAgentDirectSecondBrainWrite(agent,
        {
          id: 'msg-event-move',
          userId: 'owner',
          channel: 'web',
          content: 'Move that event to tomorrow at 5:00 PM, the title becomes "Second Brain calendar smoke test updated", the location becomes "War Room", and the description becomes "Updated calendar smoke test event.".',
          timestamp: Date.now(),
        },
        ctx,
        'owner:web',
        {
          route: 'personal_assistant_task',
          operation: 'update',
          confidence: 'high',
          summary: 'Moves a local event.',
          turnRelation: 'follow_up',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'calendar', calendarTarget: 'local' },
        },
        {
          continuityKey: 'chat:owner',
          scope: { assistantId: 'chat', userId: 'owner' },
          linkedSurfaces: [],
          continuationState: {
            kind: 'second_brain_focus',
            payload: {
              itemType: 'calendar',
              focusId: 'event-1',
              items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
            },
          },
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      );

      expect((result as { content: string }).content).toBe('Calendar event updated: Second Brain calendar smoke test updated');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('infers the active Second Brain item type for follow-up task reads when the gateway omits it', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listTasks: vi.fn(() => [{
        id: 'task-1',
        title: 'Second Brain task smoke test',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 8, 15, 0, 0),
        status: 'todo',
      }]),
    };

    const result = await tryAgentDirectSecondBrainRead(agent,
      {
        id: 'msg-task-read-follow-up',
        userId: 'owner',
        channel: 'web',
        content: 'Show my tasks again.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads the same local task list again.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'task',
            itemType: 'task',
            focusId: 'task-1',
            items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
            byType: {
              task: {
                focusId: 'task-1',
                items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toContain('Open tasks:');
    expect((result as { content: string }).content).toContain('Second Brain task smoke test');
  });

  it('keeps note focus available after later calendar activity for note deletion follow-ups', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_note_delete');
        expect(args).toEqual({ id: 'note-2' });
        return {
          success: true,
          output: {
            id: 'note-2',
            title: 'Smoke Test Note',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await tryAgentDirectSecondBrainWrite(agent,
      {
        id: 'msg-note-delete',
        userId: 'owner',
        channel: 'web',
        content: 'Delete that note.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'delete',
        confidence: 'high',
        summary: 'Deletes the previously focused note.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'calendar',
            itemType: 'calendar',
            focusId: 'event-1',
            items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
            byType: {
              note: {
                focusId: 'note-2',
                items: [{ id: 'note-2', label: 'Smoke Test Note' }],
              },
              calendar: {
                focusId: 'event-1',
                items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Note deleted: Smoke Test Note');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'calendar',
        itemType: 'calendar',
        focusId: 'event-1',
      },
    });
  });

  it('resumes direct Second Brain mutations after approval and persists the focused item', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-second-brain-approval.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-second-brain-focus.test.sqlite',
      retentionDays: 30,
      now: () => 1_710_000_000_000,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
      decideApproval: vi.fn(async () => ({
        success: true,
        approved: true,
        executionSucceeded: true,
        message: "Tool 'second_brain_note_upsert' completed.",
        job: {
          id: 'job-second-brain-1',
          toolName: 'second_brain_note_upsert',
          risk: 'mutating',
          origin: 'assistant',
          argsPreview: '{"title":"Smoke Test Note"}',
          status: 'succeeded',
          createdAt: 1,
          requiresApproval: true,
        },
        result: {
          success: true,
          status: 'succeeded',
          message: "Tool 'second_brain_note_upsert' completed.",
          output: {
            id: 'note-2',
            title: 'Smoke Test Note',
          },
        },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
      listPendingApprovalIdsForUser: vi.fn(() => ['approval-1']),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pendingActionStore,
      continuityThreadStore,
    );
    const updateDirectContinuationState = vi.spyOn(agent as any, 'updateDirectContinuationState');

    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve note save',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'create',
        originalUserContent: 'Create a note that says: "Second Brain write smoke test note."',
        entities: {
          secondBrainMutationApproval: {
            itemType: 'note',
            action: 'create',
          },
        },
      },
      expiresAt: Date.now() + 60_000,
    });

    const result = await (agent as any).tryHandleApproval(
      {
        id: 'msg-approve-second-brain-1',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'yes',
        timestamp: Date.now(),
      },
      {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
    );

    expect(result?.content).toBe('Note created: Smoke Test Note');
    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(updateDirectContinuationState).toHaveBeenCalledWith(
      'owner',
      'web',
      'owner',
      expect.objectContaining({
        kind: 'second_brain_focus',
        payload: expect.objectContaining({
          activeItemType: 'note',
          itemType: 'note',
          focusId: 'note-2',
        }),
      }),
    );
  });

  it('formats direct Second Brain approval results for dashboard approval decisions', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-second-brain-dashboard-approval.test.sqlite',
      retentionDays: 30,
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      continuityThreadStore,
    );
    const pendingAction: PendingActionRecord = {
      id: 'pending-second-brain-dashboard-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve note save',
        approvalIds: ['approval-dashboard-1'],
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'create',
        originalUserContent: 'Create a note that says: "Second Brain dashboard approval smoke test note."',
        entities: {
          secondBrainMutationApproval: {
            itemType: 'note',
            action: 'create',
          },
        },
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };
    const updateDirectContinuationState = vi.spyOn(agent as any, 'updateDirectContinuationState');

    const result = agent.formatApprovalDecisionResultResponse(
      pendingAction,
      {
        success: true,
        approved: true,
        executionSucceeded: true,
        message: "Tool 'second_brain_note_upsert' completed.",
        job: {
          id: 'job-second-brain-dashboard-1',
          toolName: 'second_brain_note_upsert',
          risk: 'mutating',
          origin: 'assistant',
          argsPreview: '{"title":"Smoke Test Note"}',
          status: 'succeeded',
          createdAt: 1,
          requiresApproval: true,
        },
        result: {
          success: true,
          status: 'succeeded',
          message: "Tool 'second_brain_note_upsert' completed.",
          output: {
            id: 'note-dashboard-1',
            title: 'Dashboard Smoke Test Note',
          },
        },
      },
      {
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
    );

    expect(result?.content).toBe('Note created: Dashboard Smoke Test Note');
    expect(updateDirectContinuationState).toHaveBeenCalledWith(
      'owner',
      'web',
      'owner',
      expect.objectContaining({
        kind: 'second_brain_focus',
        payload: expect.objectContaining({
          activeItemType: 'note',
          itemType: 'note',
          focusId: 'note-dashboard-1',
        }),
      }),
    );
  });

  it('resumes approved coding-backend runs with backend response-source metadata', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      decideApproval: vi.fn(async () => ({
        success: true,
        approved: true,
        executionSucceeded: true,
        message: "Tool 'coding_backend_run' completed.",
        job: {
          id: 'job-coding-backend-1',
          toolName: 'coding_backend_run',
          risk: 'mutating',
          origin: 'assistant',
          codeSessionId: 'session-coding-backend-1',
          argsPreview: '{"backend":"codex"}',
          argsRedacted: { backend: 'codex' },
          status: 'succeeded',
          createdAt: 1,
          requiresApproval: true,
        },
        result: {
          success: true,
          status: 'succeeded',
          output: {
            success: true,
            backendId: 'codex',
            backendName: 'OpenAI Codex CLI',
            assistantResponse: 'This repo is GuardianAgent.',
            output: 'OpenAI Codex CLI completed.',
            codeSessionId: 'session-coding-backend-1',
            durationMs: 1250,
          },
        },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
      listPendingApprovalIdsForUser: vi.fn(() => ['approval-coding-backend-1']),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-coding-backend-approval-result.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pendingActionStore,
    );
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the Codex run.',
        approvalIds: ['approval-coding-backend-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'inspect',
        originalUserContent: 'Use Codex in this coding workspace to inspect README.md and package.json.',
      },
      codeSessionId: 'session-coding-backend-1',
      expiresAt: Date.now() + 60_000,
    });

    const result = await (agent as any).tryHandleApproval(
      {
        id: 'msg-approve-coding-backend-1',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
        content: 'yes',
        timestamp: Date.now(),
      },
      {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
    );

    expect(result?.content).toBe('This repo is GuardianAgent.');
    expect(result?.metadata).toMatchObject({
      codingBackendDelegated: true,
      codingBackendId: 'codex',
      codeSessionResolved: true,
      codeSessionId: 'session-coding-backend-1',
      responseSource: {
        locality: 'local',
        providerName: 'OpenAI Codex CLI',
        providerTier: 'local',
        usedFallback: false,
        durationMs: 1250,
      },
    });
  });

  it('surfaces failed approved coding-backend runs as execution failures rather than approval denials', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      decideApproval: vi.fn(async () => ({
        success: true,
        approved: true,
        executionSucceeded: false,
        message: "Approval received for 'coding_backend_run', but execution failed: Claude Code could not complete the requested task.",
        job: {
          id: 'job-coding-backend-failure-1',
          toolName: 'coding_backend_run',
          risk: 'mutating',
          origin: 'assistant',
          codeSessionId: 'session-coding-backend-failure-1',
          argsPreview: '{"backend":"claude-code"}',
          argsRedacted: { backend: 'claude-code' },
          status: 'failed',
          createdAt: 1,
          requiresApproval: true,
        },
        result: {
          success: false,
          status: 'failed',
          message: 'Claude Code could not complete the requested task.',
          error: 'Claude Code could not complete the requested task.',
          output: {
            success: false,
            backendId: 'claude-code',
            backendName: 'Claude Code',
            output: 'Claude Code could not complete the requested task.',
            codeSessionId: 'session-coding-backend-failure-1',
            durationMs: 875,
          },
        },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
      listPendingApprovalIdsForUser: vi.fn(() => ['approval-coding-backend-failure-1']),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-coding-backend-approval-failure-result.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pendingActionStore,
    );
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the Claude Code run.',
        approvalIds: ['approval-coding-backend-failure-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'inspect',
        originalUserContent: 'Use Claude Code in this coding workspace to inspect README.md and package.json.',
      },
      codeSessionId: 'session-coding-backend-failure-1',
      expiresAt: Date.now() + 60_000,
    });

    const result = await (agent as any).tryHandleApproval(
      {
        id: 'msg-approve-coding-backend-failure-1',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
        content: 'yes',
        timestamp: Date.now(),
      },
      {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
    );

    expect(result?.content).toBe('Claude Code could not complete the requested task.');
    expect(result?.content).not.toContain('was not approved');
    expect(result?.metadata).toMatchObject({
      codingBackendDelegated: true,
      codingBackendId: 'claude-code',
      codeSessionResolved: true,
      codeSessionId: 'session-coding-backend-failure-1',
      responseSource: {
        locality: 'local',
        providerName: 'Claude Code',
        providerTier: 'local',
        usedFallback: false,
        durationMs: 875,
      },
    });
  });

  it('stores graph-backed tool-loop continuation state for approval-blocked remote sandbox runs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-remote-tool-loop.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const executionGraphStore = new ExecutionGraphStore();
    const llm = {
      name: 'ollama_cloud',
      chat: vi.fn(async () => ({
        content: '',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
          },
        ],
        model: 'gpt-oss:120b',
        finishReason: 'tool_calls',
      })),
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      getRuntimeNotices: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async () => ({
        success: false,
        status: 'pending_approval',
        approvalId: 'approval-1',
        jobId: 'job-1',
        message: 'Approval required.',
      })),
      getApprovalSummaries: vi.fn(() => new Map([
        ['approval-1', {
          toolName: 'code_remote_exec',
          argsPreview: '{"command":"npm ci","profile":"Daytona"}',
          actionLabel: 'run npm ci remotely',
        }],
      ])),
      listPendingApprovalIdsForUser: vi.fn(() => []),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;
    (agent as any).executionGraphStore = executionGraphStore;

    const response = await agent.onMessage({
      id: 'msg-remote-pending',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      content: 'In the Guardian workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.',
      timestamp: 1_710_000_000_000,
      metadata: attachSelectedExecutionProfileMetadata(
        attachPreRoutedIntentGatewayMetadata(
          {
            codeContext: {
              workspaceRoot: '/repo',
              sessionId: 'session-123',
            },
          },
          {
            available: true,
            mode: 'primary',
            model: 'test-model',
            latencyMs: 1,
            decision: {
              route: 'coding_task',
              operation: 'run',
              summary: 'Run repo commands in the remote sandbox.',
              confidence: 'high',
              turnRelation: 'new_request',
              resolution: 'ready',
              missingFields: [],
              executionClass: 'repo_grounded',
              preferredTier: 'external',
              requiresRepoGrounding: true,
              requiresToolSynthesis: true,
              expectedContextPressure: 'medium',
              preferredAnswerPath: 'tool_loop',
              entities: {
                codingRemoteExecRequested: true,
                profileId: 'Daytona',
              },
            },
          },
        ),
        {
          id: 'managed_cloud_tool',
          providerName: 'ollama-cloud-coding',
          providerType: 'ollama_cloud',
          providerModel: 'gpt-oss:120b',
          providerLocality: 'external',
          providerTier: 'managed_cloud',
          requestedTier: 'external',
          preferredAnswerPath: 'tool_loop',
          expectedContextPressure: 'medium',
          contextBudget: 80000,
          toolContextMode: 'tight',
          maxAdditionalSections: 2,
          maxRuntimeNotices: 2,
          fallbackProviderOrder: ['ollama-cloud-coding'],
          reason: 'coding profile',
        },
      ),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: llm as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.metadata?.pendingAction).toBeTruthy();
    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume?.kind).toBe('execution_graph');
    const artifactId = pending?.graphInterrupt?.artifactRefs[0]?.artifactId;
    expect(artifactId).toBeTruthy();
    expect(executionGraphStore.getArtifact(pending!.graphInterrupt!.graphId, artifactId!)).toMatchObject({
      artifactType: 'ChatContinuation',
      content: {
        payload: {
          type: 'suspended_tool_loop',
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'session-123',
          },
          selectedExecutionProfile: {
            providerName: 'ollama-cloud-coding',
          },
          pendingTools: [
            {
              approvalId: 'approval-1',
              toolCallId: 'tool-call-1',
              jobId: 'job-1',
              name: 'code_remote_exec',
            },
          ],
        },
      },
    });
  });

  it('resumes approval-blocked remote tool loops with the stored code session context', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listJobs: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>, request: Record<string, unknown>) => {
        expect(args).toMatchObject({
          command: 'npm test',
          profile: 'Daytona',
        });
        expect(request.codeContext).toMatchObject({
          workspaceRoot: '/repo',
          sessionId: 'session-123',
        });
        return {
          success: true,
          output: {
            stdout: 'tests ok',
            stderr: '',
          },
        };
      }),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).fallbackChain = {
      chatWithProviderOrder: vi.fn()
        .mockResolvedValueOnce({
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: '',
            toolCalls: [
              {
                id: 'tool-call-2',
                name: 'code_remote_exec',
                arguments: JSON.stringify({ command: 'npm test' }),
              },
            ],
            model: 'gpt-oss:120b',
            finishReason: 'tool_calls',
          },
        })
        .mockResolvedValueOnce({
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: 'Remote sandbox sequence completed.',
            toolCalls: [],
            model: 'gpt-oss:120b',
            finishReason: 'stop',
          },
        }),
    };

    const selectedExecutionProfile = {
      id: 'managed_cloud_tool' as const,
      providerName: 'ollama-cloud-coding',
      providerType: 'ollama_cloud',
      providerModel: 'gpt-oss:120b',
      providerLocality: 'external' as const,
      providerTier: 'managed_cloud' as const,
      requestedTier: 'external' as const,
      preferredAnswerPath: 'tool_loop' as const,
      expectedContextPressure: 'medium' as const,
      contextBudget: 80000,
      toolContextMode: 'tight' as const,
      maxAdditionalSections: 2,
      maxRuntimeNotices: 2,
      fallbackProviderOrder: ['ollama-cloud-coding'],
      reason: 'coding profile',
    };
    const originalMetadata = attachSelectedExecutionProfileMetadata({
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      },
    }, selectedExecutionProfile);
    const executionGraphStore = new ExecutionGraphStore();
    const pendingActionStore = new PendingActionStore({ enabled: false, sqlitePath: ':memory:' });
    (agent as any).executionGraphStore = executionGraphStore;
    (agent as any).pendingActionStore = pendingActionStore;
    const pendingAction = createToolLoopGraphPendingAction({
      executionGraphStore,
      pendingActionStore,
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      requestId: 'msg-remote-1',
      prompt: 'Approve remote execution.',
      approvalId: 'approval-1',
      originalUserContent: 'Run npm ci and then npm test in the same remote sandbox.',
      route: 'coding_task',
      operation: 'run',
      codeSessionId: 'session-123',
      continuation: buildToolLoopContinuationPayload({
        llmMessages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'Run npm ci and then npm test in the same remote sandbox.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tool-call-1',
                name: 'code_remote_exec',
                arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
              },
            ],
          },
        ],
        pendingTools: [
          {
            approvalId: 'approval-1',
            toolCallId: 'tool-call-1',
            jobId: 'job-1',
            name: 'code_remote_exec',
          },
        ],
        originalMessage: {
          id: 'msg-remote-1',
          userId: 'owner',
          channel: 'web',
          surfaceId: 'owner',
          principalId: 'owner',
          principalRole: 'owner',
          content: 'Run npm ci and then npm test in the same remote sandbox.',
          timestamp: 1_710_000_000_000,
          metadata: originalMetadata,
        },
        requestText: 'Run npm ci and then npm test in the same remote sandbox.',
        referenceTime: 1_710_000_000_000,
        allowModelMemoryMutation: false,
        activeSkillIds: [],
        contentTrustLevel: 'trusted',
        taintReasons: [],
        intentDecision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Run remote sandbox commands.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingRemoteExecRequested: true,
            profileId: 'Daytona',
          },
        },
        codeContext: {
          workspaceRoot: '/repo',
          sessionId: 'session-123',
        },
        selectedExecutionProfile,
      }),
    });

    const result = await (agent as any).continuePendingActionAfterApproval(
      pendingAction,
      'approval-1',
      'approved',
      {
        success: true,
        approved: true,
        executionSucceeded: true,
        message: "Tool 'code_remote_exec' completed.",
        result: {
          success: true,
          status: 'succeeded',
          output: {
            stdout: 'installed',
            stderr: '',
            leaseId: 'lease-1',
            sandboxId: 'sandbox-1',
          },
        },
      },
    );

    expect(result?.content).toBe('Remote sandbox sequence completed.');
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
  });

  it('suspends a multi-step remote sandbox turn with only the first remote step pending approval', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-remote-sequencing.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const executionGraphStore = new ExecutionGraphStore();
    const llm = {
      name: 'ollama_cloud',
      chat: vi.fn(async () => ({
        content: '',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm ci' }),
          },
          {
            id: 'tool-call-2',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm test' }),
          },
        ],
        model: 'gpt-oss:120b',
        finishReason: 'tool_calls',
      })),
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      getRuntimeNotices: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          command: 'npm ci',
          profile: 'Daytona',
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
          jobId: 'job-1',
          message: 'Approval required.',
        };
      }),
      getApprovalSummaries: vi.fn(() => new Map([
        ['approval-1', {
          toolName: 'code_remote_exec',
          argsPreview: '{"command":"npm ci","profile":"Daytona"}',
          actionLabel: 'run npm ci remotely',
        }],
      ])),
      listPendingApprovalIdsForUser: vi.fn(() => []),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;
    (agent as any).executionGraphStore = executionGraphStore;

    const response = await agent.onMessage({
      id: 'msg-remote-sequencing',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      content: 'In the current coding workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.',
      timestamp: 1_710_000_000_000,
      metadata: attachSelectedExecutionProfileMetadata(
        attachPreRoutedIntentGatewayMetadata(
          {
            codeContext: {
              workspaceRoot: '/repo',
              sessionId: 'session-123',
            },
          },
          {
            available: true,
            mode: 'primary',
            model: 'test-model',
            latencyMs: 1,
            decision: {
              route: 'coding_task',
              operation: 'run',
              summary: 'Run repo commands in the remote sandbox.',
              confidence: 'high',
              turnRelation: 'new_request',
              resolution: 'ready',
              missingFields: [],
              executionClass: 'repo_grounded',
              preferredTier: 'external',
              requiresRepoGrounding: true,
              requiresToolSynthesis: true,
              expectedContextPressure: 'medium',
              preferredAnswerPath: 'tool_loop',
              entities: {
                codingRemoteExecRequested: true,
                profileId: 'Daytona',
              },
            },
          },
        ),
        {
          id: 'managed_cloud_tool',
          providerName: 'ollama-cloud-coding',
          providerType: 'ollama_cloud',
          providerModel: 'gpt-oss:120b',
          providerLocality: 'external',
          providerTier: 'managed_cloud',
          requestedTier: 'external',
          preferredAnswerPath: 'tool_loop',
          expectedContextPressure: 'medium',
          contextBudget: 80000,
          toolContextMode: 'tight',
          maxAdditionalSections: 2,
          maxRuntimeNotices: 2,
          fallbackProviderOrder: ['ollama-cloud-coding'],
          reason: 'coding profile',
        },
      ),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: llm as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.metadata?.pendingAction).toBeTruthy();
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume?.kind).toBe('execution_graph');
    const artifactId = pending?.graphInterrupt?.artifactRefs[0]?.artifactId;
    const artifact = executionGraphStore.getArtifact(pending!.graphInterrupt!.graphId, artifactId!);
    const payload = (artifact?.content as { payload?: Record<string, unknown> } | undefined)?.payload;
    expect(payload).toMatchObject({
      pendingTools: [
        {
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          jobId: 'job-1',
          name: 'code_remote_exec',
        },
      ],
    });
    const checkpointArtifactId = String((payload as Record<string, unknown>).checkpointArtifactId ?? '');
    expect(checkpointArtifactId).toMatch(/^artifact:/);
    const checkpointArtifact = executionGraphStore.getArtifact(pending!.graphInterrupt!.graphId, checkpointArtifactId);
    const checkpointPayload = (checkpointArtifact?.content as { payload?: Record<string, unknown> } | undefined)?.payload;
    expect(checkpointArtifact).toMatchObject({
      artifactType: 'ToolLoopCheckpoint',
      redactionPolicy: 'internal_resume_checkpoint',
    });
    expect(((checkpointPayload as Record<string, unknown>).llmMessages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant')?.toolCalls).toEqual([
      {
        id: 'tool-call-1',
        name: 'code_remote_exec',
        arguments: JSON.stringify({ command: 'npm ci' }),
      },
    ]);
  });

  it('replays failed approval-backed remote tool results into the resumed tool loop', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listJobs: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const fallbackChain = {
      chatWithProviderOrder: vi.fn(async (_providerOrder: string[], msgs: Array<{ role: string; content?: string }>) => {
        const replayedFailure = msgs.find((message) =>
          message.role === 'tool'
          && typeof message.content === 'string'
          && message.content.includes('"stderr":"OOM"'),
        );
        expect(replayedFailure).toBeTruthy();
        return {
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: 'Observed the remote sandbox failure.',
            toolCalls: [],
            model: 'gpt-oss:120b',
            finishReason: 'stop',
          },
        };
      }),
    };
    (agent as any).fallbackChain = fallbackChain;

    const selectedExecutionProfile = {
      id: 'managed_cloud_tool' as const,
      providerName: 'ollama-cloud-coding',
      providerType: 'ollama_cloud',
      providerModel: 'gpt-oss:120b',
      providerLocality: 'external' as const,
      providerTier: 'managed_cloud' as const,
      requestedTier: 'external' as const,
      preferredAnswerPath: 'tool_loop' as const,
      expectedContextPressure: 'medium' as const,
      contextBudget: 80000,
      toolContextMode: 'tight' as const,
      maxAdditionalSections: 2,
      maxRuntimeNotices: 2,
      fallbackProviderOrder: ['ollama-cloud-coding'],
      reason: 'coding profile',
    };
    const originalMetadata = attachSelectedExecutionProfileMetadata({
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      },
    }, selectedExecutionProfile);
    const executionGraphStore = new ExecutionGraphStore();
    const pendingActionStore = new PendingActionStore({ enabled: false, sqlitePath: ':memory:' });
    (agent as any).executionGraphStore = executionGraphStore;
    (agent as any).pendingActionStore = pendingActionStore;
    const pendingAction = createToolLoopGraphPendingAction({
      executionGraphStore,
      pendingActionStore,
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      requestId: 'msg-remote-failure-1',
      prompt: 'Approve remote execution.',
      approvalId: 'approval-1',
      originalUserContent: 'Run npm ci and then npm test in the same remote sandbox.',
      route: 'coding_task',
      operation: 'run',
      codeSessionId: 'session-123',
      continuation: buildToolLoopContinuationPayload({
        llmMessages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'Run npm ci and then npm test in the same remote sandbox.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tool-call-1',
                name: 'code_remote_exec',
                arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
              },
            ],
          },
        ],
        pendingTools: [
          {
            approvalId: 'approval-1',
            toolCallId: 'tool-call-1',
            jobId: 'job-1',
            name: 'code_remote_exec',
          },
        ],
        originalMessage: {
          id: 'msg-remote-failure-1',
          userId: 'owner',
          channel: 'web',
          surfaceId: 'owner',
          principalId: 'owner',
          principalRole: 'owner',
          content: 'Run npm ci and then npm test in the same remote sandbox.',
          timestamp: 1_710_000_000_000,
          metadata: originalMetadata,
        },
        requestText: 'Run npm ci and then npm test in the same remote sandbox using the Daytona profile.',
        referenceTime: 1_710_000_000_000,
        allowModelMemoryMutation: false,
        activeSkillIds: [],
        contentTrustLevel: 'trusted',
        taintReasons: [],
        intentDecision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Run remote sandbox commands.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingRemoteExecRequested: true,
            profileId: 'Daytona',
          },
        },
        codeContext: {
          workspaceRoot: '/repo',
          sessionId: 'session-123',
        },
        selectedExecutionProfile,
      }),
    });

    const result = await (agent as any).continuePendingActionAfterApproval(
      pendingAction,
      'approval-1',
      'approved',
      {
        success: false,
        approved: true,
        executionSucceeded: false,
        message: "Tool 'code_remote_exec' failed.",
        result: {
          success: false,
          error: 'Remote sandbox command failed on Daytona Main.',
          output: {
            stdout: '',
            stderr: 'OOM',
            leaseId: 'lease-1',
            sandboxId: 'sandbox-1',
            leaseMode: 'managed',
          },
        },
      },
    );

    expect(result?.content).toBe('Observed the remote sandbox failure.');
    expect(fallbackChain.chatWithProviderOrder).toHaveBeenCalledTimes(1);
  });

  it('replays the last actionable request for retry-like follow-ups after a transient Ollama failure', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).conversationService = {
      getSessionHistory: vi.fn(() => [
        {
          role: 'assistant',
          content: 'Could not reach Ollama at http://127.0.0.1:11434. Check that the local Ollama server is running. (fetch failed)',
        },
      ]),
    };

    const result = (agent as any).resolveRetryAfterFailureContinuationContent(
      'Ollama was disabled. Try that again now',
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        lastActionableRequest: 'Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
      },
    );

    expect(result).toBe('Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."');
  });

  it('replays the last actionable request for natural recovery follow-ups after provider connection failures', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).conversationService = {
      getSessionHistory: vi.fn(() => [
        {
          role: 'assistant',
          content: 'I’m unable to fetch Google Calendar data because the Google Workspace integration isn’t currently connected in this environment.',
        },
      ]),
    };

    const result = (agent as any).resolveRetryAfterFailureContinuationContent(
      'It is connected now.',
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        lastActionableRequest: 'List my Google Calendar entries for the next 7 days.',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      {
        agentId: 'chat',
        userId: 'owner',
        channel: 'telegram',
      },
    );

    expect(result).toBe('List my Google Calendar entries for the next 7 days.');
  });

  it('reclassifies retry continuations instead of reusing stale pre-routed session-control metadata', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = 1_710_000_000_000;
    const retryRequest = 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.';
    const agent = new ChatAgent('chat', 'Chat');
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-retry-reroute.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      lastActionableRequest: retryRequest,
      focusSummary: 'Remote sandbox retry',
    }, nowMs);
    (agent as any).continuityThreadStore = continuityThreadStore;
    (agent as any).getActiveExecution = vi.fn(() => ({
      executionId: 'exec-1',
      requestId: 'request-1',
      rootExecutionId: 'exec-1',
      scope: {
        assistantId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      status: 'running',
      intent: {
        route: 'coding_task',
        operation: 'run',
        originalUserContent: retryRequest,
      },
      createdAt: nowMs,
      updatedAt: nowMs,
    }));

    const classify = vi.fn(async (input: { content: string }) => {
      expect(input.content).toBe(retryRequest);
      return {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'general_assistant',
          confidence: 'medium',
          operation: 'run',
          summary: 'Retry the restored sandbox request.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {},
        },
      };
    });
    (agent as any).intentGateway = { classify };
    (agent as any).chatWithFallback = vi.fn(async () => ({
      content: 'Reclassified retry request.',
      toolCalls: [],
      model: 'test-model',
      finishReason: 'stop',
    }));
    (agent as any).tryDirectCodeSessionControlFromGateway = vi.fn(() => 'Available coding workspaces:\n- CURRENT: Guardian Agent');

    const response = await agent.onMessage!({
      id: 'msg-retry-reroute',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: "I've started that Daytona sandbox so try again with the same request.",
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        mode: 'route_only_fallback',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_session_control',
          confidence: 'medium',
          operation: 'run',
          summary: 'User wants to re-run the currently active coding session.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'control_plane',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {
            sessionTarget: 'current',
          },
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: vi.fn(async () => ({
          content: 'Reclassified retry request.',
          toolCalls: [],
          model: 'test-model',
          finishReason: 'stop',
        })),
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect((agent as any).tryDirectCodeSessionControlFromGateway).not.toHaveBeenCalled();
    expect(response.content).toBe('Reclassified retry request.');
  });

  it('keeps direct-assistant greeting turns in-process on the selected frontier provider even with an attached coding session', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-frontier-direct-greeting.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const localChat = vi.fn(async () => ({
      content: 'Hello from local.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const frontierChat = vi.fn(async () => ({
      content: 'Hello back.',
      toolCalls: [],
      model: 'gpt-4o',
      finishReason: 'stop',
    }));
    const fallbackChain = new ModelFallbackChain(new Map([
      ['ollama', { name: 'ollama', chat: localChat } as never],
      ['openai', { name: 'openai', chat: frontierChat } as never],
    ]), ['ollama', 'openai']);

    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fallbackChain,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    (agent as any).intentGateway = {
      classify: vi.fn(async () => ({
        mode: 'json_fallback',
        available: false,
        model: 'unknown',
        latencyMs: 1,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: 'Intent gateway response was not structured.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {},
        },
      })),
    };
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated work failed.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-frontier-direct-greeting',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Just reply hello back',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'frontier_deep',
        providerName: 'openai',
        providerType: 'openai',
        providerModel: 'gpt-4o',
        providerLocality: 'external',
        providerTier: 'frontier',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['openai', 'ollama'],
        reason: 'request-scoped provider override selected provider \'openai\'',
        routingMode: 'auto',
        selectionSource: 'request_override',
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toBe('Hello back.');
    expect(workerManager.handleMessage).not.toHaveBeenCalled();
    expect(frontierChat).toHaveBeenCalledOnce();
    expect(localChat).not.toHaveBeenCalled();
    expect(response.metadata).toMatchObject({
      responseSource: {
        providerName: 'openai',
        model: 'gpt-4o',
        locality: 'external',
      },
    });
  });

  it('keeps classified non-coding general-assistant turns inline even when a worker manager and coding session are present', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-inline-general-assistant.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const localChat = vi.fn(async () => ({
      content: 'Inline answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated work failed.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-inline-general-assistant',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Summarize why request-scoped provider overrides matter.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Summarize the request directly.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'chat_synthesis',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toBe('Inline answer.');
    expect(localChat).toHaveBeenCalledOnce();
    expect(workerManager.handleMessage).not.toHaveBeenCalled();
  });

  it('answers automation capability questions through the gateway-selected model instead of a content shortcut', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const localChat = vi.fn(async () => ({
      content: 'Model-grounded automation capability answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent('chat', 'Chat');
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated work failed.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-automation-capability-inline',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'What can you automate?',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Answer an automation capability question directly.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'chat_synthesis',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toBe('Model-grounded automation capability answer.');
    expect(response.content).not.toContain('Guardian can automate three main shapes');
    expect(localChat).toHaveBeenCalledOnce();
    expect(workerManager.handleMessage).not.toHaveBeenCalled();
  });

  it('answers tool inventory questions through the gateway-selected model instead of a content shortcut', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const localChat = vi.fn(async () => ({
      content: 'Model-grounded tool inventory answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent('chat', 'Chat');
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated work failed.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-tool-inventory-inline',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'What tools can you use?',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Answer a tool inventory question directly.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'chat_synthesis',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toBe('Model-grounded tool inventory answer.');
    expect(response.content).not.toContain('Available tools on this surface');
    expect(localChat).toHaveBeenCalledOnce();
    expect(workerManager.handleMessage).not.toHaveBeenCalled();
  });

  it('uses active code-session continuity history for cross-surface direct follow-ups', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const conversationService = new ConversationService({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-cross-surface-history.test.sqlite',
      maxTurns: 50,
      maxMessageChars: 20_000,
      maxContextChars: 20_000,
      retentionDays: 30,
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-cross-surface-history-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-cross-surface-history-code-session.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      ownerPrincipalId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'config-panel',
      },
      activeExecutionRefs: [
        {
          kind: 'execution',
          id: 'execution:run-timeline-rendering',
          label: 'Find where run timeline rendering is implemented and where it is consumed.',
        },
        {
          kind: 'code_session',
          id: guardianSession.id,
        },
      ],
    }, nowMs);
    conversationService.recordTurn(
      { agentId: 'chat', userId: 'owner', channel: 'web' },
      'hello stale guardian surface',
      'hello stale guardian surface',
    );
    conversationService.recordTurn(
      {
        agentId: 'chat',
        userId: 'owner',
        channel: resolveConversationHistoryChannel({
          channel: 'web',
          surfaceId: 'config-panel',
        }),
      },
      'hello config panel',
      'hello config panel',
    );
    conversationService.recordTurn(
      {
        agentId: 'chat',
        userId: guardianSession.conversationUserId,
        channel: guardianSession.conversationChannel,
      },
      'Find where run timeline rendering is implemented and where it is consumed. Do not edit anything.',
      'Run timeline rendering is implemented in web/public/js/components/run-timeline-context.js and consumed by web/public/js/pages/automations.js, web/public/js/pages/code.js, and web/public/js/pages/system.js.',
    );

    const localChat = vi.fn(async () => ({
      content: 'The fragile part is request correlation between chat-run-tracking.js and the timeline consumers.',
      toolCalls: [],
      model: 'test-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    (agent as any).continuityThreadStore = continuityThreadStore;

    const response = await agent.onMessage!({
      id: 'msg-cross-surface-continuity-follow-up',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'config-panel',
      content: 'Based on your last answer, which part would be most likely to break approval continuity?',
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'answer',
          summary: 'Answer a follow-up about the prior answer.',
          turnRelation: 'follow_up',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.content).toContain('request correlation');
    expect(localChat).toHaveBeenCalledOnce();
    const messages = localChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const staleWebIndex = messages.findIndex((entry) => entry.content === 'hello stale guardian surface');
    const configSurfaceIndex = messages.findIndex((entry) => entry.content === 'hello config panel');
    const codeAnswerIndex = messages.findIndex((entry) => entry.content.includes('run-timeline-context.js'));
    expect(staleWebIndex).toBe(-1);
    expect(configSurfaceIndex).toBeGreaterThan(-1);
    expect(codeAnswerIndex).toBeGreaterThan(configSurfaceIndex);
    expect(messages.at(-2)?.content).toContain('run-timeline-context.js');
    expect(messages.at(-1)?.content).toContain('Based on your last answer');
  });

  it('uses same-surface history for direct-assistant continuity without unrelated surface turns', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const conversationService = new ConversationService({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-same-surface-history.test.sqlite',
      maxTurns: 50,
      maxMessageChars: 20_000,
      maxContextChars: 20_000,
      retentionDays: 30,
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-same-surface-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    conversationService.recordTurn(
      {
        agentId: 'chat',
        userId: 'owner',
        channel: resolveConversationHistoryChannel({
          channel: 'web',
          surfaceId: 'other-panel',
        }),
      },
      'The exact marker is STALE-MARKER.',
      'acknowledged',
    );

    const localChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'acknowledged',
        toolCalls: [],
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: 'CURRENT-MARKER',
        toolCalls: [],
        model: 'test-model',
        finishReason: 'stop',
      });
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
    );
    (agent as any).continuityThreadStore = continuityThreadStore;

    const gateway = (turnRelation: 'new_request' | 'follow_up'): IntentGatewayRecord => ({
      available: true,
      decision: {
        route: 'general_assistant',
        confidence: 'high',
        operation: 'answer',
        summary: 'Answer directly.',
        turnRelation,
        resolution: 'ready',
        missingFields: [],
        executionClass: 'direct_assistant',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        simpleVsComplex: 'simple',
        entities: {},
      },
    });

    await agent.onMessage!({
      id: 'msg-same-surface-marker-1',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'current-panel',
      content: 'For this conversation only, the exact marker is CURRENT-MARKER. Reply exactly: acknowledged',
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, gateway('new_request')),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    const response = await agent.onMessage!({
      id: 'msg-same-surface-marker-2',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'current-panel',
      content: 'What exact marker did I give in my previous message on this same surface? Reply exactly with only the marker.',
      timestamp: nowMs + 1,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, gateway('follow_up')),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.content).toBe('CURRENT-MARKER');
    expect(localChat).toHaveBeenCalledTimes(2);
    const messages = localChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const rendered = messages.map((entry) => entry.content).join('\n');
    expect(rendered).toContain('CURRENT-MARKER');
    expect(rendered).not.toContain('STALE-MARKER');
  });

  it('does not inject stale owner continuity into fresh direct-assistant surfaces', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const conversationService = new ConversationService({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-surface-history.test.sqlite',
      maxTurns: 50,
      maxMessageChars: 20_000,
      maxContextChars: 20_000,
      retentionDays: 30,
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-surface-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-surface-code-session.test.sqlite',
    });
    const staleSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      ownerPrincipalId: 'owner',
      title: 'Old Guardian Agent task',
      workspaceRoot: process.cwd(),
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      focusSummary: 'Old coding work.',
      lastActionableRequest: 'Inspect the repo and find the timeline files.',
      activeExecutionRefs: [
        {
          kind: 'execution',
          id: 'execution:old-timeline-work',
          label: 'Inspect the repo and find the timeline files.',
        },
        {
          kind: 'code_session',
          id: staleSession.id,
        },
      ],
    }, nowMs);
    conversationService.recordTurn(
      { agentId: 'chat', userId: 'owner', channel: 'web' },
      'remember marker-1234',
      'I will remember marker-1234.',
    );
    conversationService.recordTurn(
      {
        agentId: 'chat',
        userId: staleSession.conversationUserId,
        channel: staleSession.conversationChannel,
      },
      'Inspect the repo and find the timeline files.',
      'The stale answer mentioned run-timeline-context.js.',
    );

    const localChat = vi.fn(async () => ({
      content: 'prod no context ok',
      toolCalls: [],
      model: 'test-model',
      finishReason: 'stop',
    }));
    const memoryStore = {
      getMaxContextChars: vi.fn(() => 20_000),
      loadForContextWithSelection: vi.fn(() => ({
        content: 'Stale memory entry: STALE-MEMORY-MARKER',
        selectedEntries: [
          {
            category: 'General',
            createdAt: '2026-04-30',
            preview: 'Stale memory entry: STALE-MEMORY-MARKER',
            renderMode: 'full',
            queryScore: 100,
            isContextFlush: false,
            matchReasons: ['content terms 2'],
          },
        ],
        candidateEntries: 1,
        omittedEntries: 0,
        queryPreview: 'reply with exactly prod no context ok',
      })),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryStore as never,
      undefined,
      codeSessionStore,
    );
    (agent as any).continuityThreadStore = continuityThreadStore;

    const response = await agent.onMessage!({
      id: 'msg-fresh-surface-no-continuity',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'fresh-api-surface',
      content: 'Reply with exactly: prod no context ok',
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'answer',
          summary: 'Answer the current request directly.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.content).toBe('prod no context ok');
    expect(memoryStore.loadForContextWithSelection).not.toHaveBeenCalled();
    expect(localChat).toHaveBeenCalledOnce();
    const messages = localChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.map((entry) => entry.content).join('\n')).not.toContain('marker-1234');
    expect(messages.map((entry) => entry.content).join('\n')).not.toContain('run-timeline-context.js');
    expect(messages.map((entry) => entry.content).join('\n')).not.toContain('STALE-MEMORY-MARKER');
    expect(messages.at(-1)?.content).toBe('Reply with exactly: prod no context ok');
    expect(response.metadata?.contextAssembly).toMatchObject({
      knowledgeBaseLoaded: false,
    });
    expect((response.metadata?.contextAssembly as Record<string, unknown> | undefined)?.selectedMemoryEntryCount ?? 0).toBe(0);
  });

  it('does not load memory context for standalone direct-assistant greetings', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const conversationService = new ConversationService({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-greeting-minimal-context.test.sqlite',
      maxTurns: 50,
      maxMessageChars: 20_000,
      maxContextChars: 20_000,
      retentionDays: 30,
      now: () => nowMs,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-greeting-minimal-context-code-session.test.sqlite',
    });
    const memoryStore = {
      getMaxContextChars: vi.fn(() => 20_000),
      loadForContextWithSelection: vi.fn(() => ({
        content: 'Stored smoke test marker: UI-MEM-SHOULD-NOT-LOAD',
        selectedEntries: [
          {
            category: 'Smoke Tests',
            createdAt: '2026-05-01',
            preview: 'Stored smoke test marker: UI-MEM-SHOULD-NOT-LOAD',
            renderMode: 'full',
            queryScore: 100,
            isContextFlush: false,
            matchReasons: ['content terms 1'],
          },
        ],
        candidateEntries: 1,
        omittedEntries: 0,
        queryPreview: 'hello',
      })),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryStore as never,
      undefined,
      codeSessionStore,
    );

    const localChat = vi.fn(async () => ({
      content: 'Hello there.',
      toolCalls: [],
      model: 'test-model',
      finishReason: 'stop',
    }));
    const response = await agent.onMessage!({
      id: 'msg-greeting-minimal-context',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Hello',
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'unknown',
          summary: 'Answer a standalone greeting.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          simpleVsComplex: 'simple',
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama-cloud-direct',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.content).toBe('Hello there.');
    expect(memoryStore.loadForContextWithSelection).not.toHaveBeenCalled();
    const rendered = (localChat.mock.calls[0][0] as Array<{ role: string; content: string }>)
      .map((entry) => entry.content)
      .join('\n');
    expect(rendered).not.toContain('UI-MEM-SHOULD-NOT-LOAD');
    expect(response.metadata?.contextAssembly).toMatchObject({
      knowledgeBaseLoaded: false,
    });
  });

  it('delegates fresh repo-grounded shared code-session requests without stale code-session history', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowMs = Date.now();
    const conversationService = new ConversationService({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-shared-code-session-history.test.sqlite',
      maxTurns: 50,
      maxMessageChars: 20_000,
      maxContextChars: 20_000,
      retentionDays: 30,
      now: () => nowMs,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-shared-code-session-continuity.test.sqlite',
      retentionDays: 30,
      now: () => nowMs,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-fresh-shared-code-session.test.sqlite',
    });
    const staleSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      ownerPrincipalId: 'owner',
      title: 'Old Guardian Agent task',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: staleSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'old-code-surface',
      mode: 'controller',
    });
    continuityThreadStore.upsert({
      assistantId: 'chat',
      userId: 'owner',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'old-code-surface',
      },
      focusSummary: 'Old coding work.',
      lastActionableRequest: 'What tools did you use in my immediately previous request on this surface?',
      activeExecutionRefs: [
        {
          kind: 'execution',
          id: 'execution:old-tool-report',
          label: 'What tools did you use in my immediately previous request on this surface?',
        },
        {
          kind: 'code_session',
          id: staleSession.id,
        },
      ],
    }, nowMs);
    conversationService.recordTurn(
      {
        agentId: 'chat',
        userId: staleSession.conversationUserId,
        channel: staleSession.conversationChannel,
      },
      'What tools did you use in my immediately previous request on this surface?',
      'The stale answer said no tools were used.',
    );

    const localChat = vi.fn(async () => ({
      content: 'Inline answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    (agent as any).continuityThreadStore = continuityThreadStore;
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'src/runtime/execution-graph/delegated-worker-retry.ts, src/supervisor/worker-manager.ts',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-fresh-shared-code-session-repo-request',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'fresh-api-surface',
      content: 'Inspect this repo and tell me which files implement delegated worker retry policy. Do not edit anything.',
      timestamp: nowMs,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspect the repository and report grounded findings.',
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
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toContain('delegated-worker-retry.ts');
    expect(workerManager.handleMessage).toHaveBeenCalledOnce();
    const workerInput = workerManager.handleMessage.mock.calls[0][0] as {
      userId: string;
      sessionId: string;
      history: Array<{ content: string }>;
      message: UserMessage;
      systemPrompt: string;
      delegation?: { codeSessionId?: string };
    };
    expect(workerInput.userId).toBe('owner');
    expect(workerInput.sessionId).toBe('owner:web:surface:fresh-api-surface');
    expect(workerInput.message.metadata?.codeContext).toMatchObject({
      sessionId: staleSession.id,
      workspaceRoot: process.cwd(),
    });
    expect(workerInput.delegation?.codeSessionId).toBe(staleSession.id);
    const assembledWorkerContext = [
      workerInput.systemPrompt,
      ...workerInput.history.map((entry) => entry.content),
    ].join('\n');
    expect(assembledWorkerContext).not.toContain('What tools did you use');
    expect(assembledWorkerContext).not.toContain('stale answer');
    expect(localChat).not.toHaveBeenCalled();
  });

  it('delegates structured general-assistant follow-ups that need tool synthesis', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-general-tool-synthesis.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const localChat = vi.fn(async () => ({
      content: 'Inline answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated follow-up complete.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-delegated-general-tool-synthesis',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Using the security summary and posture from that last answer, create a Second Brain task for the concern and a weekly automation to revisit it.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'general_assistant',
          confidence: 'high',
          operation: 'create',
          summary: 'Use the prior security answer to create a task and follow-up automation.',
          turnRelation: 'follow_up',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'complex',
          plannedSteps: [
            {
              kind: 'tool_call',
              summary: 'Re-check the prior security context.',
              expectedToolCategories: ['assistant_security_findings', 'security_posture_status'],
              required: true,
            },
            {
              kind: 'write',
              summary: 'Create the follow-up task.',
              expectedToolCategories: ['second_brain_task_upsert'],
              required: true,
            },
            {
              kind: 'write',
              summary: 'Create the weekly automation.',
              expectedToolCategories: ['automation_save'],
              required: true,
            },
          ],
          entities: {},
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: ['read_files', 'write_files', 'network_access'],
    }, workerManager as never);

    expect(response.content).toBe('Delegated follow-up complete.');
    expect(workerManager.handleMessage).toHaveBeenCalledOnce();
    expect(workerManager.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      delegation: expect.objectContaining({
        orchestration: {
          role: 'coordinator',
          label: 'Guardian Coordinator',
        },
      }),
    }));
    expect(localChat).not.toHaveBeenCalled();
  });

  it('handles structured security-event handoffs inline instead of nesting another delegated worker', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const localChat = vi.fn(async () => ({
      content: 'Security event triage complete.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'security-triage',
      'Security Triage Agent',
    );
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated security verifier result.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-security-event-handoff-inline',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'scheduled',
      content: 'Investigate this security event as the dedicated Security Triage Agent.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata({
        handoff: {
          id: 'security-triage:security:native:provider:defender_threat_detected:1000',
          sourceAgentId: 'security-triage-dispatcher',
          targetAgentId: 'security-triage',
          contextMode: 'user_only',
          preserveTaint: false,
          allowedCapabilities: ['execute_commands', 'network_access'],
        },
        securityEvent: {
          type: 'security:native:provider',
          sourceAgentId: 'windows-defender',
          detailType: 'defender_threat_detected',
          dedupeKey: 'security:native:provider:defender_threat_detected',
          severity: 'warn',
        },
      }, {
        available: true,
        decision: {
          route: 'security_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Triage a structured native provider alert.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'security_analysis',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'chat_synthesis',
          simpleVsComplex: 'complex',
          plannedSteps: [
            {
              kind: 'tool_call',
              summary: 'Inspect security posture and alert evidence.',
              expectedToolCategories: ['assistant_security_summary', 'assistant_security_findings'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Return the security assessment.',
              required: true,
            },
          ],
          entities: {},
        },
      }),
    }, {
      agentId: 'security-triage',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: ['read_files', 'execute_commands', 'network_access'],
    }, workerManager as never);

    expect(response.content).toBe('Security event triage complete.');
    expect(workerManager.handleMessage).not.toHaveBeenCalled();
    expect(localChat).toHaveBeenCalledOnce();
  });

  it('still delegates explicit coding workloads when a coding session is attached', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-delegated-coding-boundary.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const localChat = vi.fn(async () => ({
      content: 'Inline answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Delegated repo answer.',
      })),
    };

    const response = await agent.onMessage!({
      id: 'msg-delegated-coding-boundary',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Inspect this repo and tell me which files implement delegated worker progress.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspect the repository and report grounded findings.',
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
        },
      }),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    }, workerManager as never);

    expect(response.content).toBe('Delegated repo answer.');
    expect(workerManager.handleMessage).toHaveBeenCalledOnce();
    expect(localChat).not.toHaveBeenCalled();
  });

  it('delegates structured read-write coding plans instead of marking them direct reasoning', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-structured-read-write.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: process.cwd(),
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const localChat = vi.fn(async () => ({
      content: 'Inline answer.',
      toolCalls: [],
      model: 'local-model',
      finishReason: 'stop',
    }));
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const workerManager = {
      handleMessage: vi.fn(async () => ({
        content: 'Graph-controlled write complete.',
      })),
    };
    const selectedProfile = {
      id: 'managed_cloud_direct' as const,
      providerName: 'openrouter',
      providerType: 'openrouter',
      providerModel: 'qwen/qwen3.6-plus',
      providerLocality: 'external' as const,
      providerTier: 'managed_cloud' as const,
      requestedTier: 'external' as const,
      preferredAnswerPath: 'chat_synthesis' as const,
      expectedContextPressure: 'high' as const,
      contextBudget: 32_000,
      toolContextMode: 'tight' as const,
      maxAdditionalSections: 2,
      maxRuntimeNotices: 2,
      fallbackProviderOrder: ['openrouter'],
      reason: 'test managed cloud direct profile',
      routingMode: 'auto' as const,
      selectionSource: 'auto' as const,
    };
    const gatewayRecord = {
      mode: 'primary' as const,
      available: true,
      model: 'test-gateway',
      latencyMs: 1,
      decision: {
        route: 'coding_task' as const,
        confidence: 'high' as const,
        operation: 'inspect' as const,
        summary: 'Search the repo and write a grounded summary file.',
        turnRelation: 'new_request' as const,
        resolution: 'ready' as const,
        missingFields: [],
        executionClass: 'repo_grounded' as const,
        preferredTier: 'external' as const,
        requiresRepoGrounding: true,
        requiresToolSynthesis: false,
        expectedContextPressure: 'high' as const,
        preferredAnswerPath: 'chat_synthesis' as const,
        plannedSteps: [
          { kind: 'search' as const, summary: 'Search src/runtime for planned_steps.', required: true },
          {
            kind: 'write' as const,
            summary: 'Write a grounded summary to tmp/manual-web/planned-steps-summary.txt.',
            expectedToolCategories: ['fs_write'],
            required: true,
            dependsOn: ['step_1'],
          },
        ],
        entities: {},
      },
    };

    const response = await agent.onMessage!({
      id: 'msg-structured-read-write',
      userId: 'owner',
      principalId: 'owner',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(
        attachSelectedExecutionProfileMetadata(undefined, selectedProfile),
        gatewayRecord,
      ),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: localChat,
      } as never,
      checkAction: vi.fn(),
      capabilities: ['read_files', 'write_files'],
    }, workerManager as never);

    expect(response.content).toBe('Graph-controlled write complete.');
    expect(workerManager.handleMessage).toHaveBeenCalledOnce();
    expect(workerManager.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      directReasoning: false,
      delegation: expect.objectContaining({
        orchestration: {
          role: 'implementer',
          label: 'Workspace Implementer',
          lenses: ['coding-workspace'],
        },
      }),
    }));
    expect(localChat).not.toHaveBeenCalled();
  });
});
