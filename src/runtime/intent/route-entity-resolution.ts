import {
  extractExplicitProfileId,
  findExplicitBuiltinToolName,
} from './capability-inventory.js';
import {
  areEquivalentSessionTargets,
  cleanInferredSessionTarget,
  extractCodingWorkspaceTarget,
  extractExplicitRemoteExecCommand,
  inferCodeSessionResource,
  inferExplicitCodingBackendRequest,
  hasExplicitRemoteSandboxReference,
  resolveExplicitRemoteProfileId,
} from './entity-resolvers/coding.js';
import {
  inferEmailProviderFromSource,
  inferMailboxReadModeFromSource,
} from './entity-resolvers/email.js';
import {
  inferCalendarWindowDays,
  inferRoutineEnabledFilter,
  inferSecondBrainPersonalItemType,
  inferSecondBrainQuery,
  normalizePersonalItemType,
} from './entity-resolvers/personal-assistant.js';
import { isExplicitProviderConfigRequest } from './entity-resolvers/provider-config.js';
import {
  normalizeCalendarTarget,
  normalizeAutomationReadView,
  normalizeCalendarWindowDays,
  normalizeCodingBackend,
  normalizeCodeSessionResource,
  normalizeEmailProvider,
  normalizeMailboxReadMode,
  normalizeUiSurface,
} from './normalization.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import type {
  IntentGatewayDecision,
  IntentGatewayDecisionProvenance,
  IntentGatewayEntities,
  IntentGatewayProvenanceSource,
  IntentGatewayRepairContext,
} from './types.js';
import { inferAutomationReadView } from './entity-resolvers/automation.js';

export interface IntentGatewayEntityResolution {
  entities: IntentGatewayEntities;
  provenance?: IntentGatewayDecisionProvenance['entities'];
}

