import { isRecord } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import {
  type ContinuityThreadExecutionRef,
  type ContinuityThreadContinuationState,
  type ContinuityThreadRecord,
  type ContinuityThreadScope,
  ContinuityThreadStore,
} from '../continuity-threads.js';
import type { ExecutionIdentityMetadata } from '../execution-identity.js';
import {
  ExecutionStore,
  resolveExecutionIntentContent,
  type ExecutionIntent,
  type ExecutionRecord,
  type ExecutionScope,
} from '../executions.js';
import {
  buildGraphPendingActionReplacement,
} from '../execution-graph/pending-action-adapter.js';
import type { ExecutionArtifactRef } from '../execution-graph/types.js';
import type { ExecutionGraphEvent } from '../execution-graph/graph-events.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import {
  defaultPendingActionTransferPolicy,
  isPendingActionActive,
  sanitizePendingActionPrompt,
  type PendingActionApprovalSummary,
  type PendingActionBlocker,
  type PendingActionIntent,
  type PendingActionRecord,
  type PendingActionScope,
  PendingActionStore,
  reconcilePendingApprovalAction,
  type PendingActionTransferPolicy,
  toPendingActionClientMetadata,
} from '../pending-actions.js';
import { normalizeUserFacingIntentGatewaySummary } from '../intent/summary.js';
import { formatPendingApprovalMessage } from '../pending-approval-copy.js';
import { resolveConversationSurfaceId } from '../channel-surface-ids.js';

export const PENDING_APPROVAL_TTL_MS = 30 * 60_000;

export const PENDING_ACTION_SWITCH_CONFIRM_PATTERN = /^(?:yes|yep|yeah|y|ok|okay|sure|switch|replace|switch it|switch to (?:that|the new one|the new request)|replace it|do that instead)\b/i;
export const PENDING_ACTION_SWITCH_DENY_PATTERN = /^(?:no|nope|nah|keep|keep current|keep the current one|keep the existing one|stay on current|don'?t switch)\b/i;
const CONTINUITY_STATUS_CHECK_PATTERN = /^(?:did\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task))(?:\s+\w+){0,3}\s+work|what happened(?:\s+(?:with|to|about)\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task)))?)\??$/i;

export const PENDING_ACTION_SWITCH_CANDIDATE_TYPE = 'pending_action_switch_candidate';
export const PENDING_ACTION_SWITCH_CANDIDATE_METADATA_KEY = 'pendingActionSwitchCandidate';

export interface PendingApprovalState {
  ids: string[];
  createdAt: number;
  expiresAt: number;
}

export interface PendingActionSetResult {
  action: PendingActionRecord | null;
  collisionPrompt?: string;
}

export interface PendingActionReplacementInput {
  status: PendingActionRecord['status'];
  transferPolicy: PendingActionRecord['transferPolicy'];
  blocker: PendingActionRecord['blocker'];
  intent: PendingActionRecord['intent'];
  resume?: PendingActionRecord['resume'];
  executionId?: PendingActionRecord['executionId'];
  rootExecutionId?: PendingActionRecord['rootExecutionId'];
  codeSessionId?: PendingActionRecord['codeSessionId'];
  expiresAt: number;
}

export interface PendingActionSwitchCandidatePayload {
  type: typeof PENDING_ACTION_SWITCH_CANDIDATE_TYPE;
  previousResume?: PendingActionRecord['resume'];
  replacement: PendingActionReplacementInput;
}

export function clearPendingActionSwitchCandidateFromBlocker(
  blocker: PendingActionBlocker,
): PendingActionBlocker {
  const { metadata, ...rest } = blocker;
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, PENDING_ACTION_SWITCH_CANDIDATE_METADATA_KEY)) {
    return { ...blocker };
  }
  const nextMetadata = { ...metadata };
  delete nextMetadata[PENDING_ACTION_SWITCH_CANDIDATE_METADATA_KEY];
  return Object.keys(nextMetadata).length > 0
    ? { ...rest, metadata: nextMetadata }
    : { ...rest };
}

export interface ChatAgentOrchestrationStateDeps {
  stateAgentId: string;
  pendingActionStore?: PendingActionStore;
  continuityThreadStore?: ContinuityThreadStore;
  executionStore?: ExecutionStore;
  tools?: Pick<ToolExecutor, 'getApprovalSummaries' | 'listApprovals' | 'listPendingApprovalIdsForUser'> | null;
}

function clonePendingActionIntentProvenance(
  provenance: PendingActionRecord['intent']['provenance'],
): PendingActionRecord['intent']['provenance'] {
  if (!provenance) return undefined;
  return {
    ...provenance,
    ...(provenance.entities ? { entities: { ...provenance.entities } } : {}),
  };
}

function cloneContinuityExecutionRef(
  ref: ContinuityThreadExecutionRef,
): ContinuityThreadExecutionRef {
  return {
    kind: ref.kind,
    id: ref.id,
    ...(ref.label ? { label: ref.label } : {}),
  };
}

function mergeContinuityExecutionRefs(
  existing: readonly ContinuityThreadExecutionRef[] | undefined,
  additions: readonly ContinuityThreadExecutionRef[],
): ContinuityThreadExecutionRef[] | undefined {
  const merged = new Map<string, ContinuityThreadExecutionRef>();
  for (const ref of existing ?? []) {
    merged.set(`${ref.kind}:${ref.id}`, cloneContinuityExecutionRef(ref));
  }
  for (const ref of additions) {
    merged.set(`${ref.kind}:${ref.id}`, cloneContinuityExecutionRef(ref));
  }
  const values = [...merged.values()];
  return values.length > 0 ? values : undefined;
}

