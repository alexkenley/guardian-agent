import type { IntentGatewayDecision } from './types.js';
import { getBuiltinToolCategory } from './capability-inventory.js';

type PlannedStep = NonNullable<IntentGatewayDecision['plannedSteps']>[number];

export type IntentCapabilityCandidate =
  | 'personal_assistant'
  | 'provider_read'
  | 'filesystem'
  | 'memory_write'
  | 'memory_read'
  | 'coding_backend'
  | 'scheduled_email_automation'
  | 'automation'
  | 'automation_control'
  | 'automation_output'
  | 'workspace_write'
  | 'workspace_read'
  | 'browser'
  | 'web_search'
  | 'security_guardrail'
  | 'coding_session_control';

export function resolveIntentCapabilityCandidates(
  decision: IntentGatewayDecision,
): IntentCapabilityCandidate[] {
  return dedupeCandidates(preferredCandidatesForDecision(decision));
}

function preferredCandidatesForDecision(
  decision: IntentGatewayDecision,
): IntentCapabilityCandidate[] {
  if (shouldDeferDirectCapabilityCandidates(decision)) {
    return [];
  }

  switch (decision.route) {
    case 'automation_authoring':
      return ['create', 'update', 'schedule'].includes(decision.operation)
        ? ['scheduled_email_automation', 'automation']
        : [];
    case 'automation_control':
      return ['automation_control'];
    case 'automation_output_task':
      return ['automation_output'];
    case 'ui_control':
      if (decision.entities.uiSurface === 'automations'
        && ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation)) {
        return ['automation_control'];
      }
      return [];
    case 'browser_task':
      return ['browser'];
    case 'personal_assistant_task':
      return ['personal_assistant'];
    case 'general_assistant':
      if (hasOnlyManagedSandboxStatusCategories(decision)) {
        return ['coding_session_control'];
      }
      return decision.executionClass === 'provider_crud'
        ? ['provider_read']
        : [];
    case 'workspace_task':
      return decision.operation === 'send' || decision.operation === 'draft'
        ? ['workspace_write', 'workspace_read']
        : ['workspace_read', 'workspace_write'];
    case 'email_task':
      return decision.operation === 'send' || decision.operation === 'draft'
        ? ['workspace_write', 'workspace_read']
        : ['workspace_read', 'workspace_write'];
    case 'search_task':
      return shouldUseDirectWebSearchCandidate(decision) ? ['web_search'] : [];
    case 'security_task':
      return ['security_guardrail'];
    case 'memory_task':
      return decision.operation === 'save'
        ? ['memory_write']
        : (decision.operation === 'read' || decision.operation === 'search')
          ? ['memory_read']
          : ['memory_read', 'memory_write'];
    case 'filesystem_task':
      return ['filesystem'];
    case 'coding_task':
      if (decision.entities.codingBackend && decision.entities.codingBackendRequested === true) {
        return ['coding_backend'];
      }
      if (decision.operation === 'search') {
        if (
          decision.executionClass === 'tool_orchestration'
          || decision.requiresToolSynthesis === true
          || decision.preferredAnswerPath === 'tool_loop'
        ) {
          return [];
        }
        return ['filesystem'];
      }
      return decision.operation === 'inspect'
        && decision.turnRelation === 'follow_up'
        && decision.entities.codingRunStatusCheck === true
        ? ['coding_backend']
        : [];
    case 'coding_session_control':
      return ['coding_session_control'];
    case 'unknown':
    default:
      return [];
  }
}

function shouldUseDirectWebSearchCandidate(decision: IntentGatewayDecision): boolean {
  if (decision.confidence === 'low') return false;
  if (decision.requiresToolSynthesis === true || decision.preferredAnswerPath === 'tool_loop') return false;
  const nonAnswerSteps = requiredPlannedSteps(decision).filter((step) => step.kind !== 'answer');
  if (nonAnswerSteps.length <= 0) return true;
  return nonAnswerSteps.every((step) => {
    const categories = expectedCategoriesForStep(step).map((category) => category.trim()).filter(Boolean);
    return categories.length > 0 && categories.every((category) => isWebSearchDirectCategory(category));
  });
}

function requiredPlannedSteps(decision: IntentGatewayDecision) {
  return Array.isArray(decision.plannedSteps)
    ? decision.plannedSteps.filter((step) => step.required !== false)
    : [];
}

function plannedStepExpectedCategories(decision: IntentGatewayDecision): string[] {
  return requiredPlannedSteps(decision)
    .flatMap((step) => expectedCategoriesForStep(step))
    .map((category) => category.trim())
    .filter(Boolean);
}

function expectedCategoriesForStep(step: PlannedStep): string[] {
  return Array.isArray(step.expectedToolCategories)
    ? step.expectedToolCategories
    : [];
}

