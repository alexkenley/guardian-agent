import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { CodeSessionStore } from '../code-sessions.js';
import type { ConversationKey, ConversationService } from '../conversation.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { IntentRoutingTraceStage } from '../intent-routing-trace.js';
import type {
  PendingActionApprovalSummary,
  PendingActionRecord,
} from '../pending-actions.js';
import {
  ensureExplicitCodingTaskWorkspaceTarget,
  tryDirectCodeSessionControlFromGateway,
  type CodeSessionControlDeps,
  type CodeSessionToolExecutor,
  type CodingTaskResumer,
  type OnMessageFn,
} from './code-session-control.js';
import { tryDirectAutomationAuthoring, tryDirectAutomationControl, tryDirectAutomationOutput, tryDirectBrowserAutomation } from './direct-automation.js';
import {
  tryDirectCodingBackendDelegation,
  type DirectCodingBackendDeps,
} from './direct-coding-backend.js';
import type { DirectIntentDispatchResult } from './direct-intent-dispatch.js';
import { tryDirectGoogleWorkspaceRead, tryDirectGoogleWorkspaceWrite } from './direct-mailbox-runtime.js';
import { tryDirectMemoryRead, tryDirectMemorySave } from './direct-memory.js';
import { tryDirectPersonalAssistant } from './direct-personal-assistant.js';
import { tryDirectProviderRead } from './direct-provider-read.js';
import {
  buildDirectAutomationDeps,
  buildDirectMailboxDeps,
  buildDirectPersonalAssistantDeps,
  buildDirectScheduledEmailAutomationDeps,
  type DirectRuntimeDepsInput,
} from './direct-runtime-deps.js';
import { tryDirectScheduledEmailAutomation } from './direct-scheduled-email-automation.js';
import type { DirectIntentHandlerMap } from './direct-route-orchestration.js';
import { tryDirectFilesystemIntent } from './direct-route-runtime.js';
import { tryDirectWebSearch } from './direct-web-search.js';
import type { StoredFilesystemSaveInput } from './filesystem-save-resume.js';
import type { PendingActionSetResult } from './orchestration-state.js';
import type { StoredToolLoopSanitizedResult } from './tool-loop-runtime.js';

type DirectCodeContext = {
  workspaceRoot: string;
  sessionId?: string;
};

export type DirectCodeSessionControlDeps = Omit<CodeSessionControlDeps, 'resumeCodingTask'>;

export interface ChatDirectCodingRouteDeps {
  backendDeps: DirectCodingBackendDeps;
  sessionControlDeps: DirectCodeSessionControlDeps;
}

type DirectCodingRouteTools = Pick<
  ToolExecutor,
  'isEnabled' | 'executeModelTool' | 'getApprovalSummaries' | 'getCodeSessionManagedSandboxStatus'
> | null | undefined;

export interface BuildChatDirectCodingRouteDepsInput {
  agentId: string;
  tools?: DirectCodingRouteTools;
  codeSessionStore?: Pick<CodeSessionStore, 'getSession' | 'listSessionsForUser'> | null;
  parsePendingActionUserKey: (userKey: string) => { userId: string; channel: string };
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
  getActivePendingAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => PendingActionRecord | null;
  completePendingAction: (actionId: string) => void;
  onMessage: OnMessageFn;
}

export interface BuildChatDirectRouteHandlersInput {
  agentId: string;
  tools: DirectRuntimeDepsInput['tools'];
  runtimeDeps: DirectRuntimeDepsInput;
  message: UserMessage;
  routedMessage: UserMessage;
  ctx: AgentContext;
  userKey: string;
  conversationKey: ConversationKey;
  conversationService?: Pick<ConversationService, 'getSessionHistory'> | null;
  stateAgentId: string;
  decision?: IntentGatewayDecision | null;
  codeContext?: DirectCodeContext;
  continuityThread?: ContinuityThreadRecord | null;
  llmMessages: ChatMessage[];
  fallbackProviderOrder?: string[];
  defaultToolResultProviderKind: 'local' | 'external';
  sanitizeToolResultForLlm: (
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ) => StoredToolLoopSanitizedResult;
  chatWithFallback: (
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: ChatOptions,
    fallbackProviderOrder?: string[],
  ) => Promise<ChatResponse>;
  executeStoredFilesystemSave: (
    input: StoredFilesystemSaveInput,
  ) => Promise<DirectIntentDispatchResult>;
  codingRoutes: ChatDirectCodingRouteDeps;
}

