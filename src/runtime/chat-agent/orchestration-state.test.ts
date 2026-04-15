import { describe, expect, it } from 'vitest';

import { PendingActionStore } from '../pending-actions.js';
import { ChatAgentOrchestrationState } from './orchestration-state.js';

function createStore(nowMs = 1_710_000_000_000): PendingActionStore {
  return new PendingActionStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-orchestration-state.test.sqlite',
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
          kind: 'direct_route',
          payload: {
            type: 'filesystem_save_output',
            targetPath: 'S:\\Development\\test5',
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
    expect(pendingAction?.resume?.kind).toBe('direct_route');
  });
});
