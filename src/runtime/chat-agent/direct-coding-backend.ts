import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  formatDirectCodeSessionLine,
  isRecord,
  normalizeCodingBackendSelection,
  stripLeadingContextPrefix,
  toBoolean,
  toNumber,
  toString,
} from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { CodeSessionRecord, CodeSessionStore } from '../code-sessions.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { IntentRoutingTraceStage } from '../intent-routing-trace.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type {
  PendingActionApprovalSummary,
  PendingActionRecord,
} from '../pending-actions.js';
import { toPendingActionClientMetadata } from '../pending-actions.js';
import { buildCodingBackendRunResumePayload } from './coding-backend-resume.js';
import {
  buildCodingBackendResponseSource,
  selectCodingBackendDelegatedTask,
} from './direct-intent-helpers.js';
import { toPendingActionEntities } from './intent-gateway-orchestration.js';
import type { PendingActionSetResult } from './orchestration-state.js';

type DirectCodingBackendResponse = {
  content: string;
  metadata?: Record<string, unknown>;
};

type ExplicitCodingTaskWorkspaceTargetResult =
  | {
      status: 'unchanged';
    }
  | {
      status: 'switched';
      currentSession: CodeSessionRecord | null;
      codeContext: { workspaceRoot: string; sessionId: string };
      switchResponse: { content: string; metadata: Record<string, unknown> };
    }
  | {
      status: 'blocked';
      response: DirectCodingBackendResponse;
    };

export interface DirectCodingBackendDeps {
  agentId: string;
  tools?: Pick<ToolExecutor, 'isEnabled' | 'executeModelTool' | 'getApprovalSummaries'> | null;
  codeSessionStore?: Pick<CodeSessionStore, 'getSession'> | null;
  parsePendingActionUserKey: (userKey: string) => { userId: string; channel: string };
  ensureExplicitCodingTaskWorkspaceTarget: (input: {
    message: UserMessage;
    ctx: AgentContext;
    decision?: IntentGatewayDecision;
    currentSession?: CodeSessionRecord | null;
    codeContext?: { workspaceRoot: string; sessionId?: string };
  }) => Promise<ExplicitCodingTaskWorkspaceTargetResult>;
  recordIntentRoutingTrace: (
    stage: IntentRoutingTraceStage,
    input: {
      message?: UserMessage;
      requestId?: string;
      details?: Record<string, unknown>;
      contentPreview?: string;
    },
  ) => void;
  getPendingApprovalIds: (userId: string, channel: string, surfaceId?: string) => string[];
  setPendingApprovals: (
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs?: number,
  ) => void;
  syncPendingApprovalsFromExecutor: (
    sourceUserId: string,
    sourceChannel: string,
    targetUserId: string,
    targetChannel: string,
    surfaceId?: string,
    originalUserContent?: string,
  ) => void;
  setPendingApprovalAction: (
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
  ) => PendingActionSetResult;
}

