import { describe, expect, it } from 'vitest';
import { ExecutionGraphStore } from '../execution-graph/graph-store.js';
import { buildGraphPendingActionReplacement } from '../execution-graph/pending-action-adapter.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  completeChatContinuationGraphResume,
  recordChatContinuationGraphApproval,
  startChatContinuationGraphApprovalResume,
} from './chat-continuation-graph.js';

describe('chat continuation graph approval resume', () => {
  it('owns approval-resolution lifecycle events and completion metadata', () => {
    const graphStore = new ExecutionGraphStore({ now: fixedNow(1_000) });
    const pendingAction = createPendingAction(graphStore);
    const completed: Array<{ actionId: string; nowMs: number }> = [];

    const started = startChatContinuationGraphApprovalResume({
      graphStore,
      pendingAction,
      approvalId: 'approval-1',
      approvalResult: { approved: true },
      completePendingAction: (actionId, nowMs) => completed.push({ actionId, nowMs }),
      nowMs: 2_000,
    });

    expect(started?.approved).toBe(true);
    expect(completed).toEqual([{ actionId: 'pending-1', nowMs: 2_000 }]);

    const response = completeChatContinuationGraphResume({
      graphStore,
      resume: started!.resume,
      response: { content: 'Saved.' },
      nowMs: 2_100,
    });

    expect(response).toEqual({
      content: 'Saved.',
      metadata: {
        executionGraph: {
          graphId: started!.resume.graph.graphId,
          status: 'completed',
          continuationArtifactId: started!.resume.artifact.artifactId,
        },
      },
    });

    const events = graphStore.getSnapshot(started!.resume.graph.graphId)?.events ?? [];
    expect(events.map((event) => [event.kind, event.payload.resultStatus])).toEqual([
      ['graph_started', undefined],
      ['artifact_created', undefined],
      ['interruption_requested', undefined],
      ['interruption_resolved', 'approved'],
      ['graph_completed', 'completed'],
    ]);
  });

  it('emits denied approval terminal state without invoking payload-specific replay', () => {
    const graphStore = new ExecutionGraphStore({ now: fixedNow(1_000) });
    const pendingAction = createPendingAction(graphStore);

    const started = startChatContinuationGraphApprovalResume({
      graphStore,
      pendingAction,
      approvalId: 'approval-1',
      approvalResult: {
        approved: false,
        message: 'Denied by operator.',
      },
      completePendingAction: () => {},
      nowMs: 2_000,
    });

    expect(started).toMatchObject({
      approved: false,
      deniedResponse: {
        content: 'Denied by operator.',
        metadata: {
          executionGraph: {
            graphId: started!.resume.graph.graphId,
            status: 'failed',
            reason: 'approval_denied',
          },
        },
      },
    });

    const events = graphStore.getSnapshot(started!.resume.graph.graphId)?.events ?? [];
    expect(events.map((event) => [event.kind, event.payload.resultStatus, event.payload.reason])).toEqual([
      ['graph_started', undefined, undefined],
      ['artifact_created', undefined, undefined],
      ['interruption_requested', undefined, undefined],
      ['interruption_resolved', 'denied', undefined],
      ['graph_failed', undefined, 'Denied by operator.'],
    ]);
  });
});

function createPendingAction(graphStore: ExecutionGraphStore): PendingActionRecord {
  let pendingAction: PendingActionRecord | null = null;
  recordChatContinuationGraphApproval({
    graphStore,
    userKey: 'user-1:web',
    userId: 'user-1',
    channel: 'web',
    surfaceId: 'surface-1',
    agentId: 'guardian',
    requestId: 'request-1',
    action: {
      prompt: 'Approve save?',
      approvalIds: ['approval-1'],
      originalUserContent: 'Save the answer.',
      continuation: {
        type: 'filesystem_save_output',
        targetPath: 'tmp/out.txt',
        content: 'hello',
        originalUserContent: 'Save the answer.',
        allowPathRemediation: false,
      },
    },
    setGraphPendingActionForRequest: (_userKey, _surfaceId, action, nowMs) => {
      const replacement = buildGraphPendingActionReplacement({
        event: action.event,
        originalUserContent: action.originalUserContent,
        intent: action.intent,
        artifactRefs: action.artifactRefs,
        approvalSummaries: action.approvalSummaries,
        nowMs,
      });
      if (!replacement) {
        throw new Error('expected graph pending action replacement');
      }
      pendingAction = {
        id: 'pending-1',
        scope: {
          agentId: 'guardian',
          userId: 'user-1',
          channel: 'web',
          surfaceId: 'surface-1',
        },
        createdAt: nowMs ?? 1_000,
        updatedAt: nowMs ?? 1_000,
        ...replacement,
      };
      return { action: pendingAction };
    },
    nowMs: 1_000,
  });
  if (!pendingAction) {
    throw new Error('expected pending action');
  }
  return pendingAction;
}

function fixedNow(start: number): () => number {
  let current = start;
  return () => current++;
}
