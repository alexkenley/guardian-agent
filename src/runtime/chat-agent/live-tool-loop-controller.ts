import type { Logger } from 'pino';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  compactMessagesIfOverBudget,
  formatToolResultForLLM,
  formatToolThreatWarnings,
  stripLeadingContextPrefix,
  summarizeToolRoundStatusMessage,
  toBoolean,
  toLLMToolDef,
  toString,
} from '../../chat-agent-helpers.js';
import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from '../../llm/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ContentTrustLevel, ToolDefinition } from '../../tools/types.js';
import { isDirectMemorySaveRequest } from '../../util/memory-intent.js';
import {
  buildAnswerFirstSkillCorrectionPrompt,
  buildAnswerFirstSkillFallbackResponse,
  isAnswerFirstSkillResponseSufficient as isAnswerFirstSkillResponseSufficientForSkills,
  shouldUseAnswerFirstForSkills,
} from '../../util/answer-first-skills.js';
import {
  looksLikeOngoingWorkResponse as looksLikeOngoingWorkResponseShape,
} from '../../util/assistant-response-shape.js';
import type { ContextCompactionResult } from '../../util/context-budget.js';
import { withTaintedContentSystemPrompt } from '../../util/tainted-content.js';
import { normalizeToolCallsForExecution, recoverToolCallsFromStructuredText } from '../../util/structured-json.js';
import type { ResolvedSkill } from '../../skills/types.js';
import type { ModelFallbackChain } from '../../llm/model-fallback.js';
import { parseWebSearchIntent } from '../search-intent.js';
import { hasRequiredToolBackedAnswerPlan } from '../intent/planned-steps.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  buildChatResponseSourceMetadata,
  type ResponseSourceMetadata,
} from '../model-routing-ux.js';
import { isPhantomPendingApprovalMessage } from '../pending-approval-copy.js';
import type { ChatWithRoutingMetadataResult } from './provider-fallback.js';
import { chatWithAlternateProvider as chatWithAlternateProviderHelper } from './provider-fallback.js';
import type { PendingActionSetResult } from './orchestration-state.js';
import {
  buildBlockedToolLoopPendingApprovalContinuation,
  finalizeToolLoopPendingApprovals,
  recoverDirectAnswerAfterTools,
  type StoredToolLoopSanitizedResult,
} from './tool-loop-runtime.js';
import { executeToolLoopRound } from './tool-loop-round.js';

type LlmToolDefinition = NonNullable<ChatOptions['tools']>[number];

export interface LiveToolLoopControllerResult {
  finalContent: string;
  pendingActionMeta?: Record<string, unknown>;
  lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }>;
  latestContextCompaction?: ContextCompactionResult;
  responseSource?: ResponseSourceMetadata;
}

export interface LiveToolLoopControllerInput {
  agentId: string;
  ctx: AgentContext;
  message: UserMessage;
  llmMessages: ChatMessage[];
  tools?: ToolExecutor | null;
  secondBrainService?: Pick<SecondBrainService, 'getEventById' | 'getPersonById' | 'getTaskById'> | null;
  enabledManagedProviders?: ReadonlySet<string>;
  resolveGwsProvider?: () => LLMProvider | undefined;
  fallbackChain?: Pick<
    ModelFallbackChain,
    'chatWithFallback' | 'chatWithFallbackAfterPrimary' | 'chatWithFallbackAfterProvider' | 'chatWithProviderOrder'
  >;
  fallbackProviderOrder?: string[];
  selectedExecutionProfile?: SelectedExecutionProfile | null;
  qualityFallbackEnabled: boolean;
  directIntentDecision?: IntentGatewayDecision;
  directBrowserIntent: boolean;
  hasResolvedCodeSession: boolean;
  resolvedCodeSessionId?: string;
  effectiveCodeContext?: { workspaceRoot: string; sessionId?: string };
  activeSkills: readonly ResolvedSkill[];
  requestIntentContent: string;
  routedScopedMessage: UserMessage;
  conversationUserId: string;
  conversationChannel: string;
  allowModelMemoryMutation: boolean;
  defaultToolResultProviderKind: 'local' | 'external';
  maxToolRounds: number;
  contextBudget: number;
  pendingActionUserId: string;
  pendingActionChannel: string;
  pendingActionSurfaceId?: string;
  pendingActionUserKey: string;
  log: Pick<Logger, 'info' | 'warn'>;
  chatWithRoutingMetadata: (
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: ChatOptions,
    fallbackProviderOrder?: string[],
  ) => Promise<ChatWithRoutingMetadataResult>;
  resolveToolResultProviderKind: (ctx: AgentContext, overrideProvider?: LLMProvider) => 'local' | 'external';
  sanitizeToolResultForLlm: (
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ) => StoredToolLoopSanitizedResult;
  resolveRoutedProviderForTools?: (
    tools: Array<{ name: string; category?: string }>,
  ) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined;
  resolveStoredToolLoopExecutionProfile: (
    ctx: AgentContext,
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
    decision: IntentGatewayDecision | undefined,
  ) => SelectedExecutionProfile | null | undefined;
  lacksUsableAssistantContent: (content: string | undefined) => boolean;
  looksLikeOngoingWorkResponse: (content: string | undefined) => boolean;
  getPendingApprovalIds: (
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs?: number,
  ) => string[];
  setPendingApprovals: (
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs?: number,
  ) => void;
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
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  setChatContinuationGraphPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: Parameters<typeof finalizeToolLoopPendingApprovals>[0]['setChatContinuationGraphPendingApprovalActionForRequest'] extends (
      userKey: string,
      surfaceId: string | undefined,
      action: infer Action,
      nowMs?: number,
    ) => PendingActionSetResult ? Action : never,
    nowMs?: number,
  ) => PendingActionSetResult;
}

