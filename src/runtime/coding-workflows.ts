import type { CodeSessionRecentJob, CodeSessionVerificationEntry } from './code-sessions.js';
import {
  recommendWorkflowIsolation,
  type RemoteExecutionTargetDescriptor,
  type WorkflowIsolationRecommendation,
} from './remote-execution/policy.js';

export type CodeSessionWorkflowType =
  | 'implementation'
  | 'bug_fix'
  | 'code_review'
  | 'refactor'
  | 'test_repair'
  | 'dependency_review'
  | 'spec_to_plan';

export type CodeSessionWorkflowStage =
  | 'inspect'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'summarize';

export type CodeSessionWorkflowVerificationMode = 'required' | 'recommended' | 'not_required';
export type CodeSessionWorkflowStatus = 'ready' | 'in_progress' | 'blocked' | 'completed';
export type CodeSessionWorkflowVerificationState = 'not_started' | 'pending' | 'running' | 'passed' | 'failed' | 'not_required';

export interface CodeSessionWorkflowIsolationState {
  level: WorkflowIsolationRecommendation['level'];
  backendKind?: WorkflowIsolationRecommendation['backendKind'];
  profileId?: string;
  profileName?: string;
  reason?: string;
  candidateOperations: string[];
  networkMode?: WorkflowIsolationRecommendation['networkMode'];
  allowedDomains?: string[];
  allowedCidrs?: string[];
}

export interface CodeSessionWorkflowRecipeStage {
  id: CodeSessionWorkflowStage;
  label: string;
  detail: string;
}

export interface CodeSessionWorkflowRecipe {
  type: CodeSessionWorkflowType;
  label: string;
  recipeId: string;
  summary: string;
  verificationMode: CodeSessionWorkflowVerificationMode;
  stages: CodeSessionWorkflowRecipeStage[];
}

export interface CodeSessionWorkflowState {
  type: CodeSessionWorkflowType;
  recipeId: string;
  label: string;
  summary: string;
  verificationMode: CodeSessionWorkflowVerificationMode;
  currentStage: CodeSessionWorkflowStage;
  status: CodeSessionWorkflowStatus;
  verificationState: CodeSessionWorkflowVerificationState;
  nextAction: string;
  blockedReason?: string;
  isolation?: CodeSessionWorkflowIsolationState | null;
  updatedAt: number;
}

interface DeriveCodeSessionWorkflowStateInput {
  focusSummary?: string;
  planSummary?: string;
  pendingApprovals?: unknown[];
  recentJobs?: CodeSessionRecentJob[];
  verification?: CodeSessionVerificationEntry[];
  previous?: CodeSessionWorkflowState | null;
  plannedWorkflowType?: CodeSessionWorkflowType | null;
  hasRepoEvidence?: boolean;
  workspaceTrustState?: string | null;
  remoteExecutionTargets?: RemoteExecutionTargetDescriptor[];
  now?: number;
}