function replaceContinuityExecutionRefsByKind(
  existing: readonly ContinuityThreadExecutionRef[] | undefined,
  kindsToReplace: ReadonlySet<ContinuityThreadExecutionRef['kind']>,
  additions: readonly ContinuityThreadExecutionRef[],
): ContinuityThreadExecutionRef[] | undefined {
  const retained = (existing ?? [])
    .filter((ref) => !kindsToReplace.has(ref.kind))
    .map(cloneContinuityExecutionRef);
  return mergeContinuityExecutionRefs(retained, additions);
}

function buildExecutionRefLabel(record: ExecutionRecord | null | undefined): string | undefined {
  const summary = normalizeUserFacingIntentGatewaySummary(record?.intent.summary);
  if (summary) return summary;
  const content = resolveExecutionIntentContent(record);
  if (!content) return undefined;
  return content.length > 120
    ? `${content.slice(0, 117).trimEnd()}...`
    : content;
}

function resolveSurfaceId(channel: string | undefined, surfaceId: string | undefined, userId: string): string {
  return resolveConversationSurfaceId({
    channel,
    surfaceId,
    userId,
  });
}

function samePendingActionScope(left: PendingActionScope, right: PendingActionScope): boolean {
  return left.agentId === right.agentId
    && left.userId === right.userId
    && left.channel === right.channel
    && left.surfaceId === right.surfaceId;
}

function isResumableExecution(record: ExecutionRecord | null | undefined): boolean {
  return record?.status === 'running'
    || record?.status === 'blocked'
    || record?.status === 'failed';
}

function buildExecutionContinuationRef(
  record: ExecutionRecord | null | undefined,
): ContinuityThreadExecutionRef | null {
  if (!record) return null;
  const label = buildExecutionRefLabel(record);
  return {
    kind: 'execution',
    id: record.executionId,
    ...(label ? { label } : {}),
  };
}

function cloneExecutionIntent(intent: ExecutionIntent): ExecutionIntent {
  return {
    ...intent,
    ...(intent.missingFields ? { missingFields: [...intent.missingFields] } : {}),
    ...(intent.provenance
      ? {
          provenance: {
            ...intent.provenance,
            ...(intent.provenance.entities ? { entities: { ...intent.provenance.entities } } : {}),
          },
        }
      : {}),
    ...(intent.entities ? { entities: { ...intent.entities } } : {}),
  };
}

export class ChatAgentOrchestrationState {
  private readonly stateAgentId: string;
  private pendingActionStore?: PendingActionStore;
  private continuityThreadStore?: ContinuityThreadStore;
  private executionStore?: ExecutionStore;
  private readonly tools?: Pick<ToolExecutor, 'getApprovalSummaries' | 'listApprovals' | 'listPendingApprovalIdsForUser'> | null;

  constructor(deps: ChatAgentOrchestrationStateDeps) {
    this.stateAgentId = deps.stateAgentId;
    this.pendingActionStore = deps.pendingActionStore;
    this.continuityThreadStore = deps.continuityThreadStore;
    this.executionStore = deps.executionStore;
    this.tools = deps.tools;
  }

  getPendingActionStore(): PendingActionStore | undefined {
    return this.pendingActionStore;
  }

  setPendingActionStore(store: PendingActionStore | undefined): void {
    this.pendingActionStore = store;
  }

  getContinuityThreadStore(): ContinuityThreadStore | undefined {
    return this.continuityThreadStore;
  }

  setContinuityThreadStore(store: ContinuityThreadStore | undefined): void {
    this.continuityThreadStore = store;
  }

  getExecutionStore(): ExecutionStore | undefined {
    return this.executionStore;
  }

  setExecutionStore(store: ExecutionStore | undefined): void {
    this.executionStore = store;
  }

  private buildPendingActionScope(userId: string, channel: string, surfaceId?: string): PendingActionScope {
    return {
      agentId: this.stateAgentId,
      userId,
      channel,
      surfaceId: resolveSurfaceId(channel, surfaceId, userId),
    };
  }

  private buildContinuityThreadScope(userId: string): ContinuityThreadScope {
    return {
      assistantId: this.stateAgentId,
      userId: userId.trim(),
    };
  }

  private buildExecutionScope(
    userId: string,
    channel: string,
    surfaceId?: string,
    codeSessionId?: string,
    continuityKey?: string,
  ): ExecutionScope {
    return {
      assistantId: this.stateAgentId,
      userId: userId.trim(),
      channel: channel.trim(),
      surfaceId: resolveSurfaceId(channel, surfaceId, userId),
      ...(codeSessionId?.trim() ? { codeSessionId: codeSessionId.trim() } : {}),
      ...(continuityKey?.trim() ? { continuityKey: continuityKey.trim() } : {}),
    };
  }

  private listAllPendingApprovalIds(limit = 200): string[] | undefined {
    if (!this.tools?.listApprovals) {
      return undefined;
    }
    return this.tools.listApprovals(limit, 'pending').map((approval) => approval.id);
  }

  private hasPendingApprovalIdsAnywhere(ids: readonly string[]): boolean {
    const normalizedIds = ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (normalizedIds.length === 0) {
      return false;
    }
    const allPendingApprovalIds = this.listAllPendingApprovalIds();
    if (!allPendingApprovalIds) {
      return false;
    }
    const allPendingApprovalSet = new Set(allPendingApprovalIds);
    return normalizedIds.some((id) => allPendingApprovalSet.has(id));
  }

  getContinuityThread(
    userId: string,
    nowMs: number = Date.now(),
  ): ContinuityThreadRecord | null {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return null;
    return this.continuityThreadStore?.get(this.buildContinuityThreadScope(normalizedUserId), nowMs) ?? null;
  }

  private findActiveExecutionRef(
    continuityThread: ContinuityThreadRecord | null | undefined,
  ): ContinuityThreadExecutionRef | null {
    const executionRef = continuityThread?.activeExecutionRefs?.find((ref) => ref.kind === 'execution') ?? null;
    return executionRef ? cloneContinuityExecutionRef(executionRef) : null;
  }

