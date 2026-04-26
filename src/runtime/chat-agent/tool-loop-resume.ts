import type { UserMessage } from '../../agent/types.js';
import { isRecord, toNumber, toString } from '../../chat-agent-helpers.js';
import type { ChatMessage } from '../../llm/types.js';
import {
  EXECUTION_PROFILE_METADATA_KEY,
  readSelectedExecutionProfileMetadata,
  type SelectedExecutionProfile,
} from '../execution-profiles.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { ContentTrustLevel, PrincipalRole } from '../../tools/types.js';

export const TOOL_LOOP_RESUME_TYPE_SUSPENDED_APPROVAL = 'suspended_tool_loop';

export interface StoredToolLoopMessageIdentity {
  id: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  principalId?: string;
  principalRole?: PrincipalRole;
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface StoredToolLoopPendingTool {
  approvalId: string;
  toolCallId: string;
  jobId: string;
  name: string;
}

export interface ToolLoopPendingApprovalToolResult {
  toolCall: {
    id: string;
    name: string;
    arguments?: string;
  };
  result: Record<string, unknown>;
}

export interface ToolLoopResumePayload {
  type: typeof TOOL_LOOP_RESUME_TYPE_SUSPENDED_APPROVAL;
  llmMessages: ChatMessage[];
  pendingTools: StoredToolLoopPendingTool[];
  originalMessage: StoredToolLoopMessageIdentity;
  requestText: string;
  referenceTime: number;
  allowModelMemoryMutation: boolean;
  activeSkillIds: string[];
  contentTrustLevel: ContentTrustLevel;
  taintReasons: string[];
  intentDecision?: IntentGatewayDecision;
  codeContext?: {
    workspaceRoot: string;
    sessionId?: string;
  };
  selectedExecutionProfile?: SelectedExecutionProfile;
}

export function buildToolLoopResumePayload(input: {
  llmMessages: ChatMessage[];
  pendingTools: StoredToolLoopPendingTool[];
  originalMessage: UserMessage;
  requestText: string;
  referenceTime: number;
  allowModelMemoryMutation: boolean;
  activeSkillIds: string[];
  contentTrustLevel: ContentTrustLevel;
  taintReasons: string[];
  intentDecision?: IntentGatewayDecision;
  codeContext?: { workspaceRoot: string; sessionId?: string };
  selectedExecutionProfile?: SelectedExecutionProfile | null;
}): Record<string, unknown> {
  return {
    type: TOOL_LOOP_RESUME_TYPE_SUSPENDED_APPROVAL,
    llmMessages: input.llmMessages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls?.length
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            })),
          }
        : {}),
    })),
    pendingTools: input.pendingTools.map((tool) => ({
      approvalId: tool.approvalId,
      toolCallId: tool.toolCallId,
      jobId: tool.jobId,
      name: tool.name,
    })),
    originalMessage: {
      id: input.originalMessage.id,
      userId: input.originalMessage.userId,
      channel: input.originalMessage.channel,
      ...(input.originalMessage.surfaceId?.trim() ? { surfaceId: input.originalMessage.surfaceId.trim() } : {}),
      ...(input.originalMessage.principalId?.trim() ? { principalId: input.originalMessage.principalId.trim() } : {}),
      ...(input.originalMessage.principalRole ? { principalRole: input.originalMessage.principalRole } : {}),
      timestamp: input.originalMessage.timestamp,
      content: input.originalMessage.content,
      ...(input.originalMessage.metadata ? { metadata: { ...input.originalMessage.metadata } } : {}),
    },
    requestText: input.requestText,
    referenceTime: input.referenceTime,
    allowModelMemoryMutation: input.allowModelMemoryMutation,
    activeSkillIds: [...input.activeSkillIds],
    contentTrustLevel: input.contentTrustLevel,
    taintReasons: [...input.taintReasons],
    ...(input.intentDecision ? { intentDecision: { ...input.intentDecision } } : {}),
    ...(input.codeContext
      ? {
          codeContext: {
            workspaceRoot: input.codeContext.workspaceRoot,
            ...(input.codeContext.sessionId ? { sessionId: input.codeContext.sessionId } : {}),
          },
        }
      : {}),
    ...(input.selectedExecutionProfile
      ? {
          selectedExecutionProfile: {
            ...input.selectedExecutionProfile,
            fallbackProviderOrder: [...input.selectedExecutionProfile.fallbackProviderOrder],
          },
        }
      : {}),
  };
}