const CODING_WORKFLOW_RECIPES: Record<CodeSessionWorkflowType, CodeSessionWorkflowRecipe> = {
  implementation: {
    type: 'implementation',
    label: 'Implementation',
    recipeId: 'coding.inspect-plan-implement-verify',
    summary: 'Inspect the repo, confirm a bounded plan, implement the change, verify it, and summarize the proof.',
    verificationMode: 'required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the repo evidence and confirm the owner files before changing anything.' },
      { id: 'plan', label: 'Plan', detail: 'Write a bounded implementation plan and call out the intended verification.' },
      { id: 'implement', label: 'Implement', detail: 'Make the smallest coherent change that satisfies the plan.' },
      { id: 'verify', label: 'Verify', detail: 'Run targeted proof for the touched area before closing the loop.' },
      { id: 'summarize', label: 'Summarize', detail: 'Report what changed, which files moved, and what proof passed.' },
    ],
  },
  bug_fix: {
    type: 'bug_fix',
    label: 'Bug Fix',
    recipeId: 'coding.inspect-reproduce-patch-verify',
    summary: 'Reproduce the failure, patch the root cause, rerun the failing checks first, then summarize the regression proof.',
    verificationMode: 'required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Gather failure evidence, affected files, and the likely owner path.' },
      { id: 'plan', label: 'Plan', detail: 'Describe the root-cause hypothesis and the narrowest fix path.' },
      { id: 'implement', label: 'Implement', detail: 'Patch the failing logic without widening the change unnecessarily.' },
      { id: 'verify', label: 'Verify', detail: 'Reproduce the original failure and rerun the targeted regression checks.' },
      { id: 'summarize', label: 'Summarize', detail: 'State the root cause, the fix, and the verification that now passes.' },
    ],
  },
  code_review: {
    type: 'code_review',
    label: 'Code Review',
    recipeId: 'coding.inspect-review-validate',
    summary: 'Inspect the diff and surrounding files, identify the concrete risks, validate the claims, and summarize the findings.',
    verificationMode: 'recommended',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the changed files and the surrounding code before judging the patch.' },
      { id: 'plan', label: 'Plan', detail: 'Frame the review around correctness, regressions, and missing proof.' },
      { id: 'implement', label: 'Review', detail: 'Collect concrete findings, not generic opinions or style noise.' },
      { id: 'verify', label: 'Validate', detail: 'Confirm the findings against tests, execution proof, or adjacent code paths when needed.' },
      { id: 'summarize', label: 'Summarize', detail: 'Report findings first, then note residual risks or missing proof.' },
    ],
  },
  refactor: {
    type: 'refactor',
    label: 'Refactor',
    recipeId: 'coding.inspect-plan-refactor-verify',
    summary: 'Inspect the current shape, refactor while preserving behavior, then prove the behavior still holds.',
    verificationMode: 'required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the current design and the coupled call sites before reshaping it.' },
      { id: 'plan', label: 'Plan', detail: 'Define the safe change boundary and the behavior that must remain intact.' },
      { id: 'implement', label: 'Implement', detail: 'Refactor in the smallest coherent steps that preserve behavior.' },
      { id: 'verify', label: 'Verify', detail: 'Run focused tests or build proof that covers the reshaped behavior.' },
      { id: 'summarize', label: 'Summarize', detail: 'Explain the structural improvement and the evidence that behavior stayed intact.' },
    ],
  },
  test_repair: {
    type: 'test_repair',
    label: 'Test Repair',
    recipeId: 'coding.inspect-reproduce-repair-verify',
    summary: 'Inspect the failing tests, repair the broken path or assertions, rerun the failing lane first, then summarize the outcome.',
    verificationMode: 'required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the failing tests, fixtures, and touched production path first.' },
      { id: 'plan', label: 'Plan', detail: 'Decide whether the failure is in the tests, the product logic, or both.' },
      { id: 'implement', label: 'Implement', detail: 'Repair the minimum failing path before widening the change.' },
      { id: 'verify', label: 'Verify', detail: 'Rerun the failing tests first, then expand verification only if needed.' },
      { id: 'summarize', label: 'Summarize', detail: 'State which tests were repaired, why they failed, and what now passes.' },
    ],
  },
  dependency_review: {
    type: 'dependency_review',
    label: 'Dependency Review',
    recipeId: 'coding.inspect-compare-upgrade-verify',
    summary: 'Inspect the version delta, compare impact, apply the upgrade carefully, then run the affected proof.',
    verificationMode: 'required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the dependency boundary, lockfile impact, and likely affected surfaces.' },
      { id: 'plan', label: 'Plan', detail: 'Decide the upgrade path, rollback risk, and the proof required afterward.' },
      { id: 'implement', label: 'Implement', detail: 'Apply the upgrade or pin change without broad unrelated churn.' },
      { id: 'verify', label: 'Verify', detail: 'Run the narrowest tests, build, or lint proof that covers the upgraded area.' },
      { id: 'summarize', label: 'Summarize', detail: 'Report the version change, risk notes, and verification proof.' },
    ],
  },
  spec_to_plan: {
    type: 'spec_to_plan',
    label: 'Specification To Plan',
    recipeId: 'coding.inspect-scope-plan-summarize',
    summary: 'Inspect the specification and repo evidence, produce a bounded implementation plan, then summarize next steps.',
    verificationMode: 'not_required',
    stages: [
      { id: 'inspect', label: 'Inspect', detail: 'Read the spec, adjacent code, and owner files before proposing work.' },
      { id: 'plan', label: 'Plan', detail: 'Break the work into bounded implementation steps with risks and verification.' },
      { id: 'implement', label: 'Implement', detail: 'Implementation is intentionally deferred in this workflow.' },
      { id: 'verify', label: 'Verify', detail: 'Verification is deferred because this workflow ends at the plan.' },
      { id: 'summarize', label: 'Summarize', detail: 'Report the plan, open questions, and next actions.' },
    ],
  },
};

