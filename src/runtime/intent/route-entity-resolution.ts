import {
  extractExplicitProfileId,
  findExplicitBuiltinToolName,
} from './capability-inventory.js';
import {
  areEquivalentSessionTargets,
  cleanInferredSessionTarget,
  extractCodingWorkspaceTarget,
  extractExplicitRemoteExecCommand,
  inferCodeSessionSandboxProvider,
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
  normalizeCodeSessionSandboxProvider,
  normalizeCodeSessionResource,
  normalizeEmailProvider,
  normalizeFileExtension,
  normalizeMailboxReadMode,
  normalizeSearchSourceType,
  normalizeUiSurface,
} from './normalization.js';
import { isMeaningfulWebSearchQuery, parseWebSearchIntent } from '../search-intent.js';
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
  const parsedQuery = typeof parsed.query === 'string' && parsed.query.trim()
    ? parsed.query.trim()
    : undefined;
  const inferredSecondBrainQuery = parsedQuery
    ? undefined
    : inferSecondBrainQuery(repairContext?.sourceContent, route, operation, personalItemType);
  const inferredWebSearchQuery = parsedQuery || inferredSecondBrainQuery
    ? undefined
    : inferWebSearchQuery(rawSourceContent, route);
  const query = parsedQuery ?? inferredSecondBrainQuery ?? inferredWebSearchQuery;
  if (query) {
    provenance.query = parsedQuery
      ? classifierSource
      : inferredSecondBrainQuery
        ? 'resolver.personal_assistant'
        : 'resolver.web_search';
  }
  const inferredCodingBackendRequest = rawSourceContent && route === 'coding_task'
    ? inferExplicitCodingBackendRequest(rawSourceContent, normalizedSourceContent, operation)
    : null;
  const path = typeof parsed.path === 'string' && parsed.path.trim()
    ? parsed.path.trim()
    : undefined;
  if (path) provenance.path = classifierSource;
  const parsedFileExtension = ['coding_task', 'filesystem_task', 'search_task'].includes(route)
    ? normalizeFileExtension(parsed.fileExtension)
    : undefined;
  const inferredFileExtension = parsedFileExtension
    ?? inferFileExtensionFromSource(rawSourceContent, route, operation);
  const fileExtension = inferredFileExtension;
  if (fileExtension) {
    provenance.fileExtension = parsedFileExtension
      ? classifierSource
      : 'resolver.coding';
  }
  const extractedSessionTarget = rawSourceContent && (route === 'coding_task' || route === 'coding_session_control')
    ? extractCodingWorkspaceTarget(rawSourceContent)
    : undefined;
  const parsedSessionTarget = cleanInferredSessionTarget(
    typeof parsed.sessionTarget === 'string'
      ? parsed.sessionTarget
      : undefined,
  );
  const suppressAttachedCodeSessionTarget = route === 'coding_task'
    && hasAttachedCodeSessionReference(repairContext)
    && refersToCurrentAttachedCodingWorkspace(normalizedSourceContent);
  const derivedCodingTaskSessionTarget = suppressAttachedCodeSessionTarget
    ? inferredCodingBackendRequest?.sessionTarget
    : extractedSessionTarget ?? inferredCodingBackendRequest?.sessionTarget;
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
  const parsedCodeSessionSandboxProvider = route === 'coding_session_control'
    ? normalizeCodeSessionSandboxProvider(parsed.codeSessionSandboxProvider)
    : undefined;
  const codeSessionSandboxProvider = parsedCodeSessionSandboxProvider
    ?? (route === 'coding_session_control' && codeSessionResource === 'managed_sandboxes'
      ? inferCodeSessionSandboxProvider(normalizedSourceContent)
      : undefined);
  if (codeSessionSandboxProvider) {
    provenance.codeSessionSandboxProvider = parsedCodeSessionSandboxProvider
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
  const searchSourceId = route === 'search_task' && typeof parsed.searchSourceId === 'string' && parsed.searchSourceId.trim()
    ? parsed.searchSourceId.trim()
    : undefined;
  if (searchSourceId) provenance.searchSourceId = classifierSource;
  const searchSourceName = route === 'search_task' && typeof parsed.searchSourceName === 'string' && parsed.searchSourceName.trim()
    ? parsed.searchSourceName.trim()
    : undefined;
  if (searchSourceName) provenance.searchSourceName = classifierSource;
  const searchSourceType = route === 'search_task'
    ? normalizeSearchSourceType(parsed.searchSourceType)
    : undefined;
  if (searchSourceType) provenance.searchSourceType = classifierSource;

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
    ...(fileExtension ? { fileExtension } : {}),
    ...(sessionTarget ? { sessionTarget } : {}),
    ...(codeSessionResource ? { codeSessionResource } : {}),
    ...(codeSessionSandboxProvider ? { codeSessionSandboxProvider } : {}),
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
    ...(searchSourceId ? { searchSourceId } : {}),
    ...(searchSourceName ? { searchSourceName } : {}),
    ...(searchSourceType ? { searchSourceType } : {}),
  } satisfies IntentGatewayEntities;

  return {
    entities,
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  };
}

