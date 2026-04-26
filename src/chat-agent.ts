import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { BaseAgent } from './agent/agent.js';
import type { AgentContext, AgentResponse, UserMessage } from './agent/types.js';
import type { ChatMessage, LLMProvider } from './llm/types.js';
import { composeGuardianSystemPrompt } from './prompts/guardian-core.js';
import { composeCodeSessionSystemPrompt } from './prompts/code-session-core.js';
import {
  buildCodeSessionWorkspaceAwarenessQuery,
  compactMessagesIfOverBudget,
  compactQuarantinedToolResult,
  formatToolThreatWarnings,
  formatToolResultForLLM,
  getCodeSessionPromptRelativePath,
  isRecord,
  readCodeRequestMetadata,
  sameCodeWorkspaceWorkingSet,
  shouldRefreshCodeSessionFocus,
  shouldRefreshCodeSessionWorkingSet,
  stripLeadingContextPrefix,
  summarizeCodeSessionFocus,
  summarizeToolRoundStatusMessage,
  toBoolean,
  toLLMToolDef,
  toString,
} from './chat-agent-helpers.js';
import { withTaintedContentSystemPrompt } from './util/tainted-content.js';
import type { ContextCompactionResult } from './util/context-budget.js';
import {
  lacksUsableAssistantContent as _lacksUsableAssistantContent,
  looksLikeOngoingWorkResponse as _looksLikeOngoingWorkResponse,
} from './util/assistant-response-shape.js';
import {
  buildAnswerFirstSkillFallbackResponse,
  buildAnswerFirstSkillCorrectionPrompt,
  isAnswerFirstSkillResponseSufficient as isAnswerFirstSkillResponseSufficientForSkills,
  shouldUseAnswerFirstForSkills,
} from './util/answer-first-skills.js';
import {
  isDirectMemorySaveRequest,
  shouldAllowModelMemoryMutation,
} from './util/memory-intent.js';
import type { ConversationKey } from './runtime/conversation.js';
import { ConversationService } from './runtime/conversation.js';
import type { CodeSessionRecord, ResolvedCodeSessionContext } from './runtime/code-sessions.js';
import { CodeSessionStore } from './runtime/code-sessions.js';
import { resolveConversationSurfaceId } from './runtime/channel-surface-ids.js';
import {
  dispatchDirectIntentCandidates,
} from './runtime/chat-agent/direct-intent-dispatch.js';
import {
  formatCodingBackendApprovalResult,
} from './runtime/chat-agent/coding-backend-approval-result.js';
import {
  tryDirectCodingBackendDelegation as tryDirectCodingBackendDelegationHelper,
} from './runtime/chat-agent/direct-coding-backend.js';
import {
  executeToolLoopRound,
} from './runtime/chat-agent/tool-loop-round.js';
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
  resolveDirectIntentRoutingCandidates,
  shouldAllowBoundedDegradedMemorySaveFallback,
  type DirectIntentRoutingCandidate,
} from './runtime/direct-intent-routing.js';
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
  buildFrontierIntentPlanRepairProviderOrder,
  tryRepairGenericIntentGatewayPlan,
} from './runtime/intent/gateway-plan-repair.js';
import { buildContinuityAwareHistory } from './runtime/continuity-history.js';
import { shouldAttachCodeSessionForRequest } from './runtime/code-session-request-scope.js';
import {
  parseWebSearchIntent,
} from './runtime/search-intent.js';
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
  ensureExplicitCodingTaskWorkspaceTarget as ensureExplicitCodingTaskWorkspaceTargetHelper,
  handleCodeSessionAttach as handleCodeSessionAttachHelper,
  tryDirectCodeSessionControlFromGateway as tryDirectCodeSessionControlFromGatewayHelper,
} from './runtime/chat-agent/code-session-control.js';
import {
  syncCodeSessionRuntimeState as syncCodeSessionRuntimeStateHelper,
} from './runtime/chat-agent/code-session-runtime-state.js';
import {
  tryDirectRecentToolReport as tryDirectRecentToolReportHelper,
} from './runtime/chat-agent/recent-tool-report.js';
import {
  normalizeFilesystemResumePrincipalRole,
} from './runtime/chat-agent/capability-continuation-resume.js';
import {
  buildDirectSecondBrainClarificationResponse as buildDirectSecondBrainClarificationResponseHelper,
  buildDirectSecondBrainMutationSuccessResponse as buildDirectSecondBrainMutationSuccessResponseHelper,
  executeDirectSecondBrainMutation as executeDirectSecondBrainMutationHelper,
  readSecondBrainMutationApprovalDescriptor,
  type DirectSecondBrainMutationAction,
  type DirectSecondBrainMutationItemType,
  type DirectSecondBrainMutationToolName,
} from './runtime/chat-agent/direct-second-brain-mutation.js';
import {
  type DirectAutomationDeps,
  tryDirectAutomationAuthoring as tryDirectAutomationAuthoringHelper,
  tryDirectAutomationControl as tryDirectAutomationControlHelper,
  tryDirectAutomationOutput as tryDirectAutomationOutputHelper,
  tryDirectBrowserAutomation as tryDirectBrowserAutomationHelper,
} from './runtime/chat-agent/direct-automation.js';
import {
  tryDirectScheduledEmailAutomation as tryDirectScheduledEmailAutomationHelper,
} from './runtime/chat-agent/direct-scheduled-email-automation.js';
import {
  buildStoredAutomationAuthoringInput,
  executeStoredAutomationAuthoring as executeStoredAutomationAuthoringHelper,
} from './runtime/chat-agent/automation-authoring-resume.js';
import {
  tryDirectSecondBrainRead as tryDirectSecondBrainReadHelper,
} from './runtime/chat-agent/direct-second-brain-read.js';
import {
  tryDirectSecondBrainRoutineWrite as tryDirectSecondBrainRoutineWriteHelper,
} from './runtime/chat-agent/direct-second-brain-routine-write.js';
import {
  tryDirectSecondBrainWrite as tryDirectSecondBrainWriteHelper,
} from './runtime/chat-agent/direct-second-brain-write.js';
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
  tryDirectMemoryRead as tryDirectMemoryReadHelper,
  tryDirectMemorySave as tryDirectMemorySaveHelper,
} from './runtime/chat-agent/direct-memory.js';
import {
  tryDirectFilesystemIntent as tryDirectFilesystemIntentHelper,
} from './runtime/chat-agent/direct-route-runtime.js';
import {
  executeStoredFilesystemSave as executeStoredFilesystemSaveHelper,
} from './runtime/chat-agent/filesystem-save-resume.js';
import {
  emitChatContinuationGraphResumeEvent,
  readChatContinuationGraphResume,
  recordChatContinuationGraphApproval,
  type ChatContinuationPayload,
} from './runtime/chat-agent/chat-continuation-graph.js';
import {
  buildBlockedToolLoopPendingApprovalContinuation,
  buildStoredToolLoopChatRunner as buildStoredToolLoopChatRunnerHelper,
  finalizeToolLoopPendingApprovals as finalizeToolLoopPendingApprovalsHelper,
  recoverDirectAnswerAfterTools as recoverDirectAnswerAfterToolsHelper,
  resumeStoredToolLoopContinuation as resumeStoredToolLoopContinuationHelper,
} from './runtime/chat-agent/tool-loop-runtime.js';
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
import { readExecutionIdentityMetadata } from './runtime/execution-identity.js';
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
  isPhantomPendingApprovalMessage,
} from './runtime/pending-approval-copy.js';
import {
  getProviderLocalityFromName,
  readResponseSourceMetadata,
  type ResponseSourceMetadata,
} from './runtime/model-routing-ux.js';
import {
  chatWithAlternateProvider as chatWithAlternateProviderHelper,
  chatWithFallback as chatWithFallbackHelper,
  chatWithRoutingMetadata as chatWithRoutingMetadataHelper,
} from './runtime/chat-agent/provider-fallback.js';
import { normalizeToolCallsForExecution, recoverToolCallsFromStructuredText } from './util/structured-json.js';
import {
  buildDirectHandlerResponseSource,
  buildRoutineSemanticHints,
  buildSecondBrainFocusMetadata,
  buildSecondBrainFocusRemovalMetadata,
  buildToolSafeRoutineTrigger,
  collapseWhitespaceForSecondBrainParsing,
  deriveRoutineTimingKind,
  extractCustomSecondBrainRoutineCreate,
  extractEmailAddressFromText,
  extractExplicitNamedSecondBrainTitle,
  extractNamedSecondBrainTitle,
  extractPhoneNumberFromText,
  extractQuotedLabeledValue,
  extractQuotedPhrase,
  extractRetitledSecondBrainTitle,
  extractRoutineDeliveryDefaults,
  extractRoutineDueWithinHours,
  extractRoutineEnabledState,
  extractRoutineFocusQuery,
  extractRoutineIncludeOverdue,
  extractRoutineLookaheadMinutes,
  extractRoutineScheduleTiming,
  extractRoutineTopicWatchQuery,
  extractSecondBrainFallbackPersonName,
  extractSecondBrainPersonRelationship,
  extractSecondBrainRoutingBias,
  extractSecondBrainTags,
  extractSecondBrainTaskPriority,
  extractSecondBrainTaskStatus,
  extractSecondBrainTextBody,
  extractUrlFromText,
  findMatchingRoutineForCreate,
  formatBriefKindLabelForUser,
  getSecondBrainFocusEntry,
  isSecondBrainFocusItemType,
  normalizeRoutineNameForMatch,
  normalizeRoutineQueryTokens,
  normalizeRoutineSearchTokens,
  normalizeRoutineTemplateIdForMatch,
  normalizeSecondBrainInlineFieldValue,
  readSecondBrainFocusContinuationState,
  resolveDirectSecondBrainReadQuery,
  routineDeliveryChannels,
  routineDueWithinHours,
  routineIncludeOverdue,
  routineTopicQuery,
  summarizeRoutineTimingForUser,
  type SecondBrainFocusContinuationPayload,
} from './runtime/chat-agent/direct-intent-helpers.js';
import {
  type DirectMailboxDeps,
  tryDirectGoogleWorkspaceRead as tryDirectGoogleWorkspaceReadHelper,
  tryDirectGoogleWorkspaceWrite as tryDirectGoogleWorkspaceWriteHelper,
} from './runtime/chat-agent/direct-mailbox-runtime.js';