export function cloneCodeSessionWorkflowState(
  workflow: CodeSessionWorkflowState | null | undefined,
): CodeSessionWorkflowState | null {
  return workflow
    ? {
        ...workflow,
        isolation: workflow.isolation
          ? {
              ...workflow.isolation,
              candidateOperations: [...workflow.isolation.candidateOperations],
              allowedDomains: workflow.isolation.allowedDomains ? [...workflow.isolation.allowedDomains] : undefined,
              allowedCidrs: workflow.isolation.allowedCidrs ? [...workflow.isolation.allowedCidrs] : undefined,
            }
          : null,
      }
    : null;
}

export function getCodingWorkflowRecipe(type: CodeSessionWorkflowType): CodeSessionWorkflowRecipe {
  return CODING_WORKFLOW_RECIPES[type];
}

export function listCodingWorkflowRecipes(): CodeSessionWorkflowRecipe[] {
  return Object.values(CODING_WORKFLOW_RECIPES).map((recipe) => ({
    ...recipe,
    stages: recipe.stages.map((stage) => ({ ...stage })),
  }));
}

export function inferCodingWorkflowType(task: string, fallback: CodeSessionWorkflowType = 'implementation'): CodeSessionWorkflowType {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return fallback;
  if (/\b(review|audit|inspect diff|review pr|review patch)\b/.test(normalized)) return 'code_review';
  if (/\b(refactor|cleanup|restructure|reshape)\b/.test(normalized)) return 'refactor';
  if (/\b(test fix|fix test|repair test|flaky test|failing test|broken test)\b/.test(normalized)) return 'test_repair';
  if (/\b(upgrade|dependency|dependencies|package bump|version bump|migrate package)\b/.test(normalized)) return 'dependency_review';
  if (/\b(spec|specification|proposal|implementation plan|plan this|turn .* into a plan)\b/.test(normalized)) return 'spec_to_plan';
  if (/\b(fix|bug|issue|error|failure|regression|broken)\b/.test(normalized)) return 'bug_fix';
  return 'implementation';
}

function buildWorkflowSpecificChanges(type: CodeSessionWorkflowType): string[] {
  switch (type) {
    case 'bug_fix':
      return ['Patch the root cause and keep the regression boundary explicit.'];
    case 'code_review':
      return ['Inspect the change set and surrounding code without making assumptions.'];
    case 'refactor':
      return ['Restructure the implementation while preserving behavior.'];
    case 'test_repair':
      return ['Repair the failing tests or the narrow product path they prove.'];
    case 'dependency_review':
      return ['Apply the dependency change with minimal unrelated churn.'];
    case 'spec_to_plan':
      return ['Convert the specification into a bounded execution plan instead of editing code immediately.'];
    default:
      return ['Add the requested functionality and integrate it with existing patterns.'];
  }
}

function buildWorkflowSpecificVerification(
  type: CodeSessionWorkflowType,
  verificationMode: CodeSessionWorkflowVerificationMode,
): string[] {
  if (verificationMode === 'not_required') {
    return ['Document the verification that should run once implementation starts.'];
  }
  switch (type) {
    case 'bug_fix':
      return ['Reproduce the original failure, then rerun the failing checks first.'];
    case 'code_review':
      return ['Validate the concrete findings against tests, diffs, or adjacent code paths when needed.'];
    case 'refactor':
      return ['Run targeted tests that prove behavior stayed intact after the refactor.'];
    case 'test_repair':
      return ['Rerun the failing tests first, then expand verification only if the scope widened.'];
    case 'dependency_review':
      return ['Run the narrowest test, build, or lint proof that covers the upgraded dependency surface.'];
    default:
      return ['Run focused tests and a build or lint pass if the touched area supports them.'];
  }
}

function buildWorkflowSpecificRisks(type: CodeSessionWorkflowType): string[] {
  switch (type) {
    case 'bug_fix':
      return ['Fixing symptoms without addressing the actual root cause.'];
    case 'code_review':
      return ['Missing a behavior regression because the surrounding context was not inspected.'];
    case 'refactor':
      return ['Mechanical edits widening into behavior changes.'];
    case 'test_repair':
      return ['Masking a real product defect by weakening the test.'];
    case 'dependency_review':
      return ['Upgrade fallout in adjacent packages or runtime behavior.'];
    case 'spec_to_plan':
      return ['Planning against stale assumptions instead of repo evidence.'];
    default:
      return ['Scope creep into unrelated modules.'];
  }
}

