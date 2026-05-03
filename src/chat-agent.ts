import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { BaseAgent } from './agent/agent.js';
import type { AgentContext, AgentResponse, UserMessage } from './agent/types.js';
import type { ChatMessage, LLMProvider } from './llm/types.js';
import { composeGuardianSystemPrompt } from './prompts/guardian-core.js';
import { composeCodeSessionSystemPrompt } from './prompts/code-session-core.js';
import {
  buildCodeSessionWorkspaceAwarenessQuery,
  compactQuarantinedToolResult,
  getCodeSessionPromptRelativePath,
  isRecord,
  readCodeRequestMetadata,
  sameCodeWorkspaceWorkingSet,
  shouldRefreshCodeSessionFocus,
  shouldRefreshCodeSessionWorkingSet,
  stripLeadingContextPrefix,
  summarizeCodeSessionFocus,
  toString,
} from './chat-agent-helpers.js';
import type { ContextCompactionResult } from './util/context-budget.js';
import {
  lacksUsableAssistantContent as _lacksUsableAssistantContent,
  looksLikeOngoingWorkResponse as _looksLikeOngoingWorkResponse,
} from './util/assistant-response-shape.js';
import {
  shouldAllowModelMemoryMutation,
} from './util/memory-intent.js';
import type { ConversationKey } from './runtime/conversation.js';
import { ConversationService } from './runtime/conversation.js';
import type { CodeSessionRecord, ResolvedCodeSessionContext } from './runtime/code-sessions.js';
import { CodeSessionStore } from './runtime/code-sessions.js';
import {
  resolveConversationHistoryChannel,
  resolveConversationSurfaceId,
} from './runtime/channel-surface-ids.js';
import {
  formatCodingBackendApprovalResult,
} from './runtime/chat-agent/coding-backend-approval-result.js';
import type { SecondBrainService } from './runtime/second-brain/second-brain-service.js';
import { buildCodeSessionPortfolioAdditionalSection } from './runtime/code-session-portfolio.js';
import { inspectCodeWorkspaceSync, type CodeWorkspaceProfile } from './runtime/code-workspace-profile.js';
import type {
  AssistantResponseStyleConfig,
  GuardianAgentConfig,
} from './config/types.js';
import {
  buildCodeWorkspaceMapSync,
  buildCodeWorkspaceWorkingSetSync,
  shouldRefreshCodeWorkspaceMap,
} from './runtime/code-workspace-map.js';
import { buildIntentGatewaySearchSourceSummaries } from './runtime/intent/search-source-context.js';
import {
  assessCodeWorkspaceTrustSync,
  getEffectiveCodeWorkspaceTrustState,
  isCodeWorkspaceTrustReviewActive,
  shouldRefreshCodeWorkspaceTrust,
  type CodeWorkspaceTrustAssessment,
  type CodeWorkspaceTrustReview,
} from './runtime/code-workspace-trust.js';
import { CodeWorkspaceTrustService } from './runtime/code-workspace-trust-service.js';
import { AnalyticsService } from './runtime/analytics.js';
import {
  AgentMemoryStore,
  classifyMemoryEntrySource,
  type MemoryContextLoadResult,
  type MemoryContextQuery,
} from './runtime/agent-memory-store.js';
import {
  formatSkillInventoryResponse,
  isSkillInventoryQuery,
} from './runtime/skills-query.js';
import {
  type DirectIntentRoutingCandidate,
  runDirectRouteOrchestration,
} from './runtime/chat-agent/direct-route-orchestration.js';
import {
  buildChatDirectRouteHandlers,
  buildChatDirectCodingRouteDeps,
  buildDirectCodingTaskResumer,
  tryDirectChatCodeSessionControl,
  type ChatDirectCodingRouteDeps,
} from './runtime/chat-agent/direct-route-handlers.js';
import {
  attachPreRoutedIntentGatewayMetadata,
  detachPreRoutedIntentGatewayMetadata,
  enrichIntentGatewayRecordWithContentPlan,
  IntentGateway,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
  shouldReusePreRoutedIntentGatewayForContent,
  toIntentGatewayClientMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRoute,
  type IntentGatewayRecord,
} from './runtime/intent-gateway.js';
import {
  buildIntentGatewayHistoryQuery,
} from './runtime/intent/history-context.js';
import {
  hasRequiredToolBackedAnswerPlan,
} from './runtime/intent/planned-steps.js';
import {
  looksLikeSelfContainedDirectAnswerTurn,
  looksLikeStandaloneGreetingTurn,
} from './runtime/intent/request-patterns.js';
import {
  buildFrontierIntentPlanRepairProviderOrder,
  tryRepairGenericIntentGatewayPlan,
} from './runtime/intent/gateway-plan-repair.js';
import { buildContinuityAwareHistory } from './runtime/continuity-history.js';
import {
  shouldAttachCodeSessionForRequest,
  shouldUseCodeSessionConversationForRequest,
} from './runtime/code-session-request-scope.js';
import type { ToolApprovalDecisionResult, ToolExecutor } from './tools/executor.js';
import type { PrincipalRole } from './tools/types.js';
import {
  ChatAgentApprovalState,
  type ApprovalFollowUpCopy,
} from './runtime/chat-agent/approval-state.js';
import {
  tryBuildDirectPendingApprovalStatusResponse,
} from './runtime/chat-agent/pending-approval-status.js';
import {
  continuePendingActionAfterApproval as continuePendingActionAfterApprovalHelper,
  handleApprovalMessage,
  syncPendingApprovalsFromExecutor as syncPendingApprovalsFromExecutorHelper,
} from './runtime/chat-agent/approval-orchestration.js';
import {
  normalizeContinuationResponse as normalizeContinuationResponseHelper,
  readDirectContinuationStateMetadata,
  stripDirectContinuationStateMetadata,
} from './runtime/chat-agent/direct-continuation-state.js';
import {
  handleCodeSessionAttach as handleCodeSessionAttachHelper,
} from './runtime/chat-agent/code-session-control.js';
import {
  syncCodeSessionRuntimeState as syncCodeSessionRuntimeStateHelper,
} from './runtime/chat-agent/code-session-runtime-state.js';
import {
  tryDirectRecentToolReport as tryDirectRecentToolReportHelper,
} from './runtime/chat-agent/recent-tool-report.js';
import {
  readSecondBrainMutationApprovalDescriptor,
} from './runtime/chat-agent/direct-second-brain-mutation.js';
import {
  buildDirectSecondBrainSuccessResponse,
  type DirectRuntimeDepsInput,
} from './runtime/chat-agent/direct-runtime-deps.js';
import {
  buildStoredAutomationAuthoringInput,
  executeStoredAutomationAuthoring as executeStoredAutomationAuthoringHelper,
} from './runtime/chat-agent/automation-authoring-resume.js';
import {
  buildAssembledSystemPrompt as buildAssembledSystemPromptHelper,
  buildCodeSessionSystemContext as buildCodeSessionSystemContextHelper,
  buildContextAssemblyMetadata as buildContextAssemblyMetadataHelper,
  buildKnowledgeBaseContextQuery as buildKnowledgeBaseContextQueryHelper,
  buildPendingActionPromptContext as buildPendingActionPromptContextHelper,
  buildScopedSystemPrompt as buildScopedSystemPromptHelper,
  loadPromptKnowledgeBases as loadPromptKnowledgeBasesHelper,
} from './runtime/chat-agent/prompt-context.js';
import {
  executeStoredFilesystemSave as executeStoredFilesystemSaveHelper,
} from './runtime/chat-agent/filesystem-save-resume.js';
import {
  completeChatContinuationGraphResume,
  recordChatContinuationGraphApproval,
  startChatContinuationGraphApprovalResume,
  type ChatContinuationPayload,
} from './runtime/chat-agent/chat-continuation-graph.js';
import {
  executeChatContinuationPayload,
} from './runtime/chat-agent/chat-continuation-runtime.js';
import {
  buildStoredToolLoopChatRunner as buildStoredToolLoopChatRunnerHelper,
  resumeStoredToolLoopContinuation as resumeStoredToolLoopContinuationHelper,
} from './runtime/chat-agent/tool-loop-runtime.js';
import {
  runLiveToolLoopController,
} from './runtime/chat-agent/live-tool-loop-controller.js';
import {
  ChatAgentOrchestrationState,
} from './runtime/chat-agent/orchestration-state.js';
import {
  buildGatewayClarificationResponse as buildGatewayClarificationResponseHelper,
  filterIntentGatewayClassificationContext as filterIntentGatewayClassificationContextHelper,
  resolveIntentGatewayContent as resolveIntentGatewayContentHelper,
  resolvePendingActionContinuationContent as resolvePendingActionContinuationContentHelper,
  resolveRetryAfterFailureContinuationContent as resolveRetryAfterFailureContinuationContentHelper,
  shouldClearPendingActionAfterTurn as shouldClearPendingActionAfterTurnHelper,
  toPendingActionEntities,
  tryHandlePendingActionSwitchDecision as tryHandlePendingActionSwitchDecisionHelper,
  tryHandleWorkspaceSwitchContinuation as tryHandleWorkspaceSwitchContinuationHelper,
} from './runtime/chat-agent/intent-gateway-orchestration.js';
import {
  PendingActionStore,
  summarizePendingActionForGateway,
  toPendingActionClientMetadata,
  type PendingActionApprovalSummary,
  type PendingActionBlocker,
  type PendingActionRecord,
} from './runtime/pending-actions.js';
import {
  ContinuityThreadStore,
  hasContinuityThreadSurfaceLink,
  shouldUseContinuityThreadForTurn,
  summarizeContinuityThreadForGateway,
  toContinuityThreadClientMetadata,
  type ContinuityThreadContinuationState,
  type ContinuityThreadRecord,
} from './runtime/continuity-threads.js';
import {
  ExecutionStore,
  type ExecutionRecord,
} from './runtime/executions.js';
import type { ExecutionGraphStore } from './runtime/execution-graph/graph-store.js';
import type { RunTimelineStore } from './runtime/run-timeline.js';
import {
  buildChatMessagesFromHistory,
  buildContextCompactionDiagnostics,
  buildPromptAssemblyPreservedExecutionState,
  buildPromptAssemblySectionFootprints,
  type PromptAssemblyAdditionalSection,
  type PromptAssemblyDiagnostics,
  type PromptAssemblyKnowledgeBase,
} from './runtime/context-assembly.js';
import {
  buildRoutedIntentAdditionalSection,
} from './runtime/routed-tool-execution.js';
import type { IntentRoutingTraceLog } from './runtime/intent-routing-trace.js';
import {
  attachSelectedExecutionProfileMetadata,
  readSelectedExecutionProfileMetadata,
  selectDelegatedExecutionProfile,
  type SelectedExecutionProfile,
} from './runtime/execution-profiles.js';
import {
  handleDirectReasoningMode as handleDirectReasoningModeRuntime,
  shouldHandleDirectReasoningMode as shouldHandleDirectReasoningModeRuntime,
} from './runtime/direct-reasoning-mode.js';
import { readExecutionIdentityMetadata, type ExecutionIdentityMetadata } from './runtime/execution-identity.js';
import {
  constrainCapabilitiesToOrchestrationRole,
  inferDelegatedOrchestrationDescriptor,
} from './runtime/orchestration-role-contracts.js';
import type { ModelFallbackChain } from './llm/model-fallback.js';
import { getProviderLocality, getProviderTier } from './llm/provider-metadata.js';
import type { OutputGuardian } from './guardian/output-guardian.js';
import { SkillRegistry } from './skills/registry.js';
import { buildSkillPromptMaterial, createSkillPromptMaterialCache } from './skills/prompt.js';
import { SkillResolver } from './skills/resolver.js';
import type { ResolvedSkill, SkillPromptArtifactContext, SkillPromptMaterialResult } from './skills/types.js';
import { WorkerManager } from './supervisor/worker-manager.js';
import {
  getProviderLocalityFromName,
  readResponseSourceMetadata,
  type ResponseSourceMetadata,
} from './runtime/model-routing-ux.js';
import {
  chatWithFallback as chatWithFallbackHelper,
  chatWithRoutingMetadata as chatWithRoutingMetadataHelper,
} from './runtime/chat-agent/provider-fallback.js';
import {
  buildDirectHandlerResponseSource,
  readSecondBrainFocusContinuationState,
} from './runtime/chat-agent/direct-intent-helpers.js';

export interface ChatAgentClassDeps {
  log: Logger;
}

