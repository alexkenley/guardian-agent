import type { ChatMessage, ChatResponse, ToolDefinition } from '../llm/types.js';
import { deriveIntentRouteClarification } from './intent/intent-route-clarification.js';
import { confirmIntentGatewayDecisionIfNeeded } from './intent/confirmation-pass.js';
import { selectIntentGatewayPromptProfile } from './intent/prompt-profiles.js';
import { normalizeIntentGatewayPromptProfile, normalizeRoute } from './intent/normalization.js';
import {
  classifierProvenanceSourceForMode,
  normalizeIntentGatewayDecisionProvenance,
} from './intent/provenance.js';
import { classifyIntentGatewayPass } from './intent/route-classifier.js';
import {
  extractExplicitAutomationName,
  inferAutomationControlOperation,
  inferAutomationEnabledState,
} from './intent/entity-resolvers/automation.js';
import {
  normalizeIntentGatewayDecision,
  parseStructuredContent,
  parseStructuredToolArguments,
} from './intent/structured-recovery.js';
import { hasRequiredWritePlannedStep } from './intent/planned-steps.js';
import {
  PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY,
} from './intent/types.js';
import type {
  IntentGatewayChatFn,
  IntentGatewayDecision,
  IntentGatewayInput,
  IntentGatewayRecord,
} from './intent/types.js';

export { PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY } from './intent/types.js';
export type {
  IntentGatewayChatFn,
  IntentGatewayConfidence,
  IntentGatewayDecision,
  IntentGatewayDecisionProvenance,
  IntentGatewayEntities,
  IntentGatewayExecutionClass,
  IntentGatewayExpectedContextPressure,
  IntentGatewayInput,
  IntentGatewayOperation,
  IntentGatewayPlannedStep,
  IntentGatewayPlannedStepKind,
  IntentGatewayPreferredAnswerPath,
  IntentGatewayPreferredTier,
  IntentGatewayPromptProfile,
  IntentGatewayProvenanceSource,
  IntentGatewayRepairContext,
  IntentGatewayRecord,
  IntentGatewayResolution,
  IntentGatewayRoute,
  IntentGatewayTurnRelation,
} from './intent/types.js';

const AUTOMATION_NAME_REPAIR_TOOL: ToolDefinition = {
  name: 'resolve_automation_name',
  description: 'Extract the exact saved automation name referenced by a request that is already known to be about controlling an existing automation. Call exactly once.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      automationName: {
        type: 'string',
      },
    },
    required: ['automationName'],
  },
};

const AUTOMATION_NAME_REPAIR_SYSTEM_PROMPT = [
  'You repair missing automation names for Guardian intent routing.',
  'The route and operation are already known to be about controlling an existing saved automation.',
  'Return only the exact automationName the user referenced.',
  'Call the resolve_automation_name tool exactly once.',
].join(' ');

export class IntentGateway {
  async classify(
    input: IntentGatewayInput,
    chat: IntentGatewayChatFn,
  ): Promise<IntentGatewayRecord> {
    const startedAt = Date.now();
    const primaryPromptProfile = selectIntentGatewayPromptProfile(input);
    const primary = await classifyIntentGatewayPass(input, chat, {
      mode: 'primary',
      startedAt,
      promptProfile: primaryPromptProfile,
    });
    if (primary.available) {
      return this.repairDecisionIfNeeded(input, primary, chat);
    }

    const fallback = await classifyIntentGatewayPass(input, chat, {
      mode: 'json_fallback',
      startedAt,
      promptProfile: primaryPromptProfile,
    });
    if (fallback.available) {
      return this.repairDecisionIfNeeded(input, fallback, chat);
    }

    const routeOnly = await classifyIntentGatewayPass(input, chat, {
      mode: 'route_only_fallback',
      startedAt,
      promptProfile: primaryPromptProfile,
    });
    if (routeOnly.available || routeOnly.rawResponsePreview || routeOnly.model !== 'unknown') {
      return this.repairDecisionIfNeeded(input, routeOnly, chat);
    }
    if (fallback.rawResponsePreview || fallback.model !== 'unknown') {
      return this.repairDecisionIfNeeded(input, fallback, chat);
    }
    return this.repairDecisionIfNeeded(input, primary, chat);
  }

