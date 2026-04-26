import type { AgentContext } from '../../agent/types.js';
import { toBoolean, toString } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { PrincipalRole } from '../../tools/types.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type { PendingActionApprovalSummary, PendingActionRecord } from '../pending-actions.js';
import {
  buildDirectFilesystemToolRequest,
  CAPABILITY_CONTINUATION_TYPE_FILESYSTEM_SAVE_OUTPUT,
  getFilesystemPolicyRoot,
  isFilesystemPathPolicyError,
} from './capability-continuation-resume.js';
import type { PendingActionSetResult } from './orchestration-state.js';

export interface StoredFilesystemSaveInput {
  targetPath: string;
  content: string;
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
  allowPathRemediation: boolean;
}

export async function executeStoredFilesystemSave(input: {
  request: StoredFilesystemSaveInput;
  agentId: string;
  tools?: Pick<ToolExecutor, 'isEnabled' | 'executeModelTool' | 'getApprovalSummaries'> | null;
  setApprovalFollowUp: (approvalId: string, copy: { approved?: string; denied?: string }) => void;
  getPendingApprovals: (
    userKey: string,
    surfaceId?: string,
    nowMs?: number,
  ) => { ids: string[]; createdAt: number; expiresAt: number } | null;
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
        type: typeof CAPABILITY_CONTINUATION_TYPE_FILESYSTEM_SAVE_OUTPUT;
        targetPath: string;
        content: string;
        originalUserContent: string;
        allowPathRemediation: boolean;
        principalId?: string;
        principalRole?: string;
        codeContext?: { workspaceRoot: string; sessionId?: string };
      };
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  buildPendingApprovalBlockedResponse: (
    result: PendingActionSetResult,
    fallbackContent: string,
  ) => { content: string; metadata?: Record<string, unknown> };
}): Promise<string | { content: string; metadata?: Record<string, unknown> }> {
  if (!input.tools?.isEnabled()) {
    return `I couldn't save the previous assistant output to "${input.request.targetPath}" because filesystem tools are unavailable.`;
  }

  const toolRequest = buildDirectFilesystemToolRequest({
    ...input.request,
    agentId: input.agentId,
  });
  const writeResult = await input.tools.executeModelTool(
    'fs_write',
    {
      path: input.request.targetPath,
      content: input.request.content,
      append: false,
    },
    toolRequest,
  );

  if (toBoolean(writeResult.success)) {
    return `I saved the previous assistant output to \`${input.request.targetPath}\`.`;
  }

  const writeStatus = toString(writeResult.status);
  if (writeStatus === 'pending_approval') {
    return buildPendingFilesystemWriteApprovalResponse(input, toString(writeResult.approvalId));
  }

  const writeMessage = toString(writeResult.message) || toString(writeResult.error) || 'Save failed.';
  if (!input.request.allowPathRemediation || !isFilesystemPathPolicyError(writeMessage)) {
    return `I couldn't save the previous assistant output to "${input.request.targetPath}": ${writeMessage}`;
  }

  const policyPath = getFilesystemPolicyRoot(input.request.targetPath);
  const policyResult = await input.tools.executeModelTool(
    'update_tool_policy',
    {
      action: 'add_path',
      value: policyPath,
    },
    toolRequest,
  );

  if (toBoolean(policyResult.success)) {
    return executeStoredFilesystemSave({
      ...input,
      request: {
        ...input.request,
        allowPathRemediation: false,
      },
    });
  }

  const policyStatus = toString(policyResult.status);
  if (policyStatus === 'pending_approval') {
    return buildPendingFilesystemPathApprovalResponse(input, policyPath, toString(policyResult.approvalId));
  }

  const policyMessage = toString(policyResult.message) || toString(policyResult.error) || 'Path approval failed.';
  return `I couldn't prepare access to "${input.request.targetPath}" for saving the previous assistant output: ${policyMessage}`;
}

function buildPendingFilesystemWriteApprovalResponse(input: Parameters<typeof executeStoredFilesystemSave>[0], approvalId: string) {
  const existingIds = input.getPendingApprovals(input.request.userKey, input.request.surfaceId)?.ids ?? [];
  const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
  if (approvalId) {
    input.setApprovalFollowUp(approvalId, {
      approved: `I saved the previous assistant output to \`${input.request.targetPath}\`.`,
      denied: `I did not save the previous assistant output to \`${input.request.targetPath}\`.`,
    });
  }
  const summaries = pendingIds.length > 0 ? input.tools?.getApprovalSummaries(pendingIds) : undefined;
  const prompt = input.formatPendingApprovalPrompt(pendingIds, summaries);
  const pendingActionResult = input.setPendingApprovalActionForRequest(
    input.request.userKey,
    input.request.surfaceId,
    {
      prompt,
      approvalIds: pendingIds,
      approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
      originalUserContent: input.request.originalUserContent,
      route: 'filesystem_task',
      operation: 'save',
      summary: 'Writes the previous assistant output to a file.',
      turnRelation: 'new_request',
      resolution: 'ready',
      ...(input.request.codeContext?.sessionId ? { codeSessionId: input.request.codeContext.sessionId } : {}),
    },
  );
  return input.buildPendingApprovalBlockedResponse(pendingActionResult, [
    `I prepared a file save for "${input.request.targetPath}" but it needs approval first.`,
    prompt,
  ].filter(Boolean).join('\n\n'));
}

function buildPendingFilesystemPathApprovalResponse(
  input: Parameters<typeof executeStoredFilesystemSave>[0],
  policyPath: string,
  approvalId: string,
) {
  const existingIds = input.getPendingApprovals(input.request.userKey, input.request.surfaceId)?.ids ?? [];
  const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
  if (approvalId) {
    input.setApprovalFollowUp(approvalId, {
      approved: `I added \`${policyPath}\` to the allowed paths.`,
      denied: `I did not add \`${policyPath}\` to the allowed paths.`,
    });
  }
  const summaries = pendingIds.length > 0 ? input.tools?.getApprovalSummaries(pendingIds) : undefined;
  const prompt = input.formatPendingApprovalPrompt(pendingIds, summaries);
  const pendingActionResult = input.setChatContinuationGraphPendingApprovalActionForRequest(
    input.request.userKey,
    input.request.surfaceId,
    {
      prompt,
      approvalIds: pendingIds,
      approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
      originalUserContent: input.request.originalUserContent,
      route: 'filesystem_task',
      operation: 'save',
      summary: 'Adds an allowed path so Guardian can save the previous assistant output, then resumes the save.',
      turnRelation: 'new_request',
      resolution: 'ready',
      continuation: {
        type: CAPABILITY_CONTINUATION_TYPE_FILESYSTEM_SAVE_OUTPUT,
        targetPath: input.request.targetPath,
        content: input.request.content,
        originalUserContent: input.request.originalUserContent,
        allowPathRemediation: false,
        ...(input.request.principalId ? { principalId: input.request.principalId } : {}),
        ...(input.request.principalRole ? { principalRole: input.request.principalRole } : {}),
        ...(input.request.codeContext ? { codeContext: { ...input.request.codeContext } } : {}),
      },
      ...(input.request.codeContext?.sessionId ? { codeSessionId: input.request.codeContext.sessionId } : {}),
    },
  );
  return input.buildPendingApprovalBlockedResponse(pendingActionResult, [
    `I need approval to add "${policyPath}" to the allowed paths before I can save the previous assistant output to "${input.request.targetPath}".`,
    prompt,
  ].filter(Boolean).join('\n\n'));
}
