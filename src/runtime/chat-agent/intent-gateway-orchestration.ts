import type { AgentContext, AgentResponse, UserMessage } from '../../agent/types.js';
import { isAffirmativeContinuation, stripLeadingContextPrefix } from '../../chat-agent-helpers.js';
import type { ResolvedSkill } from '../../skills/types.js';
import { resolveAffirmativeMemoryContinuationFromHistory } from '../../util/memory-intent.js';
import type { ConversationKey } from '../conversation.js';
import {
  toIntentGatewayClientMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRecord,
} from '../intent-gateway.js';
import {
  isGenericPendingActionContinuationRequest,
  isWorkspaceSwitchPendingActionSatisfied,
} from '../pending-action-resume.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import {
  sanitizePendingActionPrompt,
  type PendingActionBlocker,
  type PendingActionRecord,
} from '../pending-actions.js';
import {
  PENDING_ACTION_SWITCH_CONFIRM_PATTERN,
  PENDING_ACTION_SWITCH_DENY_PATTERN,
  type PendingActionSwitchCandidatePayload,
} from './orchestration-state.js';

const RETRY_AFTER_FAILURE_PATTERN = /\b(?:try|run|do)\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task)|the\s+same\s+thing)\s+again\b|\bretry\b/i;
const PREREQUISITE_RECOVERY_PATTERN = /\b(?:it|that|this|they)(?:['’]s| are| is)?\s+(?:connected|linked|enabled|fixed|working|ready|configured|authenticated|started|restarted|running)\s+now\b|\bi(?:['’]ve| have)\s+(?:connected|linked|enabled|fixed|configured|authenticated|started|restarted)\b/i;
const STATUS_CHECK_FOLLOW_UP_PATTERN = /^(?:did\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task))(?:\s+\w+){0,3}\s+work|what happened(?:\s+(?:with|to|about)\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task)))?)\??$/i;

export interface IntentGatewayClarificationResponseInput {
  gateway: IntentGatewayRecord | null;
  surfaceUserId: string;
  surfaceChannel: string;
  message: UserMessage;
  activeSkills: ResolvedSkill[];
  surfaceId?: string;
}

export interface IntentGatewayClarificationResponseDeps {
  enabledManagedProviders?: ReadonlySet<string>;
  buildImmediateResponseMetadata: (
    activeSkills: ResolvedSkill[],
    userId: string,
    channel: string,
    surfaceId?: string,
    options?: { includePendingAction?: boolean },
  ) => Record<string, unknown> | undefined;
  setClarificationPendingAction: (
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: {
      blockerKind: PendingActionBlocker['kind'];
      field?: string;
      prompt: string;
      originalUserContent: string;
      options?: PendingActionBlocker['options'];
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      resolvedContent?: string;
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
    },
  ) => { collisionPrompt?: string };
  recordIntentRoutingTrace: (
    stage: 'clarification_requested',
    input: { message: UserMessage; details: Record<string, unknown> },
  ) => void;
  toPendingActionEntities: (
    entities?: Record<string, unknown> | IntentGatewayDecision['entities'],
  ) => Record<string, unknown> | undefined;
}

