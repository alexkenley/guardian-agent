import type { ChatMessage, ChatResponse, ToolDefinition } from '../llm/types.js';
import { deriveIntentRouteClarification } from './intent/intent-route-clarification.js';
import { selectIntentGatewayPromptProfile } from './intent/prompt-profiles.js';
import { normalizeIntentGatewayPromptProfile, normalizeRoute } from './intent/normalization.js';
import {
  classifierProvenanceSourceForMode,
  normalizeIntentGatewayDecisionProvenance,
} from './intent/provenance.js';
import { classifyIntentGatewayPass } from './intent/route-classifier.js';
import {
  extractExplicitAutomationName,
} from './intent/entity-resolvers/automation.js';
import {
  normalizeIntentGatewayDecision,
  parseStructuredContent,
  parseStructuredToolArguments,
} from './intent/structured-recovery.js';
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
    let decision = record.decision;
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
    decision = repairEmailProviderDecisionIfNeeded(input, decision);
    decision = resolveSatisfiedClarificationIfNeeded(input, decision);
    decision = applyIntentRouteClarificationGuard(input, record, decision);
    return {
      ...record,
      decision,
    };
  }
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
      return original;
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
    expectedContextPressure: record.decision.expectedContextPressure,
    ...(record.decision.simpleVsComplex ? { simpleVsComplex: record.decision.simpleVsComplex } : {}),
    preferredAnswerPath: record.decision.preferredAnswerPath,
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
      turnRelation: record.decision.turnRelation,
      resolution: record.decision.resolution,
      missingFields: [...record.decision.missingFields],
      executionClass: record.decision.executionClass,
      preferredTier: record.decision.preferredTier,
      requiresRepoGrounding: record.decision.requiresRepoGrounding,
      requiresToolSynthesis: record.decision.requiresToolSynthesis,
      expectedContextPressure: record.decision.expectedContextPressure,
      ...(record.decision.simpleVsComplex ? { simpleVsComplex: record.decision.simpleVsComplex } : {}),
      preferredAnswerPath: record.decision.preferredAnswerPath,
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

export function shouldReusePreRoutedIntentGateway(
  record: IntentGatewayRecord | null | undefined,
): record is IntentGatewayRecord {
  return !!record && record.available !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
