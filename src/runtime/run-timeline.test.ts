import { describe, expect, it } from 'vitest';
import type { CodeSessionRecord } from './code-sessions.js';
import type { AssistantDispatchTrace } from './orchestrator.js';
import { RunTimelineStore } from './run-timeline.js';

function createCodeSession(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<CodeSessionRecord['workState']> = {},
): CodeSessionRecord {
  return {
    id: sessionId,
    ownerUserId: 'owner',
    ownerPrincipalId: 'owner',
    title: 'Repo Fix',
    workspaceRoot: '/repo',
    resolvedRoot: '/repo',
    agentId: 'coder',
    status: 'active',
    attachmentPolicy: 'explicit_only',
    createdAt: updatedAt - 1_000,
    updatedAt,
    lastActivityAt: updatedAt,
    conversationUserId: `code-session:${sessionId}`,
    conversationChannel: 'code-session',
    uiState: {
      currentDirectory: '/repo',
      selectedFilePath: null,
      showDiff: false,
      expandedDirs: [],
      terminalCollapsed: false,
      terminalTabs: [],
    },
    workState: {
      focusSummary: '',
      planSummary: '',
      compactedSummary: '',
      workspaceProfile: null,
      workspaceTrust: null,
      workspaceTrustReview: null,
      workspaceMap: null,
      workingSet: null,
      activeSkills: [],
      pendingApprovals: [],
      recentJobs: [],
      changedFiles: [],
      verification: [],
      ...overrides,
    },
  };
}

function createTrace(overrides: Partial<AssistantDispatchTrace> = {}): AssistantDispatchTrace {
  return {
    requestId: 'req-1',
    runId: 'req-1',
    groupId: 'web:code-session:coder',
    sessionId: 'web:code-session:coder',
    agentId: 'coder',
    userId: 'owner',
    channel: 'web',
    requestType: 'code',
    priority: 'normal',
    status: 'succeeded',
    queuedAt: 100,
    startedAt: 110,
    completedAt: 170,
    queueWaitMs: 10,
    executionMs: 60,
    endToEndMs: 70,
    messagePreview: 'Fix the failing tests in the repo',
    responsePreview: 'Applied a patch and queued verification.',
    steps: [],
    nodes: [{
      id: 'tool-1',
      kind: 'tool_call',
      name: 'code_patch',
      startedAt: 120,
      completedAt: 140,
      status: 'succeeded',
      metadata: {
        result: {
          message: 'Patch applied.',
        },
      },
    }],
    ...overrides,
  };
}

