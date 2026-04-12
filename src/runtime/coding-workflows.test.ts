import { describe, expect, it } from 'vitest';

import {
  buildCodingWorkflowPlan,
  deriveCodeSessionWorkflowState,
  formatCodeSessionWorkflowForPrompt,
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
      [{
        id: 'vercel:vercel-main',
        profileId: 'vercel-main',
        profileName: 'Main Vercel',
        providerFamily: 'vercel',
        backendKind: 'vercel_sandbox',
        capabilityState: 'ready',
        reason: 'Ready for bounded remote sandbox execution.',
        projectId: 'prj_123',
        teamId: 'team_123',
        networkMode: 'allow_all',
        allowedDomains: [],
      }],
    ) as {
      workflow?: { type?: string; label?: string; stages?: Array<{ id: string }> };
      execution?: { isolation?: { level?: string; backendKind?: string } };
      inspect?: string[];
      verification?: string[];
    };

    expect(plan.workflow?.type).toBe('refactor');
    expect(plan.workflow?.label).toBe('Refactor');
    expect(plan.inspect).toEqual(['src/auth/middleware.ts', 'src/auth/middleware.test.ts']);
    expect(Array.isArray(plan.workflow?.stages)).toBe(true);
    expect(plan.verification?.[0]).toMatch(/targeted tests/i);
    expect(plan.execution?.isolation).toMatchObject({
      level: 'available',
      backendKind: 'vercel_sandbox',
    });
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

  it('recommends remote isolation when a ready sandbox target exists for higher-risk work', () => {
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: 'Review the dependency upgrade.',
      planSummary: 'Goal: Upgrade the dependency and verify the app still works.',
      pendingApprovals: [],
      recentJobs: [],
      verification: [],
      plannedWorkflowType: 'dependency_review',
      hasRepoEvidence: true,
      workspaceTrustState: 'trusted',
      remoteExecutionTargets: [{
        id: 'vercel:vercel-main',
        profileId: 'vercel-main',
        profileName: 'Main Vercel',
        providerFamily: 'vercel',
        backendKind: 'vercel_sandbox',
        capabilityState: 'ready',
        reason: 'Ready for bounded remote sandbox execution.',
        projectId: 'prj_123',
        teamId: 'team_123',
        networkMode: 'domain_allowlist',
        allowedDomains: ['registry.npmjs.org'],
      }],
      now: 999,
    });

    expect(workflow?.isolation).toMatchObject({
      level: 'recommended',
      backendKind: 'vercel_sandbox',
      profileId: 'vercel-main',
      networkMode: 'domain_allowlist',
    });
    expect(workflow?.isolation?.candidateOperations).toContain('dependency install');
  });

  it('includes isolation guidance in the coding-session prompt block', () => {
    const prompt = formatCodeSessionWorkflowForPrompt({
      type: 'dependency_review',
      recipeId: 'coding.inspect-compare-upgrade-verify',
      label: 'Dependency Review',
      summary: 'Inspect the version delta, compare impact, apply the upgrade carefully, then run the affected proof.',
      verificationMode: 'required',
      currentStage: 'verify',
      status: 'blocked',
      verificationState: 'pending',
      nextAction: 'Run the targeted checks.',
      isolation: {
        level: 'recommended',
        backendKind: 'vercel_sandbox',
        profileId: 'vercel-main',
        profileName: 'Main Vercel',
        reason: 'Dependency installs and upgrade verification are the cleanest first use for remote isolation.',
        candidateOperations: ['dependency install', 'build', 'test'],
        networkMode: 'domain_allowlist',
        allowedDomains: ['registry.npmjs.org'],
      },
      updatedAt: 1,
    });

    expect(prompt).toContain('workflowIsolation: recommended');
    expect(prompt).toContain('workflowIsolationBackend: vercel_sandbox');
    expect(prompt).toContain('workflowIsolationOperations: dependency install; build; test');
  });
});
