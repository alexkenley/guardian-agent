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
import { normalizeFileExtension } from '../intent/normalization.js';
import {
  hasRequiredReadOrSearchPlannedStep,
  hasRequiredReadWritePlan,
  hasRequiredToolBackedAnswerPlan,
} from '../intent/planned-steps.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import {
  toPendingActionClientMetadata,
  type PendingActionBlocker,
  type PendingActionRecord,
} from '../pending-actions.js';
import {
  parseDirectFilesystemSaveReference,
  parseDirectFilesystemSaveIntent,
  parseDirectFileSearchIntent,
} from '../search-intent.js';
import type { DirectFileSearchIntent } from '../search-intent.js';
import {
  normalizeChatContinuationPrincipalRole,
} from './chat-continuation-payloads.js';
import type { StoredFilesystemSaveInput } from './filesystem-save-resume.js';
import type { PendingActionSetResult } from './orchestration-state.js';

const FILESYSTEM_SAVE_TARGET_CLARIFICATION_PROMPT = 'What file name or full path should I use to save the previous assistant output?';
const DIRECT_FILE_EXTENSION_SEARCH_MAX_RESULTS = 200;
const DIRECT_FILE_EXTENSION_SEARCH_MAX_DEPTH = 20;
const DIRECT_FILE_EXTENSION_SEARCH_MAX_FILES = 20_000;

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
    if (content === FILESYSTEM_SAVE_TARGET_CLARIFICATION_PROMPT) continue;
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
  parsePendingActionUserKey?: (userKey: string) => { userId: string; channel: string };
  setClarificationPendingAction?: (
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: {
      blockerKind: PendingActionBlocker['kind'];
      field?: string;
      prompt: string;
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
    },
  ) => PendingActionSetResult;
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
  const directSave = await tryDirectFilesystemSave(input);
  if (directSave) return directSave;
  if (shouldDeferFilesystemIntentToOrchestration(input)) {
    return null;
  }
  return tryDirectFilesystemSearch(input);
}