  getActiveExecution(input: {
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    pendingAction?: PendingActionRecord | null;
    excludeExecutionId?: string;
  }): ExecutionRecord | null {
    if (!this.executionStore) return null;
    const pendingExecutionId = input.pendingAction?.executionId?.trim();
    if (pendingExecutionId && pendingExecutionId !== input.excludeExecutionId) {
      return this.executionStore.get(pendingExecutionId);
    }
    const continuityExecutionId = this.findActiveExecutionRef(input.continuityThread)?.id;
    if (continuityExecutionId && continuityExecutionId !== input.excludeExecutionId) {
      return this.executionStore.get(continuityExecutionId);
    }
    const latestForScope = this.executionStore.listForScope(
      this.buildExecutionScope(input.userId, input.channel, input.surfaceId),
    ).find((record) =>
      record.executionId !== input.excludeExecutionId
      && isResumableExecution(record));
    if (latestForScope) {
      return latestForScope;
    }
    return this.executionStore.listForAssistantUser(this.stateAgentId, input.userId)
      .find((record) =>
        record.executionId !== input.excludeExecutionId
        && isResumableExecution(record)) ?? null;
  }

  registerExecutionTurn(input: {
    executionIdentity: ExecutionIdentityMetadata;
    requestId: string;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    content: string;
    codeSessionId?: string;
    nowMs?: number;
  }): ExecutionRecord | null {
    if (!this.executionStore) return null;
    const nowMs = input.nowMs ?? Date.now();
    return this.executionStore.begin({
      executionId: input.executionIdentity.executionId,
      requestId: input.requestId,
      parentExecutionId: input.executionIdentity.parentExecutionId,
      rootExecutionId: input.executionIdentity.rootExecutionId,
      scope: this.buildExecutionScope(
        input.userId,
        input.channel,
        input.surfaceId,
        input.codeSessionId,
        input.continuityThread?.continuityKey,
      ),
      originalUserContent: input.content,
      lastUserContent: input.content,
      status: 'running',
    }, nowMs);
  }

  updateExecutionFromIntent(input: {
    executionIdentity: ExecutionIdentityMetadata;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    gateway: IntentGatewayRecord | null;
    routingContent: string;
    codeSessionId?: string;
    nowMs?: number;
  }): ExecutionRecord | null {
    if (!this.executionStore) return null;
    const nowMs = input.nowMs ?? Date.now();
    const existing = this.executionStore.get(input.executionIdentity.executionId);
    const decision = input.gateway?.decision;
    const priorExecutionRef = this.findActiveExecutionRef(input.continuityThread);
    const priorExecution = priorExecutionRef?.id
      ? this.executionStore.get(priorExecutionRef.id)
      : null;
    const isNewRequest = decision?.turnRelation === 'new_request' || !priorExecution;
    const nextRootExecutionId = isNewRequest
      ? input.executionIdentity.executionId
      : (priorExecution?.rootExecutionId ?? priorExecution?.executionId ?? input.executionIdentity.rootExecutionId ?? input.executionIdentity.executionId);
    const nextParentExecutionId = isNewRequest
      ? undefined
      : (priorExecution?.executionId ?? input.executionIdentity.parentExecutionId);
    const retryOfExecutionId = !isNewRequest
      ? (priorExecution?.executionId ?? undefined)
      : undefined;
    const priorExecutionContent = resolveExecutionIntentContent(priorExecution);
    const intent: ExecutionIntent = {
      ...(existing?.intent ? cloneExecutionIntent(existing.intent) : { originalUserContent: input.routingContent }),
      ...(decision?.route ? { route: decision.route } : {}),
      ...(decision?.operation ? { operation: decision.operation } : {}),
      ...(decision?.summary ? { summary: decision.summary } : {}),
      ...(decision?.turnRelation ? { turnRelation: decision.turnRelation } : {}),
      ...(decision?.resolution ? { resolution: decision.resolution } : {}),
      ...(decision?.missingFields?.length ? { missingFields: [...decision.missingFields] } : {}),
      originalUserContent: (!isNewRequest && priorExecutionContent)
        ? priorExecutionContent
        : (existing?.intent.originalUserContent?.trim() || input.routingContent.trim()),
      ...(decision?.resolvedContent?.trim() ? { resolvedContent: decision.resolvedContent.trim() } : {}),
      ...(decision?.provenance ? { provenance: clonePendingActionIntentProvenance(decision.provenance) } : {}),
      ...(decision?.entities ? { entities: { ...decision.entities } as Record<string, unknown> } : {}),
    };
    const nextStatus = decision?.resolution === 'needs_clarification'
      ? 'blocked'
      : (existing?.status === 'completed' || existing?.status === 'cancelled' ? 'running' : existing?.status ?? 'running');
    const updated = this.executionStore.update(input.executionIdentity.executionId, {
      requestId: existing?.requestId ?? input.executionIdentity.executionId,
      parentExecutionId: nextParentExecutionId,
      rootExecutionId: nextRootExecutionId,
      retryOfExecutionId,
      scope: this.buildExecutionScope(
        input.userId,
        input.channel,
        input.surfaceId,
        input.codeSessionId,
        input.continuityThread?.continuityKey,
      ),
      status: nextStatus,
      intent,
      lastUserContent: input.routingContent.trim(),
      completedAt: undefined,
      failedAt: undefined,
    }, nowMs);
    if (updated) return updated;
    const { originalUserContent: _ignoredOriginalUserContent, ...intentPatch } = cloneExecutionIntent(intent);
    return this.executionStore.begin({
      executionId: input.executionIdentity.executionId,
      requestId: input.executionIdentity.executionId,
      parentExecutionId: nextParentExecutionId,
      rootExecutionId: nextRootExecutionId,
      retryOfExecutionId,
      scope: this.buildExecutionScope(
        input.userId,
        input.channel,
        input.surfaceId,
        input.codeSessionId,
        input.continuityThread?.continuityKey,
      ),
      originalUserContent: intent.originalUserContent,
      intent: intentPatch,
      lastUserContent: input.routingContent.trim(),
      status: nextStatus,
    }, nowMs);
  }