export function collectToolLoopPendingApprovalTools(
  toolResults: readonly PromiseSettledResult<ToolLoopPendingApprovalToolResult>[],
): StoredToolLoopPendingTool[] {
  return toolResults
    .filter((settled): settled is PromiseFulfilledResult<ToolLoopPendingApprovalToolResult> =>
      settled.status === 'fulfilled' && settled.value.result.status === 'pending_approval')
    .map((settled) => ({
      approvalId: toString(settled.value.result.approvalId).trim(),
      toolCallId: settled.value.toolCall.id,
      jobId: toString(settled.value.result.jobId).trim(),
      name: settled.value.toolCall.name,
    }))
    .filter((tool) => tool.approvalId && tool.toolCallId && tool.jobId && tool.name);
}

export function buildToolLoopPendingApprovalContinuation(input: {
  toolResults: readonly PromiseSettledResult<ToolLoopPendingApprovalToolResult>[];
  llmMessages: ChatMessage[];
  originalMessage: UserMessage;
  requestText: string;
  referenceTime: number;
  allowModelMemoryMutation: boolean;
  activeSkillIds: string[];
  contentTrustLevel: ContentTrustLevel;
  taintReasons: string[];
  intentDecision?: IntentGatewayDecision;
  codeContext?: { workspaceRoot: string; sessionId?: string };
  selectedExecutionProfile?: SelectedExecutionProfile | null;
}): ToolLoopResumePayload | null {
  const pendingTools = collectToolLoopPendingApprovalTools(input.toolResults);
  if (pendingTools.length === 0) return null;
  return readToolLoopResumePayload(buildToolLoopResumePayload({
    llmMessages: input.llmMessages,
    pendingTools,
    originalMessage: input.originalMessage,
    requestText: input.requestText,
    referenceTime: input.referenceTime,
    allowModelMemoryMutation: input.allowModelMemoryMutation,
    activeSkillIds: input.activeSkillIds,
    contentTrustLevel: input.contentTrustLevel,
    taintReasons: input.taintReasons,
    intentDecision: input.intentDecision,
    codeContext: input.codeContext,
    selectedExecutionProfile: input.selectedExecutionProfile,
  }));
}

