import { describe, expect, it } from 'vitest';
import { createExecutionGraphEvent } from './graph-events.js';
import { projectExecutionGraphEventToTimeline } from './timeline-adapter.js';

describe('execution graph timeline adapter', () => {
  it('projects read-only graph tool calls into bounded timeline items', () => {
    const started = projectExecutionGraphEventToTimeline(createExecutionGraphEvent({
      eventId: 'event-tool-started',
      graphId: 'graph-1',
      executionId: 'exec-1',
      rootExecutionId: 'root-1',
      requestId: 'req-1',
      runId: 'req-1',
      nodeId: 'node-1',
      nodeKind: 'explore_readonly',
      kind: 'tool_call_started',
      timestamp: 110,
      sequence: 2,
      producer: 'brokered_worker',
      channel: 'web',
      agentId: 'guardian',
      codeSessionId: 'code-1',
      payload: {
        toolName: 'fs_search',
        argsPreview: '{"query":"direct reasoning"}',
      },
    }));

    expect(started?.summary).toMatchObject({
      executionId: 'exec-1',
      rootExecutionId: 'root-1',
      channel: 'web',
      agentId: 'guardian',
      codeSessionId: 'code-1',
      title: 'Direct reasoning exploration',
    });
    expect(started?.items[0]).toMatchObject({
      runId: 'req-1',
      type: 'tool_call_started',
      status: 'running',
      source: 'execution_graph',
      title: 'Tool started: Fs Search',
      toolName: 'fs_search',
      nodeId: 'node-1',
    });
    expect(started?.items[0]?.detail).toBe('{"query":"direct reasoning"}');
  });

  it('projects approval and terminal graph events without raw payload expansion', () => {
    const approval = projectExecutionGraphEventToTimeline(createExecutionGraphEvent({
      eventId: 'event-approval',
      graphId: 'graph-approval',
      executionId: 'exec-approval',
      rootExecutionId: 'exec-approval',
      requestId: 'req-approval',
      nodeId: 'node-approval',
      nodeKind: 'approval_interrupt',
      kind: 'approval_requested',
      timestamp: 200,
      sequence: 5,
      producer: 'runtime',
      payload: {
        approvalId: 'approval-1',
        summary: 'Approve the write operation.',
        rawPrompt: 'This raw prompt should not appear.',
      },
    }));

    expect(approval?.baseStatus).toBe('awaiting_approval');
    expect(approval?.items[0]).toMatchObject({
      type: 'approval_requested',
      status: 'blocked',
      source: 'execution_graph',
      approvalId: 'approval-1',
      detail: 'Approve the write operation.',
    });
    expect(approval?.items[0]?.detail).not.toContain('raw prompt');
  });
});