  private syncExecutionBlockerFromPendingAction(
    pendingAction: PendingActionRecord | null | undefined,
    nowMs: number = Date.now(),
  ): void {
    if (!this.executionStore || !pendingAction?.executionId?.trim()) {
      return;
    }
    if (isPendingActionActive(pendingAction.status)) {
      this.executionStore.attachBlocker(pendingAction.executionId, {
        pendingActionId: pendingAction.id,
        kind: pendingAction.blocker.kind,
        prompt: sanitizePendingActionPrompt(pendingAction.blocker.prompt, pendingAction.blocker.kind),
        ...(pendingAction.blocker.field ? { field: pendingAction.blocker.field } : {}),
        ...(pendingAction.blocker.provider ? { provider: pendingAction.blocker.provider } : {}),
        ...(pendingAction.blocker.service ? { service: pendingAction.blocker.service } : {}),
        ...(pendingAction.blocker.options?.length ? { options: pendingAction.blocker.options.map((option) => ({ ...option })) } : {}),
        ...(pendingAction.blocker.approvalIds?.length ? { approvalIds: [...pendingAction.blocker.approvalIds] } : {}),
        ...(pendingAction.blocker.approvalSummaries?.length
          ? { approvalSummaries: pendingAction.blocker.approvalSummaries.map((item) => ({ ...item })) }
          : {}),
        ...(pendingAction.blocker.currentSessionId ? { currentSessionId: pendingAction.blocker.currentSessionId } : {}),
        ...(pendingAction.blocker.currentSessionLabel ? { currentSessionLabel: pendingAction.blocker.currentSessionLabel } : {}),
        ...(pendingAction.blocker.targetSessionId ? { targetSessionId: pendingAction.blocker.targetSessionId } : {}),
        ...(pendingAction.blocker.targetSessionLabel ? { targetSessionLabel: pendingAction.blocker.targetSessionLabel } : {}),
        ...(pendingAction.blocker.metadata ? { metadata: { ...pendingAction.blocker.metadata } } : {}),
      }, nowMs);
      return;
    }

    if (pendingAction.status === 'completed') {
      this.executionStore.clearBlocker(pendingAction.executionId, { status: 'running' }, nowMs);
      return;
    }

    if (pendingAction.status === 'failed') {
      this.executionStore.clearBlocker(
        pendingAction.executionId,
        { status: 'failed', failedAt: nowMs },
        nowMs,
      );
      return;
    }

    this.executionStore.clearBlocker(pendingAction.executionId, { status: 'cancelled' }, nowMs);
  }

  private resolvePendingActionExecutionBinding(input: {
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    pendingAction?: PendingActionRecord | null;
  }): { executionId?: string; rootExecutionId?: string } {
    const boundExecution = this.getActiveExecution(input);
    return {
      ...(boundExecution?.executionId ? { executionId: boundExecution.executionId } : {}),
      ...(boundExecution?.rootExecutionId ? { rootExecutionId: boundExecution.rootExecutionId } : {}),
    };
  }

  touchContinuityThread(
    userId: string,
    channel: string,
    surfaceId?: string,
    codeSessionId?: string,
    nowMs: number = Date.now(),
  ): ContinuityThreadRecord | null {
    const normalizedUserId = userId.trim();
    const normalizedChannel = channel.trim();
    if (!normalizedUserId || !normalizedChannel || !this.continuityThreadStore) return null;
    const normalizedSurfaceId = resolveSurfaceId(normalizedChannel, surfaceId, normalizedUserId);
    const existing = this.getContinuityThread(normalizedUserId, nowMs);
    const nextExecutionRefs = codeSessionId?.trim()
      ? replaceContinuityExecutionRefsByKind(
          existing?.activeExecutionRefs,
          new Set<ContinuityThreadExecutionRef['kind']>(['code_session']),
          [{
            kind: 'code_session',
            id: codeSessionId.trim(),
          }],
        )
      : existing?.activeExecutionRefs;
    return this.continuityThreadStore.upsert(
      this.buildContinuityThreadScope(normalizedUserId),
      {
        touchSurface: {
          channel: normalizedChannel,
          surfaceId: normalizedSurfaceId,
        },
        ...(nextExecutionRefs ? { activeExecutionRefs: nextExecutionRefs } : {}),
      },
      nowMs,
    );
  }

  updateContinuityThreadFromIntent(input: {
    executionIdentity: ExecutionIdentityMetadata;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread: ContinuityThreadRecord | null;
    gateway: IntentGatewayRecord | null;
    routingContent: string;
    codeSessionId?: string;
  }): ContinuityThreadRecord | null {
    if (!this.continuityThreadStore) return input.continuityThread;
    const decision = input.gateway?.decision;
    const normalizedUserId = input.userId.trim();
    const normalizedChannel = input.channel.trim();
    if (!normalizedUserId || !normalizedChannel || !decision) {
      return input.continuityThread;
    }
    const routingContent = input.routingContent.trim();
    const resolvedContent = decision.resolvedContent?.trim();
    const candidateLastActionableRequest = decision.turnRelation === 'new_request'
      ? (routingContent || undefined)
      : (resolvedContent || undefined);
    const nextLastActionableRequest = candidateLastActionableRequest
      && !isContinuityStatusCheck(candidateLastActionableRequest)
      ? candidateLastActionableRequest
      : input.continuityThread?.lastActionableRequest;
    const summary = normalizeUserFacingIntentGatewaySummary(decision.summary);
    const existingExecutionRef = this.findActiveExecutionRef(input.continuityThread);
    const currentExecution = this.executionStore?.get(input.executionIdentity.executionId) ?? null;
    const currentExecutionRef = buildExecutionContinuationRef(currentExecution);
    const nextExecutionRef = decision.turnRelation === 'new_request' || !existingExecutionRef
      ? (currentExecutionRef ?? existingExecutionRef)
      : existingExecutionRef;
    const codeSessionRef = input.codeSessionId?.trim()
      ? {
          kind: 'code_session' as const,
          id: input.codeSessionId.trim(),
        }
      : null;
    const nextCodeSessionRefs = codeSessionRef
      ? [codeSessionRef]
      : decision.turnRelation === 'new_request'
        ? []
        : (input.continuityThread?.activeExecutionRefs ?? [])
            .filter((ref) => ref.kind === 'code_session');
    const nextExecutionRefs = replaceContinuityExecutionRefsByKind(
      input.continuityThread?.activeExecutionRefs,
      new Set<ContinuityThreadExecutionRef['kind']>(['execution', 'code_session']),
      [
        ...(nextExecutionRef ? [nextExecutionRef] : []),
        ...nextCodeSessionRefs,
      ],
    );
    return this.continuityThreadStore.upsert(
      this.buildContinuityThreadScope(normalizedUserId),
      {
        touchSurface: {
          channel: normalizedChannel,
          surfaceId: resolveSurfaceId(normalizedChannel, input.surfaceId, normalizedUserId),
        },
        ...(summary ? { focusSummary: summary } : {}),
        ...(nextLastActionableRequest ? { lastActionableRequest: nextLastActionableRequest } : {}),
        ...(summary ? { safeSummary: summary } : {}),
        ...(nextExecutionRefs ? { activeExecutionRefs: nextExecutionRefs } : {}),
      },
    );
  }

