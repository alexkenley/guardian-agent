import { describe, expect, it } from 'vitest';
import {
  buildDelegatedWorkerGraphContext,
  buildDelegatedWorkerTerminalProjection,
  normalizeDelegatedGraphBlockerKind,
} from './delegated-worker-node.js';
import type { VerificationDecision } from '../execution/types.js';

describe('delegated worker graph node helpers', () => {
  it('builds completed terminal verification projection events', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:1:delegated-worker',
      executionId: 'delegated-task:1',
      rootExecutionId: 'root-1',
      requestId: 'request-1',
      runId: 'request-1',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'Workspace Implementer',
    });
    const verification: VerificationDecision = {
      decision: 'satisfied',
      reasons: ['Delegated worker satisfied every required planned step.'],
      retryable: false,
    };

    const projection = buildDelegatedWorkerTerminalProjection({
      context,
      sequenceStart: 2,
      timestamp: 1_234,
      lifecycle: 'completed',
      verification,
      payload: {
        lifecycle: 'completed',
        summary: 'Completed.',
      },
    });

    expect(projection.verificationArtifact.content).toMatchObject({
      subjectArtifactId: 'delegated-result:delegated-task:1',
      valid: true,
    });
    expect(projection.events.map((event) => [event.sequence, event.kind, event.nodeKind])).toEqual([
      [3, 'artifact_created', 'delegated_worker'],
      [4, 'verification_completed', 'delegated_worker'],
      [5, 'node_completed', 'delegated_worker'],
      [6, 'graph_completed', undefined],
    ]);
    expect(projection.events[1]?.payload).toMatchObject({
      decision: 'satisfied',
      valid: true,
      failedChecks: [],
    });
    expect(projection.sequence).toBe(6);
  });

  it('maps blocked policy decisions to graph interruptions with verification artifacts', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:2:delegated-worker',
      executionId: 'delegated-task:2',
      rootExecutionId: 'root-2',
      requestId: 'request-2',
      title: 'Workspace Implementer',
    });
    const verification: VerificationDecision = {
      decision: 'policy_blocked',
      reasons: ['Tool policy blocked the worker.'],
      retryable: false,
      requiredNextAction: 'Resolve the policy blocker.',
      missingEvidenceKinds: ['policy_clearance'],
      unsatisfiedStepIds: ['step_2'],
    };

    const projection = buildDelegatedWorkerTerminalProjection({
      context,
      sequenceStart: 4,
      timestamp: 2_345,
      lifecycle: 'blocked',
      verification,
      payload: {
        lifecycle: 'blocked',
        summary: 'Policy blocked.',
      },
      blockerKind: 'policy_blocked',
      blockerPrompt: 'Resolve the policy blocker.',
    });

    expect(projection.verificationArtifact.content.valid).toBe(false);
    expect(projection.verificationArtifact.content.checks.map((check) => [check.name, check.status])).toEqual([
      ['delegated_worker_sufficiency', 'failed'],
      ['unsatisfied_required_steps', 'failed'],
      ['missing_required_evidence', 'failed'],
    ]);
    expect(projection.events.map((event) => event.kind)).toEqual([
      'artifact_created',
      'verification_completed',
      'interruption_requested',
    ]);
    expect(projection.events[2]?.payload).toMatchObject({
      kind: 'policy',
      prompt: 'Resolve the policy blocker.',
      verificationArtifactId: projection.verificationArtifact.artifactId,
    });
  });

  it('normalizes unknown graph blocker kinds to missing context', () => {
    expect(normalizeDelegatedGraphBlockerKind('policy_blocked')).toBe('policy');
    expect(normalizeDelegatedGraphBlockerKind('unexpected')).toBe('missing_context');
  });
});