function shouldDeferFilesystemIntentToOrchestration(input: DirectFilesystemIntentInput): boolean {
  const decision = input.gatewayDecision;
  if (!decision) return false;
  if (isDirectFileExtensionSearchDecision(decision, input.codeContext?.workspaceRoot)) {
    return false;
  }
  const hasReadOrSearchStep = hasRequiredReadOrSearchPlannedStep(decision);
  if (
    decision.executionClass === 'tool_orchestration'
    || decision.preferredAnswerPath === 'tool_loop'
    || decision.requiresToolSynthesis === true
  ) {
    return true;
  }
  if (hasRequiredReadWritePlan(decision)) {
    return true;
  }
  const repoGroundedAnswer = decision.route === 'coding_task'
    || decision.executionClass === 'repo_grounded'
    || decision.requiresRepoGrounding === true
    || decision.requireExactFileReferences === true;
  if (repoGroundedAnswer && hasRequiredToolBackedAnswerPlan(decision)) {
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

type DirectFilesystemSearchExecutionIntent = DirectFileSearchIntent & {
  mode?: 'name' | 'content' | 'auto';
  maxResults?: number;
  maxDepth?: number;
  maxFiles?: number;
};

function isDirectFileExtensionSearchDecision(
  decision: IntentGatewayDecision,
  workspaceRoot: string | undefined,
): boolean {
  if (!workspaceRoot) return false;
  if (decision.operation !== 'search') return false;
  if (decision.route !== 'coding_task' && decision.route !== 'filesystem_task') return false;
  if (!normalizeFileExtension(decision.entities.fileExtension)) return false;
  if (!hasOnlyReadSearchAnswerPlan(decision)) return false;
  return !hasRequiredReadWritePlan(decision);
}

function hasOnlyReadSearchAnswerPlan(decision: IntentGatewayDecision): boolean {
  const steps = decision.plannedSteps ?? [];
  if (steps.length === 0) return true;
  return steps.every((step) => {
    if (step.kind !== 'read' && step.kind !== 'search' && step.kind !== 'answer') return false;
    const categories = step.expectedToolCategories ?? [];
    return !categories.some((category) => /(?:write|create|update|delete|move|copy|mkdir|session)/i.test(category));
  });
}

function buildStructuredDirectFilesystemSearchIntent(
  input: DirectFilesystemIntentInput,
): DirectFilesystemSearchExecutionIntent | null {
  const decision = input.gatewayDecision;
  if (!decision || !isDirectFileExtensionSearchDecision(decision, input.codeContext?.workspaceRoot)) {
    return null;
  }
  const fileExtension = normalizeFileExtension(decision.entities.fileExtension);
  if (!fileExtension) return null;
  return {
    path: toString(decision.entities.path).trim() || input.codeContext!.workspaceRoot,
    query: fileExtension,
    mode: 'name',
    maxResults: DIRECT_FILE_EXTENSION_SEARCH_MAX_RESULTS,
    maxDepth: DIRECT_FILE_EXTENSION_SEARCH_MAX_DEPTH,
    maxFiles: DIRECT_FILE_EXTENSION_SEARCH_MAX_FILES,
  };
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
  if (!intent) {
    const missingTarget = parseDirectFilesystemSaveReference(stripLeadingContextPrefix(input.message.content), { pathHint })
      ?? parseDirectFilesystemSaveReference(stripLeadingContextPrefix(input.originalUserContent ?? ''), { pathHint });
    return missingTarget
      ? buildMissingFilesystemSaveTargetResponse(input)
      : null;
  }

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

function buildMissingFilesystemSaveTargetResponse(input: DirectFilesystemIntentInput): DirectRouteRuntimeResponse {
  const prompt = FILESYSTEM_SAVE_TARGET_CLARIFICATION_PROMPT;
  if (!input.parsePendingActionUserKey || !input.setClarificationPendingAction) {
    return { content: prompt };
  }
  const { userId, channel } = input.parsePendingActionUserKey(input.userKey);
  const pendingActionResult = input.setClarificationPendingAction(
    userId,
    channel,
    input.message.surfaceId,
    {
      blockerKind: 'clarification',
      field: 'path',
      prompt,
      originalUserContent: input.message.content,
      route: 'filesystem_task',
      operation: 'save',
      summary: 'Save the previous assistant output to a file.',
      turnRelation: input.gatewayDecision?.turnRelation ?? 'new_request',
      resolution: 'needs_clarification',
      missingFields: ['path'],
      provenance: input.gatewayDecision?.provenance,
      ...(input.gatewayDecision?.entities
        ? { entities: { ...input.gatewayDecision.entities } }
        : {}),
    },
  );
  return {
    content: pendingActionResult.collisionPrompt ?? prompt,
    metadata: pendingActionResult.action
      ? { pendingAction: toPendingActionClientMetadata(pendingActionResult.action) }
      : undefined,
  };
}

export async function tryDirectFilesystemSearch(input: DirectFilesystemIntentInput) {
  if (!input.tools?.isEnabled()) return null;

  const intent: DirectFilesystemSearchExecutionIntent | null = buildStructuredDirectFilesystemSearchIntent(input)
    ?? parseDirectFileSearchIntent(input.message.content, input.tools.getPolicy(), {
      fallbackPath: input.codeContext?.workspaceRoot,
    });
  if (!intent) return null;

  const toolResult = await input.tools.executeModelTool(
    'fs_search',
    {
      path: intent.path,
      query: intent.query,
      mode: intent.mode ?? 'auto',
      maxResults: intent.maxResults ?? 50,
      maxDepth: intent.maxDepth ?? 20,
      ...(typeof intent.maxFiles === 'number' ? { maxFiles: intent.maxFiles } : {}),
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
