import {
  inferCodeSessionControlOperation,
  extractExplicitRemoteExecCommand,
  inferExplicitFilesystemTaskOperation,
  isExplicitRemoteSandboxTaskRequest,
} from './entity-resolvers/coding.js';
import {
  inferAutomationControlOperation,
  inferAutomationOutputOperation,
  isExplicitAutomationAuthoringRequest,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './entity-resolvers/automation.js';
import {
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
import { resolvePagedListContinuationRoute } from '../list-continuation.js';
import {
  isExplicitCodingExecutionRequest,
  isExplicitCodingSessionControlRequest,
  isExplicitComplexPlanningRequest,
  isExplicitRepoInspectionRequest,
  isExplicitRepoPlanningRequest,
  isExplicitWorkspaceScopedRepoWorkRequest,
  isRawCredentialDisclosureRequest,
} from './request-patterns.js';
import { collapseIntentGatewayWhitespace, normalizeIntentGatewayRepairText } from './text.js';
import type { IntentGatewayDecision, IntentGatewayRepairContext } from './types.js';

export function repairStructuredIntentGatewayRoute(
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
  parsed?: Record<string, unknown>,
): IntentGatewayDecision['route'] {
  if (turnRelation === 'clarification_answer' || turnRelation === 'correction') {
    return route;
  }
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  const explicitComplexPlanning = isExplicitComplexPlanningRequest(rawSourceContent);
  const explicitAutomationAuthoring = isExplicitAutomationAuthoringRequest(rawSourceContent);
  const explicitAutomationControl = isExplicitAutomationControlRequest(rawSourceContent);
  const explicitAutomationOutput = isExplicitAutomationOutputRequest(rawSourceContent);
  const explicitProviderConfig = isExplicitProviderConfigRequest(rawSourceContent);
  const rawCredentialDisclosure = isRawCredentialDisclosureRequest(rawSourceContent);
  const explicitCodingExecution = isExplicitCodingExecutionRequest(rawSourceContent);
  const explicitWorkspaceScopedRepoWork = isExplicitWorkspaceScopedRepoWorkRequest(rawSourceContent);
  const explicitRepoInspection = isExplicitRepoInspectionRequest(rawSourceContent);
  const explicitRepoPlanning = isExplicitRepoPlanningRequest(rawSourceContent);
  const explicitRemoteSandbox = isExplicitRemoteSandboxTaskRequest(rawSourceContent, normalizedSourceContent);
  const explicitCodingTaskRequest = explicitCodingExecution
    || explicitWorkspaceScopedRepoWork
    || explicitRepoInspection
    || explicitRepoPlanning
    || explicitRemoteSandbox;
  const pagedListContinuationRoute = resolvePagedListContinuationRoute({
    continuationStateKind: repairContext?.continuity?.continuationStateKind,
    content: rawSourceContent,
    turnRelation,
  });

  if (pagedListContinuationRoute) {
    return pagedListContinuationRoute;
  }
  if (route === 'ui_control' && explicitAutomationControl) {
    return 'automation_control';
  }
  if (rawCredentialDisclosure) {
    return 'security_task';
  }
  if (
    (route === 'coding_session_control'
      || route === 'filesystem_task'
      || route === 'personal_assistant_task')
    && explicitCodingTaskRequest
  ) {
    return 'coding_task';
  }
  if (
    (route === 'filesystem_task' || route === 'unknown')
    && explicitComplexPlanning
  ) {
    return 'complex_planning_task';
  }
  if (route === 'unknown' && explicitAutomationAuthoring) {
    return 'automation_authoring';
  }
  if (route === 'unknown' && explicitAutomationControl) {
    return 'automation_control';
  }
  if (route === 'unknown' && explicitProviderConfig) {
    return 'general_assistant';
  }
  if (route === 'unknown' && explicitCodingTaskRequest) {
    return 'coding_task';
  }
  if (route === 'unknown' && explicitAutomationOutput) {
    return 'automation_output_task';
  }
  if (route === 'unknown' && isExplicitCodingSessionControlRequest(rawSourceContent)) {
    return 'coding_session_control';
  }
  const sourceContent = normalizeIntentGatewayRepairText(repairContext?.sourceContent);
  if (route === 'filesystem_task' && typeof parsed?.path === 'string' && parsed.path.trim().length > 0) {
    return route;
  }
  if (
    (route === 'personal_assistant_task' || route === 'general_assistant' || route === 'unknown')
    && typeof parsed?.path === 'string'
    && parsed.path.trim().length > 0
  ) {
    return 'filesystem_task';
  }
  if (mentionsAutomationControlTerms(sourceContent)) {
    return route;
  }
  if (isExplicitSecondBrainRoutineRequest(sourceContent, operation)) {
    return 'personal_assistant_task';
  }
  if (isExplicitSecondBrainEntityRequest(sourceContent, operation)) {
    return 'personal_assistant_task';
  }
  if (turnRelation === 'follow_up'
    && (
      pendingActionSuggestsPersonalAssistantTask(repairContext)
      || pendingActionSuggestsRoutine(repairContext)
    )) {
    return 'personal_assistant_task';
  }
  return route;
}

export function repairStructuredIntentGatewayOperation(
  operation: IntentGatewayDecision['operation'],
  route: IntentGatewayDecision['route'],
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
): IntentGatewayDecision['operation'] {
  if (turnRelation === 'clarification_answer' || turnRelation === 'correction') {
    return operation;
  }
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  if (
    route === 'coding_task'
    && (
      extractExplicitRemoteExecCommand(rawSourceContent, normalizedSourceContent, 'run')
      || isExplicitRemoteSandboxTaskRequest(rawSourceContent, normalizedSourceContent)
    )
  ) {
    return 'run';
  }
  if (route === 'complex_planning_task' && isExplicitComplexPlanningRequest(rawSourceContent)) {
    return 'run';
  }
  if (
    route === resolvePagedListContinuationRoute({
      continuationStateKind: repairContext?.continuity?.continuationStateKind,
      content: rawSourceContent,
      turnRelation,
    })
  ) {
    return 'read';
  }
  if (route === 'security_task' && isRawCredentialDisclosureRequest(rawSourceContent)) {
    return 'read';
  }
  if (route === 'automation_control' && operation === 'navigate') {
    return 'read';
  }
  if (route === 'coding_session_control' && isExplicitCodingSessionControlRequest(rawSourceContent)) {
    return inferCodeSessionControlOperation(normalizedSourceContent) ?? operation;
  }
  if (route === 'coding_task' && isExplicitRepoInspectionRequest(rawSourceContent)) {
    return /\bsearch\s+(?:this|the)?\s*(?:repo|repository|codebase|workspace)\b/.test(normalizedSourceContent)
      || /\bfind\b.*\b(?:in|across)\s+(?:this|the)?\s*(?:repo|repository|codebase|workspace)\b/.test(normalizedSourceContent)
      || /\b(?:grep|rg)\b/.test(normalizedSourceContent)
      ? 'search'
      : 'inspect';
  }
  if (route === 'coding_task' && isExplicitRepoPlanningRequest(rawSourceContent)) {
    return 'inspect';
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
  return inferSecondBrainOperation(repairContext?.sourceContent, route, operation) ?? operation;
}

function mentionsAutomationControlTerms(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  return /\bautomation\b/.test(normalized)
    || /\bworkflow\b/.test(normalized)
    || /\bautomations\b/.test(normalized);
}
