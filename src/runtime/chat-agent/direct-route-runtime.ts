import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  formatDirectFilesystemSearchResponse,
  stripLeadingContextPrefix,
  toBoolean,
  toNumber,
  toString,
} from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ConversationKey, ConversationService } from '../conversation.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  hasRequiredReadOrSearchPlannedStep,
  hasRequiredReadWritePlan,
} from '../intent/planned-steps.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  parseDirectFilesystemSaveIntent,
  parseDirectFileSearchIntent,
} from '../search-intent.js';
import {
  normalizeChatContinuationPrincipalRole,
} from './chat-continuation-payloads.js';
import type { StoredFilesystemSaveInput } from './filesystem-save-resume.js';
import type { PendingActionSetResult } from './orchestration-state.js';

export interface DirectRouteRuntimeResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

export function readLatestAssistantOutput(input: {
  conversationService?: Pick<ConversationService, 'getSessionHistory'> | null;
  conversationKey: ConversationKey;
}): string {
  if (!input.conversationService) return '';
  const history = input.conversationService.getSessionHistory(input.conversationKey, { limit: 40 });
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'assistant') continue;
    const content = entry.content.trim();
    if (content) return content;
  }
  return '';
}

export interface DirectFilesystemIntentInput {
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  conversationKey: ConversationKey;
  codeContext?: { workspaceRoot: string; sessionId?: string };
  originalUserContent?: string;
  gatewayDecision?: IntentGatewayDecision;
  agentId: string;
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'getApprovalSummaries' | 'getPolicy' | 'isEnabled'> | null;
  conversationService?: Pick<ConversationService, 'getSessionHistory'> | null;
  executeStoredFilesystemSave: (
    input: StoredFilesystemSaveInput,
  ) => Promise<string | DirectRouteRuntimeResponse>;
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved?: string; denied?: string },
  ) => void;
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
      approvalSummaries?: PendingActionRecord['blocker']['approvalSummaries'];
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
  buildPendingApprovalBlockedResponse: (
    result: PendingActionSetResult,
    fallbackContent: string,
  ) => DirectRouteRuntimeResponse;
}

export async function tryDirectFilesystemIntent(input: DirectFilesystemIntentInput): Promise<string | DirectRouteRuntimeResponse | null> {
  if (shouldDeferFilesystemIntentToOrchestration(input)) {
    return null;
  }
  const directSave = await tryDirectFilesystemSave(input);
  if (directSave) return directSave;
  return tryDirectFilesystemSearch(input);
}

function shouldDeferFilesystemIntentToOrchestration(input: DirectFilesystemIntentInput): boolean {
  const decision = input.gatewayDecision;
  if (!decision) return false;
  const hasReadOrSearchStep = hasRequiredReadOrSearchPlannedStep(decision);
  if (hasRequiredReadWritePlan(decision)) {
    return true;
  }
  if (decision.operation === 'save' && decision.turnRelation !== 'new_request' && !hasReadOrSearchStep) {
    return false;
  }
  const mutatingOperation = decision.operation === 'create'
    || decision.operation === 'update'
    || decision.operation === 'delete'
    || decision.operation === 'save';
  if (!mutatingOperation) {
    return false;
  }
  return true;
}