export function buildDirectCodingTaskResumer(
  backendDeps: DirectCodingBackendDeps,
): CodingTaskResumer {
  return (message, ctx, userKey, decision, codeContext) => tryDirectCodingBackendDelegation(
    {
      message,
      ctx,
      userKey,
      decision,
      codeContext,
    },
    backendDeps,
  );
}

function buildDirectCodeSessionToolExecutor(
  input: Pick<BuildChatDirectCodingRouteDepsInput, 'agentId' | 'tools'>,
): CodeSessionToolExecutor {
  return (toolName, args, message, ctx) => input.tools!.executeModelTool(
    toolName,
    args,
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: message.userId,
      surfaceId: message.surfaceId,
      principalId: message.principalId ?? message.userId,
      principalRole: message.principalRole,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
    },
  );
}

export function buildChatDirectCodingRouteDeps(
  input: BuildChatDirectCodingRouteDepsInput,
): ChatDirectCodingRouteDeps {
  const executeDirectCodeSessionTool = buildDirectCodeSessionToolExecutor(input);
  const backendDeps: DirectCodingBackendDeps = {
    agentId: input.agentId,
    tools: input.tools,
    codeSessionStore: input.codeSessionStore,
    parsePendingActionUserKey: input.parsePendingActionUserKey,
    ensureExplicitCodingTaskWorkspaceTarget: (nextInput) => ensureExplicitCodingTaskWorkspaceTarget({
      toolsEnabled: input.tools?.isEnabled() === true,
      codeSessionStore: input.codeSessionStore,
      executeDirectCodeSessionTool,
      ...nextInput,
    }),
    recordIntentRoutingTrace: input.recordIntentRoutingTrace,
    getPendingApprovalIds: input.getPendingApprovalIds,
    setPendingApprovals: input.setPendingApprovals,
    syncPendingApprovalsFromExecutor: input.syncPendingApprovalsFromExecutor,
    setPendingApprovalAction: input.setPendingApprovalAction,
  };
  return {
    backendDeps,
    sessionControlDeps: {
      executeDirectCodeSessionTool,
      getCodeSessionManagedSandboxes: input.tools?.getCodeSessionManagedSandboxStatus
        ? (sessionId, ownerUserId, options) => input.tools!.getCodeSessionManagedSandboxStatus!({
          sessionId,
          ownerUserId,
          ...(options?.refreshTargetHealth ? { refreshTargetHealth: options.refreshTargetHealth } : {}),
        })
        : undefined,
      getActivePendingAction: input.getActivePendingAction,
      completePendingAction: input.completePendingAction,
      onMessage: input.onMessage,
    },
  };
}

export function tryDirectChatCodeSessionControl(input: {
  tools: DirectRuntimeDepsInput['tools'];
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision | null;
  codingRoutes: ChatDirectCodingRouteDeps;
}): Promise<DirectIntentDispatchResult | null> {
  return tryDirectCodeSessionControlFromGateway({
    ...input.codingRoutes.sessionControlDeps,
    toolsEnabled: input.tools?.isEnabled() === true,
    resumeCodingTask: buildDirectCodingTaskResumer(input.codingRoutes.backendDeps),
    message: input.message,
    ctx: input.ctx,
    decision: input.decision ?? undefined,
  });
}

