import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  compactMessagesIfOverBudget,
  formatToolResultForLLM,
  isRecord,
  summarizeToolRoundStatusMessage,
  toLLMToolDef,
} from '../../chat-agent-helpers.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import { buildToolResultPayloadFromJob } from '../../tools/job-results.js';
import type { ToolApprovalDecisionResult, ToolExecutor } from '../../tools/executor.js';
import type {
  ContentTrustLevel,
  PrincipalRole,
  ToolCategory,
  ToolExecutionRequest,
  ToolRisk,
} from '../../tools/types.js';
import { normalizeToolCallsForExecution, recoverToolCallsFromStructuredText } from '../../util/structured-json.js';
import { looksLikeOngoingWorkResponse } from '../../util/assistant-response-shape.js';
import { withTaintedContentSystemPrompt } from '../../util/tainted-content.js';
import { getProviderLocalityFromName } from '../model-routing-ux.js';
import { buildPendingApprovalMetadata, formatPendingApprovalMessage } from '../pending-approval-copy.js';
import type { PendingActionRecord } from '../pending-actions.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { PendingActionSetResult } from './orchestration-state.js';
import {
  buildToolLoopPendingApprovalResume,
  readToolLoopResumePayload,
} from './tool-loop-resume.js';
import {
  executeToolsConflictAware,
  isDeferredRemoteSandboxToolResult,
  pruneDeferredRemoteSandboxToolCalls,
} from './tool-execution.js';

export interface StoredToolLoopChatRunner {
  chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  providerLocality: 'local' | 'external';
}

export interface StoredToolLoopSanitizedResult {
  sanitized: unknown;
  threats: string[];
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
}

export function buildStoredToolLoopChatRunner(input: {
  ctx?: AgentContext;
  selectedExecutionProfile?: SelectedExecutionProfile;
  abortSignal?: AbortSignal;
  resolveProviderLocality: (ctx: AgentContext) => 'local' | 'external';
  chatWithFallback: (
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: ChatOptions,
    fallbackProviderOrder?: string[],
  ) => Promise<ChatResponse>;
  chatWithProviderOrder?: (
    providerOrder: string[],
    messages: ChatMessage[],
    options?: ChatOptions,
  ) => Promise<{ response: ChatResponse }>;
}): StoredToolLoopChatRunner | null {
  if (input.ctx?.llm) {
    const fallbackProviderOrder = input.selectedExecutionProfile?.fallbackProviderOrder;
    return {
      providerLocality: input.selectedExecutionProfile?.providerLocality ?? input.resolveProviderLocality(input.ctx),
      chatFn: (messages, options) => input.chatWithFallback(
        input.ctx!,
        messages,
        { ...(options ?? {}), ...(input.abortSignal ? { signal: input.abortSignal } : {}) },
        fallbackProviderOrder,
      ),
    };
  }

  const primaryProviderName = input.selectedExecutionProfile?.providerName?.trim();
  if (!primaryProviderName || !input.chatWithProviderOrder) {
    return null;
  }
  const providerOrder = [...new Set([
    primaryProviderName,
    ...(input.selectedExecutionProfile?.fallbackProviderOrder ?? []),
  ])];
  return {
    providerLocality: input.selectedExecutionProfile?.providerLocality ?? getProviderLocalityFromName(primaryProviderName),
    chatFn: async (messages, options) => {
      const result = await input.chatWithProviderOrder!(
        providerOrder,
        messages,
        { ...(options ?? {}), ...(input.abortSignal ? { signal: input.abortSignal } : {}) },
      );
      return result.response;
    },
  };
}

export async function recoverDirectAnswerAfterTools(input: {
  llmMessages: ChatMessage[];
  chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  currentContextTrustLevel: ContentTrustLevel;
  currentTaintReasons: ReadonlySet<string>;
  lacksUsableAssistantContent: (content: string | undefined) => boolean;
  looksLikeOngoingWorkResponse: (content: string | undefined) => boolean;
}): Promise<string> {
  const recoveryMessages: ChatMessage[] = [
    ...input.llmMessages,
    {
      role: 'user',
      content: [
        'You already completed tool calls for this request.',
        'Now answer the user directly in plain language using the tool results already in the conversation.',
        'Do not call any more tools.',
      ].join(' '),
    },
  ];

  try {
    const recovery = await input.chatFn(
      withTaintedContentSystemPrompt(
        recoveryMessages,
        input.currentContextTrustLevel,
        new Set(input.currentTaintReasons),
      ),
      { tools: [] },
    );
    const content = recovery.content?.trim() ?? '';
    return content && !input.lacksUsableAssistantContent(content) && !input.looksLikeOngoingWorkResponse(content) ? content : '';
  } catch {
    return '';
  }
}