export async function runLiveToolLoopController(
  input: LiveToolLoopControllerInput,
): Promise<LiveToolLoopControllerResult> {
  const { ctx, message } = input;
  if (!ctx.llm) {
    return {
      finalContent: 'No LLM provider configured.',
      lastToolRoundResults: [],
    };
  }

  let finalContent = '';
  let pendingActionMeta: Record<string, unknown> | undefined;
  let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
  let latestContextCompaction: ContextCompactionResult | undefined;
  let responseSource: ResponseSourceMetadata | undefined;
  const directIntentDecision = input.directIntentDecision;

  const buildResponseSourceMetadata = (metadataInput: {
    locality: 'local' | 'external';
    providerName: string;
    response: ChatResponse;
    usedFallback: boolean;
    notice?: string;
    durationMs?: number;
  }): ResponseSourceMetadata | undefined => buildChatResponseSourceMetadata({
    response: metadataInput.response,
    selectedExecutionProfile: input.selectedExecutionProfile,
    providerName: metadataInput.providerName,
    providerLocality: metadataInput.locality,
    usedFallback: metadataInput.usedFallback,
    notice: metadataInput.notice,
    durationMs: metadataInput.durationMs,
  });

  const gwsProvider = input.enabledManagedProviders?.has('gws')
    && (directIntentDecision?.route === 'workspace_task' || directIntentDecision?.route === 'email_task')
    ? input.resolveGwsProvider?.()
    : undefined;
  let chatFn = async (msgs: ChatMessage[], opts?: ChatOptions) => {
    const mergedOpts = { ...opts, signal: message.abortSignal };
    if (gwsProvider) {
      try {
        const startedAt = Date.now();
        const response = await gwsProvider.chat(msgs, mergedOpts);
        responseSource = buildResponseSourceMetadata({
          locality: 'external',
          providerName: gwsProvider.name,
          response,
          usedFallback: false,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (err) {
        input.log.warn({ agent: input.agentId, error: err instanceof Error ? err.message : String(err) },
          'GWS provider failed, falling back to default');
        const fallback = await input.chatWithRoutingMetadata(ctx, msgs, mergedOpts, input.fallbackProviderOrder);
        responseSource = buildResponseSourceMetadata({
          locality: fallback.providerLocality,
          providerName: fallback.providerName,
          response: fallback.response,
          usedFallback: fallback.usedFallback,
          notice: fallback.notice,
          durationMs: fallback.durationMs,
        });
        return fallback.response;
      }
    }
    const routed = await input.chatWithRoutingMetadata(ctx, msgs, mergedOpts, input.fallbackProviderOrder);
    responseSource = buildResponseSourceMetadata({
      locality: routed.providerLocality,
      providerName: routed.providerName,
      response: routed.response,
      usedFallback: routed.usedFallback,
      notice: routed.notice,
      durationMs: routed.durationMs,
    });
    return routed.response;
  };
  let toolResultProviderKind = gwsProvider
    ? 'external' as const
    : input.defaultToolResultProviderKind;

  const providerLocality = input.resolveToolResultProviderKind(ctx);
  const tools = input.tools;

  if (shouldUseNoToolDirectAnswer(directIntentDecision)) {
    const response = await chatFn(input.llmMessages, { tools: [] });
    finalContent = response.content;
    return {
      finalContent: finalContent || 'I could not generate a final response for that request.',
      lastToolRoundResults,
      ...(responseSource ? { responseSource } : {}),
    };
  }

  if (!tools?.isEnabled()) {
    const response = await chatFn(input.llmMessages);
    finalContent = response.content;
    if (input.qualityFallbackEnabled && input.lacksUsableAssistantContent(finalContent) && input.fallbackChain && providerLocality === 'local') {
      input.log.warn({ agent: input.agentId }, 'Local LLM produced degraded response (no-tools path), retrying with fallback');
      try {
        const fb = await chatWithAlternateProviderHelper({
          primaryProviderName: ctx.llm?.name ?? 'unknown',
          messages: input.llmMessages,
          fallbackProviderOrder: input.fallbackProviderOrder,
          fallbackChain: input.fallbackChain,
        });
        if (fb?.response.content?.trim()) {
          finalContent = fb.response.content;
          responseSource = buildResponseSourceMetadata({
            locality: fb.providerLocality,
            providerName: fb.providerName,
            response: fb.response,
            usedFallback: fb.usedFallback,
            notice: 'Retried with an alternate model after a weak local response.',
            durationMs: fb.durationMs,
          });
        }
      } catch { /* fallback also failed, keep original */ }
    }
  } else {
    let rounds = 0;
    const baseToolDefs = tools.listAlwaysLoadedDefinitions();
    const eagerBrowserToolDefs = input.directBrowserIntent
      ? tools.listToolDefinitions().filter((definition) => definition.name.startsWith('browser_'))
      : [];
    const allToolDefs = [
      ...baseToolDefs,
      ...listIntentPlannedEagerToolDefinitions(input.directIntentDecision, tools, baseToolDefs),
      ...(input.hasResolvedCodeSession
        ? tools.listCodeSessionEagerToolDefinitions().filter((d) => !baseToolDefs.some((b) => b.name === d.name))
        : []),
      ...eagerBrowserToolDefs.filter((d) => !baseToolDefs.some((b) => b.name === d.name)),
    ];
    let llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, providerLocality));
    const pendingIds: string[] = [];
    let forcedPolicyRetryUsed = false;
    let forcedSkillShapeRetryCount = 0;
    let forcedSkillGroundingUsed = false;
    let forcedIntermediateStatusRetryCount = 0;
    let currentContextTrustLevel: ContentTrustLevel = 'trusted';
    const currentTaintReasons = new Set<string>();
    let seededAnswerFirstResponse: ChatResponse | null = null;
    let toolLoopPendingContinuation: Parameters<typeof finalizeToolLoopPendingApprovals>[0]['continuation'];
    const answerFirstOriginalRequest = stripLeadingContextPrefix(input.requestIntentContent);
    const shouldPreferAnswerFirst = shouldUseAnswerFirstForSkills(input.activeSkills, answerFirstOriginalRequest);
    const answerFirstCorrectionPrompt = shouldPreferAnswerFirst
      ? buildAnswerFirstSkillCorrectionPrompt(input.activeSkills, stripLeadingContextPrefix(input.requestIntentContent))
      : undefined;
    const answerFirstFallbackResponse = shouldPreferAnswerFirst
      ? buildAnswerFirstSkillFallbackResponse(input.activeSkills, stripLeadingContextPrefix(input.requestIntentContent))
      : undefined;

    if (shouldPreferAnswerFirst) {
      try {
        let answerFirstResponse = await chatFn(
          withTaintedContentSystemPrompt(input.llmMessages, currentContextTrustLevel, currentTaintReasons),
          { tools: [] },
        );
        if (!answerFirstResponse.toolCalls || answerFirstResponse.toolCalls.length === 0) {
          const recoveredToolCalls = recoverToolCallsFromStructuredText(answerFirstResponse.content ?? '', llmToolDefs);
          if (recoveredToolCalls?.toolCalls.length) {
            answerFirstResponse = {
              ...answerFirstResponse,
              toolCalls: recoveredToolCalls.toolCalls,
              finishReason: 'tool_calls',
              content: '',
            };
          }
        }
        const answerFirstContent = answerFirstResponse.content?.trim() ?? '';
        if (
          answerFirstContent
          && isAnswerFirstSkillResponseSufficientForSkills(input.activeSkills, answerFirstContent, answerFirstOriginalRequest)
          && (!answerFirstResponse.toolCalls || answerFirstResponse.toolCalls.length === 0)
        ) {
          finalContent = answerFirstContent;
        } else if (answerFirstResponse.toolCalls?.length) {
          seededAnswerFirstResponse = answerFirstResponse;
        }
      } catch {
        finalContent = '';
      }
    }

    while (rounds < input.maxToolRounds) {
      if (finalContent) break;
      const compactionResult = compactMessagesIfOverBudget(input.llmMessages, input.contextBudget);
      if (compactionResult.applied) {
        latestContextCompaction = compactionResult;
      }

      const plannerMessages = withTaintedContentSystemPrompt(
        input.llmMessages,
        currentContextTrustLevel,
        currentTaintReasons,
      );

      let response = rounds === 0 && seededAnswerFirstResponse
        ? seededAnswerFirstResponse
        : await chatFn(plannerMessages, { tools: llmToolDefs });
      seededAnswerFirstResponse = null;
      finalContent = response.content;
      if (
        !forcedPolicyRetryUsed
        && shouldRetryPolicyUpdateCorrection(input.llmMessages, finalContent, llmToolDefs)
      ) {
        forcedPolicyRetryUsed = true;
        response = await chatFn(
          [
            ...plannerMessages,
            { role: 'assistant', content: response.content ?? '' },
            { role: 'user', content: buildPolicyUpdateCorrectionPrompt() },
          ],
          { tools: llmToolDefs },
        );
        finalContent = response.content;
      }
      if (
        rounds === 0
        && (!response.toolCalls || response.toolCalls.length === 0)
        && isDirectMemorySaveRequest(stripLeadingContextPrefix(input.requestIntentContent))
      ) {
        response = await chatFn(
          [
            ...plannerMessages,
            { role: 'assistant', content: response.content ?? '' },
            { role: 'user', content: buildExplicitMemorySaveCorrectionPrompt(input.requestIntentContent) },
          ],
          { tools: llmToolDefs },
        );
        finalContent = response.content;
      }
      if (!response.toolCalls || response.toolCalls.length === 0) {
        response = recoverResponseToolCalls(response, llmToolDefs);
        if (response.toolCalls?.length) {
          finalContent = '';
        }
      }
      if (
        forcedSkillShapeRetryCount < 2
        && (!response.toolCalls || response.toolCalls.length === 0)
        && answerFirstCorrectionPrompt
        && !isAnswerFirstSkillResponseSufficientForSkills(input.activeSkills, response.content ?? '', answerFirstOriginalRequest)
      ) {
        forcedSkillShapeRetryCount += 1;
        response = await chatFn(
          [
            ...plannerMessages,
            { role: 'assistant', content: response.content ?? '' },
            { role: 'user', content: answerFirstCorrectionPrompt },
          ],
          { tools: llmToolDefs },
        );
        finalContent = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) {
          response = recoverResponseToolCalls(response, llmToolDefs);
          if (response.toolCalls?.length) {
            finalContent = '';
          }
        }
      }
      if (
        !forcedSkillGroundingUsed
        && (!response.toolCalls || response.toolCalls.length === 0)
        && shouldPreferAnswerFirst
        && !isAnswerFirstSkillResponseSufficientForSkills(input.activeSkills, response.content ?? '', answerFirstOriginalRequest)
        && llmToolDefs.some((definition) => definition.name === 'fs_read')
      ) {
        const skillSourcePaths = [...new Set(
          input.activeSkills
            .filter((skill) => shouldUseAnswerFirstForSkills([skill], answerFirstOriginalRequest))
            .map((skill) => skill.sourcePath?.trim() ?? '')
            .filter((value) => value.length > 0),
        )].slice(0, 2);
        if (skillSourcePaths.length > 0) {
          forcedSkillGroundingUsed = true;
          for (const [index, skillPath] of skillSourcePaths.entries()) {
            const prefetched = await tools.executeModelTool(
              'fs_read',
              { path: skillPath },
              {
                origin: 'assistant',
                agentId: input.agentId,
                userId: input.conversationUserId,
                principalId: message.principalId ?? input.conversationUserId,
                principalRole: message.principalRole ?? 'owner',
                channel: input.conversationChannel,
                requestId: message.id,
                agentContext: { checkAction: ctx.checkAction },
                codeContext: input.effectiveCodeContext,
              },
            );
            const scannedToolResult = input.sanitizeToolResultForLlm(
              'fs_read',
              prefetched,
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
            const toolCallId = `skill-grounding-${index + 1}`;
            input.llmMessages.push({
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: toolCallId,
                name: 'fs_read',
                arguments: JSON.stringify({ path: skillPath }),
              }],
            });
            input.llmMessages.push({
              role: 'tool',
              toolCallId,
              content: formatToolResultForLLM(
                'fs_read',
                scannedToolResult.sanitized,
                scannedToolResult.threats,
              ),
            });
          }
          response = await chatFn(
            withTaintedContentSystemPrompt(input.llmMessages, currentContextTrustLevel, currentTaintReasons),
            { tools: llmToolDefs },
          );
          finalContent = response.content;
          if (!response.toolCalls || response.toolCalls.length === 0) {
            response = recoverResponseToolCalls(response, llmToolDefs);
            if (response.toolCalls?.length) {
              finalContent = '';
            }
          }
        }
      }
      if (
        forcedIntermediateStatusRetryCount < 2
        && (!response.toolCalls || response.toolCalls.length === 0)
        && shouldRetryTerminalResultCorrection(response.content ?? '', {
          hasToolResults: lastToolRoundResults.length > 0,
          hasAnswerFirstContract: !!answerFirstCorrectionPrompt,
          hasToolExecutionContract: false,
        })
      ) {
        forcedIntermediateStatusRetryCount += 1;
        response = await chatFn(
          [
            ...plannerMessages,
            { role: 'assistant', content: response.content ?? '' },
            { role: 'user', content: buildTerminalResultCorrectionPrompt() },
          ],
          { tools: llmToolDefs },
        );
        finalContent = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) {
          response = recoverResponseToolCalls(response, llmToolDefs);
          if (response.toolCalls?.length) {
            finalContent = '';
          }
        }
      }
      if (response.toolCalls?.length) {
        response = {
          ...response,
          toolCalls: normalizeToolCallsForExecution(response.toolCalls, llmToolDefs),
        };
      }
      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (rounds === 0 && response.finishReason === 'stop') {
          const searchQuery = (!input.hasResolvedCodeSession && !input.effectiveCodeContext)
            ? parseWebSearchIntent(message.content)
            : null;
          if (searchQuery) {
            const prefetched = await tools.executeModelTool(
              'web_search',
              { query: searchQuery, maxResults: 5 },
              {
                origin: 'assistant',
                agentId: input.agentId,
                userId: input.conversationUserId,
                channel: input.conversationChannel,
                requestId: message.id,
                agentContext: { checkAction: ctx.checkAction },
                codeContext: input.effectiveCodeContext,
              },
            );
            if (toBoolean(prefetched.success) && prefetched.output) {
              const prefetchedScan = input.sanitizeToolResultForLlm('web_search', prefetched, toolResultProviderKind);
              if (prefetchedScan.trustLevel === 'quarantined') {
                currentContextTrustLevel = 'quarantined';
              } else if (prefetchedScan.trustLevel === 'low_trust' && currentContextTrustLevel === 'trusted') {
                currentContextTrustLevel = 'low_trust';
              }
              for (const reason of prefetchedScan.taintReasons) {
                currentTaintReasons.add(reason);
              }
              const safePrefetched = prefetchedScan.sanitized && typeof prefetchedScan.sanitized === 'object'
                ? prefetchedScan.sanitized as Record<string, unknown>
                : prefetched;
              const output = (safePrefetched && typeof safePrefetched === 'object' && safePrefetched.output && typeof safePrefetched.output === 'object'
                ? safePrefetched.output
                : prefetched.output) as { answer?: unknown; results?: unknown; provider?: unknown };
              const answer = toString(output.answer);
              const results = Array.isArray(output.results) ? output.results : [];
              const warningPrefix = formatToolThreatWarnings(prefetchedScan.threats);
              if (answer) {
                input.llmMessages.push({
                  role: 'user',
                  content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${answer}\n\nSources:\n${results.map((r: { url?: string }, i: number) => `${i + 1}. ${r.url ?? ''}`).join('\n')}\n\nPlease use these results to answer the user's question.`,
                });
              } else if (results.length > 0) {
                const snippets = results.map((r: { title?: string; url?: string; snippet?: string }, i: number) =>
                  `${i + 1}. ${r.title ?? '(untitled)'} — ${r.url ?? ''}\n   ${r.snippet ?? ''}`
                ).join('\n');
                input.llmMessages.push({
                  role: 'user',
                  content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${snippets}\n\nPlease synthesize these results to answer the user's question.`,
                });
              }
              if (answer || results.length > 0) {
                const retryResponse = await chatFn(
                  withTaintedContentSystemPrompt(input.llmMessages, currentContextTrustLevel, currentTaintReasons),
                );
                finalContent = retryResponse.content;
              }
            }
          }
        }
        break;
      }

      const toolExecOrigin = {
        origin: 'assistant' as const,
        agentId: input.agentId,
        userId: input.conversationUserId,
        surfaceId: message.surfaceId,
        principalId: message.principalId ?? input.conversationUserId,
        principalRole: message.principalRole ?? 'owner',
        channel: input.conversationChannel,
        requestId: message.id,
        contentTrustLevel: currentContextTrustLevel,
        taintReasons: [...currentTaintReasons],
        derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
        allowModelMemoryMutation: input.allowModelMemoryMutation,
        agentContext: { checkAction: ctx.checkAction },
        codeContext: input.effectiveCodeContext,
        activeSkills: input.activeSkills.map((skill) => skill.id),
        requestText: stripLeadingContextPrefix(input.routedScopedMessage.content),
      };

      const roundResult = await executeToolLoopRound({
        response: {
          ...response,
          toolCalls: response.toolCalls,
        },
        state: {
          llmMessages: input.llmMessages,
          allToolDefs,
          llmToolDefs,
          contentTrustLevel: currentContextTrustLevel,
          taintReasons: currentTaintReasons,
        },
        toolExecOrigin,
        referenceTime: message.timestamp,
        intentDecision: directIntentDecision,
        tools,
        secondBrainService: input.secondBrainService,
        toolResultProviderKind,
        sanitizeToolResultForLlm: input.sanitizeToolResultForLlm,
      });
      pendingIds.push(...roundResult.pendingIds);
      lastToolRoundResults = roundResult.lastToolRoundResults;
      currentContextTrustLevel = roundResult.contentTrustLevel;

      if (roundResult.hasPending && roundResult.allBlocked) {
        toolLoopPendingContinuation = buildBlockedToolLoopPendingApprovalContinuation({
          toolResults: roundResult.toolResults,
          llmMessages: input.llmMessages,
          deferredRemoteToolCallIds: roundResult.deferredRemoteToolCallIds,
          originalMessage: input.routedScopedMessage,
          requestText: stripLeadingContextPrefix(input.routedScopedMessage.content),
          referenceTime: message.timestamp,
          allowModelMemoryMutation: input.allowModelMemoryMutation,
          activeSkillIds: input.activeSkills.map((skill) => skill.id),
          contentTrustLevel: currentContextTrustLevel,
          taintReasons: [...currentTaintReasons],
          intentDecision: directIntentDecision ?? undefined,
          codeContext: input.effectiveCodeContext,
          selectedExecutionProfile: input.resolveStoredToolLoopExecutionProfile(
            ctx,
            input.selectedExecutionProfile,
            directIntentDecision,
          ),
        }) ?? undefined;
        break;
      }

      if (input.resolveRoutedProviderForTools) {
        const executedTools = response.toolCalls.map((tc) => {
          const def = tools.getToolDefinition?.(tc.name);
          return { name: tc.name, category: def?.category };
        });
        const routed = input.resolveRoutedProviderForTools(executedTools);
        if (routed) {
          const { provider: routedProvider, locality: routedLocality } = routed;
          chatFn = async (msgs, opts) => {
            const mergedOpts = { ...opts, signal: message.abortSignal };
            try {
              const startedAt = Date.now();
              const response = await routedProvider.chat(msgs, mergedOpts);
              responseSource = buildResponseSourceMetadata({
                locality: routedLocality,
                providerName: routedProvider.name,
                response,
                usedFallback: false,
                durationMs: Date.now() - startedAt,
              });
              return response;
            } catch (err) {
              input.log.warn({ agent: input.agentId, routing: routedLocality, error: err instanceof Error ? err.message : String(err) },
                'Routed provider failed, falling back to default');
              const fallback = await input.chatWithRoutingMetadata(ctx, msgs, mergedOpts, input.fallbackProviderOrder);
              responseSource = buildResponseSourceMetadata({
                locality: fallback.providerLocality,
                providerName: fallback.providerName,
                response: fallback.response,
                usedFallback: true,
                notice: fallback.notice,
                durationMs: fallback.durationMs,
              });
              return fallback.response;
            }
          };
          toolResultProviderKind = routedLocality;
          llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, toolResultProviderKind));
        }
      }

      rounds += 1;
    }

    if (
      (
        !finalContent
        || input.looksLikeOngoingWorkResponse(finalContent)
        || (
          !!answerFirstFallbackResponse
          && !isAnswerFirstSkillResponseSufficientForSkills(input.activeSkills, finalContent ?? '', answerFirstOriginalRequest)
        )
      )
      && lastToolRoundResults.length > 0
    ) {
      finalContent = await recoverDirectAnswerAfterTools({
        llmMessages: input.llmMessages,
        chatFn,
        currentContextTrustLevel,
        currentTaintReasons,
        lacksUsableAssistantContent: input.lacksUsableAssistantContent,
        looksLikeOngoingWorkResponse: input.looksLikeOngoingWorkResponse,
      });
    }

    if (
      input.qualityFallbackEnabled
      && (input.lacksUsableAssistantContent(finalContent) || input.looksLikeOngoingWorkResponse(finalContent))
      && input.fallbackChain
      && providerLocality === 'local'
      && pendingIds.length === 0
      && lastToolRoundResults.length === 0
    ) {
      input.log.warn({ agent: input.agentId, contentPreview: finalContent?.slice(0, 100) },
        'Local LLM produced degraded response, retrying with fallback chain');
      try {
        let externalToolDefs = llmToolDefs.map((d) => toLLMToolDef(d, 'external'));
        const fbMessages = [...input.llmMessages];
        const fallbackResult = await chatWithAlternateProviderHelper({
          primaryProviderName: ctx.llm?.name ?? 'unknown',
          messages: fbMessages,
          options: { tools: externalToolDefs },
          fallbackProviderOrder: input.fallbackProviderOrder,
          fallbackChain: input.fallbackChain,
        });
        if (!fallbackResult) {
          throw new Error('No alternate providers available in fallback chain');
        }
        const fbProvider = fallbackResult.providerName;
        responseSource = buildResponseSourceMetadata({
          locality: fallbackResult.providerLocality,
          providerName: fbProvider,
          response: fallbackResult.response,
          usedFallback: fallbackResult.usedFallback,
          notice: 'Retried with an alternate model after a weak local response.',
          durationMs: fallbackResult.durationMs,
        });

        const normalizedFallbackToolCalls = normalizeToolCallsForExecution(
          fallbackResult.response.toolCalls,
          llmToolDefs,
        );
        if (normalizedFallbackToolCalls?.length) {
          input.log.info({ agent: input.agentId, provider: fbProvider, toolCount: normalizedFallbackToolCalls.length },
            'Fallback provider requested tool calls, executing');
          const fbToolOrigin = {
            origin: 'assistant' as const,
            agentId: input.agentId,
            userId: input.conversationUserId,
            surfaceId: message.surfaceId,
            principalId: message.principalId ?? input.conversationUserId,
            principalRole: message.principalRole ?? 'owner',
            channel: input.conversationChannel,
            requestId: message.id,
            contentTrustLevel: currentContextTrustLevel,
            taintReasons: [...currentTaintReasons],
            derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
            allowModelMemoryMutation: input.allowModelMemoryMutation,
            agentContext: { checkAction: ctx.checkAction },
            codeContext: input.effectiveCodeContext,
            activeSkills: input.activeSkills.map((skill) => skill.id),
            requestText: stripLeadingContextPrefix(input.routedScopedMessage.content),
          };
          const fallbackRoundState = {
            llmMessages: fbMessages,
            allToolDefs,
            llmToolDefs: externalToolDefs,
            contentTrustLevel: currentContextTrustLevel,
            taintReasons: currentTaintReasons,
          };
          const fallbackRoundResult = await executeToolLoopRound({
            response: {
              ...fallbackResult.response,
              toolCalls: normalizedFallbackToolCalls,
            },
            state: fallbackRoundState,
            toolExecOrigin: fbToolOrigin,
            referenceTime: message.timestamp,
            intentDecision: directIntentDecision,
            tools,
            secondBrainService: input.secondBrainService,
            toolResultProviderKind: 'external',
            sanitizeToolResultForLlm: input.sanitizeToolResultForLlm,
          });
          externalToolDefs = fallbackRoundState.llmToolDefs;
          pendingIds.push(...fallbackRoundResult.pendingIds);
          currentContextTrustLevel = fallbackRoundResult.contentTrustLevel;

          if (fallbackRoundResult.hasPending) {
            if (fallbackRoundResult.allBlocked) {
              toolLoopPendingContinuation = buildBlockedToolLoopPendingApprovalContinuation({
                toolResults: fallbackRoundResult.toolResults,
                llmMessages: fbMessages,
                deferredRemoteToolCallIds: fallbackRoundResult.deferredRemoteToolCallIds,
                originalMessage: input.routedScopedMessage,
                requestText: stripLeadingContextPrefix(input.routedScopedMessage.content),
                referenceTime: message.timestamp,
                allowModelMemoryMutation: input.allowModelMemoryMutation,
                activeSkillIds: input.activeSkills.map((skill) => skill.id),
                contentTrustLevel: currentContextTrustLevel,
                taintReasons: [...currentTaintReasons],
                intentDecision: directIntentDecision ?? undefined,
                codeContext: input.effectiveCodeContext,
                selectedExecutionProfile: input.resolveStoredToolLoopExecutionProfile(
                  ctx,
                  input.selectedExecutionProfile,
                  directIntentDecision,
                ),
              }) ?? undefined;
            } else {
              const finalFb = await chatWithAlternateProviderHelper({
                primaryProviderName: fallbackResult.providerName,
                messages: fbMessages,
                options: { tools: externalToolDefs },
                fallbackProviderOrder: input.fallbackProviderOrder,
                fallbackChain: input.fallbackChain,
              });
              if (finalFb?.response.content?.trim()) {
                finalContent = finalFb.response.content;
                responseSource = buildResponseSourceMetadata({
                  locality: finalFb.providerLocality,
                  providerName: finalFb.providerName,
                  response: finalFb.response,
                  usedFallback: finalFb.usedFallback,
                  notice: 'Retried with an alternate model after local execution degraded.',
                  durationMs: finalFb.durationMs,
                });
                input.log.info({ agent: input.agentId, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
              }
            }
          } else {
            const finalFb = await chatWithAlternateProviderHelper({
              primaryProviderName: fallbackResult.providerName,
              messages: fbMessages,
              options: { tools: externalToolDefs },
              fallbackProviderOrder: input.fallbackProviderOrder,
              fallbackChain: input.fallbackChain,
            });
            if (finalFb?.response.content?.trim()) {
              finalContent = finalFb.response.content;
              responseSource = buildResponseSourceMetadata({
                locality: finalFb.providerLocality,
                providerName: finalFb.providerName,
                response: finalFb.response,
                usedFallback: finalFb.usedFallback,
                notice: 'Retried with an alternate model after local execution degraded.',
                durationMs: finalFb.durationMs,
              });
              input.log.info({ agent: input.agentId, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
            }
          }
        } else if (fallbackResult.response.content?.trim()) {
          finalContent = fallbackResult.response.content;
          responseSource = buildResponseSourceMetadata({
            locality: fallbackResult.providerLocality,
            providerName: fbProvider,
            response: fallbackResult.response,
            usedFallback: fallbackResult.usedFallback,
            notice: 'Retried with an alternate model after a weak local response.',
            durationMs: fallbackResult.durationMs,
          });
          input.log.info({ agent: input.agentId, provider: fbProvider },
            'Fallback provider produced successful response');
        }
      } catch (fallbackErr) {
        input.log.warn({ agent: input.agentId, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          'Fallback chain also failed');
      }
    }

    if (
      answerFirstFallbackResponse
      && (
        !isAnswerFirstSkillResponseSufficientForSkills(input.activeSkills, finalContent ?? '', answerFirstOriginalRequest)
        || input.looksLikeOngoingWorkResponse(finalContent)
      )
    ) {
      finalContent = answerFirstFallbackResponse;
    }

    const finalizedPendingApprovals = finalizeToolLoopPendingApprovals({
      pendingIds,
      pendingActionUserId: input.pendingActionUserId,
      pendingActionChannel: input.pendingActionChannel,
      pendingActionSurfaceId: input.pendingActionSurfaceId,
      pendingActionUserKey: input.pendingActionUserKey,
      originalUserContent: input.routedScopedMessage.content,
      finalContent,
      intentDecision: directIntentDecision,
      continuation: toolLoopPendingContinuation,
      codeSessionId: input.resolvedCodeSessionId,
      tools,
      getPendingApprovalIds: input.getPendingApprovalIds,
      setPendingApprovals: input.setPendingApprovals,
      setPendingApprovalAction: input.setPendingApprovalAction,
      setChatContinuationGraphPendingApprovalActionForRequest: input.setChatContinuationGraphPendingApprovalActionForRequest,
      lacksUsableAssistantContent: input.lacksUsableAssistantContent,
    });
    if (finalizedPendingApprovals) {
      finalContent = finalizedPendingApprovals.finalContent;
      pendingActionMeta = finalizedPendingApprovals.pendingActionMeta;
    }

    if ((!finalContent || input.looksLikeOngoingWorkResponse(finalContent)) && lastToolRoundResults.length > 0) {
      finalContent = summarizeToolRoundStatusMessage(lastToolRoundResults);
    }

    if (!pendingActionMeta && isPhantomPendingApprovalMessage(finalContent)) {
      finalContent = lastToolRoundResults.length > 0
        ? summarizeToolRoundStatusMessage(lastToolRoundResults)
        : 'I did not create a real approval request for that action. Please try again.';
    }

    if (!finalContent) {
      finalContent = 'I could not generate a final response for that request.';
    }
  }

  return {
    finalContent,
    ...(pendingActionMeta ? { pendingActionMeta } : {}),
    lastToolRoundResults,
    ...(latestContextCompaction ? { latestContextCompaction } : {}),
    ...(responseSource ? { responseSource } : {}),
  };
}

function shouldUseNoToolDirectAnswer(
  decision: IntentGatewayDecision | undefined,
): boolean {
  if (!decision) return false;
  if (decision.route === 'unknown' || decision.confidence === 'low') return false;
  return decision.preferredAnswerPath === 'direct'
    && decision.requiresRepoGrounding !== true
    && decision.requiresToolSynthesis !== true
    && !hasRequiredToolBackedAnswerPlan(decision);
}

function recoverResponseToolCalls(response: ChatResponse, llmToolDefs: LlmToolDefinition[]): ChatResponse {
  const recoveredToolCalls = recoverToolCallsFromStructuredText(response.content ?? '', llmToolDefs);
  if (!recoveredToolCalls?.toolCalls.length) {
    return response;
  }
  return {
    ...response,
    toolCalls: recoveredToolCalls.toolCalls,
    finishReason: 'tool_calls',
  };
}

function listIntentPlannedEagerToolDefinitions(
  decision: IntentGatewayDecision | undefined,
  tools: ToolExecutor,
  existing: readonly ToolDefinition[],
): ToolDefinition[] {
  const existingNames = new Set(existing.map((definition) => definition.name));
  const names = new Set<string>();
  if (decision?.route === 'search_task') {
    for (const name of ['web_search', 'doc_search', 'doc_search_list']) {
      names.add(name);
    }
  }
  for (const step of decision?.plannedSteps ?? []) {
    for (const category of step.expectedToolCategories ?? []) {
      for (const toolName of eagerToolNamesForPlannedCategory(category)) {
        names.add(toolName);
      }
    }
  }

  const definitions: ToolDefinition[] = [];
  for (const name of names) {
    if (existingNames.has(name)) continue;
    const definition = tools.getToolDefinition(name);
    if (!definition) continue;
    existingNames.add(name);
    definitions.push(definition);
  }
  return definitions;
}

function eagerToolNamesForPlannedCategory(category: string): string[] {
  const normalized = category.trim();
  if (normalized === 'doc_search') {
    return ['doc_search', 'doc_search_list'];
  }
  if (normalized === 'doc_search_list' || normalized === 'doc_search_status') {
    return [normalized];
  }
  return [];
}

function shouldRetryTerminalResultCorrection(
  content: string,
  context: {
    hasToolResults: boolean;
    hasAnswerFirstContract: boolean;
    hasToolExecutionContract: boolean;
  },
): boolean {
  if (!looksLikeOngoingWorkResponseShape(content)) {
    return false;
  }
  return context.hasToolResults || context.hasAnswerFirstContract || context.hasToolExecutionContract;
}

function buildTerminalResultCorrectionPrompt(): string {
  return [
    'System correction: your previous reply narrated ongoing work instead of delivering a terminal result.',
    'Continue the same request now.',
    'If more tool calls are required, call them now instead of narrating what you will do next.',
    'If the work is already complete, answer with the actual result, exact outputs, and any requested verification.',
    'Do not stop at phrases like "I\'ll inspect", "Let me", or "Now I\'ll".',
  ].join(' ');
}

function shouldRetryPolicyUpdateCorrection(
  messages: ChatMessage[],
  content: string | undefined,
  toolDefs: Array<{ name: string }>,
): boolean {
  const lower = content?.trim().toLowerCase();
  if (!lower) return false;
  if (!toolDefs.some((tool) => tool.name === 'update_tool_policy')) return false;

  const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content.toLowerCase() ?? '';
  const claimsToolMissing = lower.includes('update_tool_policy') && (
    lower.includes('not available')
    || lower.includes('unavailable')
    || lower.includes('no such tool')
    || lower.includes('no equivalent tool')
    || lower.includes('search returned no results')
    || lower.includes('search returned no matches')
  );
  const pushesManualConfig = lower.includes('manually add')
    || lower.includes('manually update')
    || lower.includes('edit the configuration file')
    || lower.includes('update your guardian agent config')
    || lower.includes('you will need to manually')
    || lower.includes('i can, however, save it to')
    || lower.includes('i can however save it to')
    || lower.includes('instead save it to');
  const asksForPolicyConfirmation = /\b(?:if you(?:['’]d)? like me to add|would you like me to add|please confirm(?: that)? you want me to add|i can request that approval now|we need policy approval to add)\b/.test(lower);
  const isPolicyScoped = /(allowlist|allow list|allowed domains|alloweddomains|allowed paths|allowed commands|outside the sandbox|blocked by policy|not in the allowed|not in alloweddomains|outside allowed paths|outside the authorized workspace root|outside the authorized workspace)/.test(`${latestUser}\n${lower}`);

  return isPolicyScoped && (claimsToolMissing || pushesManualConfig || asksForPolicyConfirmation);
}

function buildPolicyUpdateCorrectionPrompt(): string {
  return [
    'System correction: update_tool_policy is available in your current tool list.',
    'Do not tell the user to edit config manually for allowlist changes.',
    'If the block is a filesystem path, call update_tool_policy with action "add_path".',
    'If the block is a hostname/domain, call update_tool_policy with action "add_domain" using the normalized hostname only.',
    'If the block is a command prefix, call update_tool_policy with action "add_command".',
    'Use the tool now if policy is the blocker.',
  ].join(' ');
}

function buildExplicitMemorySaveCorrectionPrompt(requestContent: string): string {
  return [
    'System correction: the user already made an explicit remember/save request.',
    'Do not ask for confirmation or ask the user to restate it.',
    'Call memory_save now using the requested scope if one was specified.',
    `Original request: ${requestContent.trim()}`,
  ].join(' ');
}
