import { describe, expect, it } from 'vitest';
import type { IntentGatewayDecision } from '../intent/types.js';
import { createExecutionGraphEvent } from './graph-events.js';
import { ExecutionGraphStore } from './graph-store.js';

function decision(): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect the repository.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    resolvedContent: 'Inspect the repository.',
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
  };
}

function event(input: {
  kind: Parameters<typeof createExecutionGraphEvent>[0]['kind'];
  sequence: number;
  timestamp?: number;
  nodeId?: string;
  payload?: Record<string, unknown>;
}) {
  return createExecutionGraphEvent({
    eventId: `event-${input.sequence}`,
    graphId: 'graph-1',
    executionId: 'exec-1',
    rootExecutionId: 'exec-1',
    requestId: 'req-1',
    runId: 'req-1',
    ...(input.nodeId ? { nodeId: input.nodeId, nodeKind: 'explore_readonly' } : {}),
    kind: input.kind,
    timestamp: input.timestamp ?? 100 + input.sequence,
    sequence: input.sequence,
    producer: 'runtime',
    payload: input.payload ?? {},
  });
}

describe('ExecutionGraphStore', () => {
  it('creates graph snapshots and records coarse checkpoints at phase boundaries', () => {
    const store = new ExecutionGraphStore({
      now: () => 100,
      checkpointIntervalEvents: 3,
    });
    store.createGraph({
      graphId: 'graph-1',
      executionId: 'exec-1',
      requestId: 'req-1',
      intent: decision(),
      securityContext: {
        agentId: 'guardian',
        agentIdentity: {
          agentId: 'guardian',
          policySetId: 'default',
          allowedMemoryScopes: ['global'],
        },
      },
      nodes: [{
        nodeId: 'node-1',
        graphId: 'graph-1',
        kind: 'explore_readonly',
        status: 'pending',
        title: 'Read-only exploration',
        requiredInputIds: [],
        outputArtifactTypes: ['EvidenceLedger'],
        allowedToolCategories: ['filesystem.read'],
        checkpointPolicy: 'phase_boundary',
      }],
    });

    store.appendEvent(event({ kind: 'graph_started', sequence: 1 }));
    store.appendEvent(event({ kind: 'tool_call_started', sequence: 2, nodeId: 'node-1' }));
    store.appendEvent(event({ kind: 'tool_call_completed', sequence: 3, nodeId: 'node-1' }));
    store.appendEvent(event({ kind: 'node_completed', sequence: 4, nodeId: 'node-1' }));

    const snapshot = store.getSnapshot('graph-1');
    expect(snapshot?.graph.status).toBe('running');
    expect(snapshot?.graph.nodes[0]?.status).toBe('completed');
    expect(snapshot?.events.map((entry) => entry.kind)).toEqual([
      'graph_started',
      'tool_call_started',
      'tool_call_completed',
      'node_completed',
    ]);
    expect(snapshot?.graph.checkpoints.map((checkpoint) => checkpoint.reason)).toEqual([
      'phase_boundary',
      'interval',
      'phase_boundary',
    ]);
    expect(snapshot?.graph.securityContext.agentIdentity?.allowedMemoryScopes).toEqual(['global']);
  });

  it('bounds retained graphs and graph events', () => {
    let clock = 100;
    const store = new ExecutionGraphStore({
      now: () => clock,
      maxGraphs: 1,
      maxEventsPerGraph: 2,
    });
    store.createGraph({
      graphId: 'graph-1',
      executionId: 'exec-1',
      requestId: 'req-1',
      intent: decision(),
    });
    store.appendEvent(event({ kind: 'graph_started', sequence: 1 }));
    store.appendEvent(event({ kind: 'tool_call_started', sequence: 2 }));
    store.appendEvent(event({ kind: 'tool_call_completed', sequence: 3 }));

    expect(store.getSnapshot('graph-1')?.events.map((entry) => entry.sequence)).toEqual([2, 3]);

    clock = 200;
    store.createGraph({
      graphId: 'graph-2',
      executionId: 'exec-2',
      requestId: 'req-2',
      intent: decision(),
    });

    expect(store.getGraph('graph-1')).toBeNull();
    expect(store.getGraph('graph-2')?.executionId).toBe('exec-2');
  });
});
