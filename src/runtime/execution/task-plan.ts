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
  const gatewaySteps = Array.isArray(decision?.plannedSteps)
    ? decision.plannedSteps
        .map((step, index) => normalizeGatewayPlannedStep(step, index))
        .filter((step): step is PlannedStep => !!step)
    : [];

  if (gatewaySteps.length > 0) {
    const steps = ensureExactFileReferenceReadStep(
      applyContractAnswerSummary(gatewaySteps, contract.summary, contract.answerConstraints),
      contract,
    );
    return {
      planId: buildPlanId(decision?.route ?? contract.route, decision?.operation ?? contract.operation, steps.length),
      steps,
      allowAdditionalSteps: false,
    };
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

  const steps = ensureExactFileReferenceReadStep([{
    stepId: 'step_1',
    kind: inferDefaultPlannedStepKind(contract.kind, contract.operation),
    summary: contract.summary?.trim() || 'Complete the requested work.',
    required: true,
  }], contract);
  return {
    planId: buildPlanId(contract.route, contract.operation, steps.length),
    steps,
    allowAdditionalSteps: true,
  };
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
    if (step.expectedToolCategories?.some((value) => value === input.toolName || value === toolKind)) {
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

  for (const receipt of input.evidenceReceipts) {
    const stepId = input.toolReceiptStepIds?.get(receipt.receiptId)
      ?? (input.finalAnswerReceiptId && receipt.receiptId === input.finalAnswerReceiptId
        ? findAnswerStepId(input.plannedTask)
        : undefined);
    if (!stepId) continue;
    const existing = receiptsByStepId.get(stepId) ?? [];
    existing.push(receipt);
    receiptsByStepId.set(stepId, existing);
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
  return plannedTask.steps.find((step) => step.kind === 'answer')?.stepId;
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
  if (operation === 'search') return 'search';
  if (operation === 'read' || operation === 'inspect') return 'read';
  if (operation === 'save' || operation === 'update' || operation === 'create' || operation === 'delete') {
    return 'write';
  }
  if (operation === 'run') return 'tool_call';
  if (contractKind === 'filesystem_mutation') return 'write';
  if (contractKind === 'repo_inspection') return 'read';
  return 'tool_call';
}

function inferStepKindFromToolName(toolName: string): PlannedStepKind {
  if (toolName === 'memory_save') return 'memory_save';
  if (toolName === 'find_tools' || toolName === 'fs_search' || toolName === 'web_search' || toolName === 'code_symbol_search') {
    return 'search';
  }
  if (toolName === 'fs_read' || toolName === 'fs_list' || toolName === 'web_fetch' || toolName === 'memory_recall' || toolName === 'memory_search') {
    return 'read';
  }
  if (toolName === 'fs_write' || toolName === 'fs_mkdir' || toolName === 'fs_delete' || toolName === 'fs_move' || toolName === 'fs_copy') {
    return 'write';
  }
  return 'tool_call';
}

function toolNameSatisfiesStep(
  step: PlannedStep,
  toolName: string,
  inferredToolKind: PlannedStepKind = inferStepKindFromToolName(toolName),
): boolean {
  if (!step.expectedToolCategories?.length) {
    return true;
  }
  return step.expectedToolCategories.some((value) => value === toolName || value === inferredToolKind);
}

function receiptSatisfiesStep(step: PlannedStep, receipt: EvidenceReceipt): boolean {
  if (!step.expectedToolCategories?.length) {
    return true;
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
