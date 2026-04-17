import { isRecord } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import {
  type ContinuityThreadContinuationState,
  type ContinuityThreadRecord,
  type ContinuityThreadScope,
  ContinuityThreadStore,
} from '../continuity-threads.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import {
  defaultPendingActionTransferPolicy,
  isPendingActionActive,
  sanitizePendingActionPrompt,
  type PendingActionApprovalSummary,
  type PendingActionBlocker,
  type PendingActionRecord,
  type PendingActionScope,
  PendingActionStore,
  reconcilePendingApprovalAction,
  toPendingActionClientMetadata,
} from '../pending-actions.js';
import { normalizeUserFacingIntentGatewaySummary } from '../intent/summary.js';
import { formatPendingApprovalMessage } from '../pending-approval-copy.js';

export const PENDING_APPROVAL_TTL_MS = 30 * 60_000;

export const PENDING_ACTION_SWITCH_CONFIRM_PATTERN = /^(?:yes|yep|yeah|y|ok|okay|sure|switch|replace|switch it|switch to (?:that|the new one|the new request)|replace it|do that instead)\b/i;
export const PENDING_ACTION_SWITCH_DENY_PATTERN = /^(?:no|nope|nah|keep|keep current|keep the current one|keep the existing one|stay on current|don'?t switch)\b/i;
const CONTINUITY_STATUS_CHECK_PATTERN = /^(?:did\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task))(?:\s+\w+){0,3}\s+work|what happened(?:\s+(?:with|to|about)\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task)))?)\??$/i;

const PENDING_ACTION_SWITCH_CANDIDATE_TYPE = 'pending_action_switch_candidate';

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
  codeSessionId?: PendingActionRecord['codeSessionId'];
  expiresAt: number;
}

export interface PendingActionSwitchCandidatePayload {
  type: typeof PENDING_ACTION_SWITCH_CANDIDATE_TYPE;
  previousResume?: PendingActionRecord['resume'];
  replacement: PendingActionReplacementInput;
}

export interface ChatAgentOrchestrationStateDeps {
  stateAgentId: string;
  pendingActionStore?: PendingActionStore;
  continuityThreadStore?: ContinuityThreadStore;
  tools?: Pick<ToolExecutor, 'getApprovalSummaries' | 'listPendingApprovalIdsForUser'> | null;
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

export class ChatAgentOrchestrationState {
  private readonly stateAgentId: string;
  private pendingActionStore?: PendingActionStore;
  private continuityThreadStore?: ContinuityThreadStore;
  private readonly tools?: Pick<ToolExecutor, 'getApprovalSummaries' | 'listPendingApprovalIdsForUser'> | null;