export function buildCodingWorkflowPlan(
  task: string,
  cwd: string,
  selectedFiles: string[],
  remoteExecutionTargets: RemoteExecutionTargetDescriptor[] = [],
): Record<string, unknown> {
  const normalizedTask = task.trim();
  const workflowType = inferCodingWorkflowType(normalizedTask);
  const recipe = getCodingWorkflowRecipe(workflowType);
  const inspect = selectedFiles.length > 0 ? selectedFiles : ['relevant source files', 'tests', 'config'];
  const isolation = recommendWorkflowIsolation(workflowType, { targets: remoteExecutionTargets });

  return {
    goal: normalizedTask,
    cwd,
    workflow: {
      type: recipe.type,
      label: recipe.label,
      recipeId: recipe.recipeId,
      summary: recipe.summary,
      verificationMode: recipe.verificationMode,
      stages: recipe.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        detail: stage.detail,
      })),
    },
    execution: {
      isolation,
    },
    inspect,
    changes: buildWorkflowSpecificChanges(workflowType),
    verification: buildWorkflowSpecificVerification(workflowType, recipe.verificationMode),
    risks: buildWorkflowSpecificRisks(workflowType),
    plan: recipe.stages
      .filter((stage) => !(workflowType === 'spec_to_plan' && stage.id === 'implement'))
      .filter((stage) => !(recipe.verificationMode === 'not_required' && stage.id === 'verify'))
      .map((stage) => stage.detail),
  };
}

function isVerificationToolName(toolName: string): boolean {
  return toolName === 'code_test' || toolName === 'code_lint' || toolName === 'code_build';
}

function isImplementationJob(job: CodeSessionRecentJob): boolean {
  const toolName = String(job?.toolName || '').trim();
  if (!toolName) return false;
  if (toolName === 'code_plan' || toolName === 'find_tools') return false;
  if (isVerificationToolName(toolName)) return false;
  if (job.verificationStatus) return false;
  return toolName === 'code_edit'
    || toolName === 'code_patch'
    || toolName === 'code_create'
    || toolName.startsWith('fs_')
    || toolName === 'shell_safe'
    || toolName === 'package_install';
}

function resolveVerificationState(
  verificationMode: CodeSessionWorkflowVerificationMode,
  recentJobs: CodeSessionRecentJob[],
  verification: CodeSessionVerificationEntry[],
  hasImplementationActivity: boolean,
): CodeSessionWorkflowVerificationState {
  if (verificationMode === 'not_required') {
    return 'not_required';
  }
  if (recentJobs.some((job) => isVerificationToolName(String(job.toolName || '').trim()) && job.status === 'running')) {
    return 'running';
  }
  if (verification.some((entry) => entry.status === 'fail')) {
    return 'failed';
  }
  if (recentJobs.some((job) => job.status === 'failed' && isVerificationToolName(String(job.toolName || '').trim()))) {
    return 'failed';
  }
  if (recentJobs.some((job) => job.verificationStatus === 'unverified')) {
    return 'failed';
  }
  if (verification.some((entry) => entry.status === 'pass')) {
    return 'passed';
  }
  if (recentJobs.some((job) => job.verificationStatus === 'verified')) {
    return 'passed';
  }
  if (hasImplementationActivity) {
    return 'pending';
  }
  return 'not_started';
}

