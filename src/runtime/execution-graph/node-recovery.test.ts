import { describe, expect, it } from 'vitest';
import {
  artifactRefFromArtifact,
  buildSearchResultSetArtifact,
} from './graph-artifacts.js';
import {
  executeRecoveryProposalNode,
  type RecoveryNodeExecutionContext,
} from './node-recovery.js';
import type { ExecutionNode } from './types.js';

describe('execution graph recovery node', () => {
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
