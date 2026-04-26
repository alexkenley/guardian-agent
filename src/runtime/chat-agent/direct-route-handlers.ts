import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { tryDirectAutomationAuthoring, tryDirectAutomationControl, tryDirectAutomationOutput, tryDirectBrowserAutomation } from './direct-automation.js';
import type { DirectIntentDispatchResult } from './direct-intent-dispatch.js';
import { tryDirectGoogleWorkspaceRead, tryDirectGoogleWorkspaceWrite } from './direct-mailbox-runtime.js';
import { tryDirectProviderRead } from './direct-provider-read.js';
import {
  buildDirectAutomationDeps,
  buildDirectMailboxDeps,
  buildDirectScheduledEmailAutomationDeps,
  type DirectRuntimeDepsInput,
} from './direct-runtime-deps.js';
import { tryDirectScheduledEmailAutomation } from './direct-scheduled-email-automation.js';
import type { DirectIntentHandlerMap } from './direct-route-orchestration.js';
import { tryDirectWebSearch } from './direct-web-search.js';
import type { StoredToolLoopSanitizedResult } from './tool-loop-runtime.js';

type DirectCodeContext = {
  workspaceRoot: string;
  sessionId?: string;
};

type DirectHandlerCallback = () => Promise<DirectIntentDispatchResult | null>;

export interface ChatDirectRouteHandlerCallbacks {
  personalAssistant: DirectHandlerCallback;
  codingSessionControl: DirectHandlerCallback;
  codingBackend: DirectHandlerCallback;
  filesystem: DirectHandlerCallback;
  memoryWrite: DirectHandlerCallback;
  memoryRead: DirectHandlerCallback;
}

export interface BuildChatDirectRouteHandlersInput {
  agentId: string;
  tools: DirectRuntimeDepsInput['tools'];
  runtimeDeps: DirectRuntimeDepsInput;
  message: UserMessage;
  routedMessage: UserMessage;
  ctx: AgentContext;
  userKey: string;
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
  callbacks: ChatDirectRouteHandlerCallbacks;
}

export function buildChatDirectRouteHandlers(input: BuildChatDirectRouteHandlersInput): DirectIntentHandlerMap {
  const mailboxDeps = buildDirectMailboxDeps(input.runtimeDeps);
  const automationDeps = buildDirectAutomationDeps(input.runtimeDeps);
  const scheduledEmailAutomationDeps = buildDirectScheduledEmailAutomationDeps(input.runtimeDeps);

  return {
    personal_assistant: input.callbacks.personalAssistant,
    provider_read: () => tryDirectProviderRead({
      agentId: input.agentId,
      tools: input.tools,
      message: input.routedMessage,
      ctx: input.ctx,
      decision: input.decision,
    }),
    coding_session_control: input.callbacks.codingSessionControl,
    coding_backend: input.callbacks.codingBackend,
    filesystem: input.callbacks.filesystem,
    memory_write: input.callbacks.memoryWrite,
    memory_read: input.callbacks.memoryRead,
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
