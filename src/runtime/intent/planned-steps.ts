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
