import type { DirectAutomationDeps } from './direct-automation.js';
import type { DirectMailboxDeps } from './direct-mailbox-runtime.js';
import type { DirectScheduledEmailAutomationDeps } from './direct-scheduled-email-automation.js';

export interface DirectRuntimeDepsInput {
  agentId: string;
  tools?: DirectAutomationDeps['tools'];
  conversationService?: DirectScheduledEmailAutomationDeps['conversationService'];
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved?: string; denied?: string },
  ) => void;
  getPendingApprovals: (
    userKey: string,
    surfaceId?: string,
    nowMs?: number,
  ) => { ids: string[]; createdAt: number; expiresAt: number } | null;
  formatPendingApprovalPrompt: DirectAutomationDeps['formatPendingApprovalPrompt'];
  parsePendingActionUserKey: DirectAutomationDeps['parsePendingActionUserKey'];
  setClarificationPendingAction: DirectAutomationDeps['setClarificationPendingAction'];
  setPendingApprovalActionForRequest: DirectAutomationDeps['setPendingApprovalActionForRequest'];
  setChatContinuationGraphPendingApprovalActionForRequest: DirectAutomationDeps['setChatContinuationGraphPendingApprovalActionForRequest'];
  buildPendingApprovalBlockedResponse: DirectAutomationDeps['buildPendingApprovalBlockedResponse'];
}

export function buildDirectMailboxDeps(input: DirectRuntimeDepsInput): DirectMailboxDeps {
  return {
    agentId: input.agentId,
    tools: input.tools,
    setApprovalFollowUp: input.setApprovalFollowUp,
    getPendingApprovals: input.getPendingApprovals,
    formatPendingApprovalPrompt: input.formatPendingApprovalPrompt,
    setPendingApprovalActionForRequest: input.setPendingApprovalActionForRequest,
    buildPendingApprovalBlockedResponse: input.buildPendingApprovalBlockedResponse,
  };
}

export function buildDirectAutomationDeps(input: DirectRuntimeDepsInput): DirectAutomationDeps {
  return {
    agentId: input.agentId,
    tools: input.tools,
    setApprovalFollowUp: input.setApprovalFollowUp,
    formatPendingApprovalPrompt: input.formatPendingApprovalPrompt,
    parsePendingActionUserKey: input.parsePendingActionUserKey,
    setClarificationPendingAction: input.setClarificationPendingAction,
    setPendingApprovalActionForRequest: input.setPendingApprovalActionForRequest,
    setChatContinuationGraphPendingApprovalActionForRequest: input.setChatContinuationGraphPendingApprovalActionForRequest,
    buildPendingApprovalBlockedResponse: input.buildPendingApprovalBlockedResponse,
  };
}

export function buildDirectScheduledEmailAutomationDeps(
  input: DirectRuntimeDepsInput,
): DirectScheduledEmailAutomationDeps {
  return {
    agentId: input.agentId,
    tools: input.tools,
    conversationService: input.conversationService,
    setApprovalFollowUp: input.setApprovalFollowUp,
    getPendingApprovals: input.getPendingApprovals,
    formatPendingApprovalPrompt: input.formatPendingApprovalPrompt,
    setPendingApprovalActionForRequest: input.setPendingApprovalActionForRequest,
    buildPendingApprovalBlockedResponse: input.buildPendingApprovalBlockedResponse,
  };
}
