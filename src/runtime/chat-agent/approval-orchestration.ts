import type { AgentContext, UserMessage } from '../../agent/types.js';
import { stripLeadingContextPrefix } from '../../chat-agent-helpers.js';
import type { ToolApprovalDecisionResult, ToolExecutor } from '../../tools/executor.js';
import {
  type PendingActionRecord,
  toPendingActionClientMetadata,
} from '../pending-actions.js';
import {
  APPROVAL_COMMAND_PATTERN,
  APPROVAL_CONFIRM_PATTERN,
  APPROVAL_DENY_PATTERN,
  type AutomationApprovalContinuation,
} from './approval-state.js';
import type { PendingActionSetResult } from './orchestration-state.js';

export interface ApprovalOrchestrationResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

function isGenericSuccessfulToolCompletionMessage(message: string): boolean {
  const normalized = stripLeadingContextPrefix(message).trim();
  if (!normalized) return false;
  return /^Tool '[^']+' completed\.$/.test(normalized)
    || /^Approved and executed(?: \([^)]+\))?\.$/.test(normalized);
}

export async function continueDirectRouteAfterApproval(input: {
  pendingAction: PendingActionRecord | null;
  approvalId: string;
  decision: 'approved' | 'denied';
  approvalResult?: ToolApprovalDecisionResult;
  stateAgentId: string;
  resumeStoredToolLoopPendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      approvalId?: string;
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
      ctx?: AgentContext;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  resumeStoredDirectRoutePendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  normalizeDirectRouteContinuationResponse: (
    response: ApprovalOrchestrationResponse,
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => ApprovalOrchestrationResponse;
}): Promise<ApprovalOrchestrationResponse | null> {
  if (!input.pendingAction || input.decision !== 'approved') return null;
  if (input.pendingAction.scope.agentId !== input.stateAgentId) return null;
  const remainingApprovalIds = (input.pendingAction.blocker.approvalIds ?? [])
    .filter((id) => id !== input.approvalId.trim());
  if (remainingApprovalIds.length > 0) return null;
  const resumeKind = input.pendingAction.resume?.kind;
  if (resumeKind !== 'direct_route' && resumeKind !== 'tool_loop') return null;
  const response = resumeKind === 'tool_loop'
    ? await input.resumeStoredToolLoopPendingAction(
      input.pendingAction,
      {
        approvalId: input.approvalId,
        approvalResult: input.approvalResult,
      },
    )
    : await input.resumeStoredDirectRoutePendingAction(
      input.pendingAction,
      {
        approvalResult: input.approvalResult,
      },
    );
  if (!response) return null;
  return input.normalizeDirectRouteContinuationResponse(
    response,
    input.pendingAction.scope.userId,
    input.pendingAction.scope.channel,
    input.pendingAction.scope.surfaceId,
  );
}

export function syncPendingApprovalsFromExecutor(input: {
  tools?: Pick<ToolExecutor, 'isEnabled' | 'listPendingApprovalIdsForUser'> | null;
  sourceUserId: string;
  sourceChannel: string;
  targetUserId: string;
  targetChannel: string;
  surfaceId?: string;
  originalUserContent?: string;
  setPendingApprovals: (
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs?: number,
  ) => void;
  getPendingApprovalAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs?: number,
  ) => PendingActionRecord | null;
  updatePendingAction: (
    actionId: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>>,
    nowMs?: number,
  ) => PendingActionRecord | null;
}): void {
  if (!input.tools?.isEnabled()) return;
  const ids = input.tools.listPendingApprovalIdsForUser(
    input.sourceUserId,
    input.sourceChannel,
    {
      includeUnscoped: input.sourceChannel === 'web',
    },
  );
  const userKey = `${input.targetUserId}:${input.targetChannel}`;
  const active = input.getPendingApprovalAction(input.targetUserId, input.targetChannel, input.surfaceId);
  if (!active && ids.length > 0 && !input.originalUserContent?.trim()) {
    return;
  }
  input.setPendingApprovals(userKey, ids, input.surfaceId);
  if (ids.length > 0 && input.originalUserContent?.trim()) {
    const nextActive = input.getPendingApprovalAction(input.targetUserId, input.targetChannel, input.surfaceId);
    if (nextActive && !nextActive.intent.originalUserContent.trim()) {
      input.updatePendingAction(nextActive.id, {
        intent: {
          ...nextActive.intent,
          originalUserContent: input.originalUserContent,
        },
      });
    }
  }
}