  private async repairDecisionIfNeeded(
    input: IntentGatewayInput,
    record: IntentGatewayRecord,
    chat: IntentGatewayChatFn,
  ): Promise<IntentGatewayRecord> {
    let workingRecord = normalizeIntentGatewayRecordDecisionForInput(input, record);
    let decision = repairEmailProviderDecisionIfNeeded(input, workingRecord.decision);
    decision = resolveSatisfiedClarificationIfNeeded(input, decision);
    workingRecord = decision === workingRecord.decision
      ? workingRecord
      : {
          ...workingRecord,
          decision,
        };
    workingRecord = await confirmIntentGatewayDecisionIfNeeded(input, workingRecord, chat);
    decision = workingRecord.decision;
    decision = repairAutomationClarificationFromRecentHistory(input, decision);
    if (needsAutomationNameRepair(decision)) {
      const repairedName = await repairAutomationName(input, decision, chat);
      if (repairedName) {
        decision = {
          ...decision,
          provenance: {
            ...(decision.provenance ?? {}),
            entities: {
              ...(decision.provenance?.entities ?? {}),
              automationName: 'repair.automation_name',
            },
          },
          entities: {
            ...decision.entities,
            automationName: repairedName,
          },
        };
      }
    }
    decision = applyIntentRouteClarificationGuard(input, workingRecord, decision);
    return {
      ...workingRecord,
      decision,
    };
  }
}

function normalizeIntentGatewayRecordDecisionForInput(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
): IntentGatewayRecord {
  if (record.decision.route !== 'unknown') {
    return record;
  }
  const decision = normalizeIntentGatewayDecision(
    {
      ...record.decision,
      ...record.decision.entities,
    } as Record<string, unknown>,
    {
      sourceContent: input.content,
      pendingAction: input.pendingAction,
      continuity: input.continuity,
    },
    { classifierSource: classifierProvenanceSourceForMode(record.mode) },
  );
  return {
    ...record,
    decision,
  };
}