export interface ChatAgentClassDeps {
  log: Logger;
}

export interface ChatAgentPublicApi extends BaseAgent {
  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null;
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
  candidate: DirectIntentShadowCandidate;
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
  candidate: DirectIntentShadowCandidate;
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

type DirectIntentShadowCandidate =
  | 'personal_assistant'
  | 'provider_read'
  | 'filesystem'
  | 'memory_write'
  | 'memory_read'
  | 'coding_backend'
  | 'coding_session_control'
  | 'scheduled_email_automation'
  | 'automation'
  | 'automation_control'
  | 'automation_output'
  | 'workspace_write'
  | 'workspace_read'
  | 'browser'
  | 'complex_planning_task'
  | 'web_search';

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
    },
  ): void {
    const continuity = input.message?.userId
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

  private tryDirectToolInventoryResponse(content: string): string | null {
    if (!/\bwhat tools do you have available\b|\bwhich tools do you have available\b|\bwhat tools can you use\b|\bwhich tools can you use\b/i.test(content)) {
      return null;
    }
    if (!this.tools?.isEnabled()) return null;
    const definitions = this.tools.listToolDefinitions();
    if (definitions.length === 0) {
      return 'No assistant-visible tools are currently available on this surface.';
    }

    const categoryLabels: Record<string, string> = {
      coding: 'Coding',
      filesystem: 'Filesystem',
      browser: 'Browser',
      search: 'Search',
      memory: 'Memory',
      shell: 'Shell',
      automation: 'Automation',
      workspace: 'Workspace',
      system: 'System',
      security: 'Security',
      mcp: 'MCP',
      google_workspace: 'Google Workspace',
      microsoft_365: 'Microsoft 365',
    };
    const grouped = definitions.reduce<Map<string, string[]>>((acc, definition) => {
      const category = definition.category ?? 'other';
      const names = acc.get(category) ?? [];
      names.push(definition.name);
      acc.set(category, names);
      return acc;
    }, new Map<string, string[]>());

    const lines = ['Available tools on this surface right now:'];
    for (const [category, names] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- ${categoryLabels[category] ?? category}: ${names.sort((a, b) => a.localeCompare(b)).join(', ')}`);
    }
    lines.push('If a coding session is attached, repo-local coding actions stay anchored to that workspace, but broader Guardian tools remain available from this chat surface.');
    return lines.join('\n');
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

  private tryDirectAutomationCapabilitiesResponse(content: string): string | null {
    if (!/\b(?:what|which)\b[\s\S]*\b(?:automate|automation|automations)\b/i.test(content)
      && !/\bwhat can you automate\b/i.test(content)) {
      return null;
    }
    return [
      'Guardian can automate three main shapes:',
      '- step workflows: fixed deterministic tool steps that can run manually or on a schedule',
      '- assistant automations: scheduled or manual prompt-driven tasks such as summaries, reports, or triage runs',
      '- standalone tool tasks: single-tool jobs behind the same approval and policy controls',
      '',
      'It can also inspect outputs, run saved automations, enable or disable them, and delete them.',
      'If you want to create one, describe the goal, whether it should be manual or scheduled, and any fixed steps or browser actions it must follow.',
    ].join('\n');
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

  private shouldPreferAnswerFirstForSkills(
    skills: readonly ResolvedSkill[],
    originalRequest?: string,
  ): boolean {
    return shouldUseAnswerFirstForSkills(skills, originalRequest);
  }

  private isAnswerFirstSkillResponseSufficient(
    skills: readonly ResolvedSkill[],
    content: string,
    originalRequest?: string,
  ): boolean {
    return isAnswerFirstSkillResponseSufficientForSkills(skills, content, originalRequest);
  }

  private async tryRecoverDirectAnswerAfterTools(
    llmMessages: ChatMessage[],
    chatFn: (msgs: ChatMessage[], opts?: import('./llm/types.js').ChatOptions) => Promise<import('./llm/types.js').ChatResponse>,
    currentContextTrustLevel: import('./tools/types.js').ContentTrustLevel,
    currentTaintReasons: Set<string>,
  ): Promise<string> {
    return recoverDirectAnswerAfterToolsHelper({
      llmMessages,
      chatFn,
      currentContextTrustLevel,
      currentTaintReasons,
        lacksUsableAssistantContent: (content) => this.lacksUsableAssistantContent(content),
        looksLikeOngoingWorkResponse: (content) => this.looksLikeOngoingWorkResponse(content),
    });
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
    const conversationUserId = resolvedCodeSession?.session.conversationUserId ?? effectiveMessage.userId;
    const conversationChannel = resolvedCodeSession?.session.conversationChannel ?? effectiveMessage.channel;
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
    const continuitySummaryForHistory = summarizeContinuityThreadForGateway(continuityThread);
    const priorHistory = buildContinuityAwareHistory({
      conversationService: this.conversationService,
      codeSessionStore: this.codeSessionStore,
      continuityThread,
      currentConversationKey: conversationKey,
      currentUserId: pendingActionUserId,
      currentPrincipalId: effectiveMessage.principalId,
      resolvedCodeSession: resolvedCodeSession?.session ?? null,
      query: buildIntentGatewayHistoryQuery({
        content: stripLeadingContextPrefix(scopedMessage.content),
        continuity: continuitySummaryForHistory,
      }),
    }).history;
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
      resolvedCodeSession?.session,
    );
    const referencedCodeSessionsSection = this.buildReferencedCodeSessionsSection(
      resolvedCodeSession?.session,
      referencedCodeSessions,
    );
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
    const pendingAction = this.getActivePendingAction(pendingActionUserId, pendingActionChannel, pendingActionSurfaceId);
    let activeExecution = this.getActiveExecution({
      userId: pendingActionUserId,
      channel: pendingActionChannel,
      surfaceId: pendingActionSurfaceId,
      continuityThread,
      pendingAction,
      excludeExecutionId: executionIdentity.executionId,
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
          continuityThread,
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
        continuityThread,
      });
      trackResolvedSkillsIfChanged(resolveSkillsForCurrentContext({
        gateway: earlyGateway,
        pendingAction,
        continuityThread,
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
        recordIntentRoutingTrace: (stage, traceInput) => this.recordIntentRoutingTrace(stage, traceInput),
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
      const explicitWorkspaceTarget = await this.ensureExplicitCodingTaskWorkspaceTarget({
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
        continuityThread,
        activeExecution,
      });
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
      if (pendingAction && shouldClearPendingActionAfterTurnHelper(earlyGateway?.decision, pendingAction)) {
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

      const directAutomationCapabilities = allowGeneralShortcut
        ? this.tryDirectAutomationCapabilitiesResponse(routedScopedMessage.content)
        : null;
      if (directAutomationCapabilities) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            directAutomationCapabilities,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return { content: directAutomationCapabilities };
      }

      const directToolInventory = allowGeneralShortcut
        ? this.tryDirectToolInventoryResponse(routedScopedMessage.content)
        : null;
      if (directToolInventory) {
        if (this.conversationService) {
          this.conversationService.recordTurn(
            conversationKey,
            message.content,
            directToolInventory,
          );
        }
        if (resolvedCodeSession) {
          this.syncCodeSessionRuntimeState(resolvedCodeSession.session, conversationUserId, conversationChannel, preResolvedSkills);
        }
        return { content: directToolInventory };
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
        const sessionControlResult = await this.tryDirectCodeSessionControlFromGateway(
          message, ctx, earlyGateway.decision,
        );
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
      continuityThread,
      pendingAction,
      resolvedCodeSession,
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
    const maintainedSummarySource = resolvedCodeSession?.session.workState.compactedSummary?.trim()
      ? 'code_session_compacted_summary'
      : resolvedCodeSession?.session.workState.planSummary?.trim()
        ? 'code_session_plan_summary'
        : resolvedCodeSession?.session.workState.focusSummary?.trim()
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
      continuity: summarizeContinuityThreadForGateway(continuityThread),
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
      continuityThread,
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
      continuity: summarizeContinuityThreadForGateway(continuityThread),
      maintainedSummarySource,
    });
    const buildCompactionContext = (compaction?: ContextCompactionResult) => (
      compaction?.applied ? buildContextCompactionDiagnostics(compaction) : undefined
    );
    const buildResponseSourceMetadata = (input: {
      locality: 'local' | 'external';
      providerName: string;
      response: import('./llm/types.js').ChatResponse;
      usedFallback: boolean;
      notice?: string;
      durationMs?: number;
    }): ResponseSourceMetadata => {
      const actualProviderName = input.providerName.trim();
      const useSelectedExecutionProfile = !!selectedExecutionProfile
        && (
          !actualProviderName
          || actualProviderName === selectedExecutionProfile.providerName
          || actualProviderName === selectedExecutionProfile.providerType
        );
      const providerName = useSelectedExecutionProfile
        ? selectedExecutionProfile.providerType
        : actualProviderName;
      const providerProfileName = useSelectedExecutionProfile
        && selectedExecutionProfile.providerName !== selectedExecutionProfile.providerType
        ? selectedExecutionProfile.providerName
        : undefined;
      return {
        locality: input.locality,
        ...(providerName ? { providerName } : {}),
        ...(providerProfileName ? { providerProfileName } : {}),
        ...((useSelectedExecutionProfile ? selectedExecutionProfile.providerTier : getProviderTier(providerName))
          ? { providerTier: (useSelectedExecutionProfile ? selectedExecutionProfile.providerTier : getProviderTier(providerName)) }
          : {}),
        ...(input.response.model?.trim() ? { model: input.response.model.trim() } : {}),
        usedFallback: input.usedFallback,
        ...(input.notice ? { notice: input.notice } : {}),
        ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
          ? { durationMs: Math.max(0, input.durationMs) }
          : {}),
        ...(input.response.usage
          ? {
              usage: {
                promptTokens: input.response.usage.promptTokens,
                completionTokens: input.response.usage.completionTokens,
                totalTokens: input.response.usage.totalTokens,
                ...(typeof input.response.usage.cacheCreationTokens === 'number'
                  ? { cacheCreationTokens: input.response.usage.cacheCreationTokens }
                  : {}),
                ...(typeof input.response.usage.cacheReadTokens === 'number'
                  ? { cacheReadTokens: input.response.usage.cacheReadTokens }
                  : {}),
              },
            }
          : {}),
      };
    };

    let llmMessages: import('./llm/types.js').ChatMessage[];
    let skipDirectTools = false;
    let enrichedSystemPrompt = this.buildScopedSystemPrompt(resolvedCodeSession, message);
    let activeSkills: ResolvedSkill[] = [];
    let skillPromptMaterial: SkillPromptMaterialResult | undefined;

    activeSkills = preResolvedSkills;
    const promptKnowledge = this.loadPromptKnowledgeBases(resolvedCodeSession, knowledgeBaseQuery);
    if (activeSkills.length > 0) {
      this.trackResolvedSkills(message, 'chat', activeSkills, 'prompt_injected');
      skillPromptMaterial = buildSkillPromptMaterial(
        this.skillRegistry!,
        {
          skills: activeSkills,
          requestText: routedScopedMessage.content,
          ...(earlyGateway?.decision.route ? { route: earlyGateway.decision.route } : {}),
          artifactReferences: this.resolveSkillArtifactReferences(activeSkills, resolvedCodeSession),
        },
        createSkillPromptMaterialCache(),
      );
      this.trackSkillPromptMaterial(message, earlyGateway?.decision.route, skillPromptMaterial);
    }
    const toolContext = this.tools?.getToolContext({
      userId: conversationUserId,
      principalId: message.principalId ?? conversationUserId,
      channel: conversationChannel,
      codeContext: effectiveCodeContext,
      requestText: routedScopedMessage.content,
      ...(selectedExecutionProfile ? { toolContextMode: selectedExecutionProfile.toolContextMode } : {}),
    }) ?? '';
    const runtimeNotices = (this.tools?.getRuntimeNotices() ?? [])
      .slice(0, Math.max(0, selectedExecutionProfile?.maxRuntimeNotices ?? Number.MAX_SAFE_INTEGER));
    const promptAdditionalSections = this.buildPromptAdditionalSections(
      skillPromptMaterial,
      earlyGateway?.decision,
      selectedExecutionProfile,
      referencedCodeSessionsSection ? [referencedCodeSessionsSection] : undefined,
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
      continuityThread,
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
      codeSessionId: resolvedCodeSession?.session.id,
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
    let toolLoopPendingContinuation: import('./runtime/chat-agent/tool-loop-resume.js').ToolLoopResumePayload | undefined;
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
        continuityThread,
      }))
      : null;
    const directIntentRouting = !skipDirectTools
      ? resolveDirectIntentRoutingCandidates(
        directIntent,
        [
          'personal_assistant',
          'provider_read',
          'coding_session_control',
          'coding_backend',
          'filesystem',
          'memory_write',
          'memory_read',
          'scheduled_email_automation',
          'automation',
          'automation_control',
          'automation_output',
          'workspace_write',
          'workspace_read',
          'browser',
          'web_search',
        ],
      )
      : {
        candidates: [] as DirectIntentRoutingCandidate[],
        gatewayDirected: false,
        gatewayUnavailable: false,
      };
    const directBrowserIntent = directIntent?.decision.route === 'browser_task';
    const skipDirectWebSearch = !!resolvedCodeSession
      || !!effectiveCodeContext
      || directBrowserIntent
      || activeSkills.some((skill) => (
        skill.id === 'multi-search-engine'
        || skill.id === 'weather'
        || skill.id === 'blogwatcher'
      ));

    if (!skipDirectTools) {
      this.recordIntentRoutingTrace('direct_candidates_evaluated', {
        message,
        details: {
          gatewayDirected: directIntentRouting.gatewayDirected,
          gatewayUnavailable: directIntentRouting.gatewayUnavailable,
          route: directIntent?.decision.route,
          routeSource: directIntent?.decision.provenance?.route,
          operation: directIntent?.decision.operation,
          operationSource: directIntent?.decision.provenance?.operation,
          codingBackend: directIntent?.decision.entities.codingBackend,
          simpleVsComplex: directIntent?.decision.simpleVsComplex,
          entitySources: directIntent?.decision.provenance?.entities,
          candidates: directIntentRouting.candidates,
          skipDirectWebSearch,
          codeSessionResolved: !!resolvedCodeSession,
          codeSessionId: effectiveCodeContext?.sessionId,
        },
      });
    }
    
    if (!skipDirectTools) {
      const directIntentResponse = await dispatchDirectIntentCandidates({
        candidates: directIntentRouting.candidates,
        handlers: {
          personal_assistant: async () => (
            await this.tryDirectSecondBrainWrite(
              routedScopedMessage,
              ctx,
              pendingActionUserKey,
              directIntent?.decision,
              continuityThread,
            )
          ) ?? this.tryDirectSecondBrainRead(
            routedScopedMessage,
            directIntent?.decision,
            continuityThread,
          ),
          provider_read: () => this.tryDirectProviderRead(
            routedScopedMessage,
            ctx,
            directIntent?.decision,
          ),
          coding_session_control: () => this.tryDirectCodeSessionControlFromGateway(
            message,
            ctx,
            directIntent?.decision,
          ),
          coding_backend: () => this.tryDirectCodingBackendDelegation(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            directIntent?.decision,
            effectiveCodeContext,
          ),
          filesystem: () => this.tryDirectFilesystemIntent(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            conversationKey,
            effectiveCodeContext,
            message.content,
            directIntent?.decision,
          ),
          memory_write: () => this.tryDirectMemorySave(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            effectiveCodeContext,
            message.content,
          ),
          memory_read: () => this.tryDirectMemoryRead(
            routedScopedMessage,
            ctx,
            effectiveCodeContext,
            message.content,
          ),
          scheduled_email_automation: () => this.tryDirectScheduledEmailAutomation(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            stateAgentId,
          ),
          automation: () => this.tryDirectAutomationAuthoring(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            effectiveCodeContext,
            {
              intentDecision: directIntent?.decision,
              assumeAuthoring: directIntentRouting.gatewayDirected,
            },
          ),
          automation_control: () => this.tryDirectAutomationControl(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            directIntent?.decision,
            continuityThread,
          ),
          automation_output: () => this.tryDirectAutomationOutput(
            routedScopedMessage,
            ctx,
            directIntent?.decision,
          ),
          workspace_write: () => this.tryDirectGoogleWorkspaceWrite(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            directIntent?.decision,
          ),
          workspace_read: () => this.tryDirectGoogleWorkspaceRead(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            directIntent?.decision,
            continuityThread,
          ),
          browser: () => this.tryDirectBrowserAutomation(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            effectiveCodeContext,
            directIntent?.decision,
            continuityThread,
          ),
          web_search: async () => {
            if (skipDirectWebSearch) return null;
            let webSearchResult: string | null = null;
            try {
              webSearchResult = await this.tryDirectWebSearch(routedScopedMessage, ctx);
            } catch {
              webSearchResult = null;
            }
            if (!webSearchResult) return null;

            const sanitizedWebSearch = this.sanitizeToolResultForLlm(
              'web_search',
              webSearchResult,
              defaultToolResultProviderKind,
            );
            const safeWebSearchResult = typeof sanitizedWebSearch.sanitized === 'string'
              ? sanitizedWebSearch.sanitized
              : String(sanitizedWebSearch.sanitized ?? '');
            const warningPrefix = formatToolThreatWarnings(sanitizedWebSearch.threats);
            const llmSearchPayload = warningPrefix
              ? `${warningPrefix}\n${safeWebSearchResult}`
              : safeWebSearchResult;

            if (ctx.llm) {
              try {
                const llmFormat: ChatMessage[] = [
                  ...llmMessages,
                  { role: 'user', content: `Here are web search results for the user's query. Summarize and present them clearly:\n\n${llmSearchPayload}` },
                ];
                const formatted = await this.chatWithFallback(ctx, llmFormat, undefined, fallbackProviderOrder);
                finalContent = formatted.content || llmSearchPayload;
              } catch {
                finalContent = llmSearchPayload;
              }
            } else {
              finalContent = llmSearchPayload;
            }
            return finalContent;
          },
        },
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
        gatewayDirected: directIntentRouting.gatewayDirected,
        allowDegradedMemoryFallback: shouldAllowBoundedDegradedMemorySaveFallback(directIntent),
        onDegradedMemoryFallback: async () => {
          const degradedMemorySave = await this.tryDirectMemorySave(
            routedScopedMessage,
            ctx,
            pendingActionUserKey,
            effectiveCodeContext,
            message.content,
          );
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
    }

    const delegatedOrchestration = inferDelegatedOrchestrationDescriptor(
      earlyGateway?.decision,
    );
    const handleDirectAssistantInline = this.shouldHandleDirectAssistantInline({
      gateway: earlyGateway,
      selectedExecutionProfile,
      currentProviderName: ctx.llm?.name,
    });
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
        const promptKnowledge = this.loadPromptKnowledgeBases(resolvedCodeSession, knowledgeBaseQuery);
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

    if (workerManager && delegatedOrchestration && !handleDirectAssistantInline) {
      try {
        const promptKnowledge = this.loadPromptKnowledgeBases(resolvedCodeSession, knowledgeBaseQuery);
        const workerSystemPrompt = this.buildScopedSystemPrompt(resolvedCodeSession, message);
        const workerSkillPromptMaterial = skillPromptMaterial
          ?? (
            preResolvedSkills.length > 0 && this.skillRegistry
              ? buildSkillPromptMaterial(
                this.skillRegistry,
                {
                  skills: preResolvedSkills,
                  requestText: routedScopedMessage.content,
                  ...(earlyGateway?.decision.route ? { route: earlyGateway.decision.route } : {}),
                  artifactReferences: this.resolveSkillArtifactReferences(preResolvedSkills, resolvedCodeSession),
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
          referencedCodeSessionsSection ? [referencedCodeSessionsSection] : undefined,
        );
        const workerContextAssemblyMeta = buildContextDiagnostics({
          promptKnowledge,
          runtimeSkills: preResolvedSkills,
          skillPromptMaterial: workerSkillPromptMaterial,
          toolContext: workerToolContext,
          runtimeNotices: workerRuntimeNotices,
          baseSystemPrompt: workerSystemPrompt,
          codeSessionId: resolvedCodeSession?.session.id,
          additionalSections: workerAdditionalSections,
          compaction: latestContextCompaction,
          executionProfile: workerExecutionProfile,
        });
        const continuitySummary = summarizeContinuityThreadForGateway(continuityThread);
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
        const executionIdentity = readExecutionIdentityMetadata(message.metadata);
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
            ...(executionIdentity?.executionId ? { executionId: executionIdentity.executionId } : {}),
            ...(executionIdentity?.rootExecutionId ? { rootExecutionId: executionIdentity.rootExecutionId } : {}),
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
        if (workerPendingActionMeta) {
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

    if (!ctx.llm) {
      return { content: 'No LLM provider configured.' };
    }

    // If GWS provider is configured and the structured interpretation says this is
    // workspace/email work, prefer the external provider for the tool-calling loop.
    // swap to the external model for the tool-calling loop so it handles
    // structured tool calls correctly (local models often struggle with complex schemas).
    const gwsProvider = this.enabledManagedProviders?.has('gws')
      && (directIntent?.decision.route === 'workspace_task' || directIntent?.decision.route === 'email_task')
      ? this.resolveGwsProvider?.()
      : undefined;
    let chatFn = async (msgs: ChatMessage[], opts?: import('./llm/types.js').ChatOptions) => {
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
          log.warn({ agent: this.id, error: err instanceof Error ? err.message : String(err) },
            'GWS provider failed, falling back to default');
          const fallback = await this.chatWithRoutingMetadata(ctx, msgs, mergedOpts, fallbackProviderOrder);
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
      const routed = await this.chatWithRoutingMetadata(ctx, msgs, mergedOpts, fallbackProviderOrder);
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
      ? 'external'
      : defaultToolResultProviderKind;

    const providerLocality = this.resolveToolResultProviderKind(ctx);

    if (!this.tools?.isEnabled()) {
      const response = await chatFn(llmMessages);
      finalContent = response.content;
      // Quality-based fallback for non-tool path
      if (this.qualityFallbackEnabled && this.lacksUsableAssistantContent(finalContent) && this.fallbackChain && providerLocality === 'local') {
        log.warn({ agent: this.id }, 'Local LLM produced degraded response (no-tools path), retrying with fallback');
        try {
          const fb = await chatWithAlternateProviderHelper({
            primaryProviderName: ctx.llm?.name ?? 'unknown',
            messages: llmMessages,
            fallbackProviderOrder,
            fallbackChain: this.fallbackChain,
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
      // Deferred loading: start with always-loaded tools, expand via find_tools.
      // In code sessions, only eager-load a small read-first coding subset.
      const baseToolDefs = this.tools.listAlwaysLoadedDefinitions();
      const eagerBrowserToolDefs = directBrowserIntent
        ? this.tools.listToolDefinitions().filter((definition) => definition.name.startsWith('browser_'))
        : [];
      const allToolDefs = [
        ...baseToolDefs,
        ...(resolvedCodeSession
          ? this.tools.listCodeSessionEagerToolDefinitions().filter((d) => !baseToolDefs.some((b) => b.name === d.name))
          : []),
        ...eagerBrowserToolDefs.filter((d) => !baseToolDefs.some((b) => b.name === d.name)),
      ];
      // Local models get full descriptions for better tool selection; external models get short
      let llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, providerLocality));
      const pendingIds: string[] = [];
      const contextBudget = this.contextBudget;
      let forcedPolicyRetryUsed = false;
      let forcedSkillShapeRetryCount = 0;
      let forcedSkillGroundingUsed = false;
      let forcedIntermediateStatusRetryCount = 0;
      let currentContextTrustLevel: import('./tools/types.js').ContentTrustLevel = 'trusted';
      const currentTaintReasons = new Set<string>();
      let seededAnswerFirstResponse: import('./llm/types.js').ChatResponse | null = null;
      const answerFirstOriginalRequest = stripLeadingContextPrefix(requestIntentContent);
      const answerFirstCorrectionPrompt = this.shouldPreferAnswerFirstForSkills(activeSkills, answerFirstOriginalRequest)
        ? buildAnswerFirstSkillCorrectionPrompt(activeSkills, stripLeadingContextPrefix(requestIntentContent))
        : undefined;
      const answerFirstFallbackResponse = this.shouldPreferAnswerFirstForSkills(activeSkills, answerFirstOriginalRequest)
        ? buildAnswerFirstSkillFallbackResponse(activeSkills, stripLeadingContextPrefix(requestIntentContent))
        : undefined;
      if (this.shouldPreferAnswerFirstForSkills(activeSkills, answerFirstOriginalRequest)) {
        try {
          let answerFirstResponse = await chatFn(
            withTaintedContentSystemPrompt(llmMessages, currentContextTrustLevel, currentTaintReasons),
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
            && this.isAnswerFirstSkillResponseSufficient(activeSkills, answerFirstContent, answerFirstOriginalRequest)
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
      while (rounds < this.maxToolRounds) {
        if (finalContent) break;
        // Context window awareness: if approaching budget, summarize oldest tool results
        const compactionResult = compactMessagesIfOverBudget(llmMessages, contextBudget);
        if (compactionResult.applied) {
          latestContextCompaction = compactionResult;
        }

        const plannerMessages = withTaintedContentSystemPrompt(
          llmMessages,
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
          && this.shouldRetryPolicyUpdateCorrection(llmMessages, finalContent, llmToolDefs)
        ) {
          forcedPolicyRetryUsed = true;
          response = await chatFn(
            [
              ...plannerMessages,
              { role: 'assistant', content: response.content ?? '' },
              { role: 'user', content: this.buildPolicyUpdateCorrectionPrompt() },
            ],
            { tools: llmToolDefs },
          );
          finalContent = response.content;
        }
        if (
          rounds === 0
          && (!response.toolCalls || response.toolCalls.length === 0)
          && isDirectMemorySaveRequest(stripLeadingContextPrefix(requestIntentContent))
        ) {
          response = await chatFn(
            [
              ...plannerMessages,
              { role: 'assistant', content: response.content ?? '' },
              { role: 'user', content: this.buildExplicitMemorySaveCorrectionPrompt(requestIntentContent) },
            ],
            { tools: llmToolDefs },
          );
          finalContent = response.content;
        }
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
        if (
          forcedSkillShapeRetryCount < 2
          && (!response.toolCalls || response.toolCalls.length === 0)
          && answerFirstCorrectionPrompt
          && !this.isAnswerFirstSkillResponseSufficient(activeSkills, response.content ?? '', answerFirstOriginalRequest)
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
        }
        if (
          !forcedSkillGroundingUsed
          && (!response.toolCalls || response.toolCalls.length === 0)
          && this.shouldPreferAnswerFirstForSkills(activeSkills, answerFirstOriginalRequest)
          && !this.isAnswerFirstSkillResponseSufficient(activeSkills, response.content ?? '', answerFirstOriginalRequest)
          && llmToolDefs.some((definition) => definition.name === 'fs_read')
        ) {
          const skillSourcePaths = [...new Set(
            activeSkills
              .filter((skill) => shouldUseAnswerFirstForSkills([skill], answerFirstOriginalRequest))
              .map((skill) => skill.sourcePath?.trim() ?? '')
              .filter((value) => value.length > 0),
          )].slice(0, 2);
          if (skillSourcePaths.length > 0) {
            forcedSkillGroundingUsed = true;
            for (const [index, skillPath] of skillSourcePaths.entries()) {
              const prefetched = await this.tools.executeModelTool(
                'fs_read',
                { path: skillPath },
                {
                  origin: 'assistant',
                  agentId: this.id,
                  userId: conversationUserId,
                  principalId: message.principalId ?? conversationUserId,
                  principalRole: message.principalRole ?? 'owner',
                  channel: conversationChannel,
                  requestId: message.id,
                  agentContext: { checkAction: ctx.checkAction },
                  codeContext: effectiveCodeContext,
                },
              );
              const scannedToolResult = this.sanitizeToolResultForLlm(
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
              llmMessages.push({
                role: 'assistant',
                content: '',
                toolCalls: [{
                  id: toolCallId,
                  name: 'fs_read',
                  arguments: JSON.stringify({ path: skillPath }),
                }],
              });
              llmMessages.push({
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
              withTaintedContentSystemPrompt(llmMessages, currentContextTrustLevel, currentTaintReasons),
              { tools: llmToolDefs },
            );
            finalContent = response.content;
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
          }
        }
        if (
          forcedIntermediateStatusRetryCount < 2
          && (!response.toolCalls || response.toolCalls.length === 0)
        && this.shouldRetryTerminalResultCorrection(response.content ?? '', {
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
          { role: 'user', content: this.buildTerminalResultCorrectionPrompt() },
            ],
            { tools: llmToolDefs },
          );
          finalContent = response.content;
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
        }
        if (response.toolCalls?.length) {
          response = {
            ...response,
            toolCalls: normalizeToolCallsForExecution(response.toolCalls, llmToolDefs),
          };
        }
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // Safety net for local models: if finishReason is 'stop' (no tool calls)
          // but the message clearly needed web search, pre-fetch results and re-prompt.
          // This catches cases where Ollama/local models fail to emit tool calls.
          if (rounds === 0 && response.finishReason === 'stop' && this.tools) {
            const searchQuery = (!resolvedCodeSession && !effectiveCodeContext)
              ? parseWebSearchIntent(message.content)
              : null;
            if (searchQuery) {
              const prefetched = await this.tools.executeModelTool(
                'web_search',
                { query: searchQuery, maxResults: 5 },
                {
                  origin: 'assistant',
                  agentId: this.id,
                  userId: conversationUserId,
                  channel: conversationChannel,
                  requestId: message.id,
                  agentContext: { checkAction: ctx.checkAction },
                  codeContext: effectiveCodeContext,
                },
              );
              if (toBoolean(prefetched.success) && prefetched.output) {
                const prefetchedScan = this.sanitizeToolResultForLlm('web_search', prefetched, toolResultProviderKind);
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
                // If Perplexity returned a synthesized answer, inject it directly
                if (answer) {
                  llmMessages.push({
                    role: 'user',
                    content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${answer}\n\nSources:\n${results.map((r: { url?: string }, i: number) => `${i + 1}. ${r.url ?? ''}`).join('\n')}\n\nPlease use these results to answer the user's question.`,
                  });
                } else if (results.length > 0) {
                  const snippets = results.map((r: { title?: string; url?: string; snippet?: string }, i: number) =>
                    `${i + 1}. ${r.title ?? '(untitled)'} — ${r.url ?? ''}\n   ${r.snippet ?? ''}`
                  ).join('\n');
                  llmMessages.push({
                    role: 'user',
                    content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${snippets}\n\nPlease synthesize these results to answer the user's question.`,
                  });
                }
                // Re-prompt the LLM with the search results
                if (answer || results.length > 0) {
                  const retryResponse = await chatFn(
                    withTaintedContentSystemPrompt(llmMessages, currentContextTrustLevel, currentTaintReasons),
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
          agentId: this.id,
          userId: conversationUserId,
          surfaceId: message.surfaceId,
          principalId: message.principalId ?? conversationUserId,
          principalRole: message.principalRole ?? 'owner',
          channel: conversationChannel,
          requestId: message.id,
          contentTrustLevel: currentContextTrustLevel,
          taintReasons: [...currentTaintReasons],
          derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
          allowModelMemoryMutation,
          agentContext: { checkAction: ctx.checkAction },
          codeContext: effectiveCodeContext,
          activeSkills: activeSkills.map((skill) => skill.id),
          requestText: stripLeadingContextPrefix(routedScopedMessage.content),
        };

        const roundResult = await executeToolLoopRound({
          response: {
            ...response,
            toolCalls: response.toolCalls,
          },
          state: {
            llmMessages,
            allToolDefs,
            llmToolDefs,
            contentTrustLevel: currentContextTrustLevel,
            taintReasons: currentTaintReasons,
          },
          toolExecOrigin,
          referenceTime: message.timestamp,
          intentDecision: directIntent?.decision,
          tools: this.tools!,
          secondBrainService: this.secondBrainService,
          toolResultProviderKind,
          sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
            toolName,
            result,
            providerKind,
          ),
        });
        pendingIds.push(...roundResult.pendingIds);
        lastToolRoundResults = roundResult.lastToolRoundResults;
        currentContextTrustLevel = roundResult.contentTrustLevel;

        if (roundResult.hasPending) {
          if (roundResult.allBlocked) {
            toolLoopPendingContinuation = buildBlockedToolLoopPendingApprovalContinuation({
              toolResults: roundResult.toolResults,
              llmMessages,
              deferredRemoteToolCallIds: roundResult.deferredRemoteToolCallIds,
              originalMessage: routedScopedMessage,
              requestText: stripLeadingContextPrefix(routedScopedMessage.content),
              referenceTime: message.timestamp,
              allowModelMemoryMutation,
              activeSkillIds: activeSkills.map((skill) => skill.id),
              contentTrustLevel: currentContextTrustLevel,
              taintReasons: [...currentTaintReasons],
              intentDecision: directIntent?.decision ?? undefined,
              codeContext: effectiveCodeContext,
              selectedExecutionProfile: this.resolveStoredToolLoopExecutionProfile(
                ctx,
                selectedExecutionProfile,
                directIntent?.decision,
              ),
            }) ?? undefined;
            break;
          }
        }

        // Per-tool provider routing: if any executed tool has a routing preference,
        // swap the provider for the next round so a better model synthesizes the result.
        if (this.resolveRoutedProviderForTools) {
          const executedTools = response.toolCalls.map((tc) => {
            const def = this.tools?.getToolDefinition?.(tc.name);
            return { name: tc.name, category: def?.category };
          });
          const routed = this.resolveRoutedProviderForTools(executedTools);
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
                log.warn({ agent: this.id, routing: routedLocality, error: err instanceof Error ? err.message : String(err) },
                  'Routed provider failed, falling back to default');
                const fallback = await this.chatWithRoutingMetadata(ctx, msgs, mergedOpts, fallbackProviderOrder);
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
            // Re-map tool definitions for the new provider's locality
            llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, toolResultProviderKind));
          }
        }

        rounds += 1;
      }

      if (
        (
          !finalContent
            || this.looksLikeOngoingWorkResponse(finalContent)
          || (
            !!answerFirstFallbackResponse
            && !this.isAnswerFirstSkillResponseSufficient(activeSkills, finalContent ?? '', answerFirstOriginalRequest)
          )
        )
        && lastToolRoundResults.length > 0
      ) {
        finalContent = await this.tryRecoverDirectAnswerAfterTools(
          llmMessages,
          chatFn,
          currentContextTrustLevel,
          currentTaintReasons,
        );
      }

      // Quality-based fallback: if the local LLM produced an empty or degraded
      // response and we have a fallback chain with an external provider, retry.
      // Pass tool definitions (re-mapped for external provider) so the fallback
      // LLM can call tools, not just produce text.
      if (
        this.qualityFallbackEnabled
        && (this.lacksUsableAssistantContent(finalContent) || this.looksLikeOngoingWorkResponse(finalContent))
        && this.fallbackChain
        && providerLocality === 'local'
        // If the tool round already produced concrete results or a real approval,
        // prefer the local structured fallback paths below over cross-provider retry.
        && pendingIds.length === 0
        && lastToolRoundResults.length === 0
      ) {
        log.warn({ agent: this.id, contentPreview: finalContent?.slice(0, 100) },
          'Local LLM produced degraded response, retrying with fallback chain');
        try {
          let externalToolDefs = llmToolDefs.map((d) => toLLMToolDef(d, 'external'));
          const fbMessages = [...llmMessages];
          const fallbackResult = await chatWithAlternateProviderHelper({
            primaryProviderName: ctx.llm?.name ?? 'unknown',
            messages: fbMessages,
            options: { tools: externalToolDefs },
            fallbackProviderOrder,
            fallbackChain: this.fallbackChain,
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

          // If the fallback LLM returned tool calls, execute them (single round)
          const normalizedFallbackToolCalls = normalizeToolCallsForExecution(
            fallbackResult.response.toolCalls,
            llmToolDefs,
          );
          if (normalizedFallbackToolCalls?.length && this.tools) {
            log.info({ agent: this.id, provider: fbProvider, toolCount: normalizedFallbackToolCalls.length },
              'Fallback provider requested tool calls, executing');
            const fbToolOrigin = {
              origin: 'assistant' as const,
              agentId: this.id,
              userId: conversationUserId,
              surfaceId: message.surfaceId,
              principalId: message.principalId ?? conversationUserId,
              principalRole: message.principalRole ?? 'owner',
              channel: conversationChannel,
              requestId: message.id,
              contentTrustLevel: currentContextTrustLevel,
              taintReasons: [...currentTaintReasons],
              derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
              allowModelMemoryMutation,
              agentContext: { checkAction: ctx.checkAction },
              codeContext: effectiveCodeContext,
              activeSkills: activeSkills.map((skill) => skill.id),
              requestText: stripLeadingContextPrefix(routedScopedMessage.content),
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
              intentDecision: directIntent?.decision,
              tools: this.tools!,
              secondBrainService: this.secondBrainService,
              toolResultProviderKind: 'external',
              sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
                toolName,
                result,
                providerKind,
              ),
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
                  originalMessage: routedScopedMessage,
                  requestText: stripLeadingContextPrefix(routedScopedMessage.content),
                  referenceTime: message.timestamp,
                  allowModelMemoryMutation,
                  activeSkillIds: activeSkills.map((skill) => skill.id),
                  contentTrustLevel: currentContextTrustLevel,
                  taintReasons: [...currentTaintReasons],
                  intentDecision: directIntent?.decision ?? undefined,
                  codeContext: effectiveCodeContext,
                  selectedExecutionProfile: this.resolveStoredToolLoopExecutionProfile(
                    ctx,
                    selectedExecutionProfile,
                    directIntent?.decision,
                  ),
                }) ?? undefined;
              } else {
                const finalFb = await chatWithAlternateProviderHelper({
                  primaryProviderName: fallbackResult.providerName,
                  messages: fbMessages,
                  options: { tools: externalToolDefs },
                  fallbackProviderOrder,
                  fallbackChain: this.fallbackChain,
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
                  log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
                }
              }
            } else {
              // One more chat call to get the final text response from fallback
              const finalFb = await chatWithAlternateProviderHelper({
                primaryProviderName: fallbackResult.providerName,
                messages: fbMessages,
                options: { tools: externalToolDefs },
                fallbackProviderOrder,
                fallbackChain: this.fallbackChain,
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
                log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
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
            log.info({ agent: this.id, provider: fbProvider },
              'Fallback provider produced successful response');
          }
        } catch (fallbackErr) {
          log.warn({ agent: this.id, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
            'Fallback chain also failed');
        }
      }

      if (
        answerFirstFallbackResponse
        && (
          !this.isAnswerFirstSkillResponseSufficient(activeSkills, finalContent ?? '', answerFirstOriginalRequest)
        || this.looksLikeOngoingWorkResponse(finalContent)
        )
      ) {
        finalContent = answerFirstFallbackResponse;
      }

      const finalizedPendingApprovals = finalizeToolLoopPendingApprovalsHelper({
        pendingIds,
        pendingActionUserId,
        pendingActionChannel,
        pendingActionSurfaceId,
        pendingActionUserKey,
        originalUserContent: routedScopedMessage.content,
        finalContent,
        intentDecision: directIntent?.decision,
        continuation: toolLoopPendingContinuation,
        codeSessionId: resolvedCodeSession?.session.id,
        tools: this.tools,
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
        lacksUsableAssistantContent: (content) => this.lacksUsableAssistantContent(content),
      });
      if (finalizedPendingApprovals) {
        finalContent = finalizedPendingApprovals.finalContent;
        pendingActionMeta = finalizedPendingApprovals.pendingActionMeta;
      }

      if ((!finalContent || this.looksLikeOngoingWorkResponse(finalContent)) && lastToolRoundResults.length > 0) {
        finalContent = summarizeToolRoundStatusMessage(lastToolRoundResults);
      }

      // Local models sometimes emit generic approval copy without ever producing
      // a real pending approval object. Never show approval text unless the
      // runtime actually has pending approval metadata to back it.
      if (!pendingActionMeta && isPhantomPendingApprovalMessage(finalContent)) {
        finalContent = lastToolRoundResults.length > 0
          ? summarizeToolRoundStatusMessage(lastToolRoundResults)
          : 'I did not create a real approval request for that action. Please try again.';
      }

      if (!finalContent) {
        finalContent = 'I could not generate a final response for that request.';
      }
    }

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

  private resolveDirectSecondBrainItemType(
    decision: IntentGatewayDecision | undefined,
    continuityThread?: ContinuityThreadRecord | null,
  ): string {
    const requestedItemType = toString(decision?.entities.personalItemType).trim();
    if (requestedItemType && requestedItemType !== 'unknown' && requestedItemType !== 'overview') {
      return requestedItemType;
    }
    if (decision?.route !== 'personal_assistant_task' || decision.turnRelation !== 'follow_up') {
      return requestedItemType;
    }
    const focusState = readSecondBrainFocusContinuationState(continuityThread);
    if (focusState?.activeItemType) {
      return focusState.activeItemType;
    }
    const availableTypes = Object.keys(focusState?.byType ?? {}).filter(isSecondBrainFocusItemType);
    return availableTypes.length === 1 ? availableTypes[0] : requestedItemType;
  }

  private async tryDirectSecondBrainWrite(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: IntentGatewayDecision,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled() || decision?.route !== 'personal_assistant_task') {
      return null;
    }
    if (!['create', 'save', 'update', 'delete', 'toggle'].includes(decision.operation)) {
      return null;
    }

    const resolvedItemType = this.resolveDirectSecondBrainItemType(decision, continuityThread);
    const focusState = readSecondBrainFocusContinuationState(continuityThread);

    if (resolvedItemType === 'routine') {
      if (!this.secondBrainService) return null;
      return tryDirectSecondBrainRoutineWriteHelper({
        secondBrainService: this.secondBrainService as SecondBrainService & {
          listRoutineRecords?: () => Array<Record<string, unknown>>;
          getRoutineRecordById?: (id: string) => Record<string, unknown> | null;
        },
        message,
        ctx,
        userKey,
        decision,
        focusState,
        getFocusEntry: getSecondBrainFocusEntry,
        buildFocusMetadata: buildSecondBrainFocusMetadata,
        normalizeRoutineNameForMatch,
        normalizeRoutineTemplateIdForMatch,
        extractExplicitNamedTitle: extractExplicitNamedSecondBrainTitle,
        extractRoutineDeliveryDefaults,
        extractRoutineScheduleTiming,
        extractRoutineFocusQuery,
        extractCustomRoutineCreate: extractCustomSecondBrainRoutineCreate,
        extractQuotedPhrase,
        findMatchingRoutineForCreate,
        routineTopicQuery,
        extractRoutineEnabledState,
        extractRoutingBias: extractSecondBrainRoutingBias,
        extractRoutineLookaheadMinutes,
        extractRoutineTopicWatchQuery,
        extractRoutineDueWithinHours,
        extractRoutineIncludeOverdue,
        routineDeliveryChannels,
        deriveRoutineTimingKind,
        buildToolSafeRoutineTrigger,
        executeMutation: (input) => this.executeDirectSecondBrainMutation(input),
      });
    }

    return tryDirectSecondBrainWriteHelper({
      secondBrainService: this.secondBrainService,
      message,
      ctx,
      userKey,
      decision,
      resolvedItemType,
      focusState,
      getFocusEntry: getSecondBrainFocusEntry,
      normalizeInlineFieldValue: normalizeSecondBrainInlineFieldValue,
      extractQuotedLabeledValue,
      extractExplicitNamedTitle: extractExplicitNamedSecondBrainTitle,
      extractNamedTitle: extractNamedSecondBrainTitle,
      extractRetitledTitle: extractRetitledSecondBrainTitle,
      extractTextBody: extractSecondBrainTextBody,
      extractTags: extractSecondBrainTags,
      collapseWhitespace: collapseWhitespaceForSecondBrainParsing,
      extractTaskPriority: extractSecondBrainTaskPriority,
      extractTaskStatus: extractSecondBrainTaskStatus,
      extractUrlFromText,
      extractFallbackPersonName: extractSecondBrainFallbackPersonName,
      extractEmailAddress: extractEmailAddressFromText,
      extractPhoneNumber: extractPhoneNumberFromText,
      extractPersonRelationship: extractSecondBrainPersonRelationship,
      buildClarificationResponse: (input) => this.buildDirectSecondBrainClarificationResponse(input),
      executeMutation: (input) => this.executeDirectSecondBrainMutation(input),
    });
  }

  private async tryDirectSecondBrainRead(
    message: UserMessage,
    decision?: IntentGatewayDecision,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.secondBrainService || decision?.route !== 'personal_assistant_task') {
      return null;
    }
    if (!['inspect', 'read', 'search'].includes(decision.operation)) {
      return null;
    }

    return tryDirectSecondBrainReadHelper({
      secondBrainService: this.secondBrainService,
      requestText: message.content,
      decision,
      continuityThread,
      resolvedItemType: this.resolveDirectSecondBrainItemType(decision, continuityThread),
      readFocusState: readSecondBrainFocusContinuationState,
      getFocusEntry: getSecondBrainFocusEntry,
      buildFocusMetadata: buildSecondBrainFocusMetadata,
      buildFocusRemovalMetadata: buildSecondBrainFocusRemovalMetadata,
      resolveReadQuery: resolveDirectSecondBrainReadQuery,
      normalizeInlineFieldValue: normalizeSecondBrainInlineFieldValue,
      formatBriefKindLabel: formatBriefKindLabelForUser,
      normalizeRoutineQueryTokens,
      normalizeRoutineSearchTokens,
      deriveRoutineTimingKind: (routine) => deriveRoutineTimingKind(
        routine as { timing?: { kind?: string }; trigger?: { mode?: string; eventType?: string } },
      ),
      summarizeRoutineTimingForUser: (routine) => summarizeRoutineTimingForUser(
        routine as {
          timing?: { label?: string };
          trigger?: { mode?: string; cron?: string; eventType?: string; lookaheadMinutes?: unknown };
        },
      ),
      routineTopicQuery: (routine) => routineTopicQuery(
        routine as { topicQuery?: string; config?: { topicQuery?: string } },
      ),
      routineDueWithinHours: (routine) => routineDueWithinHours(
        routine as { dueWithinHours?: number; config?: { dueWithinHours?: number } },
      ),
      routineIncludeOverdue: (routine) => routineIncludeOverdue(
        routine as { includeOverdue?: boolean; config?: { includeOverdue?: boolean } },
      ),
      routineDeliveryChannels: (routine) => routineDeliveryChannels(
        routine as { delivery?: string[]; deliveryDefaults?: string[] },
      ),
      buildRoutineSemanticHints: (routine) => buildRoutineSemanticHints(
        routine as {
          id?: string;
          templateId?: string;
          name?: string;
          category?: string;
          externalCommMode?: string;
          topicQuery?: string;
          dueWithinHours?: number;
          includeOverdue?: boolean;
          config?: {
            topicQuery?: string;
            dueWithinHours?: number;
            includeOverdue?: boolean;
          };
          timing?: {
            kind?: string;
            label?: string;
            schedule?: { cadence?: string; dayOfWeek?: string; dayOfMonth?: number; time?: string; minute?: number };
          };
          trigger?: { mode?: string; eventType?: string; cron?: string; lookaheadMinutes?: unknown };
        },
      ),
    });
  }

  private async tryDirectProviderRead(
    message: UserMessage,
    ctx: AgentContext,
    decision?: IntentGatewayDecision,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;
    if (decision?.executionClass !== 'provider_crud') return null;
    if (!['read', 'inspect'].includes(decision.operation)) return null;

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
      ...(message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
    };

    const listResult = await this.tools.executeModelTool(
      'llm_provider_list',
      {},
      toolRequest,
    );
    if (!toBoolean(listResult.success)) {
      const msg = toString(listResult.message) || toString(listResult.error) || 'Provider inventory lookup failed.';
      return `I tried to inspect the configured AI providers, but it failed: ${msg}`;
    }

    const output = isRecord(listResult.output) ? listResult.output : {};
    const providers = Array.isArray(output.providers)
      ? output.providers.filter((provider): provider is Record<string, unknown> => isRecord(provider))
      : [];
    if (providers.length === 0) {
      return 'No AI providers are currently configured.';
    }

    const targetProvider = this.resolveDirectProviderInventoryTarget(message.content, providers);
    if (decision.operation === 'inspect' && targetProvider) {
      const providerName = toString(targetProvider.name).trim();
      const modelsResult = await this.tools.executeModelTool(
        'llm_provider_models',
        { provider: providerName },
        toolRequest,
      );
      if (toBoolean(modelsResult.success)) {
        return this.formatDirectProviderModelsResponse(
          targetProvider,
          isRecord(modelsResult.output) ? modelsResult.output : {},
        );
      }
    }

    return this.formatDirectProviderInventoryResponse(providers);
  }

  private resolveDirectProviderInventoryTarget(
    content: string,
    providers: readonly Record<string, unknown>[],
  ): Record<string, unknown> | null {
    const normalized = content.trim().toLowerCase();
    if (!normalized) return null;
    const matches = providers
      .filter((provider) => {
        const name = toString(provider.name).trim().toLowerCase();
        return !!name && normalized.includes(name);
      })
      .sort((left, right) => toString(right.name).length - toString(left.name).length);
    return matches[0] ?? null;
  }

  private formatDirectProviderInventoryResponse(
    providers: readonly Record<string, unknown>[],
  ): string {
    const lines = ['Configured AI providers:'];
    for (const provider of providers) {
      const name = toString(provider.name).trim() || '(unnamed)';
      const type = toString(provider.type).trim() || 'unknown';
      const model = toString(provider.model).trim() || 'unknown';
      const tier = toString(provider.tier).trim().replace(/_/g, ' ') || 'unknown';
      const connected = provider.connected === true ? 'connected' : 'not verified';
      const flags: string[] = [];
      if (provider.isDefault === true) flags.push('primary');
      if (provider.isPreferredLocal === true) flags.push('preferred local');
      if (provider.isPreferredManagedCloud === true) flags.push('preferred managed cloud');
      if (provider.isPreferredFrontier === true) flags.push('preferred frontier');
      const extras = flags.length > 0 ? ` · ${flags.join(', ')}` : '';
      lines.push(`- ${name} [${tier} · ${type}] model ${model} · ${connected}${extras}`);
    }
    return lines.join('\n');
  }

  private formatDirectProviderModelsResponse(
    provider: Record<string, unknown>,
    output: Record<string, unknown>,
  ): string {
    const providerName = toString(provider.name).trim() || '(unnamed)';
    const activeModel = toString(output.activeModel).trim() || toString(provider.model).trim() || 'unknown';
    const models = Array.isArray(output.models)
      ? output.models
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
      : [];
    if (models.length === 0) {
      return `Configured provider ${providerName} is currently set to model ${activeModel}, but no available model catalog was returned.`;
    }
    return [
      `Available models for ${providerName}:`,
      `- Active model: ${activeModel}`,
      ...models.slice(0, 25).map((model) => `- ${model}`),
      ...(models.length > 25 ? [`- ...and ${models.length - 25} more`] : []),
    ].join('\n');
  }

  private buildDirectSecondBrainMutationSuccessResponse(
    descriptor: {
      itemType: DirectSecondBrainMutationItemType;
      action: DirectSecondBrainMutationAction;
      fallbackId?: string;
      fallbackLabel?: string;
    },
    output: unknown,
    focusState: SecondBrainFocusContinuationPayload | null | undefined,
  ): { content: string; metadata?: Record<string, unknown> } {
    return buildDirectSecondBrainMutationSuccessResponseHelper({
      descriptor,
      output,
      focusState,
      buildFocusMetadata: (existingState, itemType, items, options) => buildSecondBrainFocusMetadata(
        existingState,
        itemType,
        items,
        options,
      ),
      buildFocusRemovalMetadata: (existingState, itemType) => buildSecondBrainFocusRemovalMetadata(
        existingState,
        itemType,
      ),
    });
  }

  private buildDirectSecondBrainClarificationResponse(input: {
    message: UserMessage;
    decision: IntentGatewayDecision;
    prompt: string;
    field?: string;
    missingFields?: string[];
    entities?: Record<string, unknown>;
  }): { content: string; metadata?: Record<string, unknown> } {
    return buildDirectSecondBrainClarificationResponseHelper({
      ...input,
      toPendingActionEntities: (entities) => toPendingActionEntities(
        entities as Record<string, unknown> | IntentGatewayDecision['entities'] | undefined,
      ),
      setClarificationPendingAction: (userId, channel, surfaceId, action, nowMs) => this.setClarificationPendingAction(
        userId,
        channel,
        surfaceId,
        action,
        nowMs,
      ),
      buildImmediateResponseMetadata: (_pendingApprovalIds, userId, channel, surfaceId, options) => this.buildImmediateResponseMetadata(
        [] as ResolvedSkill[],
        userId,
        channel,
        surfaceId,
        options,
      ),
    });
  }

  private async executeDirectSecondBrainMutation(input: {
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
    decision: IntentGatewayDecision;
    toolName: DirectSecondBrainMutationToolName;
    args: Record<string, unknown>;
    summary: string;
    pendingIntro: string;
    successDescriptor: {
      itemType: DirectSecondBrainMutationItemType;
      action: DirectSecondBrainMutationAction;
      fallbackId?: string;
      fallbackLabel?: string;
    };
    focusState: SecondBrainFocusContinuationPayload | null | undefined;
  }): Promise<string | { content: string; metadata?: Record<string, unknown> }> {
    return executeDirectSecondBrainMutationHelper({
      ...input,
      agentId: this.id,
      tools: this.tools,
      getPendingApprovals: (userKey, surfaceId, nowMs) => this.getPendingApprovals(userKey, surfaceId, nowMs),
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setPendingApprovalActionForRequest(
        userKey,
        surfaceId,
        action,
        nowMs,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
      toPendingActionEntities: (entities) => toPendingActionEntities(
        entities as Record<string, unknown> | IntentGatewayDecision['entities'] | undefined,
      ),
      buildDirectSecondBrainMutationSuccessResponse: (descriptor, output, focusState) => this.buildDirectSecondBrainMutationSuccessResponse(
        descriptor,
        output,
        focusState,
      ),
    });
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

  private async executeDirectCodeSessionTool(
    toolName: string,
    args: Record<string, unknown>,
    message: UserMessage,
    ctx: AgentContext,
  ): Promise<Record<string, unknown>> {
    return this.tools!.executeModelTool(
      toolName,
      args,
      {
        origin: 'assistant',
        agentId: this.id,
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

  private async tryDirectCodingBackendDelegation(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: import('./runtime/intent-gateway.js').IntentGatewayDecision,
    codeContext?: { sessionId?: string; workspaceRoot: string },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectCodingBackendDelegationHelper(
      {
        message,
        ctx,
        userKey,
        decision,
        codeContext,
      },
      {
        agentId: this.id,
        tools: this.tools,
        codeSessionStore: this.codeSessionStore,
        parsePendingActionUserKey: (key) => this.parsePendingActionUserKey(key),
        ensureExplicitCodingTaskWorkspaceTarget: (nextInput) => this.ensureExplicitCodingTaskWorkspaceTarget(nextInput),
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
      },
    );
  }

  private async ensureExplicitCodingTaskWorkspaceTarget(input: {
    message: UserMessage;
    ctx: AgentContext;
    decision?: IntentGatewayDecision;
    currentSession?: CodeSessionRecord | null;
    codeContext?: { workspaceRoot: string; sessionId?: string };
  }): Promise<
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
        response: { content: string; metadata?: Record<string, unknown> };
      }
  > {
    return ensureExplicitCodingTaskWorkspaceTargetHelper({
      toolsEnabled: this.tools?.isEnabled() === true,
      codeSessionStore: this.codeSessionStore,
      executeDirectCodeSessionTool: (toolName, args, message, ctx) => this.executeDirectCodeSessionTool(
        toolName,
        args,
        message,
        ctx,
      ),
      ...input,
    });
  }

  private async tryDirectCodeSessionControlFromGateway(
    message: UserMessage,
    ctx: AgentContext,
    decision?: import('./runtime/intent-gateway.js').IntentGatewayDecision,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectCodeSessionControlFromGatewayHelper({
      toolsEnabled: this.tools?.isEnabled() === true,
      executeDirectCodeSessionTool: (toolName, args, message, ctx) => this.executeDirectCodeSessionTool(
        toolName,
        args,
        message,
        ctx,
      ),
      getCodeSessionManagedSandboxes: this.tools?.getCodeSessionManagedSandboxStatus
        ? (sessionId, ownerUserId) => this.tools!.getCodeSessionManagedSandboxStatus({ sessionId, ownerUserId })
        : undefined,
      getActivePendingAction: (userId, channel, surfaceId) => this.getActivePendingAction(userId, channel, surfaceId),
      completePendingAction: (actionId) => this.completePendingAction(actionId),
      resumeCodingTask: (message, ctx, userKey, decision, codeContext) => this.tryDirectCodingBackendDelegation(
        message,
        ctx,
        userKey,
        decision,
        codeContext,
      ),
      onMessage: (message, ctx) => this.onMessage(message, ctx),
      message,
      ctx,
      decision,
    });
  }

  private async handleCodeSessionAttach(
    message: UserMessage,
    ctx: AgentContext,
    target: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return handleCodeSessionAttachHelper({
      executeDirectCodeSessionTool: (toolName, args, message, ctx) => this.executeDirectCodeSessionTool(
        toolName,
        args,
        message,
        ctx,
      ),
      getActivePendingAction: (userId, channel, surfaceId) => this.getActivePendingAction(userId, channel, surfaceId),
      completePendingAction: (actionId) => this.completePendingAction(actionId),
      resumeCodingTask: (message, ctx, userKey, decision, codeContext) => this.tryDirectCodingBackendDelegation(
        message,
        ctx,
        userKey,
        decision,
        codeContext,
      ),
      onMessage: (message, ctx) => this.onMessage(message, ctx),
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

  private shouldRetryTerminalResultCorrection(
    content: string,
    context: {
      hasToolResults: boolean;
      hasAnswerFirstContract: boolean;
      hasToolExecutionContract: boolean;
    },
  ): boolean {
    if (!this.looksLikeOngoingWorkResponse(content)) {
      return false;
    }
    return context.hasToolResults || context.hasAnswerFirstContract || context.hasToolExecutionContract;
  }

  private buildTerminalResultCorrectionPrompt(): string {
    return [
      'System correction: your previous reply narrated ongoing work instead of delivering a terminal result.',
      'Continue the same request now.',
      'If more tool calls are required, call them now instead of narrating what you will do next.',
      'If the work is already complete, answer with the actual result, exact outputs, and any requested verification.',
      'Do not stop at phrases like "I\'ll inspect", "Let me", or "Now I\'ll".',
    ].join(' ');
  }

  private shouldRetryPolicyUpdateCorrection(
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

  private buildPolicyUpdateCorrectionPrompt(): string {
    return [
      'System correction: update_tool_policy is available in your current tool list.',
      'Do not tell the user to edit config manually for allowlist changes.',
      'If the block is a filesystem path, call update_tool_policy with action "add_path".',
      'If the block is a hostname/domain, call update_tool_policy with action "add_domain" using the normalized hostname only.',
      'If the block is a command prefix, call update_tool_policy with action "add_command".',
      'Use the tool now if policy is the blocker.',
    ].join(' ');
  }

  private buildExplicitMemorySaveCorrectionPrompt(requestContent: string): string {
    return [
      'System correction: the user already made an explicit remember/save request.',
      'Do not ask for confirmation or ask the user to restate it.',
      'Call memory_save now using the requested scope if one was specified.',
      `Original request: ${requestContent.trim()}`,
    ].join(' ');
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
    return this.buildDirectSecondBrainMutationSuccessResponse(
      secondBrainDescriptor,
      approvalResult.result?.output,
      focusState,
    );
  }

  private async tryDirectWebSearch(
    message: UserMessage,
    ctx: AgentContext,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const query = parseWebSearchIntent(message.content);
    if (!query) return null;

    const toolResult = await this.tools.executeModelTool(
      'web_search',
      { query, maxResults: 10 },
      {
        origin: 'assistant',
        agentId: this.id,
        userId: message.userId,
        channel: message.channel,
        requestId: message.id,
        agentContext: { checkAction: ctx.checkAction },
      },
    );

    if (!toBoolean(toolResult.success)) {
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Web search failed.';
      return `I tried to search the web for "${query}" but it failed: ${msg}`;
    }

    const output = (toolResult.output && typeof toolResult.output === 'object'
      ? toolResult.output
      : null) as {
        provider?: unknown;
        results?: unknown;
        answer?: unknown;
      } | null;

    const provider = output ? toString(output.provider) : 'unknown';
    const results = output && Array.isArray(output.results)
      ? output.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>
      : [];
    const answer = output ? toString(output.answer) : '';

    if (results.length === 0 && !answer) {
      return `I searched the web for "${query}" (via ${provider}) but found no results.`;
    }

    const lines = [`Web search results for "${query}" (via ${provider}):\n`];
    if (answer) {
      lines.push(`Summary: ${answer}\n`);
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const title = toString(r.title) || '(untitled)';
      const url = toString(r.url);
      const snippet = toString(r.snippet);
      lines.push(`${i + 1}. **${title}**`);
      if (url) lines.push(`   ${url}`);
      if (snippet) lines.push(`   ${snippet}`);
    }
    return lines.join('\n');
  }

  private async tryDirectMemorySave(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    codeContext?: { workspaceRoot?: string; sessionId?: string },
    originalUserContent?: string,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectMemorySaveHelper({
      tools: this.tools,
      agentId: this.id,
      message,
      ctx,
      userKey,
      codeContext,
      originalUserContent,
      getPendingApprovals: (userKey, surfaceId) => this.getPendingApprovals(userKey, surfaceId),
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (userKey, surfaceId, action, nowMs) => this.setPendingApprovalActionForRequest(
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

  private async tryDirectMemoryRead(
    message: UserMessage,
    ctx: AgentContext,
    codeContext?: { workspaceRoot?: string; sessionId?: string },
    originalUserContent?: string,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectMemoryReadHelper({
      tools: this.tools,
      agentId: this.id,
      message,
      ctx,
      codeContext,
      originalUserContent,
    });
  }

  private async tryDirectGoogleWorkspaceWrite(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: IntentGatewayDecision,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectGoogleWorkspaceWriteHelper({
      message,
      ctx,
      userKey,
      decision,
    }, this.buildDirectMailboxDeps());
  }

  private buildDirectMailboxDeps(): DirectMailboxDeps {
    return {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      getPendingApprovals: (nextUserKey, surfaceId, nowMs) => this.getPendingApprovals(nextUserKey, surfaceId, nowMs),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (nextUserKey, surfaceId, action) => this.setPendingApprovalActionForRequest(
        nextUserKey,
        surfaceId,
        action,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    };
  }

  private buildDirectAutomationDeps(): DirectAutomationDeps {
    return {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
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
    };
  }

  private async tryDirectAutomationAuthoring(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    codeContext?: { workspaceRoot?: string },
    options?: {
      allowRemediation?: boolean;
      assumeAuthoring?: boolean;
      intentDecision?: IntentGatewayDecision | null;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectAutomationAuthoringHelper({
      message,
      ctx,
      userKey,
      codeContext,
      options,
    }, this.buildDirectAutomationDeps());
  }

  private async tryDirectAutomationControl(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    intentDecision?: IntentGatewayDecision | null,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectAutomationControlHelper({
      message,
      ctx,
      userKey,
      intentDecision,
      continuityThread,
    }, this.buildDirectAutomationDeps());
  }

  private async tryDirectAutomationOutput(
    message: UserMessage,
    ctx: AgentContext,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectAutomationOutputHelper({
      message,
      ctx,
      intentDecision,
    }, this.buildDirectAutomationDeps());
  }

  private async tryDirectBrowserAutomation(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    codeContext?: { workspaceRoot?: string; sessionId?: string },
    intentDecision?: IntentGatewayDecision | null,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectBrowserAutomationHelper({
      message,
      ctx,
      userKey,
      codeContext,
      intentDecision,
      continuityThread,
    }, this.buildDirectAutomationDeps());
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
    candidate: DirectIntentShadowCandidate,
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
    candidate: DirectIntentShadowCandidate,
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
      default:
        return new Set(['unknown']);
    }
  }

  private async tryDirectScheduledEmailAutomation(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    stateAgentId: string,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectScheduledEmailAutomationHelper({
      message,
      ctx,
      userKey,
      stateAgentId,
    }, {
      agentId: this.id,
      tools: this.tools,
      conversationService: this.conversationService,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      getPendingApprovals: (nextUserKey, surfaceId, nowMs) => this.getPendingApprovals(nextUserKey, surfaceId, nowMs),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (nextUserKey, surfaceId, action) => this.setPendingApprovalActionForRequest(
        nextUserKey,
        surfaceId,
        action,
      ),
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
  }

  private async tryDirectGoogleWorkspaceRead(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: IntentGatewayDecision,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectGoogleWorkspaceReadHelper({
      message,
      ctx,
      userKey,
      decision,
      continuityThread,
    }, this.buildDirectMailboxDeps());
  }

  private async tryDirectFilesystemIntent(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    conversationKey: ConversationKey,
    codeContext?: { workspaceRoot: string; sessionId?: string },
    originalUserContent?: string,
    gatewayDecision?: IntentGatewayDecision,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectFilesystemIntentHelper({
      message,
      ctx,
      userKey,
      conversationKey,
      codeContext,
      originalUserContent,
      gatewayDecision,
      agentId: this.id,
      tools: this.tools,
      conversationService: this.conversationService,
      executeStoredFilesystemSave: (input) => this.executeStoredFilesystemSave(input),
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      getPendingApprovals: (nextUserKey, surfaceId, nowMs) => this.getPendingApprovals(nextUserKey, surfaceId, nowMs),
      formatPendingApprovalPrompt: (ids, summaries) => this.formatPendingApprovalPrompt(ids, summaries),
      setPendingApprovalActionForRequest: (nextUserKey, surfaceId, action, nowMs) => this.setPendingApprovalActionForRequest(
        nextUserKey,
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
    const chatResume = readChatContinuationGraphResume({
      graphStore: this.executionGraphStore,
      pendingAction,
    });
    if (!chatResume) {
      return fallback ? fallback(pendingAction, options) : null;
    }
    if (!this.executionGraphStore) return null;
    const nowMs = Date.now();
    this.completePendingAction(pendingAction.id, nowMs);
    emitChatContinuationGraphResumeEvent({
      graphStore: this.executionGraphStore,
      runTimeline: this.runTimeline,
      resume: chatResume,
      kind: 'interruption_resolved',
      payload: {
        kind: 'approval',
        approvalId: options.approvalId,
        resumeToken: chatResume.resumeToken,
        resultStatus: (options.approvalResult.approved ?? options.approvalResult.success) ? 'approved' : 'denied',
      },
      eventKey: 'approval-resolved',
      nowMs,
    });

    if (!(options.approvalResult.approved ?? options.approvalResult.success)) {
      emitChatContinuationGraphResumeEvent({
        graphStore: this.executionGraphStore,
        runTimeline: this.runTimeline,
        resume: chatResume,
        kind: 'graph_failed',
        payload: {
          reason: options.approvalResult.message || 'Approval denied.',
          continuationArtifactId: chatResume.artifact.artifactId,
        },
        eventKey: 'denied',
        nowMs,
      });
      return {
        content: options.approvalResult.message || 'Approval denied. I did not continue the pending action.',
        metadata: {
          executionGraph: {
            graphId: chatResume.graph.graphId,
            status: 'failed',
            reason: 'approval_denied',
          },
        },
      };
    }

    const result = chatResume.payload.type === 'filesystem_save_output'
      ? await this.executeStoredFilesystemSave({
          targetPath: chatResume.payload.targetPath,
          content: chatResume.payload.content,
          originalUserContent: chatResume.payload.originalUserContent,
          userKey: `${pendingAction.scope.userId}:${pendingAction.scope.channel}`,
          userId: pendingAction.scope.userId,
          channel: pendingAction.scope.channel,
          surfaceId: pendingAction.scope.surfaceId,
          principalId: chatResume.payload.principalId ?? pendingAction.scope.userId,
          principalRole: normalizeFilesystemResumePrincipalRole(chatResume.payload.principalRole) ?? 'owner',
          requestId: randomUUID(),
          codeContext: chatResume.payload.codeContext,
          allowPathRemediation: chatResume.payload.allowPathRemediation,
        })
      : chatResume.payload.type === 'automation_authoring'
        ? await this.executeStoredAutomationAuthoring(
            pendingAction,
            chatResume.payload,
            options.approvalResult,
          )
        : await this.resumeStoredToolLoopContinuation(
            pendingAction,
            chatResume.payload,
            {
              approvalId: options.approvalId,
              pendingActionAlreadyCleared: true,
              approvalResult: options.approvalResult,
            },
          ) ?? {
            content: 'I could not resume the pending coding run after approval.',
          };
    const response = typeof result === 'string' ? { content: result } : result;
    const nextPendingAction = isRecord(response.metadata?.pendingAction)
      ? response.metadata.pendingAction
      : null;
    emitChatContinuationGraphResumeEvent({
      graphStore: this.executionGraphStore,
      runTimeline: this.runTimeline,
      resume: chatResume,
      kind: 'graph_completed',
      payload: {
        continuationArtifactId: chatResume.artifact.artifactId,
        resultStatus: nextPendingAction ? 'pending_approval' : 'completed',
      },
      eventKey: 'completed',
    });
    return {
      content: response.content,
      metadata: {
        ...(response.metadata ?? {}),
        executionGraph: {
          graphId: chatResume.graph.graphId,
          status: nextPendingAction ? 'pending_approval' : 'completed',
          continuationArtifactId: chatResume.artifact.artifactId,
        },
      },
    };
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
    continuation: import('./runtime/chat-agent/tool-loop-resume.js').ToolLoopResumePayload,
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
    resume: import('./runtime/chat-agent/capability-continuation-resume.js').AutomationAuthoringResumePayload,
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
