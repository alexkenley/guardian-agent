import type { ChatResponse } from '../../llm/types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';
import {
  cleanInferredSessionTarget,
  extractCodingWorkspaceTarget,
  extractExplicitRemoteExecCommand,
  inferExplicitCodingBackendRequest,
  inferExplicitCodingTaskOperation,
} from './entity-resolvers/coding.js';
import {
  continuitySuggestsRoutine,
  inferCalendarWindowDays,
  inferRoutineEnabledFilter,
  inferSecondBrainOperation,
  inferSecondBrainPersonalItemType,
  inferSecondBrainQuery,
  isExplicitSecondBrainEntityRequest,
  isExplicitSecondBrainRoutineRequest,
  normalizePersonalItemType,
  pendingActionSuggestsPersonalAssistantTask,
  pendingActionSuggestsRoutine,
} from './entity-resolvers/personal-assistant.js';
import {
  inferEmailProviderFromSource,
  inferMailboxReadModeFromSource,
} from './entity-resolvers/email.js';
import {
  inferProviderConfigOperation,
  isExplicitProviderConfigRequest,
} from './entity-resolvers/provider-config.js';
import {
  normalizeCalendarTarget,
  normalizeCalendarWindowDays,
  normalizeCodingBackend,
  normalizeConfidence,
  normalizeEmailProvider,
  normalizeExecutionClass,
  normalizeExpectedContextPressure,
  normalizeMailboxReadMode,
  normalizeOperation,
  normalizePreferredAnswerPath,
  normalizePreferredTier,
  normalizeResolution,
  normalizeRoute,
  normalizeTurnRelation,
  normalizeUiSurface,
} from './normalization.js';
import { isExplicitComplexPlanningRequest } from './request-patterns.js';
import { collapseIntentGatewayWhitespace, normalizeIntentGatewayRepairText } from './text.js';
import type {
  IntentGatewayDecision,
  IntentGatewayEntities,
  IntentGatewayRepairContext,
} from './types.js';
import { deriveWorkloadMetadata } from './workload-derivation.js';

export function parseIntentGatewayDecision(
  response: ChatResponse,
  repairContext?: IntentGatewayRepairContext,
): { decision: IntentGatewayDecision; available: boolean } {
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content);
  if (!parsed) {
    const repaired = repairUnavailableIntentGatewayDecision(repairContext);
    if (repaired) {
      return {
        decision: repaired,
        available: true,
      };
    }
    return {
      decision: {
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        summary: 'Intent gateway response was not structured.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        entities: {},
      },
      available: false,
    };
  }
  const decision = normalizeIntentGatewayDecision(parsed, repairContext);
  if (decision.route === 'unknown') {
    const repaired = repairUnavailableIntentGatewayDecision(repairContext, parsed);
    if (repaired) {
      return {
        decision: repaired,
        available: true,
      };
    }
  }
  return {
    decision,
    available: decision.route !== 'unknown',
  };
}

export function parseStructuredToolArguments(response: ChatResponse): Record<string, unknown> | null {
  const firstToolCall = response.toolCalls?.[0];
  if (!firstToolCall?.arguments) return null;
  return parseStructuredJsonObject<Record<string, unknown>>(firstToolCall.arguments);
}

export function parseStructuredContent(content: string): Record<string, unknown> | null {
  return parseStructuredJsonObject<Record<string, unknown>>(content);
}