export function buildGatewayClarificationResponse(
  input: IntentGatewayClarificationResponseInput,
  deps: IntentGatewayClarificationResponseDeps,
): AgentResponse | null {
  const decision = input.gateway?.decision;
  if (!decision) return null;

  const missingFields = new Set(decision.missingFields);
  const needsEmailProvider = (decision.route === 'email_task')
    && deps.enabledManagedProviders?.has('gws')
    && deps.enabledManagedProviders.has('m365')
    && !decision.entities.emailProvider
    && (decision.resolution === 'needs_clarification' || missingFields.has('email_provider'));
  if (needsEmailProvider) {
    const prompt = 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?';
    const pendingActionResult = deps.setClarificationPendingAction(
      input.surfaceUserId,
      input.surfaceChannel,
      input.surfaceId,
      {
        blockerKind: 'clarification',
        field: 'email_provider',
        prompt,
        originalUserContent: input.message.content,
        route: decision.route,
        operation: decision.operation,
        summary: decision.summary,
        turnRelation: decision.turnRelation,
        resolution: decision.resolution,
        missingFields: decision.missingFields,
        provenance: decision.provenance,
        entities: deps.toPendingActionEntities(decision.entities),
        options: [
          { value: 'gws', label: 'Gmail / Google Workspace' },
          { value: 'm365', label: 'Outlook / Microsoft 365' },
        ],
      },
    );
    const responseContent = pendingActionResult.collisionPrompt ?? prompt;
    deps.recordIntentRoutingTrace('clarification_requested', {
      message: input.message,
      details: {
        kind: 'email_provider',
        route: decision.route,
        routeSource: decision.provenance?.route,
        operation: decision.operation,
        operationSource: decision.provenance?.operation,
        entitySources: decision.provenance?.entities,
        missingFields: [...missingFields],
        prompt: responseContent,
      },
    });
    return buildClarificationResponseMetadata(input, responseContent, deps);
  }

  if (decision.resolution === 'needs_clarification' && missingFields.has('coding_backend')) {
    const prompt = 'Which coding backend do you want me to use: Codex, Claude Code, Gemini CLI, or Aider?';
    const pendingActionResult = deps.setClarificationPendingAction(
      input.surfaceUserId,
      input.surfaceChannel,
      input.surfaceId,
      {
        blockerKind: 'clarification',
        field: 'coding_backend',
        prompt,
        originalUserContent: input.message.content,
        route: decision.route,
        operation: decision.operation,
        summary: decision.summary,
        turnRelation: decision.turnRelation,
        resolution: decision.resolution,
        missingFields: decision.missingFields,
        provenance: decision.provenance,
        entities: deps.toPendingActionEntities(decision.entities),
        options: [
          { value: 'codex', label: 'Codex' },
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'gemini-cli', label: 'Gemini CLI' },
          { value: 'aider', label: 'Aider' },
        ],
      },
    );
    const responseContent = pendingActionResult.collisionPrompt ?? prompt;
    deps.recordIntentRoutingTrace('clarification_requested', {
      message: input.message,
      details: {
        kind: 'coding_backend',
        route: decision.route,
        routeSource: decision.provenance?.route,
        operation: decision.operation,
        operationSource: decision.provenance?.operation,
        entitySources: decision.provenance?.entities,
        missingFields: [...missingFields],
        prompt: responseContent,
      },
    });
    return buildClarificationResponseMetadata(input, responseContent, deps);
  }

  if (decision.resolution === 'needs_clarification') {
    const prompt = sanitizePendingActionPrompt(decision.summary, 'clarification');
    const pendingActionResult = deps.setClarificationPendingAction(
      input.surfaceUserId,
      input.surfaceChannel,
      input.surfaceId,
      {
        blockerKind: 'clarification',
        prompt,
        originalUserContent: input.message.content,
        route: decision.route,
        operation: decision.operation,
        summary: decision.summary,
        turnRelation: decision.turnRelation,
        resolution: decision.resolution,
        missingFields: decision.missingFields,
        provenance: decision.provenance,
        entities: deps.toPendingActionEntities(decision.entities),
      },
    );
    const responseContent = pendingActionResult.collisionPrompt ?? prompt;
    deps.recordIntentRoutingTrace('clarification_requested', {
      message: input.message,
      details: {
        kind: 'generic',
        route: decision.route,
        routeSource: decision.provenance?.route,
        operation: decision.operation,
        operationSource: decision.provenance?.operation,
        entitySources: decision.provenance?.entities,
        missingFields: [...missingFields],
        prompt: responseContent,
      },
    });
    return buildClarificationResponseMetadata(input, responseContent, deps);
  }

  return null;
}

