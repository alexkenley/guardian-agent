import { describe, expect, it } from 'vitest';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import { buildDelegatedSyntheticEnvelope } from '../execution/metadata.js';
import type { DelegatedTaskContract } from '../execution/types.js';
import type { DelegatedResultSufficiencyFailure } from './delegated-worker-retry.js';
import { runDelegatedWorkerRetryInvocation } from './delegated-worker-retry-invocation.js';

describe('delegated worker retry invocation graph policy', () => {
  it('skips retry invocation when verification did not produce retryable insufficiency', async () => {
    const result = await runDelegatedWorkerRetryInvocation({
      requestId: 'req-none',
      taskRunId: 'task-none',
      targetLabel: 'Workspace Explorer',
      currentRequest: { id: 'request' },
      currentExecutionProfile: executionProfile(),
      config: undefined,
      intentDecision: undefined,
      baseRecord: undefined,
      taskContract: taskContract(),
      insufficiency: null,
      baseSections: [],
      buildRetryRequest: () => {
        throw new Error('unexpected retry request');
      },
      dispatchRetry: async () => {
        throw new Error('unexpected retry dispatch');
      },
      drainPendingJobs: async () => {
        throw new Error('unexpected drain');
      },
      verifyRetryResult: async () => {
        throw new Error('unexpected verification');
      },
    });

    expect(result).toBeNull();
  });

  it('owns retry profile choice, retry dispatch, drain, and verification callbacks', async () => {
    const events: string[] = [];
    const profile = executionProfile();
    const contract = taskContract();
    const insufficiency = answerOnlyInsufficiency();

    const result = await runDelegatedWorkerRetryInvocation({
      requestId: 'req-retry',
      taskRunId: 'task-retry',
      targetLabel: 'Workspace Explorer',
      currentRequest: { id: 'request', retry: false },
      currentExecutionProfile: profile,
      config: undefined,
      intentDecision: undefined,
      baseRecord: undefined,
      taskContract: contract,
      insufficiency,
      codeSessionId: 'code-session-1',
      baseSections: [{ section: 'Base', mode: 'plain', content: 'Existing context.' }],
      buildRetryRequest: ({ currentRequest, retryPlan, retryProfile }) => ({
        ...currentRequest,
        retry: true,
        retryProfileId: retryProfile.id,
        additionalSectionCount: retryPlan.additionalSections.length,
      }),
      dispatchRetry: async ({ request, retryPlan }) => {
        events.push('dispatch');
        expect(request).toMatchObject({
          retry: true,
          retryProfileId: profile.id,
          additionalSectionCount: 2,
        });
        expect(retryPlan.detail).toContain('Workspace Explorer');
        return { content: 'retry answer', metadata: { source: 'retry' } };
      },
      drainPendingJobs: async () => ({
        snapshots: [{ id: 'job-retry', toolName: 'fs_read', status: 'running' }],
        waitedMs: 2500,
        inFlightRemaining: 1,
      }),
      verifyRetryResult: async ({ request, result: retryResult, retryProfile, jobDrain }) => {
        events.push('verify');
        expect(request).toMatchObject({ retry: true });
        expect(retryResult.content).toBe('retry answer');
        expect(retryProfile).toBe(profile);
        expect(jobDrain.inFlightRemaining).toBe(1);
        return {
          taskContract: contract,
          verifiedResult: {
            envelope: buildDelegatedSyntheticEnvelope({
              taskContract: contract,
              runStatus: 'completed',
              stopReason: 'end_turn',
              operatorSummary: 'retry answer',
            }),
            decision: {
              decision: 'satisfied',
              reasons: ['Retry satisfied the delegated answer step.'],
              retryable: false,
            },
          },
          insufficiency: null,
          jobSnapshots: jobDrain.snapshots,
          extendedDrain: null,
        };
      },
      onRetrying: ({ request, retryPlan, retryProfile }) => {
        events.push('retrying');
        expect(request).toMatchObject({ retry: true });
        expect(retryProfile).toBe(profile);
        expect(retryPlan.usesSameProfile).toBe(true);
      },
      onDrainWaitExpired: ({ request, jobDrain, taskContract: drainedContract }) => {
        events.push('drain-expired');
        expect(request).toMatchObject({ retry: true });
        expect(jobDrain.inFlightRemaining).toBe(1);
        expect(drainedContract).toBe(contract);
      },
    });

    expect(events).toEqual(['retrying', 'dispatch', 'drain-expired', 'verify']);
    expect(result).toMatchObject({
      request: {
        retry: true,
        retryProfileId: profile.id,
      },
      result: {
        content: 'retry answer',
      },
      jobDrain: {
        inFlightRemaining: 1,
      },
      verificationCycle: {
        insufficiency: null,
      },
    });
  });
});

function taskContract(): DelegatedTaskContract {
  return {
    kind: 'repo_inspection',
    route: 'coding_task',
    operation: 'inspect',
    requiresEvidence: true,
    allowsAnswerFirst: false,
    requireExactFileReferences: false,
    plan: {
      planId: 'plan-retry',
      steps: [
        { stepId: 'read', kind: 'read', summary: 'Read implementation file.' },
        { stepId: 'answer', kind: 'answer', summary: 'Answer user from evidence.' },
      ],
    },
  };
}

function executionProfile(): SelectedExecutionProfile {
  return {
    id: 'managed-cloud-tools',
    providerName: 'ollama-cloud',
    providerType: 'ollama_cloud',
    providerModel: 'gpt-oss:120b',
    providerTier: 'managed_cloud',
    providerLocality: 'external',
    requestedTier: 'external',
    routingMode: 'auto',
    selectionSource: 'auto',
    reason: 'test profile',
    fallbackProviderOrder: [],
  };
}

function answerOnlyInsufficiency(): DelegatedResultSufficiencyFailure {
  return {
    decision: {
      decision: 'insufficient',
      reasons: ['The worker gathered evidence but did not answer.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
    },
    failureSummary: 'The worker gathered evidence but did not answer.',
    retryReason: 'required steps remain unsatisfied (answer)',
    unsatisfiedSteps: [{
      stepId: 'answer',
      kind: 'answer',
      summary: 'Answer user from evidence.',
      status: 'missing',
    }],
    satisfiedSteps: [{
      stepId: 'read',
      summary: 'Read implementation file.',
      refs: ['src/runtime/execution-graph/delegated-worker-retry-invocation.ts'],
    }],
  };
}