export function normalizeIntentGatewayDecision(
  parsed: Record<string, unknown>,
  repairContext?: IntentGatewayRepairContext,
): IntentGatewayDecision {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  const parsedOperation = normalizeOperation(parsed.operation);
  const confidence = normalizeConfidence(parsed.confidence);
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : 'No classification summary provided.';
  const turnRelation = normalizeTurnRelation(parsed.turnRelation);
  const route = repairIntentGatewayRoute(
    normalizeRoute(parsed.route),
    parsedOperation,
    turnRelation,
    repairContext,
  );
  const operation = repairIntentGatewayOperation(parsedOperation, route, turnRelation, repairContext);
  const resolution = normalizeResolution(parsed.resolution);
  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const resolvedContent = typeof parsed.resolvedContent === 'string' && parsed.resolvedContent.trim()
    ? parsed.resolvedContent.trim()
    : undefined;
  const providerConfigRequest = isExplicitProviderConfigRequest(rawSourceContent);
  const uiSurface = normalizeUiSurface(parsed.uiSurface)
    ?? (route === 'general_assistant' && providerConfigRequest ? 'config' : undefined);
  const derivedWorkload = deriveWorkloadMetadata(route, operation, {
    ...parsed,
    ...(uiSurface ? { uiSurface } : {}),
  });
  const executionClass = normalizeExecutionClass(parsed.executionClass) ?? derivedWorkload.executionClass;
  const preferredTier = normalizePreferredTier(parsed.preferredTier) ?? derivedWorkload.preferredTier;
  const requiresRepoGrounding = typeof parsed.requiresRepoGrounding === 'boolean'
    ? parsed.requiresRepoGrounding
    : derivedWorkload.requiresRepoGrounding;
  const requiresToolSynthesis = typeof parsed.requiresToolSynthesis === 'boolean'
    ? parsed.requiresToolSynthesis
    : derivedWorkload.requiresToolSynthesis;
  const expectedContextPressure = normalizeExpectedContextPressure(parsed.expectedContextPressure)
    ?? derivedWorkload.expectedContextPressure;
  const preferredAnswerPath = normalizePreferredAnswerPath(parsed.preferredAnswerPath)
    ?? derivedWorkload.preferredAnswerPath;

  const automationName = shouldKeepAutomationEntities(route, uiSurface)
    && typeof parsed.automationName === 'string' && parsed.automationName.trim()
    ? parsed.automationName.trim()
    : undefined;
  const newAutomationName = shouldKeepAutomationEntities(route, uiSurface)
    && typeof parsed.newAutomationName === 'string' && parsed.newAutomationName.trim()
    ? parsed.newAutomationName.trim()
    : undefined;
  const manualOnly = typeof parsed.manualOnly === 'boolean' ? parsed.manualOnly : undefined;
  const scheduled = typeof parsed.scheduled === 'boolean' ? parsed.scheduled : undefined;
  const personalItemType = normalizePersonalItemType(parsed.personalItemType)
    ?? inferSecondBrainPersonalItemType(repairContext, route, operation);
  const enabled = typeof parsed.enabled === 'boolean'
    ? parsed.enabled
    : inferRoutineEnabledFilter(repairContext?.sourceContent, route, operation, personalItemType);
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : undefined;
  const query = typeof parsed.query === 'string' && parsed.query.trim()
    ? parsed.query.trim()
    : inferSecondBrainQuery(repairContext?.sourceContent, route, operation, personalItemType);
  const inferredCodingBackendRequest = rawSourceContent && route === 'coding_task'
    ? inferExplicitCodingBackendRequest(rawSourceContent, normalizedSourceContent, operation)
    : null;
  const path = typeof parsed.path === 'string' && parsed.path.trim()
    ? parsed.path.trim()
    : undefined;
  const sessionTarget = cleanInferredSessionTarget(
    typeof parsed.sessionTarget === 'string'
      ? parsed.sessionTarget
      : (
        inferredCodingBackendRequest?.sessionTarget
        ?? (
          rawSourceContent && (route === 'coding_task' || route === 'coding_session_control')
            ? extractCodingWorkspaceTarget(rawSourceContent)
            : undefined
        )
      ),
  );
  const emailProvider = normalizeEmailProvider(parsed.emailProvider)
    ?? inferEmailProviderFromSource(rawSourceContent, route, personalItemType);
  const mailboxReadMode = normalizeMailboxReadMode(parsed.mailboxReadMode)
    ?? inferMailboxReadModeFromSource(rawSourceContent, route, operation);
  const calendarTarget = normalizeCalendarTarget(parsed.calendarTarget)
    ?? (route === 'personal_assistant_task' && personalItemType === 'calendar' ? 'local' : undefined);
  const calendarWindowDays = normalizeCalendarWindowDays(parsed.calendarWindowDays)
    ?? inferCalendarWindowDays(repairContext?.sourceContent, route, personalItemType);
  const codingBackend = normalizeCodingBackend(parsed.codingBackend)
    ?? inferredCodingBackendRequest?.codingBackend;
  const codingBackendRequested = typeof parsed.codingBackendRequested === 'boolean'
    ? parsed.codingBackendRequested
    : inferredCodingBackendRequest
      ? true
      : undefined;
  const inferredRemoteExecCommand = rawSourceContent && route === 'coding_task'
    ? extractExplicitRemoteExecCommand(rawSourceContent, normalizedSourceContent, operation)
    : undefined;
  const codingRemoteExecRequested = typeof parsed.codingRemoteExecRequested === 'boolean'
    ? parsed.codingRemoteExecRequested
    : inferredRemoteExecCommand
      ? true
      : undefined;
  const codingRunStatusCheck = typeof parsed.codingRunStatusCheck === 'boolean'
    ? parsed.codingRunStatusCheck
    : undefined;
  const toolName = typeof parsed.toolName === 'string' && parsed.toolName.trim()
    ? parsed.toolName.trim()
    : undefined;
  const profileId = typeof parsed.profileId === 'string' && parsed.profileId.trim()
    ? parsed.profileId.trim()
    : undefined;
  const command = typeof parsed.command === 'string' && parsed.command.trim()
    ? parsed.command.trim()
    : inferredRemoteExecCommand;

  return {
    route,
    confidence,
    operation,
    summary,
    turnRelation,
    resolution,
    missingFields,
    executionClass,
    preferredTier,
    requiresRepoGrounding,
    requiresToolSynthesis,
    expectedContextPressure,
    preferredAnswerPath,
    ...(resolvedContent ? { resolvedContent } : {}),
    entities: {
      ...(automationName ? { automationName } : {}),
      ...(newAutomationName ? { newAutomationName } : {}),
      ...(typeof manualOnly === 'boolean' ? { manualOnly } : {}),
      ...(typeof scheduled === 'boolean' ? { scheduled } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(uiSurface ? { uiSurface } : {}),
      ...(urls && urls.length > 0 ? { urls } : {}),
      ...(query ? { query } : {}),
      ...(path ? { path } : {}),
      ...(sessionTarget ? { sessionTarget } : {}),
      ...(emailProvider ? { emailProvider } : {}),
      ...(mailboxReadMode ? { mailboxReadMode } : {}),
      ...(calendarTarget ? { calendarTarget } : {}),
      ...(typeof calendarWindowDays === 'number' ? { calendarWindowDays } : {}),
      ...(personalItemType ? { personalItemType } : {}),
      ...(codingBackend ? { codingBackend } : {}),
      ...(typeof codingBackendRequested === 'boolean' ? { codingBackendRequested } : {}),
      ...(typeof codingRemoteExecRequested === 'boolean' ? { codingRemoteExecRequested } : {}),
      ...(typeof codingRunStatusCheck === 'boolean' ? { codingRunStatusCheck } : {}),
      ...(toolName ? { toolName } : {}),
      ...(profileId ? { profileId } : {}),
      ...(command ? { command } : {}),
    },
  };
}

export function buildRawResponsePreview(response: ChatResponse): string | undefined {
  const toolArguments = response.toolCalls?.[0]?.arguments?.trim();
  if (toolArguments) return toolArguments.slice(0, 200);
  const content = response.content.trim();
  return content ? content.slice(0, 200) : undefined;
}

function shouldKeepAutomationEntities(
  route: IntentGatewayDecision['route'],
  uiSurface: IntentGatewayEntities['uiSurface'] | undefined,
): boolean {
  return route === 'automation_authoring'
    || route === 'automation_control'
    || route === 'automation_output_task'
    || (route === 'ui_control' && uiSurface === 'automations');
}

function repairIntentGatewayRoute(
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
): IntentGatewayDecision['route'] {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (isExplicitComplexPlanningRequest(rawSourceContent)) {
    return 'complex_planning_task';
  }
  if (isExplicitProviderConfigRequest(rawSourceContent)) {
    return 'general_assistant';
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

function repairIntentGatewayOperation(
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

function repairUnavailableIntentGatewayDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed?: Record<string, unknown>,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const sourceContent = rawSourceContent.toLowerCase();
  if (!sourceContent) return null;
  if (isExplicitComplexPlanningRequest(rawSourceContent)) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'complex_planning_task',
      operation: 'run',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'medium',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered explicit complex-planning request after an unstructured gateway response.',
    }, repairContext);
  }
  const inferredProviderConfigDecision = inferExplicitProviderConfigDecision(repairContext, parsed);
  if (inferredProviderConfigDecision) {
    return inferredProviderConfigDecision;
  }
  const parsedOperation = normalizeOperation(parsed?.operation);
  const inferredRemoteExecCommand = extractExplicitRemoteExecCommand(
    rawSourceContent,
    sourceContent,
    parsedOperation === 'unknown' ? 'run' : parsedOperation,
  );
  if (inferredRemoteExecCommand) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'coding_task',
      operation: 'run',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered explicit remote-sandbox coding intent after an unstructured gateway response.',
      command: inferredRemoteExecCommand,
      codingRemoteExecRequested: true,
      ...(extractCodingWorkspaceTarget(rawSourceContent)
        ? { sessionTarget: extractCodingWorkspaceTarget(rawSourceContent) }
        : {}),
    }, repairContext);
  }
  const inferredCodingBackendRequest = inferExplicitCodingBackendRequest(
    rawSourceContent,
    sourceContent,
    parsedOperation,
  );
  if (inferredCodingBackendRequest) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'coding_task',
      operation: inferredCodingBackendRequest.operation,
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered coding-backend intent from an explicit backend workspace request after an unstructured gateway response.',
      codingBackend: inferredCodingBackendRequest.codingBackend,
      codingBackendRequested: true,
      ...(inferredCodingBackendRequest.sessionTarget
        ? { sessionTarget: inferredCodingBackendRequest.sessionTarget }
        : {}),
    }, repairContext);
  }
  const inferredSecondBrainDecision = inferExplicitSecondBrainDecision(repairContext, parsed);
  if (inferredSecondBrainDecision) {
    return inferredSecondBrainDecision;
  }
  const inferredCodingOperation = inferExplicitCodingTaskOperation(sourceContent, parsedOperation);
  if (!inferredCodingOperation) return null;
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'coding_task',
    operation: inferredCodingOperation,
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered coding-task intent from explicit repo file references after an unstructured gateway response.',
  }, repairContext);
}

function inferExplicitSecondBrainDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed?: Record<string, unknown>,
): IntentGatewayDecision | null {
  const operation = inferSecondBrainOperation(
    repairContext?.sourceContent,
    'personal_assistant_task',
    normalizeOperation(parsed?.operation) ?? 'unknown',
  );
  if (!operation || operation === 'unknown') {
    return null;
  }
  if (
    !isExplicitSecondBrainEntityRequest(repairContext?.sourceContent, operation)
    && !isExplicitSecondBrainRoutineRequest(repairContext?.sourceContent, operation)
  ) {
    return null;
  }
  const personalItemType = inferSecondBrainPersonalItemType(repairContext, 'personal_assistant_task', operation);
  if (!personalItemType || personalItemType === 'unknown') {
    return null;
  }
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'personal_assistant_task',
    operation,
    personalItemType,
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered Second Brain intent from an unstructured gateway response.',
  }, repairContext);
}

function inferExplicitProviderConfigDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed?: Record<string, unknown>,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (!isExplicitProviderConfigRequest(rawSourceContent)) return null;
  const parsedOperation = normalizeOperation(parsed?.operation);
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'general_assistant',
    operation: inferProviderConfigOperation(rawSourceContent, parsedOperation),
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered an AI provider configuration request after an unstructured gateway response.',
    uiSurface: 'config',
    executionClass: 'provider_crud',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
  }, repairContext);
}

function mentionsAutomationControlTerms(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  return /\bautomation\b/.test(normalized)
    || /\bworkflow\b/.test(normalized)
    || /\bautomations\b/.test(normalized);
}
