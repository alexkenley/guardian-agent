import {
  extractExplicitRemoteExecCommand,
  inferExplicitFilesystemTaskOperation,
} from './entity-resolvers/coding.js';
import {
  inferAutomationControlOperation,
  inferAutomationOutputOperation,
  isExplicitAutomationAuthoringRequest,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './entity-resolvers/automation.js';
import {
  continuitySuggestsRoutine,
  inferSecondBrainOperation,
  isExplicitSecondBrainEntityRequest,
  isExplicitSecondBrainRoutineRequest,
  pendingActionSuggestsPersonalAssistantTask,
  pendingActionSuggestsRoutine,
} from './entity-resolvers/personal-assistant.js';
import {
  inferProviderConfigOperation,
  isExplicitProviderConfigRequest,
} from './entity-resolvers/provider-config.js';
import { normalizeOperation, normalizeRoute } from './normalization.js';
import { isExplicitComplexPlanningRequest, isExplicitCodingExecutionRequest } from './request-patterns.js';
import { collapseIntentGatewayWhitespace, normalizeIntentGatewayRepairText } from './text.js';
import type { IntentGatewayDecision, IntentGatewayRepairContext } from './types.js';

export function repairIntentGatewayRoute(
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
): IntentGatewayDecision['route'] {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (isExplicitComplexPlanningRequest(rawSourceContent)) {
    return 'complex_planning_task';
  }
  if (isExplicitAutomationAuthoringRequest(rawSourceContent)) {
    return 'automation_authoring';
  }
  if (isExplicitAutomationControlRequest(rawSourceContent)) {
    return 'automation_control';
  }
  if (isExplicitAutomationOutputRequest(rawSourceContent)) {
    return 'automation_output_task';
  }
  if (isExplicitProviderConfigRequest(rawSourceContent)) {
    return 'general_assistant';
  }
  if (isExplicitCodingExecutionRequest(rawSourceContent)) {
    return 'coding_task';
  }
  if (route === 'personal_assistant_task') {
    return route;
  }
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  if (
    route === 'coding_session_control'
    && extractExplicitRemoteExecCommand(rawSourceContent, normalizedSourceContent, 'run')
  ) {
    return 'coding_task';
  }
  const sourceContent = normalizeIntentGatewayRepairText(repairContext?.sourceContent);
  if (mentionsAutomationControlTerms(sourceContent)) {
    return route;
  }
  if (isExplicitSecondBrainRoutineRequest(sourceContent, operation)) {
    return 'personal_assistant_task';
  }
  if (isExplicitSecondBrainEntityRequest(sourceContent, operation)) {
    return 'personal_assistant_task';
  }
  if ((turnRelation === 'follow_up' || turnRelation === 'clarification_answer')
    && (
      pendingActionSuggestsPersonalAssistantTask(repairContext)
      || pendingActionSuggestsRoutine(repairContext)
      || continuitySuggestsRoutine(repairContext)
    )) {
    return 'personal_assistant_task';
  }
  return route;
}

export function repairIntentGatewayOperation(
  operation: IntentGatewayDecision['operation'],
  route: IntentGatewayDecision['route'],
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
): IntentGatewayDecision['operation'] {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  if (route === 'complex_planning_task' && isExplicitComplexPlanningRequest(rawSourceContent)) {
    return 'run';
  }
  if (route === 'general_assistant' && isExplicitProviderConfigRequest(rawSourceContent)) {
    return inferProviderConfigOperation(rawSourceContent, operation);
  }
  if (route === 'automation_authoring' && isExplicitAutomationAuthoringRequest(rawSourceContent)) {
    return 'create';
  }
  if (route === 'automation_control' && isExplicitAutomationControlRequest(rawSourceContent)) {
    return inferAutomationControlOperation(rawSourceContent, operation);
  }
  if (route === 'automation_output_task' && isExplicitAutomationOutputRequest(rawSourceContent)) {
    return inferAutomationOutputOperation(rawSourceContent, operation);
  }
  if (route === 'filesystem_task') {
    const inferredFilesystemOperation = inferExplicitFilesystemTaskOperation(rawSourceContent, operation);
    if (inferredFilesystemOperation) {
      return inferredFilesystemOperation;
    }
  }
  if (
    route === 'coding_task'
    && extractExplicitRemoteExecCommand(rawSourceContent, normalizedSourceContent, 'run')
  ) {
    return 'run';
  }
  if (turnRelation !== 'clarification_answer' && turnRelation !== 'correction') {
    return inferSecondBrainOperation(repairContext?.sourceContent, route, operation) ?? operation;
  }
  const pendingAction = repairContext?.pendingAction;
  if (!pendingAction) {
    return inferSecondBrainOperation(repairContext?.sourceContent, route, operation) ?? operation;
  }
  const pendingRoute = normalizeRoute(pendingAction.route);
  const pendingOperation = normalizeOperation(pendingAction.operation);
  if (pendingRoute !== route || pendingOperation === 'unknown') {
    return inferSecondBrainOperation(repairContext?.sourceContent, route, operation) ?? operation;
  }
  return pendingOperation;
}

function mentionsAutomationControlTerms(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  return /\bautomation\b/.test(normalized)
    || /\bworkflow\b/.test(normalized)
    || /\bautomations\b/.test(normalized);
}