function repairEmailProviderDecisionIfNeeded(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
): IntentGatewayDecision {
  if (decision.route !== 'email_task' || decision.entities.emailProvider) {
    return decision;
  }

  const enabledProviders = new Set(
    (input.enabledManagedProviders ?? [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase()),
  );
  const hasGoogleWorkspace = enabledProviders.has('gws');
  const hasMicrosoft365 = enabledProviders.has('m365');

  if (!hasGoogleWorkspace && !hasMicrosoft365) {
    return decision;
  }

  if (hasGoogleWorkspace && hasMicrosoft365) {
    const missingFields = new Set(decision.missingFields);
    missingFields.add('email_provider');
    return {
      ...decision,
      resolution: 'needs_clarification',
      missingFields: [...missingFields],
    };
  }

  const emailProvider = hasMicrosoft365 ? 'm365' : 'gws';
  return {
    ...decision,
    provenance: {
      ...(decision.provenance ?? {}),
      entities: {
        ...(decision.provenance?.entities ?? {}),
        emailProvider: decision.provenance?.entities?.emailProvider ?? 'resolver.email',
      },
    },
    entities: {
      ...decision.entities,
      emailProvider,
    },
  };
}

function resolveSatisfiedClarificationIfNeeded(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
): IntentGatewayDecision {
  const pendingAction = input.pendingAction;
  if (!pendingAction || pendingAction.blockerKind !== 'clarification') {
    return decision;
  }
  const satisfiedField = readSatisfiedClarificationField(decision, pendingAction, pendingAction.field);
  if (!satisfiedField) {
    return decision;
  }
  const missingFields = decision.missingFields.filter((field) => field !== satisfiedField);
  const resolvedContent = decision.resolvedContent
    ?? buildSatisfiedClarificationResolvedContent(decision, pendingAction.originalRequest, satisfiedField);
  return {
    ...decision,
    turnRelation: decision.turnRelation === 'correction' ? 'correction' : 'clarification_answer',
    resolution: 'ready',
    missingFields,
    ...(resolvedContent ? { resolvedContent } : {}),
    provenance: {
      ...(decision.provenance ?? {}),
      ...(resolvedContent
        ? {
            resolvedContent: decision.provenance?.resolvedContent ?? 'resolver.clarification',
          }
        : {}),
    },
  };
}

function readSatisfiedClarificationField(
  decision: IntentGatewayDecision,
  pendingAction: NonNullable<IntentGatewayInput['pendingAction']>,
  field: string | undefined,
): string | null {
  switch (field?.trim()) {
    case 'email_provider':
      return decision.entities.emailProvider ? 'email_provider' : null;
    case 'coding_backend':
      return decision.entities.codingBackend ? 'coding_backend' : null;
    case 'automation_name':
      return decision.entities.automationName?.trim() ? 'automation_name' : null;
    case 'session_target':
      return decision.entities.sessionTarget?.trim() ? 'session_target' : null;
    case 'path':
      return decision.entities.path?.trim() ? 'path' : null;
    case 'intent_route':
      return hasSatisfiedIntentRouteClarification(decision, pendingAction) ? 'intent_route' : null;
    default:
      return null;
  }
}

function buildSatisfiedClarificationResolvedContent(
  decision: IntentGatewayDecision,
  originalRequest: string,
  field: string,
): string | undefined {
  const original = originalRequest.trim();
  if (!original) return undefined;
  switch (field) {
    case 'email_provider': {
      const providerLabel = decision.entities.emailProvider === 'm365'
        ? 'Outlook / Microsoft 365'
        : decision.entities.emailProvider === 'gws'
          ? 'Gmail / Google Workspace'
          : '';
      return providerLabel ? `Use ${providerLabel} for this request: ${original}` : undefined;
    }
    case 'coding_backend': {
      const backendLabel = formatCodingBackendLabel(decision.entities.codingBackend);
      return backendLabel ? `Use ${backendLabel} for this request: ${original}` : undefined;
    }
    case 'automation_name':
      return original;
    case 'session_target':
      return `Use ${decision.entities.sessionTarget} for this request: ${original}`;
    case 'path':
      return decision.entities.path?.trim()
        ? `Use path ${decision.entities.path.trim()} for this request: ${original}`
        : original;
    case 'intent_route':
      return original;
    default:
      return undefined;
  }
}

function applyIntentRouteClarificationGuard(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
  decision: IntentGatewayDecision,
): IntentGatewayDecision {
  const clarification = deriveIntentRouteClarification({
    content: input.content,
    decision,
    mode: record.mode,
  });
  if (!clarification) {
    return decision;
  }
  const missingFields = new Set(decision.missingFields);
  missingFields.add('intent_route');
  return {
    ...decision,
    confidence: decision.confidence === 'high' ? 'medium' : decision.confidence,
    resolution: 'needs_clarification',
    missingFields: [...missingFields],
    summary: clarification.prompt,
  };
}

function hasSatisfiedIntentRouteClarification(
  decision: IntentGatewayDecision,
  pendingAction: NonNullable<IntentGatewayInput['pendingAction']>,
): boolean {
  const candidates = readIntentRouteCandidatesFromPendingAction(pendingAction);
  if (candidates.length === 0) {
    return (decision.turnRelation === 'clarification_answer' || decision.turnRelation === 'correction')
      && decision.resolution === 'ready'
      && decision.route !== 'unknown';
  }
  return candidates.includes(decision.route);
}

function readIntentRouteCandidatesFromPendingAction(
  pendingAction: NonNullable<IntentGatewayInput['pendingAction']>,
): IntentGatewayDecision['route'][] {
  const rawCandidates = pendingAction.entities?.intentRouteCandidates;
  if (!Array.isArray(rawCandidates)) {
    return [];
  }
  return [...new Set(
    rawCandidates
      .map((value) => normalizeRoute(value))
      .filter((value): value is IntentGatewayDecision['route'] => value !== 'unknown'),
  )];
}

function formatCodingBackendLabel(value: string | undefined): string {
  switch (value?.trim()) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'gemini-cli':
      return 'Gemini CLI';
    case 'aider':
      return 'Aider';
    default:
      return value?.trim() ?? '';
  }
}

