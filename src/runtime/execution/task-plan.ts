import type { IntentGatewayDecision } from '../intent-gateway.js';
import type {
  AnswerConstraints,
  DelegatedTaskContractKind,
  EvidenceReceipt,
  Interruption,
  PlannedStep,
  PlannedStepKind,
  PlannedTask,
  StepReceipt,
  WorkerRunStatus,
  WorkerStopReason,
} from './types.js';

type GatewayPlannedStep = NonNullable<IntentGatewayDecision['plannedSteps']>[number];

const PATHLIKE_TOKEN_PATTERN = /(?:[a-zA-Z]:)?[./\\][^\s,;:()]+|[a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+|[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]+/g;
const SECOND_BRAIN_READ_TOOL_NAMES = new Set([
  'second_brain_overview',
  'second_brain_brief_list',
  'second_brain_note_list',
  'second_brain_task_list',
  'second_brain_calendar_list',
  'second_brain_people_list',
  'second_brain_library_list',
  'second_brain_routine_list',
  'second_brain_routine_catalog',
]);
const REPO_INSPECTION_TOOL_NAMES = new Set([
  'fs_search',
  'fs_read',
  'fs_list',
  'code_symbol_search',
]);
const BROWSER_READ_TOOL_NAMES = new Set([
  'browser_read',
  'browser_links',
  'browser_extract',
  'browser_state',
]);
const MEMORY_READ_TOOL_NAMES = new Set([
  'memory_recall',
  'memory_search',
]);
const AUTOMATION_WRITE_TOOL_NAMES = new Set([
  'automation_delete',
  'automation_save',
  'automation_set_enabled',
]);

export interface ToolStepMatchInput {
  hintStepId?: string;
  toolName: string;
  args: Record<string, unknown>;
  plannedTask: PlannedTask;
  previouslyMatchedStepIds?: Set<string>;
}

export interface BuildStepReceiptsInput {
  plannedTask: PlannedTask;
  evidenceReceipts: EvidenceReceipt[];
  toolReceiptStepIds?: Map<string, string>;
  finalAnswerReceiptId?: string;
  interruptions?: Interruption[];
}

export function buildPlannedTask(
  decision: IntentGatewayDecision | null | undefined,
  contract: {
    kind: DelegatedTaskContractKind;
    route?: string;
    operation?: string;
    summary?: string;
    requireExactFileReferences?: boolean;
    answerConstraints?: AnswerConstraints;
  },
): PlannedTask {
  const normalizedGatewaySteps = Array.isArray(decision?.plannedSteps)
    ? decision.plannedSteps
        .map((step, index) => normalizeGatewayPlannedStep(step, index))
        .filter((step): step is PlannedStep => !!step)
    : [];
  const gatewaySteps = shouldUseGatewayPlannedSteps(normalizedGatewaySteps, contract)
    ? normalizedGatewaySteps.map((step) => applyDefaultExpectedToolCategories(step, contract))
    : [];

  const toolSynthesisFallback = buildReadOnlyToolSynthesisFallbackPlan(
    decision,
    contract,
    gatewaySteps,
  );
  if (toolSynthesisFallback) {
    return toolSynthesisFallback;
  }

  if (gatewaySteps.length > 0) {
    const answerBackedSteps = ensureRequiredAnswerStep(gatewaySteps, contract);
    const steps = ensureExactFileReferenceReadStep(
      applyContractAnswerSummary(answerBackedSteps, contract.summary, contract.answerConstraints),
      contract,
    );
    return {
      planId: buildPlanId(decision?.route ?? contract.route, decision?.operation ?? contract.operation, steps.length),
      steps,
      allowAdditionalSteps: steps.some(hasRuntimeEvidencePlaceholder),
    };
  }

  const emptyPlanToolSynthesisFallback = buildReadOnlyToolSynthesisFallbackPlan(
    decision,
    contract,
    [],
  );
  if (emptyPlanToolSynthesisFallback) {
    return emptyPlanToolSynthesisFallback;
  }

  if (contract.kind === 'general_answer') {
    return {
      planId: buildPlanId(contract.route, contract.operation, 1),
      steps: [{
        stepId: 'step_1',
        kind: 'answer',
        summary: contract.summary?.trim() || 'Answer the request directly.',
        required: true,
      }],
      allowAdditionalSteps: false,
    };
  }

  if (contract.kind === 'repo_inspection') {
    const needsExactFileRead = contract.requireExactFileReferences === true;
    const answerDependsOn = needsExactFileRead ? ['step_1', 'step_2'] : ['step_1'];
    const answerSummary = enrichAnswerSummaryForConstraints(
      contract.summary?.trim() || 'Answer with grounded findings from the inspected repo files.',
      contract.answerConstraints,
    );
    const repoSteps: PlannedStep[] = [
      {
        stepId: 'step_1',
        kind: 'search',
        summary: 'Search the repo for the relevant implementation files.',
        required: true,
      },
      ...(needsExactFileRead
        ? [{
            stepId: 'step_2',
            kind: 'read' as const,
            summary: 'Read the specific implementation files needed to ground the exact file references.',
            required: true,
            dependsOn: ['step_1'],
          }]
        : []),
      {
        stepId: needsExactFileRead ? 'step_3' : 'step_2',
        kind: 'answer',
        summary: answerSummary,
        required: true,
        dependsOn: answerDependsOn,
      },
    ];
    const steps = repoSteps.map((step) => applyDefaultExpectedToolCategories(step, contract));
    return {
      planId: buildPlanId(contract.route, contract.operation, steps.length),
      steps,
      allowAdditionalSteps: true,
    };
  }

  const steps = ensureExactFileReferenceReadStep([applyDefaultExpectedToolCategories({
    stepId: 'step_1',
    kind: inferDefaultPlannedStepKind(contract.kind, contract.operation),
    summary: contract.summary?.trim() || 'Complete the requested work.',
    required: true,
  }, contract)], contract);
  return {
    planId: buildPlanId(contract.route, contract.operation, steps.length),
    steps,
    allowAdditionalSteps: true,
  };
}

function shouldUseGatewayPlannedSteps(
  steps: PlannedStep[],
  contract: {
    kind: DelegatedTaskContractKind;
  },
): boolean {
  if (steps.length === 0) return false;
  switch (contract.kind) {
    case 'filesystem_mutation':
      return steps.some((step) => step.kind === 'write'
        || step.expectedToolCategories?.some(isWriteToolCategory));
    case 'tool_execution':
      return steps.some((step) => step.kind === 'tool_call'
        || step.kind === 'search'
        || step.kind === 'read'
        || step.kind === 'write'
        || step.expectedToolCategories?.some(isActionToolCategory));
    case 'general_answer':
    case 'repo_inspection':
    case 'security_analysis':
      return true;
  }
}

function isWriteToolCategory(value: string): boolean {
  return value === 'write'
    || value === 'fs_write'
    || value === 'fs_mkdir'
    || value === 'fs_delete'
    || value === 'fs_move'
    || value === 'fs_copy';
}

function isExecutionToolCategory(value: string): boolean {
  return value === 'tool_call'
    || value === 'code_remote_exec'
    || value === 'execute_code'
    || value === 'shell'
    || value === 'command';
}

function isActionToolCategory(value: string): boolean {
  return isExecutionToolCategory(value)
    || isWriteToolCategory(value)
    || value === 'search'
    || value === 'read'
    || value === 'fs_search'
    || value === 'code_symbol_search'
    || value === 'fs_read'
    || value === 'fs_list'
    || value === 'web_search'
    || value === 'web_fetch'
    || value === 'browser'
    || value.startsWith('browser_')
    || value === 'memory'
    || value === 'memory_search'
    || value === 'memory_recall'
    || value === 'memory_save'
    || value === 'automation'
    || value === 'automation_list'
    || value.startsWith('second_brain_')
    || value === 'second_brain';
}

function ensureExactFileReferenceReadStep(
  steps: PlannedStep[],
  contract: {
    kind: DelegatedTaskContractKind;
    requireExactFileReferences?: boolean;
  },
): PlannedStep[] {
  if (contract.kind !== 'repo_inspection' || contract.requireExactFileReferences !== true) {
    return steps;
  }
  if (steps.some((step) => step.kind === 'read')) {
    return steps;
  }

  const answerIndex = steps.findIndex((step) => step.kind === 'answer');
  const priorStepId = answerIndex > 0
    ? steps[answerIndex - 1]?.stepId
    : answerIndex < 0
      ? steps[steps.length - 1]?.stepId
      : undefined;
  const exactFileReadStep: PlannedStep = {
    stepId: '__exact_file_read__',
    kind: 'read',
    summary: 'Read the specific implementation files needed to ground the exact file references.',
    expectedToolCategories: ['fs_read', 'fs_list'],
    required: true,
    ...(priorStepId ? { dependsOn: [priorStepId] } : {}),
  };
  const nextSteps = [...steps];
  if (answerIndex >= 0) {
    const answerStep = nextSteps[answerIndex];
    nextSteps.splice(answerIndex, 0, exactFileReadStep);
    if (answerStep) {
      const nextDependsOn = new Set(answerStep.dependsOn ?? []);
      nextDependsOn.add(exactFileReadStep.stepId);
      nextSteps[answerIndex + 1] = {
        ...answerStep,
        dependsOn: [...nextDependsOn],
      };
    }
  } else {
    nextSteps.push(exactFileReadStep);
  }
  return renumberPlannedSteps(nextSteps);
}

function ensureRequiredAnswerStep(
  steps: PlannedStep[],
  contract: {
    kind: DelegatedTaskContractKind;
    summary?: string;
    answerConstraints?: AnswerConstraints;
  },
): PlannedStep[] {
  if (steps.some((step) => step.kind === 'answer')) {
    return steps;
  }
  if (!shouldRequireFinalAnswerStep(contract.kind)) {
    return steps;
  }
  const requiredEvidenceStepIds = steps
    .filter((step) => step.required !== false)
    .map((step) => step.stepId);
  const answerSummary = enrichAnswerSummaryForConstraints(
    contract.summary?.trim() || 'Answer with grounded findings from the collected evidence.',
    contract.answerConstraints,
  );
  return renumberPlannedSteps([
    ...steps,
    {
      stepId: '__answer__',
      kind: 'answer',
      summary: answerSummary,
      required: true,
      ...(requiredEvidenceStepIds.length > 0 ? { dependsOn: requiredEvidenceStepIds } : {}),
    },
  ]);
}

function shouldRequireFinalAnswerStep(kind: DelegatedTaskContractKind): boolean {
  return kind === 'repo_inspection'
    || kind === 'security_analysis'
    || kind === 'general_answer'
    || kind === 'tool_execution';
}

function hasRuntimeEvidencePlaceholder(step: PlannedStep): boolean {
  return step.expectedToolCategories?.some((category) => category.trim() === 'runtime_evidence') === true;
}

function buildReadOnlyToolSynthesisFallbackPlan(
  decision: IntentGatewayDecision | null | undefined,
  contract: {
    kind: DelegatedTaskContractKind;
    route?: string;
    operation?: string;
    summary?: string;
    answerConstraints?: AnswerConstraints;
  },
  gatewaySteps: PlannedStep[],
): PlannedTask | null {
  if (!shouldRequireReadOnlyToolSynthesisEvidence(decision, contract)) {
    return null;
  }
  if (gatewaySteps.some((step) => step.kind !== 'answer')) {
    return null;
  }
  const answerSummary = buildToolSynthesisFallbackAnswerSummary(gatewaySteps, contract);
  const steps: PlannedStep[] = [
    {
      stepId: 'step_1',
      kind: 'tool_call',
      summary: 'Collect real runtime/tool evidence needed to answer the request across the requested domains.',
      expectedToolCategories: ['runtime_evidence'],
      required: true,
    },
    {
      stepId: 'step_2',
      kind: 'answer',
      summary: answerSummary,
      required: true,
      dependsOn: ['step_1'],
    },
  ];
  return {
    planId: buildPlanId(decision?.route ?? contract.route, decision?.operation ?? contract.operation, steps.length),
    steps,
    allowAdditionalSteps: true,
  };
}

function shouldRequireReadOnlyToolSynthesisEvidence(
  decision: IntentGatewayDecision | null | undefined,
  contract: {
    kind: DelegatedTaskContractKind;
    operation?: string;
  },
): boolean {
  if (contract.kind !== 'general_answer') {
    return false;
  }
  const operation = decision?.operation ?? contract.operation;
  if (operation !== 'inspect' && operation !== 'read' && operation !== 'search') {
    return false;
  }
  return decision?.requiresToolSynthesis === true
    || decision?.preferredAnswerPath === 'tool_loop'
    || decision?.executionClass === 'tool_orchestration'
    || decision?.executionClass === 'provider_crud';
}

function buildToolSynthesisFallbackAnswerSummary(
  gatewaySteps: PlannedStep[],
  contract: {
    summary?: string;
    answerConstraints?: AnswerConstraints;
  },
): string {
  const answerSummaries = gatewaySteps
    .filter((step) => step.kind === 'answer')
    .map((step) => step.summary.trim())
    .filter((summary) => summary.length > 0 && !isGeneratedGenericAnswerSummary(summary));
  const summary = answerSummaries.length > 0
    ? answerSummaries.join(' ')
    : contract.summary?.trim() || 'Answer with grounded findings from the collected evidence.';
  return enrichAnswerSummaryForConstraints(summary, contract.answerConstraints);
}

function applyContractAnswerSummary(
  steps: PlannedStep[],
  summary: string | undefined,
  answerConstraints?: AnswerConstraints,
): PlannedStep[] {
  const normalizedSummary = summary?.trim();
  if (!normalizedSummary) {
    return steps;
  }
  let updated = false;
  const nextSteps = steps.map((step) => {
    if (step.kind !== 'answer' || !isGeneratedGenericAnswerSummary(step.summary)) {
      return step;
    }
    updated = true;
    const enrichedSummary = enrichAnswerSummaryForConstraints(normalizedSummary, answerConstraints);
    return {
      ...step,
      summary: enrichedSummary,
    };
  });
  return updated ? nextSteps : steps;
}

function enrichAnswerSummaryForConstraints(
  summary: string,
  constraints: AnswerConstraints | undefined,
): string {
  if (!constraints) return summary;
  const parts: string[] = [summary.endsWith('.') ? summary : `${summary}.`];
  if (constraints.requiresImplementationFiles) {
    parts.push('Cite the specific implementation files, not just files that were read during search.');
  }
  if (constraints.requiresSymbolNames) {
    parts.push('Include the exact function, type, or symbol names requested.');
  }
  if (constraints.readonly) {
    parts.push('Do not modify any files.');
  }
  return parts.join(' ');
}

function isGeneratedGenericAnswerSummary(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'answer the request directly.'
    || normalized === 'complete the requested work.'
    || normalized === 'answer the request directly'
    || normalized === 'complete the requested work';
}

function renumberPlannedSteps(steps: PlannedStep[]): PlannedStep[] {
  const nextIds = new Map<string, string>();
  for (const [index, step] of steps.entries()) {
    nextIds.set(step.stepId, `step_${index + 1}`);
  }
  return steps.map((step, index) => ({
    ...step,
    stepId: `step_${index + 1}`,
    ...(step.dependsOn?.length
      ? { dependsOn: step.dependsOn.map((dependsOn) => nextIds.get(dependsOn) ?? dependsOn) }
      : {}),
  }));
}

export function matchPlannedStepForTool(input: ToolStepMatchInput): string | undefined {
  const toolKind = inferStepKindFromToolName(input.toolName);
  const normalizedHint = input.hintStepId?.trim();
  if (normalizedHint) {
    const hintedStep = input.plannedTask.steps.find((step) => step.stepId === normalizedHint);
    if (hintedStep && toolNameSatisfiesStep(hintedStep, input.toolName, toolKind)) {
      return normalizedHint;
    }
  }

  const argRefs = new Set(extractNormalizedRefs(input.args));
  const previouslyMatched = input.previouslyMatchedStepIds ?? new Set<string>();

  const scored = input.plannedTask.steps.map((step, index) => {
    let score = 0;
    if (!toolNameSatisfiesStep(step, input.toolName, toolKind)) {
      return { step, index, score: Number.NEGATIVE_INFINITY };
    }
    if (
      input.toolName === 'find_tools'
      && step.kind === 'tool_call'
      && !step.expectedToolCategories?.some((value) => value === 'find_tools' || value === 'search')
    ) {
      return { step, index, score: Number.NEGATIVE_INFINITY };
    }
    if (step.kind === toolKind) score += 8;
    if (step.expectedToolCategories?.some((value) => expectedToolCategoryMatchesTool(value, input.toolName, toolKind, step.kind))) {
      score += 6;
    }
    const summaryRefs = extractNormalizedRefs(step.summary);
    if (summaryRefs.some((ref) => argRefs.has(ref))) {
      score += 5;
    }
    if (summaryRefs.length > 0 && summaryRefs.some((ref) => [...argRefs].some((argRef) => argRef.includes(ref) || ref.includes(argRef)))) {
      score += 3;
    }
    if (!previouslyMatched.has(step.stepId)) {
      score += 1;
    }
    return { step, index, score };
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const best = scored[0];
  return best && best.score > 0 ? best.step.stepId : undefined;
}

export function buildStepReceipts(input: BuildStepReceiptsInput): StepReceipt[] {
  const interruptionId = input.interruptions?.[0]?.interruptionId;
  const receiptsByStepId = new Map<string, EvidenceReceipt[]>();
  const answerStepIds = input.finalAnswerReceiptId
    ? findAnswerStepIds(input.plannedTask)
    : [];

  for (const receipt of input.evidenceReceipts) {
    const stepIds = input.finalAnswerReceiptId && receipt.receiptId === input.finalAnswerReceiptId
      ? answerStepIds
      : [input.toolReceiptStepIds?.get(receipt.receiptId)].filter((stepId): stepId is string => !!stepId);
    for (const stepId of stepIds) {
      const existing = receiptsByStepId.get(stepId) ?? [];
      existing.push(receipt);
      receiptsByStepId.set(stepId, existing);
    }
  }

  return input.plannedTask.steps.map((step) => {
    const matchedReceipts = (receiptsByStepId.get(step.stepId) ?? [])
      .slice()
      .sort((left, right) => left.startedAt - right.startedAt);
    const qualifyingReceipts = matchedReceipts.filter((receipt) => receiptSatisfiesStep(step, receipt));
    const successful = qualifyingReceipts.filter((receipt) => receipt.status === 'succeeded');
    const blocked = qualifyingReceipts.find((receipt) => (
      receipt.status === 'pending_approval' || receipt.status === 'blocked'
    ));
    const failed = qualifyingReceipts.find((receipt) => receipt.status === 'failed');

    if (successful.length > 0) {
      return {
        stepId: step.stepId,
        status: 'satisfied' as const,
        evidenceReceiptIds: successful.map((receipt) => receipt.receiptId),
        summary: successful.at(-1)?.summary ?? step.summary,
        startedAt: successful[0]?.startedAt ?? 0,
        endedAt: successful.at(-1)?.endedAt ?? successful[0]?.startedAt ?? 0,
      };
    }

    if (blocked) {
      return {
        stepId: step.stepId,
        status: 'blocked' as const,
        evidenceReceiptIds: [blocked.receiptId],
        ...(interruptionId ? { interruptionId } : {}),
        summary: blocked.summary || step.summary,
        startedAt: blocked.startedAt,
        endedAt: blocked.endedAt,
      };
    }

    if (failed) {
      return {
        stepId: step.stepId,
        status: 'failed' as const,
        evidenceReceiptIds: [failed.receiptId],
        summary: failed.summary || step.summary,
        startedAt: failed.startedAt,
        endedAt: failed.endedAt,
      };
    }

    if (!step.required) {
      return {
        stepId: step.stepId,
        status: 'skipped' as const,
        evidenceReceiptIds: [],
        summary: step.summary,
        startedAt: 0,
        endedAt: 0,
      };
    }

    return {
      stepId: step.stepId,
      status: 'failed' as const,
      evidenceReceiptIds: [],
      summary: step.summary,
      startedAt: 0,
      endedAt: 0,
    };
  });
}

export function computeWorkerRunStatus(
  plannedTask: PlannedTask,
  stepReceipts: StepReceipt[],
  interruptions: Interruption[],
  stopReason: WorkerStopReason,
): WorkerRunStatus {
  if (interruptions.length > 0) {
    return 'suspended';
  }
  if (stopReason === 'max_rounds' || stopReason === 'max_tokens') {
    return 'max_turns';
  }

  const requiredSteps = plannedTask.steps.filter((step) => step.required);
  const receiptByStepId = new Map(stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  const effectivelySatisfiedStepIds = collectSatisfiedStepIdsRespectingDependencies(plannedTask, stepReceipts);
  const allRequiredSatisfied = requiredSteps.every((step) => effectivelySatisfiedStepIds.has(step.stepId));
  if (allRequiredSatisfied && stopReason === 'end_turn') {
    return 'completed';
  }

  if (stopReason === 'error') {
    return 'failed';
  }

  const hasActualFailure = requiredSteps.some((step) => {
    if (effectivelySatisfiedStepIds.has(step.stepId)) {
      return false;
    }
    const receipt = receiptByStepId.get(step.stepId);
    return !!receipt && (
      receipt.status === 'blocked'
      || (receipt.status === 'failed' && receipt.evidenceReceiptIds.length > 0)
    );
  });
  if (hasActualFailure) {
    return 'failed';
  }

  return 'incomplete';
}

export function readUnsatisfiedRequiredSteps(
  plannedTask: PlannedTask,
  stepReceipts: StepReceipt[],
): PlannedStep[] {
  const effectivelySatisfiedStepIds = collectSatisfiedStepIdsRespectingDependencies(plannedTask, stepReceipts);
  return plannedTask.steps.filter((step) => {
    if (!step.required) return false;
    return !effectivelySatisfiedStepIds.has(step.stepId);
  });
}

export function collectMissingEvidenceKinds(
  plannedTask: PlannedTask,
  stepReceipts: StepReceipt[],
): string[] {
  const receiptByStepId = new Map(stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  const effectivelySatisfiedStepIds = collectSatisfiedStepIdsRespectingDependencies(plannedTask, stepReceipts);
  return [...new Set(
    plannedTask.steps
      .filter((step) => step.required)
      .filter((step) => !effectivelySatisfiedStepIds.has(step.stepId))
      .filter((step) => {
        const receipt = receiptByStepId.get(step.stepId);
        return !receipt || receipt.evidenceReceiptIds.length === 0 || receipt.status === 'failed';
      })
      .map((step) => step.kind),
  )];
}

export function collectSatisfiedStepIdsRespectingDependencies(
  plannedTask: PlannedTask,
  stepReceipts: StepReceipt[],
): Set<string> {
  const receiptByStepId = new Map(stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  const satisfied = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const step of plannedTask.steps) {
      if (satisfied.has(step.stepId)) {
        continue;
      }
      const receipt = receiptByStepId.get(step.stepId);
      if (receipt?.status !== 'satisfied') {
        continue;
      }
      const dependsOn = step.dependsOn ?? [];
      if (!dependsOn.every((dependencyStepId) => satisfied.has(dependencyStepId))) {
        continue;
      }
      satisfied.add(step.stepId);
      progressed = true;
    }
  }
  return satisfied;
}

export function filterDependencySatisfiedStepReceipts(
  plannedTask: PlannedTask,
  stepReceipts: StepReceipt[],
): StepReceipt[] {
  const satisfiedStepIds = collectSatisfiedStepIdsRespectingDependencies(plannedTask, stepReceipts);
  return stepReceipts.filter((receipt) => satisfiedStepIds.has(receipt.stepId));
}

export function findAnswerStepId(plannedTask: PlannedTask): string | undefined {
  return findAnswerStepIds(plannedTask).at(-1);
}

export function findAnswerStepIds(plannedTask: PlannedTask): string[] {
  return plannedTask.steps
    .filter((step) => step.kind === 'answer')
    .map((step) => step.stepId);
}

function normalizeGatewayPlannedStep(
  step: GatewayPlannedStep,
  index: number,
): PlannedStep | null {
  const summary = typeof step.summary === 'string' ? step.summary.trim() : '';
  const kind = normalizePlannedStepKind(step.kind);
  if (!summary || !kind) return null;
  const expectedToolCategories = Array.isArray(step.expectedToolCategories)
    ? step.expectedToolCategories
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const dependsOn = Array.isArray(step.dependsOn)
    ? step.dependsOn
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  return {
    stepId: `step_${index + 1}`,
    kind,
    summary,
    ...(expectedToolCategories.length > 0 ? { expectedToolCategories } : {}),
    required: step.required !== false,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function normalizePlannedStepKind(value: unknown): PlannedStepKind | null {
  switch (value) {
    case 'tool_call':
    case 'write':
    case 'read':
    case 'search':
    case 'memory_save':
    case 'answer':
      return value;
    default:
      return null;
  }
}

function inferDefaultPlannedStepKind(
  contractKind: DelegatedTaskContractKind,
  operation: string | undefined,
): PlannedStepKind {
  if (contractKind === 'general_answer') return 'answer';
  if (contractKind === 'filesystem_mutation') return 'write';
  if (operation === 'search') return 'search';
  if (operation === 'read' || operation === 'inspect') return 'read';
  if (operation === 'save' || operation === 'update' || operation === 'create' || operation === 'delete') {
    return 'write';
  }
  if (operation === 'run') return 'tool_call';
  if (contractKind === 'repo_inspection') return 'read';
  return 'tool_call';
}

function applyDefaultExpectedToolCategories(
  step: PlannedStep,
  contract: {
    kind: DelegatedTaskContractKind;
    route?: string;
    operation?: string;
  },
): PlannedStep {
  if (step.expectedToolCategories?.length) {
    return step;
  }
  const expectedToolCategories = inferExpectedToolCategories(step, contract);
  return expectedToolCategories.length > 0
    ? { ...step, expectedToolCategories }
    : step;
}

function inferExpectedToolCategories(
  step: PlannedStep,
  contract: {
    kind: DelegatedTaskContractKind;
    route?: string;
    operation?: string;
  },
): string[] {
  switch (step.kind) {
    case 'search':
      return inferSearchToolCategories(step.summary, contract);
    case 'read':
      return inferReadToolCategories(step.summary, contract);
    case 'write':
      return inferWriteToolCategories(step.summary, contract);
    case 'memory_save':
      return ['memory_save'];
    case 'tool_call':
      return inferToolCallCategories(contract);
    case 'answer':
      return [];
  }
}

function inferSearchToolCategories(
  summary: string | undefined,
  contract: {
    route?: string;
  },
): string[] {
  const semanticCategories = inferSemanticEvidenceToolCategories(summary);
  if (semanticCategories.length > 0) {
    return semanticCategories;
  }
  if (contract.route === 'memory_task') {
    return ['memory_search', 'memory_recall'];
  }
  if (contract.route === 'automation_control') {
    return ['automation_list'];
  }
  if (contract.route === 'personal_assistant_task') {
    return ['second_brain'];
  }
  if (contract.route === 'browser_task' || contract.route === 'search_task') {
    return ['web_search', 'fs_search', 'code_symbol_search'];
  }
  return ['fs_search', 'code_symbol_search'];
}

function inferReadToolCategories(
  summary: string | undefined,
  contract: {
    route?: string;
  },
): string[] {
  const semanticCategories = inferSemanticEvidenceToolCategories(summary);
  if (semanticCategories.length > 0) {
    return semanticCategories;
  }
  if (contract.route === 'memory_task') {
    return ['memory_search', 'memory_recall'];
  }
  if (contract.route === 'automation_control') {
    return ['automation_list'];
  }
  if (contract.route === 'personal_assistant_task') {
    return ['second_brain'];
  }
  if (contract.route === 'browser_task' || contract.route === 'search_task') {
    return ['web_fetch', 'fs_read', 'fs_list'];
  }
  return ['fs_read', 'fs_list'];
}

function inferSemanticEvidenceToolCategories(summary: string | undefined): string[] {
  const normalized = summary?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return [];
  }
  const categories: string[] = [];
  if (containsAny(normalized, ['memory', 'remembered', 'knowledge base'])) {
    categories.push('memory');
  }
  if (containsAny(normalized, [
    'repo',
    'repository',
    'workspace',
    'codebase',
    'source code',
    'local code',
    'implementation',
    'file path',
    'symbol',
  ])) {
    categories.push('repo_inspect');
  }
  if (containsAny(normalized, [
    'web',
    'internet',
    'browser',
    'website',
    'page title',
    'url',
    'http://',
    'https://',
  ])) {
    categories.push('web');
  }
  if (containsAny(normalized, ['automation', 'automations', 'workflow', 'workflows'])) {
    categories.push('automation_list');
  }
  if (containsAny(normalized, [
    'second brain',
    'calendar',
    'appointment',
    'reminder',
    'note',
    'contact',
    'contacts',
    'library',
  ])) {
    categories.push('second_brain');
  }
  return [...new Set(categories)];
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function inferToolCallCategories(
  contract: {
    kind: DelegatedTaskContractKind;
    operation?: string;
  },
): string[] {
  if (contract.kind === 'tool_execution' || contract.operation === 'run') {
    return ['code_remote_exec', 'execute_code', 'shell', 'command'];
  }
  return [];
}

function inferWriteToolCategories(
  summary: string | undefined,
  contract: {
    route?: string;
  },
): string[] {
  if (contract.route === 'memory_task') {
    return ['memory_save'];
  }
  if (contract.route === 'automation_authoring' || contract.route === 'automation_control') {
    return ['automation'];
  }
  if (contract.route === 'personal_assistant_task') {
    return ['second_brain'];
  }
  if (contract.route === 'complex_planning_task' || contract.route === 'general_assistant') {
    return ['write'];
  }
  const normalized = summary?.trim().toLowerCase() ?? '';
  if (/\b(delete|remove|unlink)\b/.test(normalized)) {
    return ['fs_delete'];
  }
  if (/\b(move|rename)\b/.test(normalized)) {
    return ['fs_move'];
  }
  if (/\b(copy|duplicate)\b/.test(normalized)) {
    return ['fs_copy'];
  }
  const directoryOnly = /\b(directory|folder|mkdir)\b/.test(normalized)
    && !/\b(file|write|save|content|contents|containing|text|summary)\b/.test(normalized);
  if (directoryOnly) {
    return ['fs_mkdir'];
  }
  return ['fs_write'];
}

function inferStepKindFromToolName(toolName: string): PlannedStepKind {
  if (toolName === 'memory_save') return 'memory_save';
  if (toolName === 'find_tools' || toolName === 'fs_search' || toolName === 'web_search' || toolName === 'code_symbol_search') {
    return 'search';
  }
  if (
    toolName === 'fs_read'
    || toolName === 'fs_list'
    || toolName === 'web_fetch'
    || BROWSER_READ_TOOL_NAMES.has(toolName)
    || MEMORY_READ_TOOL_NAMES.has(toolName)
    || toolName === 'automation_list'
    || SECOND_BRAIN_READ_TOOL_NAMES.has(toolName)
  ) {
    return 'read';
  }
  if (
    toolName === 'fs_write'
    || toolName === 'fs_mkdir'
    || toolName === 'fs_delete'
    || toolName === 'fs_move'
    || toolName === 'fs_copy'
    || isSecondBrainWriteToolName(toolName)
    || AUTOMATION_WRITE_TOOL_NAMES.has(toolName)
  ) {
    return 'write';
  }
  return 'tool_call';
}

function isSecondBrainWriteToolName(toolName: string): boolean {
  if (!toolName.startsWith('second_brain_')) {
    return false;
  }
  return toolName.endsWith('_upsert')
    || toolName.endsWith('_update')
    || toolName.endsWith('_delete')
    || toolName === 'second_brain_routine_create'
    || toolName === 'second_brain_generate_brief';
}

function toolNameSatisfiesStep(
  step: PlannedStep,
  toolName: string,
  inferredToolKind: PlannedStepKind = inferStepKindFromToolName(toolName),
): boolean {
  if (!step.expectedToolCategories?.length) {
    return step.kind === 'tool_call'
      ? inferredToolKind === 'tool_call'
      : step.kind === inferredToolKind;
  }
  return step.expectedToolCategories.some((value) => (
    expectedToolCategoryMatchesTool(value, toolName, inferredToolKind, step.kind)
  ));
}

function expectedToolCategoryMatchesTool(
  value: string,
  toolName: string,
  inferredToolKind: PlannedStepKind,
  stepKind: PlannedStepKind,
): boolean {
  const normalized = value.trim();
  return normalized === toolName
    || normalized === inferredToolKind
    || (normalized === 'runtime_evidence' && toolName !== 'find_tools' && (
      inferredToolKind === 'read'
        || inferredToolKind === 'search'
        || inferredToolKind === 'tool_call'
    ))
    || (normalized === 'repo' && REPO_INSPECTION_TOOL_NAMES.has(toolName))
    || (normalized === 'repository' && REPO_INSPECTION_TOOL_NAMES.has(toolName))
    || (normalized === 'repo_inspect' && REPO_INSPECTION_TOOL_NAMES.has(toolName))
    || (normalized === 'repo_inspection' && REPO_INSPECTION_TOOL_NAMES.has(toolName))
    || (normalized === 'second_brain' && toolName.startsWith('second_brain_'))
    || (normalized === 'personal_assistant_task' && toolName.startsWith('second_brain_'))
    || (normalized === 'browser' && (toolName.startsWith('browser_') || toolName.startsWith('web_')))
    || (normalized === 'web' && (toolName.startsWith('web_') || toolName.startsWith('browser_')))
    || (normalized === 'browser_task' && (toolName.startsWith('browser_') || toolName.startsWith('web_')))
    || (normalized === 'search_task' && (toolName.startsWith('web_') || toolName.startsWith('browser_')))
    || (normalized === 'memory' && (
      stepKind === 'memory_save'
        ? toolName === 'memory_save'
        : MEMORY_READ_TOOL_NAMES.has(toolName)
    ))
    || (normalized === 'memory_task' && (
      stepKind === 'memory_save'
        ? toolName === 'memory_save'
        : MEMORY_READ_TOOL_NAMES.has(toolName)
    ))
    || (normalized === 'automation' && toolName.startsWith('automation_'));
}

function receiptSatisfiesStep(step: PlannedStep, receipt: EvidenceReceipt): boolean {
  if (!step.expectedToolCategories?.length) {
    return true;
  }
  if (receipt.sourceType === 'model_answer') {
    return step.kind === 'answer'
      && step.expectedToolCategories.some((value) => value === 'answer' || value === 'model_answer');
  }
  if (receipt.sourceType !== 'tool_call' || !receipt.toolName) {
    return false;
  }
  return toolNameSatisfiesStep(step, receipt.toolName);
}

function extractNormalizedRefs(value: unknown): string[] {
  if (typeof value === 'string') {
    const matches = value.match(PATHLIKE_TOKEN_PATTERN) ?? [];
    return matches.map(normalizeRef).filter((entry): entry is string => !!entry);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractNormalizedRefs(entry));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.values(value).flatMap((entry) => extractNormalizedRefs(entry));
}

function normalizeRef(value: string | undefined): string | null {
  const normalized = value?.trim().replaceAll('\\', '/').toLowerCase();
  return normalized ? normalized : null;
}

function buildPlanId(route: string | undefined, operation: string | undefined, count: number): string {
  const normalizedRoute = route?.trim() || 'unknown';
  const normalizedOperation = operation?.trim() || 'unknown';
  return `plan:${normalizedRoute}:${normalizedOperation}:${count}`;
}
