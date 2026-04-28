import { describe, expect, it } from 'vitest';
import { buildDelegatedExecutionMetadata, buildDelegatedSyntheticEnvelope } from '../execution/metadata.js';
import type { DelegatedTaskContract } from '../execution/types.js';
import type { WorkerExecutionMetadata } from '../worker-execution-metadata.js';
import {
  buildSyntheticDelegatedEnvelopeFromJobs,
  isDelegatedWorkerBudgetExhausted,
  isDelegatedJobInFlight,
  reconcileDelegatedEnvelopeWithJobSnapshots,
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

  it('normalizes in-flight delegated job statuses', () => {
    expect(isDelegatedJobInFlight('queued')).toBe(true);
    expect(isDelegatedJobInFlight('running')).toBe(true);
    expect(isDelegatedJobInFlight('completed')).toBe(false);
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
