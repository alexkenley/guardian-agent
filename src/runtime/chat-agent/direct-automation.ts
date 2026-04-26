import type { AgentContext, UserMessage } from '../../agent/types.js';
import { isRecord, toString } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import { tryAutomationPreRoute } from '../automation-prerouter.js';
import { tryAutomationControlPreRoute } from '../automation-control-prerouter.js';
import { tryAutomationOutputPreRoute } from '../automation-output-prerouter.js';
import { tryBrowserPreRoute } from '../browser-prerouter.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type {
  PendingActionApprovalSummary,
  PendingActionBlocker,
  PendingActionRecord,
} from '../pending-actions.js';
import { toPendingActionClientMetadata } from '../pending-actions.js';
import { toPendingActionEntities } from './intent-gateway-orchestration.js';
import type { AutomationApprovalContinuationStore } from './automation-approval-continuation.js';

interface DirectAutomationClarificationMetadata {
  blockerKind: PendingActionBlocker['kind'];
  field?: string;
  prompt: string;
  route?: string;
  operation?: string;
  summary?: string;
  resolution?: string;
  missingFields?: string[];
  entities?: Record<string, unknown>;
  options?: PendingActionBlocker['options'];
}

export interface DirectAutomationDeps {
  agentId: string;
  tools?: Pick<
    ToolExecutor,
    'isEnabled' | 'getPolicy' | 'preflightTools' | 'executeModelTool' | 'getApprovalSummaries'
  > | null;
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved: string; denied: string },
  ) => void;
  automationContinuations: Pick<AutomationApprovalContinuationStore, 'clear' | 'set'>;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string }>,
  ) => string;
  parsePendingActionUserKey: (userKey: string) => { userId: string; channel: string };
  setClarificationPendingAction: (
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
    },
  ) => { collisionPrompt?: string; action: PendingActionRecord | null };
  setPendingApprovalActionForRequest: (
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
      codeSessionId?: string;
    },
  ) => { action: PendingActionRecord | null; collisionPrompt?: string };
  buildPendingApprovalBlockedResponse: (
    result: { action: PendingActionRecord | null; collisionPrompt?: string },
    fallbackContent: string,
  ) => { content: string; metadata?: Record<string, unknown> };
  runAutomationPreRoute?: typeof tryAutomationPreRoute;
  runAutomationControlPreRoute?: typeof tryAutomationControlPreRoute;
  runAutomationOutputPreRoute?: typeof tryAutomationOutputPreRoute;
  runBrowserPreRoute?: typeof tryBrowserPreRoute;
}

