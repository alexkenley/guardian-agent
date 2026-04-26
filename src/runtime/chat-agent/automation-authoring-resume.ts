import { randomUUID } from 'node:crypto';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import { isRecord, toString } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { PrincipalRole } from '../../tools/types.js';
import { tryAutomationPreRoute } from '../automation-prerouter.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type { PendingActionApprovalSummary, PendingActionRecord } from '../pending-actions.js';
import {
  CAPABILITY_CONTINUATION_TYPE_AUTOMATION_AUTHORING,
  normalizeFilesystemResumePrincipalRole,
} from './capability-continuation-resume.js';
import type { PendingActionSetResult } from './orchestration-state.js';

export interface StoredAutomationAuthoringInput {
  originalUserContent: string;
  userKey: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  principalId?: string;
  principalRole?: PrincipalRole;
  requestId: string;
  agentCheckAction?: AgentContext['checkAction'];
  codeContext?: { workspaceRoot: string; sessionId?: string };
  allowRemediation: boolean;
}

export interface AutomationAuthoringResumeResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

type AutomationAuthoringTools = Pick<
  ToolExecutor,
  'isEnabled' | 'getPolicy' | 'preflightTools' | 'executeModelTool' | 'getApprovalSummaries'
>;

function resolvePendingApprovalMetadata(
  tools: AutomationAuthoringTools | null | undefined,
  ids: string[],
  fallback: PendingActionApprovalSummary[],
): PendingActionApprovalSummary[] {
  const summaries = tools?.getApprovalSummaries(ids);
  if (!summaries) return fallback;
  return ids.map((id) => {
    const summary = summaries.get(id);
    const fallbackItem = fallback.find((item) => item.id === id);
    return {
      id,
      toolName: summary?.toolName ?? fallbackItem?.toolName ?? 'unknown',
      argsPreview: summary?.argsPreview ?? fallbackItem?.argsPreview ?? '',
      actionLabel: summary?.actionLabel ?? fallbackItem?.actionLabel ?? '',
    };
  });
}

function readPendingActionPrompt(
  metadata: Record<string, unknown> | undefined,
): string | null {
  if (!isRecord(metadata?.pendingAction) || !isRecord(metadata.pendingAction.blocker)) {
    return null;
  }
  const prompt = toString(metadata.pendingAction.blocker.prompt).trim();
  return prompt || null;
}