  updateDirectContinuationState(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    continuationState: ContinuityThreadContinuationState | null,
  ): ContinuityThreadRecord | null {
    if (!this.continuityThreadStore) return null;
    const normalizedUserId = userId.trim();
    const normalizedChannel = channel.trim();
    if (!normalizedUserId || !normalizedChannel) return null;
    return this.continuityThreadStore.upsert(
      this.buildContinuityThreadScope(normalizedUserId),
      {
        touchSurface: {
          channel: normalizedChannel,
          surfaceId: resolveSurfaceId(normalizedChannel, surfaceId, normalizedUserId),
        },
        continuationState,
      },
    );
  }

  getActivePendingAction(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    const primaryScope = this.buildPendingActionScope(userId, channel, surfaceId);
    const pendingAction = this.pendingActionStore?.resolveActiveForSurface(primaryScope, nowMs) ?? null;
    if (!this.pendingActionStore || !this.tools?.listPendingApprovalIdsForUser) {
      this.syncExecutionBlockerFromPendingAction(pendingAction, nowMs);
      return pendingAction;
    }
    if (!pendingAction) {
      return null;
    }
    if (!isPendingActionActive(pendingAction.status)) {
      this.syncExecutionBlockerFromPendingAction(pendingAction, nowMs);
      return pendingAction;
    }
    const liveApprovalIds = this.tools?.listPendingApprovalIdsForUser?.(userId, channel, {
      includeUnscoped: channel === 'web',
    }) ?? [];
    const approvalSummaries = this.tools?.getApprovalSummaries?.(liveApprovalIds);
    const allPendingApprovalIds = this.listAllPendingApprovalIds();
    const reconciled = reconcilePendingApprovalAction(this.pendingActionStore, pendingAction, {
      liveApprovalIds,
      liveApprovalSummaries: approvalSummaries,
      allPendingApprovalIds,
      scope: primaryScope,
      nowMs,
    });
    const active = reconciled && isPendingActionActive(reconciled.status)
      ? reconciled
      : null;
    this.syncExecutionBlockerFromPendingAction(active ?? reconciled ?? pendingAction, nowMs);
    return active;
  }

