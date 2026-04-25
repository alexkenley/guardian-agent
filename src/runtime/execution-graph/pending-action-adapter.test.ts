import { describe, expect, it } from 'vitest';
import { PendingActionStore, toPendingActionClientMetadata } from '../pending-actions.js';
import { createExecutionGraphEvent } from './graph-events.js';
import {
  buildExecutionGraphResumePayload,
  readExecutionGraphResumePayload,
  recordGraphPendingActionInterrupt,
} from './pending-action-adapter.js';
import type { ExecutionArtifactRef } from './types.js';

describe('execution graph pending-action adapter', () => {
  it('records approval graph interrupts as pending actions with resume metadata', () => {
    const store = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-graph-pending-actions.test.sqlite',
      now: () => 1_000,
    });
    const writeSpec = buildWriteSpecRef();
    const event = createExecutionGraphEvent({
      eventId: 'event-approval-1',
      graphId: 'graph-1',
      executionId: 'exec-1',
      rootExecutionId: 'root-1',
      requestId: 'request-1',
      runId: 'request-1',
      nodeId: 'node-mutate',
      nodeKind: 'mutate',
      kind: 'approval_requested',
      timestamp: 1_100,
      sequence: 8,
      producer: 'supervisor',
      channel: 'web',
      agentId: 'guardian',
      userId: 'user-1',
      codeSessionId: 'code-1',
      payload: {
        approvalId: 'approval-1',
        toolName: 'fs_write',
        path: 'tmp/manual-web/secret-scan-paths.txt',
        summary: 'Approve writing the redacted secret scan output.',
      },
    });

    const record = recordGraphPendingActionInterrupt({
      store,
      scope: {
        agentId: 'guardian',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'surface-1',
      },
      event,
      originalUserContent: 'Search for secrets and write only path/line hits.',
      intent: {
        route: 'coding_task',
        operation: 'create',
        summary: 'Write redacted secret scan results.',
        resolvedContent: 'Search for secrets and write only path/line hits.',
      },
      artifactRefs: [writeSpec],
      nowMs: 1_000,
    });

    expect(record).toMatchObject({
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      executionId: 'exec-1',
      rootExecutionId: 'root-1',
      codeSessionId: 'code-1',
      blocker: {
        kind: 'approval',
        prompt: 'Approve writing the redacted secret scan output.',
        approvalIds: ['approval-1'],
        approvalSummaries: [{
          id: 'approval-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"tmp/manual-web/secret-scan-paths.txt"}',
        }],
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-1',
          nodeId: 'node-mutate',
          nodeKind: 'mutate',
          resumeToken: 'graph-1:node-mutate:8',
          artifactIds: ['write-spec-1'],
        },
      },
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        nodeKind: 'mutate',
        resumeToken: 'graph-1:node-mutate:8',
        artifactRefs: [{ artifactId: 'write-spec-1', artifactType: 'WriteSpec' }],
      },
    });
    expect(store.findActiveByApprovalId('approval-1')?.id).toBe(record?.id);
    expect(toPendingActionClientMetadata(record)).toMatchObject({
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        resumeToken: 'graph-1:node-mutate:8',
      },
    });
  });

  it('round-trips graph resume payloads without artifact contents', () => {
    const interrupt = {
      graphId: 'graph-1',
      nodeId: 'node-mutate',
      nodeKind: 'mutate' as const,
      resumeToken: 'resume-token',
      artifactRefs: [buildWriteSpecRef()],
    };

    const payload = buildExecutionGraphResumePayload(interrupt);

    expect(payload).toEqual({
      graphId: 'graph-1',
      nodeId: 'node-mutate',
      nodeKind: 'mutate',
      resumeToken: 'resume-token',
      artifactIds: ['write-spec-1'],
    });
    expect(readExecutionGraphResumePayload(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain('Write tmp/manual-web');
  });

  it('records clarification graph interrupts as linked pending actions', () => {
    const store = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-graph-clarification-actions.test.sqlite',
      now: () => 2_000,
    });
    const event = createExecutionGraphEvent({
      eventId: 'event-clarification-1',
      graphId: 'graph-clarification',
      executionId: 'exec-clarification',
      rootExecutionId: 'root-clarification',
      requestId: 'request-clarification',
      runId: 'request-clarification',
      nodeId: 'node-plan',
      nodeKind: 'plan',
      kind: 'clarification_requested',
      timestamp: 2_100,
      sequence: 3,
      producer: 'runtime',
      channel: 'web',
      agentId: 'guardian',
      userId: 'user-1',
      payload: {
        clarificationId: 'clarification-1',
        field: 'target_file',
        question: 'Which file should receive the generated note?',
        options: [
          { value: 'tmp/manual-web/note.txt', label: 'manual web note' },
          'tmp/manual-web/alternate-note.txt',
        ],
      },
    });

    const record = recordGraphPendingActionInterrupt({
      store,
      scope: {
        agentId: 'guardian',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'surface-1',
      },
      event,
      originalUserContent: 'Write a note after deciding where it belongs.',
      intent: {
        route: 'coding_task',
        operation: 'create',
        summary: 'Write a note after choosing the target file.',
        missingFields: ['target_file'],
      },
      nowMs: 2_000,
    });

    expect(record).toMatchObject({
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      executionId: 'exec-clarification',
      rootExecutionId: 'root-clarification',
      blocker: {
        kind: 'clarification',
        prompt: 'Which file should receive the generated note?',
        field: 'target_file',
        options: [
          { value: 'tmp/manual-web/note.txt', label: 'manual web note' },
          { value: 'tmp/manual-web/alternate-note.txt', label: 'tmp/manual-web/alternate-note.txt' },
        ],
        metadata: {
          graphId: 'graph-clarification',
          nodeId: 'node-plan',
          resumeToken: 'graph-clarification:node-plan:3',
          clarificationId: 'clarification-1',
        },
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-clarification',
          nodeId: 'node-plan',
          nodeKind: 'plan',
          resumeToken: 'graph-clarification:node-plan:3',
          artifactIds: [],
        },
      },
      graphInterrupt: {
        graphId: 'graph-clarification',
        nodeId: 'node-plan',
        nodeKind: 'plan',
        resumeToken: 'graph-clarification:node-plan:3',
      },
    });
    expect(toPendingActionClientMetadata(record)).toMatchObject({
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'clarification',
        field: 'target_file',
      },
      graphInterrupt: {
        graphId: 'graph-clarification',
        nodeId: 'node-plan',
        resumeToken: 'graph-clarification:node-plan:3',
      },
    });
  });
});

function buildWriteSpecRef(): ExecutionArtifactRef {
  return {
    artifactId: 'write-spec-1',
    graphId: 'graph-1',
    nodeId: 'node-synthesize',
    artifactType: 'WriteSpec',
    label: 'Write spec',
    preview: 'Write tmp/manual-web/secret-scan-paths.txt.',
    trustLevel: 'trusted',
    redactionPolicy: 'no_secret_values',
    createdAt: 900,
  };
}