function buildClarificationResponseMetadata(
  input: IntentGatewayClarificationResponseInput,
  content: string,
  deps: IntentGatewayClarificationResponseDeps,
): AgentResponse {
  return {
    content,
    metadata: {
      ...(deps.buildImmediateResponseMetadata(
        input.activeSkills,
        input.surfaceUserId,
        input.surfaceChannel,
        input.surfaceId,
        { includePendingAction: true },
      ) ?? {}),
      ...(toIntentGatewayClientMetadata(input.gateway)
        ? { intentGateway: toIntentGatewayClientMetadata(input.gateway) }
        : {}),
    },
  };
}

export function resolveIntentGatewayContent(input: {
  gateway: IntentGatewayRecord | null;
  currentContent: string;
  pendingAction: PendingActionRecord | null;
  priorHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}): string | null {
  const decision = input.gateway?.decision;
  if (!decision) return null;
  const memoryContinuation = resolveAffirmativeMemoryContinuationFromHistory(
    stripLeadingContextPrefix(input.currentContent),
    input.priorHistory,
  );
  if (memoryContinuation) {
    return memoryContinuation;
  }
  if (decision.resolvedContent?.trim()) {
    return decision.resolvedContent.trim();
  }

  if (input.pendingAction?.blocker.kind === 'clarification'
    && input.pendingAction.blocker.field === 'email_provider'
    && decision.entities.emailProvider) {
    const providerLabel = decision.entities.emailProvider === 'm365'
      ? 'Outlook / Microsoft 365'
      : 'Gmail / Google Workspace';
    return `Use ${providerLabel} for this request: ${input.pendingAction.intent.originalUserContent}`;
  }

  if (input.pendingAction?.blocker.kind === 'workspace_switch'
    && decision.route === 'coding_task'
    && decision.turnRelation !== 'new_request') {
    return input.pendingAction.intent.originalUserContent;
  }

  if (input.pendingAction?.blocker.kind === 'clarification'
    && input.pendingAction.blocker.field === 'coding_backend'
    && decision.entities.codingBackend) {
    return `Use ${decision.entities.codingBackend} for this request: ${input.pendingAction.intent.originalUserContent}`;
  }

  if (input.pendingAction?.blocker.kind === 'clarification'
    && input.pendingAction.blocker.field === 'automation_name'
    && decision.entities.automationName
    && decision.turnRelation !== 'new_request') {
    return input.pendingAction.intent.originalUserContent;
  }

  if (decision.turnRelation === 'correction' && decision.entities.codingBackend) {
    const priorRequest = findLatestActionableUserRequest(input.priorHistory);
    if (priorRequest) {
      if (priorRequest.toLowerCase().includes(decision.entities.codingBackend.toLowerCase())) {
        return priorRequest;
      }
      return `Use ${decision.entities.codingBackend} for this request: ${priorRequest}`;
    }
  }

  return null;
}

export function resolvePendingActionContinuationContent(
  content: string,
  pendingAction: PendingActionRecord | null,
  currentCodeSessionId?: string,
): string | null {
  if (!pendingAction) return null;
  const normalized = stripLeadingContextPrefix(content);
  const genericContinuation = isGenericPendingActionContinuationRequest(normalized);
  const affirmativeContinuation = isAffirmativeContinuation(normalized);
  if (!genericContinuation && !affirmativeContinuation) {
    return null;
  }
  if (pendingAction.blocker.kind === 'clarification' && pendingAction.intent.resolvedContent?.trim()) {
    return pendingAction.intent.resolvedContent.trim();
  }
  if (isWorkspaceSwitchPendingActionSatisfied(pendingAction, currentCodeSessionId)) {
    return pendingAction.intent.originalUserContent;
  }
  return null;
}

