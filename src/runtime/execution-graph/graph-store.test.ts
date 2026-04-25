import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntentGatewayDecision } from '../intent/types.js';
import { createExecutionGraphEvent } from './graph-events.js';
import { ExecutionGraphStore } from './graph-store.js';
import { buildSearchResultSetArtifact } from './graph-artifacts.js';

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

  it('marks graph and node state awaiting clarification for clarification interrupts', () => {
    const store = new ExecutionGraphStore({
      now: () => 100,
    });
    store.createGraph({
      graphId: 'graph-1',
      executionId: 'exec-1',
      requestId: 'req-1',
      intent: decision(),
      nodes: [{
        nodeId: 'node-1',
        graphId: 'graph-1',
        kind: 'plan',
        status: 'pending',
        title: 'Plan target output',
        requiredInputIds: [],
        outputArtifactTypes: [],
        allowedToolCategories: [],
      }],
    });

    store.appendEvent(event({
      kind: 'clarification_requested',
      sequence: 1,
      nodeId: 'node-1',
      payload: {
        field: 'target_file',
        question: 'Which file should receive the generated note?',
      },
    }));

    const snapshot = store.getSnapshot('graph-1');
    expect(snapshot?.graph.status).toBe('awaiting_clarification');
    expect(snapshot?.graph.nodes[0]?.status).toBe('awaiting_clarification');
    expect(snapshot?.graph.checkpoints.map((checkpoint) => checkpoint.reason)).toEqual([
      'clarification_interrupt',
    ]);
  });

  it('stores typed artifacts with graph snapshots and prunes artifact refs with content', () => {
    const store = new ExecutionGraphStore({
      now: () => 100,
      maxArtifactsPerGraph: 1,
    });
    store.createGraph({
      graphId: 'graph-1',
      executionId: 'exec-1',
      requestId: 'req-1',
      intent: decision(),
    });

    const oldArtifact = buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'old-search',
      query: 'RunTimelineStore',
      matches: [{ relativePath: 'src/runtime/run-timeline.ts', line: 10 }],
      createdAt: 110,
    });
    const newArtifact = buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'new-search',
      query: 'direct reasoning',
      matches: [{ relativePath: 'src/runtime/direct-reasoning-mode.ts', line: 20 }],
      createdAt: 120,
    });

    expect(store.writeArtifact(oldArtifact)?.artifactId).toBe('old-search');
    expect(store.getArtifact('graph-1', 'old-search')?.content).toMatchObject({
      totalMatches: 1,
    });

    store.writeArtifact(newArtifact);

    expect(store.getArtifact('graph-1', 'old-search')).toBeNull();
    expect(store.listArtifacts('graph-1').map((artifact) => artifact.artifactId)).toEqual(['new-search']);
    expect(store.getSnapshot('graph-1')?.graph.artifacts.map((artifact) => artifact.artifactId)).toEqual(['new-search']);
  });

  it('persists graph snapshots, events, and artifacts across store instances', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'guardianagent-execution-graph-store-'));
    try {
      const persistPath = join(tempDir, 'execution-graphs.json');
      const store = new ExecutionGraphStore({
        now: () => 100,
        persistPath,
      });
      store.createGraph({
        graphId: 'graph-1',
        executionId: 'exec-1',
        requestId: 'req-1',
        intent: decision(),
        nodes: [{
          nodeId: 'node-1',
          graphId: 'graph-1',
          kind: 'explore_readonly',
          status: 'pending',
          title: 'Read-only exploration',
          requiredInputIds: [],
          outputArtifactTypes: ['SearchResultSet'],
          allowedToolCategories: ['filesystem.read'],
        }],
      });
      store.appendEvent(event({ kind: 'graph_started', sequence: 1 }));
      store.appendEvent(event({ kind: 'approval_requested', sequence: 2, nodeId: 'node-1', payload: { approvalId: 'approval-1' } }));
      store.writeArtifact(buildSearchResultSetArtifact({
        graphId: 'graph-1',
        nodeId: 'node-1',
        artifactId: 'search-1',
        query: 'planned_steps',
        matches: [{ relativePath: 'src/runtime/intent/types.ts', line: 12 }],
        createdAt: 120,
      }));

      const reloaded = new ExecutionGraphStore({
        now: () => 200,
        persistPath,
      });

      expect(reloaded.getSnapshot('graph-1')?.graph.status).toBe('awaiting_approval');
      expect(reloaded.getSnapshot('graph-1')?.events.map((entry) => entry.kind)).toEqual([
        'graph_started',
        'approval_requested',
      ]);
      expect(reloaded.getArtifact('graph-1', 'search-1')?.content).toMatchObject({
        totalMatches: 1,
      });
      expect(reloaded.listArtifacts('graph-1').map((artifact) => artifact.artifactId)).toEqual(['search-1']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
