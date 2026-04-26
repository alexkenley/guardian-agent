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

export async function continuePendingActionAfterApproval(input: {
  pendingAction: PendingActionRecord | null;
  approvalId: string;
  decision: 'approved' | 'denied';
  approvalResult?: ToolApprovalDecisionResult;
  stateAgentId: string;
  completePendingAction: (actionId: string, nowMs?: number) => void;
  resumeStoredExecutionGraphPendingAction?: (
    pendingAction: PendingActionRecord,
    options: {
      approvalId: string;
      approvalResult: ToolApprovalDecisionResult;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  normalizeApprovalContinuationResponse: (
    response: ApprovalOrchestrationResponse,
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => ApprovalOrchestrationResponse;
  withCurrentPendingActionMetadata?: (
    metadata: Record<string, unknown> | undefined,
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => Record<string, unknown> | undefined;
}): Promise<ApprovalOrchestrationResponse | null> {
  if (!input.pendingAction || input.decision !== 'approved') return null;
  if (input.pendingAction.scope.agentId !== input.stateAgentId) return null;
  const remainingApprovalIds = (input.pendingAction.blocker.approvalIds ?? [])
    .filter((id) => id !== input.approvalId.trim());
  if (remainingApprovalIds.length > 0) return null;
  const resume = input.pendingAction.resume;
  if (!resume) return null;
  const resumeKind = resume.kind;
  if (resumeKind !== 'execution_graph') return null;
  const approvalGranted = input.approvalResult
    ? input.approvalResult.approved ?? input.approvalResult.success
    : false;
  const response = approvalGranted && input.approvalResult && input.resumeStoredExecutionGraphPendingAction
    ? await input.resumeStoredExecutionGraphPendingAction(input.pendingAction, {
      approvalId: input.approvalId,
      approvalResult: input.approvalResult,
    })
    : null;
  if (response) {
    return input.normalizeApprovalContinuationResponse(
      response,
      input.pendingAction.scope.userId,
      input.pendingAction.scope.channel,
      input.pendingAction.scope.surfaceId,
    );
  }
  const payload = resume.payload as { graphId?: unknown } | undefined;
  const graphId = typeof payload?.graphId === 'string' ? payload.graphId : undefined;
  input.completePendingAction(input.pendingAction.id);
  const metadata = input.withCurrentPendingActionMetadata
    ? input.withCurrentPendingActionMetadata(
      {
        executionGraph: {
          ...(graphId ? { graphId } : {}),
          status: 'failed',
          reason: 'execution_graph_resume_unavailable',
        },
      },
      input.pendingAction.scope.userId,
      input.pendingAction.scope.channel,
      input.pendingAction.scope.surfaceId,
    )
    : {
        executionGraph: {
          ...(graphId ? { graphId } : {}),
          status: 'failed',
          reason: 'execution_graph_resume_unavailable',
        },
      };
  return {
    content: 'Execution graph approval was resolved, but the persisted execution graph could not be resumed. Please retry the request.',
    ...(metadata ? { metadata } : {}),
  };
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
  resumeStoredExecutionGraphPendingAction: (
    pendingAction: PendingActionRecord,
    options?: {
      approvalId?: string;
      approvalResult?: ToolApprovalDecisionResult;
    },
  ) => Promise<ApprovalOrchestrationResponse | null>;
  normalizeApprovalContinuationResponse: (
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
  formatResolvedApprovalResultResponse: (
    pendingAction: PendingActionRecord,
    approvalResult?: ToolApprovalDecisionResult,
  ) => ApprovalOrchestrationResponse | null;
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
        const followUp = input.takeApprovalFollowUp(approvalId, decision);
        results.push(followUp ?? result.message ?? `${decision === 'approved' ? 'Approved and executed' : 'Denied'} (${approvalId}).`);
      } else {
        input.clearApprovalFollowUp(approvalId);
        const failure = result.message ?? `${decision === 'approved' ? 'Approval' : 'Denial'} failed (${approvalId}).`;
        results.push(
          decision === 'approved'
            ? `Approval received for ${approvalId}, but execution failed: ${failure}`
            : `Denial for ${approvalId} failed: ${failure}`,
        );
      }
    } catch (err) {
      input.clearApprovalFollowUp(approvalId);
      results.push(`Error processing ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
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

  if (decision === 'approved' && pendingAction?.resume) {
    const approvalResult = targetIds.length === 1
      ? approvalDecisionResults.get(targetIds[0])
      : undefined;
    const resumedResponse = await continuePendingActionAfterApproval({
      pendingAction,
      approvalId: targetIds[0],
      decision,
      approvalResult,
      stateAgentId: pendingAction.scope.agentId,
      completePendingAction: input.completePendingAction,
      resumeStoredExecutionGraphPendingAction: input.resumeStoredExecutionGraphPendingAction,
      normalizeApprovalContinuationResponse: input.normalizeApprovalContinuationResponse,
      withCurrentPendingActionMetadata: input.withCurrentPendingActionMetadata,
    });
    if (resumedResponse) {
      const leadingResults = results.filter((line) => !isGenericSuccessfulToolCompletionMessage(line));
      return {
        content: [
          leadingResults.join('\n'),
          resumedResponse.content,
        ].filter(Boolean).join('\n\n'),
        metadata: resumedResponse.metadata,
      };
    }
  }

  if (decision === 'approved' && pendingAction) {
    const approvalResult = targetIds.length === 1
      ? approvalDecisionResults.get(targetIds[0])
      : undefined;
    const approvalResultResponse = input.formatResolvedApprovalResultResponse(pendingAction, approvalResult);
    if (approvalResultResponse) {
      input.completePendingAction(pendingAction.id);
      const normalizedResponse = input.normalizeApprovalContinuationResponse(
        approvalResultResponse,
        input.message.userId,
        input.message.channel,
        input.message.surfaceId,
      );
      const leadingResults = results.filter((line) => (
        !isGenericSuccessfulToolCompletionMessage(line)
        && line !== approvalResult?.message
      ));
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