describe('RunTimelineStore', () => {
  it('merges assistant traces with code-session activity using requestId correlation', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace());
    store.ingestCodeSession(createCodeSession('code-1', 180, {
      pendingApprovals: [{
        id: 'approval-1',
        toolName: 'code_write',
        argsPreview: 'Write src/app.ts',
        createdAt: 175,
        requestId: 'req-1',
      }],
      recentJobs: [{
        id: 'job-1',
        toolName: 'code_patch',
        status: 'succeeded',
        createdAt: 120,
        completedAt: 140,
        requestId: 'req-1',
        resultPreview: 'Patch applied.',
      }],
    }));

    const run = store.getRun('req-1');
    expect(run?.summary.kind).toBe('assistant_dispatch');
    expect(run?.summary.codeSessionId).toBe('code-1');
    expect(run?.summary.status).toBe('awaiting_approval');
    expect(run?.items.some((item) => item.type === 'approval_requested')).toBe(true);
    expect(run?.items.some((item) => item.type === 'tool_call_completed')).toBe(true);
  });

  it('records approval resolution when a pending approval clears on a later session update', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestCodeSession(createCodeSession('code-2', 200, {
      pendingApprovals: [{
        id: 'approval-2',
        toolName: 'code_write',
        argsPreview: 'Write src/index.ts',
        createdAt: 190,
        requestId: 'req-2',
      }],
    }));

    store.ingestCodeSession(createCodeSession('code-2', 260, {
      pendingApprovals: [],
      recentJobs: [{
        id: 'job-2',
        toolName: 'code_write',
        status: 'denied',
        createdAt: 190,
        completedAt: 255,
        approvalId: 'approval-2',
        requestId: 'req-2',
        error: 'Denied by user.',
      }],
    }));

    const run = store.getRun('req-2');
    expect(run?.summary.pendingApprovalCount).toBe(0);
    expect(run?.items.some((item) => item.id === 'approval:approval-2:resolved')).toBe(true);
    expect(run?.items.some((item) => item.type === 'tool_call_completed' && item.status === 'blocked')).toBe(true);
  });

  it('adds live delegated-coding progress to the correlated run timeline', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-backend',
      runId: 'req-backend',
      status: 'running',
      completedAt: undefined,
      responsePreview: undefined,
      nodes: [],
    }));

    store.ingestCodingBackendProgress({
      id: 'cb-1',
      kind: 'started',
      runId: 'req-backend',
      requestId: 'req-backend',
      codeSessionId: 'code-1',
      sessionId: 'cb-session-1',
      terminalId: 'term-1',
      backendId: 'codex',
      backendName: 'OpenAI Codex CLI',
      task: 'Inspect the repo and fix the failing tests',
      timestamp: 120,
      detail: 'Inspect the repo and fix the failing tests',
    });
    store.ingestCodingBackendProgress({
      id: 'cb-2',
      kind: 'progress',
      runId: 'req-backend',
      requestId: 'req-backend',
      codeSessionId: 'code-1',
      sessionId: 'cb-session-1',
      terminalId: 'term-1',
      backendId: 'codex',
      backendName: 'OpenAI Codex CLI',
      task: 'Inspect the repo and fix the failing tests',
      timestamp: 135,
      detail: 'Running targeted tests for auth helpers.',
    });

    const run = store.getRun('req-backend');
    expect(run?.summary.codeSessionId).toBe('code-1');
    expect(run?.summary.status).toBe('running');
    expect(run?.items.some((item) => item.title === 'Delegated to OpenAI Codex CLI')).toBe(true);
    expect(run?.items.some((item) => item.title === 'OpenAI Codex CLI is working' && item.detail === 'Running targeted tests for auth helpers.')).toBe(true);
  });

  it('strips the web-ui context prefix from assistant run titles and details', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-context',
      runId: 'req-context',
      messagePreview: '[Context: User is currently viewing the automations panel] Run Browser Read Smoke now.',
      responsePreview: 'Ran the automation successfully.',
    }));

    const run = store.getRun('req-context');
    expect(run?.summary.title).toBe('Run Browser Read Smoke now.');
    expect(run?.items[0]?.detail).toBe('Run Browser Read Smoke now.');
  });

  it('adds humanized orchestrator step items for ordinary assistant runs', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-steps',
      runId: 'req-steps',
      status: 'running',
      completedAt: undefined,
      steps: [
        {
          name: 'message_built',
          status: 'succeeded',
          startedAt: 112,
          completedAt: 112,
          durationMs: 0,
        },
        {
          name: 'runtime_dispatch_message',
          status: 'running',
          startedAt: 115,
        },
      ],
      nodes: [],
    }));

    const run = store.getRun('req-steps');
    expect(run?.items.some((item) => item.title === 'Prepared request')).toBe(true);
    expect(run?.items.some((item) => item.title === 'Agent is working')).toBe(true);
  });

  it('renders provider-call trace nodes with bounded usage detail', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-provider',
      runId: 'req-provider',
      steps: [],
      nodes: [{
        id: 'provider-1',
        kind: 'provider_call',
        name: 'Model response: ollama • llama3.1',
        startedAt: 118,
        completedAt: 132,
        status: 'succeeded',
        metadata: {
          detail: 'provider=ollama; model=llama3.1; locality=local; duration=14ms; 920 tokens | 800 prompt | 120 completion',
        },
      }],
    }));

    const run = store.getRun('req-provider');
    const item = run?.items.find((entry) => entry.id === 'node:provider-1:note');
    expect(item?.title).toBe('Model response: ollama • llama3.1');
    expect(item?.detail).toContain('920 tokens');
  });

  it('surfaces context assembly trace details from compile nodes', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-context-assembly',
      runId: 'req-context-assembly',
      steps: [],
      nodes: [{
        id: 'compile-1',
        kind: 'compile',
        name: 'Assembled context',
        startedAt: 118,
        completedAt: 119,
        status: 'succeeded',
        metadata: {
          summary: 'global memory loaded | coding memory loaded | continuity 2 surfaces | blocker approval',
          detail: 'memoryScope=global; knowledgeBase=188 chars; codingMemory=76 chars; continuityKey=continuity-1; linkedSurfaces=2; pendingAction=approval',
          memoryScope: 'global',
          knowledgeBaseLoaded: true,
          codingMemoryLoaded: true,
          codingMemoryChars: 76,
          contextCompactionApplied: true,
          contextCharsBeforeCompaction: 9800,
          contextCharsAfterCompaction: 4200,
          contextCompactionStages: ['truncate_tool_calls', 'truncate_tool_results'],
          compactedSummaryPreview: 'Compacted prior work summary: importer retries and verification steps.',
          knowledgeBaseQueryPreview: 'importer overhaul verification checkpoints',
          activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
          selectedMemoryEntryCount: 2,
          omittedMemoryEntryCount: 1,
          selectedMemoryEntries: [
            {
              scope: 'coding_session',
              category: 'Project Notes',
              createdAt: '2026-03-20',
              preview: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
              renderMode: 'summary',
              queryScore: 312,
              isContextFlush: false,
              matchReasons: ['query summary', 'summary terms 4'],
            },
          ],
        },
      }],
    }));

    const run = store.getRun('req-context-assembly');
    expect(run?.items.some((item) =>
      item.title === 'Assembled context'
      && item.detail === 'memoryScope=global; knowledgeBase=188 chars; codingMemory=76 chars; continuityKey=continuity-1; linkedSurfaces=2; pendingAction=approval'
    )).toBe(true);
    const contextItem = run?.items.find((item) => item.title === 'Assembled context');
    expect(contextItem?.contextAssembly?.memoryScope).toBe('global');
    expect(contextItem?.contextAssembly?.codingMemoryLoaded).toBe(true);
    expect(contextItem?.contextAssembly?.codingMemoryChars).toBe(76);
    expect(contextItem?.contextAssembly?.contextCompactionApplied).toBe(true);
    expect(contextItem?.contextAssembly?.contextCharsBeforeCompaction).toBe(9800);
    expect(contextItem?.contextAssembly?.contextCharsAfterCompaction).toBe(4200);
    expect(contextItem?.contextAssembly?.contextCompactionStages).toEqual(['truncate_tool_calls', 'truncate_tool_results']);
    expect(contextItem?.contextAssembly?.compactedSummaryPreview).toContain('Compacted prior work summary');
    expect(contextItem?.contextAssembly?.knowledgeBaseQueryPreview).toBe('importer overhaul verification checkpoints');
    expect(contextItem?.contextAssembly?.activeExecutionRefs).toEqual(['code_session:Repo Fix', 'pending_action:approval-1']);
    expect(contextItem?.contextAssembly?.selectedMemoryEntries?.[0]?.scope).toBe('coding_session');
    expect(contextItem?.contextAssembly?.selectedMemoryEntries?.[0]?.category).toBe('Project Notes');
    expect(contextItem?.contextAssembly?.selectedMemoryEntries?.[0]?.matchReasons).toEqual(['query summary', 'summary terms 4']);
  });

  it('preserves section footprints and execution state in context assembly timeline details', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-context-state',
      runId: 'req-context-state',
      nodes: [{
        id: 'compile-context-state',
        kind: 'compile',
        name: 'Assembled context',
        startedAt: 118,
        completedAt: 119,
        status: 'succeeded',
        metadata: {
          summary: 'global memory loaded | sections tool_context:420',
          detail: 'memoryScope=global; objective="Fix importer"',
          sectionFootprints: [
            { section: 'tool_context', chars: 420, included: true, mode: 'inventory' },
          ],
          preservedExecutionState: {
            objective: 'Fix importer',
            blockerSummary: 'approval | coding_task | Approve the write operation.',
            maintainedSummarySource: 'code_session_compacted_summary',
          },
        },
      }],
    }));

    const contextItem = store.getRun('req-context-state')?.items.find((item) => item.title === 'Assembled context');
    expect(contextItem?.contextAssembly?.sectionFootprints?.[0]).toMatchObject({
      section: 'tool_context',
      chars: 420,
      included: true,
      mode: 'inventory',
    });
    expect(contextItem?.contextAssembly?.preservedExecutionState).toEqual({
      objective: 'Fix importer',
      blockerSummary: 'approval | coding_task | Approve the write operation.',
      maintainedSummarySource: 'code_session_compacted_summary',
    });
  });

  it('filters runs by continuity key and active execution ref from context assembly details', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-match',
      runId: 'req-match',
      nodes: [{
        id: 'compile-match',
        kind: 'compile',
        name: 'Assembled context',
        startedAt: 118,
        completedAt: 119,
        status: 'succeeded',
        metadata: {
          summary: 'global memory loaded | continuity 2 surfaces',
          detail: 'memoryScope=global; continuityKey=continuity-keep',
          continuityKey: 'continuity-keep',
          activeExecutionRefs: ['code_session:Repo Fix'],
        },
      }],
    }));
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-other',
      runId: 'req-other',
      nodes: [{
        id: 'compile-other',
        kind: 'compile',
        name: 'Assembled context',
        startedAt: 118,
        completedAt: 119,
        status: 'succeeded',
        metadata: {
          summary: 'global memory loaded | continuity 1 surface',
          detail: 'memoryScope=global; continuityKey=continuity-other',
          continuityKey: 'continuity-other',
          activeExecutionRefs: ['pending_action:approval-2'],
        },
      }],
    }));

    expect(store.listRuns({ continuityKey: 'continuity-keep' }).map((run) => run.summary.runId)).toEqual(['req-match']);
    expect(store.listRuns({ activeExecutionRef: 'repo fix' }).map((run) => run.summary.runId)).toEqual(['req-match']);
    expect(store.listRuns({
      continuityKey: 'continuity-keep',
      activeExecutionRef: 'approval-2',
    })).toEqual([]);
  });

  it('renders delegated handoff nodes with blocked follow-up detail', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-handoff',
      runId: 'req-handoff',
      nodes: [{
        id: 'handoff-1',
        kind: 'handoff',
        name: 'Delegated follow-up',
        startedAt: 130,
        completedAt: 132,
        status: 'blocked',
        metadata: {
          summary: 'Waiting for approval to write the report.',
          detail: 'Resolve the pending approval(s) to continue the delegated run.',
          reportingMode: 'held_for_approval',
          unresolvedBlockerKind: 'approval',
          approvalCount: 1,
        },
      }],
    }));

    const run = store.getRun('req-handoff');
    expect(run?.items.some((item) =>
      item.type === 'handoff_completed'
      && item.status === 'blocked'
      && item.title === 'Handoff blocked: Delegated follow-up'
      && item.detail === 'Resolve the pending approval(s) to continue the delegated run.'
    )).toBe(true);
  });

  it('projects delegated worker lifecycle updates into the correlated run timeline', () => {
    const store = new RunTimelineStore({ now: () => 500 });
    store.ingestAssistantTrace(createTrace({
      requestId: 'req-delegated-worker',
      runId: 'req-delegated-worker',
      status: 'running',
      completedAt: undefined,
      responsePreview: undefined,
      nodes: [],
    }));

    store.ingestDelegatedWorkerProgress({
      id: 'delegated-1',
      kind: 'started',
      requestId: 'req-delegated-worker',
      codeSessionId: 'code-1',
      agentId: 'agent-1',
      agentName: 'Workspace Implementer',
      orchestrationLabel: 'Coding Workspace',
      originChannel: 'web',
      requestPreview: 'Create the fix and verify the result.',
      continuityKey: 'continuity-1',
      activeExecutionRefs: ['code_session:Repo Fix'],
      timestamp: 120,
      detail: 'Brokered worker dispatch started.',
    });
    store.ingestDelegatedWorkerProgress({
      id: 'delegated-2',
      kind: 'running',
      requestId: 'req-delegated-worker',
      codeSessionId: 'code-1',
      agentId: 'agent-1',
      agentName: 'Workspace Implementer',
      orchestrationLabel: 'Coding Workspace',
      originChannel: 'web',
      requestPreview: 'Create the fix and verify the result.',
      continuityKey: 'continuity-1',
      activeExecutionRefs: ['code_session:Repo Fix'],
      timestamp: 130,
      detail: 'Worker worker-1 is processing the delegated request in code session code-1.',
    });
    store.ingestDelegatedWorkerProgress({
      id: 'delegated-3',
      kind: 'blocked',
      requestId: 'req-delegated-worker',
      codeSessionId: 'code-1',
      agentId: 'agent-1',
      agentName: 'Workspace Implementer',
      orchestrationLabel: 'Coding Workspace',
      originChannel: 'web',
      requestPreview: 'Create the fix and verify the result.',
      continuityKey: 'continuity-1',
      activeExecutionRefs: ['code_session:Repo Fix'],
      unresolvedBlockerKind: 'approval',
      approvalCount: 1,
      reportingMode: 'held_for_approval',
      timestamp: 140,
      detail: 'Resolve the pending approval(s) to continue the delegated run.',
    });

    const run = store.getRun('req-delegated-worker');
    expect(run?.summary.codeSessionId).toBe('code-1');
    expect(run?.summary.status).toBe('running');
    expect(run?.items.some((item) =>
      item.type === 'handoff_started'
      && item.title === 'Delegated to Workspace Implementer'
    )).toBe(true);
    const progressItem = run?.items.find((item) => item.id === 'delegated-2');
    expect(progressItem).toMatchObject({
      type: 'note',
      status: 'running',
      title: 'Workspace Implementer is working',
      detail: 'Worker worker-1 is processing the delegated request in code session code-1.',
      contextAssembly: {
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix'],
      },
    });
    expect(run?.items.some((item) =>
      item.type === 'handoff_completed'
      && item.status === 'blocked'
      && item.title === 'Workspace Implementer is waiting'
    )).toBe(true);
    expect(run?.items.find((item) => item.id === 'delegated-3')).toMatchObject({
      type: 'handoff_completed',
      status: 'blocked',
      title: 'Workspace Implementer is waiting',
      detail: 'Resolve the pending approval(s) to continue the delegated run.',
      contextAssembly: {
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix'],
      },
    });
    expect(store.listRuns({ continuityKey: 'continuity-1' }).map((entry) => entry.summary.runId)).toEqual([
      'req-delegated-worker',
    ]);
    expect(store.listRuns({ activeExecutionRef: 'repo fix' }).map((entry) => entry.summary.runId)).toEqual([
      'req-delegated-worker',
    ]);
  });
});
