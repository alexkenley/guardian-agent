import { describe, expect, it } from 'vitest';
import {
  artifactRefFromArtifact,
  buildSearchResultSetArtifact,
} from './graph-artifacts.js';
import {
  buildRecoveryAdvisorGraphContext,
  buildRecoveryAdvisorGraphInput,
  buildRecoveryAdvisorLifecycleEvent,
  executeRecoveryProposalNode,
  runRecoveryAdvisorGraph,
  type RecoveryNodeExecutionContext,
} from './node-recovery.js';
import type { ExecutionGraphEvent } from './graph-events.js';
import type { ExecutionNode } from './types.js';

describe('execution graph recovery node', () => {
  it('builds the recovery advisor graph shell outside WorkerManager ownership', () => {
    const context = buildRecoveryAdvisorGraphContext({
      graphId: 'execution-graph:delegated-task:recovery',
      executionId: 'delegated-task',
      rootExecutionId: 'root-task',
      parentExecutionId: 'parent-task',
      requestId: 'request-1',
      runId: 'request-1',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      codeSessionId: 'code-1',
    });

    const projection = buildRecoveryAdvisorGraphInput({
      context,
      intent: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'modify',
        summary: 'Modify repository.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        entities: {},
      },
      securityContext: {
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'web',
        codeSessionId: 'code-1',
      },
      failureReason: 'Verification failed.',
      now: () => 1_234,
    });

    expect(projection.graphInput).toMatchObject({
      graphId: context.graphId,
      executionId: context.executionId,
      rootExecutionId: context.rootExecutionId,
      parentExecutionId: context.parentExecutionId,
      requestId: context.requestId,
      runId: context.runId,
      trigger: {
        type: 'event',
        source: 'recovery_advisor',
        sourceId: context.requestId,
      },
      nodes: [{
        nodeId: context.failedNodeId,
        kind: 'delegated_worker',
        status: 'failed',
        terminalReason: 'Verification failed.',
      }, {
        nodeId: context.recoveryNodeId,
        kind: 'recover',
        status: 'pending',
      }],
      edges: [{
        fromNodeId: context.failedNodeId,
        toNodeId: context.recoveryNodeId,
      }],
    });
    expect(projection.recoveryNodeContext).toMatchObject({
      graphId: context.graphId,
      nodeId: context.recoveryNodeId,
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      codeSessionId: 'code-1',
    });

    const event = buildRecoveryAdvisorLifecycleEvent(context, {
      kind: 'graph_started',
      sequence: 1,
      timestamp: 2_000,
      eventId: `${context.graphId}:graph:started:1`,
      payload: {
        controller: 'recovery_advisor',
      },
    });

    expect(event).toMatchObject({
      graphId: context.graphId,
      executionId: context.executionId,
      rootExecutionId: context.rootExecutionId,
      parentExecutionId: context.parentExecutionId,
      requestId: context.requestId,
      runId: context.runId,
      kind: 'graph_started',
      producer: 'supervisor',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      codeSessionId: 'code-1',
    });
  });

  it('emits a bounded advisory retry proposal without tool execution', () => {
    const failedNode = buildNode('mutate-1', 'mutate');
    const graph = {
      graphId: 'graph-1',
      nodes: [failedNode],
      artifacts: [],
    };

    const result = executeRecoveryProposalNode({
      graph,
      failedNode,
      context: baseContext(),
      candidate: {
        reason: 'The mutation failed verification and can be retried once.',
        actions: [{
          kind: 'retry_node',
          targetNodeId: 'mutate-1',
          retryBudget: 1,
        }],
      },
    });

    expect(result.status).toBe('proposed');
    expect(result.proposalArtifact?.artifactType).toBe('RecoveryProposal');
    expect(result.proposalArtifact?.content).toMatchObject({
      failedNodeId: 'mutate-1',
      advisoryOnly: true,
      actions: [{
        kind: 'retry_node',
        targetNodeId: 'mutate-1',
        retryBudget: 1,
      }],
    });
    expect(result.patch?.operations).toEqual([{
      kind: 'retry_node',
      targetNodeId: 'mutate-1',
      retryBudget: 1,
    }]);
    expect(result.events.map((event) => event.kind)).toEqual([
      'node_started',
      'artifact_created',
      'recovery_proposed',
      'node_completed',
    ]);
    expect(result.events.map((event) => event.kind)).not.toContain('tool_call_started');
    expect(JSON.stringify(result.events.map((event) => event.payload))).toContain('advisoryOnly');
  });

  it('runs and persists the recovery advisor graph lifecycle in graph ownership', () => {
    const context = buildRecoveryAdvisorGraphContext({
      graphId: 'execution-graph:delegated-task:recovery',
      executionId: 'delegated-task',
      rootExecutionId: 'root-task',
      requestId: 'request-1',
      runId: 'request-1',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    const createdGraphs: unknown[] = [];
    const storedEvents: ExecutionGraphEvent[] = [];
    const timelineEvents: ExecutionGraphEvent[] = [];
    const artifacts: unknown[] = [];

    const result = runRecoveryAdvisorGraph({
      context,
      intent: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'modify',
        summary: 'Modify repository.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        entities: {},
      },
      securityContext: {
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'web',
      },
      failureReason: 'Verifier rejected the delegated answer.',
      candidate: {
        reason: 'Retry the delegated worker once.',
        actions: [{
          kind: 'retry_node',
          targetNodeId: context.failedNodeId,
          retryBudget: 1,
        }],
      },
      now: (() => {
        let timestamp = 10_000;
        return () => {
          timestamp += 10;
          return timestamp;
        };
      })(),
      persistence: {
        createGraph: (graph) => {
          createdGraphs.push(graph);
        },
        appendEvent: (event) => {
          storedEvents.push(event);
        },
        ingestEvent: (event) => {
          timelineEvents.push(event);
        },
        writeArtifact: (artifact) => {
          artifacts.push(artifact);
        },
      },
    });

    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') {
      throw new Error('expected recovery proposal');
    }
    expect(createdGraphs).toHaveLength(1);
    expect(storedEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'recovery_proposed',
      'node_completed',
      'graph_completed',
    ]);
    expect(timelineEvents.map((event) => event.eventId)).toEqual(storedEvents.map((event) => event.eventId));
    expect(result.events.map((event) => event.eventId)).toEqual(storedEvents.map((event) => event.eventId));
    expect(artifacts).toHaveLength(1);
    expect(result.patch.operations).toEqual([{
      kind: 'retry_node',
      targetNodeId: context.failedNodeId,
      retryBudget: 1,
    }]);
    expect(result.proposalArtifactId).toBe(result.proposalArtifact.artifactId);
  });

  it('rejects unsafe or overbroad recovery actions without creating a proposal', () => {
    const failedNode = buildNode('mutate-1', 'mutate');
    const graph = {
      graphId: 'graph-1',
      nodes: [failedNode],
      artifacts: [],
    };

    const unsafe = executeRecoveryProposalNode({
      graph,
      failedNode,
      context: baseContext(),
      candidate: {
        reason: 'Bypass the verifier.',
        actions: [{
          kind: 'execute_tool',
          targetNodeId: 'mutate-1',
          reason: 'Run fs_write directly.',
        }],
      },
    });

    expect(unsafe.status).toBe('rejected');
    expect(unsafe.proposalArtifact).toBeUndefined();
    expect(unsafe.patch).toBeUndefined();
    expect(unsafe.events.map((event) => event.kind)).toEqual(['node_started', 'node_failed']);

    const unboundedRetry = executeRecoveryProposalNode({
      graph,
      failedNode,
      context: baseContext(),
      candidate: {
        reason: 'Retry until it works.',
        actions: [{
          kind: 'retry_node',
          targetNodeId: 'mutate-1',
          retryBudget: 99,
        }],
      },
    });

    expect(unboundedRetry.status).toBe('rejected');
    expect(unboundedRetry.events.map((event) => event.kind)).not.toContain('recovery_proposed');
  });

  it('runs rejected recovery advisor lifecycle without writing a proposal artifact', () => {
    const context = buildRecoveryAdvisorGraphContext({
      graphId: 'execution-graph:delegated-task:recovery',
      executionId: 'delegated-task',
      rootExecutionId: 'root-task',
      requestId: 'request-1',
    });
    const storedEvents: ExecutionGraphEvent[] = [];
    const artifacts: unknown[] = [];

    const result = runRecoveryAdvisorGraph({
      context,
      candidate: {
        reason: 'Bypass recovery validation.',
        actions: [{
          kind: 'execute_tool',
          targetNodeId: context.failedNodeId,
          reason: 'Run a tool directly.',
        }],
      },
      persistence: {
        appendEvent: (event) => {
          storedEvents.push(event);
        },
        writeArtifact: (artifact) => {
          artifacts.push(artifact);
        },
      },
    });

    expect(result.status).toBe('rejected');
    expect(storedEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'node_failed',
      'graph_failed',
    ]);
    expect(artifacts).toHaveLength(0);
    expect(result.events.map((event) => event.eventId)).toEqual(storedEvents.map((event) => event.eventId));
  });

  it('can propose a no-tools synthesis retry only when evidence artifacts exist', () => {
    const failedNode = buildNode('synthesize-1', 'synthesize');
    const searchArtifact = buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'explore-1',
      artifactId: 'search-1',
      query: 'planned_steps',
      matches: [{
        relativePath: 'src/runtime/intent/types.ts',
        line: 12,
        snippet: 'plannedSteps?: IntentGatewayPlannedStep[];',
      }],
      createdAt: 100,
    });
    const graph = {
      graphId: 'graph-1',
      nodes: [failedNode],
      artifacts: [artifactRefFromArtifact(searchArtifact)],
    };

    const result = executeRecoveryProposalNode({
      graph,
      failedNode,
      context: baseContext(),
    });

    expect(result.status).toBe('proposed');
    expect(result.proposalArtifact?.content.actions).toEqual([{
      kind: 'insert_synthesize_node',
      insertAfterNodeId: 'synthesize-1',
      reason: 'Evidence is present, so recovery can create a bounded no-tools synthesis retry.',
    }]);
    const operation = result.patch?.operations[0];
    expect(operation?.kind).toBe('insert_synthesize_node');
    if (operation?.kind !== 'insert_synthesize_node') {
      throw new Error('expected insert_synthesize_node operation');
    }
    expect(operation.requiredArtifactIds).toEqual(['search-1']);
    expect(operation.node).toMatchObject({
      kind: 'synthesize',
      status: 'pending',
      requiredInputIds: ['search-1'],
      outputArtifactTypes: ['SynthesisDraft'],
      allowedToolCategories: [],
    });

    const rejected = executeRecoveryProposalNode({
      graph: {
        ...graph,
        artifacts: [],
      },
      failedNode,
      context: baseContext(),
      candidate: {
        reason: 'Synthesize without evidence.',
        actions: [{
          kind: 'insert_synthesize_node',
          insertAfterNodeId: 'synthesize-1',
        }],
      },
    });
    expect(rejected.status).toBe('rejected');
  });
});

function buildNode(nodeId: string, kind: ExecutionNode['kind']): ExecutionNode {
  return {
    nodeId,
    graphId: 'graph-1',
    kind,
    status: 'failed',
    title: `${kind} node`,
    requiredInputIds: [],
    outputArtifactTypes: kind === 'mutate' ? ['MutationReceipt'] : ['SynthesisDraft'],
    allowedToolCategories: kind === 'mutate' ? ['fs_write'] : [],
    retryLimit: 1,
    completedAt: 500,
    terminalReason: 'node failed',
  };
}

function baseContext(): RecoveryNodeExecutionContext {
  return {
    graphId: 'graph-1',
    executionId: 'exec-1',
    rootExecutionId: 'exec-1',
    requestId: 'request-1',
    runId: 'request-1',
    nodeId: 'recover-1',
    channel: 'web',
    agentId: 'guardian',
    userId: 'user-1',
    codeSessionId: 'code-1',
    now: (() => {
      let timestamp = 1_000;
      return () => {
        timestamp += 10;
        return timestamp;
      };
    })(),
  };
}
