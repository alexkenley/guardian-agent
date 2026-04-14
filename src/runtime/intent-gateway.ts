import type { ChatMessage, ChatResponse, ToolDefinition } from '../llm/types.js';
import { selectIntentGatewayPromptProfile } from './intent/prompt-profiles.js';
import { normalizeIntentGatewayPromptProfile } from './intent/normalization.js';
import { classifyIntentGatewayPass } from './intent/route-classifier.js';
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
  IntentGatewayEntities,
  IntentGatewayExecutionClass,
  IntentGatewayExpectedContextPressure,
  IntentGatewayInput,
  IntentGatewayOperation,
  IntentGatewayPreferredAnswerPath,
  IntentGatewayPreferredTier,
  IntentGatewayPromptProfile,
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
      return this.repairAutomationNameIfNeeded(input, primary, chat);
    }

    const fallback = await classifyIntentGatewayPass(input, chat, {
      mode: 'json_fallback',
      startedAt,
      promptProfile: primaryPromptProfile,
    });
    if (fallback.available) {
      return this.repairAutomationNameIfNeeded(input, fallback, chat);
    }

    const routeOnly = await classifyIntentGatewayPass(input, chat, {
      mode: 'route_only_fallback',
      startedAt,
      promptProfile: primaryPromptProfile,
    });
    if (routeOnly.available || routeOnly.rawResponsePreview || routeOnly.model !== 'unknown') {
      return this.repairAutomationNameIfNeeded(input, routeOnly, chat);
    }
    if (fallback.rawResponsePreview || fallback.model !== 'unknown') {
      return this.repairAutomationNameIfNeeded(input, fallback, chat);
    }
    return this.repairAutomationNameIfNeeded(input, primary, chat);
  }

  private async repairAutomationNameIfNeeded(
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
          entities: {
            ...decision.entities,
            automationName: repairedName,
          },
        };
      }
    }
    return {
      ...record,
      decision,
    };
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
    preferredAnswerPath: record.decision.preferredAnswerPath,
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
      preferredAnswerPath: record.decision.preferredAnswerPath,
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
  return {
    mode: value.mode === 'json_fallback' || value.mode === 'route_only_fallback'
      ? value.mode
      : 'primary',
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
    decision: normalizeIntentGatewayDecision(value.decision),
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
  const continuitySection = input.continuity
    ? [
        input.continuity.focusSummary ? `Focus summary: ${input.continuity.focusSummary}` : '',
        input.continuity.lastActionableRequest ? `Last actionable request: ${input.continuity.lastActionableRequest}` : '',
      ].filter(Boolean).join('\n')
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
        continuitySection,
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
