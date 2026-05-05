import { describe, expect, it } from 'vitest';

import { ContinuityThreadStore } from '../continuity-threads.js';
import { ExecutionStore } from '../executions.js';
import { PendingActionStore } from '../pending-actions.js';
import { ChatAgentOrchestrationState } from './orchestration-state.js';

function createStore(nowMs = 1_710_000_000_000): PendingActionStore {
  return new PendingActionStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-orchestration-state.test.sqlite',
    now: () => nowMs,
  });
}

function createContinuityStore(nowMs = 1_710_000_000_000): ContinuityThreadStore {
  return new ContinuityThreadStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-continuity-state.test.sqlite',
    retentionDays: 30,
    now: () => nowMs,
  });
}

function createExecutionStore(nowMs = 1_710_000_000_000): ExecutionStore {
  return new ExecutionStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-execution-state.test.sqlite',
    now: () => nowMs,
  });
}

describe('ChatAgentOrchestrationState', () => {
  it('does not return completed approval actions after reconciliation clears the live approval ids', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the pending path update.',
          approvalIds: ['approval-1'],
          approvalSummaries: [
            {
              id: 'approval-1',
              toolName: 'update_tool_policy',
              argsPreview: '{"action":"add_path"}',
              actionLabel: 'add path',
            },
          ],
        },
        intent: {
          route: 'general_assistant',
          operation: 'execute',
          originalUserContent: 'Create the empty file.',
        },
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        listPendingApprovalIdsForUser: () => [],
        getApprovalSummaries: () => new Map(),
      },
    });

    const pendingAction = state.getActivePendingAction(
      'user-1',
      'web',
      'web-guardian-chat',
      nowMs + 1,
    );

    expect(pendingAction).toBeNull();
  });

  it('does not raise a collision prompt when the next approval replaces a reconciled stale approval', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const stale = store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the pending path update.',
          approvalIds: ['approval-1'],
          approvalSummaries: [
            {
              id: 'approval-1',
              toolName: 'update_tool_policy',
              argsPreview: '{"action":"add_path"}',
              actionLabel: 'add path',
            },
          ],
        },
        intent: {
          route: 'general_assistant',
          operation: 'execute',
          originalUserContent: 'Create the empty file.',
        },
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        listPendingApprovalIdsForUser: () => [],
        getApprovalSummaries: () => new Map(),
      },
    });

    const result = state.setPendingApprovalAction(
      'user-1',
      'web',
      'web-guardian-chat',
      {
        prompt: 'Waiting for approval to write ./web-empty.txt.',
        approvalIds: ['approval-2'],
        approvalSummaries: [
          {
            id: 'approval-2',
            toolName: 'fs_write',
            argsPreview: '{"path":"./web-empty.txt","content":""}',
            actionLabel: 'write ./web-empty.txt',
          },
        ],
        originalUserContent: 'Create the empty file.',
        route: 'general_assistant',
        operation: 'execute',
        summary: 'Create the requested empty file.',
        turnRelation: 'follow_up',
        resolution: 'ready',
      },
      stale.updatedAt + 1,
    );

    expect(result.collisionPrompt).toBeUndefined();
    expect(result.action?.blocker.approvalIds).toEqual(['approval-2']);
    expect(result.action?.blocker.approvalSummaries).toEqual([
      {
        id: 'approval-2',
        toolName: 'fs_write',
        argsPreview: '{"path":"./web-empty.txt","content":""}',
        actionLabel: 'write ./web-empty.txt',
      },
    ]);
  });

  it('preserves an active approval pending action when live approval lookup is unavailable', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const created = store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the pending path update.',
          approvalIds: ['approval-1'],
        },
        intent: {
          route: 'filesystem_task',
          operation: 'save',
          originalUserContent: 'Save the previous output.',
        },
        resume: {
          kind: 'execution_graph',
          payload: {
            graphId: 'graph-1',
            nodeId: 'node-1',
            resumeToken: 'resume-1',
            artifactIds: [],
          },
        },
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const pendingAction = state.getActivePendingAction(
      'user-1',
      'web',
      'web-guardian-chat',
      nowMs + 1,
    );

    expect(pendingAction?.id).toBe(created.id);
    expect(pendingAction?.resume?.kind).toBe('execution_graph');
  });

  it('stores pending-action switch candidates in blocker metadata instead of graph resume', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const previousResume = {
      kind: 'execution_graph' as const,
      payload: {
        graphId: 'graph-previous',
        nodeId: 'node-previous',
        resumeToken: 'resume-previous',
        artifactIds: [],
      },
    };
    store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the pending path update.',
          approvalIds: ['approval-1'],
        },
        intent: {
          route: 'filesystem_task',
          operation: 'save',
          originalUserContent: 'Save the previous output.',
        },
        resume: previousResume,
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const result = state.setClarificationPendingAction(
      'user-1',
      'web',
      'web-guardian-chat',
      {
        blockerKind: 'clarification',
        prompt: 'Which workspace should I use?',
        originalUserContent: 'Use the other workspace.',
        route: 'workspace_task',
        operation: 'update',
      },
      nowMs + 1,
    );

    expect(result.collisionPrompt).toContain('You already have blocked work waiting');
    expect(result.action?.resume).toEqual(previousResume);
    const switchCandidate = state.readPendingActionSwitchCandidatePayload(result.action);
    expect(switchCandidate).toMatchObject({
      type: 'pending_action_switch_candidate',
      previousResume,
      replacement: {
        blocker: {
          kind: 'clarification',
          prompt: 'Which workspace should I use?',
        },
        intent: {
          route: 'workspace_task',
          operation: 'update',
          originalUserContent: 'Use the other workspace.',
        },
      },
    });
  });

  it('keeps local uncertainty clarifications from colliding with portable blocked work on another surface', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const portable = store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'linked_surfaces_same_user',
        blocker: {
          kind: 'clarification',
          prompt: 'What should I search the web for?',
          field: 'query',
        },
        intent: {
          route: 'search_task',
          operation: 'search',
          originalUserContent: 'Find something useful.',
        },
        expiresAt: nowMs + 30 * 60_000,
      },
    );
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const result = state.setClarificationPendingAction(
      'user-1',
      'web',
      'new-web-surface',
      {
        blockerKind: 'clarification',
        field: 'intent_route',
        prompt: 'What do you want me to do next?',
        originalUserContent: 'Go out to the internet search on random websites and pull me back some information.',
        route: 'coding_task',
        operation: 'unknown',
        transferPolicy: 'origin_surface_only',
      },
      nowMs + 1,
    );

    expect(result.collisionPrompt).toBeUndefined();
    expect(result.action?.scope.surfaceId).toBe('new-web-surface');
    expect(result.action?.transferPolicy).toBe('origin_surface_only');
    expect(store.get(portable.id)?.status).toBe('pending');
  });

  it('preserves a cross-scope approval pending action when scoped lookup misses it but the executor still reports it pending globally', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const created = store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the Codex run.',
          approvalIds: ['approval-codesession-1'],
        },
        intent: {
          route: 'coding_task',
          operation: 'update',
          originalUserContent: 'Use Codex in this coding workspace to inspect README.md.',
        },
        codeSessionId: 'code-session-1',
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        listPendingApprovalIdsForUser: () => [],
        listApprovals: () => [{ id: 'approval-codesession-1' } as any],
        getApprovalSummaries: () => new Map(),
      },
    });

    const pendingAction = state.getActivePendingAction(
      'owner',
      'web',
      'web-guardian-chat',
      nowMs + 1,
    );

    expect(pendingAction?.id).toBe(created.id);
    expect(store.findActiveByApprovalId('approval-codesession-1')?.id).toBe(created.id);
  });

  it('does not clear a cross-scope approval pending action when sync receives an empty scoped approval list', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const created = store.replaceActive(
      {
        agentId: 'assistant',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt: 'Approve the Codex run.',
          approvalIds: ['approval-codesession-1'],
        },
        intent: {
          route: 'coding_task',
          operation: 'update',
          originalUserContent: 'Use Codex in this coding workspace to inspect README.md.',
        },
        expiresAt: nowMs + 30 * 60_000,
      },
    );

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        listPendingApprovalIdsForUser: () => [],
        listApprovals: () => [{ id: 'approval-codesession-1' } as any],
        getApprovalSummaries: () => new Map(),
      },
    });

    state.setPendingApprovals(
      'owner:web',
      [],
      'web-guardian-chat',
      nowMs + 1,
    );

    expect(store.findActiveByApprovalId('approval-codesession-1')?.id).toBe(created.id);
    expect(state.getPendingApprovalIds(
      'owner',
      'web',
      'web-guardian-chat',
      nowMs + 2,
    )).toEqual(['approval-codesession-1']);
  });

  it('does not synthesize a new pending approval action from unrelated live approvals', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);

    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      pendingActionStore: store,
      tools: {
        listPendingApprovalIdsForUser: () => ['approval-1'],
        getApprovalSummaries: () => new Map([
          ['approval-1', {
            toolName: 'code_test',
            argsPreview: '{"command":"npm test"}',
            actionLabel: 'run npm test',
          }],
        ]),
      },
    });

    const pendingAction = state.getActivePendingAction(
      'user-1',
      'web',
      'web-guardian-chat',
      nowMs + 1,
    );

    expect(pendingAction).toBeNull();
    expect(store.resolveActiveForSurface({
      agentId: 'assistant',
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    })).toBeNull();
  });

  it('does not replace the last actionable request with a referential status check', () => {
    const nowMs = 1_710_000_000_000;
    const continuityStore = createContinuityStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const initial = state.updateContinuityThreadFromIntent({
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      routingContent: 'In this workspace, write a short report to C:\\Sensitive\\round2-approval.txt and continue once approval is granted.',
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'filesystem_task',
          confidence: 'high',
          operation: 'create',
          summary: 'Write the approval smoke report.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'tool_call',
          preferredTier: 'local',
          preferredAnswerPath: 'tool_loop',
          expectedContextPressure: 'medium',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          entities: {},
        },
      },
    });

    const updated = state.updateContinuityThreadFromIntent({
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: initial,
      routingContent: 'Did that last request work?',
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'general_assistant',
          confidence: 'medium',
          operation: 'read',
          summary: 'Check whether the previous request succeeded.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          preferredAnswerPath: 'direct',
          expectedContextPressure: 'low',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          entities: {},
        },
      },
    });

    expect(updated?.lastActionableRequest).toBe('In this workspace, write a short report to C:\\Sensitive\\round2-approval.txt and continue once approval is granted.');
  });

  it('preserves the classified intent on newly created executions so continuity refs stay grounded', () => {
    const nowMs = 1_710_000_000_000;
    const continuityStore = createContinuityStore(nowMs);
    const executionStore = createExecutionStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      executionStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const execution = state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-1',
        rootExecutionId: 'exec-1',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      routingContent: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspect the repository to identify files implementing delegated worker progress and run timeline rendering, without making edits.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          preferredAnswerPath: 'chat_synthesis',
          expectedContextPressure: 'high',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          entities: {},
        },
      },
      codeSessionId: 'code-session-1',
      nowMs,
    });

    expect(execution?.intent).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      summary: 'Inspect the repository to identify files implementing delegated worker progress and run timeline rendering, without making edits.',
      originalUserContent: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
    });

    const continuity = state.updateContinuityThreadFromIntent({
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      executionIdentity: {
        executionId: 'exec-1',
        rootExecutionId: 'exec-1',
      },
      routingContent: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspect the repository to identify files implementing delegated worker progress and run timeline rendering, without making edits.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          preferredAnswerPath: 'chat_synthesis',
          expectedContextPressure: 'high',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          entities: {},
        },
      },
      codeSessionId: 'code-session-1',
    });

    expect(executionStore.get('exec-1')?.intent).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      summary: 'Inspect the repository to identify files implementing delegated worker progress and run timeline rendering, without making edits.',
    });
    expect(continuity?.activeExecutionRefs).toEqual([
      {
        kind: 'execution',
        id: 'exec-1',
        label: 'Inspect the repository to identify files implementing delegated worker progress and run timeline rendering, without making edits.',
      },
      {
        kind: 'code_session',
        id: 'code-session-1',
      },
    ]);
  });

  it('preserves active code-session refs when a cross-surface direct follow-up does not resolve a session', () => {
    const nowMs = 1_710_000_000_050;
    const continuityStore = createContinuityStore(nowMs);
    const executionStore = createExecutionStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      executionStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });
    const existing = continuityStore.upsert({
      assistantId: 'assistant',
      userId: 'user-1',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'config-panel',
      },
      activeExecutionRefs: [
        {
          kind: 'execution',
          id: 'exec-previous',
          label: 'Find where run timeline rendering is implemented and where it is consumed.',
        },
        {
          kind: 'code_session',
          id: 'code-session-1',
        },
      ],
    }, nowMs);
    const gateway = {
      mode: 'primary' as const,
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'general_assistant' as const,
        confidence: 'high' as const,
        operation: 'answer',
        summary: 'Answer a follow-up about the prior answer.',
        turnRelation: 'follow_up' as const,
        resolution: 'ready' as const,
        missingFields: [],
        executionClass: 'direct_assistant' as const,
        preferredTier: 'external' as const,
        preferredAnswerPath: 'direct' as const,
        expectedContextPressure: 'low' as const,
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        entities: {},
      },
    };

    state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-follow-up',
        rootExecutionId: 'exec-follow-up',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'config-panel',
      continuityThread: existing,
      routingContent: 'Based on your last answer, which part would be most likely to break approval continuity?',
      gateway,
      nowMs,
    });
    const updated = state.updateContinuityThreadFromIntent({
      executionIdentity: {
        executionId: 'exec-follow-up',
        rootExecutionId: 'exec-follow-up',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'config-panel',
      continuityThread: existing,
      routingContent: 'Based on your last answer, which part would be most likely to break approval continuity?',
      gateway,
    });

    expect(updated?.activeExecutionRefs).toEqual([
      {
        kind: 'execution',
        id: 'exec-previous',
        label: 'Find where run timeline rendering is implemented and where it is consumed.',
      },
      {
        kind: 'code_session',
        id: 'code-session-1',
      },
    ]);
  });

  it('drops stale code-session refs when a fresh non-code request does not resolve a session', () => {
    const nowMs = 1_710_000_000_075;
    const continuityStore = createContinuityStore(nowMs);
    const executionStore = createExecutionStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      executionStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });
    const existing = continuityStore.upsert({
      assistantId: 'assistant',
      userId: 'user-1',
    }, {
      touchSurface: {
        channel: 'web',
        surfaceId: 'fresh-panel',
      },
      activeExecutionRefs: [
        {
          kind: 'execution',
          id: 'exec-previous',
          label: 'Old coding task.',
        },
        {
          kind: 'code_session',
          id: 'code-session-1',
        },
      ],
    }, nowMs);
    const gateway = {
      mode: 'primary' as const,
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'general_assistant' as const,
        confidence: 'high' as const,
        operation: 'read' as const,
        summary: 'Answer a self-contained marker request.',
        turnRelation: 'new_request' as const,
        resolution: 'ready' as const,
        missingFields: [],
        executionClass: 'direct_assistant' as const,
        preferredTier: 'external' as const,
        preferredAnswerPath: 'direct' as const,
        expectedContextPressure: 'low' as const,
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        entities: {},
      },
    };

    state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-fresh',
        rootExecutionId: 'exec-fresh',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'fresh-panel',
      continuityThread: existing,
      routingContent: 'Reply with exactly this marker and no other text: FRESH-1',
      gateway,
      nowMs,
    });
    const updated = state.updateContinuityThreadFromIntent({
      executionIdentity: {
        executionId: 'exec-fresh',
        rootExecutionId: 'exec-fresh',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'fresh-panel',
      continuityThread: existing,
      routingContent: 'Reply with exactly this marker and no other text: FRESH-1',
      gateway,
    });

    expect(updated?.activeExecutionRefs).toEqual([
      {
        kind: 'execution',
        id: 'exec-fresh',
        label: 'Answer a self-contained marker request.',
      },
    ]);
  });

  it('does not let blocked unknown clarification executions displace active coding work', () => {
    const nowMs = 1_710_000_000_090;
    const continuityStore = createContinuityStore(nowMs);
    const executionStore = createExecutionStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      executionStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });
    const codingGateway = {
      mode: 'primary' as const,
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'coding_task' as const,
        confidence: 'high' as const,
        operation: 'update' as const,
        summary: 'Continue the active MusicApp phase one build.',
        turnRelation: 'new_request' as const,
        resolution: 'ready' as const,
        missingFields: [],
        executionClass: 'repo_grounded' as const,
        preferredTier: 'external' as const,
        preferredAnswerPath: 'chat_synthesis' as const,
        expectedContextPressure: 'high' as const,
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        entities: {},
      },
    };
    state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-coding',
        rootExecutionId: 'exec-coding',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      routingContent: 'Start phase one.',
      gateway: codingGateway,
      codeSessionId: 'code-session-1',
      nowMs,
    });
    const continuity = state.updateContinuityThreadFromIntent({
      executionIdentity: {
        executionId: 'exec-coding',
        rootExecutionId: 'exec-coding',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      routingContent: 'Start phase one.',
      gateway: codingGateway,
      codeSessionId: 'code-session-1',
    });

    const clarificationGateway = {
      mode: 'primary' as const,
      available: true,
      model: 'test-model',
      latencyMs: 1,
      decision: {
        route: 'unknown' as const,
        confidence: 'low' as const,
        operation: 'unknown' as const,
        summary: 'Ask the user to clarify the request.',
        turnRelation: 'new_request' as const,
        resolution: 'needs_clarification' as const,
        missingFields: ['request'],
        executionClass: 'direct_assistant' as const,
        preferredTier: 'external' as const,
        preferredAnswerPath: 'direct' as const,
        expectedContextPressure: 'low' as const,
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        entities: {},
      },
    };
    state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-clarification',
        rootExecutionId: 'exec-clarification',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: continuity,
      routingContent: 'continue',
      gateway: clarificationGateway,
      nowMs: nowMs + 1,
    });
    const updated = state.updateContinuityThreadFromIntent({
      executionIdentity: {
        executionId: 'exec-clarification',
        rootExecutionId: 'exec-clarification',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: continuity,
      routingContent: 'continue',
      gateway: clarificationGateway,
    });

    expect(updated?.activeExecutionRefs).toEqual([
      {
        kind: 'execution',
        id: 'exec-coding',
        label: 'Continue the active MusicApp phase one build.',
      },
    ]);
    expect(state.getActiveExecution({
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: updated,
    })?.executionId).toBe('exec-coding');
  });

  it('drops internal fallback summaries from durable execution and continuity labels', () => {
    const nowMs = 1_710_000_000_100;
    const continuityStore = createContinuityStore(nowMs);
    const executionStore = createExecutionStore(nowMs);
    const state = new ChatAgentOrchestrationState({
      stateAgentId: 'assistant',
      continuityThreadStore: continuityStore,
      executionStore,
      tools: {
        getApprovalSummaries: () => new Map(),
      },
    });

    const routingContent = 'Inspect the repo and list the delegated worker progress files.';

    const execution = state.updateExecutionFromIntent({
      executionIdentity: {
        executionId: 'exec-2',
        rootExecutionId: 'exec-2',
      },
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      routingContent,
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: 'No direct route for this coding harness turn.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          preferredAnswerPath: 'direct',
          expectedContextPressure: 'low',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          entities: {},
        },
      },
      nowMs,
    });

    const continuity = state.updateContinuityThreadFromIntent({
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      continuityThread: null,
      executionIdentity: {
        executionId: 'exec-2',
        rootExecutionId: 'exec-2',
      },
      routingContent,
      gateway: {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: 'No direct route for this coding harness turn.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          preferredAnswerPath: 'direct',
          expectedContextPressure: 'low',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          entities: {},
        },
      },
    });

    expect(execution?.intent.summary).toBeUndefined();
    expect(executionStore.get('exec-2')?.intent.summary).toBeUndefined();
    expect(continuity?.focusSummary).toBeUndefined();
    expect(continuity?.safeSummary).toBeUndefined();
    expect(continuity?.activeExecutionRefs).toEqual([
      {
        kind: 'execution',
        id: 'exec-2',
        label: routingContent,
      },
    ]);
  });
});