const AUTOMATION_NAME_CLARIFICATION_PROMPT_PATTERN = /tell me which automation you want to inspect, run, rename, enable, disable, or edit/i;
const DEICTIC_AUTOMATION_REFERENCE_PATTERN = /\b(?:that|it|the one|just created|new one|newly created|latest|most recent)\b/i;
const AUTOMATION_CONTROL_VERB_PATTERN = /\b(?:disable|enable|run|inspect|show|read|delete|remove|rename|edit|update|change|modify|clone|list)\b/i;

function repairAutomationClarificationFromRecentHistory(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
): IntentGatewayDecision {
  const isAutomationControlRoute = decision.route === 'automation_control'
    || (decision.route === 'ui_control' && decision.entities.uiSurface === 'automations');
  if (!isAutomationControlRoute) {
    return decision;
  }
  if (decision.turnRelation === 'clarification_answer' || decision.turnRelation === 'correction') {
    return decision;
  }

  const clarificationContext = readAutomationNameClarificationContext(input.recentHistory);
  if (!clarificationContext) {
    return decision;
  }

  const repairedOperation = decision.operation === 'unknown'
    ? inferAutomationControlOperation(clarificationContext.originalUserRequest, decision.operation)
    : decision.operation;
  if (repairedOperation === 'unknown') {
    return decision;
  }

  const repairedAutomationName = decision.entities.automationName?.trim()
    || extractExplicitAutomationName(input.content)
    || readAutomationClarificationAnswerName(input.content);
  const enabled = typeof decision.entities.enabled === 'boolean'
    ? decision.entities.enabled
    : inferAutomationEnabledState(clarificationContext.originalUserRequest);

  return {
    ...decision,
    operation: repairedOperation,
    turnRelation: 'clarification_answer',
    resolution: 'ready',
    missingFields: decision.missingFields.filter((field) => field !== 'automation_name'),
    entities: {
      ...decision.entities,
      ...(repairedAutomationName ? { automationName: repairedAutomationName } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
    },
    ...(decision.resolvedContent
      ? {}
      : { resolvedContent: clarificationContext.originalUserRequest }),
    provenance: {
      ...(decision.provenance ?? {}),
      ...(decision.resolvedContent
        ? {}
        : { resolvedContent: decision.provenance?.resolvedContent ?? 'resolver.clarification' }),
      entities: {
        ...(decision.provenance?.entities ?? {}),
        ...(repairedAutomationName && !decision.provenance?.entities?.automationName
          ? { automationName: 'repair.automation_name' }
          : {}),
        ...(typeof enabled === 'boolean' && !decision.provenance?.entities?.enabled
          ? { enabled: 'repair.automation_name' }
          : {}),
      },
    },
  };
}

function readAutomationNameClarificationContext(
  recentHistory: IntentGatewayInput['recentHistory'],
): { originalUserRequest: string } | null {
  if (!Array.isArray(recentHistory) || recentHistory.length === 0) {
    return null;
  }
  for (let index = recentHistory.length - 1; index >= 0; index -= 1) {
    const entry = recentHistory[index];
    if (!entry || entry.role !== 'assistant') {
      continue;
    }
    if (!AUTOMATION_NAME_CLARIFICATION_PROMPT_PATTERN.test(entry.content)) {
      continue;
    }
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const priorEntry = recentHistory[priorIndex];
      if (priorEntry?.role === 'user' && priorEntry.content.trim()) {
        return {
          originalUserRequest: priorEntry.content.trim(),
        };
      }
    }
  }
  return null;
}