export function deriveCodeSessionWorkflowState(input: DeriveCodeSessionWorkflowStateInput): CodeSessionWorkflowState | null {
  const type = input.plannedWorkflowType
    || input.previous?.type
    || inferCodingWorkflowType(input.planSummary || input.focusSummary || '');
  const recipe = getCodingWorkflowRecipe(type);
  const now = input.now ?? Date.now();
  const recentJobs = Array.isArray(input.recentJobs) ? input.recentJobs : [];
  const verification = Array.isArray(input.verification) ? input.verification : [];
  const pendingApprovals = Array.isArray(input.pendingApprovals) ? input.pendingApprovals : [];
  const hasPlan = Boolean(input.planSummary?.trim());
  const hasRepoEvidence = input.hasRepoEvidence !== false;
  const runningImplementation = recentJobs.some((job) => isImplementationJob(job) && job.status === 'running');
  const hasImplementationActivity = runningImplementation
    || recentJobs.some((job) => isImplementationJob(job) && (job.status === 'succeeded' || job.status === 'pending_approval'));
  const verificationState = resolveVerificationState(recipe.verificationMode, recentJobs, verification, hasImplementationActivity);
  const isolation = recommendWorkflowIsolation(type, {
    targets: input.remoteExecutionTargets,
    workspaceTrustState: input.workspaceTrustState,
  });

  let currentStage: CodeSessionWorkflowStage = 'inspect';
  let status: CodeSessionWorkflowStatus = 'ready';
  let nextAction = recipe.stages[0].detail;
  let blockedReason: string | undefined;

  if (!hasRepoEvidence && !hasPlan) {
    currentStage = 'inspect';
    status = 'blocked';
    blockedReason = 'Repo evidence is still missing.';
    nextAction = 'Inspect the workspace files and gather concrete repo evidence before continuing.';
  } else if (!hasPlan) {
    currentStage = 'plan';
    status = 'ready';
    nextAction = recipe.stages.find((stage) => stage.id === 'plan')?.detail || 'Write a bounded plan before editing.';
  } else if (pendingApprovals.length > 0) {
    currentStage = 'implement';
    status = 'blocked';
    blockedReason = 'A pending approval is pausing the workflow.';
    nextAction = 'Resolve the pending approval so the next coding step can continue.';
  } else if (type === 'spec_to_plan' && hasPlan) {
    currentStage = 'summarize';
    status = 'completed';
    nextAction = 'Summarize the plan, open questions, and next implementation steps.';
  } else if (runningImplementation) {
    currentStage = 'implement';
    status = 'in_progress';
    nextAction = 'Let the current coding step finish, then inspect the resulting diff.';
  } else if (!hasImplementationActivity) {
    currentStage = 'implement';
    status = 'ready';
    nextAction = recipe.stages.find((stage) => stage.id === 'implement')?.detail || 'Make the next bounded code change.';
  } else if (verificationState === 'running') {
    currentStage = 'verify';
    status = 'in_progress';
    nextAction = 'Wait for the verification run to complete and inspect the result.';
  } else if (verificationState === 'failed') {
    currentStage = 'verify';
    status = 'blocked';
    blockedReason = 'Verification is still failing.';
    nextAction = 'Fix the failing checks or narrow the change before declaring completion.';
  } else if (verificationState === 'pending' && recipe.verificationMode === 'required') {
    currentStage = 'verify';
    status = 'blocked';
    blockedReason = 'Verification is still missing.';
    nextAction = 'Run targeted tests, lint, or build proof before treating the workflow as complete.';
  } else if (verificationState === 'pending') {
    currentStage = 'verify';
    status = 'ready';
    nextAction = 'Run targeted proof before you close the loop on this workflow.';
  } else {
    currentStage = 'summarize';
    status = 'completed';
    nextAction = 'Summarize the changed files and the verification evidence for the operator.';
  }

  return {
    type: recipe.type,
    recipeId: recipe.recipeId,
    label: recipe.label,
    summary: recipe.summary,
    verificationMode: recipe.verificationMode,
    currentStage,
    status,
    verificationState,
    nextAction,
    ...(blockedReason ? { blockedReason } : {}),
    isolation,
    updatedAt: now,
  };
}

export function formatCodeSessionWorkflowForPrompt(workflow: CodeSessionWorkflowState | null | undefined): string {
  if (!workflow) {
    return 'workflow: (none)';
  }
  const lines = [
    `workflow: ${workflow.label}`,
    `workflowRecipeId: ${workflow.recipeId}`,
    `workflowStage: ${workflow.currentStage}`,
    `workflowStatus: ${workflow.status}`,
    `workflowVerification: ${workflow.verificationState}`,
    `workflowNextAction: ${workflow.nextAction}`,
  ];
  if (workflow.blockedReason) {
    lines.push(`workflowBlockedReason: ${workflow.blockedReason}`);
  }
  if (workflow.isolation && workflow.isolation.level !== 'none') {
    lines.push(`workflowIsolation: ${workflow.isolation.level}`);
    if (workflow.isolation.backendKind) {
      lines.push(`workflowIsolationBackend: ${workflow.isolation.backendKind}`);
    }
    if (workflow.isolation.profileId) {
      lines.push(`workflowIsolationProfile: ${workflow.isolation.profileId}`);
    }
    if (workflow.isolation.reason) {
      lines.push(`workflowIsolationReason: ${workflow.isolation.reason}`);
    }
    if (workflow.isolation.candidateOperations.length > 0) {
      lines.push(`workflowIsolationOperations: ${workflow.isolation.candidateOperations.join('; ')}`);
    }
    if (workflow.isolation.networkMode) {
      lines.push(`workflowIsolationNetwork: ${workflow.isolation.networkMode}`);
    }
    if (workflow.isolation.allowedDomains?.length) {
      lines.push(`workflowIsolationAllowedDomains: ${workflow.isolation.allowedDomains.join('; ')}`);
    }
    if (workflow.isolation.allowedCidrs?.length) {
      lines.push(`workflowIsolationAllowedCidrs: ${workflow.isolation.allowedCidrs.join('; ')}`);
    }
  }
  return lines.join('\n');
}
