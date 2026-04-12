import { describe, expect, it } from 'vitest';

import {
  buildCodingWorkflowPlan,
  deriveCodeSessionWorkflowState,
  inferCodingWorkflowType,
} from './coding-workflows.js';

describe('coding workflow recipes', () => {
  it('infers workflow types from common coding requests', () => {
    expect(inferCodingWorkflowType('Review this PR for regressions.')).toBe('code_review');
    expect(inferCodingWorkflowType('Refactor the API client.')).toBe('refactor');
    expect(inferCodingWorkflowType('Fix the failing auth bug.')).toBe('bug_fix');
    expect(inferCodingWorkflowType('Turn this spec into an implementation plan.')).toBe('spec_to_plan');
  });

  it('builds a structured coding workflow plan with recipe metadata', () => {
    const plan = buildCodingWorkflowPlan(
      'Refactor the auth middleware and add regression coverage for token parsing failures.',
      '/repo',
      ['src/auth/middleware.ts', 'src/auth/middleware.test.ts'],
    ) as {
      workflow?: { type?: string; label?: string; stages?: Array<{ id: string }> };
      inspect?: string[];
      verification?: string[];
    };

    expect(plan.workflow?.type).toBe('refactor');
    expect(plan.workflow?.label).toBe('Refactor');
    expect(plan.inspect).toEqual(['src/auth/middleware.ts', 'src/auth/middleware.test.ts']);
    expect(Array.isArray(plan.workflow?.stages)).toBe(true);
    expect(plan.verification?.[0]).toMatch(/targeted tests/i);
  });

  it('blocks the workflow until repo evidence exists', () => {
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: 'Investigate the auth middleware.',
      planSummary: '',
      pendingApprovals: [],
      recentJobs: [],
      verification: [],
      hasRepoEvidence: false,
      now: 123,
    });

    expect(workflow).toMatchObject({
      currentStage: 'inspect',
      status: 'blocked',
      verificationState: 'not_started',
      updatedAt: 123,
    });
    expect(workflow?.blockedReason).toMatch(/repo evidence/i);
  });

  it('holds implementation workflows in verify until proof exists', () => {
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: 'Fix the auth failure.',
      planSummary: 'Goal: Fix the auth failure.',
      pendingApprovals: [],
      recentJobs: [
        {
          id: 'job-1',
          toolName: 'code_edit',
          status: 'succeeded',
        },
      ],
      verification: [],
      plannedWorkflowType: 'bug_fix',
      hasRepoEvidence: true,
      now: 456,
    });

    expect(workflow).toMatchObject({
      type: 'bug_fix',
      currentStage: 'verify',
      status: 'blocked',
      verificationState: 'pending',
      updatedAt: 456,
    });
    expect(workflow?.nextAction).toMatch(/targeted tests|proof/i);
  });

  it('completes specification-to-plan workflows after the plan is ready', () => {
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: 'Turn the spec into a plan.',
      planSummary: 'Goal: Turn the spec into a plan.',
      pendingApprovals: [],
      recentJobs: [],
      verification: [],
      plannedWorkflowType: 'spec_to_plan',
      hasRepoEvidence: true,
      now: 789,
    });

    expect(workflow).toMatchObject({
      type: 'spec_to_plan',
      currentStage: 'summarize',
      status: 'completed',
      verificationState: 'not_required',
      updatedAt: 789,
    });
  });
});