export function resolveRetryAfterFailureContinuationContent(input: {
  content: string;
  continuityThread: ContinuityThreadRecord | null | undefined;
  conversationKey: ConversationKey;
  readLatestAssistantOutput: (conversationKey: ConversationKey) => string;
}): string | null {
  const normalized = stripLeadingContextPrefix(input.content).trim();
  if (!isRetryAfterFailureRequest(normalized)) {
    return null;
  }
  const lastActionableRequest = input.continuityThread?.lastActionableRequest?.trim();
  if (!lastActionableRequest) {
    return null;
  }
  const latestAssistantOutput = input.readLatestAssistantOutput(input.conversationKey).trim();
  if (!isRetryableProviderFailureMessage(latestAssistantOutput)) {
    return null;
  }
  return lastActionableRequest;
}

export async function tryHandleWorkspaceSwitchContinuation(input: {
  message: UserMessage;
  ctx: AgentContext;
  pendingAction: PendingActionRecord | null;
  handleCodeSessionAttach: (
    message: UserMessage,
    ctx: AgentContext,
    targetSessionId: string,
  ) => Promise<{ content: string; metadata?: Record<string, unknown> } | null>;
}): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  const pendingAction = input.pendingAction;
  if (!pendingAction || pendingAction.blocker.kind !== 'workspace_switch') {
    return null;
  }
  const targetSessionId = pendingAction.blocker.targetSessionId?.trim();
  if (!targetSessionId) {
    return null;
  }
  const normalized = stripLeadingContextPrefix(input.message.content).trim();
  if (!normalized) {
    return null;
  }
  if (!isAffirmativeContinuation(normalized)
    && !isGenericPendingActionContinuationRequest(normalized)) {
    return null;
  }
  return input.handleCodeSessionAttach(input.message, input.ctx, targetSessionId);
}

export async function tryHandlePendingActionSwitchDecision(input: {
  message: UserMessage;
  pendingAction: PendingActionRecord | null;
  gateway: IntentGatewayRecord | null;
  activeSkills: ResolvedSkill[];
  surfaceUserId: string;
  surfaceChannel: string;
  surfaceId?: string;
  readPendingActionSwitchCandidatePayload: (
    pendingAction: PendingActionRecord | null | undefined,
  ) => PendingActionSwitchCandidatePayload | null;
  replacePendingAction: (
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    replacement: Omit<PendingActionRecord, 'createdAt' | 'updatedAt' | 'scope'>,
  ) => PendingActionRecord | null;
  updatePendingAction: (
    actionId: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>>,
  ) => PendingActionRecord | null;
  buildImmediateResponseMetadata: (
    activeSkills: ResolvedSkill[],
    userId: string,
    channel: string,
    surfaceId?: string,
    options?: { includePendingAction?: boolean },
  ) => Record<string, unknown> | undefined;
}): Promise<AgentResponse | null> {
  const switchCandidate = input.readPendingActionSwitchCandidatePayload(input.pendingAction);
  if (!input.pendingAction || !switchCandidate) return null;
  const trimmed = stripLeadingContextPrefix(input.message.content).trim();
  if (!trimmed) return null;

  if (PENDING_ACTION_SWITCH_CONFIRM_PATTERN.test(trimmed)) {
    const replacement = input.replacePendingAction(
      input.surfaceUserId,
      input.surfaceChannel,
      input.surfaceId,
      {
        id: input.pendingAction.id,
        ...switchCandidate.replacement,
      },
    );
    return {
      content: replacement
        ? `Switched the active blocked request.\n\n${sanitizePendingActionPrompt(
            replacement.blocker.prompt,
            replacement.blocker.kind,
          )}`
        : 'I could not switch the active blocked request.',
      metadata: {
        ...(input.buildImmediateResponseMetadata(
          input.activeSkills,
          input.surfaceUserId,
          input.surfaceChannel,
          input.surfaceId,
          { includePendingAction: true },
        ) ?? {}),
        ...(toIntentGatewayClientMetadata(input.gateway)
          ? { intentGateway: toIntentGatewayClientMetadata(input.gateway) }
          : {}),
      },
    };
  }

  if (PENDING_ACTION_SWITCH_DENY_PATTERN.test(trimmed)) {
    const restored = input.updatePendingAction(input.pendingAction.id, {
      resume: switchCandidate.previousResume ?? undefined,
    });
    return {
      content: restored
        ? `Kept the current blocked request active.\n\n${sanitizePendingActionPrompt(
            restored.blocker.prompt,
            restored.blocker.kind,
          )}`
        : 'Kept the current blocked request active.',
      metadata: {
        ...(input.buildImmediateResponseMetadata(
          input.activeSkills,
          input.surfaceUserId,
          input.surfaceChannel,
          input.surfaceId,
          { includePendingAction: true },
        ) ?? {}),
        ...(toIntentGatewayClientMetadata(input.gateway)
          ? { intentGateway: toIntentGatewayClientMetadata(input.gateway) }
          : {}),
      },
    };
  }

  return null;
}

