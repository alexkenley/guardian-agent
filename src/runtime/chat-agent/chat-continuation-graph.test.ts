import { describe, expect, it } from 'vitest';
import { ExecutionGraphStore } from '../execution-graph/graph-store.js';
import { buildGraphPendingActionReplacement } from '../execution-graph/pending-action-adapter.js';
import {
  toPendingActionClientMetadata,
  type PendingActionRecord,
} from '../pending-actions.js';
import {
  completeChatContinuationGraphResume,
  recordChatContinuationGraphApproval,
  readChatContinuationGraphResume,
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

  it('keeps suspended tool-loop replay state inside the graph artifact, not pending-action client metadata', () => {
    const graphStore = new ExecutionGraphStore({ now: fixedNow(1_000) });
    const pendingAction = createPendingAction(graphStore, {
      prompt: 'Approve write?',
      approvalIds: ['approval-tool-1'],
      originalUserContent: 'Create the requested file.',
      route: 'coding_task',
      operation: 'update',
      summary: 'Resume a suspended tool loop after approval.',
      continuation: {
        type: 'suspended_tool_loop',
        llmMessages: [
          { role: 'user', content: 'Write the private plan to tmp/secret.txt.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call-1',
              name: 'fs_write',
              arguments: '{"path":"tmp/secret.txt","content":"classified"}',
            }],
          },
        ],
        pendingTools: [{
          approvalId: 'approval-tool-1',
          toolCallId: 'call-1',
          jobId: 'job-1',
          name: 'fs_write',
        }],
        originalMessage: {
          id: 'message-1',
          userId: 'user-1',
          channel: 'web',
          surfaceId: 'surface-1',
          timestamp: 1_000,
          content: 'Write the private plan to tmp/secret.txt.',
        },
        requestText: 'Write the private plan to tmp/secret.txt.',
        referenceTime: 1_000,
        allowModelMemoryMutation: false,
        activeSkillIds: ['coding'],
        contentTrustLevel: 'trusted',
        taintReasons: [],
      },
    });

    expect(pendingAction.resume?.kind).toBe('execution_graph');
    const artifactRef = pendingAction.graphInterrupt?.artifactRefs[0];
    expect(artifactRef).toMatchObject({
      artifactType: 'ChatContinuation',
      label: 'Tool-loop continuation',
      preview: 'Resume 1 approved tool call.',
      redactionPolicy: 'internal_resume_payload',
    });

    const graphId = String(pendingAction.resume?.payload.graphId);
    const artifact = graphStore.getArtifact(graphId, artifactRef!.artifactId);
    expect(artifact).toMatchObject({
      artifactType: 'ChatContinuation',
      label: 'Tool-loop continuation',
      refs: ['fs_write'],
      redactionPolicy: 'internal_resume_payload',
      content: {
        type: 'chat_continuation',
        payload: {
          type: 'suspended_tool_loop',
          requestText: 'Write the private plan to tmp/secret.txt.',
        },
      },
    });

    const resume = readChatContinuationGraphResume({ graphStore, pendingAction });
    expect(resume?.payload).toMatchObject({
      type: 'suspended_tool_loop',
      pendingTools: [{ approvalId: 'approval-tool-1', name: 'fs_write' }],
    });

    const clientMetadataJson = JSON.stringify(toPendingActionClientMetadata(pendingAction));
    expect(clientMetadataJson).toContain('Tool-loop continuation');
    expect(clientMetadataJson).not.toContain('llmMessages');
    expect(clientMetadataJson).not.toContain('requestText');
    expect(clientMetadataJson).not.toContain('Write the private plan');
    expect(clientMetadataJson).not.toContain('classified');
  });
});

function createPendingAction(
  graphStore: ExecutionGraphStore,
  overrides: Partial<Parameters<typeof recordChatContinuationGraphApproval>[0]['action']> = {},
): PendingActionRecord {
  let pendingAction: PendingActionRecord | null = null;
  const continuation: Parameters<typeof recordChatContinuationGraphApproval>[0]['action']['continuation'] = overrides.continuation ?? {
    type: 'filesystem_save_output',
    targetPath: 'tmp/out.txt',
    content: 'hello',
    originalUserContent: 'Save the answer.',
    allowPathRemediation: false,
  };
  recordChatContinuationGraphApproval({
    graphStore,
    userKey: 'user-1:web',
    userId: 'user-1',
    channel: 'web',
    surfaceId: 'surface-1',
    agentId: 'guardian',
    requestId: 'request-1',
    action: {
      ...overrides,
      prompt: overrides.prompt ?? 'Approve save?',
      approvalIds: overrides.approvalIds ?? ['approval-1'],
      originalUserContent: overrides.originalUserContent ?? 'Save the answer.',
      route: overrides.route,
      operation: overrides.operation,
      summary: overrides.summary,
      turnRelation: overrides.turnRelation,
      resolution: overrides.resolution,
      missingFields: overrides.missingFields,
      provenance: overrides.provenance,
      entities: overrides.entities,
      continuation,
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