function resolvePendingApprovalMetadata(
  tools: DirectAutomationDeps['tools'],
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

function readDirectAutomationClarificationMetadata(
  metadata: Record<string, unknown> | undefined,
): DirectAutomationClarificationMetadata | null {
  if (!metadata || !isRecord(metadata.clarification)) return null;
  const clarification = metadata.clarification;
  const prompt = toString(clarification.prompt).trim();
  if (!prompt) return null;
  return {
    blockerKind: clarification.blockerKind === 'workspace_switch'
      ? 'workspace_switch'
      : clarification.blockerKind === 'auth'
        ? 'auth'
        : clarification.blockerKind === 'policy'
          ? 'policy'
          : clarification.blockerKind === 'missing_context'
            ? 'missing_context'
            : 'clarification',
    ...(toString(clarification.field).trim() ? { field: toString(clarification.field).trim() } : {}),
    prompt,
    ...(toString(clarification.route).trim() ? { route: toString(clarification.route).trim() } : {}),
    ...(toString(clarification.operation).trim() ? { operation: toString(clarification.operation).trim() } : {}),
    ...(toString(clarification.summary).trim() ? { summary: toString(clarification.summary).trim() } : {}),
    ...(toString(clarification.resolution).trim() ? { resolution: toString(clarification.resolution).trim() } : {}),
    ...(Array.isArray(clarification.missingFields)
      ? {
          missingFields: clarification.missingFields
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {}),
    ...(isRecord(clarification.entities) ? { entities: { ...clarification.entities } } : {}),
    ...(Array.isArray(clarification.options)
      ? {
          options: clarification.options
            .filter((value): value is Record<string, unknown> => isRecord(value) && toString(value.value).trim().length > 0)
            .map((value) => ({
              value: toString(value.value).trim(),
              label: toString(value.label).trim() || toString(value.value).trim(),
              ...(toString(value.description).trim() ? { description: toString(value.description).trim() } : {}),
            })),
        }
      : {}),
  };
}

function stripDirectAutomationClarificationMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const next = { ...metadata };
  delete next.clarification;
  return Object.keys(next).length > 0 ? next : undefined;
}

export async function tryDirectAutomationAuthoring(input: {
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  codeContext?: { workspaceRoot?: string };
  options?: {
    allowRemediation?: boolean;
    assumeAuthoring?: boolean;
    intentDecision?: IntentGatewayDecision | null;
  };
}, deps: DirectAutomationDeps): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!deps.tools?.isEnabled()) return null;
  const codeWorkspaceRoot = input.codeContext?.workspaceRoot?.trim();
  const allowedPaths = codeWorkspaceRoot
    ? [codeWorkspaceRoot]
    : deps.tools.getPolicy().sandbox.allowedPaths;
  const trackedPendingApprovalIds: string[] = [];
  const result = await (deps.runAutomationPreRoute ?? tryAutomationPreRoute)({
    agentId: deps.agentId,
    message: input.message,
    checkAction: input.ctx.checkAction,
    preflightTools: (requests) => deps.tools!.preflightTools(requests),
    workspaceRoot: allowedPaths[0] || process.cwd(),
    allowedPaths,
    executeTool: (toolName, args, request) => deps.tools!.executeModelTool(toolName, args, request),
    trackPendingApproval: (approvalId) => {
      trackedPendingApprovalIds.push(approvalId);
    },
    onPendingApproval: ({ approvalId, automationName, artifactLabel, verb }) => {
      deps.setApprovalFollowUp(approvalId, {
        approved: `I ${verb} the ${artifactLabel} '${automationName}'.`,
        denied: `I did not ${verb === 'updated' ? 'update' : 'create'} the ${artifactLabel} '${automationName}'.`,
      });
    },
    formatPendingApprovalPrompt: (ids) => deps.formatPendingApprovalPrompt(ids),
    resolvePendingApprovalMetadata: (ids, fallback) => resolvePendingApprovalMetadata(deps.tools, ids, fallback),
  }, input.options);
  if (!result) {
    deps.automationContinuations.clear(input.userKey);
    return null;
  }
  if (trackedPendingApprovalIds.length > 0) {
    const prompt = isRecord(result.metadata?.pendingAction) && isRecord(result.metadata?.pendingAction.blocker)
      && typeof result.metadata.pendingAction.blocker.prompt === 'string'
      ? result.metadata.pendingAction.blocker.prompt
      : deps.formatPendingApprovalPrompt(trackedPendingApprovalIds);
    const summaries = deps.tools?.getApprovalSummaries(trackedPendingApprovalIds);
    const pendingActionResult = deps.setPendingApprovalActionForRequest(
      input.userKey,
      input.message.surfaceId,
      {
        prompt,
        approvalIds: trackedPendingApprovalIds,
        approvalSummaries: buildPendingApprovalMetadata(trackedPendingApprovalIds, summaries),
        originalUserContent: input.message.content,
        route: input.options?.intentDecision?.route ?? 'automation_authoring',
        operation: input.options?.intentDecision?.operation ?? 'create',
        summary: input.options?.intentDecision?.summary ?? 'Creates or updates a Guardian automation.',
        turnRelation: input.options?.intentDecision?.turnRelation ?? 'new_request',
        resolution: input.options?.intentDecision?.resolution ?? 'ready',
        provenance: input.options?.intentDecision?.provenance,
        entities: toPendingActionEntities(input.options?.intentDecision?.entities),
      },
    );
    const mergedResult = deps.buildPendingApprovalBlockedResponse(pendingActionResult, result.content);
    result.content = mergedResult.content;
    result.metadata = {
      ...(result.metadata ?? {}),
      ...(mergedResult.metadata ?? {}),
    };
  }
  if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
    deps.automationContinuations.set(input.userKey, input.message, input.ctx, trackedPendingApprovalIds);
  } else {
    deps.automationContinuations.clear(input.userKey);
  }
  return result;
}

