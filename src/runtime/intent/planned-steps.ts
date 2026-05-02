import type { IntentGatewayDecision, IntentGatewayPlannedStep } from './types.js';

const WRITE_TOOL_CATEGORIES = new Set([
  'write',
  'fs_write',
  'fs_mkdir',
  'fs_delete',
  'fs_move',
  'fs_copy',
]);

const READ_OR_SEARCH_TOOL_CATEGORIES = new Set([
  'read',
  'search',
  'fs_read',
  'fs_list',
  'fs_search',
  'code_symbol_search',
  'web_search',
  'web_fetch',
  'doc_search',
  'doc_search_list',
  'doc_search_status',
]);

const GENERIC_TOOL_PLAN_CATEGORIES = new Set([
  'answer',
  'read',
  'search',
  'tool_call',
  'write',
]);

function plannedSteps(decision: IntentGatewayDecision | null | undefined): IntentGatewayPlannedStep[] {
  return Array.isArray(decision?.plannedSteps) ? decision.plannedSteps : [];
}

function isRequiredStep(step: IntentGatewayPlannedStep): boolean {
  return step.required !== false;
}

function hasAnyExpectedCategory(
  step: IntentGatewayPlannedStep,
  categories: ReadonlySet<string>,
): boolean {
  return step.expectedToolCategories?.some((category) => categories.has(category)) === true;
}

function requiredEvidenceSteps(
  decision: IntentGatewayDecision | null | undefined,
): IntentGatewayPlannedStep[] {
  return plannedSteps(decision)
    .filter((step) => isRequiredStep(step) && step.kind !== 'answer');
}

export function hasConcreteToolEvidenceCategory(
  categories: readonly string[] | undefined,
): boolean {
  return categories?.some((category) => {
    const normalized = category.trim();
    return normalized.length > 0 && !GENERIC_TOOL_PLAN_CATEGORIES.has(normalized);
  }) === true;
}

export function hasRequiredWritePlannedStep(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  return plannedSteps(decision).some((step) => isRequiredStep(step)
    && (step.kind === 'write' || hasAnyExpectedCategory(step, WRITE_TOOL_CATEGORIES)));
}

export function hasRequiredReadOrSearchPlannedStep(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  return plannedSteps(decision).some((step) => isRequiredStep(step)
    && (
      step.kind === 'read'
      || step.kind === 'search'
      || step.kind === 'answer'
      || hasAnyExpectedCategory(step, READ_OR_SEARCH_TOOL_CATEGORIES)
    ));
}

export function hasRequiredReadWritePlan(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  return hasRequiredWritePlannedStep(decision)
    && hasRequiredReadOrSearchPlannedStep(decision);
}

export function hasRequiredToolOrMutationPlannedStep(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  return plannedSteps(decision).some((step) => isRequiredStep(step)
    && (
      step.kind === 'tool_call'
      || step.kind === 'write'
      || step.kind === 'memory_save'
      || hasAnyExpectedCategory(step, WRITE_TOOL_CATEGORIES)
    ));
}

export function requiresSecurityEvidence(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  if (!decision) return false;
  if (decision.requiresRepoGrounding || decision.requiresToolSynthesis || decision.requireExactFileReferences) {
    return true;
  }
  return requiredEvidenceSteps(decision).length > 0;
}

export function hasRequiredToolBackedAnswerPlan(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  const requiredSteps = plannedSteps(decision).filter(isRequiredStep);
  const hasAnswerStep = requiredSteps.some((step) => step.kind === 'answer');
  if (!hasAnswerStep) {
    return false;
  }
  return requiredSteps.some((step) => step.kind !== 'answer'
    && (
      step.kind === 'tool_call'
      || step.kind === 'write'
      || step.kind === 'read'
      || step.kind === 'search'
      || step.kind === 'memory_save'
      || (step.expectedToolCategories?.length ?? 0) > 0
    ));
}

export function hasGenericRequiredToolBackedAnswerPlan(
  decision: IntentGatewayDecision | null | undefined,
): boolean {
  if (!hasRequiredToolBackedAnswerPlan(decision)) {
    return false;
  }
  const evidenceSteps = requiredEvidenceSteps(decision);
  if (evidenceSteps.length === 0) {
    return true;
  }
  return evidenceSteps.some((step) => !hasConcreteToolEvidenceCategory(step.expectedToolCategories));
}

export function countConcreteRequiredEvidenceSteps(
  decision: IntentGatewayDecision | null | undefined,
): number {
  return requiredEvidenceSteps(decision)
    .filter((step) => hasConcreteToolEvidenceCategory(step.expectedToolCategories))
    .length;
}

export function shouldAdoptMoreConcreteToolBackedAnswerPlan(input: {
  current: IntentGatewayDecision | null | undefined;
  candidate: IntentGatewayDecision | null | undefined;
}): boolean {
  if (input.candidate?.resolution !== 'ready') {
    return false;
  }
  if (!hasRequiredToolBackedAnswerPlan(input.candidate)) {
    return false;
  }
  return countConcreteRequiredEvidenceSteps(input.candidate)
    > countConcreteRequiredEvidenceSteps(input.current);
}