export async function tryDirectFilesystemSave(input: DirectFilesystemIntentInput) {
  if (!input.tools?.isEnabled() || !input.conversationService) return null;

  const pathHint = toString(input.gatewayDecision?.entities.path).trim() || undefined;
  const intent = parseDirectFilesystemSaveIntent(stripLeadingContextPrefix(input.message.content), {
    fallbackDirectory: input.codeContext?.workspaceRoot,
    pathHint,
  }) ?? parseDirectFilesystemSaveIntent(stripLeadingContextPrefix(input.originalUserContent ?? ''), {
    fallbackDirectory: input.codeContext?.workspaceRoot,
    pathHint,
  });
  if (!intent) return null;

  const lastAssistantOutput = readLatestAssistantOutput({
    conversationService: input.conversationService,
    conversationKey: input.conversationKey,
  });
  if (!lastAssistantOutput) {
    return 'I could not find a previous assistant output to save yet.';
  }

  return input.executeStoredFilesystemSave({
    targetPath: intent.path,
    content: lastAssistantOutput,
    originalUserContent: input.message.content,
    userKey: input.userKey,
    userId: input.message.userId,
    channel: input.message.channel,
    surfaceId: input.message.surfaceId,
    principalId: input.message.principalId ?? input.message.userId,
    principalRole: normalizeChatContinuationPrincipalRole(input.message.principalRole) ?? 'owner',
    requestId: input.message.id,
    agentCheckAction: input.ctx.checkAction,
    codeContext: input.codeContext,
    allowPathRemediation: true,
  });
}

export async function tryDirectFilesystemSearch(input: DirectFilesystemIntentInput) {
  if (!input.tools?.isEnabled()) return null;

  const intent = parseDirectFileSearchIntent(input.message.content, input.tools.getPolicy(), {
    fallbackPath: input.codeContext?.workspaceRoot,
  });
  if (!intent) return null;

  const toolResult = await input.tools.executeModelTool(
    'fs_search',
    {
      path: intent.path,
      query: intent.query,
      mode: 'auto',
      maxResults: 50,
      maxDepth: 20,
    },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
      ...(input.codeContext ? { codeContext: input.codeContext } : {}),
    },
  );

  if (!toBoolean(toolResult.success)) {
    const status = toString(toolResult.status);
    if (status === 'pending_approval') {
      const approvalId = toString(toolResult.approvalId);
      const existingIds = input.getPendingApprovals(input.userKey)?.ids ?? [];
      const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
      if (approvalId) {
        input.setApprovalFollowUp(approvalId, {
          approved: `I completed the filesystem search for "${intent.query}".`,
          denied: `I did not run the filesystem search for "${intent.query}".`,
        });
      }
      const summaries = pendingIds.length > 0 ? input.tools?.getApprovalSummaries(pendingIds) : undefined;
      const prompt = input.formatPendingApprovalPrompt(pendingIds, summaries);
      const pendingActionResult = input.setPendingApprovalActionForRequest(
        input.userKey,
        input.message.surfaceId,
        {
          prompt,
          approvalIds: pendingIds,
          approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
          originalUserContent: input.message.content,
          route: 'filesystem_task',
          operation: 'search',
          summary: 'Runs a filesystem search in the requested path.',
          turnRelation: 'new_request',
          resolution: 'ready',
        },
      );
      return input.buildPendingApprovalBlockedResponse(pendingActionResult, [
        `I prepared a filesystem search for "${intent.query}" but it needs approval first.`,
        prompt,
      ].filter(Boolean).join('\n\n'));
    }
    const message = toString(toolResult.message) || 'Search failed.';
    return `I attempted a filesystem search in "${intent.path}" for "${intent.query}" but it failed: ${message}`;
  }

  const output = (toolResult.output && typeof toolResult.output === 'object'
    ? toolResult.output
    : null) as {
      root?: unknown;
      scannedFiles?: unknown;
      truncated?: unknown;
      matches?: unknown;
    } | null;
  const root = output ? toString(output.root) : intent.path;
  const scannedFiles = output ? toNumber(output.scannedFiles) : null;
  const truncated = output ? toBoolean(output.truncated) : false;
  const matches = output && Array.isArray(output.matches)
    ? output.matches as Array<{ relativePath?: unknown; path?: unknown; matchType?: unknown; snippet?: unknown }>
    : [];

  return formatDirectFilesystemSearchResponse({
    requestText: input.message.content,
    root: root || intent.path,
    query: intent.query,
    scannedFiles,
    truncated,
    matches,
  });
}