  private createPendingActionReplacementInput(
    input: Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'>,
  ): PendingActionReplacementInput {
    return {
      status: input.status,
      transferPolicy: input.transferPolicy,
      blocker: {
        ...input.blocker,
        ...(input.blocker.options ? { options: input.blocker.options.map((option) => ({ ...option })) } : {}),
        ...(input.blocker.approvalIds ? { approvalIds: [...input.blocker.approvalIds] } : {}),
        ...(input.blocker.approvalSummaries ? { approvalSummaries: input.blocker.approvalSummaries.map((item) => ({ ...item })) } : {}),
        ...(input.blocker.metadata ? { metadata: { ...input.blocker.metadata } } : {}),
      },
      intent: {
        ...input.intent,
        ...(input.intent.missingFields ? { missingFields: [...input.intent.missingFields] } : {}),
        ...(input.intent.entities ? { entities: { ...input.intent.entities } } : {}),
      },
      ...(input.resume
        ? {
            resume: {
              kind: input.resume.kind,
              payload: { ...input.resume.payload },
            },
          }
        : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      expiresAt: input.expiresAt,
    };
  }

  private isEquivalentPendingActionReplacement(
    active: PendingActionRecord,
    replacement: PendingActionReplacementInput,
  ): boolean {
    const activeRoute = active.intent.route?.trim() || '';
    const nextRoute = replacement.intent.route?.trim() || '';
    const activeOperation = active.intent.operation?.trim() || '';
    const nextOperation = replacement.intent.operation?.trim() || '';
    const activeOriginal = active.intent.originalUserContent.trim();
    const nextOriginal = replacement.intent.originalUserContent.trim();
    const sameOriginal = activeOriginal === nextOriginal
      || activeOriginal.length === 0
      || nextOriginal.length === 0;
    const sameClarificationSlot = active.blocker.kind === 'clarification'
      && replacement.blocker.kind === 'clarification'
      && (active.blocker.field ?? '') === (replacement.blocker.field ?? '')
      && activeRoute === nextRoute
      && activeOperation === nextOperation;
    return active.blocker.kind === replacement.blocker.kind
      && (active.blocker.field ?? '') === (replacement.blocker.field ?? '')
      && activeRoute === nextRoute
      && activeOperation === nextOperation
      && (sameOriginal || sameClarificationSlot);
  }

  private formatPendingActionSwitchSummary(
    input: PendingActionReplacementInput,
  ): string {
    const route = input.intent.route?.trim() || 'task';
    const operation = input.intent.operation?.trim() || 'continue';
    const original = input.intent.originalUserContent.trim();
    const blockerPrompt = sanitizePendingActionPrompt(input.blocker.prompt, input.blocker.kind);
    const fragments = [
      `${route} · ${operation}`,
      original || blockerPrompt,
    ].filter(Boolean);
    return fragments.join(' — ');
  }

  private formatPendingActionSwitchPrompt(
    active: PendingActionRecord,
    replacement: PendingActionReplacementInput,
  ): string {
    const currentSummary = this.formatPendingActionSwitchSummary(this.createPendingActionReplacementInput(active));
    const nextSummary = this.formatPendingActionSwitchSummary(replacement);
    return [
      'You already have blocked work waiting for input or approval.',
      `Current blocked slot: ${currentSummary}`,
      `New blocked request: ${nextSummary}`,
      'Reply "yes" to switch the active blocked slot, or "no" to keep the current one.',
    ].join('\n');
  }

  private buildPendingActionSwitchCandidatePayload(
    active: PendingActionRecord,
    replacement: PendingActionReplacementInput,
  ): PendingActionSwitchCandidatePayload {
    return {
      type: PENDING_ACTION_SWITCH_CANDIDATE_TYPE,
      replacement,
      ...(active.resume ? { previousResume: { kind: active.resume.kind, payload: { ...active.resume.payload } } } : {}),
    };
  }

  private buildPendingActionBlockerWithSwitchCandidate(
    blocker: PendingActionBlocker,
    candidate: PendingActionSwitchCandidatePayload,
  ): PendingActionBlocker {
    return {
      ...blocker,
      metadata: {
        ...(blocker.metadata ?? {}),
        [PENDING_ACTION_SWITCH_CANDIDATE_METADATA_KEY]: candidate as unknown as Record<string, unknown>,
      },
    };
  }

  private normalizePendingActionReplacementInput(
    value: Record<string, unknown>,
  ): PendingActionReplacementInput | null {
    if (!isRecord(value.blocker) || !isRecord(value.intent)) return null;
    const originalUserContent = typeof value.intent.originalUserContent === 'string'
      ? value.intent.originalUserContent.trim()
      : '';
    const blockerKind = value.blocker.kind === 'approval'
      || value.blocker.kind === 'clarification'
      || value.blocker.kind === 'workspace_switch'
      || value.blocker.kind === 'auth'
      || value.blocker.kind === 'policy'
      || value.blocker.kind === 'missing_context'
      ? value.blocker.kind
      : 'clarification';
    const blockerPrompt = sanitizePendingActionPrompt(
      typeof value.blocker.prompt === 'string' ? value.blocker.prompt : '',
      blockerKind,
    );
    if (!originalUserContent) return null;
    const resume = isRecord(value.resume)
      && typeof value.resume.kind === 'string'
      && isRecord(value.resume.payload)
      ? {
          kind: value.resume.kind as NonNullable<PendingActionRecord['resume']>['kind'],
          payload: { ...value.resume.payload },
        }
      : undefined;

    return {
      status: value.status === 'pending'
        || value.status === 'resolving'
        || value.status === 'running'
        || value.status === 'completed'
        || value.status === 'cancelled'
        || value.status === 'expired'
        || value.status === 'failed'
        ? value.status
        : 'pending',
      transferPolicy: value.transferPolicy === 'origin_surface_only'
        || value.transferPolicy === 'linked_surfaces_same_user'
        || value.transferPolicy === 'explicit_takeover_only'
        ? value.transferPolicy
        : defaultPendingActionTransferPolicy(blockerKind),
      blocker: {
        ...(value.blocker as unknown as PendingActionRecord['blocker']),
        kind: blockerKind,
        prompt: blockerPrompt,
        ...(Array.isArray(value.blocker.options)
          ? { options: value.blocker.options.filter(isRecord).map((option) => ({ ...option })) as unknown as PendingActionBlocker['options'] }
          : {}),
        ...(Array.isArray(value.blocker.approvalIds)
          ? { approvalIds: value.blocker.approvalIds.filter((id): id is string => typeof id === 'string') }
          : {}),
        ...(Array.isArray(value.blocker.approvalSummaries)
          ? { approvalSummaries: value.blocker.approvalSummaries.filter(isRecord).map((item) => ({ ...item })) as unknown as PendingActionApprovalSummary[] }
          : {}),
        ...(isRecord(value.blocker.metadata) ? { metadata: { ...value.blocker.metadata } } : {}),
      },
      intent: {
        ...(value.intent as unknown as PendingActionRecord['intent']),
        originalUserContent,
        ...(Array.isArray(value.intent.missingFields)
          ? { missingFields: value.intent.missingFields.filter((field): field is string => typeof field === 'string') }
          : {}),
        ...(isRecord(value.intent.entities) ? { entities: { ...value.intent.entities } } : {}),
      },
      ...(resume ? { resume } : {}),
      ...(typeof value.executionId === 'string' && value.executionId.trim()
        ? { executionId: value.executionId.trim() }
        : {}),
      ...(typeof value.rootExecutionId === 'string' && value.rootExecutionId.trim()
        ? { rootExecutionId: value.rootExecutionId.trim() }
        : {}),
      ...(typeof value.codeSessionId === 'string' && value.codeSessionId.trim()
        ? { codeSessionId: value.codeSessionId.trim() }
        : {}),
      expiresAt: typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : Date.now() + PENDING_APPROVAL_TTL_MS,
    };
  }

  readPendingActionSwitchCandidatePayload(
    pendingAction: PendingActionRecord | null | undefined,
  ): PendingActionSwitchCandidatePayload | null {
    const payload = pendingAction?.blocker.metadata?.[PENDING_ACTION_SWITCH_CANDIDATE_METADATA_KEY];
    if (!isRecord(payload) || payload.type !== PENDING_ACTION_SWITCH_CANDIDATE_TYPE || !isRecord(payload.replacement)) {
      return null;
    }

    const replacement = this.normalizePendingActionReplacementInput(payload.replacement);
    if (!replacement) return null;
    const previousResume = isRecord(payload.previousResume)
      && typeof payload.previousResume.kind === 'string'
      && isRecord(payload.previousResume.payload)
      ? {
          kind: payload.previousResume.kind as NonNullable<PendingActionRecord['resume']>['kind'],
          payload: { ...payload.previousResume.payload },
        }
      : undefined;
    return {
      type: PENDING_ACTION_SWITCH_CANDIDATE_TYPE,
      replacement,
      ...(previousResume ? { previousResume } : {}),
    };
  }

  private replacePendingActionWithGuard(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'> & { id?: string },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const scope = this.buildPendingActionScope(userId, channel, surfaceId);
    const active = this.getActivePendingAction(userId, channel, surfaceId, nowMs);
    const replacement = this.createPendingActionReplacementInput(input);
    if (
      active
      && !samePendingActionScope(active.scope, scope)
      && input.transferPolicy !== 'linked_surfaces_same_user'
    ) {
      return {
        action: this.replacePendingAction(userId, channel, surfaceId, input, nowMs),
      };
    }
    if (!active || (input.id && active.id === input.id) || this.isEquivalentPendingActionReplacement(active, replacement)) {
      return {
        action: this.replacePendingAction(
          userId,
          channel,
          surfaceId,
          active && !input.id ? { ...input, id: active.id } : input,
          nowMs,
        ),
      };
    }

    const updatedActive = this.updatePendingAction(active.id, {
      blocker: this.buildPendingActionBlockerWithSwitchCandidate(
        active.blocker,
        this.buildPendingActionSwitchCandidatePayload(active, replacement),
      ),
    }, nowMs);
    return {
      action: updatedActive ?? active,
      collisionPrompt: this.formatPendingActionSwitchPrompt(active, replacement),
    };
  }

  replacePendingAction(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'> & { id?: string },
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    if (!this.pendingActionStore) return null;
    const continuityThread = this.getContinuityThread(userId, nowMs);
    const boundExecution = this.resolvePendingActionExecutionBinding({
      userId,
      channel,
      surfaceId,
      continuityThread,
      pendingAction: input.id ? this.pendingActionStore.get(input.id, nowMs) : undefined,
    });
    const next = this.pendingActionStore.replaceActive(
      this.buildPendingActionScope(userId, channel, surfaceId),
      {
        ...input,
        ...(input.executionId ? { executionId: input.executionId } : boundExecution.executionId ? { executionId: boundExecution.executionId } : {}),
        ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : boundExecution.rootExecutionId ? { rootExecutionId: boundExecution.rootExecutionId } : {}),
      },
      nowMs,
    );
    this.syncExecutionBlockerFromPendingAction(next, nowMs);
    return next;
  }