export function resolveIntentGatewayEntities(
  parsed: Record<string, unknown>,
  repairContext: IntentGatewayRepairContext | undefined,
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
  classifierSource: IntentGatewayProvenanceSource,
): IntentGatewayEntityResolution {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const normalizedSourceContent = rawSourceContent.toLowerCase();
  const providerConfigRequest = isExplicitProviderConfigRequest(rawSourceContent);
  const provenance: NonNullable<IntentGatewayDecisionProvenance['entities']> = {};
  const uiSurface = normalizeUiSurface(parsed.uiSurface)
    ?? (route === 'general_assistant' && providerConfigRequest ? 'config' : undefined);
  if (uiSurface) {
    provenance.uiSurface = normalizeUiSurface(parsed.uiSurface)
      ? classifierSource
      : 'resolver.provider_config';
  }
  const automationName = shouldKeepAutomationEntities(route, uiSurface)
    && typeof parsed.automationName === 'string' && parsed.automationName.trim()
    ? parsed.automationName.trim()
    : undefined;
  if (automationName) provenance.automationName = classifierSource;
  const newAutomationName = shouldKeepAutomationEntities(route, uiSurface)
    && typeof parsed.newAutomationName === 'string' && parsed.newAutomationName.trim()
    ? parsed.newAutomationName.trim()
    : undefined;
  if (newAutomationName) provenance.newAutomationName = classifierSource;
  const parsedAutomationReadView = shouldKeepAutomationEntities(route, uiSurface)
    ? normalizeAutomationReadView(parsed.automationReadView)
    : undefined;
  const automationReadView = parsedAutomationReadView
    ?? (shouldKeepAutomationEntities(route, uiSurface)
      ? inferAutomationReadView(rawSourceContent, route, operation)
      : undefined);
  if (automationReadView) {
    provenance.automationReadView = parsedAutomationReadView
      ? classifierSource
      : 'resolver.automation';
  }
  const manualOnly = typeof parsed.manualOnly === 'boolean' ? parsed.manualOnly : undefined;
  if (typeof manualOnly === 'boolean') provenance.manualOnly = classifierSource;
  const scheduled = typeof parsed.scheduled === 'boolean' ? parsed.scheduled : undefined;
  if (typeof scheduled === 'boolean') provenance.scheduled = classifierSource;
  const parsedPersonalItemType = route === 'personal_assistant_task'
    ? normalizePersonalItemType(parsed.personalItemType)
    : undefined;
  const personalItemType = parsedPersonalItemType
    ?? inferSecondBrainPersonalItemType(repairContext, route, operation);
  if (personalItemType) {
    provenance.personalItemType = parsedPersonalItemType
      ? classifierSource
      : 'resolver.personal_assistant';
  }
  const enabled = typeof parsed.enabled === 'boolean'
    ? parsed.enabled
    : inferRoutineEnabledFilter(repairContext?.sourceContent, route, operation, personalItemType);
  if (typeof enabled === 'boolean') {
    provenance.enabled = typeof parsed.enabled === 'boolean'
      ? classifierSource
      : 'resolver.personal_assistant';
  }
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : undefined;
  if (urls && urls.length > 0) provenance.urls = classifierSource;
  const query = typeof parsed.query === 'string' && parsed.query.trim()
    ? parsed.query.trim()
    : inferSecondBrainQuery(repairContext?.sourceContent, route, operation, personalItemType);
  if (query) {
    provenance.query = typeof parsed.query === 'string' && parsed.query.trim()
      ? classifierSource
      : 'resolver.personal_assistant';
  }
  const inferredCodingBackendRequest = rawSourceContent && route === 'coding_task'
    ? inferExplicitCodingBackendRequest(rawSourceContent, normalizedSourceContent, operation)
    : null;
  const path = typeof parsed.path === 'string' && parsed.path.trim()
    ? parsed.path.trim()
    : undefined;
  if (path) provenance.path = classifierSource;
  const extractedSessionTarget = rawSourceContent && (route === 'coding_task' || route === 'coding_session_control')
    ? extractCodingWorkspaceTarget(rawSourceContent)
    : undefined;
  const parsedSessionTarget = cleanInferredSessionTarget(
    typeof parsed.sessionTarget === 'string'
      ? parsed.sessionTarget
      : undefined,
  );
  const derivedCodingTaskSessionTarget = extractedSessionTarget ?? inferredCodingBackendRequest?.sessionTarget;
  const preferredCodingTaskParsedSessionTarget = parsedSessionTarget
    && derivedCodingTaskSessionTarget
    && parsedSessionTarget.length > derivedCodingTaskSessionTarget.length
    && areEquivalentSessionTargets(parsedSessionTarget, derivedCodingTaskSessionTarget)
      ? parsedSessionTarget
      : undefined;
  const sessionTargetSource = route === 'coding_session_control'
    ? (parsedSessionTarget ? 'classifier' : extractedSessionTarget ? 'resolver' : undefined)
    : (
      preferredCodingTaskParsedSessionTarget
        ? 'classifier'
        : derivedCodingTaskSessionTarget
          ? 'resolver'
          : !rawSourceContent && parsedSessionTarget
            ? 'classifier'
            : undefined
    );
  const sessionTarget = cleanInferredSessionTarget(
    route === 'coding_session_control'
      ? (parsedSessionTarget ?? extractedSessionTarget)
      : (
        preferredCodingTaskParsedSessionTarget
        ?? derivedCodingTaskSessionTarget
        ?? (!rawSourceContent ? parsedSessionTarget : undefined)
      ),
  );
  if (sessionTarget && sessionTargetSource) {
    provenance.sessionTarget = sessionTargetSource === 'classifier'
      ? classifierSource
      : 'resolver.coding';
  }
  const parsedCodeSessionResource = route === 'coding_session_control'
    ? normalizeCodeSessionResource(parsed.codeSessionResource)
    : undefined;
  const codeSessionResource = parsedCodeSessionResource
    ?? (route === 'coding_session_control'
      ? inferCodeSessionResource(normalizedSourceContent)
      : undefined);
  if (codeSessionResource) {
    provenance.codeSessionResource = parsedCodeSessionResource
      ? classifierSource
      : 'resolver.coding';
  }
  const emailProvider = normalizeEmailProvider(parsed.emailProvider)
    ?? inferEmailProviderFromSource(rawSourceContent, route, personalItemType);
  if (emailProvider) {
    provenance.emailProvider = normalizeEmailProvider(parsed.emailProvider)
      ? classifierSource
      : 'resolver.email';
  }
  const mailboxReadMode = normalizeMailboxReadMode(parsed.mailboxReadMode)
    ?? inferMailboxReadModeFromSource(rawSourceContent, route, operation);
  if (mailboxReadMode) {
    provenance.mailboxReadMode = normalizeMailboxReadMode(parsed.mailboxReadMode)
      ? classifierSource
      : 'resolver.email';
  }
  const calendarTarget = normalizeCalendarTarget(parsed.calendarTarget)
    ?? (route === 'personal_assistant_task' && personalItemType === 'calendar' ? 'local' : undefined);
  if (calendarTarget) {
    provenance.calendarTarget = normalizeCalendarTarget(parsed.calendarTarget)
      ? classifierSource
      : 'resolver.personal_assistant';
  }
  const calendarWindowDays = normalizeCalendarWindowDays(parsed.calendarWindowDays)
    ?? inferCalendarWindowDays(repairContext?.sourceContent, route, personalItemType);
  if (typeof calendarWindowDays === 'number') {
    provenance.calendarWindowDays = normalizeCalendarWindowDays(parsed.calendarWindowDays) !== undefined
      ? classifierSource
      : 'resolver.personal_assistant';
  }
  const codingBackend = normalizeCodingBackend(parsed.codingBackend)
    ?? inferredCodingBackendRequest?.codingBackend;
  if (codingBackend) {
    provenance.codingBackend = normalizeCodingBackend(parsed.codingBackend)
      ? classifierSource
      : 'resolver.coding';
  }
  const codingBackendRequested = typeof parsed.codingBackendRequested === 'boolean'
    ? parsed.codingBackendRequested
    : inferredCodingBackendRequest
      ? true
      : undefined;
  if (typeof codingBackendRequested === 'boolean') {
    provenance.codingBackendRequested = typeof parsed.codingBackendRequested === 'boolean'
      ? classifierSource
      : 'resolver.coding';
  }
  const inferredRemoteExecCommand = rawSourceContent && route === 'coding_task'
    ? extractExplicitRemoteExecCommand(rawSourceContent, normalizedSourceContent, operation)
    : undefined;
  const codingRemoteExecRequested = typeof parsed.codingRemoteExecRequested === 'boolean'
    ? parsed.codingRemoteExecRequested
    : inferredRemoteExecCommand
      || (rawSourceContent && route === 'coding_task'
        ? hasExplicitRemoteSandboxReference(rawSourceContent, normalizedSourceContent)
        : false)
      ? true
      : undefined;
  if (typeof codingRemoteExecRequested === 'boolean') {
    provenance.codingRemoteExecRequested = typeof parsed.codingRemoteExecRequested === 'boolean'
      ? classifierSource
      : 'resolver.coding';
  }
  const codingRunStatusCheck = typeof parsed.codingRunStatusCheck === 'boolean'
    ? parsed.codingRunStatusCheck
    : undefined;
  if (typeof codingRunStatusCheck === 'boolean') provenance.codingRunStatusCheck = classifierSource;
  const parsedToolName = typeof parsed.toolName === 'string' && parsed.toolName.trim()
    ? parsed.toolName.trim()
    : undefined;
  const inferredToolName = parsedToolName
    ? undefined
    : findExplicitBuiltinToolName(rawSourceContent);
  const toolName = parsedToolName ?? inferredToolName;
  if (toolName) {
    provenance.toolName = parsedToolName
      ? classifierSource
      : 'resolver.tool_inventory';
  }
  const profileId = typeof parsed.profileId === 'string' && parsed.profileId.trim()
    ? parsed.profileId.trim()
    : rawSourceContent && route === 'coding_task'
      ? resolveExplicitRemoteProfileId(rawSourceContent)
    : rawSourceContent && route === 'general_assistant'
      ? extractExplicitProfileId(rawSourceContent)
    : undefined;
  if (profileId) {
    provenance.profileId = typeof parsed.profileId === 'string' && parsed.profileId.trim()
      ? classifierSource
      : route === 'coding_task'
        ? 'resolver.coding'
        : 'resolver.tool_inventory';
  }
  const command = typeof parsed.command === 'string' && parsed.command.trim()
    ? parsed.command.trim()
    : inferredRemoteExecCommand;
  if (command) {
    provenance.command = typeof parsed.command === 'string' && parsed.command.trim()
      ? classifierSource
      : 'resolver.coding';
  }

  const entities = {
    ...(automationName ? { automationName } : {}),
    ...(newAutomationName ? { newAutomationName } : {}),
    ...(automationReadView ? { automationReadView } : {}),
    ...(typeof manualOnly === 'boolean' ? { manualOnly } : {}),
    ...(typeof scheduled === 'boolean' ? { scheduled } : {}),
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(uiSurface ? { uiSurface } : {}),
    ...(urls && urls.length > 0 ? { urls } : {}),
    ...(query ? { query } : {}),
    ...(path ? { path } : {}),
    ...(sessionTarget ? { sessionTarget } : {}),
    ...(codeSessionResource ? { codeSessionResource } : {}),
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
  } satisfies IntentGatewayEntities;

  return {
    entities,
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  };
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