function shouldDeferDirectCapabilityCandidates(decision: IntentGatewayDecision): boolean {
  const requiredSteps = requiredPlannedSteps(decision);
  if (requiredSteps.length <= 0) {
    return false;
  }

  if (decision.route === 'personal_assistant_task') {
    return requiredSteps.length > 1
      || plannedStepExpectedCategories(decision).some((category) => !isSecondBrainDirectCategory(category));
  }

  if (decision.route === 'automation_authoring') {
    return plannedStepExpectedCategories(decision).some((category) => !isAutomationAuthoringDirectCategory(category));
  }

  if (decision.route === 'automation_control') {
    const nonAnswerSteps = requiredSteps.filter((step) => step.kind !== 'answer');
    if (nonAnswerSteps.length <= 0) {
      return false;
    }
    if (isReadOnlyAutomationControlOperation(decision.operation)
      && isAutomationReadView(decision.entities.automationReadView)
      && nonAnswerSteps.every((step) => {
        const categories = expectedCategoriesForStep(step).map((category) => category.trim()).filter(Boolean);
        return categories.length > 0
          && categories.every((category) => isAutomationDirectCategory(category));
      })) {
      return false;
    }
    if (isReadOnlyAutomationControlOperation(decision.operation)
      && nonAnswerSteps.length < requiredSteps.length) {
      return true;
    }
    return nonAnswerSteps.some((step) => {
      const categories = expectedCategoriesForStep(step).map((category) => category.trim()).filter(Boolean);
      return categories.length <= 0
        || categories.some((category) => !isAutomationDirectCategory(category));
    });
  }

  if (decision.route === 'browser_task') {
    const nonAnswerSteps = requiredSteps.filter((step) => step.kind !== 'answer');
    const answerSteps = requiredSteps.filter((step) => step.kind === 'answer');
    return nonAnswerSteps.length > 0 && answerSteps.length > 0;
  }

  if (decision.route === 'search_task') {
    const nonAnswerSteps = requiredSteps.filter((step) => step.kind !== 'answer');
    const answerSteps = requiredSteps.filter((step) => step.kind === 'answer');
    if (answerSteps.length <= 0) {
      return false;
    }
    if (nonAnswerSteps.length > 1) {
      return true;
    }
    return nonAnswerSteps.some((step) => {
      const categories = expectedCategoriesForStep(step).map((category) => category.trim()).filter(Boolean);
      return categories.length > 0
        && categories.some((category) => !isWebSearchDirectCategory(category));
    });
  }

  if (decision.route === 'coding_task' && decision.operation === 'search') {
    return shouldDeferCodingSearchCandidate(requiredSteps);
  }

  if (decision.route === 'security_task') {
    return requiredSteps.length > 0
      || decision.requiresToolSynthesis === true
      || decision.preferredAnswerPath === 'tool_loop'
      || decision.simpleVsComplex === 'complex';
  }

  return false;
}

function shouldDeferCodingSearchCandidate(requiredSteps: PlannedStep[]): boolean {
  const nonAnswerSteps = requiredSteps.filter((step) => step.kind !== 'answer');
  return nonAnswerSteps.some((step) => {
    if (step.kind !== 'read' && step.kind !== 'search') {
      return true;
    }
    const categories = expectedCategoriesForStep(step).map((category) => category.trim()).filter(Boolean);
    return categories.some((category) => !isFilesystemDirectSearchCategory(category));
  });
}

function isSecondBrainDirectCategory(category: string): boolean {
  const normalized = category.trim();
  if (!normalized) return true;
  if (normalized === 'personal_assistant' || normalized === 'second_brain') return true;
  if (normalized.startsWith('second_brain_')) return true;
  return getBuiltinToolCategory(normalized) === 'memory' && normalized.startsWith('second_brain_');
}

function isAutomationAuthoringDirectCategory(category: string): boolean {
  const normalized = category.trim();
  if (!normalized) return true;
  if (normalized === 'read' || normalized === 'search' || normalized === 'write') return true;
  if (isWebSearchDirectCategory(normalized)) return true;
  return isAutomationDirectCategory(normalized);
}

function isAutomationDirectCategory(category: string): boolean {
  const normalized = category.trim();
  if (!normalized) return true;
  if (normalized === 'automation' || normalized === 'scheduled_email_automation') return true;
  if (normalized.startsWith('automation_')) return true;
  return getBuiltinToolCategory(normalized) === 'automation';
}

function isWebSearchDirectCategory(category: string): boolean {
  const normalized = category.trim();
  if (!normalized) return true;
  return normalized === 'search'
    || normalized === 'read'
    || normalized === 'web'
    || normalized === 'browser'
    || normalized === 'web_search'
    || normalized === 'web_fetch'
    || normalized.startsWith('browser_');
}

function isFilesystemDirectSearchCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'search'
    || normalized === 'read'
    || normalized === 'filesystem'
    || normalized === 'fs_search'
    || normalized === 'fs_list';
}

function isManagedSandboxStatusCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'daytona_status'
    || normalized === 'managed_sandbox_status'
    || normalized === 'remote_sandbox_status';
}

function hasOnlyManagedSandboxStatusCategories(decision: IntentGatewayDecision): boolean {
  const nonAnswerSteps = requiredPlannedSteps(decision).filter((step) => step.kind !== 'answer');
  if (nonAnswerSteps.length <= 0) return false;
  const categories = nonAnswerSteps
    .flatMap((step) => expectedCategoriesForStep(step))
    .map((category) => category.trim())
    .filter(Boolean);
  return categories.length > 0 && categories.every((category) => isManagedSandboxStatusCategory(category));
}

function isReadOnlyAutomationControlOperation(operation: IntentGatewayDecision['operation']): boolean {
  return operation === 'read'
    || operation === 'inspect'
    || operation === 'search'
    || operation === 'navigate';
}

function isAutomationReadView(value: unknown): value is 'catalog' | 'count' {
  return value === 'catalog' || value === 'count';
}

function dedupeCandidates(
  candidates: IntentCapabilityCandidate[],
): IntentCapabilityCandidate[] {
  const seen = new Set<IntentCapabilityCandidate>();
  const ordered: IntentCapabilityCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}