  updatePendingAction(
    actionId: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>>,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    const next = this.pendingActionStore?.update(actionId, patch, nowMs) ?? null;
    this.syncExecutionBlockerFromPendingAction(next, nowMs);
    return next;
  }

  completePendingAction(actionId: string, nowMs: number = Date.now()): void {
    const next = this.pendingActionStore?.complete(actionId, nowMs);
    this.syncExecutionBlockerFromPendingAction(next, nowMs);
  }

  private cancelPendingAction(actionId: string, nowMs: number = Date.now()): void {
    const next = this.pendingActionStore?.cancel(actionId, nowMs);
    this.syncExecutionBlockerFromPendingAction(next, nowMs);
  }

  private clearActivePendingAction(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): void {
    const active = this.getActivePendingAction(userId, channel, surfaceId, nowMs);
    if (active) {
      this.cancelPendingAction(active.id, nowMs);
    }
  }

  parsePendingActionUserKey(userKey: string): { userId: string; channel: string } {
    const trimmed = userKey.trim();
    const splitAt = trimmed.lastIndexOf(':');
    if (splitAt <= 0) {
      return { userId: trimmed, channel: 'web' };
    }
    return {
      userId: trimmed.slice(0, splitAt),
      channel: trimmed.slice(splitAt + 1),
    };
  }

  getPendingApprovals(
    userKey: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): PendingApprovalState | null {
    const { userId, channel } = this.parsePendingActionUserKey(userKey);
    const pending = this.getPendingApprovalAction(userId, channel, surfaceId, nowMs);
    if (!pending?.blocker.approvalIds?.length) return null;
    return {
      ids: [...pending.blocker.approvalIds],
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
    };
  }

  setPendingApprovals(
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): void {
    const { userId, channel } = this.parsePendingActionUserKey(userKey);
    const active = this.getPendingApprovalAction(userId, channel, surfaceId, nowMs);
    const approvalIds = [...new Set(ids.filter((id) => id.trim().length > 0))];
    if (approvalIds.length === 0) {
      if (active?.blocker.kind === 'approval' && this.hasPendingApprovalIdsAnywhere(active.blocker.approvalIds ?? [])) {
        return;
      }
      if (active) this.completePendingAction(active.id, nowMs);
      return;
    }
    const summaries = this.tools?.getApprovalSummaries?.(approvalIds);
    const approvalSummaries = approvalIds.map((id) => {
      const summary = summaries?.get(id);
      return {
        id,
        toolName: summary?.toolName ?? 'unknown',
        argsPreview: summary?.argsPreview ?? '',
        actionLabel: summary?.actionLabel ?? '',
      };
    });
    this.setPendingApprovalAction(
      userId,
      channel,
      surfaceId,
      {
        prompt: (active?.blocker.prompt && !active.blocker.prompt.startsWith('Approval required'))
          ? active.blocker.prompt
          : formatPendingApprovalMessage(approvalSummaries),
        approvalIds,
        approvalSummaries,
        originalUserContent: active?.intent.originalUserContent ?? '',
        route: active?.intent.route,
        operation: active?.intent.operation,
        summary: active?.intent.summary,
        turnRelation: active?.intent.turnRelation,
        resolution: active?.intent.resolution,
        missingFields: active?.intent.missingFields,
        entities: active?.intent.entities,
        resume: active?.resume,
        executionId: active?.executionId,
        rootExecutionId: active?.rootExecutionId,
        codeSessionId: active?.codeSessionId,
      },
      nowMs,
    );
  }