export async function resumeStoredToolLoopPendingAction(input: {
  pendingAction: PendingActionRecord;
  options?: {
    approvalId?: string;
    pendingActionAlreadyCleared?: boolean;
    approvalResult?: ToolApprovalDecisionResult;
    ctx?: AgentContext;
  };
  agentId: string;
  tools?: Pick<
    ToolExecutor,
    | 'executeModelTool'
    | 'getApprovalSummaries'
    | 'getToolDefinition'
    | 'isEnabled'
    | 'listAlwaysLoadedDefinitions'
    | 'listCodeSessionEagerToolDefinitions'
    | 'listJobs'
  > | null;
  secondBrainService?: Pick<SecondBrainService, 'getEventById' | 'getPersonById' | 'getTaskById'> | null;
  maxToolRounds: number;
  contextBudget: number;
  normalizePrincipalRole: (value: string | undefined) => PrincipalRole | undefined;
  buildChatRunner: (input: {
    ctx?: AgentContext;
    selectedExecutionProfile?: SelectedExecutionProfile;
    abortSignal?: AbortSignal;
  }) => StoredToolLoopChatRunner | null;
  completePendingAction: (actionId: string, nowMs?: number) => void;
  sanitizeToolResultForLlm: (
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ) => StoredToolLoopSanitizedResult;
  lacksUsableAssistantContent: (content: string | undefined) => boolean;
  setPendingApprovalAction: (
    userId: string,
    channel: string,
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
  ) => { content: string; metadata?: Record<string, unknown> };
}): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!input.tools?.isEnabled()) {
    return { content: 'I could not resume the pending coding run because tool execution is unavailable.' };
  }

  const resume = readToolLoopResumePayload(
    input.pendingAction.resume?.payload,
    input.normalizePrincipalRole,
  );
  if (!resume) {
    return null;
  }

  if (!input.options?.pendingActionAlreadyCleared) {
    input.completePendingAction(input.pendingAction.id);
  }

  const chatRunner = input.buildChatRunner({
    ctx: input.options?.ctx,
    selectedExecutionProfile: resume.selectedExecutionProfile,
  });
  if (!chatRunner) {
    return { content: 'I could not resume the pending coding run because the original model profile is no longer available.' };
  }

  const llmMessages = resume.llmMessages.map((message) => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) } : {}),
  }));
  const allJobs = input.tools.listJobs(200);
  const resumedApprovalId = input.options?.approvalId?.trim();
  const resumedToolResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
  for (const pendingTool of resume.pendingTools) {
    let resultObj: Record<string, unknown> | undefined;
    if (input.options?.approvalResult?.result && resumedApprovalId && pendingTool.approvalId === resumedApprovalId) {
      resultObj = isRecord(input.options.approvalResult.result)
        ? { ...input.options.approvalResult.result }
        : undefined;
    }
    if (!resultObj) {
      const job = allJobs.find((entry) => entry.id === pendingTool.jobId);
      resultObj = buildToolResultPayloadFromJob(job);
    }
    if (resultObj) {
      resumedToolResults.push({
        toolName: pendingTool.name,
        result: resultObj,
      });
    }
    llmMessages.push({
      role: 'tool',
      toolCallId: pendingTool.toolCallId,
      content: JSON.stringify(resultObj),
    });
  }

  const providerLocality = chatRunner.providerLocality;
  const baseToolDefs = input.tools.listAlwaysLoadedDefinitions();
  const codeSessionToolDefs = resume.codeContext?.sessionId
    ? input.tools.listCodeSessionEagerToolDefinitions()
      .filter((definition) => !baseToolDefs.some((base) => base.name === definition.name))
    : [];
  const allToolDefs = [...baseToolDefs, ...codeSessionToolDefs];
  let llmToolDefs = allToolDefs.map((definition) => toLLMToolDef(definition, providerLocality));
  let finalContent = '';
  let rounds = 0;
  let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = resumedToolResults;
  let currentContextTrustLevel = resume.contentTrustLevel;
  const currentTaintReasons = new Set(resume.taintReasons);
  const toolResultProviderKind: 'local' | 'external' = providerLocality;

  while (rounds < input.maxToolRounds) {
    compactMessagesIfOverBudget(llmMessages, input.contextBudget);
    let response = await chatRunner.chatFn(
      withTaintedContentSystemPrompt(llmMessages, currentContextTrustLevel, currentTaintReasons),
      { tools: llmToolDefs },
    );
    finalContent = response.content ?? '';
    if (!response.toolCalls || response.toolCalls.length === 0) {
      const recoveredToolCalls = recoverToolCallsFromStructuredText(response.content ?? '', llmToolDefs);
      if (recoveredToolCalls?.toolCalls.length) {
        response = {
          ...response,
          toolCalls: recoveredToolCalls.toolCalls,
          finishReason: 'tool_calls',
        };
        finalContent = '';
      }
    }
    if (response.toolCalls?.length) {
      response = {
        ...response,
        toolCalls: normalizeToolCallsForExecution(response.toolCalls, llmToolDefs),
      };
    }
    if (!response.toolCalls || response.toolCalls.length === 0) {
      break;
    }

    llmMessages.push({
      role: 'assistant',
      content: response.content ?? '',
      toolCalls: response.toolCalls,
    });

    const toolExecOrigin: Omit<ToolExecutionRequest, 'toolName' | 'args'> = {
      origin: 'assistant',
      agentId: input.agentId,
      userId: resume.originalMessage.userId,
      surfaceId: resume.originalMessage.surfaceId,
      principalId: resume.originalMessage.principalId ?? resume.originalMessage.userId,
      principalRole: resume.originalMessage.principalRole ?? 'owner',
      channel: resume.originalMessage.channel,
      requestId: resume.originalMessage.id,
      contentTrustLevel: currentContextTrustLevel,
      taintReasons: [...currentTaintReasons],
      derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
      allowModelMemoryMutation: resume.allowModelMemoryMutation,
      ...(input.options?.ctx?.checkAction ? { agentContext: { checkAction: input.options.ctx.checkAction } } : {}),
      ...(resume.codeContext ? { codeContext: resume.codeContext } : {}),
      ...(resume.activeSkillIds.length > 0 ? { activeSkills: [...resume.activeSkillIds] } : {}),
      ...(resume.originalMessage.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
      requestText: resume.requestText,
    };

    const toolResults = await Promise.allSettled(
      executeToolsConflictAware({
        toolCalls: response.toolCalls,
        toolExecOrigin,
        referenceTime: resume.referenceTime,
        intentDecision: resume.intentDecision,
        tools: input.tools,
        secondBrainService: input.secondBrainService,
      }),
    );
    lastToolRoundResults = toolResults.reduce<Array<{ toolName: string; result: Record<string, unknown> }>>((acc, settled) => {
      if (settled.status !== 'fulfilled') return acc;
      acc.push({
        toolName: settled.value.toolCall.name,
        result: settled.value.result,
      });
      return acc;
    }, []);

    const pendingIds: string[] = [];
    let hasPending = false;
    const deferredRemoteToolCallIds = new Set<string>();
    for (const settled of toolResults) {
      if (settled.status === 'fulfilled') {
        const { toolCall, result: toolResult } = settled.value;
        if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
          pendingIds.push(String(toolResult.approvalId));
          hasPending = true;
        }
        if (isDeferredRemoteSandboxToolResult(toolResult)) {
          deferredRemoteToolCallIds.add(toolCall.id);
        }
        let resultForLlm = toolResult;
        if (toolResult.status === 'pending_approval') {
          const { approvalId: _stripped, jobId: _stripJob, ...rest } = toolResult as Record<string, unknown>;
          resultForLlm = { ...rest, message: 'This action needs your approval. The approval UI is shown to the user automatically.' };
        }
        const scannedToolResult = input.sanitizeToolResultForLlm(
          toolCall.name,
          resultForLlm,
          toolResultProviderKind,
        );
        if (scannedToolResult.trustLevel === 'quarantined') {
          currentContextTrustLevel = 'quarantined';
        } else if (scannedToolResult.trustLevel === 'low_trust' && currentContextTrustLevel === 'trusted') {
          currentContextTrustLevel = 'low_trust';
        }
        for (const reason of scannedToolResult.taintReasons) {
          currentTaintReasons.add(reason);
        }
        llmMessages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: formatToolResultForLLM(
            toolCall.name,
            scannedToolResult.sanitized,
            scannedToolResult.threats,
          ),
        });
        if (toolCall.name === 'find_tools' && toolResult.success) {
          const searchOutput = toolResult.output as {
            tools?: Array<{
              name: string;
              description: string;
              parameters: Record<string, unknown>;
              risk: string;
              category?: string;
            }>;
          } | undefined;
          if (searchOutput?.tools) {
            for (const discovered of searchOutput.tools) {
              if (!llmToolDefs.some((definition) => definition.name === discovered.name)) {
                const toolDefinition = {
                  name: discovered.name,
                  description: discovered.description,
                  risk: discovered.risk as ToolRisk,
                  parameters: discovered.parameters,
                  category: discovered.category as ToolCategory | undefined,
                };
                allToolDefs.push(toolDefinition);
                llmToolDefs.push(toLLMToolDef(toolDefinition, toolResultProviderKind));
              }
            }
          }
        }
      } else {
        const failedToolCall = response.toolCalls[toolResults.indexOf(settled)];
        llmMessages.push({
          role: 'tool',
          toolCallId: failedToolCall?.id ?? '',
          content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
        });
      }
    }

    if (hasPending) {
      const allBlocked = toolResults.every(
        (settled) => settled.status === 'fulfilled'
          && (
            (settled.value.result as Record<string, unknown>).status === 'pending_approval'
            || isDeferredRemoteSandboxToolResult(settled.value.result as Record<string, unknown>)
          ),
      );
      if (allBlocked) {
        llmMessages.splice(-toolResults.length, toolResults.length);
        pruneDeferredRemoteSandboxToolCalls(llmMessages, deferredRemoteToolCallIds);
        const originalMessage: UserMessage = {
          ...resume.originalMessage,
          ...(resume.originalMessage.metadata ? { metadata: { ...resume.originalMessage.metadata } } : {}),
        };
        const summaries = input.tools.getApprovalSummaries(pendingIds);
        const nextResume = buildToolLoopPendingApprovalResume({
          toolResults,
          llmMessages,
          originalMessage,
          requestText: resume.requestText,
          referenceTime: resume.referenceTime,
          allowModelMemoryMutation: resume.allowModelMemoryMutation,
          activeSkillIds: resume.activeSkillIds,
          contentTrustLevel: currentContextTrustLevel,
          taintReasons: [...currentTaintReasons],
          intentDecision: resume.intentDecision,
          codeContext: resume.codeContext,
          selectedExecutionProfile: resume.selectedExecutionProfile,
        });
        const pendingActionResult = input.setPendingApprovalAction(
          input.pendingAction.scope.userId,
          input.pendingAction.scope.channel,
          input.pendingAction.scope.surfaceId,
          {
            prompt: input.pendingAction.blocker.prompt || 'Approval required for the pending action.',
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: input.pendingAction.intent.originalUserContent,
            route: input.pendingAction.intent.route,
            operation: input.pendingAction.intent.operation,
            summary: input.pendingAction.intent.summary,
            turnRelation: input.pendingAction.intent.turnRelation,
            resolution: input.pendingAction.intent.resolution,
            missingFields: input.pendingAction.intent.missingFields,
            entities: input.pendingAction.intent.entities,
            ...(nextResume ? { resume: nextResume } : {}),
            codeSessionId: input.pendingAction.codeSessionId ?? resume.codeContext?.sessionId,
          },
        );
        return input.buildPendingApprovalBlockedResponse(
          pendingActionResult,
          formatPendingApprovalMessage(pendingActionResult.action?.blocker.approvalSummaries ?? []),
        );
      }
    }
    rounds += 1;
  }

  if ((!finalContent || looksLikeOngoingWorkResponse(finalContent)) && lastToolRoundResults.length > 0) {
    finalContent = await recoverDirectAnswerAfterTools({
      llmMessages,
      chatFn: chatRunner.chatFn,
      currentContextTrustLevel,
      currentTaintReasons,
      lacksUsableAssistantContent: input.lacksUsableAssistantContent,
      looksLikeOngoingWorkResponse,
    });
  }
  if ((!finalContent || looksLikeOngoingWorkResponse(finalContent)) && lastToolRoundResults.length > 0) {
    finalContent = summarizeToolRoundStatusMessage(lastToolRoundResults);
  }
  if (looksLikeOngoingWorkResponse(finalContent)) {
    finalContent = '';
  }
  if (!finalContent) {
    finalContent = 'I could not resume the pending coding run after approval.';
  }
  return { content: finalContent };
}
