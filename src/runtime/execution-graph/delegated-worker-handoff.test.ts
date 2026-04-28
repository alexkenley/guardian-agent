import { describe, expect, it } from 'vitest';
import {
  applyDelegatedFollowUpPolicy,
  buildDelegatedHandoff,
  buildDelegatedInsufficientResultHandoff,
  formatFailedDelegatedMessage,
  normalizeDelegatedWorkerRunClass,
  resolveDelegatedWorkerLifecycle,
} from './delegated-worker-handoff.js';
import { buildDelegatedExecutionMetadata, buildDelegatedSyntheticEnvelope } from '../execution/metadata.js';
import type { DelegatedTaskContract, VerificationDecision } from '../execution/types.js';

describe('delegated worker handoff graph policy', () => {
  it('owns approval handoff and lifecycle resolution outside WorkerManager', () => {
    const verification: VerificationDecision = {
      decision: 'blocked',
      reasons: ['Approval is required.'],
      retryable: true,
    };
    const metadata = {
      pendingAction: {
        blocker: {
          kind: 'approval',
          prompt: 'Approval required for fs_write.',
          approvalSummaries: [{ id: 'approval-1', toolName: 'fs_write', argsPreview: '{}' }],
        },
      },
    };

    const handoff = buildDelegatedHandoff('Waiting for approval.', metadata, 'short_lived', verification);

    expect(handoff).toMatchObject({
      summary: 'Waiting for approval.',
      unresolvedBlockerKind: 'approval',
      approvalCount: 1,
      runClass: 'short_lived',
      nextAction: 'Resolve the pending approval(s) to continue the delegated run.',
      reportingMode: 'held_for_approval',
    });
    expect(resolveDelegatedWorkerLifecycle(metadata, handoff.unresolvedBlockerKind, verification)).toBe('blocked');
  });

  it('renders policy blockers as status-only delegated pauses', () => {
    const verification: VerificationDecision = {
      decision: 'policy_blocked',
      reasons: ['Filesystem path is outside policy.'],
      retryable: false,
      requiredNextAction: 'Choose an allowed workspace path.',
    };
    const handoff = buildDelegatedHandoff('Path blocked.', {}, 'short_lived', verification);
    const result = applyDelegatedFollowUpPolicy({ content: 'Path blocked.', metadata: {} }, handoff, verification);

    expect(result.content).toContain('Delegated work is paused: policy blocker must be resolved.');
    expect(result.content).toContain('Filesystem path is outside policy.');
    expect(result.content).toContain('Choose an allowed workspace path.');
    expect(result.metadata?.delegatedHandoff).toEqual(handoff);
  });

  it('formats insufficient terminal handoffs as failed delegated messages', () => {
    const handoff = buildDelegatedInsufficientResultHandoff({
      failureSummary: 'The answer step was not satisfied.',
      decision: { requiredNextAction: 'Retry answer synthesis from gathered evidence.' },
    });

    expect(handoff.runClass).toBe('short_lived');
    expect(formatFailedDelegatedMessage(handoff)).toBe([
      'Delegated work failed.',
      'The answer step was not satisfied.',
      'Retry answer synthesis from gathered evidence.',
    ].join('\n'));
  });

  it('holds long-running satisfied delegated results for operator follow-up', () => {
    const verification: VerificationDecision = {
      decision: 'satisfied',
      reasons: [],
      retryable: false,
    };
    const handoff = buildDelegatedHandoff('Connector sync completed.', {}, 'long_running', verification);
    const result = applyDelegatedFollowUpPolicy(
      { content: 'Connector sync completed.', metadata: {} },
      handoff,
      verification,
    );

    expect(handoff).toMatchObject({
      reportingMode: 'held_for_operator',
      operatorState: 'pending',
      nextAction: 'Replay or dismiss the held delegated result.',
    });
    expect(result.content).toContain('Delegated work completed and is held for operator review.');
    expect(result.metadata?.delegatedHandoff).toEqual(handoff);
  });

  it('uses delegated result envelopes when summarizing incomplete graph terminals', () => {
    const taskContract = delegatedTaskContract();
    const metadata = buildDelegatedExecutionMetadata(buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'incomplete',
      stopReason: 'max_rounds',
      operatorSummary: 'Stopped early.',
      stepReceipts: [{
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['receipt-read'],
        summary: 'Read source.',
        startedAt: 1,
        endedAt: 2,
      }, {
        stepId: 'answer',
        status: 'failed',
        evidenceReceiptIds: [],
        summary: 'Answer user.',
        startedAt: 3,
        endedAt: 4,
      }],
    }));

    const handoff = buildDelegatedHandoff('Still working.', metadata, 'short_lived');

    expect(handoff.summary).toBe('Delegated worker stopped before satisfying required steps: answer.');
    expect(resolveDelegatedWorkerLifecycle(metadata, handoff.unresolvedBlockerKind)).toBe('completed');
  });

  it('normalizes unknown delegated run classes conservatively', () => {
    expect(normalizeDelegatedWorkerRunClass('automation_owned')).toBe('automation_owned');
    expect(normalizeDelegatedWorkerRunClass('unexpected')).toBe('short_lived');
  });
});

function delegatedTaskContract(): DelegatedTaskContract {
  return {
    kind: 'repo_inspection',
    route: 'coding_task',
    operation: 'inspect',
    requiresEvidence: true,
    allowsAnswerFirst: false,
    requireExactFileReferences: false,
    plan: {
      planId: 'plan-1',
      steps: [
        { stepId: 'read', kind: 'read', summary: 'Read source.' },
        { stepId: 'answer', kind: 'answer', summary: 'Answer user.' },
      ],
    },
  };
}