export async function tryDirectCodingBackendDelegation(
  input: {
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
    decision?: IntentGatewayDecision;
    codeContext?: { sessionId?: string; workspaceRoot: string };
  },
  deps: DirectCodingBackendDeps,
): Promise<DirectCodingBackendResponse | null> {
  if (!deps.tools?.isEnabled()) return null;
  const decision = input.decision;
  if (!decision || decision.route !== 'coding_task') return null;

  const { userId: pendingUserId, channel: pendingChannel } = deps.parsePendingActionUserKey(input.userKey);
  const backendId = normalizeCodingBackendSelection(decision.entities.codingBackend);
  const isCodingRunStatusCheck = decision.entities.codingRunStatusCheck === true;
  let effectiveCodeContext = input.codeContext ? { ...input.codeContext } : undefined;
  let currentSessionRecord = effectiveCodeContext?.sessionId
    ? deps.codeSessionStore?.getSession(effectiveCodeContext.sessionId, input.message.userId?.trim())
      ?? deps.codeSessionStore?.getSession(effectiveCodeContext.sessionId)
    : null;
  let switchResponsePrefix = '';
  let switchResponseMetadata: Record<string, unknown> | undefined;
  const explicitWorkspaceTarget = await deps.ensureExplicitCodingTaskWorkspaceTarget({
    message: input.message,
    ctx: input.ctx,
    decision,
    currentSession: currentSessionRecord,
    codeContext: effectiveCodeContext,
  });
  if (explicitWorkspaceTarget.status === 'blocked') {
    return explicitWorkspaceTarget.response;
  }
  if (explicitWorkspaceTarget.status === 'switched') {
    currentSessionRecord = explicitWorkspaceTarget.currentSession;
    effectiveCodeContext = explicitWorkspaceTarget.codeContext;
    switchResponsePrefix = explicitWorkspaceTarget.switchResponse.content;
    switchResponseMetadata = explicitWorkspaceTarget.switchResponse.metadata;
  }
  if (!backendId && !isCodingRunStatusCheck) return null;

  if (decision.operation === 'inspect' && isCodingRunStatusCheck) {
    return handleCodingBackendStatusCheck({
      message: input.message,
      ctx: input.ctx,
      backendId,
      effectiveCodeContext,
      switchResponsePrefix,
      switchResponseMetadata,
    }, deps);
  }

  const currentTask = stripLeadingContextPrefix(input.message.content).trim();
  const resolvedTask = stripLeadingContextPrefix(decision.resolvedContent?.trim() || '').trim();
  const delegatedTask = selectCodingBackendDelegatedTask({
    currentTask,
    resolvedTask,
    backendId,
  });
  if (!delegatedTask) {
    const content = 'I need the coding task details before I can run that coding backend request.';
    return {
      content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${content}` : content,
      metadata: switchResponseMetadata,
    };
  }

  return handleCodingBackendRun({
    message: input.message,
    ctx: input.ctx,
    userKey: input.userKey,
    pendingUserId,
    pendingChannel,
    decision,
    backendId,
    delegatedTask,
    effectiveCodeContext,
    currentSessionRecord,
    switchResponsePrefix,
    switchResponseMetadata,
  }, deps);
}

async function handleCodingBackendStatusCheck(
  input: {
    message: UserMessage;
    ctx: AgentContext;
    backendId?: string;
    effectiveCodeContext?: { sessionId?: string; workspaceRoot: string };
    switchResponsePrefix: string;
    switchResponseMetadata?: Record<string, unknown>;
  },
  deps: DirectCodingBackendDeps,
): Promise<DirectCodingBackendResponse> {
  if (!input.effectiveCodeContext?.sessionId) {
    return { content: `I can only check recent ${input.backendId || 'coding backend'} runs from an active coding workspace.` };
  }

  deps.recordIntentRoutingTrace('direct_tool_call_started', {
    message: input.message,
    details: {
      toolName: 'coding_backend_status',
      ...(input.backendId ? { backendId: input.backendId } : {}),
      codeSessionId: input.effectiveCodeContext.sessionId,
      workspaceRoot: input.effectiveCodeContext.workspaceRoot,
    },
  });
  const statusResult = await deps.tools!.executeModelTool(
    'coding_backend_status',
    {},
    {
      origin: 'assistant',
      agentId: deps.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
      codeContext: input.effectiveCodeContext,
    },
  );
  deps.recordIntentRoutingTrace('direct_tool_call_completed', {
    message: input.message,
    details: {
      toolName: 'coding_backend_status',
      ...(input.backendId ? { backendId: input.backendId } : {}),
      status: statusResult.status,
      success: toBoolean(statusResult.success),
      message: toString(statusResult.message),
    },
  });
  if (!toBoolean(statusResult.success)) {
    const failure = toString(statusResult.message)
      || toString(statusResult.error)
      || `I could not inspect recent ${input.backendId || 'coding backend'} runs.`;
    return {
      content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${failure}` : failure,
      metadata: input.switchResponseMetadata,
    };
  }

  const sessions = (isRecord(statusResult.output) && Array.isArray(statusResult.output.sessions)
    ? statusResult.output.sessions
    : []) as Array<Record<string, unknown>>;
  const matches = sessions
    .filter((session) => !input.backendId || toString(session.backendId) === input.backendId)
    .sort((a, b) => {
      const aTime = toNumber(a.completedAt) || toNumber(a.startedAt) || 0;
      const bTime = toNumber(b.completedAt) || toNumber(b.startedAt) || 0;
      return bTime - aTime;
    });
  if (matches.length === 0) {
    const content = `I couldn't find any recent ${input.backendId || 'coding backend'} runs for this coding workspace.`;
    return {
      content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${content}` : content,
      metadata: input.switchResponseMetadata,
    };
  }

  const latest = matches[0];
  const backendName = toString(latest.backendName) || input.backendId;
  const status = toString(latest.status) || 'unknown';
  const task = toString(latest.task);
  const durationMs = toNumber(latest.durationMs);
  const exitCode = toNumber(latest.exitCode);
  const statusLabel = status === 'running'
    ? 'is still running'
    : status === 'succeeded'
      ? 'completed successfully'
      : status === 'timed_out'
        ? 'timed out'
        : 'failed';
  const lines = [`The most recent ${backendName} run ${statusLabel}.`];
  if (task) lines.push(`Task: ${task}`);
  if (durationMs !== null) lines.push(`Duration: ${durationMs}ms`);
  if (exitCode !== null) lines.push(`Exit code: ${exitCode}`);
  if (status === 'succeeded') {
    lines.push('If you want, I can also inspect the repo diff or recent changes from that run.');
  }
  const content = lines.join('\n');
  return {
    content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${content}` : content,
    metadata: input.switchResponseMetadata,
  };
}

async function handleCodingBackendRun(
  input: {
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
    pendingUserId: string;
    pendingChannel: string;
    decision: IntentGatewayDecision;
    backendId?: string;
    delegatedTask: string;
    effectiveCodeContext?: { sessionId?: string; workspaceRoot: string };
    currentSessionRecord: CodeSessionRecord | null | undefined;
    switchResponsePrefix: string;
    switchResponseMetadata?: Record<string, unknown>;
  },
  deps: DirectCodingBackendDeps,
): Promise<DirectCodingBackendResponse> {
  deps.recordIntentRoutingTrace('direct_tool_call_started', {
    message: input.message,
    contentPreview: input.delegatedTask,
    details: {
      toolName: 'coding_backend_run',
      backendId: input.backendId,
      codeSessionId: input.effectiveCodeContext?.sessionId,
      workspaceRoot: input.effectiveCodeContext?.workspaceRoot,
    },
  });
  const result = await deps.tools!.executeModelTool(
    'coding_backend_run',
    {
      task: input.delegatedTask,
      backend: input.backendId,
    },
    {
      origin: 'assistant',
      agentId: deps.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
      ...(input.effectiveCodeContext ? { codeContext: input.effectiveCodeContext } : {}),
    },
  );

  deps.recordIntentRoutingTrace('direct_tool_call_completed', {
    message: input.message,
    details: {
      toolName: 'coding_backend_run',
      backendId: input.backendId,
      status: result.status,
      success: toBoolean(result.success),
      message: toString(result.message),
    },
    contentPreview: toString(
      result.output && isRecord(result.output)
        ? result.output.assistantResponse ?? result.output.output
        : undefined,
    ),
  });

  if (result.status === 'pending_approval') {
    return buildCodingBackendPendingApprovalResponse(input, result, deps);
  }

  const runResult = isRecord(result.output) ? result.output : null;
  const backendName = toString(runResult?.backendName) || input.backendId;
  const assistantResponse = toString(runResult?.assistantResponse)?.trim();
  const backendOutput = toString(runResult?.output)?.trim();
  const sessionId = input.effectiveCodeContext?.sessionId || toString(runResult?.codeSessionId);

  const metadata: Record<string, unknown> = {
    codingBackendDelegated: true,
    codingBackendId: input.backendId,
    responseSource: buildCodingBackendResponseSource({
      backendId: input.backendId,
      backendName,
      durationMs: toNumber(runResult?.durationMs) ?? undefined,
    }),
    ...(input.switchResponseMetadata ?? {}),
    ...(sessionId ? { codeSessionResolved: true, codeSessionId: sessionId } : {}),
  };

  const content = assistantResponse || backendOutput || `${backendName} completed successfully.`;
  if (toBoolean(result.success)) {
    return {
      content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${content}` : content,
      metadata,
    };
  }

  const failureMessage = backendOutput
    || toString(result.message)
    || `${backendName} could not complete the requested task.`;
  return {
    content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${failureMessage}` : failureMessage,
    metadata,
  };
}

function buildCodingBackendPendingApprovalResponse(
  input: {
    message: UserMessage;
    userKey: string;
    pendingUserId: string;
    pendingChannel: string;
    decision: IntentGatewayDecision;
    backendId?: string;
    delegatedTask: string;
    effectiveCodeContext?: { sessionId?: string; workspaceRoot: string };
    currentSessionRecord: CodeSessionRecord | null | undefined;
    switchResponsePrefix: string;
    switchResponseMetadata?: Record<string, unknown>;
  },
  result: Record<string, unknown>,
  deps: DirectCodingBackendDeps,
): DirectCodingBackendResponse {
  const approvalId = toString(result.approvalId);
  let pendingIds: string[] = [];
  if (approvalId) {
    const existingIds = deps.getPendingApprovalIds(input.pendingUserId, input.pendingChannel, input.message.surfaceId);
    pendingIds = [...new Set([...existingIds, approvalId])];
    deps.setPendingApprovals(input.userKey, pendingIds, input.message.surfaceId);
  } else {
    deps.syncPendingApprovalsFromExecutor(
      input.message.userId,
      input.message.channel,
      input.pendingUserId,
      input.pendingChannel,
      input.message.surfaceId,
      input.message.content,
    );
    pendingIds = deps.getPendingApprovalIds(input.pendingUserId, input.pendingChannel, input.message.surfaceId);
  }
  const summaries = pendingIds.length > 0 ? deps.tools?.getApprovalSummaries(pendingIds) : undefined;
  const prompt = [
    `I need approval to run ${input.backendId} for this coding task.`,
    'Once approved, I\'ll launch it in:',
    input.currentSessionRecord
      ? formatDirectCodeSessionLine(input.currentSessionRecord, true)
      : `- CURRENT: ${input.effectiveCodeContext?.workspaceRoot ?? '(unknown workspace)'}`,
  ].join('\n');
  const pendingActionResult = deps.setPendingApprovalAction(
    input.pendingUserId,
    input.pendingChannel,
    input.message.surfaceId,
    {
      prompt,
      approvalIds: pendingIds,
      approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
      originalUserContent: input.delegatedTask,
      route: input.decision.route,
      operation: input.decision.operation,
      summary: input.decision.summary,
      turnRelation: input.decision.turnRelation,
      resolution: input.decision.resolution,
      missingFields: input.decision.missingFields,
      provenance: input.decision.provenance,
      entities: toPendingActionEntities(input.decision.entities),
      codeSessionId: input.effectiveCodeContext?.sessionId,
      resume: buildCodingBackendRunResumePayload({
        task: input.delegatedTask,
        backendId: input.backendId,
        codeSessionId: input.effectiveCodeContext?.sessionId,
        workspaceRoot: input.effectiveCodeContext?.workspaceRoot,
      }),
    },
  );
  deps.recordIntentRoutingTrace('direct_intent_response', {
    message: input.message,
    contentPreview: 'pending_action_stored',
    details: {
      candidate: 'coding_backend_diagnostic',
      toolApprovalId: approvalId || null,
      pendingIds,
      pendingActionId: pendingActionResult.action?.id || null,
      pendingActionApprovalIds: pendingActionResult.action?.blocker?.approvalIds ?? null,
      pendingActionResumeKind: pendingActionResult.action?.resume?.kind ?? null,
      pendingActionResumePayloadType: (pendingActionResult.action?.resume?.payload as { type?: string } | undefined)?.type ?? null,
      pendingActionScope: pendingActionResult.action?.scope ?? null,
      collision: !!pendingActionResult.collisionPrompt,
    },
  });
  const content = pendingActionResult.collisionPrompt ?? prompt;
  return {
    content: input.switchResponsePrefix ? `${input.switchResponsePrefix}\n\n${content}` : content,
    metadata: {
      ...(input.switchResponseMetadata ?? {}),
      ...(input.effectiveCodeContext?.sessionId
        ? { codeSessionResolved: true, codeSessionId: input.effectiveCodeContext.sessionId }
        : {}),
      ...(toPendingActionClientMetadata(pendingActionResult.action) ? { pendingAction: toPendingActionClientMetadata(pendingActionResult.action) } : {}),
    },
  };
}