export function shouldClearPendingActionAfterTurn(
  decision: IntentGatewayDecision | undefined,
  pendingAction: PendingActionRecord | null,
): boolean {
  if (!decision || !pendingAction || decision.resolution !== 'ready') return false;
  if (pendingAction.blocker.kind === 'approval') return false;
  if (pendingAction.blocker.kind === 'workspace_switch') return false;
  if (decision.turnRelation === 'new_request') return false;
  if (pendingAction.intent.route && decision.route !== pendingAction.intent.route) return false;
  if (pendingAction.blocker.field === 'email_provider') {
    return Boolean(decision.entities.emailProvider);
  }
  if (pendingAction.blocker.field === 'coding_backend') {
    return Boolean(decision.entities.codingBackend);
  }
  return true;
}

export function toPendingActionEntities(
  entities?: Record<string, unknown> | IntentGatewayDecision['entities'],
): Record<string, unknown> | undefined {
  if (!entities) return undefined;
  const normalized = Object.entries(entities).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (value === undefined) return acc;
    acc[key] = Array.isArray(value) ? [...value] : value;
    return acc;
  }, {});
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function findLatestActionableUserRequest(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.role !== 'user') continue;
    const text = entry.content.trim();
    if (!text || text.length < 16) continue;
    if (/^(?:no|yes|yeah|yep|gmail|outlook|codex|claude code|gemini|aider)\b/i.test(text)) {
      continue;
    }
    if (isStatusCheckFollowUp(text)) {
      continue;
    }
    return text;
  }
  return null;
}

function isRetryAfterFailureRequest(content: string): boolean {
  const normalized = content.trim();
  return RETRY_AFTER_FAILURE_PATTERN.test(normalized)
    || PREREQUISITE_RECOVERY_PATTERN.test(normalized);
}

function isRetryableProviderFailureMessage(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return /^Could not reach Ollama(?: Cloud)?\b/i.test(normalized)
    || /\brate limit exceeded or quota depleted\. Please try again shortly\./i.test(normalized)
    || /\b(?:internal server error|service(?: temporarily)? unavailable|gateway timeout|bad gateway)\b/i.test(normalized)
    || /\bollama cloud api error\b/i.test(normalized)
    || /\bnot authenticated\b/i.test(normalized)
    || /\bplease connect your\b/i.test(normalized)
    || /\b(?:integration|provider).*\b(?:isn['’]?t|is not)\b.*\bconnected\b/i.test(normalized)
    || /\b(?:isn['’]?t|is not)\s+currently connected\b/i.test(normalized)
    || /\baccess denied\b/i.test(normalized)
    || /\bdisconnected\b/i.test(normalized)
    || /\bmodel not found\b/i.test(normalized)
    || /\bmodel\b.+\bnot available\b/i.test(normalized)
    || /\bremote execution failed\b/i.test(normalized)
    || /\bsandbox is currently stopped\b/i.test(normalized)
    || /\bcannot accept commands until restarted\b/i.test(normalized)
    || /\breturned a 502 error\b/i.test(normalized);
}

function isStatusCheckFollowUp(content: string): boolean {
  return STATUS_CHECK_FOLLOW_UP_PATTERN.test(content.trim());
}