export async function handleApprovalMessage(input: {
  message: UserMessage;
  ctx: AgentContext;
  tools: Pick<ToolExecutor, 'decideApproval' | 'getApprovalSummaries' | 'listPendingApprovalIdsForUser'>;
  getPendingApprovalAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs?: number,
  ) => PendingActionRecord | null;
  setPendingApprovals: (
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs?: number,
  ) => void;
  setPendingApprovalAction: (
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    pendingActionInput: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionRecord['blocker']['approvalSummaries'];
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
  ) => PendingActionSetResult;
  completePendingAction: (actionId: string, nowMs?: number) => void;
  takeApprovalFollowUp: (approvalId: string, decision: 'approved' | 'denied') => string | null;
  clearApprovalFollowUp: (approvalId: string) => void;
  getAutomationApprovalContinuation: (userKey: string, nowMs?: number) => AutomationApprovalContinuation | null;
  setAutomationApprovalContinuation: (
    userKey: string,
    originalMessage: UserMessage,
    ctx: AgentContext,
    pendingApprovalIds: string[],
    expiresAt?: number,
  ) => void;
  clearAutomationApprovalContinuation: (userKey: string) => void;
  tryDirectAutomationAuthoring: (
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    codeContext?: { workspaceRoot: string; sessionId?: string },
    options?: {
      allowRemediation?: boolean;
      assumeAuthoring?: boolean;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  resumeStoredToolLoopPendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      approvalId?: string;
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
      ctx?: AgentContext;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  resumeStoredDirectRoutePendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  resumeStoredExecutionGraphPendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      approvalId?: string;
      approvalResult?: ToolApprovalDecisionResult;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  normalizeDirectRouteContinuationResponse: (
    response: ApprovalOrchestrationResponse,
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => ApprovalOrchestrationResponse;
  withCurrentPendingActionMetadata: (
    metadata: Record<string, unknown> | undefined,
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => Record<string, unknown> | undefined;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string; actionLabel?: string }>,
  ) => string;
  resolveApprovalTargets: (
    content: string,
    pendingIds: string[],
  ) => { ids: string[]; errors: string[] };
}): Promise<ApprovalOrchestrationResponse | null> {
  const userKey = `${input.message.userId}:${input.message.channel}`;
  const pendingAction = input.getPendingApprovalAction(
    input.message.userId,
    input.message.channel,
    input.message.surfaceId,
  );
  const pendingIds = pendingAction?.blocker.approvalIds ?? [];
  if (pendingIds.length === 0) return null;

  const content = stripLeadingContextPrefix(input.message.content).trim();
  const isApprove = APPROVAL_CONFIRM_PATTERN.test(content);
  const isDeny = APPROVAL_DENY_PATTERN.test(content);
  if (!isApprove && !isDeny) return null;

  const decision: 'approved' | 'denied' = isDeny ? 'denied' : 'approved';
  let targetIds = pendingIds;
  if (APPROVAL_COMMAND_PATTERN.test(content)) {
    const selected = input.resolveApprovalTargets(content, pendingIds);
    if (selected.errors.length > 0) {
      const summaries = input.tools.getApprovalSummaries(pendingIds);
      return {
        content: [
          selected.errors.join('\n'),
          '',
          input.formatPendingApprovalPrompt(pendingIds, summaries),
        ].join('\n'),
      };
    }
    targetIds = selected.ids;
  }

  if (targetIds.length === 0) {
    const summaries = input.tools.getApprovalSummaries(pendingIds);
    return { content: input.formatPendingApprovalPrompt(pendingIds, summaries) };
  }

  const remaining = pendingIds.filter((id) => !targetIds.includes(id));
  input.setPendingApprovals(userKey, remaining, input.message.surfaceId);
  const results: string[] = [];
  const approvedIds = new Set<string>();
  const failedIds = new Set<string>();
  const approvalDecisionResults = new Map<string, ToolApprovalDecisionResult>();
  for (const approvalId of targetIds) {
    try {
      const result = await input.tools.decideApproval(
        approvalId,
        decision,
        input.message.principalId ?? input.message.userId,
        input.message.principalRole ?? 'owner',
      );
      approvalDecisionResults.set(approvalId, result);
      if (result.success) {
        if (decision === 'approved') approvedIds.add(approvalId);
        const followUp = input.takeApprovalFollowUp(approvalId, decision);
        results.push(followUp ?? result.message ?? `${decision === 'approved' ? 'Approved and executed' : 'Denied'} (${approvalId}).`);
      } else {
        failedIds.add(approvalId);
        input.clearApprovalFollowUp(approvalId);
        const failure = result.message ?? `${decision === 'approved' ? 'Approval' : 'Denial'} failed (${approvalId}).`;
        results.push(
          decision === 'approved'
            ? `Approval received for ${approvalId}, but execution failed: ${failure}`
            : `Denial for ${approvalId} failed: ${failure}`,
        );
      }
    } catch (err) {
      failedIds.add(approvalId);
      input.clearApprovalFollowUp(approvalId);
      results.push(`Error processing ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const continuation = input.getAutomationApprovalContinuation(userKey);
  if (continuation) {
    const affected = targetIds.filter((id) => continuation.pendingApprovalIds.includes(id));
    if (decision === 'approved' && affected.length > 0) {
      const stillPending = continuation.pendingApprovalIds.filter((id) => !approvedIds.has(id));
      if (stillPending.length === 0) {
        input.clearAutomationApprovalContinuation(userKey);
        const retry = await input.tryDirectAutomationAuthoring(continuation.originalMessage, input.ctx, userKey, undefined, {
          assumeAuthoring: true,
        });
        if (retry) {
          results.push('');
          results.push(retry.content);
          return {
            content: results.join('\n'),
            metadata: input.withCurrentPendingActionMetadata(
              retry.metadata,
              input.message.userId,
              input.message.channel,
              input.message.surfaceId,
            ),
          };
        }
      } else {
        input.setAutomationApprovalContinuation(
          userKey,
          continuation.originalMessage,
          continuation.ctx,
          stillPending,
          continuation.expiresAt,
        );
      }
    } else if (affected.length > 0 && (decision === 'denied' || affected.some((id) => failedIds.has(id)))) {
      input.clearAutomationApprovalContinuation(userKey);
    }
  }

  const fallbackContinuation = input.getAutomationApprovalContinuation(userKey);
  if (decision === 'approved' && fallbackContinuation && approvedIds.size > 0) {
    const livePendingIds = new Set(input.tools.listPendingApprovalIdsForUser(
      input.message.userId,
      input.message.channel,
      {
        includeUnscoped: input.message.channel === 'web',
        principalId: input.message.principalId ?? input.message.userId,
      },
    ));
    const stillPending = fallbackContinuation.pendingApprovalIds.filter((id) => livePendingIds.has(id));
    if (stillPending.length === 0) {
      input.clearAutomationApprovalContinuation(userKey);
      const retry = await input.tryDirectAutomationAuthoring(fallbackContinuation.originalMessage, input.ctx, userKey, undefined, {
        assumeAuthoring: true,
      });
      if (retry) {
        results.push('');
        results.push(retry.content);
        return {
          content: results.join('\n'),
          metadata: input.withCurrentPendingActionMetadata(
            retry.metadata,
            input.message.userId,
            input.message.channel,
            input.message.surfaceId,
          ),
        };
      }
    } else if (stillPending.length !== fallbackContinuation.pendingApprovalIds.length) {
      input.setAutomationApprovalContinuation(
        userKey,
        fallbackContinuation.originalMessage,
        fallbackContinuation.ctx,
        stillPending,
        fallbackContinuation.expiresAt,
      );
    }
  }

  if (remaining.length > 0) {
    const summaries = input.tools.getApprovalSummaries(remaining);
    results.push('');
    results.push(input.formatPendingApprovalPrompt(remaining, summaries));
    const approvalSummaries = remaining.map((id) => {
      const summary = summaries?.get(id);
      return {
        id,
        toolName: summary?.toolName ?? 'unknown',
        argsPreview: summary?.argsPreview ?? '',
        actionLabel: summary?.actionLabel ?? '',
      };
    });
    const nextActionResult = input.setPendingApprovalAction(
      input.message.userId,
      input.message.channel,
      input.message.surfaceId,
      {
        prompt: pendingAction?.blocker.prompt ?? 'Approval required for the pending action.',
        approvalIds: remaining,
        approvalSummaries,
        originalUserContent: pendingAction?.intent.originalUserContent ?? input.message.content,
        route: pendingAction?.intent.route,
        operation: pendingAction?.intent.operation,
        summary: pendingAction?.intent.summary,
        turnRelation: pendingAction?.intent.turnRelation,
        resolution: pendingAction?.intent.resolution,
        missingFields: pendingAction?.intent.missingFields,
        provenance: pendingAction?.intent.provenance,
        entities: pendingAction?.intent.entities,
        resume: pendingAction?.resume,
        executionId: pendingAction?.executionId,
        rootExecutionId: pendingAction?.rootExecutionId,
        codeSessionId: pendingAction?.codeSessionId,
      },
    );
    return {
      content: [
        results.join('\n'),
        nextActionResult.collisionPrompt ?? '',
      ].filter(Boolean).join('\n\n'),
      metadata: nextActionResult.action ? { pendingAction: toPendingActionClientMetadata(nextActionResult.action) } : undefined,
    };
  }

  if (pendingAction?.resume?.kind === 'execution_graph') {
    const approvalResult = targetIds.length === 1
      ? approvalDecisionResults.get(targetIds[0])
      : undefined;
    const resumedResponse = approvalResult?.success
      ? await input.resumeStoredExecutionGraphPendingAction(
        pendingAction,
        { approvalId: targetIds[0], approvalResult },
      )
      : null;
    if (resumedResponse) {
      const normalizedResponse = input.normalizeDirectRouteContinuationResponse(
        resumedResponse,
        input.message.userId,
        input.message.channel,
        input.message.surfaceId,
      );
      const leadingResults = results.filter((line) => !isGenericSuccessfulToolCompletionMessage(line));
      return {
        content: [
          leadingResults.join('\n'),
          normalizedResponse.content,
        ].filter(Boolean).join('\n\n'),
        metadata: normalizedResponse.metadata,
      };
    }
    const payload = pendingAction.resume.payload as { graphId?: unknown } | undefined;
    const graphId = typeof payload?.graphId === 'string' ? payload.graphId : undefined;
    input.completePendingAction(pendingAction.id);
    return {
      content: [
        results.join('\n'),
        'Execution graph approval was resolved, but the persisted execution graph could not be resumed. Please retry the request.',
      ].filter(Boolean).join('\n\n'),
      metadata: input.withCurrentPendingActionMetadata(
        {
          executionGraph: {
            ...(graphId ? { graphId } : {}),
            status: 'failed',
            reason: 'execution_graph_resume_unavailable',
          },
        },
        input.message.userId,
        input.message.channel,
        input.message.surfaceId,
      ),
    };
  }

  if (decision === 'approved' && (pendingAction?.resume?.kind === 'direct_route' || pendingAction?.resume?.kind === 'tool_loop')) {
    const approvalResult = targetIds.length === 1
      ? approvalDecisionResults.get(targetIds[0])
      : undefined;
    const resumedResponse = pendingAction.resume.kind === 'tool_loop'
      ? await input.resumeStoredToolLoopPendingAction(
        pendingAction,
        { approvalId: targetIds[0], approvalResult, ctx: input.ctx },
      )
      : await input.resumeStoredDirectRoutePendingAction(
        pendingAction,
        { approvalResult },
      );
    if (resumedResponse) {
      const normalizedResponse = input.normalizeDirectRouteContinuationResponse(
        resumedResponse,
        input.message.userId,
        input.message.channel,
        input.message.surfaceId,
      );
      const leadingResults = results.filter((line) => !isGenericSuccessfulToolCompletionMessage(line));
      return {
        content: [
          leadingResults.join('\n'),
          normalizedResponse.content,
        ].filter(Boolean).join('\n\n'),
        metadata: normalizedResponse.metadata,
      };
    }
  }

  if (pendingAction) {
    input.completePendingAction(pendingAction.id);
  }
  return { content: results.join('\n') };
}