function readAutomationClarificationAnswerName(content: string | undefined): string | undefined {
  const raw = content?.trim() ?? '';
  if (!raw) {
    return undefined;
  }
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.?!]+$/g, '')
    .trim();
  if (!cleaned) {
    return undefined;
  }
  if (DEICTIC_AUTOMATION_REFERENCE_PATTERN.test(cleaned)) {
    return cleaned;
  }
  if (AUTOMATION_CONTROL_VERB_PATTERN.test(cleaned)) {
    return undefined;
  }
  return cleaned.split(/\s+/).length <= 12 ? cleaned : undefined;
}

export function toIntentGatewayClientMetadata(
  record: IntentGatewayRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return {
    mode: record.mode,
    available: record.available,
    model: record.model,
    latencyMs: record.latencyMs,
    ...(record.promptProfile ? { promptProfile: record.promptProfile } : {}),
    route: record.decision.route,
    confidence: record.decision.confidence,
    operation: record.decision.operation,
    summary: record.decision.summary,
    turnRelation: record.decision.turnRelation,
    resolution: record.decision.resolution,
    missingFields: record.decision.missingFields,
    executionClass: record.decision.executionClass,
    preferredTier: record.decision.preferredTier,
    requiresRepoGrounding: record.decision.requiresRepoGrounding,
    requiresToolSynthesis: record.decision.requiresToolSynthesis,
    ...(typeof record.decision.requireExactFileReferences === 'boolean'
      ? { requireExactFileReferences: record.decision.requireExactFileReferences }
      : {}),
    expectedContextPressure: record.decision.expectedContextPressure,
    ...(record.decision.simpleVsComplex ? { simpleVsComplex: record.decision.simpleVsComplex } : {}),
    preferredAnswerPath: record.decision.preferredAnswerPath,
    ...(record.decision.plannedSteps?.length
      ? { plannedSteps: cloneIntentGatewayPlannedSteps(record.decision.plannedSteps) }
      : {}),
    ...(record.decision.provenance ? { provenance: record.decision.provenance } : {}),
    ...(record.decision.resolvedContent ? { resolvedContent: record.decision.resolvedContent } : {}),
    entities: record.decision.entities,
  };
}

export function serializeIntentGatewayRecord(
  record: IntentGatewayRecord,
): Record<string, unknown> {
  return {
    mode: record.mode,
    available: record.available,
    model: record.model,
    latencyMs: record.latencyMs,
    ...(record.promptProfile ? { promptProfile: record.promptProfile } : {}),
    ...(record.rawResponsePreview ? { rawResponsePreview: record.rawResponsePreview } : {}),
    decision: {
      route: record.decision.route,
      confidence: record.decision.confidence,
      operation: record.decision.operation,
      summary: record.decision.summary,
      ...(record.decision.recoveryReason ? { recoveryReason: record.decision.recoveryReason } : {}),
      turnRelation: record.decision.turnRelation,
      resolution: record.decision.resolution,
      missingFields: [...record.decision.missingFields],
      executionClass: record.decision.executionClass,
      preferredTier: record.decision.preferredTier,
      requiresRepoGrounding: record.decision.requiresRepoGrounding,
      requiresToolSynthesis: record.decision.requiresToolSynthesis,
      ...(typeof record.decision.requireExactFileReferences === 'boolean'
        ? { requireExactFileReferences: record.decision.requireExactFileReferences }
        : {}),
      expectedContextPressure: record.decision.expectedContextPressure,
      ...(record.decision.simpleVsComplex ? { simpleVsComplex: record.decision.simpleVsComplex } : {}),
      preferredAnswerPath: record.decision.preferredAnswerPath,
      ...(record.decision.plannedSteps?.length
        ? { plannedSteps: cloneIntentGatewayPlannedSteps(record.decision.plannedSteps) }
        : {}),
      ...(record.decision.provenance ? { provenance: record.decision.provenance } : {}),
      ...(record.decision.resolvedContent ? { resolvedContent: record.decision.resolvedContent } : {}),
      ...record.decision.entities,
    },
  };
}