export function buildChatDirectRouteHandlers(input: BuildChatDirectRouteHandlersInput): DirectIntentHandlerMap {
  const mailboxDeps = buildDirectMailboxDeps(input.runtimeDeps);
  const automationDeps = buildDirectAutomationDeps(input.runtimeDeps);
  const scheduledEmailAutomationDeps = buildDirectScheduledEmailAutomationDeps(input.runtimeDeps);
  const personalAssistantDeps = buildDirectPersonalAssistantDeps(input.runtimeDeps);

  return {
    personal_assistant: () => tryDirectPersonalAssistant({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      decision: input.decision ?? undefined,
      continuityThread: input.continuityThread,
    }, personalAssistantDeps),
    provider_read: () => tryDirectProviderRead({
      agentId: input.agentId,
      tools: input.tools,
      message: input.routedMessage,
      ctx: input.ctx,
      decision: input.decision,
    }),
    coding_session_control: () => tryDirectChatCodeSessionControl({
      tools: input.tools,
      message: input.message,
      ctx: input.ctx,
      decision: input.decision,
      codingRoutes: input.codingRoutes,
    }),
    coding_backend: () => tryDirectCodingBackendDelegation({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      decision: input.decision ?? undefined,
      codeContext: input.codeContext,
    }, input.codingRoutes.backendDeps),
    filesystem: () => tryDirectFilesystemIntent({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      conversationKey: input.conversationKey,
      codeContext: input.codeContext,
      originalUserContent: input.message.content,
      gatewayDecision: input.decision ?? undefined,
      agentId: input.agentId,
      tools: input.tools,
      conversationService: input.conversationService,
      executeStoredFilesystemSave: input.executeStoredFilesystemSave,
      setApprovalFollowUp: input.runtimeDeps.setApprovalFollowUp,
      getPendingApprovals: input.runtimeDeps.getPendingApprovals,
      formatPendingApprovalPrompt: input.runtimeDeps.formatPendingApprovalPrompt,
      setPendingApprovalActionForRequest: input.runtimeDeps.setPendingApprovalActionForRequest,
      buildPendingApprovalBlockedResponse: input.runtimeDeps.buildPendingApprovalBlockedResponse,
    }),
    memory_write: () => tryDirectMemorySave({
      tools: input.tools,
      agentId: input.agentId,
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      codeContext: input.codeContext,
      originalUserContent: input.message.content,
      getPendingApprovals: input.runtimeDeps.getPendingApprovals,
      setApprovalFollowUp: input.runtimeDeps.setApprovalFollowUp,
      formatPendingApprovalPrompt: input.runtimeDeps.formatPendingApprovalPrompt,
      setPendingApprovalActionForRequest: input.runtimeDeps.setPendingApprovalActionForRequest,
      buildPendingApprovalBlockedResponse: input.runtimeDeps.buildPendingApprovalBlockedResponse,
    }),
    memory_read: () => tryDirectMemoryRead({
      tools: input.tools,
      agentId: input.agentId,
      message: input.routedMessage,
      ctx: input.ctx,
      codeContext: input.codeContext,
      originalUserContent: input.message.content,
    }),
    scheduled_email_automation: () => tryDirectScheduledEmailAutomation({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      stateAgentId: input.stateAgentId,
    }, scheduledEmailAutomationDeps),
    automation: ({ gatewayDirected }) => tryDirectAutomationAuthoring({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      codeContext: input.codeContext,
      options: {
        intentDecision: input.decision,
        assumeAuthoring: gatewayDirected,
      },
    }, automationDeps),
    automation_control: () => tryDirectAutomationControl({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      intentDecision: input.decision,
      continuityThread: input.continuityThread,
    }, automationDeps),
    automation_output: () => tryDirectAutomationOutput({
      message: input.routedMessage,
      ctx: input.ctx,
      intentDecision: input.decision,
    }, automationDeps),
    workspace_write: () => tryDirectGoogleWorkspaceWrite({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      decision: input.decision ?? undefined,
    }, mailboxDeps),
    workspace_read: () => tryDirectGoogleWorkspaceRead({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      decision: input.decision ?? undefined,
      continuityThread: input.continuityThread,
    }, mailboxDeps),
    browser: () => tryDirectBrowserAutomation({
      message: input.routedMessage,
      ctx: input.ctx,
      userKey: input.userKey,
      codeContext: input.codeContext,
      intentDecision: input.decision,
      continuityThread: input.continuityThread,
    }, automationDeps),
    web_search: () => tryDirectWebSearch({
      agentId: input.agentId,
      tools: input.tools,
      message: input.routedMessage,
      ctx: input.ctx,
      llmMessages: input.llmMessages,
      fallbackProviderOrder: input.fallbackProviderOrder,
      defaultToolResultProviderKind: input.defaultToolResultProviderKind,
      sanitizeToolResultForLlm: input.sanitizeToolResultForLlm,
      chatWithFallback: input.chatWithFallback,
    }),
  };
}
