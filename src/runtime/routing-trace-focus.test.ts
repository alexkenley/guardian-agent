import { describe, expect, it } from 'vitest';
import { pickRoutingTraceFocusItem } from './routing-trace-focus.js';
import type { DashboardRunDetail } from './run-timeline.js';

function makeRun(items: DashboardRunDetail['items']): DashboardRunDetail {
  return {
    summary: {
      runId: 'run-1',
      groupId: 'group-1',
      kind: 'assistant_dispatch',
      status: 'completed',
      title: 'Test run',
      startedAt: 1,
      lastUpdatedAt: 2,
      pendingApprovalCount: 0,
      verificationPendingCount: 0,
      tags: [],
    },
    items,
  };
}

describe('pickRoutingTraceFocusItem', () => {
  it('prefers the assembled-context node for gateway and dispatch stages', () => {
    const run = makeRun([
      {
        id: 'item-prepared',
        runId: 'run-1',
        timestamp: 1,
        type: 'note',
        status: 'info',
        source: 'orchestrator',
        title: 'Prepared request',
      },
      {
        id: 'item-context',
        runId: 'run-1',
        timestamp: 2,
        type: 'note',
        status: 'info',
        source: 'orchestrator',
        title: 'Assembled context',
        nodeId: 'compile-1',
        contextAssembly: {
          summary: 'global memory loaded',
          detail: 'memoryScope=global',
          memoryScope: 'global',
          knowledgeBaseLoaded: true,
        },
      },
    ]);

    const focus = pickRoutingTraceFocusItem({ stage: 'dispatch_response', details: {} }, run);

    expect(focus).toEqual({
      itemId: 'item-context',
      title: 'Assembled context',
      nodeId: 'compile-1',
    });
  });

  it('prefers the matching completed tool call when the routing trace references a tool', () => {
    const run = makeRun([
      {
        id: 'tool-a',
        runId: 'run-1',
        timestamp: 2,
        type: 'tool_call_completed',
        status: 'succeeded',
        source: 'orchestrator',
        title: 'Tool completed: Browser Navigate',
        toolName: 'browser_navigate',
      },
      {
        id: 'tool-b',
        runId: 'run-1',
        timestamp: 3,
        type: 'tool_call_completed',
        status: 'succeeded',
        source: 'orchestrator',
        title: 'Tool completed: Browser Read',
        toolName: 'browser_read',
      },
    ]);

    const focus = pickRoutingTraceFocusItem({
      stage: 'direct_tool_call_completed',
      details: { toolName: 'browser_read' },
    }, run);

    expect(focus).toEqual({
      itemId: 'tool-b',
      title: 'Tool completed: Browser Read',
    });
  });

  it('prefers approval events for clarification stages', () => {
    const run = makeRun([
      {
        id: 'item-context',
        runId: 'run-1',
        timestamp: 2,
        type: 'note',
        status: 'info',
        source: 'orchestrator',
        title: 'Assembled context',
      },
      {
        id: 'item-approval',
        runId: 'run-1',
        timestamp: 3,
        type: 'approval_requested',
        status: 'blocked',
        source: 'workflow',
        title: 'Approval requested',
        nodeId: 'approval-1',
      },
    ]);

    const focus = pickRoutingTraceFocusItem({ stage: 'clarification_requested', details: {} }, run);

    expect(focus).toEqual({
      itemId: 'item-approval',
      title: 'Approval requested',
      nodeId: 'approval-1',
    });
  });

  it('prefers delegated-worker lifecycle items for delegated worker stages', () => {
    const run = makeRun([
      {
        id: 'handoff-started',
        runId: 'run-1',
        timestamp: 2,
        type: 'handoff_started',
        status: 'running',
        source: 'system',
        title: 'Delegated to Workspace Implementer',
      },
      {
        id: 'handoff-running',
        runId: 'run-1',
        timestamp: 3,
        type: 'note',
        status: 'running',
        source: 'system',
        title: 'Workspace Implementer is working',
      },
      {
        id: 'handoff-completed',
        runId: 'run-1',
        timestamp: 4,
        type: 'handoff_completed',
        status: 'succeeded',
        source: 'system',
        title: 'Workspace Implementer completed',
      },
    ]);

    expect(pickRoutingTraceFocusItem({ stage: 'delegated_worker_running', details: {} }, run)).toEqual({
      itemId: 'handoff-running',
      title: 'Workspace Implementer is working',
    });
    expect(pickRoutingTraceFocusItem({ stage: 'delegated_worker_completed', details: {} }, run)).toEqual({
      itemId: 'handoff-completed',
      title: 'Workspace Implementer completed',
    });
  });
});
