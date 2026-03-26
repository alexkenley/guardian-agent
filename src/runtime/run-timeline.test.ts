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
      activeAssistantTab: 'activity',
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
});