export async function executeStoredAutomationAuthoring(input: {
  request: StoredAutomationAuthoringInput;
  agentId: string;
  tools?: AutomationAuthoringTools | null;
  setApprovalFollowUp: (approvalId: string, copy: { approved: string; denied: string }) => void;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string; actionLabel?: string }>,
  ) => string;
  setPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: {
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
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  setChatContinuationGraphPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: {
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
      entities?: Record<string, unknown>;
      continuation: {
        type: typeof CAPABILITY_CONTINUATION_TYPE_AUTOMATION_AUTHORING;
        originalUserContent: string;
        allowRemediation: boolean;
        principalId?: string;
        principalRole?: string;
        messageMetadata?: Record<string, unknown>;
        codeContext?: { workspaceRoot: string; sessionId?: string };
      };
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  buildPendingApprovalBlockedResponse: (
    result: PendingActionSetResult,
    fallbackContent: string,
  ) => AutomationAuthoringResumeResponse;
}): Promise<AutomationAuthoringResumeResponse> {
  if (!input.tools?.isEnabled()) {
    return { content: 'I could not resume automation authoring because automation tools are unavailable.' };
  }

  const message: UserMessage = {
    id: input.request.requestId || randomUUID(),
    userId: input.request.userId,
    channel: input.request.channel,
    surfaceId: input.request.surfaceId,
    principalId: input.request.principalId,
    principalRole: input.request.principalRole,
    content: input.request.originalUserContent,
    timestamp: Date.now(),
  };
  const codeWorkspaceRoot = input.request.codeContext?.workspaceRoot.trim();
  const allowedPaths = codeWorkspaceRoot
    ? [codeWorkspaceRoot]
    : input.tools.getPolicy().sandbox.allowedPaths;
  const trackedPendingApprovalIds: string[] = [];
  const result = await tryAutomationPreRoute({
    agentId: input.agentId,
    message,
    checkAction: input.request.agentCheckAction,
    preflightTools: (requests) => input.tools!.preflightTools(requests),
    workspaceRoot: allowedPaths[0] || process.cwd(),
    allowedPaths,
    executeTool: (toolName, args, request) => input.tools!.executeModelTool(toolName, args, request),
    trackPendingApproval: (approvalId) => {
      trackedPendingApprovalIds.push(approvalId);
    },
    onPendingApproval: ({ approvalId, automationName, artifactLabel, verb }) => {
      input.setApprovalFollowUp(approvalId, {
        approved: `I ${verb} the ${artifactLabel} '${automationName}'.`,
        denied: `I did not ${verb === 'updated' ? 'update' : 'create'} the ${artifactLabel} '${automationName}'.`,
      });
    },
    formatPendingApprovalPrompt: (ids) => input.formatPendingApprovalPrompt(ids),
    resolvePendingApprovalMetadata: (ids, fallback) => resolvePendingApprovalMetadata(input.tools, ids, fallback),
  }, {
    allowRemediation: input.request.allowRemediation,
    assumeAuthoring: true,
  });

  if (!result) {
    return { content: 'I could not resume automation authoring from the approved remediation.' };
  }

  if (trackedPendingApprovalIds.length === 0) {
    return result;
  }

  const summaries = input.tools.getApprovalSummaries(trackedPendingApprovalIds);
  const prompt = readPendingActionPrompt(result.metadata)
    ?? input.formatPendingApprovalPrompt(trackedPendingApprovalIds, summaries);
  const pendingActionInput = {
    prompt,
    approvalIds: trackedPendingApprovalIds,
    approvalSummaries: buildPendingApprovalMetadata(trackedPendingApprovalIds, summaries),
    originalUserContent: input.request.originalUserContent,
    route: 'automation_authoring',
    operation: 'create',
    summary: 'Creates or updates a Guardian automation.',
    turnRelation: 'new_request',
    resolution: 'ready',
    ...(input.request.codeContext?.sessionId ? { codeSessionId: input.request.codeContext.sessionId } : {}),
  } as const;
  const pendingActionResult = result.metadata?.resumeAutomationAfterApprovals
    ? input.setChatContinuationGraphPendingApprovalActionForRequest(
      input.request.userKey,
      input.request.surfaceId,
      {
        ...pendingActionInput,
        continuation: {
          type: CAPABILITY_CONTINUATION_TYPE_AUTOMATION_AUTHORING,
          originalUserContent: input.request.originalUserContent,
          allowRemediation: input.request.allowRemediation,
          ...(input.request.principalId ? { principalId: input.request.principalId } : {}),
          ...(input.request.principalRole ? { principalRole: input.request.principalRole } : {}),
          ...(input.request.codeContext ? { codeContext: { ...input.request.codeContext } } : {}),
        },
      },
    )
    : input.setPendingApprovalActionForRequest(
    input.request.userKey,
    input.request.surfaceId,
    pendingActionInput,
  );
  const merged = input.buildPendingApprovalBlockedResponse(pendingActionResult, result.content);
  return {
    content: merged.content,
    metadata: {
      ...(result.metadata ?? {}),
      ...(merged.metadata ?? {}),
    },
  };
}

export function buildStoredAutomationAuthoringInput(input: {
  originalUserContent: string;
  userKey: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  principalId?: string;
  principalRole?: string;
  requestId?: string;
  agentCheckAction?: AgentContext['checkAction'];
  codeContext?: { workspaceRoot: string; sessionId?: string };
  allowRemediation?: boolean;
}): StoredAutomationAuthoringInput {
  return {
    originalUserContent: input.originalUserContent,
    userKey: input.userKey,
    userId: input.userId,
    channel: input.channel,
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(normalizeFilesystemResumePrincipalRole(input.principalRole) ? {
      principalRole: normalizeFilesystemResumePrincipalRole(input.principalRole),
    } : {}),
    requestId: input.requestId || randomUUID(),
    ...(input.agentCheckAction ? { agentCheckAction: input.agentCheckAction } : {}),
    ...(input.codeContext ? { codeContext: { ...input.codeContext } } : {}),
    allowRemediation: input.allowRemediation !== false,
  };
}