export function readToolLoopResumePayload(
  payload: Record<string, unknown> | undefined,
  normalizePrincipalRole?: (value: string | undefined) => PrincipalRole | undefined,
): ToolLoopResumePayload | null {
  if (!isRecord(payload) || payload.type !== TOOL_LOOP_RESUME_TYPE_SUSPENDED_APPROVAL) {
    return null;
  }
  const llmMessages = Array.isArray(payload.llmMessages)
    ? payload.llmMessages
      .filter((value): value is Record<string, unknown> => isRecord(value))
      .map((value) => {
        const role = value.role === 'system' || value.role === 'user' || value.role === 'assistant' || value.role === 'tool'
          ? value.role
          : null;
        if (!role) return null;
        const content = toString(value.content);
        const toolCalls = Array.isArray(value.toolCalls)
          ? value.toolCalls
            .filter((toolCall): toolCall is Record<string, unknown> => isRecord(toolCall))
            .map((toolCall) => ({
              id: toString(toolCall.id).trim(),
              name: toString(toolCall.name).trim(),
              arguments: toString(toolCall.arguments),
            }))
            .filter((toolCall) => toolCall.id && toolCall.name)
          : undefined;
        return {
          role,
          content,
          ...(toString(value.toolCallId).trim() ? { toolCallId: toString(value.toolCallId).trim() } : {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        } satisfies ChatMessage;
      })
      .filter((value): value is ChatMessage => Boolean(value))
    : [];
  const pendingTools = Array.isArray(payload.pendingTools)
    ? payload.pendingTools
      .filter((value): value is Record<string, unknown> => isRecord(value))
      .map((value) => ({
        approvalId: toString(value.approvalId).trim(),
        toolCallId: toString(value.toolCallId).trim(),
        jobId: toString(value.jobId).trim(),
        name: toString(value.name).trim(),
      }))
      .filter((value) => value.approvalId && value.toolCallId && value.jobId && value.name)
    : [];
  const originalMessageRecord = isRecord(payload.originalMessage) ? payload.originalMessage : null;
  const originalMessage = originalMessageRecord
    ? {
        id: toString(originalMessageRecord.id).trim(),
        userId: toString(originalMessageRecord.userId).trim(),
        channel: toString(originalMessageRecord.channel).trim(),
        ...(toString(originalMessageRecord.surfaceId).trim() ? { surfaceId: toString(originalMessageRecord.surfaceId).trim() } : {}),
        ...(toString(originalMessageRecord.principalId).trim() ? { principalId: toString(originalMessageRecord.principalId).trim() } : {}),
        ...(toString(originalMessageRecord.principalRole).trim()
          ? { principalRole: normalizePrincipalRole?.(toString(originalMessageRecord.principalRole).trim()) ?? normalizeStoredPrincipalRole(toString(originalMessageRecord.principalRole).trim()) }
          : {}),
        timestamp: toNumber(originalMessageRecord.timestamp) ?? Date.now(),
        content: toString(originalMessageRecord.content),
        ...(isRecord(originalMessageRecord.metadata) ? { metadata: { ...originalMessageRecord.metadata } } : {}),
      } satisfies StoredToolLoopMessageIdentity
    : null;
  const requestText = toString(payload.requestText).trim();
  if (llmMessages.length === 0 || pendingTools.length === 0 || !originalMessage || !originalMessage.id || !originalMessage.userId || !originalMessage.channel || !requestText) {
    return null;
  }
  const contentTrustLevel = payload.contentTrustLevel === 'trusted'
    || payload.contentTrustLevel === 'low_trust'
    || payload.contentTrustLevel === 'quarantined'
    ? payload.contentTrustLevel
    : 'trusted';
  const taintReasons = Array.isArray(payload.taintReasons)
    ? payload.taintReasons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const activeSkillIds = Array.isArray(payload.activeSkillIds)
    ? payload.activeSkillIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const codeContext = isRecord(payload.codeContext) && toString(payload.codeContext.workspaceRoot).trim()
    ? {
        workspaceRoot: toString(payload.codeContext.workspaceRoot).trim(),
        ...(toString(payload.codeContext.sessionId).trim() ? { sessionId: toString(payload.codeContext.sessionId).trim() } : {}),
      }
    : undefined;
  const selectedExecutionProfile = isRecord(payload.selectedExecutionProfile)
    ? readSelectedExecutionProfileMetadata({
        [EXECUTION_PROFILE_METADATA_KEY]: payload.selectedExecutionProfile,
      })
    : null;
  return {
    type: TOOL_LOOP_RESUME_TYPE_SUSPENDED_APPROVAL,
    llmMessages,
    pendingTools,
    originalMessage,
    requestText,
    referenceTime: toNumber(payload.referenceTime) ?? Date.now(),
    allowModelMemoryMutation: payload.allowModelMemoryMutation === true,
    activeSkillIds,
    contentTrustLevel,
    taintReasons,
    ...(isRecord(payload.intentDecision) ? { intentDecision: payload.intentDecision as unknown as IntentGatewayDecision } : {}),
    ...(codeContext ? { codeContext } : {}),
    ...(selectedExecutionProfile ? { selectedExecutionProfile } : {}),
  };
}

function normalizeStoredPrincipalRole(value: string | undefined): PrincipalRole | undefined {
  switch (value) {
    case 'owner':
    case 'operator':
    case 'approver':
    case 'viewer':
      return value;
    default:
      return undefined;
  }
}