function hasAttachedCodeSessionReference(repairContext: IntentGatewayRepairContext | undefined): boolean {
  return repairContext?.continuity?.activeExecutionRefs?.some((ref) => ref.startsWith('code_session:')) === true
    || !!repairContext?.continuity?.activeExecution?.codeSessionId;
}

function refersToCurrentAttachedCodingWorkspace(normalizedSourceContent: string): boolean {
  return /\b(?:attached|current|active)\b[\s\S]{0,60}\b(?:coding\s+)?(?:workspace|session)\b/.test(normalizedSourceContent)
    || /\b(?:coding\s+)?(?:workspace|session)\b[\s\S]{0,60}\b(?:attached|current|active)\b/.test(normalizedSourceContent);
}

function inferWebSearchQuery(
  sourceContent: string,
  route: IntentGatewayDecision['route'],
): string | undefined {
  if (route !== 'search_task' && route !== 'browser_task') {
    return undefined;
  }
  const explicitWebQuery = parseWebSearchIntent(sourceContent);
  if (explicitWebQuery) {
    return explicitWebQuery;
  }
  if (hasExplicitWebResearchInstruction(sourceContent)) {
    return undefined;
  }
  const continuationQuery = cleanRoutedWebSearchQuery(sourceContent);
  return isMeaningfulWebSearchQuery(continuationQuery) ? continuationQuery : undefined;
}

function cleanRoutedWebSearchQuery(sourceContent: string): string {
  return collapseIntentGatewayWhitespace(sourceContent)
    .replace(/^(?:now\s+)?(?:narrow|focus|filter|limit)\s+(?:that|this|it|the\s+results?)\s+(?:down\s+)?(?:to|on)\s+/i, '')
    .replace(/\b(?:keep\s+it\s+)?(?:factual|concise|brief)\b.*$/i, '')
    .trim();
}

function hasExplicitWebResearchInstruction(sourceContent: string): boolean {
  return /\b(?:search|browse|research|look\s+up|find|go\s+out)\b.{0,80}\b(?:web|internet|online|websites?|sites?|pages?)\b/i.test(sourceContent)
    || /\b(?:web|internet|online|websites?|sites?|pages?)\b.{0,80}\b(?:search|browse|research|look\s+up|find|go\s+out)\b/i.test(sourceContent);
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

function inferFileExtensionFromSource(
  sourceContent: string,
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
): string | undefined {
  if (!sourceContent || (operation !== 'search' && operation !== 'unknown')) return undefined;
  if (route !== 'coding_task' && route !== 'filesystem_task' && route !== 'search_task') return undefined;
  const normalized = sourceContent.toLowerCase();
  if (!isFileExtensionInventoryRequest(normalized)) return undefined;
  const explicit = sourceContent.match(/(^|[\s"'`(])(\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31})(?=$|[\s"'`),.;:!?])/);
  const explicitExtension = normalizeFileExtension(explicit?.[2]);
  if (explicitExtension) return explicitExtension;

  const knownTypes: Array<[RegExp, string]> = [
    [/\bjson\s+files\b/, '.json'],
    [/\b(?:markdown|md)\s+files\b/, '.md'],
    [/\b(?:text|txt)\s+files\b/, '.txt'],
    [/\b(?:typescript|ts)\s+files\b/, '.ts'],
    [/\b(?:javascript|js)\s+files\b/, '.js'],
    [/\b(?:python|py)\s+files\b/, '.py'],
    [/\b(?:yaml|yml)\s+files\b/, '.yaml'],
    [/\btoml\s+files\b/, '.toml'],
  ];
  for (const [pattern, extension] of knownTypes) {
    if (pattern.test(normalized)) return extension;
  }
  return undefined;
}

function isFileExtensionInventoryRequest(normalizedSourceContent: string): boolean {
  return /\b(?:find|search|list|show)\b.{0,80}\b(?:files?|paths?|extensions?)\b/.test(normalizedSourceContent)
    || /\b(?:files?|paths?|extensions?)\b.{0,80}\b(?:find|search|list|show)\b/.test(normalizedSourceContent);
}