export async function tryDirectAutomationControl(input: {
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  intentDecision?: IntentGatewayDecision | null;
  continuityThread?: ContinuityThreadRecord | null;
}, deps: DirectAutomationDeps): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!deps.tools?.isEnabled()) return null;
  const trackedPendingApprovalIds: string[] = [];
  const result = await (deps.runAutomationControlPreRoute ?? tryAutomationControlPreRoute)({
    agentId: deps.agentId,
    message: input.message,
    continuityThread: input.continuityThread,
    checkAction: input.ctx.checkAction,
    executeTool: (toolName, args, request) => deps.tools!.executeModelTool(toolName, args, request),
    trackPendingApproval: (approvalId) => {
      trackedPendingApprovalIds.push(approvalId);
    },
    onPendingApproval: ({ approvalId, approved, denied }) => {
      deps.setApprovalFollowUp(approvalId, { approved, denied });
    },
    formatPendingApprovalPrompt: (ids) => deps.formatPendingApprovalPrompt(ids),
    resolvePendingApprovalMetadata: (ids, fallback) => resolvePendingApprovalMetadata(deps.tools, ids, fallback),
  }, { intentDecision: input.intentDecision });
  if (!result) return null;
  const resultMetadata = result.metadata;
  const clarification = readDirectAutomationClarificationMetadata(result.metadata);
  if (clarification) {
    const { userId, channel } = deps.parsePendingActionUserKey(input.userKey);
    const pendingActionResult = deps.setClarificationPendingAction(
      userId,
      channel,
      input.message.surfaceId,
      {
        blockerKind: clarification.blockerKind,
        ...(clarification.field ? { field: clarification.field } : {}),
        prompt: clarification.prompt,
        originalUserContent: input.message.content,
        route: clarification.route ?? input.intentDecision?.route ?? 'automation_control',
        operation: clarification.operation ?? input.intentDecision?.operation ?? 'update',
        summary: clarification.summary ?? input.intentDecision?.summary ?? clarification.prompt,
        turnRelation: input.intentDecision?.turnRelation ?? 'new_request',
        resolution: clarification.resolution ?? input.intentDecision?.resolution ?? 'needs_clarification',
        missingFields: clarification.missingFields ?? input.intentDecision?.missingFields,
        provenance: input.intentDecision?.provenance,
        entities: toPendingActionEntities(clarification.entities ?? input.intentDecision?.entities),
        options: clarification.options,
      },
    );
    return {
      content: pendingActionResult.collisionPrompt ?? clarification.prompt,
      metadata: {
        ...(stripDirectAutomationClarificationMetadata(resultMetadata) ?? {}),
        ...(pendingActionResult.action ? { pendingAction: toPendingActionClientMetadata(pendingActionResult.action) } : {}),
      },
    };
  }
  if (trackedPendingApprovalIds.length > 0) {
    const prompt = isRecord(resultMetadata?.pendingAction) && isRecord(resultMetadata?.pendingAction.blocker)
      && typeof resultMetadata.pendingAction.blocker.prompt === 'string'
      ? resultMetadata.pendingAction.blocker.prompt
      : deps.formatPendingApprovalPrompt(trackedPendingApprovalIds);
    const summaries = deps.tools?.getApprovalSummaries(trackedPendingApprovalIds);
    const pendingActionResult = deps.setPendingApprovalActionForRequest(
      input.userKey,
      input.message.surfaceId,
      {
        prompt,
        approvalIds: trackedPendingApprovalIds,
        approvalSummaries: buildPendingApprovalMetadata(trackedPendingApprovalIds, summaries),
        originalUserContent: input.message.content,
        route: input.intentDecision?.route ?? 'automation_control',
        operation: input.intentDecision?.operation ?? 'run',
        summary: input.intentDecision?.summary ?? 'Runs or updates an existing automation.',
        turnRelation: input.intentDecision?.turnRelation ?? 'new_request',
        resolution: input.intentDecision?.resolution ?? 'ready',
        provenance: input.intentDecision?.provenance,
        entities: toPendingActionEntities(input.intentDecision?.entities),
      },
    );
    const mergedResult = deps.buildPendingApprovalBlockedResponse(pendingActionResult, result.content);
    return {
      content: mergedResult.content,
      metadata: {
        ...(resultMetadata ?? {}),
        ...(mergedResult.metadata ?? {}),
      },
    };
  }
  return resultMetadata
    ? {
        ...result,
        metadata: resultMetadata,
      }
    : {
        content: result.content,
      };
}