  constructor(deps: ChatAgentOrchestrationStateDeps) {
    this.stateAgentId = deps.stateAgentId;
    this.pendingActionStore = deps.pendingActionStore;
    this.continuityThreadStore = deps.continuityThreadStore;
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

  private buildPendingActionScope(userId: string, channel: string, surfaceId?: string): PendingActionScope {
    return {
      agentId: this.stateAgentId,
      userId,
      channel,
      surfaceId: surfaceId?.trim() || userId || 'default-surface',
    };
  }

  private buildContinuityThreadScope(userId: string): ContinuityThreadScope {
    return {
      assistantId: this.stateAgentId,
      userId: userId.trim(),
    };
  }

  getContinuityThread(
    userId: string,
    nowMs: number = Date.now(),
  ): ContinuityThreadRecord | null {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return null;
    return this.continuityThreadStore?.get(this.buildContinuityThreadScope(normalizedUserId), nowMs) ?? null;
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
    const normalizedSurfaceId = surfaceId?.trim() || normalizedUserId || 'default-surface';
    return this.continuityThreadStore.upsert(
      this.buildContinuityThreadScope(normalizedUserId),
      {
        touchSurface: {
          channel: normalizedChannel,
          surfaceId: normalizedSurfaceId,
        },
        ...(codeSessionId?.trim()
          ? {
              activeExecutionRefs: [{
                kind: 'code_session',
                id: codeSessionId.trim(),
              }],
            }
          : {}),
      },
      nowMs,
    );
  }

  updateContinuityThreadFromIntent(input: {
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
    return this.continuityThreadStore.upsert(
      this.buildContinuityThreadScope(normalizedUserId),
      {
        touchSurface: {
          channel: normalizedChannel,
          surfaceId: input.surfaceId?.trim() || normalizedUserId || 'default-surface',
        },
        ...(summary ? { focusSummary: summary } : {}),
        ...(nextLastActionableRequest ? { lastActionableRequest: nextLastActionableRequest } : {}),
        ...(summary ? { safeSummary: summary } : {}),
        ...(input.codeSessionId?.trim()
          ? {
              activeExecutionRefs: [{
                kind: 'code_session',
                id: input.codeSessionId.trim(),
              }],
            }
          : {}),
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
          surfaceId: surfaceId?.trim() || normalizedUserId || 'default-surface',
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
      return pendingAction;
    }
    const liveApprovalIds = this.tools?.listPendingApprovalIdsForUser?.(userId, channel, {
      includeUnscoped: channel === 'web',
    }) ?? [];
    const approvalSummaries = this.tools?.getApprovalSummaries?.(liveApprovalIds);
    const reconciled = reconcilePendingApprovalAction(this.pendingActionStore, pendingAction, {
      liveApprovalIds,
      liveApprovalSummaries: approvalSummaries,
      scope: primaryScope,
      nowMs,
    });
    return reconciled && isPendingActionActive(reconciled.status)
      ? reconciled
      : null;
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
    return active.blocker.kind === replacement.blocker.kind
      && (active.blocker.field ?? '') === (replacement.blocker.field ?? '')
      && activeRoute === nextRoute
      && activeOperation === nextOperation
      && sameOriginal;
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
  ): PendingActionRecord['resume'] {
    const payload: PendingActionSwitchCandidatePayload = {
      type: PENDING_ACTION_SWITCH_CANDIDATE_TYPE,
      replacement,
      ...(active.resume ? { previousResume: { kind: active.resume.kind, payload: { ...active.resume.payload } } } : {}),
    };
    return {
      kind: 'direct_route',
      payload: payload as unknown as Record<string, unknown>,
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
    const payload = pendingAction?.resume?.payload;
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
    const active = this.getActivePendingAction(userId, channel, surfaceId, nowMs);
    const replacement = this.createPendingActionReplacementInput(input);
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
      resume: this.buildPendingActionSwitchCandidatePayload(active, replacement),
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
    return this.pendingActionStore.replaceActive(
      this.buildPendingActionScope(userId, channel, surfaceId),
      input,
      nowMs,
    );
  }

  updatePendingAction(
    actionId: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>>,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    return this.pendingActionStore?.update(actionId, patch, nowMs) ?? null;
  }

  completePendingAction(actionId: string, nowMs: number = Date.now()): void {
    this.pendingActionStore?.complete(actionId, nowMs);
  }

  private cancelPendingAction(actionId: string, nowMs: number = Date.now()): void {
    this.pendingActionStore?.cancel(actionId, nowMs);
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
      resume?: PendingActionRecord['resume'];
    },
    nowMs: number = Date.now(),
  ): PendingActionSetResult {
    const prompt = sanitizePendingActionPrompt(input.prompt, input.blockerKind);
    const summary = normalizeUserFacingIntentGatewaySummary(input.summary);
    return this.replacePendingActionWithGuard(userId, channel, surfaceId, {
      status: 'pending',
      transferPolicy: defaultPendingActionTransferPolicy(input.blockerKind),
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
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    }, nowMs);
  }
}

function isContinuityStatusCheck(content: string): boolean {
  return CONTINUITY_STATUS_CHECK_PATTERN.test(content.trim());
}
