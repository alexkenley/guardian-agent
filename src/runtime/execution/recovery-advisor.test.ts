import { describe, expect, it } from 'vitest';
import type { DelegatedResultEnvelope, VerificationDecision } from './types.js';
import {
  buildDeterministicRecoveryAdvice,
  buildRecoveryAdvisorAdditionalSection,
  parseRecoveryAdvisorProposal,
  validateRecoveryAdvisorProposal,
} from './recovery-advisor.js';

function taskContract(): DelegatedResultEnvelope['taskContract'] {
  return {
    kind: 'filesystem_mutation',
    route: 'filesystem_task',
    operation: 'create',
    requiresEvidence: true,
    allowsAnswerFirst: false,
    requireExactFileReferences: false,
    summary: 'Search then write a summary file.',
    plan: {
      planId: 'plan:filesystem_task:create:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'search',
          summary: 'Search src/runtime for planned_steps.',
          required: true,
          expectedToolCategories: ['fs_search'],
        },
        {
          stepId: 'step_2',
          kind: 'write',
          summary: 'Write the summary to tmp/manual-web/planned-steps-summary.txt.',
          required: true,
          dependsOn: ['step_1'],
          expectedToolCategories: ['fs_write'],
        },
      ],
    },
  };
}

function verification(): VerificationDecision {
  return {
    decision: 'insufficient',
    reasons: ['Failed to satisfy step_2.'],
    retryable: true,
    missingEvidenceKinds: ['write'],
    unsatisfiedStepIds: ['step_2'],
  };
}

describe('recovery advisor', () => {
  it('validates a bounded write-step retry and builds deterministic guidance', () => {
    const proposal = parseRecoveryAdvisorProposal(JSON.stringify({
      decision: 'retry',
      reason: 'The write step has no filesystem mutation receipt.',
      actions: [{
        stepId: 'step_2',
        strategy: 'complete_missing_write',
        toolName: 'fs_write',
      }],
    }));

    const advice = validateRecoveryAdvisorProposal(proposal, {
      originalRequest: 'Search then write a summary.',
      taskContract: taskContract(),
      verification: verification(),
    });

    expect(advice?.actions).toEqual([{
      stepId: 'step_2',
      strategy: 'complete_missing_write',
      toolName: 'fs_write',
    }]);
    const section = buildRecoveryAdvisorAdditionalSection(advice!, taskContract());
    expect(section.content).toContain('successful filesystem mutation receipt');
    expect(section.content).toContain('Write retry requirements');
    expect(section.content).toContain('step_2');
  });

  it('builds deterministic write-step advice when the advisor proposal is unavailable', () => {
    const advice = buildDeterministicRecoveryAdvice({
      originalRequest: 'Search this repo and write only paths to tmp/manual-web/secret-scan-paths.txt.',
      taskContract: taskContract(),
      verification: verification(),
      jobSnapshots: [{
        toolName: 'fs_search',
        status: 'succeeded',
        resultPreview: 'Search returned 5 sanitized candidate paths.',
      }],
    });

    expect(advice).toMatchObject({
      reason: expect.stringContaining('Deterministic recovery'),
      actions: [{
        stepId: 'step_2',
        strategy: 'complete_missing_write',
        toolName: 'fs_write',
      }],
    });
    const section = buildRecoveryAdvisorAdditionalSection(advice!, taskContract());
    expect(section.content).toContain('Call the filesystem mutation tool');
    expect(section.content).toContain('Never include secret values');
  });

  it('rejects strategies that do not match the unsatisfied step kind', () => {
    const proposal = parseRecoveryAdvisorProposal(JSON.stringify({
      decision: 'retry',
      actions: [{
        stepId: 'step_2',
        strategy: 'complete_missing_search',
        toolName: 'fs_search',
      }],
    }));

    const advice = validateRecoveryAdvisorProposal(proposal, {
      originalRequest: 'Search then write a summary.',
      taskContract: taskContract(),
      verification: verification(),
    });

    expect(advice).toBeNull();
  });
});