  getPendingApprovalAction(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    const active = this.getActivePendingAction(userId, channel, surfaceId, nowMs);
    if (!active || !isPendingActionActive(active.status) || active.blocker.kind !== 'approval') {
      return null;
    }
    return active;
  }

  getPendingApprovalIds(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): string[] {
    return this.getPendingApprovalAction(userId, channel, surfaceId, nowMs)?.blocker.approvalIds ?? [];
  }

  setPendingApprovalActionForRequest(
    userKey: string,
    surfaceId: string | undefined,
    input: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionApprovalSummary[];
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      executionId?: string;
      rootExecutionId?: string;
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const { userId, channel } = this.parsePendingActionUserKey(userKey);
    return this.setPendingApprovalAction(
      userId,
      channel,
      surfaceId,
      input,
      nowMs,
    );
  }

  setGraphPendingActionInterruptForRequest(
    userKey: string,
    surfaceId: string | undefined,
    input: {
      event: ExecutionGraphEvent;
      originalUserContent: string;
      intent?: Partial<PendingActionIntent>;
      artifactRefs?: ExecutionArtifactRef[];
      approvalSummaries?: PendingActionApprovalSummary[];
      transferPolicy?: PendingActionTransferPolicy;
      expiresAt?: number;
    },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const { userId, channel } = this.parsePendingActionUserKey(userKey);
    const replacement = buildGraphPendingActionReplacement({
      ...input,
      nowMs,
    });
    if (!replacement) return { action: null };
    return this.replacePendingActionWithGuard(
      userId,
      channel,
      surfaceId,
      replacement,
      nowMs,
    );
  }

  buildPendingApprovalBlockedResponse(
    result: PendingActionSetResult,
    fallbackContent: string,
  ): { content: string; metadata?: Record<string, unknown> } {
    return {
      content: result.collisionPrompt ?? fallbackContent,
      metadata: result.action ? { pendingAction: toPendingActionClientMetadata(result.action) } : undefined,
    };
  }

  setPendingApprovalAction(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionApprovalSummary[];
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      executionId?: string;
      rootExecutionId?: string;
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const approvalIds = [...new Set(input.approvalIds.map((id) => id.trim()).filter(Boolean))];
    if (approvalIds.length === 0) {
      this.clearActivePendingAction(userId, channel, surfaceId, nowMs);
      return { action: null };
    }
    return this.replacePendingActionWithGuard(userId, channel, surfaceId, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: input.prompt,
        approvalIds,
        ...(input.approvalSummaries?.length ? { approvalSummaries: input.approvalSummaries.map((item) => ({ ...item })) } : {}),
      },
      intent: {
        ...(input.route ? { route: input.route } : {}),
        ...(input.operation ? { operation: input.operation } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.turnRelation ? { turnRelation: input.turnRelation } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.missingFields?.length ? { missingFields: [...input.missingFields] } : {}),
        originalUserContent: input.originalUserContent,
        ...(input.provenance ? { provenance: clonePendingActionIntentProvenance(input.provenance) } : {}),
        ...(input.entities ? { entities: { ...input.entities } } : {}),
      },
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    }, nowMs);
  }

  setClarificationPendingAction(
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
      codeSessionId?: string;
      currentSessionId?: string;
      currentSessionLabel?: string;
      targetSessionId?: string;
      targetSessionLabel?: string;
      metadata?: Record<string, unknown>;
      transferPolicy?: PendingActionTransferPolicy;
      resume?: PendingActionRecord['resume'];
      executionId?: string;
      rootExecutionId?: string;
    },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const prompt = sanitizePendingActionPrompt(input.prompt, input.blockerKind);
    const summary = normalizeUserFacingIntentGatewaySummary(input.summary);
    return this.replacePendingActionWithGuard(userId, channel, surfaceId, {
      status: 'pending',
      transferPolicy: input.transferPolicy ?? defaultPendingActionTransferPolicy(input.blockerKind),
      blocker: {
        kind: input.blockerKind,
        prompt,
        ...(input.field ? { field: input.field } : {}),
        ...(input.options?.length ? { options: input.options.map((option) => ({ ...option })) } : {}),
        ...(input.currentSessionId ? { currentSessionId: input.currentSessionId } : {}),
        ...(input.currentSessionLabel ? { currentSessionLabel: input.currentSessionLabel } : {}),
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
        ...(input.targetSessionLabel ? { targetSessionLabel: input.targetSessionLabel } : {}),
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      },
      intent: {
        ...(input.route ? { route: input.route } : {}),
        ...(input.operation ? { operation: input.operation } : {}),
        ...(summary ? { summary } : {}),
        ...(input.turnRelation ? { turnRelation: input.turnRelation } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.missingFields?.length ? { missingFields: [...input.missingFields] } : {}),
        originalUserContent: input.originalUserContent,
        ...(input.resolvedContent?.trim() ? { resolvedContent: input.resolvedContent.trim() } : {}),
        ...(input.provenance ? { provenance: clonePendingActionIntentProvenance(input.provenance) } : {}),
        ...(input.entities ? { entities: { ...input.entities } } : {}),
      },
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    }, nowMs);
  }
}

function isContinuityStatusCheck(content: string): boolean {
  return CONTINUITY_STATUS_CHECK_PATTERN.test(content.trim());
}