export interface ChatAgentPublicApi extends BaseAgent {
  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null;
  formatApprovalDecisionResultResponse(
    pendingAction: PendingActionRecord | null,
    approvalResult?: ToolApprovalDecisionResult,
    scope?: {
      userId: string;
      channel: string;
      surfaceId?: string;
    },
  ): { content: string; metadata?: Record<string, unknown> } | null;
  syncPendingApprovalsFromExecutorForScope(args: {
    userId: string;
    channel: string;
    surfaceId?: string;
  }): void;
  resetPendingState(args: {
    userId: string;
    channel: string;
    surfaceId?: string;
    approvalIds?: string[];
  }): void;
  continuePendingActionAfterApproval(
    pendingAction: PendingActionRecord | null,
    approvalId: string,
    decision: 'approved' | 'denied',
    approvalResult?: ToolApprovalDecisionResult,
    options?: {
      resumeStoredExecutionGraphPendingAction?: (
        pendingAction: PendingActionRecord,
        options: {
          approvalId: string;
          approvalResult: ToolApprovalDecisionResult;
        },
      ) => Promise<{ content: string; metadata?: Record<string, unknown> } | null>;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null>;
}

export interface ChatAgentConstructor {
  new (
    id: string,
    name: string,
    systemPrompt?: string,
    conversationService?: ConversationService,
    tools?: ToolExecutor,
    outputGuardian?: OutputGuardian,
    skillRegistry?: SkillRegistry,
    skillResolver?: SkillResolver,
    enabledManagedProviders?: ReadonlySet<string>,
    fallbackChain?: ModelFallbackChain,
    soulPrompt?: string,
    memoryStore?: AgentMemoryStore,
    codeSessionMemoryStore?: AgentMemoryStore,
    codeSessionStore?: CodeSessionStore,
    secondBrainService?: SecondBrainService,
    codeWorkspaceTrustService?: CodeWorkspaceTrustService,
    stateAgentId?: string,
    resolveGwsProvider?: () => LLMProvider | undefined,
    contextBudget?: number,
    qualityFallback?: boolean,
    analytics?: AnalyticsService,
    resolveRoutedProviderForTools?: (tools: Array<{ name: string; category?: string }>) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined,
    intentRoutingTrace?: IntentRoutingTraceLog,
    pendingActionStore?: PendingActionStore,
    continuityThreadStore?: ContinuityThreadStore,
    executionStore?: ExecutionStore,
    intentGateway?: IntentGateway,
    resolveAssistantResponseStyle?: () => AssistantResponseStyleConfig | undefined,
    readConfig?: () => GuardianAgentConfig | undefined,
    executionGraphStore?: ExecutionGraphStore,
    runTimeline?: RunTimelineStore,
  ): ChatAgentPublicApi;
}

export function createChatAgentClass({ log }: ChatAgentClassDeps): ChatAgentConstructor {
interface DirectIntentResponseInput {
  candidate: DirectIntentRoutingCandidate;
  result: string | { content: string; metadata?: Record<string, unknown> };
  message: UserMessage;
  routingMessage?: UserMessage;
  intentGateway?: IntentGatewayRecord | null;
  ctx: AgentContext;
  activeSkills: ResolvedSkill[];
  conversationKey: ConversationKey;
  surfaceUserId?: string;
  surfaceChannel?: string;
  surfaceId?: string;
}

interface DegradedDirectIntentResponseInput {
  candidate: DirectIntentRoutingCandidate;
  result: string | { content: string; metadata?: Record<string, unknown> };
  message: UserMessage;
  intentGateway?: IntentGatewayRecord | null;
  activeSkills: ResolvedSkill[];
  conversationKey: ConversationKey;
  degradedReason: string;
  surfaceUserId?: string;
  surfaceChannel?: string;
  surfaceId?: string;
}

  return class ChatAgent extends BaseAgent {
  private systemPrompt: string;
  private codeSessionSystemPrompt: string;
  private customSystemPrompt?: string;
  private soulPromptText?: string;
  private resolveAssistantResponseStyle?: () => AssistantResponseStyleConfig | undefined;
  private conversationService?: ConversationService;
  private tools?: ToolExecutor;
  private outputGuardian?: OutputGuardian;
  private skillRegistry?: SkillRegistry;
  private skillResolver?: SkillResolver;
  private enabledManagedProviders?: ReadonlySet<string>;
  private maxToolRounds: number;
  /** Approval follow-up copy and prompt formatting. */
  private readonly approvalState: ChatAgentApprovalState;
  /** Shared blocked-work and continuity helpers extracted from the chat-agent monolith. */
  private readonly orchestrationState: ChatAgentOrchestrationState;
  get pendingActionStore(): PendingActionStore | undefined {
    return this.orchestrationState.getPendingActionStore();
  }
  set pendingActionStore(value: PendingActionStore | undefined) {
    this.orchestrationState.setPendingActionStore(value);
  }
  get continuityThreadStore(): ContinuityThreadStore | undefined {
    return this.orchestrationState.getContinuityThreadStore();
  }
  set continuityThreadStore(value: ContinuityThreadStore | undefined) {
    this.orchestrationState.setContinuityThreadStore(value);
  }
  get executionStore(): ExecutionStore | undefined {
    return this.orchestrationState.getExecutionStore();
  }
  set executionStore(value: ExecutionStore | undefined) {
    this.orchestrationState.setExecutionStore(value);
  }
  get capabilityExecutionGraphStore(): ExecutionGraphStore | undefined {
    return this.executionGraphStore;
  }
  set capabilityExecutionGraphStore(value: ExecutionGraphStore | undefined) {
    this.executionGraphStore = value;
  }
  get capabilityRunTimeline(): RunTimelineStore | undefined {
    return this.runTimeline;
  }
  set capabilityRunTimeline(value: RunTimelineStore | undefined) {
    this.runTimeline = value;
  }
  private executionGraphStore?: ExecutionGraphStore;
  private runTimeline?: RunTimelineStore;
  /** Durable trace for intent gateway, tier routing, and direct execution decisions. */
  private intentRoutingTrace?: IntentRoutingTraceLog;
  /** Optional model fallback chain for retrying failed LLM calls. */
  private fallbackChain?: ModelFallbackChain;
  /** Per-agent persistent knowledge base. */
  private memoryStore?: AgentMemoryStore;
  /** Per-code-session persistent knowledge base. */
  private codeSessionMemoryStore?: AgentMemoryStore;
  /** Backend-owned coding session store for cross-surface coding workflows. */
  private codeSessionStore?: CodeSessionStore;
  /** Shared Second Brain runtime for personal productivity objects. */
  private secondBrainService?: SecondBrainService;
  /** Background workspace-trust enrichment for native AV scans. */
  private codeWorkspaceTrustService?: CodeWorkspaceTrustService;
  /** Logical state identity used for shared conversation/memory context. */
  private readonly stateAgentId: string;
  /** Resolver for the GWS LLM provider — looked up at request time so hot-reloaded config is used. */
  private resolveGwsProvider?: () => LLMProvider | undefined;
  /** Approximate token budget for tool results in context. */
  private contextBudget: number;
  /** Whether to retry degraded local LLM responses with an external fallback. */
  private qualityFallbackEnabled: boolean;
  /** Optional analytics sink for skill-trigger telemetry. */
  private analytics?: AnalyticsService;
  /** Resolve a routed LLM provider based on tools just executed. Returns undefined if no routing override. */
  private resolveRoutedProviderForTools?: (tools: Array<{ name: string; category?: string }>) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined;
  /** Shadow-mode structured classifier for top-level request routing. */
  private readonly intentGateway: IntentGateway;
  /** Hot config accessor for delegated execution-profile selection. */
  private readConfig?: () => GuardianAgentConfig | undefined;

  private buildPromptAdditionalSections(
    skillPromptMaterial: SkillPromptMaterialResult | undefined,
    intentDecision?: IntentGatewayDecision | null,
    executionProfile?: SelectedExecutionProfile | null,
    seedSections?: PromptAssemblyAdditionalSection[],
  ): PromptAssemblyAdditionalSection[] | undefined {
    const sections: PromptAssemblyAdditionalSection[] = [
      ...(seedSections ?? []),
      ...(skillPromptMaterial?.additionalSections ?? []),
    ];
    const routedIntentSection = buildRoutedIntentAdditionalSection(intentDecision);
    if (routedIntentSection && !sections.some((section) => section.section === routedIntentSection.section)) {
      sections.push(routedIntentSection);
    }
    const bounded = executionProfile
      ? sections.slice(0, Math.max(0, executionProfile.maxAdditionalSections))
      : sections;
    return bounded.length > 0 ? bounded : undefined;
  }

  private resolveReferencedCodeSessionsForSurface(
    message: UserMessage,
    currentSession?: CodeSessionRecord | null,
  ): CodeSessionRecord[] {
    if (!this.codeSessionStore) return [];
    const ownerUserId = currentSession?.ownerUserId ?? message.userId?.trim();
    const channel = message.channel?.trim();
    if (!ownerUserId || !channel) return [];
    const referencedSessions = this.codeSessionStore.listReferencedSessionsForSurface({
      userId: ownerUserId,
      principalId: message.principalId,
      channel,
      surfaceId: this.getCodeSessionSurfaceId(message),
    });
    if (!currentSession?.id) {
      return referencedSessions;
    }
    return referencedSessions.filter((session) => session.id !== currentSession.id);
  }

  private buildReferencedCodeSessionsSection(
    currentSession?: CodeSessionRecord | null,
    referencedSessions?: readonly CodeSessionRecord[],
  ): PromptAssemblyAdditionalSection | undefined {
    const content = buildCodeSessionPortfolioAdditionalSection({
      currentSession,
      referencedSessions,
    });
    if (!content) return undefined;
    return {
      section: 'code_session_portfolio',
      content,
      mode: 'inventory',
      itemCount: Array.isArray(referencedSessions) ? referencedSessions.length : 0,
    };
  }

  constructor(
    id: string,
    name: string,
    systemPrompt?: string,
    conversationService?: ConversationService,
    tools?: ToolExecutor,
    outputGuardian?: OutputGuardian,
    skillRegistry?: SkillRegistry,
    skillResolver?: SkillResolver,
    enabledManagedProviders?: ReadonlySet<string>,
    fallbackChain?: ModelFallbackChain,
    soulPrompt?: string,
    memoryStore?: AgentMemoryStore,
    codeSessionMemoryStore?: AgentMemoryStore,
    codeSessionStore?: CodeSessionStore,
    secondBrainService?: SecondBrainService,
    codeWorkspaceTrustService?: CodeWorkspaceTrustService,
    stateAgentId?: string,
    resolveGwsProvider?: () => LLMProvider | undefined,
    contextBudget?: number,
    qualityFallback?: boolean,
    analytics?: AnalyticsService,
    resolveRoutedProviderForTools?: (tools: Array<{ name: string; category?: string }>) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined,
    intentRoutingTrace?: IntentRoutingTraceLog,
    pendingActionStore?: PendingActionStore,
    continuityThreadStore?: ContinuityThreadStore,
    executionStore?: ExecutionStore,
    intentGateway?: IntentGateway,
    resolveAssistantResponseStyle?: () => AssistantResponseStyleConfig | undefined,
    readConfig?: () => GuardianAgentConfig | undefined,
    executionGraphStore?: ExecutionGraphStore,
    runTimeline?: RunTimelineStore,
  ) {
    super(id, name, { handleMessages: true });
    this.customSystemPrompt = systemPrompt;
    this.soulPromptText = soulPrompt;
    this.resolveAssistantResponseStyle = resolveAssistantResponseStyle;
    const initialResponseStyle = this.resolveAssistantResponseStyle?.();
    this.systemPrompt = composeGuardianSystemPrompt(systemPrompt, soulPrompt, initialResponseStyle);
    this.codeSessionSystemPrompt = composeCodeSessionSystemPrompt(initialResponseStyle);
    log.debug(
      {
        agentId: id,
        systemPromptChars: this.systemPrompt.length,
        codeSessionPromptChars: this.codeSessionSystemPrompt.length,
        soulChars: soulPrompt?.length ?? 0,
      },
      'Initialized chat agent prompt context',
    );
    this.conversationService = conversationService;
    this.tools = tools;
    this.outputGuardian = outputGuardian;
    this.skillRegistry = skillRegistry;
    this.skillResolver = skillResolver;
    this.enabledManagedProviders = enabledManagedProviders;
    this.maxToolRounds = 6;
    this.fallbackChain = fallbackChain;
    this.memoryStore = memoryStore;
    this.codeSessionMemoryStore = codeSessionMemoryStore;
    this.codeSessionStore = codeSessionStore;
    this.secondBrainService = secondBrainService;
    this.codeWorkspaceTrustService = codeWorkspaceTrustService;
    this.stateAgentId = stateAgentId ?? id;
    this.resolveGwsProvider = resolveGwsProvider;
    this.contextBudget = contextBudget ?? 80_000;
    this.qualityFallbackEnabled = qualityFallback ?? true;
    this.analytics = analytics;
    this.resolveRoutedProviderForTools = resolveRoutedProviderForTools;
    this.intentRoutingTrace = intentRoutingTrace;
    this.approvalState = new ChatAgentApprovalState({ tools });
    this.orchestrationState = new ChatAgentOrchestrationState({
      stateAgentId: this.stateAgentId,
      pendingActionStore,
      continuityThreadStore,
      executionStore,
      tools,
    });
    this.intentGateway = intentGateway ?? new IntentGateway();
    this.readConfig = readConfig;
    this.executionGraphStore = executionGraphStore;
    this.runTimeline = runTimeline;
  }

  private recordIntentRoutingTrace(
    stage: import('./runtime/intent-routing-trace.js').IntentRoutingTraceStage,
    input: {
      message?: UserMessage;
      requestId?: string;
      details?: Record<string, unknown>;
      contentPreview?: string;
      continuityThread?: ContinuityThreadRecord | null;
    },
  ): void {
    const hasContinuityOverride = Object.prototype.hasOwnProperty.call(input, 'continuityThread');
    const continuity = hasContinuityOverride
      ? summarizeContinuityThreadForGateway(input.continuityThread)
      : input.message?.userId
        ? summarizeContinuityThreadForGateway(this.getContinuityThread(input.message.userId))
        : null;
    const details = {
      ...(continuity?.continuityKey ? { continuityKey: continuity.continuityKey } : {}),
      ...(continuity?.activeExecutionRefs?.length ? { activeExecutionRefs: continuity.activeExecutionRefs } : {}),
      ...(typeof continuity?.linkedSurfaceCount === 'number' ? { linkedSurfaceCount: continuity.linkedSurfaceCount } : {}),
      ...(continuity?.continuationStateKind ? { continuationStateKind: continuity.continuationStateKind } : {}),
      ...(input.details ?? {}),
    };
    this.intentRoutingTrace?.record({
      stage,
      requestId: input.requestId,
      messageId: input.message?.id,
      userId: input.message?.userId,
      channel: input.message?.channel,
      agentId: this.id,
      contentPreview: input.contentPreview
        ?? (input.message?.content ? stripLeadingContextPrefix(input.message.content) : undefined),
      details: Object.keys(details).length > 0 ? details : undefined,
    });
  }

  private tryDirectSkillInventoryResponse(content: string): string | null {
    if (!this.skillRegistry) return null;
    if (!isSkillInventoryQuery(content)) return null;
    return formatSkillInventoryResponse(this.skillRegistry.listStatus());
  }

  private tryDirectUnsupportedManagedProviderPlanResponse(
    decision: IntentGatewayDecision | undefined,
  ): string | null {
    const provider = this.resolveUnsupportedManagedProviderFromDecision(decision);
    if (!provider) return null;
    const label = provider === 'slack'
      ? 'Slack'
      : provider === 'notion'
      ? 'Notion'
      : provider === 'email'
      ? 'the local email provider'
      : provider;
    return `${label} is not connected or enabled in this Guardian session, so I cannot use ${label} tools for that request right now.`;
  }

  private resolveUnsupportedManagedProviderFromDecision(
    decision: IntentGatewayDecision | undefined,
  ): 'slack' | 'notion' | 'email' | null {
    if (!decision?.plannedSteps?.length || !this.enabledManagedProviders) return null;
    const enabledProviders = new Set([...this.enabledManagedProviders].map((provider) => provider.trim().toLowerCase()));
    const aliases: Record<string, 'slack' | 'notion' | 'email'> = {
      slack: 'slack',
      notion: 'notion',
      email: 'email',
      himalaya: 'email',
    };
    for (const step of decision.plannedSteps) {
      for (const category of step.expectedToolCategories ?? []) {
        const normalized = category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const base = normalized.replace(/_(?:status|read|write|send|draft|list|search|schema)$/g, '');
        const provider = aliases[normalized] ?? aliases[base];
        if (provider && !enabledProviders.has(provider)) {
          return provider;
        }
      }
    }
    return null;
  }

  private tryDirectPendingApprovalStatusResponse(
    message: UserMessage,
    options?: { exactOnly?: boolean },
  ): { content: string; metadata?: Record<string, unknown> } | null {
    return tryBuildDirectPendingApprovalStatusResponse(message, {
      tools: this.tools,
      getCodeSessionSurfaceId: (nextMessage) => this.getCodeSessionSurfaceId(nextMessage),
      getPendingApprovalAction: (userId, channel, surfaceId) => this.getPendingApprovalAction(userId, channel, surfaceId),
      setPendingApprovals: (userKey, ids, surfaceId) => this.setPendingApprovals(userKey, ids, surfaceId),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
    }, options);
  }

  private trackResolvedSkills(
    message: UserMessage,
    requestType: string,
    skills: readonly ResolvedSkill[],
    stage: 'resolved' | 'prompt_injected',
  ): void {
    if (!this.analytics || skills.length === 0) return;
    for (const skill of skills) {
      this.analytics.track({
        type: stage === 'resolved' ? 'skill_resolved' : 'skill_prompt_injected',
        channel: message.channel,
        canonicalUserId: message.userId,
        channelUserId: message.userId,
        agentId: this.id,
        metadata: {
          skillId: skill.id,
          skillName: skill.name,
          skillRole: skill.role ?? null,
          score: skill.score,
          requestType,
        },
      });
    }
  }

  private trackSkillPromptMaterial(
    message: UserMessage,
    route: string | undefined,
    material: SkillPromptMaterialResult | undefined,
  ): void {
    if (!this.analytics || !material) return;
    const instructionCount = material.metadata.instructionSkillIds.length;
    const resourceCount = material.metadata.loadedResourcePaths.length;
    const artifactCount = material.metadata.artifactReferences.length;
    const cacheHitCount = material.metadata.cacheHits.length;
    if (instructionCount === 0 && resourceCount === 0 && artifactCount === 0 && cacheHitCount === 0) return;
    this.analytics.track({
      type: 'skill_prompt_material_loaded',
      channel: message.channel,
      canonicalUserId: message.userId,
      channelUserId: message.userId,
      agentId: this.id,
      metadata: {
        ...(route?.trim() ? { route: route.trim() } : {}),
        skillIds: material.metadata.skillIds,
        instructionSkillIds: material.metadata.instructionSkillIds,
        resourceSkillIds: material.metadata.resourceSkillIds,
        loadedResourcePaths: material.metadata.loadedResourcePaths,
        cacheHits: material.metadata.cacheHits,
        loadReasons: material.metadata.loadReasons,
        artifactReferences: material.metadata.artifactReferences,
      },
    });
  }

  private isSkillArtifactEntryStale(entry: {
    artifact?: {
      nextReviewAt?: string;
      updatedAt?: string;
      staleAfterDays?: number;
    };
    createdAt: string;
  }): boolean {
    const nextReviewAt = Date.parse(entry.artifact?.nextReviewAt ?? '');
    if (Number.isFinite(nextReviewAt)) {
      return nextReviewAt <= Date.now();
    }
    const staleAfterDays = typeof entry.artifact?.staleAfterDays === 'number'
      && Number.isFinite(entry.artifact.staleAfterDays)
      ? Math.max(1, Math.round(entry.artifact.staleAfterDays))
      : null;
    if (!staleAfterDays) return false;
    const referenceMs = Date.parse(entry.artifact?.updatedAt || entry.createdAt);
    if (!Number.isFinite(referenceMs)) return false;
    return (referenceMs + staleAfterDays * 24 * 60 * 60 * 1000) <= Date.now();
  }

  private resolveSkillArtifactReferences(
    skills: readonly ResolvedSkill[],
    resolvedCodeSession?: ResolvedCodeSessionContext | null,
  ): SkillPromptArtifactContext[] {
    if (!this.skillRegistry || skills.length === 0 || !this.memoryStore) return [];
    const contexts: SkillPromptArtifactContext[] = [];

    for (const skill of skills) {
      const loadedSkill = this.skillRegistry.get(skill.id);
      const references = loadedSkill?.manifest.artifactReferences;
      if (!Array.isArray(references) || references.length === 0) continue;

      for (const reference of references) {
        const scope = reference.scope === 'coding_session' ? 'coding_session' : 'global';
        const store = scope === 'coding_session'
          ? (resolvedCodeSession ? this.codeSessionMemoryStore : undefined)
          : this.memoryStore;
        const agentId = scope === 'coding_session'
          ? resolvedCodeSession?.session.id
          : this.stateAgentId;
        if (!store || !agentId) continue;

        const match = store.getEntries(agentId)
          .find((entry) => {
            if ((entry.artifact?.kind ?? '') !== 'wiki_page') return false;
            if ((entry.artifact?.slug ?? '').trim() !== reference.slug) return false;
            const sourceClass = classifyMemoryEntrySource(entry);
            if (sourceClass !== 'operator_curated' && sourceClass !== 'canonical') return false;
            if (this.isSkillArtifactEntryStale(entry)) return false;
            return true;
          });
        if (!match) continue;

        const sourceClass = classifyMemoryEntrySource(match);
        const title = match.artifact?.title?.trim() || reference.title?.trim() || reference.slug;
        const content = match.summary?.trim() || match.content.trim();
        if (!content) continue;
        contexts.push({
          skillId: skill.id,
          scope,
          slug: reference.slug,
          title,
          sourceClass,
          content,
          truncated: false,
        });
      }
    }

    return contexts;
  }

  private shouldHandleDirectAssistantInline(input: {
    gateway: IntentGatewayRecord | null | undefined;
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined;
    currentProviderName?: string;
  }): boolean {
    const decision = input.gateway?.decision;
    if (!decision) return false;
    if (decision.executionClass !== 'direct_assistant') return false;
    if (decision.requiresRepoGrounding || decision.requiresToolSynthesis) return false;
    if (hasRequiredToolBackedAnswerPlan(decision)) return false;
    const preferredAnswerPath = decision.preferredAnswerPath ?? input.selectedExecutionProfile?.preferredAnswerPath;
    if (preferredAnswerPath !== 'direct') return false;

    const requestedProviderName = input.selectedExecutionProfile?.selectionSource === 'request_override'
      ? input.selectedExecutionProfile.providerName?.trim()
      : '';
    if (!requestedProviderName) {
      return true;
    }
    return requestedProviderName === (input.currentProviderName?.trim() || '')
      || !!this.fallbackChain;
  }

  private shouldUseMinimalDirectAssistantContext(input: {
    gateway: IntentGatewayRecord | null | undefined;
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined;
    currentProviderName?: string;
    messageContent: string;
    activeSkillCount: number;
  }): boolean {
    if (input.activeSkillCount > 0) return false;
    const requestContent = stripLeadingContextPrefix(input.messageContent);
    if (
      !looksLikeSelfContainedDirectAnswerTurn(requestContent)
      && !looksLikeStandaloneGreetingTurn(requestContent)
    ) {
      return false;
    }
    return this.shouldHandleDirectAssistantInline(input);
  }

  /**
   * Chat with fallback: try ctx.llm first, fall back to chain on failure.
   * Returns ChatResponse from whichever provider succeeds.
   */
  private async chatWithFallback(
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: import('./llm/types.js').ChatOptions,
    fallbackProviderOrder?: string[],
  ): Promise<import('./llm/types.js').ChatResponse> {
    return chatWithFallbackHelper({
      agentId: this.id,
      ctx,
      messages,
      options,
      fallbackProviderOrder,
      fallbackChain: this.fallbackChain,
      log,
    });
  }

  private async chatWithRoutingMetadata(
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: import('./llm/types.js').ChatOptions,
    fallbackProviderOrder?: string[],
  ): Promise<{
    response: import('./llm/types.js').ChatResponse;
    providerName: string;
    providerLocality: 'local' | 'external';
    usedFallback: boolean;
    notice?: string;
    durationMs: number;
  }> {
    return chatWithRoutingMetadataHelper({
      agentId: this.id,
      ctx,
      messages,
      options,
      fallbackProviderOrder,
      fallbackChain: this.fallbackChain,
      log,
    });
  }

  async onMessage(message: UserMessage, ctx: AgentContext, workerManager?: WorkerManager): Promise<AgentResponse> {
    const stateAgentId = this.stateAgentId;
    const pendingActionSurfaceId = this.getCodeSessionSurfaceId(message);
    const effectiveMessage: UserMessage = message;
    const executionIdentity = readExecutionIdentityMetadata(effectiveMessage.metadata) ?? {
      executionId: effectiveMessage.id,
      rootExecutionId: effectiveMessage.id,
    };
    const requestedCodeContext = readCodeRequestMetadata(effectiveMessage.metadata);
    let resolvedCodeSession = this.resolveCodeSessionContext(effectiveMessage);
    if (resolvedCodeSession) {
      resolvedCodeSession = await this.refreshCodeSessionWorkspaceAwareness(
        resolvedCodeSession,
        buildCodeSessionWorkspaceAwarenessQuery(
          stripLeadingContextPrefix(effectiveMessage.content),
          requestedCodeContext?.fileReferences,
        ),
      );
    }
    const useCodeSessionConversation = shouldUseCodeSessionConversationForRequest({
      channel: effectiveMessage.channel,
      surfaceId: pendingActionSurfaceId,
      requestedCodeContext,
      resolvedCodeSession,
      metadata: effectiveMessage.metadata,
    });
    const scopedCodeSession = useCodeSessionConversation ? resolvedCodeSession : null;
    const conversationUserId = scopedCodeSession?.session.conversationUserId ?? effectiveMessage.userId;
    const conversationChannel = scopedCodeSession?.session.conversationChannel
      ?? resolveConversationHistoryChannel({
        channel: effectiveMessage.channel,
        surfaceId: effectiveMessage.surfaceId,
      });
    const selectedExecutionProfile = readSelectedExecutionProfileMetadata(effectiveMessage.metadata);
    const fallbackProviderOrder = selectedExecutionProfile?.fallbackProviderOrder;
    const conversationKey = {
      agentId: stateAgentId,
      userId: conversationUserId,
      channel: conversationChannel,
    };
    const pendingActionUserId = effectiveMessage.userId;
    const pendingActionChannel = effectiveMessage.channel;
    const pendingActionUserKey = `${pendingActionUserId}:${pendingActionChannel}`;
    const effectiveCodeContext = resolvedCodeSession
      ? {
          sessionId: resolvedCodeSession.session.id,
          workspaceRoot: resolvedCodeSession.session.resolvedRoot,
        }
      : requestedCodeContext?.workspaceRoot
        ? {
            workspaceRoot: requestedCodeContext.workspaceRoot,
            ...(requestedCodeContext.sessionId ? { sessionId: requestedCodeContext.sessionId } : {}),
          }
        : undefined;
    if (resolvedCodeSession) {
      this.codeSessionStore?.touchSession(
        resolvedCodeSession.session.id,
        resolvedCodeSession.session.ownerUserId,
        'active',
      );
    }
    const scopedMessage: UserMessage = (conversationUserId !== effectiveMessage.userId
      || conversationChannel !== effectiveMessage.channel
      || effectiveCodeContext)
      ? {
          ...effectiveMessage,
          userId: conversationUserId,
          channel: conversationChannel,
          metadata: {
            ...(effectiveMessage.metadata ?? {}),
            ...(effectiveCodeContext ? { codeContext: effectiveCodeContext } : {}),
          },
        }
      : effectiveMessage;
    const pendingAction = this.getActivePendingAction(pendingActionUserId, pendingActionChannel, pendingActionSurfaceId);
    const existingContinuityThread = this.getContinuityThread(pendingActionUserId);
    const surfaceHadContinuityBeforeTurn = hasContinuityThreadSurfaceLink({
      record: existingContinuityThread,
      channel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
    });
    let continuityThread = this.touchContinuityThread(
      pendingActionUserId,
      pendingActionChannel,
      pendingActionSurfaceId,
      effectiveCodeContext?.sessionId,
    );
    this.registerExecutionTurn({
      executionIdentity,
      requestId: message.id,
      userId: pendingActionUserId,
      channel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
      continuityThread,
      content: stripLeadingContextPrefix(effectiveMessage.content),
      codeSessionId: effectiveCodeContext?.sessionId,
    });
    const shouldUseContinuityForGateway = (gateway?: IntentGatewayRecord | null): boolean => (
      shouldUseContinuityThreadForTurn({
        record: continuityThread,
        surfaceHadContinuityBeforeTurn,
        hasPendingAction: !!pendingAction,
        hasResolvedCodeSession: !!scopedCodeSession?.session || (useCodeSessionConversation && !!effectiveCodeContext?.sessionId),
        turnRelation: gateway?.decision.turnRelation,
      })
    );
    let continuityThreadForContext: ContinuityThreadRecord | null = shouldUseContinuityForGateway()
      ? continuityThread
      : null;
    const buildPriorHistory = (thread: ContinuityThreadRecord | null): Array<{ role: 'user' | 'assistant'; content: string }> => {
      if (continuityThread && !thread) {
        return [];
      }
      const continuitySummaryForHistory = summarizeContinuityThreadForGateway(thread);
      return buildContinuityAwareHistory({
        conversationService: this.conversationService,
        codeSessionStore: this.codeSessionStore,
        continuityThread: thread,
        currentConversationKey: conversationKey,
        currentUserId: pendingActionUserId,
        currentPrincipalId: effectiveMessage.principalId,
        resolvedCodeSession: scopedCodeSession?.session ?? null,
        query: buildIntentGatewayHistoryQuery({
          content: stripLeadingContextPrefix(scopedMessage.content),
          continuity: continuitySummaryForHistory,
        }),
      }).history;
    };
    let priorHistory = buildPriorHistory(continuityThreadForContext);
    const refreshContinuityContextForGateway = (gateway?: IntentGatewayRecord | null): void => {
      const nextContinuityThreadForContext = shouldUseContinuityForGateway(gateway)
        ? continuityThread
        : null;
      if (nextContinuityThreadForContext === continuityThreadForContext) {
        return;
      }
      continuityThreadForContext = nextContinuityThreadForContext;
      priorHistory = buildPriorHistory(continuityThreadForContext);
    };
    const buildScopedDirectIntentResponse = (input: Omit<DirectIntentResponseInput, 'surfaceUserId' | 'surfaceChannel' | 'surfaceId'>) => this.buildDirectIntentResponse({
      ...input,
      surfaceUserId: pendingActionUserId,
      surfaceChannel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
    });
    const buildScopedDegradedDirectIntentResponse = (
      input: Omit<DegradedDirectIntentResponseInput, 'surfaceUserId' | 'surfaceChannel' | 'surfaceId'>,
    ) => this.buildDegradedDirectIntentResponse({
      ...input,
      surfaceUserId: pendingActionUserId,
      surfaceChannel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
    });
    const groundedScopedMessage = scopedMessage;
    const referencedCodeSessions = this.resolveReferencedCodeSessionsForSurface(
      message,
      scopedCodeSession?.session,
    );
    const buildReferencedCodeSessionsSectionForPrompt = (
      runtimeSkills: readonly ResolvedSkill[],
      gateway?: IntentGatewayRecord | null,
    ): PromptAssemblyAdditionalSection | undefined => {
      const decision = gateway?.decision;
      const codeGroundedTurn = decision?.route === 'coding_task'
        || decision?.route === 'filesystem_task'
        || decision?.route === 'coding_session_control'
        || decision?.requiresRepoGrounding === true
        || runtimeSkills.some((skill) => skill.id === 'coding-workspace');
      if (!scopedCodeSession?.session && !codeGroundedTurn) {
        return undefined;
      }
      return this.buildReferencedCodeSessionsSection(
        scopedCodeSession?.session,
        referencedCodeSessions,
      );
    };
    let preResolvedSkills: ResolvedSkill[] = [];
    const resolveSkillsForCurrentContext = (options?: {
      gateway?: IntentGatewayRecord | null;
      pendingAction?: PendingActionRecord | null;
      continuityThread?: ContinuityThreadRecord | null;
      priorActiveSkills?: readonly ResolvedSkill[];
    }): ResolvedSkill[] => this.skillResolver?.resolve({
      agentId: this.id,
      channel: message.channel,
      requestType: 'chat',
      content: stripLeadingContextPrefix(groundedScopedMessage.content),
      codeSessionAttached: !!resolvedCodeSession,
      hasTaggedFileContext: (requestedCodeContext?.fileReferences?.length ?? 0) > 0,
      enabledManagedProviders: this.enabledManagedProviders,
      availableCapabilities: new Set(ctx.capabilities),
      intentRoute: options?.gateway?.decision.route,
      intentTurnRelation: options?.gateway?.decision.turnRelation,
      intentResolution: options?.gateway?.decision.resolution,
      intentEntities: {
        ...(options?.gateway?.decision.entities.emailProvider
          ? { emailProvider: options.gateway.decision.entities.emailProvider }
          : {}),
        ...(options?.gateway?.decision.entities.calendarTarget
          ? { calendarTarget: options.gateway.decision.entities.calendarTarget }
          : {}),
        ...(options?.gateway?.decision.entities.codingBackend
          ? { codingBackend: options.gateway.decision.entities.codingBackend }
          : {}),
        ...(options?.gateway?.decision.entities.toolName
          ? { toolName: options.gateway.decision.entities.toolName }
          : {}),
        ...(options?.gateway?.decision.entities.profileId
          ? { profileId: options.gateway.decision.entities.profileId }
          : {}),
        ...(options?.gateway?.decision.entities.uiSurface
          ? { uiSurface: options.gateway.decision.entities.uiSurface }
          : {}),
        ...(options?.gateway?.decision.entities.searchSourceId
          ? { searchSourceId: options.gateway.decision.entities.searchSourceId }
          : {}),
        ...(options?.gateway?.decision.entities.searchSourceType
          ? { searchSourceType: options.gateway.decision.entities.searchSourceType }
          : {}),
      },
      pendingActionKind: options?.pendingAction?.blocker.kind,
      continuityFocusSummary: options?.continuityThread?.focusSummary,
      continuityLastActionableRequest: options?.continuityThread?.lastActionableRequest,
      priorActiveSkillIds: options?.priorActiveSkills?.map((skill) => skill.id) ?? [],
    }) ?? [];
    const trackResolvedSkillsIfChanged = (nextSkills: readonly ResolvedSkill[]): void => {
      const currentIds = preResolvedSkills.map((skill) => skill.id);
      const nextIds = nextSkills.map((skill) => skill.id);
      if (currentIds.length === nextIds.length && currentIds.every((id, index) => id === nextIds[index])) {
        preResolvedSkills = [...nextSkills];
        return;
      }
      preResolvedSkills = [...nextSkills];
      this.trackResolvedSkills(message, 'chat', preResolvedSkills, 'resolved');
    };
    trackResolvedSkillsIfChanged(resolveSkillsForCurrentContext());
    this.syncPendingApprovalsFromExecutor(
      conversationUserId,
      conversationChannel,
      pendingActionUserId,
      pendingActionChannel,
      pendingActionSurfaceId,
    );

    // Approval continuation is a control-plane path and must not go back through
    // normal intent classification or worker dispatch.
    const approvalResult = await this.tryHandleApproval(message, ctx, workerManager);
    if (approvalResult) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          conversationKey,
          message.content,
          approvalResult.content,
        );
      }
      if (resolvedCodeSession) {
        this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
      }
      return {
        content: approvalResult.content,
        metadata: {
          ...(preResolvedSkills.length > 0
            ? { activeSkills: preResolvedSkills.map((skill) => skill.id) }
            : {}),
          ...(approvalResult.metadata ?? {}),
        },
      };
    }

    const directPendingApprovalStatusBeforeGateway = this.tryDirectPendingApprovalStatusResponse(message, { exactOnly: true });
    if (directPendingApprovalStatusBeforeGateway) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          conversationKey,
          message.content,
          directPendingApprovalStatusBeforeGateway.content,
        );
      }
      if (resolvedCodeSession) {
        this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
      }
      return {
        content: directPendingApprovalStatusBeforeGateway.content,
        metadata: {
          ...(preResolvedSkills.length > 0
            ? { activeSkills: preResolvedSkills.map((skill) => skill.id) }
            : {}),
          ...(directPendingApprovalStatusBeforeGateway.metadata ?? {}),
        },
      };
    }

    // Classify intent early — session control is a control-plane operation that must
    // be handled before the worker path (which would scope the userId to the code-session
    // and return incomplete results). The gateway result is reused later to avoid a
    // redundant LLM call in the non-worker direct-intent routing path.
    const preRoutedGateway = readPreRoutedIntentGatewayMetadata(groundedScopedMessage.metadata);
    let earlyGateway: import('./runtime/intent-gateway.js').IntentGatewayRecord | null = shouldReusePreRoutedIntentGateway(preRoutedGateway)
      ? enrichIntentGatewayRecordWithContentPlan(
          preRoutedGateway,
          stripLeadingContextPrefix(groundedScopedMessage.content),
        ) ?? preRoutedGateway
      : null;
    refreshContinuityContextForGateway(earlyGateway);
    let activeExecution = this.getActiveExecution({
      userId: pendingActionUserId,
      channel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
      continuityThread: continuityThreadForContext,
      pendingAction,
      excludeExecutionId: executionIdentity.executionId,
    });
    const buildCodingRoutes = (): ChatDirectCodingRouteDeps => buildChatDirectCodingRouteDeps({
      agentId: this.id,
      tools: this.tools,
      codeSessionStore: this.codeSessionStore,
      parsePendingActionUserKey: (key) => this.parsePendingActionUserKey(key),
      recordIntentRoutingTrace: (stage, traceInput) => this.recordIntentRoutingTrace(stage, traceInput),
      getPendingApprovalIds: (userId, channel, surfaceId) => this.getPendingApprovalIds(userId, channel, surfaceId),
      setPendingApprovals: (key, ids, surfaceId, nowMs) => this.setPendingApprovals(key, ids, surfaceId, nowMs),
      syncPendingApprovalsFromExecutor: (
        sourceUserId,
        sourceChannel,
        targetUserId,
        targetChannel,
        surfaceId,
        originalUserContent,
      ) => this.syncPendingApprovalsFromExecutor(
        sourceUserId,
        sourceChannel,
        targetUserId,
        targetChannel,
        surfaceId,
        originalUserContent,
      ),
      setPendingApprovalAction: (userId, channel, surfaceId, actionInput) => this.setPendingApprovalAction(
        userId,
        channel,
        surfaceId,
        actionInput,
      ),
      getActivePendingAction: (userId, channel, surfaceId) => this.getActivePendingAction(userId, channel, surfaceId),
      completePendingAction: (actionId) => this.completePendingAction(actionId),
      onMessage: (nextMessage, nextCtx) => this.onMessage(nextMessage, nextCtx),
    });
    const workspaceSwitchContinuation = await tryHandleWorkspaceSwitchContinuationHelper({
      message,
      ctx,
      pendingAction,
      handleCodeSessionAttach: (nextMessage, nextCtx, targetSessionId) => this.handleCodeSessionAttach(
        nextMessage,
        nextCtx,
        targetSessionId,
      ),
    });
    if (workspaceSwitchContinuation) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          conversationKey,
          message.content,
          workspaceSwitchContinuation.content,
        );
      }
      if (resolvedCodeSession) {
        this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
      }
      return workspaceSwitchContinuation;
    }
    const resolvedPendingActionContinuation = this.resolvePendingActionContinuationContent(
      groundedScopedMessage.content,
      pendingAction,
      effectiveCodeContext?.sessionId,
    );
    const resolvedRetryAfterFailureContinuation = resolvedPendingActionContinuation
      ? null
      : this.resolveRetryAfterFailureContinuationContent(
          groundedScopedMessage.content,
          continuityThreadForContext,
          activeExecution,
        );
    let routedScopedMessage = resolvedPendingActionContinuation
      ? {
          ...groundedScopedMessage,
          content: resolvedPendingActionContinuation,
        }
      : resolvedRetryAfterFailureContinuation
        ? {
            ...groundedScopedMessage,
            content: resolvedRetryAfterFailureContinuation,
          }
        : groundedScopedMessage;
    const shouldReuseRoutedPreRoutedGateway = shouldReusePreRoutedIntentGatewayForContent(
      preRoutedGateway,
      groundedScopedMessage.content,
      routedScopedMessage.content,
    );
    if (!shouldReuseRoutedPreRoutedGateway) {
      routedScopedMessage = {
        ...routedScopedMessage,
        metadata: detachPreRoutedIntentGatewayMetadata(routedScopedMessage.metadata),
      };
      earlyGateway = null;
    }
    if (ctx.llm || earlyGateway) {
      earlyGateway = earlyGateway ?? await this.classifyIntentGateway(routedScopedMessage, ctx, {
        recentHistory: priorHistory,
        pendingAction,
        continuityThread: continuityThreadForContext,
      });
      refreshContinuityContextForGateway(earlyGateway);
      trackResolvedSkillsIfChanged(resolveSkillsForCurrentContext({
        gateway: earlyGateway,
        pendingAction,
        continuityThread: continuityThreadForContext,
        priorActiveSkills: preResolvedSkills,
      }));
      activeExecution = this.updateExecutionFromIntent({
        executionIdentity,
        userId: pendingActionUserId,
        channel: pendingActionChannel,
        surfaceId: pendingActionSurfaceId,
        continuityThread,
        gateway: earlyGateway,
        routingContent: routedScopedMessage.content,
        codeSessionId: effectiveCodeContext?.sessionId,
      }) ?? activeExecution;
      continuityThread = this.updateContinuityThreadFromIntent({
        executionIdentity,
        userId: pendingActionUserId,
        channel: pendingActionChannel,
        surfaceId: pendingActionSurfaceId,
        continuityThread,
        gateway: earlyGateway,
        routingContent: routedScopedMessage.content,
        codeSessionId: effectiveCodeContext?.sessionId,
      });
      refreshContinuityContextForGateway(earlyGateway);
      const pendingActionSwitchDecision = await tryHandlePendingActionSwitchDecisionHelper({
        message,
        pendingAction,
        gateway: earlyGateway,
        activeSkills: preResolvedSkills,
        surfaceUserId: pendingActionUserId,
        surfaceChannel: pendingActionChannel,
        surfaceId: pendingActionSurfaceId,
        readPendingActionSwitchCandidatePayload: (nextPendingAction) => this.readPendingActionSwitchCandidatePayload(nextPendingAction),
        replacePendingAction: (userId, channel, surfaceId, replacement) => this.replacePendingAction(
          userId,
          channel,
          surfaceId,
          replacement,
        ),
        updatePendingAction: (actionId, patch) => this.updatePendingAction(actionId, patch),
        buildImmediateResponseMetadata: (activeSkills, userId, channel, surfaceId, options) => this.buildImmediateResponseMetadata(
          activeSkills,
          userId,
          channel,
          surfaceId,
          options,
        ),
      });
      if (pendingActionSwitchDecision) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            pendingActionSwitchDecision.content,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return pendingActionSwitchDecision;
      }
      const clarificationResponse = buildGatewayClarificationResponseHelper({
        gateway: earlyGateway,
        surfaceUserId: pendingActionUserId,
        surfaceChannel: pendingActionChannel,
        message,
        activeSkills: preResolvedSkills,
        surfaceId: pendingActionSurfaceId,
        pendingAction,
      }, {
        enabledManagedProviders: this.enabledManagedProviders,
        buildImmediateResponseMetadata: (activeSkills, userId, channel, surfaceId, options) => this.buildImmediateResponseMetadata(
          activeSkills,
          userId,
          channel,
          surfaceId,
          options,
        ),
        setClarificationPendingAction: (userId, channel, surfaceId, action) => this.setClarificationPendingAction(
          userId,
          channel,
          surfaceId,
          action,
        ),
        recordIntentRoutingTrace: (stage, traceInput) => this.recordIntentRoutingTrace(stage, {
          ...traceInput,
          continuityThread: continuityThreadForContext,
        }),
        toPendingActionEntities,
      });
      if (clarificationResponse) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            clarificationResponse.content,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return clarificationResponse;
      }
      const unsupportedManagedProviderResponse = this.tryDirectUnsupportedManagedProviderPlanResponse(earlyGateway?.decision);
      if (unsupportedManagedProviderResponse) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            unsupportedManagedProviderResponse,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, []);
        }
        return {
          content: unsupportedManagedProviderResponse,
          metadata: {
            ...(toIntentGatewayClientMetadata(earlyGateway)
              ? { intentGateway: toIntentGatewayClientMetadata(earlyGateway) }
              : {}),
          },
        };
      }
      const explicitWorkspaceTarget = await buildCodingRoutes().backendDeps.ensureExplicitCodingTaskWorkspaceTarget({
        message,
        ctx,
        decision: earlyGateway?.decision,
        currentSession: resolvedCodeSession?.session ?? null,
        codeContext: effectiveCodeContext,
      });
      if (explicitWorkspaceTarget.status === 'blocked') {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            explicitWorkspaceTarget.response.content,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return explicitWorkspaceTarget.response;
      }
      if (explicitWorkspaceTarget.status === 'switched') {
        const switchedMessage: UserMessage = {
          ...message,
          id: randomUUID(),
          metadata: attachPreRoutedIntentGatewayMetadata(
            {
              ...(message.metadata ?? {}),
              codeContext: explicitWorkspaceTarget.codeContext,
            },
            earlyGateway,
          ),
        };
        const resumed = await this.onMessage(switchedMessage, ctx, workerManager);
        return {
          content: `${explicitWorkspaceTarget.switchResponse.content}\n\n${resumed.content}`,
          metadata: {
            ...(explicitWorkspaceTarget.switchResponse.metadata ?? {}),
            ...(resumed.metadata ?? {}),
          },
        };
      }
      const resolvedGatewayContent = resolveIntentGatewayContentHelper({
        gateway: earlyGateway,
        currentContent: groundedScopedMessage.content,
        pendingAction,
        priorHistory,
        continuityThread: continuityThreadForContext,
        activeExecution,
      });
      const resolvedPendingSearchSurface = Boolean(
        pendingAction?.blocker.kind === 'clarification'
          && pendingAction.blocker.field === 'search_surface'
          && resolvedGatewayContent
          && resolvedGatewayContent !== groundedScopedMessage.content,
      );
      if (resolvedGatewayContent && resolvedGatewayContent !== groundedScopedMessage.content) {
        routedScopedMessage = {
          ...groundedScopedMessage,
          content: resolvedGatewayContent,
        };
      }
      activeExecution = this.updateExecutionFromIntent({
        executionIdentity,
        userId: pendingActionUserId,
        channel: pendingActionChannel,
        surfaceId: pendingActionSurfaceId,
        continuityThread,
        gateway: earlyGateway,
        routingContent: routedScopedMessage.content,
        codeSessionId: effectiveCodeContext?.sessionId,
      }) ?? activeExecution;
      continuityThread = this.updateContinuityThreadFromIntent({
        executionIdentity,
        userId: pendingActionUserId,
        channel: pendingActionChannel,
        surfaceId: pendingActionSurfaceId,
        continuityThread,
        gateway: earlyGateway,
        routingContent: routedScopedMessage.content,
        codeSessionId: effectiveCodeContext?.sessionId,
      });
      refreshContinuityContextForGateway(earlyGateway);
      if (pendingAction && (
        resolvedPendingSearchSurface
        || shouldClearPendingActionAfterTurnHelper(earlyGateway?.decision, pendingAction)
      )) {
        this.completePendingAction(pendingAction.id);
      }

      const allowGeneralShortcut = earlyGateway?.decision.route === 'general_assistant'
        || earlyGateway?.decision.route === 'complex_planning_task'
        || earlyGateway?.decision.route === 'unknown';
      const directPendingApprovalStatus = allowGeneralShortcut
        ? this.tryDirectPendingApprovalStatusResponse(message)
        : null;
      if (directPendingApprovalStatus) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            directPendingApprovalStatus.content,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return {
          content: directPendingApprovalStatus.content,
          metadata: {
            ...(preResolvedSkills.length > 0
              ? { activeSkills: preResolvedSkills.map((skill) => skill.id) }
              : {}),
            ...(directPendingApprovalStatus.metadata ?? {}),
          },
        };
      }

      const directSkillInventory = allowGeneralShortcut
        ? this.tryDirectSkillInventoryResponse(routedScopedMessage.content)
        : null;
      if (directSkillInventory) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            directSkillInventory,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return {
          content: directSkillInventory,
          metadata: preResolvedSkills.length > 0
            ? { activeSkills: preResolvedSkills.map((skill) => skill.id) }
            : undefined,
        };
      }

      const directToolReport = allowGeneralShortcut
        ? this.tryDirectRecentToolReport(routedScopedMessage, resolvedCodeSession)
        : null;
      if (directToolReport) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            directToolReport,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return { content: directToolReport };
      }

      if (earlyGateway?.decision.route === 'coding_session_control') {
        const sessionControlResult = await tryDirectChatCodeSessionControl({
          tools: this.tools,
          message,
          ctx,
          decision: earlyGateway.decision,
          codingRoutes: buildCodingRoutes(),
        });
        if (sessionControlResult) {
          return buildScopedDirectIntentResponse({
            candidate: 'coding_session_control',
            result: sessionControlResult,
            message,
            routingMessage: routedScopedMessage,
            intentGateway: earlyGateway,
            ctx,
            activeSkills: preResolvedSkills,
            conversationKey,
          });
        }
      }
    }

    const requestIntentContent = routedScopedMessage.content;
    const allowModelMemoryMutation = shouldAllowModelMemoryMutation(requestIntentContent);
    const existingPendingIds = this.getPendingApprovalIds(
      pendingActionUserId,
      pendingActionChannel,
      pendingActionSurfaceId,
    );
    const pendingApprovalNotice = existingPendingIds.length > 0
      ? `Note: ${existingPendingIds.length} earlier tool action(s) are still awaiting user approval in a separate UI flow. Treat them as background state only. Unless the user explicitly asks about approvals or this turn is resuming one of those actions, do NOT mention, summarize, or list them, and do not let them change your answer to the current request.`
      : undefined;
    const knowledgeBaseQuery = this.buildKnowledgeBaseContextQuery({
      messageContent: routedScopedMessage.content,
      continuityThread: continuityThreadForContext,
      pendingAction,
      resolvedCodeSession: scopedCodeSession,
    });
    let contextAssemblyMeta: PromptAssemblyDiagnostics | undefined;
    let latestContextCompaction: ContextCompactionResult | undefined;
    const applyContextCompactionMetadata = (
      diagnostics: PromptAssemblyDiagnostics | undefined,
      compaction: ContextCompactionResult | undefined,
    ): PromptAssemblyDiagnostics | undefined => {
      if (!diagnostics || !compaction?.applied) return diagnostics;
      return {
        ...diagnostics,
        contextCompactionApplied: true,
        contextCharsBeforeCompaction: compaction.beforeChars,
        contextCharsAfterCompaction: compaction.afterChars,
        ...(compaction.stages.length > 0 ? { contextCompactionStages: [...compaction.stages] } : {}),
        ...(compaction.summary ? { compactedSummaryPreview: compaction.summary.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
      };
    };
    type PromptKnowledgeBundle = {
      knowledgeBases: PromptAssemblyKnowledgeBase[];
      globalContent: string;
      globalSelection?: MemoryContextLoadResult;
      codingMemoryContent: string;
      codingMemorySelection?: MemoryContextLoadResult;
      queryPreview?: string;
    };
    type PromptSkillMaterialBundle = SkillPromptMaterialResult | undefined;
    const maintainedSummarySource = scopedCodeSession?.session.workState.compactedSummary?.trim()
      ? 'code_session_compacted_summary'
      : scopedCodeSession?.session.workState.planSummary?.trim()
        ? 'code_session_plan_summary'
        : scopedCodeSession?.session.workState.focusSummary?.trim()
          ? 'code_session_focus_summary'
          : undefined;
    const buildSectionFootprints = (
      baseSystemPrompt: string,
      promptKnowledge: PromptKnowledgeBundle | undefined,
      runtimeSkills: ResolvedSkill[],
      toolContext: string,
      runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>,
      additionalSections?: PromptAssemblyAdditionalSection[],
      executionProfile?: SelectedExecutionProfile | null,
    ) => buildPromptAssemblySectionFootprints({
      baseSystemPrompt,
      knowledgeBases: promptKnowledge?.knowledgeBases ?? [],
      activeSkills: runtimeSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        summary: skill.summary,
        description: skill.description,
        role: skill.role,
        sourcePath: skill.sourcePath,
      })),
      toolContext,
      runtimeNotices,
      pendingAction: this.buildPendingActionPromptContext(pendingAction),
      pendingApprovalNotice,
      continuity: summarizeContinuityThreadForGateway(continuityThreadForContext),
      ...(executionProfile ? { executionProfile } : {}),
      additionalSections,
    });
    const buildContextDiagnostics = (input: {
      promptKnowledge: PromptKnowledgeBundle | undefined;
      runtimeSkills: ResolvedSkill[];
      skillPromptMaterial: PromptSkillMaterialBundle;
      toolContext: string;
      runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
      baseSystemPrompt: string;
      codeSessionId?: string;
      additionalSections?: PromptAssemblyAdditionalSection[];
      compaction?: ContextCompactionResult;
      executionProfile?: SelectedExecutionProfile | null;
    }): PromptAssemblyDiagnostics => this.buildContextAssemblyMetadata({
      memoryScope: 'global',
      knowledgeBase: input.promptKnowledge?.globalContent ?? '',
      codingMemory: input.promptKnowledge?.codingMemoryContent,
      globalMemorySelection: input.promptKnowledge?.globalSelection,
      codingMemorySelection: input.promptKnowledge?.codingMemorySelection,
      knowledgeBaseQuery: input.promptKnowledge?.queryPreview,
      activeSkillCount: input.runtimeSkills.length,
      ...(input.skillPromptMaterial ? { skillPromptSelection: input.skillPromptMaterial.metadata } : {}),
      pendingAction,
      continuityThread: continuityThreadForContext,
      codeSessionId: input.codeSessionId,
      executionProfile: input.executionProfile ?? undefined,
      sectionFootprints: buildSectionFootprints(
        input.baseSystemPrompt,
        input.promptKnowledge,
        input.runtimeSkills,
        input.toolContext,
        input.runtimeNotices,
        input.additionalSections,
        input.executionProfile,
      ),
      preservedExecutionState: buildPreservedExecutionState(),
      ...(input.compaction?.applied
        ? { contextCompaction: buildCompactionContext(input.compaction) }
        : {}),
    });
    const buildPreservedExecutionState = () => buildPromptAssemblyPreservedExecutionState({
      pendingAction: this.buildPendingActionPromptContext(pendingAction),
      continuity: summarizeContinuityThreadForGateway(continuityThreadForContext),
      maintainedSummarySource,
    });
    const buildCompactionContext = (compaction?: ContextCompactionResult) => (
      compaction?.applied ? buildContextCompactionDiagnostics(compaction) : undefined
    );
    let llmMessages: import('./llm/types.js').ChatMessage[];
    let skipDirectTools = false;
    let enrichedSystemPrompt = this.buildScopedSystemPrompt(scopedCodeSession, message);
    let activeSkills: ResolvedSkill[] = [];
    let skillPromptMaterial: SkillPromptMaterialResult | undefined;

    activeSkills = preResolvedSkills;
    const useMinimalDirectAssistantContext = this.shouldUseMinimalDirectAssistantContext({
      gateway: earlyGateway,
      selectedExecutionProfile,
      currentProviderName: ctx.llm?.name,
      messageContent: routedScopedMessage.content,
      activeSkillCount: activeSkills.length,
    });
    const promptKnowledge = useMinimalDirectAssistantContext
      ? {
          knowledgeBases: [],
          globalContent: '',
          codingMemoryContent: '',
        }
      : this.loadPromptKnowledgeBases(scopedCodeSession, knowledgeBaseQuery);
    if (activeSkills.length > 0) {
      this.trackResolvedSkills(message, 'chat', activeSkills, 'prompt_injected');
      skillPromptMaterial = buildSkillPromptMaterial(
        this.skillRegistry!,
        {
          skills: activeSkills,
          requestText: routedScopedMessage.content,
          ...(earlyGateway?.decision.route ? { route: earlyGateway.decision.route } : {}),
          artifactReferences: this.resolveSkillArtifactReferences(activeSkills, scopedCodeSession),
        },
        createSkillPromptMaterialCache(),
      );
      this.trackSkillPromptMaterial(message, earlyGateway?.decision.route, skillPromptMaterial);
    }
    const toolContext = useMinimalDirectAssistantContext
      ? ''
      : this.tools?.getToolContext({
          userId: conversationUserId,
          principalId: message.principalId ?? conversationUserId,
          channel: conversationChannel,
          codeContext: effectiveCodeContext,
          requestText: routedScopedMessage.content,
          ...(selectedExecutionProfile ? { toolContextMode: selectedExecutionProfile.toolContextMode } : {}),
        }) ?? '';
    const runtimeNotices = useMinimalDirectAssistantContext
      ? []
      : (this.tools?.getRuntimeNotices() ?? [])
          .slice(0, Math.max(0, selectedExecutionProfile?.maxRuntimeNotices ?? Number.MAX_SAFE_INTEGER));
    const promptAdditionalSections = useMinimalDirectAssistantContext
      ? []
      : this.buildPromptAdditionalSections(
          skillPromptMaterial,
          earlyGateway?.decision,
          selectedExecutionProfile,
          (() => {
            const section = buildReferencedCodeSessionsSectionForPrompt(activeSkills, earlyGateway);
            return section ? [section] : undefined;
          })(),
        );
    const baseSystemPrompt = enrichedSystemPrompt;
    enrichedSystemPrompt = this.buildAssembledSystemPrompt({
      baseSystemPrompt,
      knowledgeBases: promptKnowledge.knowledgeBases,
      activeSkills,
      toolContext,
      runtimeNotices,
      pendingAction,
      pendingApprovalNotice,
      continuityThread: continuityThreadForContext,
      additionalSections: promptAdditionalSections,
      executionProfile: selectedExecutionProfile ?? undefined,
    });
    contextAssemblyMeta = buildContextDiagnostics({
      promptKnowledge,
      runtimeSkills: activeSkills,
      skillPromptMaterial,
      toolContext,
      runtimeNotices,
      baseSystemPrompt,
      codeSessionId: scopedCodeSession?.session.id,
      additionalSections: promptAdditionalSections,
      executionProfile: selectedExecutionProfile,
    });
    llmMessages = buildChatMessagesFromHistory({
      systemPrompt: enrichedSystemPrompt,
      history: priorHistory,
      userContent: routedScopedMessage.content,
    });

    let finalContent = '';
    let pendingActionMeta: Record<string, unknown> | undefined;
    let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
    const defaultToolResultProviderKind = this.resolveToolResultProviderKind(ctx);
    let responseSource: ResponseSourceMetadata | undefined;
    const directIntent = !skipDirectTools
      ? (earlyGateway ?? await this.classifyIntentGateway(routedScopedMessage, ctx, {
        recentHistory: priorHistory,
        pendingAction: this.getActivePendingAction(
          pendingActionUserId,
          pendingActionChannel,
          pendingActionSurfaceId,
        ),
        continuityThread: continuityThreadForContext,
      }))
      : null;
    const directRuntimeDeps: DirectRuntimeDepsInput = {
      agentId: this.id,
      tools: this.tools,
      secondBrainService: this.secondBrainService,
      conversationService: this.conversationService,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      getPendingApprovals: (nextUserKey, surfaceId, nowMs) => this.getPendingApprovals(nextUserKey, surfaceId, nowMs),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      parsePendingActionUserKey: (nextUserKey) => this.parsePendingActionUserKey(nextUserKey),
      setClarificationPendingAction: (userId, channel, surfaceId, action) => this.setClarificationPendingAction(
        userId,
        channel,
        surfaceId,
        action,
      ),
      setPendingApprovalActionForRequest: (nextUserKey, surfaceId, action) => this.setPendingApprovalActionForRequest(
        nextUserKey,
        surfaceId,
        action,
      ),
      setChatContinuationGraphPendingApprovalActionForRequest: (nextUserKey, surfaceId, action) => this.setChatContinuationGraphPendingApprovalActionForRequest(
        nextUserKey,
        surfaceId,
        action,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
      buildImmediateResponseMetadata: (_pendingApprovalIds, userId, channel, surfaceId, options) => this.buildImmediateResponseMetadata(
        [] as ResolvedSkill[],
        userId,
        channel,
        surfaceId,
        options,
      ),
    };
    const continuityThreadForDirectState = continuityThreadForContext
      ?? (continuityThread?.continuationState ? continuityThread : null);
    const directRouteHandlers = buildChatDirectRouteHandlers({
      agentId: this.id,
      tools: this.tools,
      runtimeDeps: directRuntimeDeps,
      message,
      routedMessage: routedScopedMessage,
      ctx,
      userKey: pendingActionUserKey,
      conversationKey,
      conversationService: this.conversationService,
      stateAgentId,
      decision: directIntent?.decision,
      codeContext: effectiveCodeContext,
      continuityThread: continuityThreadForDirectState,
      llmMessages,
      fallbackProviderOrder,
      defaultToolResultProviderKind,
      sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
        toolName,
        result,
        providerKind,
      ),
      chatWithFallback: (nextCtx, messages, options, providerOrder) => this.chatWithFallback(
        nextCtx,
        messages,
        options,
        providerOrder,
      ),
      executeStoredFilesystemSave: (input) => this.executeStoredFilesystemSave(input),
      codingRoutes: buildCodingRoutes(),
    });
    const directIntentResponse = await runDirectRouteOrchestration({
      skipDirectTools,
      gateway: directIntent,
      message,
      activeSkills,
      resolvedCodeSession,
      codeContext: effectiveCodeContext,
      recordIntentRoutingTrace: (stage, traceInput) => this.recordIntentRoutingTrace(stage, {
        ...traceInput,
        continuityThread: continuityThreadForDirectState,
      }),
      handlers: directRouteHandlers,
      onHandled: (candidate, result) => buildScopedDirectIntentResponse({
        candidate,
        result,
        message,
        routingMessage: routedScopedMessage,
        intentGateway: directIntent,
        ctx,
        activeSkills,
        conversationKey,
      }),
      onDegradedMemoryFallback: async () => {
        const degradedMemorySave = await directRouteHandlers.memory_write?.({
          gatewayDirected: false,
          gatewayUnavailable: true,
          skipDirectWebSearch: false,
        });
        if (!degradedMemorySave) {
          return null;
        }
        return buildScopedDegradedDirectIntentResponse({
          candidate: 'memory_write',
          result: degradedMemorySave,
          message,
          intentGateway: directIntent,
          activeSkills,
          conversationKey,
          degradedReason: 'gateway_unavailable_or_unstructured',
        });
      },
    });
    if (directIntentResponse) {
      return directIntentResponse;
    }

    const delegatedOrchestration = inferDelegatedOrchestrationDescriptor(
      earlyGateway?.decision,
    );
    const handleDirectAssistantInline = this.shouldHandleDirectAssistantInline({
      gateway: earlyGateway,
      selectedExecutionProfile,
      currentProviderName: ctx.llm?.name,
    });
    const handleSecurityEventHandoffInline = this.shouldHandleSecurityEventHandoffInline(message);
    const handleDirectReasoning = shouldHandleDirectReasoningModeRuntime({
      gateway: earlyGateway,
      selectedExecutionProfile,
    });

    // Direct reasoning normally runs inside the brokered worker. This supervisor
    // fallback only exists for runtimes that have no WorkerManager configured.
    if (handleDirectReasoning && !handleDirectAssistantInline && !workerManager) {
      try {
        if (!ctx.llm || !this.tools) {
          throw new Error('Direct reasoning requires an LLM provider and tool executor.');
        }
        const promptKnowledge = this.loadPromptKnowledgeBases(scopedCodeSession, knowledgeBaseQuery);
        const directToolContext = this.tools.getToolContext({
          userId: conversationUserId,
          principalId: message.principalId ?? conversationUserId,
          channel: conversationChannel,
          codeContext: effectiveCodeContext,
          requestText: routedScopedMessage.content,
          ...(selectedExecutionProfile ? { toolContextMode: selectedExecutionProfile.toolContextMode } : {}),
        });
        const directRuntimeNotices = this.tools.getRuntimeNotices()
          .slice(0, Math.max(0, selectedExecutionProfile?.maxRuntimeNotices ?? Number.MAX_SAFE_INTEGER));
        const directReasoningResult = await handleDirectReasoningModeRuntime({
          message: message.content,
          history: priorHistory,
          gateway: earlyGateway,
          selectedExecutionProfile,
          promptKnowledge: {
            ...promptKnowledge,
            toolContext: directToolContext,
            runtimeNotices: directRuntimeNotices,
          },
          workspaceRoot: effectiveCodeContext?.workspaceRoot ?? resolvedCodeSession?.session.workspaceRoot,
          traceContext: {
            requestId: message.id,
            messageId: message.id,
            userId: conversationUserId,
            channel: conversationChannel,
            agentId: this.id,
            contentPreview: message.content,
            executionId: executionIdentity.executionId,
            rootExecutionId: executionIdentity.rootExecutionId,
            codeSessionId: effectiveCodeContext?.sessionId,
          },
          toolRequest: {
            origin: 'assistant',
            requestId: message.id,
            agentId: this.id,
            userId: conversationUserId,
            surfaceId: message.surfaceId,
            principalId: message.principalId ?? conversationUserId,
            principalRole: message.principalRole ?? 'owner',
            channel: conversationChannel,
            agentContext: { checkAction: ctx.checkAction },
            codeContext: effectiveCodeContext,
            toolContextMode: selectedExecutionProfile?.toolContextMode,
            activeSkills: activeSkills.map((skill) => skill.id),
            requestText: stripLeadingContextPrefix(routedScopedMessage.content),
          },
        }, {
          chat: (messagesForProvider, options) => ctx.llm!.chat(messagesForProvider, options),
          executeTool: (toolName, args, request) => this.tools!.executeModelTool(toolName, args, {
            ...request,
            origin: request.origin ?? 'assistant',
          }),
          trace: this.intentRoutingTrace,
          logger: log,
        });
        return directReasoningResult;
      } catch (directReasoningError) {
        const errorMessage = directReasoningError instanceof Error
          ? directReasoningError.message
          : String(directReasoningError);
        log.error(`Direct reasoning mode failed: ${errorMessage}`);
        this.intentRoutingTrace?.record({
          stage: 'direct_reasoning_failed',
          requestId: message.id,
          messageId: message.id,
          userId: conversationUserId,
          channel: conversationChannel,
          agentId: this.id,
          contentPreview: message.content,
          details: {
            executionId: executionIdentity.executionId,
            rootExecutionId: executionIdentity.rootExecutionId,
            codeSessionId: effectiveCodeContext?.sessionId,
            error: errorMessage,
          },
        });
        return {
          content: 'Direct reasoning failed before it could produce a grounded answer.',
          metadata: {
            executionProfile: selectedExecutionProfile ?? undefined,
            directReasoning: true,
            directReasoningMode: 'supervisor_readonly_fallback',
            directReasoningFailed: true,
          },
        };
      }
    }

    if (workerManager && delegatedOrchestration && !handleDirectAssistantInline && !handleSecurityEventHandoffInline) {
      try {
        const promptKnowledge = this.loadPromptKnowledgeBases(scopedCodeSession, knowledgeBaseQuery);
        const workerSystemPrompt = this.buildScopedSystemPrompt(scopedCodeSession, message);
        const workerSkillPromptMaterial = skillPromptMaterial
          ?? (
            preResolvedSkills.length > 0 && this.skillRegistry
              ? buildSkillPromptMaterial(
                this.skillRegistry,
                {
                  skills: preResolvedSkills,
                  requestText: routedScopedMessage.content,
                  ...(earlyGateway?.decision.route ? { route: earlyGateway.decision.route } : {}),
                  artifactReferences: this.resolveSkillArtifactReferences(preResolvedSkills, scopedCodeSession),
                },
                createSkillPromptMaterialCache(),
              )
              : undefined
          );
        if (!skillPromptMaterial && workerSkillPromptMaterial) {
          this.trackSkillPromptMaterial(message, earlyGateway?.decision.route, workerSkillPromptMaterial);
        }
        const currentConfig = this.readConfig?.();
        const workerExecutionProfile = handleDirectReasoning
          ? selectedExecutionProfile
          : currentConfig
          ? (
            selectDelegatedExecutionProfile({
              config: currentConfig,
              parentProfile: selectedExecutionProfile,
              gatewayDecision: earlyGateway?.decision,
              orchestration: delegatedOrchestration,
              mode: selectedExecutionProfile?.routingMode,
            })
              ?? selectedExecutionProfile
          )
          : selectedExecutionProfile;
        const workerToolContext = this.tools?.getToolContext({
          userId: conversationUserId,
          principalId: message.principalId ?? conversationUserId,
          channel: conversationChannel,
          codeContext: effectiveCodeContext,
          requestText: routedScopedMessage.content,
          ...(workerExecutionProfile ? { toolContextMode: workerExecutionProfile.toolContextMode } : {}),
        }) ?? '';
        const workerRuntimeNotices = (this.tools?.getRuntimeNotices() ?? [])
          .slice(0, Math.max(0, workerExecutionProfile?.maxRuntimeNotices ?? Number.MAX_SAFE_INTEGER));
        const workerAdditionalSections = this.buildPromptAdditionalSections(
          workerSkillPromptMaterial,
          earlyGateway?.decision,
          workerExecutionProfile,
          (() => {
            const section = buildReferencedCodeSessionsSectionForPrompt(preResolvedSkills, earlyGateway);
            return section ? [section] : undefined;
          })(),
        );
        const workerContextAssemblyMeta = buildContextDiagnostics({
          promptKnowledge,
          runtimeSkills: preResolvedSkills,
          skillPromptMaterial: workerSkillPromptMaterial,
          toolContext: workerToolContext,
          runtimeNotices: workerRuntimeNotices,
          baseSystemPrompt: workerSystemPrompt,
          codeSessionId: scopedCodeSession?.session.id,
          additionalSections: workerAdditionalSections,
          compaction: latestContextCompaction,
          executionProfile: workerExecutionProfile,
        });
        const continuitySummary = summarizeContinuityThreadForGateway(continuityThreadForContext);
        // Attach codeContext to the message metadata so the worker can forward it
        // through the broker to the tool executor for auto-approve decisions.
        const workerMetadata = attachPreRoutedIntentGatewayMetadata(
          attachSelectedExecutionProfileMetadata(
            effectiveCodeContext
              ? { ...routedScopedMessage.metadata, codeContext: effectiveCodeContext }
              : routedScopedMessage.metadata,
            workerExecutionProfile,
          ),
          shouldReusePreRoutedIntentGateway(earlyGateway) ? earlyGateway : null,
        );
        const workerMessage = workerMetadata
          ? { ...routedScopedMessage, metadata: workerMetadata }
          : routedScopedMessage;
        const delegatedExecutionIdentity = readExecutionIdentityMetadata(message.metadata);
        const workerCapabilities = constrainCapabilitiesToOrchestrationRole(
          [...ctx.capabilities],
          delegatedOrchestration,
        );
        const result = await workerManager.handleMessage({
          sessionId: `${conversationUserId}:${conversationChannel}`,
          agentId: this.id,
          userId: conversationUserId,
          grantedCapabilities: [...workerCapabilities],
          message: workerMessage,
          systemPrompt: workerSystemPrompt,
          history: priorHistory,
          knowledgeBases: promptKnowledge.knowledgeBases,
          activeSkills: preResolvedSkills,
          additionalSections: workerAdditionalSections,
          toolContext: workerToolContext,
          runtimeNotices: workerRuntimeNotices,
          executionProfile: workerExecutionProfile ?? undefined,
          continuity: continuitySummary,
          pendingAction: this.buildPendingActionPromptContext(pendingAction),
          pendingApprovalNotice,
          directReasoning: handleDirectReasoning,
          delegation: {
            requestId: message.id,
            ...(delegatedExecutionIdentity?.executionId ? { executionId: delegatedExecutionIdentity.executionId } : {}),
            ...(delegatedExecutionIdentity?.rootExecutionId ? { rootExecutionId: delegatedExecutionIdentity.rootExecutionId } : {}),
            originChannel: message.channel,
            ...(message.surfaceId ? { originSurfaceId: message.surfaceId } : {}),
            ...(continuitySummary?.continuityKey ? { continuityKey: continuitySummary.continuityKey } : {}),
            ...(continuitySummary?.activeExecutionRefs?.length ? { activeExecutionRefs: continuitySummary.activeExecutionRefs } : {}),
            ...(pendingAction?.id ? { pendingActionId: pendingAction.id } : {}),
            ...(resolvedCodeSession?.session.id ? { codeSessionId: resolvedCodeSession.session.id } : {}),
            ...(delegatedOrchestration ? { orchestration: delegatedOrchestration } : {}),
          },
        });
        const workerMeta: Record<string, unknown> = { ...(result.metadata ?? {}) };
        // Ensure responseSource is present — if the worker didn't provide one,
        // derive it from the primary provider context.
        if (!workerMeta.responseSource) {
          const primaryName = workerExecutionProfile?.providerType || ctx.llm?.name || 'unknown';
          workerMeta.responseSource = {
            locality: workerExecutionProfile?.providerLocality ?? getProviderLocalityFromName(primaryName),
            providerName: primaryName,
            ...(workerExecutionProfile?.providerName && workerExecutionProfile.providerName !== primaryName
              ? { providerProfileName: workerExecutionProfile.providerName }
              : {}),
            ...(workerExecutionProfile?.providerTier
              ? { providerTier: workerExecutionProfile.providerTier }
              : {}),
          };
        }
        if (requestedCodeContext?.sessionId || resolvedCodeSession) {
          workerMeta.codeSessionResolved = !!resolvedCodeSession;
          if (resolvedCodeSession) workerMeta.codeSessionId = resolvedCodeSession.session.id;
        }
        // Sync pending approvals from the executor into response metadata so the
        // frontend can render inline approval buttons (worker path does not do this
        // automatically like the inline ChatAgent LLM loop does).
        this.syncPendingApprovalsFromExecutor(
          conversationUserId,
          conversationChannel,
          pendingActionUserId,
          pendingActionChannel,
          pendingActionSurfaceId,
          routedScopedMessage.content,
        );
        const workerPendingAction = this.getActivePendingAction(
          pendingActionUserId,
          pendingActionChannel,
          pendingActionSurfaceId,
        );
        const workerPendingActionMeta = toPendingActionClientMetadata(workerPendingAction);
        if (
          workerPendingActionMeta
          && this.shouldAttachWorkerPendingActionMetadata(workerMeta, workerPendingAction, executionIdentity)
        ) {
          workerMeta.pendingAction = workerPendingActionMeta;
        }
        if (workerContextAssemblyMeta) {
          workerMeta.contextAssembly = {
            ...workerContextAssemblyMeta,
            ...(
              workerMeta.contextAssembly && typeof workerMeta.contextAssembly === 'object' && !Array.isArray(workerMeta.contextAssembly)
                ? workerMeta.contextAssembly as Record<string, unknown>
                : {}
            ),
          };
        }
        delete workerMeta.pendingApprovals;
        if (preResolvedSkills.length > 0) {
          workerMeta.activeSkills = preResolvedSkills.map((skill) => skill.id);
        }
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            result.content,
            { assistantResponseSource: readResponseSourceMetadata(workerMeta) },
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills, [], {
            contextAssembly: applyContextCompactionMetadata(
              workerMeta.contextAssembly && typeof workerMeta.contextAssembly === 'object' && !Array.isArray(workerMeta.contextAssembly)
                ? workerMeta.contextAssembly as PromptAssemblyDiagnostics
                : workerContextAssemblyMeta,
              latestContextCompaction,
            ),
            responseSource: readResponseSourceMetadata(workerMeta),
            requestId: message.id,
          });
        }
        return {
          content: result.content,
          metadata: Object.keys(workerMeta).length > 0 ? workerMeta : undefined,
        };
      } catch (error) {
        log.error({ agent: this.id, error: error instanceof Error ? error.stack ?? error.message : String(error) }, 'Brokered message execution failed');
        throw error;
      }
    }

    const directBrowserIntent = directIntent?.decision.route === 'browser_task';
    const liveToolLoopResult = await runLiveToolLoopController({
      agentId: this.id,
      ctx,
      message,
      llmMessages,
      tools: this.tools,
      secondBrainService: this.secondBrainService,
      enabledManagedProviders: this.enabledManagedProviders,
      resolveGwsProvider: this.resolveGwsProvider,
      fallbackChain: this.fallbackChain,
      fallbackProviderOrder,
      selectedExecutionProfile,
      qualityFallbackEnabled: this.qualityFallbackEnabled,
      directIntentDecision: directIntent?.decision,
      directBrowserIntent,
      hasResolvedCodeSession: !!resolvedCodeSession,
      resolvedCodeSessionId: resolvedCodeSession?.session.id,
      effectiveCodeContext,
      activeSkills,
      requestIntentContent,
      routedScopedMessage,
      conversationUserId,
      conversationChannel,
      allowModelMemoryMutation,
      defaultToolResultProviderKind,
      maxToolRounds: this.maxToolRounds,
      contextBudget: this.contextBudget,
      pendingActionUserId,
      pendingActionChannel,
      pendingActionSurfaceId,
      pendingActionUserKey,
      log,
      chatWithRoutingMetadata: (nextCtx, messages, options, providerOrder) => this.chatWithRoutingMetadata(
        nextCtx,
        messages,
        options,
        providerOrder,
      ),
      resolveToolResultProviderKind: (nextCtx, provider) => this.resolveToolResultProviderKind(nextCtx, provider),
      sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
        toolName,
        result,
        providerKind,
      ),
      resolveRoutedProviderForTools: this.resolveRoutedProviderForTools,
      resolveStoredToolLoopExecutionProfile: (nextCtx, profile, decision) => this.resolveStoredToolLoopExecutionProfile(
        nextCtx,
        profile,
        decision,
      ),
      lacksUsableAssistantContent: (content) => this.lacksUsableAssistantContent(content),
      looksLikeOngoingWorkResponse: (content) => this.looksLikeOngoingWorkResponse(content),
      getPendingApprovalIds: (userId, channel, surfaceId, nowMs) => this.getPendingApprovalIds(
        userId,
        channel,
        surfaceId,
        nowMs,
      ),
      setPendingApprovals: (userKey, ids, surfaceId, nowMs) => this.setPendingApprovals(
        userKey,
        ids,
        surfaceId,
        nowMs,
      ),
      setPendingApprovalAction: (userId, channel, surfaceId, action, nowMs) => this.setPendingApprovalAction(
        userId,
        channel,
        surfaceId,
        action,
        nowMs,
      ),
      setChatContinuationGraphPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setChatContinuationGraphPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
    });
    finalContent = liveToolLoopResult.finalContent;
    pendingActionMeta = liveToolLoopResult.pendingActionMeta;
    lastToolRoundResults = liveToolLoopResult.lastToolRoundResults;
    latestContextCompaction = liveToolLoopResult.latestContextCompaction;
    responseSource = liveToolLoopResult.responseSource;
    contextAssemblyMeta = applyContextCompactionMetadata(contextAssemblyMeta, latestContextCompaction);

    const metadata: Record<string, unknown> = {};
    if (activeSkills.length > 0) metadata.activeSkills = activeSkills.map((skill) => skill.id);
    if (pendingActionMeta) metadata.pendingAction = pendingActionMeta;
    if (contextAssemblyMeta) metadata.contextAssembly = contextAssemblyMeta;
    if (responseSource) metadata.responseSource = responseSource;
    // Signal code session resolution status so the frontend can detect drift.
    if (requestedCodeContext?.sessionId || resolvedCodeSession) {
      metadata.codeSessionResolved = !!resolvedCodeSession;
      if (resolvedCodeSession) {
        metadata.codeSessionId = resolvedCodeSession.session.id;
      }
    }

    if (this.conversationService) {
      this.conversationService.recordTurn(
        conversationKey,
        message.content,
        finalContent,
        { assistantResponseSource: responseSource },
      );
    }
    if (resolvedCodeSession) {
      this.syncCodeSessionRuntimeState(
        resolvedCodeSession.session,
        conversationUserId,
        conversationChannel,
        activeSkills,
        lastToolRoundResults,
        {
          contextAssembly: contextAssemblyMeta,
          responseSource,
          requestId: message.id,
        },
      );
    }

    return {
      content: finalContent,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private getCodeSessionSurfaceId(message: UserMessage): string {
    return resolveConversationSurfaceId({
      channel: message.channel,
      surfaceId: message.surfaceId,
      userId: message.userId,
    });
  }

  private shouldHandleSecurityEventHandoffInline(message: UserMessage): boolean {
    const metadata = message.metadata;
    if (!metadata) return false;
    const handoff = isRecord(metadata.handoff) ? metadata.handoff : null;
    const securityEvent = isRecord(metadata.securityEvent) ? metadata.securityEvent : null;
    if (!handoff || !securityEvent) return false;
    return handoff.targetAgentId === this.id && securityEvent.type != null;
  }

  private resolveCodeSessionContext(message: UserMessage): ResolvedCodeSessionContext | null {
    if (!this.codeSessionStore) return null;
    const requested = readCodeRequestMetadata(message.metadata);
    const userId = message.userId?.trim();
    const channel = message.channel?.trim();
    if (!userId || !channel) return null;
    const resolved = this.codeSessionStore.resolveForRequest({
      requestedSessionId: requested?.sessionId,
      userId,
      principalId: message.principalId,
      channel,
      surfaceId: this.getCodeSessionSurfaceId(message),
      touchAttachment: true,
    });
    if (!resolved && requested?.sessionId) {
      log.warn(
        {
          agent: this.id,
          requestedSessionId: requested.sessionId,
          userId,
          channel,
          surfaceId: this.getCodeSessionSurfaceId(message),
        },
        'Code session resolution failed — message will fall back to web chat context',
      );
    }
    if (!resolved) {
      return null;
    }
    const surfaceId = this.getCodeSessionSurfaceId(message);
    const preRoutedGateway = readPreRoutedIntentGatewayMetadata(message.metadata);
    if (!shouldAttachCodeSessionForRequest({
      content: stripLeadingContextPrefix(message.content),
      channel,
      surfaceId,
      requestedCodeContext: requested,
      resolvedCodeSession: resolved,
      gatewayDecision: preRoutedGateway?.decision ?? null,
    })) {
      return null;
    }
    return resolved;
  }

  private async refreshCodeSessionWorkspaceAwareness(
    resolved: ResolvedCodeSessionContext,
    messageContent?: string,
  ): Promise<ResolvedCodeSessionContext> {
    if (!this.codeSessionStore) return resolved;
    const workState = resolved.session.workState;
    const updates: Partial<typeof workState> = {};
    const now = Date.now();
    if (!workState.workspaceProfile) {
      updates.workspaceProfile = inspectCodeWorkspaceSync(resolved.session.resolvedRoot, now);
    }
    const nextWorkspaceProfile = updates.workspaceProfile ?? workState.workspaceProfile;
    if (shouldRefreshCodeWorkspaceTrust(workState.workspaceTrust, resolved.session.resolvedRoot, now)) {
      updates.workspaceTrust = assessCodeWorkspaceTrustSync(resolved.session.resolvedRoot, now);
    }
    if (shouldRefreshCodeWorkspaceMap(workState.workspaceMap, resolved.session.resolvedRoot, now)) {
      updates.workspaceMap = buildCodeWorkspaceMapSync(resolved.session.resolvedRoot, now);
    }
    if (shouldRefreshCodeSessionFocus(messageContent ?? '')) {
      const nextFocusSummary = summarizeCodeSessionFocus(
        messageContent ?? '',
        getCodeSessionPromptRelativePath(
          resolved.session.uiState.selectedFilePath,
          resolved.session.resolvedRoot,
        ),
      );
      if (nextFocusSummary && nextFocusSummary !== workState.focusSummary) {
        updates.focusSummary = nextFocusSummary;
      }
    }
    const nextWorkspaceMap = updates.workspaceMap ?? workState.workspaceMap;
    if (shouldRefreshCodeSessionWorkingSet(messageContent ?? '') && nextWorkspaceMap) {
      const nextWorkingSet = buildCodeWorkspaceWorkingSetSync({
        workspaceRoot: resolved.session.resolvedRoot,
        workspaceMap: nextWorkspaceMap,
        workspaceProfile: nextWorkspaceProfile,
        query: messageContent ?? '',
        selectedFilePath: resolved.session.uiState.selectedFilePath,
        currentDirectory: resolved.session.uiState.currentDirectory,
        previousWorkingSet: workState.workingSet,
        now,
      });
      if (!sameCodeWorkspaceWorkingSet(workState.workingSet, nextWorkingSet)) {
        updates.workingSet = nextWorkingSet;
      }
    }
    let nextResolved = Object.keys(updates).length === 0
      ? resolved
      : (() => {
        const updated = this.codeSessionStore!.updateSession({
          sessionId: resolved.session.id,
          ownerUserId: resolved.session.ownerUserId,
          workState: updates,
        });
        if (!updated) return resolved;
        return {
          ...resolved,
          session: updated,
        };
      })();

    if (nextResolved.session.workState.managedSandboxes.length > 0 && this.tools?.getCodeSessionManagedSandboxStatus) {
      await this.tools.getCodeSessionManagedSandboxStatus({
        sessionId: nextResolved.session.id,
        ownerUserId: nextResolved.session.ownerUserId,
      }).catch(() => undefined);
      const refreshedSession = this.codeSessionStore.getSession(
        nextResolved.session.id,
        nextResolved.session.ownerUserId,
      );
      if (refreshedSession) {
        nextResolved = {
          ...nextResolved,
          session: refreshedSession,
        };
      }
    }

    if (!this.codeWorkspaceTrustService) return nextResolved;
    const enrichedSession = this.codeWorkspaceTrustService.maybeSchedule(nextResolved.session);
    if (enrichedSession === nextResolved.session) return nextResolved;
    return {
      ...nextResolved,
      session: enrichedSession,
    };
  }

  private formatCodeWorkspaceProfileForPromptWithTrust(
    profile: CodeWorkspaceProfile | null | undefined,
    workspaceTrust: CodeWorkspaceTrustAssessment | null | undefined,
    workspaceTrustReview?: CodeWorkspaceTrustReview | null,
  ): string {
    if (!profile) return 'workspaceProfile: (not indexed yet)';
    const effectiveTrustState = getEffectiveCodeWorkspaceTrustState(workspaceTrust, workspaceTrustReview);
    const allowRepoSummary = effectiveTrustState === 'trusted' || !workspaceTrust;
    return [
      `workspaceProfile.repoName: ${profile.repoName || '(unknown)'}`,
      `workspaceProfile.repoKind: ${profile.repoKind || '(unknown)'}`,
      `workspaceProfile.stack: ${profile.stack.length > 0 ? profile.stack.join(', ') : '(unknown)'}`,
      `workspaceProfile.manifests: ${profile.manifests.length > 0 ? profile.manifests.join(', ') : '(none)'}`,
      `workspaceProfile.entryHints: ${profile.entryHints.length > 0 ? profile.entryHints.join(', ') : '(none)'}`,
      `workspaceProfile.topLevelEntries: ${profile.topLevelEntries.length > 0 ? profile.topLevelEntries.join(', ') : '(none)'}`,
      `workspaceProfile.inspectedFiles: ${profile.inspectedFiles.length > 0 ? profile.inspectedFiles.join(', ') : '(none)'}`,
      `workspaceProfile.lastIndexedAt: ${profile.lastIndexedAt ? new Date(profile.lastIndexedAt).toISOString() : '(unknown)'}`,
      allowRepoSummary && profile.summary
        ? `workspaceProfile.summary:\n${profile.summary}`
        : `workspaceProfile.summary: ${allowRepoSummary ? '(none)' : '(suppressed until workspace trust is cleared)'}`,
    ].join('\n');
  }

  private formatCodeWorkspaceTrustForPrompt(
    workspaceTrust: CodeWorkspaceTrustAssessment | null | undefined,
    workspaceTrustReview?: CodeWorkspaceTrustReview | null,
  ): string {
    if (!workspaceTrust) return 'workspaceTrust: (not assessed yet)';
    const reviewActive = isCodeWorkspaceTrustReviewActive(workspaceTrust, workspaceTrustReview);
    const effectiveTrustState = getEffectiveCodeWorkspaceTrustState(workspaceTrust, workspaceTrustReview) ?? workspaceTrust.state;
    const findingLines = workspaceTrust.findings.length > 0
      ? workspaceTrust.findings
        .slice(0, 6)
        .map((finding) => `- [${finding.severity}] ${finding.path}: ${finding.summary}${finding.evidence ? ` (${finding.evidence})` : ''}`)
        .join('\n')
      : '- (none)';
    const nativeProtection = workspaceTrust.nativeProtection;
    const nativeProtectionLines = nativeProtection
      ? [
        `workspaceTrust.nativeProtection.provider: ${nativeProtection.provider}`,
        `workspaceTrust.nativeProtection.status: ${nativeProtection.status}`,
        `workspaceTrust.nativeProtection.observedAt: ${nativeProtection.observedAt ? new Date(nativeProtection.observedAt).toISOString() : '(unknown)'}`,
        `workspaceTrust.nativeProtection.summary: ${nativeProtection.summary}`,
        `workspaceTrust.nativeProtection.details: ${Array.isArray(nativeProtection.details) && nativeProtection.details.length > 0 ? nativeProtection.details.join(' | ') : '(none)'}`,
      ]
      : [
        'workspaceTrust.nativeProtection: (not scanned yet)',
      ];
    return [
      `workspaceTrust.state: ${workspaceTrust.state}`,
      `workspaceTrust.effectiveState: ${effectiveTrustState}`,
      reviewActive
        ? `workspaceTrust.review: manually accepted by ${workspaceTrustReview?.reviewedBy || 'unknown'} at ${workspaceTrustReview?.reviewedAt ? new Date(workspaceTrustReview.reviewedAt).toISOString() : '(unknown)'}`
        : 'workspaceTrust.review: (none)',
      `workspaceTrust.assessedAt: ${workspaceTrust.assessedAt ? new Date(workspaceTrust.assessedAt).toISOString() : '(unknown)'}`,
      `workspaceTrust.scannedFiles: ${workspaceTrust.scannedFiles}`,
      `workspaceTrust.truncated: ${workspaceTrust.truncated ? 'yes' : 'no'}`,
      `workspaceTrust.summary: ${workspaceTrust.summary}`,
      ...nativeProtectionLines,
      'workspaceTrust.findings:',
      findingLines,
    ].join('\n');
  }

  private buildScopedSystemPrompt(
    resolvedCodeSession?: ResolvedCodeSessionContext | null,
    message?: UserMessage,
  ): string {
    return buildScopedSystemPromptHelper({
      customSystemPrompt: this.customSystemPrompt,
      soulPromptText: this.soulPromptText,
      resolveAssistantResponseStyle: this.resolveAssistantResponseStyle,
      resolvedCodeSession,
      message,
      buildCodeSessionSystemContext: (session) => this.buildCodeSessionSystemContext(session),
    });
  }

  private loadPromptKnowledgeBases(
    resolvedCodeSession?: ResolvedCodeSessionContext | null,
    query?: MemoryContextQuery,
  ): {
    knowledgeBases: PromptAssemblyKnowledgeBase[];
    globalContent: string;
    globalSelection?: MemoryContextLoadResult;
    codingMemoryContent: string;
    codingMemorySelection?: MemoryContextLoadResult;
    queryPreview?: string;
  } {
    return loadPromptKnowledgeBasesHelper({
      memoryStore: this.memoryStore,
      codeSessionMemoryStore: this.codeSessionMemoryStore,
      stateAgentId: this.stateAgentId,
      resolvedCodeSession,
      query,
    });
  }

  private buildKnowledgeBaseContextQuery(input: {
    messageContent: string;
    continuityThread?: ContinuityThreadRecord | null;
    pendingAction?: PendingActionRecord | null;
    resolvedCodeSession?: ResolvedCodeSessionContext | null;
  }): MemoryContextQuery | undefined {
    return buildKnowledgeBaseContextQueryHelper(input);
  }

  private buildContextAssemblyMetadata(input: {
    memoryScope: 'global' | 'coding_session';
    knowledgeBase: string;
    codingMemory?: string;
    globalMemorySelection?: MemoryContextLoadResult;
    codingMemorySelection?: MemoryContextLoadResult;
    knowledgeBaseQuery?: string;
    activeSkillCount: number;
    pendingAction?: PendingActionRecord | null;
    continuityThread?: ContinuityThreadRecord | null;
    codeSessionId?: string;
    executionProfile?: SelectedExecutionProfile;
    sectionFootprints?: ReturnType<typeof buildPromptAssemblySectionFootprints>;
    preservedExecutionState?: ReturnType<typeof buildPromptAssemblyPreservedExecutionState>;
    contextCompaction?: ReturnType<typeof buildContextCompactionDiagnostics>;
  }): PromptAssemblyDiagnostics {
    return buildContextAssemblyMetadataHelper(input);
  }

  private buildPendingActionPromptContext(
    pendingAction: PendingActionRecord | null | undefined,
  ): {
    kind: string;
    prompt: string;
    field?: string;
    route?: string;
    operation?: string;
    transferPolicy?: string;
    originChannel?: string;
    originSurfaceId?: string;
  } | null {
    return buildPendingActionPromptContextHelper(pendingAction);
  }

  private buildAssembledSystemPrompt(input: {
    baseSystemPrompt: string;
    knowledgeBases: PromptAssemblyKnowledgeBase[];
    activeSkills: readonly ResolvedSkill[];
    toolContext?: string;
    runtimeNotices?: Array<{ level: 'info' | 'warn'; message: string }>;
    pendingAction?: PendingActionRecord | null;
    pendingApprovalNotice?: string;
    continuityThread?: ContinuityThreadRecord | null;
    executionProfile?: SelectedExecutionProfile;
    additionalSections?: Array<{
      section: string;
      content: string;
      mode?: string;
      itemCount?: number;
    }>;
  }): string {
    return buildAssembledSystemPromptHelper(input);
  }

  private buildCodeSessionSystemContext(session: CodeSessionRecord): string {
    return buildCodeSessionSystemContextHelper({
      session,
      remoteExecutionTargets: this.tools?.getRemoteExecutionTargets?.(),
      formatCodeWorkspaceTrustForPrompt: (workspaceTrust, workspaceTrustReview) => this.formatCodeWorkspaceTrustForPrompt(
        workspaceTrust,
        workspaceTrustReview,
      ),
      formatCodeWorkspaceProfileForPromptWithTrust: (profile, workspaceTrust, workspaceTrustReview) => this.formatCodeWorkspaceProfileForPromptWithTrust(
        profile,
        workspaceTrust,
        workspaceTrustReview,
      ),
    });
  }

  private syncCodeSessionRuntimeState(
    session: CodeSessionRecord,
    conversationUserId: string,
    conversationChannel: string,
    activeSkills: ResolvedSkill[],
    lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [],
    runtimeState?: {
      contextAssembly?: PromptAssemblyDiagnostics;
      responseSource?: ResponseSourceMetadata;
      requestId?: string;
    },
  ): void {
    syncCodeSessionRuntimeStateHelper({
      codeSessionStore: this.codeSessionStore,
      tools: this.tools,
      session,
      conversationUserId,
      conversationChannel,
      activeSkills,
      lastToolRoundResults,
      runtimeState,
      getPendingApprovals: (userKey) => this.getPendingApprovals(userKey),
    });
  }

  private buildImmediateResponseMetadata(
    activeSkills: ResolvedSkill[],
    userId: string,
    channel: string,
    surfaceId?: string,
    options?: { includePendingAction?: boolean },
  ): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {};
    if (activeSkills.length > 0) {
      metadata.activeSkills = activeSkills.map((skill) => skill.id);
    }
    if (options?.includePendingAction === true) {
      const pendingAction = this.getActivePendingAction(userId, channel, surfaceId);
      const pendingActionMeta = toPendingActionClientMetadata(pendingAction);
      if (pendingActionMeta) {
        metadata.pendingAction = pendingActionMeta;
      }
    }
    const continuityMeta = toContinuityThreadClientMetadata(this.getContinuityThread(userId));
    if (continuityMeta) {
      metadata.continuity = continuityMeta;
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private withCurrentPendingActionMetadata(
    metadata: Record<string, unknown> | undefined,
    userId: string,
    channel: string,
    surfaceId?: string,
  ): Record<string, unknown> | undefined {
    const next = { ...(metadata ?? {}) };
    const shouldAttachPendingAction = this.shouldAttachCurrentPendingActionMetadata(metadata);
    delete next.pendingApprovals;
    if (shouldAttachPendingAction) {
      const pendingAction = this.getActivePendingAction(userId, channel, surfaceId);
      const pendingActionMeta = toPendingActionClientMetadata(pendingAction);
      if (pendingActionMeta) {
        next.pendingAction = pendingActionMeta;
      }
    }
    const continuityMeta = toContinuityThreadClientMetadata(this.getContinuityThread(userId));
    if (continuityMeta) {
      next.continuity = continuityMeta;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private shouldAttachCurrentPendingActionMetadata(
    metadata: Record<string, unknown> | undefined,
  ): boolean {
    if (!metadata) return false;
    if (isRecord(metadata.pendingAction)) return true;
    if (Array.isArray(metadata.pendingApprovals)) return true;
    if (isRecord(metadata.delegatedHandoff)) {
      const reportingMode = typeof metadata.delegatedHandoff.reportingMode === 'string'
        ? metadata.delegatedHandoff.reportingMode.trim()
        : '';
      const unresolvedBlockerKind = typeof metadata.delegatedHandoff.unresolvedBlockerKind === 'string'
        ? metadata.delegatedHandoff.unresolvedBlockerKind.trim()
        : '';
      const approvalCount = typeof metadata.delegatedHandoff.approvalCount === 'number'
        ? metadata.delegatedHandoff.approvalCount
        : 0;
      if (reportingMode === 'held_for_approval'
        || (reportingMode === 'status_only' && unresolvedBlockerKind.length > 0)
        || unresolvedBlockerKind.length > 0
        || approvalCount > 0) {
        return true;
      }
    }
    return false;
  }

  private shouldAttachWorkerPendingActionMetadata(
    metadata: Record<string, unknown>,
    pendingAction: PendingActionRecord | null,
    executionIdentity: ExecutionIdentityMetadata,
  ): boolean {
    if (isRecord(metadata.pendingAction) || !pendingAction) {
      return false;
    }
    const executionId = executionIdentity.executionId?.trim();
    const rootExecutionId = executionIdentity.rootExecutionId?.trim();
    return (!!executionId && pendingAction.executionId === executionId)
      || (!!rootExecutionId && pendingAction.rootExecutionId === rootExecutionId);
  }

  private async buildDirectIntentResponse(input: DirectIntentResponseInput): Promise<AgentResponse> {
    const normalizedBase = typeof input.result === 'string'
      ? { content: input.result }
      : input.result;
    const selectedExecutionProfile = readSelectedExecutionProfileMetadata(
      input.routingMessage?.metadata ?? input.message.metadata,
    );
    const surfaceUserId = input.surfaceUserId?.trim() || input.message.userId;
    const surfaceChannel = input.surfaceChannel?.trim() || input.message.channel;
    const surfaceId = input.surfaceId?.trim() || input.message.surfaceId;
    const continuationState = readDirectContinuationStateMetadata(normalizedBase.metadata);
    if (continuationState !== undefined) {
      this.updateDirectContinuationState(
        surfaceUserId,
        surfaceChannel,
        surfaceId,
        continuationState,
      );
    }
    const baseMetadata = stripDirectContinuationStateMetadata(normalizedBase.metadata);
    const normalized = readResponseSourceMetadata(baseMetadata) || !input.ctx.llm?.name?.trim()
      ? {
          content: normalizedBase.content,
          ...(baseMetadata ? { metadata: baseMetadata } : {}),
        }
      : {
          content: normalizedBase.content,
          metadata: {
            ...(baseMetadata ?? {}),
            responseSource: (
              buildDirectHandlerResponseSource(input.candidate, selectedExecutionProfile, input.ctx.llm.name)
              ?? {
                locality: selectedExecutionProfile?.providerLocality ?? getProviderLocalityFromName(input.ctx.llm.name),
                providerName: selectedExecutionProfile?.providerType ?? input.ctx.llm.name.trim(),
                ...(selectedExecutionProfile?.providerName
                  && selectedExecutionProfile.providerName !== (selectedExecutionProfile.providerType ?? input.ctx.llm.name.trim())
                  ? { providerProfileName: selectedExecutionProfile.providerName }
                  : {}),
                ...(selectedExecutionProfile?.providerModel
                  ? { model: selectedExecutionProfile.providerModel }
                  : {}),
                ...((selectedExecutionProfile?.providerTier ?? getProviderTier(input.ctx.llm.name))
                  ? { providerTier: selectedExecutionProfile?.providerTier ?? getProviderTier(input.ctx.llm.name) }
                  : {}),
                usedFallback: false,
              }
            ) satisfies ResponseSourceMetadata,
          },
        };
    if (this.conversationService) {
      this.conversationService.recordTurn(
        input.conversationKey,
        input.message.content,
        normalized.content,
        { assistantResponseSource: readResponseSourceMetadata(normalized.metadata) },
      );
    }
    const routingMessage = input.routingMessage ?? input.message;
    const intentGateway = input.intentGateway ?? await this.classifyIntentGateway(routingMessage, input.ctx);
    this.logIntentGateway(input.candidate, routingMessage, intentGateway, true);
    const gatewayMeta = toIntentGatewayClientMetadata(intentGateway);
    const normalizedMetadata = this.withCurrentPendingActionMetadata(
      normalized.metadata,
      surfaceUserId,
      surfaceChannel,
      surfaceId,
    );
    this.recordIntentRoutingTrace('direct_intent_response', {
      message: input.message,
      details: {
        candidate: input.candidate,
        route: intentGateway?.decision.route,
        gatewayAvailable: intentGateway?.available ?? false,
        handled: true,
        metadataKeys: normalizedMetadata ? Object.keys(normalizedMetadata) : [],
      },
      contentPreview: normalized.content,
    });
    const metadata = {
      ...(this.buildImmediateResponseMetadata(
        input.activeSkills,
        surfaceUserId,
        surfaceChannel,
        surfaceId,
      ) ?? {}),
      ...(normalizedMetadata ?? {}),
      ...(gatewayMeta ? { intentGateway: gatewayMeta } : {}),
    };
    return {
      content: normalized.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private buildDegradedDirectIntentResponse(input: DegradedDirectIntentResponseInput): AgentResponse {
    const normalizedBase = typeof input.result === 'string'
      ? { content: input.result }
      : input.result;
    const surfaceUserId = input.surfaceUserId?.trim() || input.message.userId;
    const surfaceChannel = input.surfaceChannel?.trim() || input.message.channel;
    const surfaceId = input.surfaceId?.trim() || input.message.surfaceId;
    const continuationState = readDirectContinuationStateMetadata(normalizedBase.metadata);
    if (continuationState !== undefined) {
      this.updateDirectContinuationState(
        surfaceUserId,
        surfaceChannel,
        surfaceId,
        continuationState,
      );
    }
    const baseMetadata = stripDirectContinuationStateMetadata(normalizedBase.metadata);
    const normalized = {
      content: normalizedBase.content,
      ...(baseMetadata ? { metadata: baseMetadata } : {}),
    };
    if (this.conversationService) {
      this.conversationService.recordTurn(
        input.conversationKey,
        input.message.content,
        normalized.content,
        { assistantResponseSource: readResponseSourceMetadata(normalized.metadata) },
      );
    }
    const normalizedMetadata = this.withCurrentPendingActionMetadata(
      normalized.metadata,
      surfaceUserId,
      surfaceChannel,
      surfaceId,
    );
    this.recordIntentRoutingTrace('direct_intent_response', {
      message: input.message,
      details: {
        candidate: input.candidate,
        route: input.intentGateway?.decision.route,
        gatewayAvailable: input.intentGateway?.available ?? false,
        handled: true,
        degradedFallback: true,
        degradedReason: input.degradedReason,
        metadataKeys: normalizedMetadata ? Object.keys(normalizedMetadata) : [],
      },
      contentPreview: normalized.content,
    });
    const gatewayMeta = toIntentGatewayClientMetadata(input.intentGateway);
    const metadata = {
      ...(this.buildImmediateResponseMetadata(
        input.activeSkills,
        surfaceUserId,
        surfaceChannel,
        surfaceId,
      ) ?? {}),
      ...(normalizedMetadata ?? {}),
      ...(gatewayMeta ? { intentGateway: gatewayMeta } : {}),
    };
    return {
      content: normalized.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private tryDirectRecentToolReport(
    message: UserMessage,
    resolvedCodeSession?: ResolvedCodeSessionContext | null,
  ): string | null {
    return tryDirectRecentToolReportHelper({
      tools: this.tools,
      message,
      resolvedCodeSession,
    });
  }

  private async handleCodeSessionAttach(
    message: UserMessage,
    ctx: AgentContext,
    target: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const codingRoutes = buildChatDirectCodingRouteDeps({
      agentId: this.id,
      tools: this.tools,
      codeSessionStore: this.codeSessionStore,
      parsePendingActionUserKey: (key) => this.parsePendingActionUserKey(key),
      recordIntentRoutingTrace: (stage, traceInput) => this.recordIntentRoutingTrace(stage, traceInput),
      getPendingApprovalIds: (userId, channel, surfaceId) => this.getPendingApprovalIds(userId, channel, surfaceId),
      setPendingApprovals: (key, ids, surfaceId, nowMs) => this.setPendingApprovals(key, ids, surfaceId, nowMs),
      syncPendingApprovalsFromExecutor: (
        sourceUserId,
        sourceChannel,
        targetUserId,
        targetChannel,
        surfaceId,
        originalUserContent,
      ) => this.syncPendingApprovalsFromExecutor(
        sourceUserId,
        sourceChannel,
        targetUserId,
        targetChannel,
        surfaceId,
        originalUserContent,
      ),
      setPendingApprovalAction: (userId, channel, surfaceId, actionInput) => this.setPendingApprovalAction(
        userId,
        channel,
        surfaceId,
        actionInput,
      ),
      getActivePendingAction: (userId, channel, surfaceId) => this.getActivePendingAction(userId, channel, surfaceId),
      completePendingAction: (actionId) => this.completePendingAction(actionId),
      onMessage: (nextMessage, nextCtx) => this.onMessage(nextMessage, nextCtx),
    });
    return handleCodeSessionAttachHelper({
      ...codingRoutes.sessionControlDeps,
      resumeCodingTask: buildDirectCodingTaskResumer(codingRoutes.backendDeps),
      message,
      ctx,
      target,
    });
  }

  private lacksUsableAssistantContent(content: string | undefined): boolean {
    return _lacksUsableAssistantContent(content);
  }

  private looksLikeOngoingWorkResponse(content: string | undefined): boolean {
    return _looksLikeOngoingWorkResponse(content);
  }

  private resolveToolResultProviderKind(
    ctx: AgentContext,
    overrideProvider?: LLMProvider,
  ): 'local' | 'external' {
    const providerType = (overrideProvider?.name ?? ctx.llm?.name ?? '').trim().toLowerCase();
    return getProviderLocality(providerType) ?? 'external';
  }

  private sanitizeToolResultForLlm(
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ): {
    sanitized: unknown;
    threats: string[];
    trustLevel: import('./tools/types.js').ContentTrustLevel;
    taintReasons: string[];
    allowPlannerRawContent: boolean;
    allowMemoryWrite: boolean;
    allowDownstreamDispatch: boolean;
  } {
    if (!this.outputGuardian) {
      return {
        sanitized: result,
        threats: [],
        trustLevel: providerKind === 'local' ? 'trusted' : 'low_trust',
        taintReasons: providerKind === 'local' ? [] : ['remote_content'],
        allowPlannerRawContent: true,
        allowMemoryWrite: providerKind === 'local',
        allowDownstreamDispatch: true,
      };
    }

    const scan = this.outputGuardian.scanToolResult(toolName, result, { providerKind });
    return {
      sanitized: scan.allowPlannerRawContent
        ? scan.sanitized
        : compactQuarantinedToolResult(toolName, scan.sanitized, scan.taintReasons),
      threats: scan.threats,
      trustLevel: scan.trustLevel,
      taintReasons: scan.taintReasons,
      allowPlannerRawContent: scan.allowPlannerRawContent,
      allowMemoryWrite: scan.allowMemoryWrite,
      allowDownstreamDispatch: scan.allowDownstreamDispatch,
    };
  }

  /**
   * Check if the user's message is an approval decision for pending tool actions.
   * If so, execute approval/denial and return a summary.
   */
  private async tryHandleApproval(
    message: UserMessage,
    ctx: AgentContext,
    workerManager?: WorkerManager,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;
    return handleApprovalMessage({
      message,
      ctx,
      tools: this.tools,
      getPendingApprovalAction: (userId, channel, surfaceId, nowMs) => this.getPendingApprovalAction(userId, channel, surfaceId, nowMs),
      setPendingApprovals: (userKey, ids, surfaceId, nowMs) => this.setPendingApprovals(userKey, ids, surfaceId, nowMs),
      setPendingApprovalAction: (userId, channel, surfaceId, pendingActionInput) => this.setPendingApprovalAction(
        userId,
        channel,
        surfaceId,
        pendingActionInput,
      ),
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
      takeApprovalFollowUp: (approvalId, decision) => this.takeApprovalFollowUp(approvalId, decision),
      clearApprovalFollowUp: (approvalId) => this.clearApprovalFollowUp(approvalId),
      resumeStoredExecutionGraphPendingAction: (pendingAction, options) => {
        if (!options?.approvalId || !options.approvalResult) {
          return Promise.resolve(null);
        }
        return this.resumeStoredExecutionGraphPendingAction(
          pendingAction,
          {
            approvalId: options.approvalId,
            approvalResult: options.approvalResult,
          },
          workerManager
            ? (action, nextOptions) => workerManager.resumeExecutionGraphPendingAction(action, nextOptions)
            : undefined,
        );
      },
      normalizeApprovalContinuationResponse: (response, userId, channel, surfaceId) => this.normalizeContinuationResponse(
        response,
        userId,
        channel,
        surfaceId,
      ),
      withCurrentPendingActionMetadata: (metadata, userId, channel, surfaceId) => this.withCurrentPendingActionMetadata(
        metadata,
        userId,
        channel,
        surfaceId,
      ),
      formatResolvedApprovalResultResponse: (pendingAction, approvalResult) => this.formatResolvedApprovalResultResponse(
        pendingAction,
        approvalResult,
      ),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      resolveApprovalTargets: (content, pendingIds) => this.resolveApprovalTargets(content, pendingIds),
    });
  }

  private getContinuityThread(
    userId: string,
    nowMs: number = Date.now(),
  ): ContinuityThreadRecord | null {
    return this.orchestrationState.getContinuityThread(userId, nowMs);
  }

  private touchContinuityThread(
    userId: string,
    channel: string,
    surfaceId?: string,
    codeSessionId?: string,
    nowMs: number = Date.now(),
  ): ContinuityThreadRecord | null {
    return this.orchestrationState.touchContinuityThread(userId, channel, surfaceId, codeSessionId, nowMs);
  }

  private updateContinuityThreadFromIntent(input: {
    executionIdentity: NonNullable<ReturnType<typeof readExecutionIdentityMetadata>>;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread: ContinuityThreadRecord | null;
    gateway: IntentGatewayRecord | null;
    routingContent: string;
    codeSessionId?: string;
  }): ContinuityThreadRecord | null {
    return this.orchestrationState.updateContinuityThreadFromIntent(input);
  }

  private registerExecutionTurn(input: {
    executionIdentity: NonNullable<ReturnType<typeof readExecutionIdentityMetadata>>;
    requestId: string;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    content: string;
    codeSessionId?: string;
    nowMs?: number;
  }): ExecutionRecord | null {
    return this.orchestrationState.registerExecutionTurn(input);
  }

  private updateExecutionFromIntent(input: {
    executionIdentity: NonNullable<ReturnType<typeof readExecutionIdentityMetadata>>;
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    gateway: IntentGatewayRecord | null;
    routingContent: string;
    codeSessionId?: string;
    nowMs?: number;
  }): ExecutionRecord | null {
    return this.orchestrationState.updateExecutionFromIntent(input);
  }

  private getActiveExecution(input: {
    userId: string;
    channel: string;
    surfaceId?: string;
    continuityThread?: ContinuityThreadRecord | null;
    pendingAction?: PendingActionRecord | null;
    excludeExecutionId?: string;
  }): ExecutionRecord | null {
    return this.orchestrationState.getActiveExecution(input);
  }

  private updateDirectContinuationState(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    continuationState: ContinuityThreadContinuationState | null,
  ): ContinuityThreadRecord | null {
    return this.orchestrationState.updateDirectContinuationState(userId, channel, surfaceId, continuationState);
  }

  private getActivePendingAction(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    return this.orchestrationState.getActivePendingAction(userId, channel, surfaceId, nowMs);
  }

  private readPendingActionSwitchCandidatePayload(
    pendingAction: PendingActionRecord | null | undefined,
  ) {
    return this.orchestrationState.readPendingActionSwitchCandidatePayload(pendingAction);
  }

  private replacePendingAction(
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    input: Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'> & { id?: string },
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    return this.orchestrationState.replacePendingAction(userId, channel, surfaceId, input, nowMs);
  }

  private updatePendingAction(
    actionId: string,
    patch: Partial<Omit<PendingActionRecord, 'id' | 'scope' | 'createdAt'>>,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    return this.orchestrationState.updatePendingAction(actionId, patch, nowMs);
  }

  private completePendingAction(actionId: string, nowMs: number = Date.now()): void {
    this.orchestrationState.completePendingAction(actionId, nowMs);
  }

  private parsePendingActionUserKey(userKey: string): { userId: string; channel: string } {
    return this.orchestrationState.parsePendingActionUserKey(userKey);
  }

  private getPendingApprovals(
    userKey: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ) {
    return this.orchestrationState.getPendingApprovals(userKey, surfaceId, nowMs);
  }

  private setPendingApprovals(
    userKey: string,
    ids: string[],
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): void {
    this.orchestrationState.setPendingApprovals(userKey, ids, surfaceId, nowMs);
  }

  private getPendingApprovalAction(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): PendingActionRecord | null {
    return this.orchestrationState.getPendingApprovalAction(userId, channel, surfaceId, nowMs);
  }

  private getPendingApprovalIds(
    userId: string,
    channel: string,
    surfaceId?: string,
    nowMs: number = Date.now(),
  ): string[] {
    return this.orchestrationState.getPendingApprovalIds(userId, channel, surfaceId, nowMs);
  }

  private setPendingApprovalActionForRequest(
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
      resume?: PendingActionRecord['resume'];
      executionId?: string;
      rootExecutionId?: string;
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ) {
    return this.orchestrationState.setPendingApprovalActionForRequest(userKey, surfaceId, input, nowMs);
  }

  private setChatContinuationGraphPendingApprovalActionForRequest(
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
      continuation: ChatContinuationPayload;
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ) {
    if (!this.executionGraphStore) {
      throw new Error('Execution graph store is required for chat approval continuation.');
    }
    const { userId, channel } = this.parsePendingActionUserKey(userKey);
    return recordChatContinuationGraphApproval({
      graphStore: this.executionGraphStore,
      runTimeline: this.runTimeline,
      userKey,
      userId,
      channel,
      surfaceId,
      agentId: this.stateAgentId,
      requestId: randomUUID(),
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      action: input,
      setGraphPendingActionForRequest: (nextUserKey, nextSurfaceId, action, nextNowMs) => this.orchestrationState.setGraphPendingActionInterruptForRequest(
        nextUserKey,
        nextSurfaceId,
        action,
        nextNowMs,
      ),
      nowMs,
    });
  }

  private buildPendingApprovalBlockedResponse(
    result: ReturnType<ChatAgentOrchestrationState['setPendingApprovalActionForRequest']>,
    fallbackContent: string,
  ): { content: string; metadata?: Record<string, unknown> } {
    return this.orchestrationState.buildPendingApprovalBlockedResponse(result, fallbackContent);
  }

  private setPendingApprovalAction(
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
      executionId?: string;
      rootExecutionId?: string;
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ) {
    return this.orchestrationState.setPendingApprovalAction(userId, channel, surfaceId, input, nowMs);
  }

  private setClarificationPendingAction(
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
      codeSessionId?: string;
      currentSessionId?: string;
      currentSessionLabel?: string;
      targetSessionId?: string;
      targetSessionLabel?: string;
      metadata?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      executionId?: string;
      rootExecutionId?: string;
    },
    nowMs: number = Date.now(),
  ) {
    return this.orchestrationState.setClarificationPendingAction(userId, channel, surfaceId, input, nowMs);
  }

  private setApprovalFollowUp(approvalId: string, copy: ApprovalFollowUpCopy): void {
    this.approvalState.setApprovalFollowUp(approvalId, copy);
  }

  private clearApprovalFollowUp(approvalId: string): void {
    this.approvalState.clearApprovalFollowUp(approvalId);
  }

  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null {
    return this.approvalState.takeApprovalFollowUp(approvalId, decision);
  }

  formatApprovalDecisionResultResponse(
    pendingAction: PendingActionRecord | null,
    approvalResult?: ToolApprovalDecisionResult,
    scope?: {
      userId: string;
      channel: string;
      surfaceId?: string;
    },
  ): { content: string; metadata?: Record<string, unknown> } | null {
    if (!pendingAction) return null;
    const response = this.formatResolvedApprovalResultResponse(pendingAction, approvalResult);
    if (!response) return null;
    return this.normalizeContinuationResponse(
      response,
      scope?.userId ?? pendingAction.scope.userId,
      scope?.channel ?? pendingAction.scope.channel,
      scope?.surfaceId ?? pendingAction.scope.surfaceId,
    );
  }

  syncPendingApprovalsFromExecutorForScope(args: {
    userId: string;
    channel: string;
    surfaceId?: string;
  }): void {
    this.syncPendingApprovalsFromExecutor(
      args.userId,
      args.channel,
      args.userId,
      args.channel,
      args.surfaceId,
    );
  }

  resetPendingState(args: {
    userId: string;
    channel: string;
    surfaceId?: string;
    approvalIds?: string[];
  }): void {
    const approvalIds = new Set((args.approvalIds ?? []).map((id) => id.trim()).filter(Boolean));
    for (const approvalId of approvalIds) {
      this.clearApprovalFollowUp(approvalId);
    }
  }

  async continuePendingActionAfterApproval(
    pendingAction: PendingActionRecord | null,
    approvalId: string,
    decision: 'approved' | 'denied',
    approvalResult?: ToolApprovalDecisionResult,
    options?: {
      resumeStoredExecutionGraphPendingAction?: (
        pendingAction: PendingActionRecord,
        options: {
          approvalId: string;
          approvalResult: ToolApprovalDecisionResult;
        },
      ) => Promise<{ content: string; metadata?: Record<string, unknown> } | null>;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return continuePendingActionAfterApprovalHelper({
      pendingAction,
      approvalId,
      decision,
      approvalResult,
      stateAgentId: this.stateAgentId,
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
      resumeStoredExecutionGraphPendingAction: (action, nextOptions) => this.resumeStoredExecutionGraphPendingAction(
        action,
        nextOptions,
        options?.resumeStoredExecutionGraphPendingAction,
      ),
      normalizeApprovalContinuationResponse: (response, userId, channel, surfaceId) => this.normalizeContinuationResponse(
        response,
        userId,
        channel,
        surfaceId,
      ),
      withCurrentPendingActionMetadata: (metadata, userId, channel, surfaceId) => this.withCurrentPendingActionMetadata(
        metadata,
        userId,
        channel,
        surfaceId,
      ),
    });
  }

  private syncPendingApprovalsFromExecutor(
    sourceUserId: string,
    sourceChannel: string,
    targetUserId: string,
    targetChannel: string,
    surfaceId?: string,
    originalUserContent: string = '',
  ): void {
    syncPendingApprovalsFromExecutorHelper({
      tools: this.tools,
      sourceUserId,
      sourceChannel,
      targetUserId,
      targetChannel,
      surfaceId,
      originalUserContent,
      setPendingApprovals: (userKey, ids, nextSurfaceId, nowMs) => this.setPendingApprovals(userKey, ids, nextSurfaceId, nowMs),
      getPendingApprovalAction: (userId, channel, nextSurfaceId, nowMs) => this.getPendingApprovalAction(userId, channel, nextSurfaceId, nowMs),
      updatePendingAction: (actionId, patch, nowMs) => this.updatePendingAction(actionId, patch, nowMs),
    });
  }

  private resolveApprovalTargets(
    input: string,
    pendingIds: string[],
  ): { ids: string[]; errors: string[] } {
    return this.approvalState.resolveApprovalTargets(input, pendingIds);
  }

  private formatPendingApprovalPrompt(
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string }>,
  ): string {
    return this.approvalState.formatPendingApprovalPrompt(ids, summaries);
  }

  private formatResolvedApprovalResultResponse(
    pendingAction: PendingActionRecord,
    approvalResult?: ToolApprovalDecisionResult,
  ): { content: string; metadata?: Record<string, unknown> } | null {
    const codingBackendResult = formatCodingBackendApprovalResult(approvalResult);
    if (codingBackendResult) return codingBackendResult;

    const secondBrainDescriptor = readSecondBrainMutationApprovalDescriptor(pendingAction.intent.entities);
    if (!secondBrainDescriptor || !approvalResult?.job?.toolName?.startsWith('second_brain_')) {
      return null;
    }
    if (!approvalResult.success || approvalResult.executionSucceeded === false || approvalResult.result?.success === false) {
      const errorMessage = toString(approvalResult.result?.error)
        || toString(approvalResult.result?.message)
        || toString(approvalResult.message)
        || 'Second Brain update failed.';
      return { content: `I couldn't complete the local Second Brain update: ${errorMessage}` };
    }

    const focusState = readSecondBrainFocusContinuationState(
      this.getContinuityThread(pendingAction.scope.userId),
    );
    return buildDirectSecondBrainSuccessResponse(
      secondBrainDescriptor,
      approvalResult.result?.output,
      focusState,
    );
  }

  private async tryRepairGenericIntentGatewayPlanWithFrontier(input: {
    message: UserMessage;
    ctx: AgentContext;
    gatewayInput: Parameters<IntentGateway['classify']>[0];
    current: IntentGatewayRecord;
  }): Promise<{
    attempted: boolean;
    adopted: boolean;
    providerOrder?: string[];
    record?: IntentGatewayRecord;
  } | null> {
    if (!this.fallbackChain) {
      return {
        attempted: false,
        adopted: false,
      };
    }
    const selectedProfile = readSelectedExecutionProfileMetadata(input.message.metadata);
    const config = this.readConfig?.();
    if (!config) {
      return {
        attempted: false,
        adopted: false,
      };
    }
    const providerOrder = buildFrontierIntentPlanRepairProviderOrder({
      config,
      currentProviderName: input.ctx.llm?.name,
      fallbackProviderOrder: selectedProfile?.fallbackProviderOrder,
      selectedProviderTier: selectedProfile?.providerTier,
      forcedProviderName: selectedProfile?.selectionSource === 'request_override'
        ? selectedProfile.providerName
        : null,
    });
    return tryRepairGenericIntentGatewayPlan({
      current: input.current,
      sourceContent: stripLeadingContextPrefix(input.message.content),
      candidates: (providerOrder ?? []).map((providerName) => ({
        providerName,
        classify: () => this.intentGateway.classify(
          input.gatewayInput,
          (messages, options) => this.chatWithFallback(
            input.ctx,
            messages,
            { ...options, signal: input.message.abortSignal },
            [providerName],
          ),
        ),
      })),
      onError: (err, providerName) => {
        log.warn({
          agentId: this.id,
          providerName,
          err: err instanceof Error ? err.message : String(err),
        }, 'Frontier intent plan repair provider failed');
      },
    });
  }

  private async classifyIntentGateway(
    message: UserMessage,
    ctx: AgentContext,
    options?: {
      recentHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
      pendingAction?: PendingActionRecord | null;
      continuityThread?: ContinuityThreadRecord | null;
    },
  ): Promise<IntentGatewayRecord | null> {
    const preRouted = readPreRoutedIntentGatewayMetadata(message.metadata);
    if (shouldReusePreRoutedIntentGateway(preRouted)) {
      const enrichedPreRouted = enrichIntentGatewayRecordWithContentPlan(
        preRouted,
        stripLeadingContextPrefix(message.content),
      ) ?? preRouted;
      this.recordIntentRoutingTrace('gateway_classified', {
        message,
        ...(options && Object.prototype.hasOwnProperty.call(options, 'continuityThread')
          ? { continuityThread: options.continuityThread ?? null }
          : {}),
        details: {
          source: 'pre_routed',
          mode: enrichedPreRouted.mode,
          available: enrichedPreRouted.available,
          promptProfile: enrichedPreRouted.promptProfile,
          route: enrichedPreRouted.decision.route,
          confidence: enrichedPreRouted.decision.confidence,
          operation: enrichedPreRouted.decision.operation,
          routeSource: enrichedPreRouted.decision.provenance?.route,
          operationSource: enrichedPreRouted.decision.provenance?.operation,
          turnRelation: enrichedPreRouted.decision.turnRelation,
          resolution: enrichedPreRouted.decision.resolution,
          missingFields: enrichedPreRouted.decision.missingFields,
          simpleVsComplex: enrichedPreRouted.decision.simpleVsComplex,
          plannedStepKinds: enrichedPreRouted.decision.plannedSteps?.map((step) => step.kind),
          entitySources: enrichedPreRouted.decision.provenance?.entities,
          emailProvider: enrichedPreRouted.decision.entities.emailProvider,
          codingBackend: enrichedPreRouted.decision.entities.codingBackend,
          latencyMs: enrichedPreRouted.latencyMs,
          model: enrichedPreRouted.model,
          rawResponsePreview: enrichedPreRouted.rawResponsePreview,
        },
      });
      return enrichedPreRouted;
    }
    if (!ctx.llm) return preRouted ?? null;
    const gatewayContext = filterIntentGatewayClassificationContextHelper({
      content: message.content,
      recentHistory: options?.recentHistory,
      pendingAction: options?.pendingAction ?? null,
      continuityThread: options?.continuityThread ?? null,
    });
    const gatewayInput = {
      content: stripLeadingContextPrefix(message.content),
      channel: message.channel,
      recentHistory: gatewayContext.recentHistory,
      pendingAction: gatewayContext.pendingAction
        ? summarizePendingActionForGateway(gatewayContext.pendingAction)
        : null,
      continuity: summarizeContinuityThreadForGateway(gatewayContext.continuityThread),
      enabledManagedProviders: this.enabledManagedProviders ? [...this.enabledManagedProviders] : [],
      availableCodingBackends: this.tools?.listEnabledCodingBackends?.() ?? [],
      configuredSearchSources: buildIntentGatewaySearchSourceSummaries(this.readConfig?.()),
    };
    const fallbackProviderOrder = readSelectedExecutionProfileMetadata(message.metadata)?.fallbackProviderOrder;
    const classified = await this.intentGateway.classify(
      gatewayInput,
      (messages, options) => this.chatWithFallback(
        ctx,
        messages,
        { ...options, signal: message.abortSignal },
        fallbackProviderOrder,
      ),
    );
    let enrichedClassified = enrichIntentGatewayRecordWithContentPlan(
      classified,
      stripLeadingContextPrefix(message.content),
    );
    const semanticPlanRepair = enrichedClassified
      ? await this.tryRepairGenericIntentGatewayPlanWithFrontier({
          message,
          ctx,
          gatewayInput,
          current: enrichedClassified,
        })
      : null;
    if (semanticPlanRepair?.record) {
      enrichedClassified = semanticPlanRepair.record;
    }
    this.recordIntentRoutingTrace('gateway_classified', {
      message,
      continuityThread: gatewayContext.continuityThread,
      details: enrichedClassified
        ? {
            source: 'agent',
            mode: enrichedClassified.mode,
            available: enrichedClassified.available,
            promptProfile: enrichedClassified.promptProfile,
            route: enrichedClassified.decision.route,
            confidence: enrichedClassified.decision.confidence,
            operation: enrichedClassified.decision.operation,
            routeSource: enrichedClassified.decision.provenance?.route,
            operationSource: enrichedClassified.decision.provenance?.operation,
            turnRelation: enrichedClassified.decision.turnRelation,
            resolution: enrichedClassified.decision.resolution,
            missingFields: enrichedClassified.decision.missingFields,
            simpleVsComplex: enrichedClassified.decision.simpleVsComplex,
            plannedStepKinds: enrichedClassified.decision.plannedSteps?.map((step) => step.kind),
            plannedStepCategories: enrichedClassified.decision.plannedSteps
              ?.map((step) => step.expectedToolCategories)
              .filter((categories): categories is string[] => Array.isArray(categories)),
            entitySources: enrichedClassified.decision.provenance?.entities,
            emailProvider: enrichedClassified.decision.entities.emailProvider,
            codingBackend: enrichedClassified.decision.entities.codingBackend,
            continuityKey: gatewayContext.continuityThread?.continuityKey,
            pendingActionContextSuppressed: gatewayContext.contextSuppressed,
            pendingActionContextSuppressionReason: gatewayContext.suppressionReason,
            semanticPlanRepairAttempted: semanticPlanRepair?.attempted ?? false,
            semanticPlanRepairAdopted: semanticPlanRepair?.adopted ?? false,
            semanticPlanRepairProviderOrder: semanticPlanRepair?.providerOrder,
            latencyMs: enrichedClassified.latencyMs,
            model: enrichedClassified.model,
            rawResponsePreview: enrichedClassified.rawResponsePreview,
          }
        : {
            source: 'agent',
            available: false,
            pendingActionContextSuppressed: gatewayContext.contextSuppressed,
            pendingActionContextSuppressionReason: gatewayContext.suppressionReason,
          },
    });
    return enrichedClassified;
  }

  private logIntentGateway(
    candidate: DirectIntentRoutingCandidate,
    message: UserMessage,
    intentGateway: IntentGatewayRecord | null,
    handled: boolean,
  ): void {
    if (!intentGateway) return;
    const expectedRoutes = this.expectedIntentGatewayRoutes(candidate);
    const mismatch = handled && !expectedRoutes.has(intentGateway.decision.route);
    log.info({
      agentId: this.id,
      messageId: message.id,
      channel: message.channel,
      candidate,
      handled,
      mismatch,
      route: intentGateway.decision.route,
      confidence: intentGateway.decision.confidence,
      operation: intentGateway.decision.operation,
      turnRelation: intentGateway.decision.turnRelation,
      resolution: intentGateway.decision.resolution,
      missingFields: intentGateway.decision.missingFields,
      summary: intentGateway.decision.summary,
      latencyMs: intentGateway.latencyMs,
      model: intentGateway.model,
    }, 'Intent gateway classification');
  }

  private expectedIntentGatewayRoutes(
    candidate: DirectIntentRoutingCandidate,
  ): Set<IntentGatewayRoute> {
    switch (candidate) {
      case 'coding_backend':
        return new Set(['coding_task']);
      case 'coding_session_control':
        return new Set(['coding_session_control', 'coding_task', 'general_assistant']);
      case 'filesystem':
        return new Set(['filesystem_task', 'search_task']);
      case 'memory_write':
      case 'memory_read':
        return new Set(['memory_task']);
      case 'scheduled_email_automation':
        return new Set(['automation_authoring']);
      case 'automation':
        return new Set(['automation_authoring', 'automation_control']);
      case 'automation_control':
        return new Set(['automation_control', 'ui_control']);
      case 'automation_output':
        return new Set(['automation_output_task']);
      case 'workspace_write':
        return new Set(['workspace_task', 'email_task']);
      case 'workspace_read':
        return new Set(['workspace_task', 'email_task']);
      case 'browser':
        return new Set(['browser_task']);
      case 'web_search':
        return new Set(['search_task']);
      case 'security_guardrail':
        return new Set(['security_task']);
      default:
        return new Set(['unknown']);
    }
  }

  private resolvePendingActionContinuationContent(
    content: string,
    pendingAction: PendingActionRecord | null,
    currentCodeSessionId?: string,
  ): string | null {
    return resolvePendingActionContinuationContentHelper(
      content,
      pendingAction,
      currentCodeSessionId,
    );
  }

  private resolveRetryAfterFailureContinuationContent(
    content: string,
    continuityThread: ContinuityThreadRecord | null | undefined,
    activeExecution: ExecutionRecord | null | undefined,
  ): string | null {
    return resolveRetryAfterFailureContinuationContentHelper({
      content,
      continuityThread,
      activeExecution,
    });
  }

  private async resumeStoredExecutionGraphPendingAction(
    pendingAction: PendingActionRecord,
    options: { approvalId: string; approvalResult: ToolApprovalDecisionResult },
    fallback?: (
      pendingAction: PendingActionRecord,
      options: { approvalId: string; approvalResult: ToolApprovalDecisionResult },
    ) => Promise<{ content: string; metadata?: Record<string, unknown> } | null>,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.executionGraphStore) return null;
    const graphResume = startChatContinuationGraphApprovalResume({
      graphStore: this.executionGraphStore,
      runTimeline: this.runTimeline,
      pendingAction,
      approvalId: options.approvalId,
      approvalResult: options.approvalResult,
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
    });
    if (!graphResume) {
      return fallback ? fallback(pendingAction, options) : null;
    }
    const chatResume = graphResume.resume;
    if (!graphResume.approved) {
      return graphResume.deniedResponse ?? null;
    }

    const result = await executeChatContinuationPayload({
      pendingAction,
      resume: chatResume,
      approvalId: options.approvalId,
      approvalResult: options.approvalResult,
      createRequestId: () => randomUUID(),
      executeStoredFilesystemSave: (request) => this.executeStoredFilesystemSave(request),
      executeStoredAutomationAuthoring: (action, continuation, approvalResult) => this.executeStoredAutomationAuthoring(
        action,
        continuation,
        approvalResult,
      ),
      resumeStoredToolLoopContinuation: (action, continuation, resumeOptions) => this.resumeStoredToolLoopContinuation(
        action,
        continuation,
        resumeOptions,
      ),
    });
    const response = typeof result === 'string' ? { content: result } : result;
    return completeChatContinuationGraphResume({
      graphStore: this.executionGraphStore,
      runTimeline: this.runTimeline,
      resume: chatResume,
      response,
    });
  }

  private normalizeContinuationResponse(
    response: { content: string; metadata?: Record<string, unknown> },
    userId: string,
    channel: string,
    surfaceId?: string,
  ): { content: string; metadata?: Record<string, unknown> } {
    return normalizeContinuationResponseHelper({
      response,
      userId,
      channel,
      surfaceId,
      updateDirectContinuationState: (nextUserId, nextChannel, nextSurfaceId, continuationState) => this.updateDirectContinuationState(
        nextUserId,
        nextChannel,
        nextSurfaceId,
        continuationState,
      ),
      withCurrentPendingActionMetadata: (metadata, nextUserId, nextChannel, nextSurfaceId) => this.withCurrentPendingActionMetadata(
        metadata,
        nextUserId,
        nextChannel,
        nextSurfaceId,
      ),
    });
  }

  private resolveStoredToolLoopExecutionProfile(
    ctx: AgentContext,
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
    decision?: IntentGatewayDecision | null,
  ): SelectedExecutionProfile | undefined {
    if (selectedExecutionProfile) {
      return selectedExecutionProfile;
    }
    const providerName = ctx.llm?.name?.trim();
    if (!providerName) {
      return undefined;
    }
    const providerOrder = this.fallbackChain?.getProviderOrder() ?? [];
    const providerProfileName = providerOrder[0]?.trim() || providerName;
    const providerLocality = getProviderLocality(providerName)
      ?? getProviderLocalityFromName(providerName)
      ?? 'local';
    const providerTier = getProviderTier(providerName)
      ?? (providerLocality === 'local' ? 'local' : 'managed_cloud');
    return {
      id: providerTier === 'frontier'
        ? 'frontier_deep'
        : providerTier === 'managed_cloud'
          ? 'managed_cloud_tool'
          : 'local_tool',
      providerName: providerProfileName,
      providerType: providerName,
      providerLocality,
      providerTier,
      requestedTier: providerLocality === 'local' ? 'local' : 'external',
      preferredAnswerPath: decision?.preferredAnswerPath ?? 'tool_loop',
      expectedContextPressure: decision?.expectedContextPressure ?? 'medium',
      contextBudget: this.contextBudget,
      toolContextMode: 'standard',
      maxAdditionalSections: 3,
      maxRuntimeNotices: 6,
      fallbackProviderOrder: providerOrder.filter((candidate) => candidate !== providerProfileName),
      reason: 'Captured from the live tool-loop context for approval resume.',
    };
  }

  private buildStoredToolLoopChatFn(input: {
    ctx?: AgentContext;
    selectedExecutionProfile?: SelectedExecutionProfile;
    abortSignal?: AbortSignal;
  }): {
    chatFn: (msgs: ChatMessage[], opts?: import('./llm/types.js').ChatOptions) => Promise<import('./llm/types.js').ChatResponse>;
    providerLocality: 'local' | 'external';
  } | null {
    return buildStoredToolLoopChatRunnerHelper({
      ...input,
      resolveProviderLocality: (ctx) => this.resolveToolResultProviderKind(ctx),
      chatWithFallback: (ctx, messages, options, fallbackProviderOrder) => this.chatWithFallback(
        ctx,
        messages,
        options,
        fallbackProviderOrder,
      ),
      ...(this.fallbackChain
        ? {
            chatWithProviderOrder: (
              providerOrder: string[],
              messages: ChatMessage[],
              options?: import('./llm/types.js').ChatOptions,
            ) => this.fallbackChain!.chatWithProviderOrder(providerOrder, messages, options),
          }
        : {}),
    });
  }

  private async resumeStoredToolLoopContinuation(
    pendingAction: PendingActionRecord,
    continuation: import('./runtime/chat-agent/tool-loop-continuation.js').ToolLoopContinuationPayload,
    options?: {
      approvalId?: string;
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
      ctx?: AgentContext;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return resumeStoredToolLoopContinuationHelper({
      pendingAction,
      continuation,
      options,
      agentId: this.id,
      tools: this.tools,
      secondBrainService: this.secondBrainService,
      maxToolRounds: this.maxToolRounds,
      contextBudget: this.contextBudget,
      buildChatRunner: (input) => this.buildStoredToolLoopChatFn(input),
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
      sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
        toolName,
        result,
        providerKind,
      ),
      lacksUsableAssistantContent: (content) => this.lacksUsableAssistantContent(content),
      setChatContinuationGraphPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setChatContinuationGraphPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
  }

  private async executeStoredAutomationAuthoring(
    pendingAction: PendingActionRecord,
    resume: import('./runtime/chat-agent/chat-continuation-payloads.js').AutomationAuthoringContinuationPayload,
    approvalResult?: ToolApprovalDecisionResult,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    if (!approvalResult || !approvalResult.approved) {
      return { content: 'The automation authoring remediation was not approved.' };
    }

    return executeStoredAutomationAuthoringHelper({
      request: buildStoredAutomationAuthoringInput({
        originalUserContent: resume.originalUserContent,
        userKey: `${pendingAction.scope.userId}:${pendingAction.scope.channel}`,
        userId: pendingAction.scope.userId,
        channel: pendingAction.scope.channel,
        surfaceId: pendingAction.scope.surfaceId,
        principalId: resume.principalId ?? pendingAction.scope.userId,
        principalRole: resume.principalRole,
        requestId: randomUUID(),
        ...(resume.codeContext ? { codeContext: { ...resume.codeContext } } : {}),
        allowRemediation: resume.allowRemediation,
      }),
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      setChatContinuationGraphPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setChatContinuationGraphPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
  }

  private async executeStoredFilesystemSave(input: {
    targetPath: string;
    content: string;
    originalUserContent: string;
    userKey: string;
    userId: string;
    channel: string;
    surfaceId?: string;
    principalId?: string;
    principalRole?: PrincipalRole;
    requestId: string;
    agentCheckAction?: AgentContext['checkAction'];
    codeContext?: { workspaceRoot: string; sessionId?: string };
    allowPathRemediation: boolean;
  }): Promise<string | { content: string; metadata?: Record<string, unknown> }> {
    return executeStoredFilesystemSaveHelper({
      request: input,
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      getPendingApprovals: (userKey, surfaceId, nowMs) => this.getPendingApprovals(userKey, surfaceId, nowMs),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      setChatContinuationGraphPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setChatContinuationGraphPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(result, fallbackContent),
    });
  }

}

}