export async function tryDirectAutomationOutput(input: {
  message: UserMessage;
  ctx: AgentContext;
  intentDecision?: IntentGatewayDecision | null;
}, deps: DirectAutomationDeps): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!deps.tools?.isEnabled()) return null;
  return (deps.runAutomationOutputPreRoute ?? tryAutomationOutputPreRoute)({
    agentId: deps.agentId,
    message: input.message,
    checkAction: input.ctx.checkAction,
    executeTool: (toolName, args, request) => deps.tools!.executeModelTool(toolName, args, request),
  }, {
    intentDecision: input.intentDecision,
  });
}

export async function tryDirectBrowserAutomation(input: {
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  codeContext?: { workspaceRoot?: string; sessionId?: string };
  intentDecision?: IntentGatewayDecision | null;
  continuityThread?: ContinuityThreadRecord | null;
}, deps: DirectAutomationDeps): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!deps.tools?.isEnabled()) return null;
  const scopedCodeContext = input.codeContext?.workspaceRoot
    ? {
        workspaceRoot: input.codeContext.workspaceRoot,
        ...(input.codeContext.sessionId ? { sessionId: input.codeContext.sessionId } : {}),
      }
    : undefined;

  const trackedPendingApprovalIds: string[] = [];
  const result = await (deps.runBrowserPreRoute ?? tryBrowserPreRoute)({
    agentId: deps.agentId,
    message: input.message,
    continuityThread: input.continuityThread,
    checkAction: input.ctx.checkAction,
    executeTool: (toolName, args, request) => deps.tools!.executeModelTool(toolName, args, {
      ...request,
      ...(scopedCodeContext ? { codeContext: scopedCodeContext } : {}),
    }),
    trackPendingApproval: (approvalId) => {
      trackedPendingApprovalIds.push(approvalId);
    },
    onPendingApproval: ({ approvalId, approved, denied }) => {
      deps.setApprovalFollowUp(approvalId, { approved, denied });
    },
    formatPendingApprovalPrompt: (ids) => deps.formatPendingApprovalPrompt(ids),
    resolvePendingApprovalMetadata: (ids, fallback) => resolvePendingApprovalMetadata(deps.tools, ids, fallback),
  }, { intentDecision: input.intentDecision });
  if (!result) return null;
  if (trackedPendingApprovalIds.length > 0) {
    const prompt = isRecord(result.metadata?.pendingAction) && isRecord(result.metadata?.pendingAction.blocker)
      && typeof result.metadata.pendingAction.blocker.prompt === 'string'
      ? result.metadata.pendingAction.blocker.prompt
      : deps.formatPendingApprovalPrompt(trackedPendingApprovalIds);
    const summaries = deps.tools?.getApprovalSummaries(trackedPendingApprovalIds);
    const pendingActionResult = deps.setPendingApprovalActionForRequest(
      input.userKey,
      input.message.surfaceId,
      {
        prompt,
        approvalIds: trackedPendingApprovalIds,
        approvalSummaries: buildPendingApprovalMetadata(trackedPendingApprovalIds, summaries),
        originalUserContent: input.message.content,
        route: input.intentDecision?.route ?? 'browser_task',
        operation: input.intentDecision?.operation ?? 'navigate',
        summary: input.intentDecision?.summary ?? 'Runs a direct browser action.',
        turnRelation: input.intentDecision?.turnRelation ?? 'new_request',
        resolution: input.intentDecision?.resolution ?? 'ready',
        provenance: input.intentDecision?.provenance,
        entities: toPendingActionEntities(input.intentDecision?.entities),
        ...(scopedCodeContext?.sessionId ? { codeSessionId: scopedCodeContext.sessionId } : {}),
      },
    );
    const mergedResult = deps.buildPendingApprovalBlockedResponse(pendingActionResult, result.content);
    return {
      content: mergedResult.content,
      metadata: {
        ...(result.metadata ?? {}),
        ...(mergedResult.metadata ?? {}),
      },
    };
  }
  return result;
}
