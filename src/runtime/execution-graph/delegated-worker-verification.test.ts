import { describe, expect, it } from 'vitest';
import { buildDelegatedExecutionMetadata, buildDelegatedSyntheticEnvelope } from '../execution/metadata.js';
import type { DelegatedTaskContract } from '../execution/types.js';
import type { WorkerExecutionMetadata } from '../worker-execution-metadata.js';
import {
  awaitDelegatedRequestJobDrain,
  buildSyntheticDelegatedEnvelopeFromJobs,
  finalizeDelegatedWorkerVerification,
  isDelegatedWorkerBudgetExhausted,
  isDelegatedJobInFlight,
  listDelegatedRequestJobSnapshots,
  reconcileDelegatedEnvelopeWithJobSnapshots,
  runDelegatedEvidenceDrainExtension,
  runDelegatedWorkerVerificationCycle,
  shouldExtendDelegatedEvidenceDrain,
  verifyDelegatedWorkerResult,
  type DelegatedJobSnapshot,
} from './delegated-worker-verification.js';

describe('delegated worker verification graph policy', () => {
  it('reconciles typed result envelopes with completed delegated job evidence', () => {
    const taskContract = delegatedTaskContract();
    const envelope = buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'incomplete',
      stopReason: 'end_turn',
      operatorSummary: 'Worker returned before recording receipts.',
    });

    const reconciled = reconcileDelegatedEnvelopeWithJobSnapshots(envelope, [{
      id: 'job-1',
      toolName: 'fs_read',
      status: 'succeeded',
      createdAt: 1,
      startedAt: 2,
      completedAt: 3,
      argsPreview: '{"path":"src/runtime/execution-graph/delegated-worker-node.ts"}',
      resultPreview: 'export function buildDelegatedWorkerGraphCompletion',
    }]);

    expect(reconciled.evidenceReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        receiptId: 'job:job-1',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['src/runtime/execution-graph/delegated-worker-node.ts'],
      }),
    ]));
    expect(reconciled.stepReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['job:job-1'],
      }),
    ]));
  });

  it('builds a synthetic delegated envelope from job progress without direct worker authority', () => {
    const taskContract = delegatedTaskContract();
    const workerExecution: WorkerExecutionMetadata = {
      lifecycle: 'failed',
      source: 'tool_loop',
      completionReason: 'model_response',
      terminationReason: 'max_rounds',
      roundCount: 6,
      toolCallCount: 1,
      toolResultCount: 1,
    };
    const envelope = buildSyntheticDelegatedEnvelopeFromJobs({
      taskContract,
      workerExecution,
      jobSnapshots: [{
        id: 'job-2',
        toolName: 'fs_search',
        status: 'completed',
        resultPreview: 'src/supervisor/worker-manager.ts',
      }],
    });

    expect(envelope).toMatchObject({
      runStatus: 'max_turns',
      stopReason: 'max_rounds',
      operatorSummary: 'Delegated worker exhausted its step budget before returning a typed result envelope.',
    });
    expect(envelope?.evidenceReceipts[0]).toMatchObject({
      receiptId: 'job:job-2',
      status: 'succeeded',
      refs: ['src/supervisor/worker-manager.ts'],
    });
  });

  it('returns a contradicted verification when no delegated result envelope or job progress exists', () => {
    const result = verifyDelegatedWorkerResult({
      metadata: undefined,
      intentDecision: undefined,
      executionProfile: undefined,
      taskContract: delegatedTaskContract(),
      jobSnapshots: [],
    });

    expect(result.envelope.runStatus).toBe('failed');
    expect(result.decision).toMatchObject({
      decision: 'contradicted',
      retryable: false,
      missingEvidenceKinds: expect.arrayContaining(['delegated_result_envelope']),
      unsatisfiedStepIds: ['read', 'answer'],
    });
  });

  it('verifies typed metadata after adding job-backed receipts', () => {
    const taskContract = delegatedTaskContract();
    const metadata = buildDelegatedExecutionMetadata(buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'incomplete',
      stopReason: 'end_turn',
      operatorSummary: 'Needs receipts.',
    }));
    const jobSnapshots: DelegatedJobSnapshot[] = [{
      id: 'job-3',
      toolName: 'fs_read',
      status: 'completed',
      argsPreview: '{"path":"src/runtime/execution-graph/delegated-worker-verification.ts"}',
      resultPreview: 'verifyDelegatedWorkerResult',
    }];

    const result = verifyDelegatedWorkerResult({
      metadata,
      intentDecision: undefined,
      executionProfile: undefined,
      taskContract,
      jobSnapshots,
    });

    expect(result.envelope.evidenceReceipts.map((receipt) => receipt.receiptId)).toContain('job:job-3');
    expect(result.decision.decision).not.toBe('contradicted');
    expect(result.decision.missingEvidenceKinds ?? []).not.toContain('delegated_result_envelope');
  });

  it('finalizes verification envelopes and trace reconciliation details without WorkerManager state', () => {
    const supervisorContract = delegatedTaskContract();
    const workerContract: DelegatedTaskContract = {
      ...supervisorContract,
      plan: {
        ...supervisorContract.plan,
        planId: 'plan-worker',
      },
    };
    const envelope = buildDelegatedSyntheticEnvelope({
      taskContract: workerContract,
      runStatus: 'completed',
      stopReason: 'end_turn',
      operatorSummary: 'Done.',
      events: [{
        eventId: 'old-verification',
        type: 'verification_decided',
        timestamp: 1,
        payload: {
          decision: 'insufficient',
          reasons: ['old'],
          retryable: true,
          summary: 'old',
        },
      }],
    });

    const result = finalizeDelegatedWorkerVerification({
      taskContract: supervisorContract,
      timestamp: 42,
      verifiedResult: {
        envelope,
        decision: {
          decision: 'satisfied',
          reasons: ['All required delegated steps were satisfied.'],
          retryable: false,
        },
      },
    });

    expect(result.planDrift).toBe(true);
    expect(result.traceTaskContract.plan.planId).toBe('plan-worker');
    expect(result.traceReason).toContain('Plan drift detected: supervisor=plan-verify');
    expect(result.verifiedEnvelope.verification).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
    expect(result.verifiedEnvelope.events.filter((event) => event.type === 'verification_decided')).toEqual([{
      eventId: 'verification:satisfied',
      type: 'verification_decided',
      timestamp: 42,
      payload: {
        decision: 'satisfied',
        reasons: ['All required delegated steps were satisfied.'],
        retryable: false,
        summary: 'All required delegated steps were satisfied.',
      },
    }]);
  });

  it('runs the delegated verification cycle with contract adoption outside WorkerManager', async () => {
    const supervisorContract = delegatedTaskContract();
    const workerContract: DelegatedTaskContract = {
      ...supervisorContract,
      plan: {
        ...supervisorContract.plan,
        planId: 'plan-worker',
      },
    };
    const metadata = buildDelegatedExecutionMetadata(buildDelegatedSyntheticEnvelope({
      taskContract: workerContract,
      runStatus: 'incomplete',
      stopReason: 'end_turn',
      operatorSummary: 'Worker is still gathering evidence.',
    }));
    let drainCalled = false;

    const result = await runDelegatedWorkerVerificationCycle({
      requestId: 'req-cycle',
      taskRunId: 'task-cycle',
      metadata,
      intentDecision: undefined,
      executionProfile: undefined,
      taskContract: supervisorContract,
      jobSnapshots: [{ id: 'job-running', toolName: 'fs_read', status: 'running' }],
      drainPendingJobs: async (_deadlineMs) => {
        drainCalled = true;
        return {
          snapshots: [{
            id: 'job-cycle',
            toolName: 'fs_read',
            status: 'completed',
            argsPreview: '{"path":"src/runtime/execution-graph/delegated-worker-verification.ts"}',
            resultPreview: 'runDelegatedWorkerVerificationCycle',
          }],
          waitedMs: 50,
          inFlightRemaining: 0,
        };
      },
    });

    expect(result.taskContract.plan.planId).toBe('plan-worker');
    expect(result.extendedDrain).toBeNull();
    expect(drainCalled).toBe(false);
    expect(result.jobSnapshots).toEqual([expect.objectContaining({ id: 'job-running' })]);
    expect(result.insufficiency?.decision.retryable).toBe(true);
  });

  it('normalizes in-flight delegated job statuses', () => {
    expect(isDelegatedJobInFlight('queued')).toBe(true);
    expect(isDelegatedJobInFlight('running')).toBe(true);
    expect(isDelegatedJobInFlight('completed')).toBe(false);
  });

  it('owns request-scoped delegated job snapshot listing and drain polling', async () => {
    let calls = 0;
    let nowMs = 0;

    const snapshots = listDelegatedRequestJobSnapshots({
      requestId: 'req-drain',
      snapshotLimit: 1,
      listJobs: (limit) => {
        expect(limit).toBe(500);
        return [
          { id: 'other', requestId: 'req-other', toolName: 'fs_read', status: 'completed' },
          { id: 'job-1', requestId: 'req-drain', toolName: 'fs_search', status: 'completed' },
          { id: 'job-2', requestId: 'req-drain', toolName: 'fs_read', status: 'completed' },
        ];
      },
    });

    expect(snapshots).toEqual([expect.objectContaining({ id: 'job-1', toolName: 'fs_search' })]);

    const drain = await awaitDelegatedRequestJobDrain({
      requestId: 'req-drain',
      deadlineMs: 50,
      pollMs: 10,
      now: () => nowMs,
      wait: async (ms) => {
        nowMs += ms;
      },
      listJobs: () => {
        calls += 1;
        return [{
          id: 'job-drain',
          requestId: 'req-drain',
          toolName: 'fs_read',
          status: calls === 1 ? 'running' : 'completed',
        }];
      },
    });

    expect(calls).toBe(2);
    expect(drain).toMatchObject({
      waitedMs: 10,
      inFlightRemaining: 0,
      snapshots: [expect.objectContaining({ id: 'job-drain', status: 'completed' })],
    });
  });

  it('owns extended evidence drain decisions from verification state', () => {
    const taskContract = delegatedTaskContract();
    expect(shouldExtendDelegatedEvidenceDrain({
      taskContract,
      decision: {
        decision: 'insufficient',
        reasons: ['Read evidence is still running.'],
        retryable: true,
        missingEvidenceKinds: ['repo_evidence'],
        unsatisfiedStepIds: ['read', 'answer'],
      },
      jobSnapshots: [{ id: 'job-1', toolName: 'fs_read', status: 'running' }],
    })).toBe(true);

    expect(shouldExtendDelegatedEvidenceDrain({
      taskContract,
      decision: {
        decision: 'insufficient',
        reasons: ['Only answer synthesis remains.'],
        retryable: true,
        missingEvidenceKinds: ['answer'],
        unsatisfiedStepIds: ['answer'],
      },
      jobSnapshots: [{ id: 'job-2', toolName: 'fs_read', status: 'running' }],
    })).toBe(false);

    expect(isDelegatedWorkerBudgetExhausted('max_wall_clock')).toBe(true);
    expect(isDelegatedWorkerBudgetExhausted('provider_error')).toBe(false);
  });

  it('runs extended evidence drain through broker-safe polling callbacks', async () => {
    const taskContract = delegatedTaskContract();
    const metadata = buildDelegatedExecutionMetadata(buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'incomplete',
      stopReason: 'end_turn',
      operatorSummary: 'Delegated evidence is still draining.',
    }));
    const traces: Array<{ stage: string; details: Record<string, unknown> }> = [];
    let observedDeadlineMs = 0;

    const result = await runDelegatedEvidenceDrainExtension({
      requestId: 'req-drain',
      taskRunId: 'task-drain',
      metadata,
      intentDecision: undefined,
      executionProfile: undefined,
      taskContract,
      decision: {
        decision: 'insufficient',
        reasons: ['Read evidence is still running.'],
        retryable: true,
        missingEvidenceKinds: ['repo_evidence'],
        unsatisfiedStepIds: ['read', 'answer'],
      },
      jobSnapshots: [{ id: 'job-running', toolName: 'fs_read', status: 'running' }],
      drainPendingJobs: async (deadlineMs) => {
        observedDeadlineMs = deadlineMs;
        return {
          snapshots: [{
            id: 'job-drained',
            toolName: 'fs_read',
            status: 'completed',
            argsPreview: '{"path":"src/runtime/execution-graph/delegated-worker-verification.ts"}',
            resultPreview: 'verifyDelegatedWorkerResult',
          }],
          waitedMs: 125,
          inFlightRemaining: 0,
        };
      },
      trace: (event) => traces.push(event),
    });

    expect(observedDeadlineMs).toBe(60_000);
    expect(traces).toEqual([]);
    expect(result?.jobSnapshots).toHaveLength(1);
    expect(result?.verifiedResult.envelope.evidenceReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        receiptId: 'job:job-drained',
        toolName: 'fs_read',
        status: 'succeeded',
      }),
    ]));
    expect(result?.verifiedResult.envelope.stepReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: 'read',
        status: 'satisfied',
      }),
    ]));
    expect(result?.verifiedResult.decision.missingEvidenceKinds ?? []).not.toContain('repo_evidence');
    expect(result?.insufficiency?.unsatisfiedSteps.some((step) => step.stepId === 'read')).not.toBe(true);
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
      planId: 'plan-verify',
      steps: [
        { stepId: 'read', kind: 'read', summary: 'Read implementation file.' },
        { stepId: 'answer', kind: 'answer', summary: 'Answer user from evidence.' },
      ],
    },
  };
}