export function deserializeIntentGatewayRecord(
  value: unknown,
): IntentGatewayRecord | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.decision)) return null;
  const mode = value.mode === 'json_fallback' || value.mode === 'route_only_fallback'
    || value.mode === 'confirmation'
    ? value.mode
    : 'primary';
  const normalizedDecision = normalizeIntentGatewayDecision(
    value.decision,
    undefined,
    { classifierSource: classifierProvenanceSourceForMode(mode) },
  );
  const normalizedProvenance = normalizeIntentGatewayDecisionProvenance(
    (value.decision as Record<string, unknown>).provenance,
  );
  return {
    mode,
    available: value.available !== false,
    model: typeof value.model === 'string' && value.model.trim()
      ? value.model
      : 'unknown',
    latencyMs: typeof value.latencyMs === 'number' && Number.isFinite(value.latencyMs)
      ? value.latencyMs
      : 0,
    ...(normalizeIntentGatewayPromptProfile(value.promptProfile)
      ? { promptProfile: normalizeIntentGatewayPromptProfile(value.promptProfile) }
      : {}),
    ...(typeof value.rawResponsePreview === 'string' && value.rawResponsePreview.trim()
      ? { rawResponsePreview: value.rawResponsePreview }
      : {}),
    decision: {
      ...normalizedDecision,
      ...(normalizedProvenance
        ? { provenance: normalizedProvenance }
        : {}),
    },
  };
}

export function attachPreRoutedIntentGatewayMetadata(
  metadata: Record<string, unknown> | undefined,
  record: IntentGatewayRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) return metadata;
  return {
    ...(metadata ?? {}),
    [PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY]: serializeIntentGatewayRecord(record),
  };
}

export function readPreRoutedIntentGatewayMetadata(
  metadata: Record<string, unknown> | undefined,
): IntentGatewayRecord | null {
  if (!metadata) return null;
  return deserializeIntentGatewayRecord(metadata[PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY]);
}

export function detachPreRoutedIntentGatewayMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !(PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY in metadata)) {
    return metadata;
  }
  const { [PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY]: _discarded, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function shouldReusePreRoutedIntentGateway(
  record: IntentGatewayRecord | null | undefined,
): record is IntentGatewayRecord {
  // Preserve any structured gateway decision, including degraded fallback records.
  // Downstream routing layers decide whether a low-confidence route is actionable.
  return !!record;
}

export function shouldReusePreRoutedIntentGatewayForContent(
  record: IntentGatewayRecord | null | undefined,
  originalContent: string | undefined,
  effectiveRoutingContent: string | undefined,
): record is IntentGatewayRecord {
  if (!shouldReusePreRoutedIntentGateway(record)) {
    return false;
  }
  return (originalContent?.trim() ?? '') === (effectiveRoutingContent?.trim() ?? '');
}

export function enrichIntentGatewayRecordWithContentPlan(
  record: IntentGatewayRecord | null | undefined,
  sourceContent: string | undefined,
): IntentGatewayRecord | null {
  if (!record) return null;
  const trimmedSource = sourceContent?.trim();
  if (!trimmedSource) return record;
  if (hasRequiredWritePlannedStep(record.decision)) return record;
  if (record.decision.plannedSteps?.length) return record;

  const normalized = normalizeIntentGatewayDecision(
    {
      ...record.decision,
      ...record.decision.entities,
      ...(record.decision.plannedSteps?.length
        ? { plannedSteps: cloneIntentGatewayPlannedSteps(record.decision.plannedSteps) }
        : {}),
    } as Record<string, unknown>,
    { sourceContent: trimmedSource },
    { classifierSource: classifierProvenanceSourceForMode(record.mode) },
  );
  if (!hasRequiredWritePlannedStep(normalized) || !normalized.plannedSteps?.length) {
    return record;
  }

  return {
    ...record,
    decision: {
      ...record.decision,
      plannedSteps: cloneIntentGatewayPlannedSteps(normalized.plannedSteps),
      ...(typeof record.decision.requireExactFileReferences === 'boolean'
        ? {}
        : typeof normalized.requireExactFileReferences === 'boolean'
          ? { requireExactFileReferences: normalized.requireExactFileReferences }
          : {}),
      provenance: {
        ...(record.decision.provenance ?? {}),
        ...(typeof record.decision.requireExactFileReferences === 'boolean'
          ? {}
          : normalized.provenance?.requireExactFileReferences
            ? { requireExactFileReferences: normalized.provenance.requireExactFileReferences }
            : {}),
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneIntentGatewayPlannedSteps(
  steps: NonNullable<IntentGatewayDecision['plannedSteps']>,
): NonNullable<IntentGatewayDecision['plannedSteps']> {
  return steps.map((step) => ({
    kind: step.kind,
    summary: step.summary,
    ...(step.expectedToolCategories?.length
      ? { expectedToolCategories: [...step.expectedToolCategories] }
      : {}),
    ...(typeof step.required === 'boolean' ? { required: step.required } : {}),
    ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
  }));
}

function buildAutomationNameRepairMessages(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
): ChatMessage[] {
  const channelLabel = input.channel?.trim() || 'unknown';
  const historySection = Array.isArray(input.recentHistory) && input.recentHistory.length > 0
    ? input.recentHistory
      .slice(-6)
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n')
    : '';
  return [
    {
      role: 'system',
      content: AUTOMATION_NAME_REPAIR_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `Channel: ${channelLabel}`,
        `Route: ${decision.route}`,
        `Operation: ${decision.operation}`,
        'Extract the saved automation name from this request.',
        '',
        historySection ? `Recent history:\n${historySection}` : '',
        input.content.trim(),
      ].join('\n'),
    },
  ];
}

function parseAutomationNameRepair(response: ChatResponse): string | undefined {
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content);
  if (!parsed) return undefined;
  const automationName = typeof parsed.automationName === 'string' ? parsed.automationName.trim() : '';
  return automationName || undefined;
}

async function repairAutomationName(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
  chat: IntentGatewayChatFn,
): Promise<string | undefined> {
  const explicitName = extractExplicitAutomationName(input.content);
  if (explicitName) {
    return explicitName;
  }
  const followUpHistoryName = readAutomationNameFromRecentHistory(input.recentHistory);
  if (followUpHistoryName) {
    return followUpHistoryName;
  }
  try {
    const response = await chat(buildAutomationNameRepairMessages(input, decision), {
      maxTokens: 80,
      temperature: 0,
      tools: [AUTOMATION_NAME_REPAIR_TOOL],
    });
    return parseAutomationNameRepair(response);
  } catch {
    return undefined;
  }
}

function needsAutomationNameRepair(decision: IntentGatewayDecision): boolean {
  if (decision.entities.automationName?.trim()) return false;
  if (decision.route === 'automation_control' || decision.route === 'automation_output_task') {
    return ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation);
  }
  return decision.route === 'ui_control'
    && decision.entities.uiSurface === 'automations'
    && ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation);
}

function readAutomationNameFromRecentHistory(
  recentHistory: IntentGatewayInput['recentHistory'],
): string | undefined {
  for (let index = (recentHistory?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = recentHistory?.[index];
    if (!entry || entry.role !== 'assistant') continue;
    const quoted = [...entry.content.matchAll(/['"`]([^'"`]+)['"`]/g)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
    if (quoted.length > 0) {
      return quoted[quoted.length - 1];
    }
  }
  return undefined;
}
