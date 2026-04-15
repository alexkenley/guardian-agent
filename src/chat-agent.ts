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
  formatDirectCodeSessionLine,
  formatToolThreatWarnings,
  formatToolResultForLLM,
  getCodeSessionPromptRelativePath,
  isAffirmativeContinuation,
  isRecord,
  normalizeCodingBackendSelection,
  normalizeScheduledEmailBody,
  parseRequestedEmailCount,
  parseDirectGoogleWorkspaceIntent,
  readCodeRequestMetadata,
  sameCodeWorkspaceWorkingSet,
  shouldRefreshCodeSessionFocus,
  shouldRefreshCodeSessionWorkingSet,
  stripLeadingContextPrefix,
  summarizeCodeSessionFocus,
  summarizeGmailMessage,
  summarizeM365From,
  summarizeToolRoundFallback,
  toBoolean,
  toLLMToolDef,
  toNumber,
  toString,
} from './chat-agent-helpers.js';
import type { GmailMessageSummary } from './chat-agent-helpers.js';
import { withTaintedContentSystemPrompt } from './util/tainted-content.js';
import type { ContextCompactionResult } from './util/context-budget.js';
import { isResponseDegraded as _isResponseDegraded } from './util/response-quality.js';
import { isToolReportQuery as _isToolReportQuery, formatToolReport as _formatToolReport } from './util/tool-report.js';
import {
  isDirectMemorySaveRequest,
  shouldAllowModelMemoryMutation,
} from './util/memory-intent.js';
import type { ConversationKey } from './runtime/conversation.js';
import { ConversationService } from './runtime/conversation.js';
import type { CodeSessionRecord, ResolvedCodeSessionContext } from './runtime/code-sessions.js';
import { CodeSessionStore } from './runtime/code-sessions.js';
import {
  deriveCodeSessionWorkflowState,
  type CodeSessionWorkflowType,
} from './runtime/coding-workflows.js';
import {
  buildToolLoopResumePayload,
  type StoredToolLoopPendingTool,
} from './runtime/chat-agent/tool-loop-resume.js';
import {
  dispatchDirectIntentCandidates,
} from './runtime/chat-agent/direct-intent-dispatch.js';
import {
  executeToolsConflictAware,
  isDeferredRemoteSandboxToolResult,
  pruneDeferredRemoteSandboxToolCalls,
} from './runtime/chat-agent/tool-execution.js';
import type { SecondBrainService } from './runtime/second-brain/second-brain-service.js';
import { buildCodeSessionPortfolioAdditionalSection } from './runtime/code-session-portfolio.js';
import { inspectCodeWorkspaceSync, type CodeWorkspaceProfile } from './runtime/code-workspace-profile.js';
import type { AssistantResponseStyleConfig } from './config/types.js';
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
import { buildGmailRawMessage, parseDirectGmailWriteIntent } from './runtime/gmail-compose.js';
import {
  parseScheduledEmailAutomationIntent,
  parseScheduledEmailScheduleIntent,
} from './runtime/email-automation-intent.js';
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
  IntentGateway,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
  toIntentGatewayClientMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRoute,
  type IntentGatewayRecord,
} from './runtime/intent-gateway.js';
import { shouldAttachCodeSessionForRequest } from './runtime/code-session-request-scope.js';
import {
  parseWebSearchIntent,
} from './runtime/search-intent.js';
import {
  buildPagedListContinuationState,
  hasPagedListFollowUpRequest,
  readPagedListContinuationState,
  resolvePagedListWindow,
} from './runtime/list-continuation.js';
import type { ToolApprovalDecisionResult, ToolExecutor } from './tools/executor.js';
import type { PrincipalRole } from './tools/types.js';
import { buildToolResultPayloadFromJob } from './tools/job-results.js';
import {
  ChatAgentApprovalState,
  type ApprovalFollowUpCopy,
} from './runtime/chat-agent/approval-state.js';
import {
  continueDirectRouteAfterApproval as continueDirectRouteAfterApprovalHelper,
  handleApprovalMessage,
  syncPendingApprovalsFromExecutor as syncPendingApprovalsFromExecutorHelper,
} from './runtime/chat-agent/approval-orchestration.js';
import {
  normalizeDirectRouteContinuationResponse as normalizeDirectRouteContinuationResponseHelper,
  readDirectContinuationStateMetadata,
  stripDirectContinuationStateMetadata,
} from './runtime/chat-agent/direct-continuation-state.js';
import {
  ensureExplicitCodingTaskWorkspaceTarget as ensureExplicitCodingTaskWorkspaceTargetHelper,
  handleCodeSessionAttach as handleCodeSessionAttachHelper,
  tryDirectCodeSessionControlFromGateway as tryDirectCodeSessionControlFromGatewayHelper,
} from './runtime/chat-agent/code-session-control.js';
import {
  normalizeFilesystemResumePrincipalRole,
  type SecondBrainMutationResumePayload,
} from './runtime/chat-agent/direct-route-resume.js';
import {
  buildDirectSecondBrainClarificationResponse as buildDirectSecondBrainClarificationResponseHelper,
  buildDirectSecondBrainMutationSuccessResponse as buildDirectSecondBrainMutationSuccessResponseHelper,
  executeDirectSecondBrainMutation as executeDirectSecondBrainMutationHelper,
  type DirectSecondBrainMutationAction,
  type DirectSecondBrainMutationItemType,
  type DirectSecondBrainMutationToolName,
} from './runtime/chat-agent/direct-second-brain-mutation.js';
import {
  tryDirectAutomationAuthoring as tryDirectAutomationAuthoringHelper,
  tryDirectAutomationControl as tryDirectAutomationControlHelper,
  tryDirectAutomationOutput as tryDirectAutomationOutputHelper,
  tryDirectBrowserAutomation as tryDirectBrowserAutomationHelper,
} from './runtime/chat-agent/direct-automation.js';
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
  readLatestAssistantOutput as readLatestAssistantOutputHelper,
  resumeStoredDirectRoutePendingAction as resumeStoredDirectRoutePendingActionHelper,
  tryDirectFilesystemSave as tryDirectFilesystemSaveHelper,
  tryDirectFilesystemSearch as tryDirectFilesystemSearchHelper,
} from './runtime/chat-agent/direct-route-runtime.js';
import {
  executeStoredFilesystemSave as executeStoredFilesystemSaveHelper,
} from './runtime/chat-agent/filesystem-save-resume.js';
import {
  executeStoredSecondBrainMutation as executeStoredSecondBrainMutationHelper,
} from './runtime/chat-agent/second-brain-resume.js';
import {
  buildStoredToolLoopChatRunner as buildStoredToolLoopChatRunnerHelper,
  recoverDirectAnswerAfterTools as recoverDirectAnswerAfterToolsHelper,
  resumeStoredToolLoopPendingAction as resumeStoredToolLoopPendingActionHelper,
} from './runtime/chat-agent/tool-loop-runtime.js';
import {
  ChatAgentOrchestrationState,
  PENDING_APPROVAL_TTL_MS,
} from './runtime/chat-agent/orchestration-state.js';
import {
  buildGatewayClarificationResponse as buildGatewayClarificationResponseHelper,
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
  readSelectedExecutionProfileMetadata,
  type SelectedExecutionProfile,
} from './runtime/execution-profiles.js';
import type { ModelFallbackChain } from './llm/model-fallback.js';
import { getProviderLocality, getProviderTier } from './llm/provider-metadata.js';
import type { OutputGuardian } from './guardian/output-guardian.js';
import { SkillRegistry } from './skills/registry.js';
import { buildSkillPromptMaterial, createSkillPromptMaterialCache } from './skills/prompt.js';
import { SkillResolver } from './skills/resolver.js';
import type { ResolvedSkill, SkillPromptArtifactContext, SkillPromptMaterialResult } from './skills/types.js';
import { WorkerManager } from './supervisor/worker-manager.js';
import {
  buildPendingApprovalMetadata,
  formatPendingApprovalMessage,
  isPhantomPendingApprovalMessage,
  shouldUseStructuredPendingApprovalMessage,
} from './runtime/pending-approval-copy.js';
import {
  buildLocalModelTooComplicatedMessage,
  getProviderLocalityFromName,
  isLocalToolCallParseError,
  readResponseSourceMetadata,
  shouldBypassLocalModelComplexityGuard,
  type ResponseSourceMetadata,
} from './runtime/model-routing-ux.js';
import {
  buildApprovalContinuationScopeKey,
  findSuspendedApprovalState,
  normalizeApprovalContinuationScope,
  selectSuspendedOriginalMessage,
  type ApprovalContinuationScope,
} from './runtime/approval-continuations.js';
import { recoverToolCallsFromStructuredText } from './util/structured-json.js';

const SECOND_BRAIN_FOCUS_CONTINUATION_KIND = 'second_brain_focus';
const ROUTINE_QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'any',
  'are',
  'brain',
  'disabled',
  'enabled',
  'for',
  'in',
  'is',
  'list',
  'me',
  'my',
  'of',
  'only',
  'or',
  'processing',
  'related',
  'routine',
  'routines',
  'second',
  'show',
  'the',
  'to',
  'what',
  'which',
]);

type SecondBrainFocusItemType = 'note' | 'task' | 'calendar' | 'person' | 'library' | 'brief' | 'routine';

interface SecondBrainFocusContinuationItem {
  id: string;
  label?: string;
}

interface SecondBrainFocusContinuationEntry {
  focusId?: string;
  items: SecondBrainFocusContinuationItem[];
}

interface SecondBrainFocusContinuationPayload {
  activeItemType?: SecondBrainFocusItemType;
  byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>>;
}

function normalizeRoutineQueryTokens(query: string | undefined): string[] {
  if (typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !ROUTINE_QUERY_STOP_WORDS.has(token));
}

function normalizeRoutineSearchTokens(value: string | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function deriveRoutineTimingKind(
  routine: {
    timing?: { kind?: string };
    trigger?: { mode?: string; eventType?: string };
  },
): string | undefined {
  if (typeof routine.timing?.kind === 'string' && routine.timing.kind.trim()) {
    return routine.timing.kind.trim();
  }
  const normalizedEventType = typeof routine.trigger?.eventType === 'string'
    ? routine.trigger.eventType.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    : '';
  if (routine.trigger?.mode === 'cron') return 'scheduled';
  if (routine.trigger?.mode === 'event' && normalizedEventType === 'upcoming_event') return 'before_meetings';
  if (routine.trigger?.mode === 'event' && normalizedEventType === 'event_ended') return 'after_meetings';
  if (routine.trigger?.mode === 'horizon') return 'background';
  if (routine.trigger?.mode === 'manual') return 'manual';
  return undefined;
}

function routineTopicQuery(
  routine: {
    topicQuery?: string;
    config?: { topicQuery?: string };
  },
): string {
  return typeof routine.topicQuery === 'string' && routine.topicQuery.trim()
    ? routine.topicQuery.trim()
    : typeof routine.config?.topicQuery === 'string' && routine.config.topicQuery.trim()
      ? routine.config.topicQuery.trim()
      : '';
}

function routineDueWithinHours(
  routine: {
    dueWithinHours?: number;
    config?: { dueWithinHours?: number };
  },
): number | undefined {
  if (Number.isFinite(routine.dueWithinHours)) {
    return Number(routine.dueWithinHours);
  }
  if (Number.isFinite(routine.config?.dueWithinHours)) {
    return Number(routine.config?.dueWithinHours);
  }
  return undefined;
}

function routineIncludeOverdue(
  routine: {
    includeOverdue?: boolean;
    config?: { includeOverdue?: boolean };
  },
): boolean | undefined {
  if (typeof routine.includeOverdue === 'boolean') return routine.includeOverdue;
  if (typeof routine.config?.includeOverdue === 'boolean') return routine.config.includeOverdue;
  return undefined;
}

function routineDeliveryChannels(
  routine: {
    delivery?: string[];
    deliveryDefaults?: string[];
  },
): string[] {
  if (Array.isArray(routine.delivery)) return routine.delivery.filter((value) => typeof value === 'string' && value.trim().length > 0);
  if (Array.isArray(routine.deliveryDefaults)) return routine.deliveryDefaults.filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [];
}

function summarizeRoutineTimingForUser(
  routine: {
    timing?: { label?: string };
    trigger?: { mode?: string; cron?: string; eventType?: string; lookaheadMinutes?: unknown };
  },
): string {
  const label = typeof routine.timing?.label === 'string' ? routine.timing.label.trim() : '';
  return label || formatRoutineTriggerSummaryForUser(routine.trigger);
}

function buildRoutineDeliverySignature(
  delivery: readonly string[] | undefined,
): string[] {
  return [...new Set((delivery ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase()))]
    .sort();
}

function buildRoutineScheduleSignature(
  schedule: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(schedule)) return undefined;
  const cadence = toString(schedule.cadence).trim().toLowerCase();
  if (!cadence) return undefined;
  const time = toString(schedule.time).trim();
  const dayOfWeek = toString(schedule.dayOfWeek).trim().toLowerCase();
  return {
    cadence,
    ...(time ? { time } : {}),
    ...(dayOfWeek ? { dayOfWeek } : {}),
    ...(Number.isFinite(schedule.dayOfMonth) ? { dayOfMonth: Number(schedule.dayOfMonth) } : {}),
    ...(Number.isFinite(schedule.minute) ? { minute: Number(schedule.minute) } : {}),
  };
}

function buildRoutineTimingSignature(
  timing: unknown,
): Record<string, unknown> | null {
  if (!isRecord(timing)) return null;
  const kind = toString(timing.kind).trim().toLowerCase();
  if (!kind) return null;
  const schedule = buildRoutineScheduleSignature(timing.schedule);
  const minutes = Number.isFinite(timing.minutes) ? Number(timing.minutes) : undefined;
  return {
    kind,
    ...(schedule ? { schedule } : {}),
    ...(minutes != null ? { minutes } : {}),
  };
}

function buildRoutineCreateDedupSignature(input: {
  templateId: string;
  timing?: unknown;
  defaultTiming?: unknown;
  delivery?: readonly string[];
  defaultDelivery?: readonly string[];
  config?: unknown;
}): string {
  const config = isRecord(input.config) ? input.config : null;
  return JSON.stringify({
    templateId: input.templateId.trim(),
    timing: buildRoutineTimingSignature(input.timing ?? input.defaultTiming),
    delivery: buildRoutineDeliverySignature(input.delivery ?? input.defaultDelivery),
    ...(toString(config?.focusQuery).trim()
      ? { focusQuery: toString(config?.focusQuery).trim().toLowerCase() }
      : {}),
    ...(input.templateId === 'topic-watch' && toString(config?.topicQuery).trim()
      ? { topicQuery: toString(config?.topicQuery).trim().toLowerCase() }
      : {}),
    ...(input.templateId === 'deadline-watch'
      ? {
          dueWithinHours: Number.isFinite(config?.dueWithinHours) ? Number(config?.dueWithinHours) : 24,
          includeOverdue: config?.includeOverdue !== false,
        }
      : {}),
  });
}

function buildRoutineViewDedupSignature(routine: {
  id?: string;
  templateId?: string;
  timing?: unknown;
  trigger?: { mode?: string; eventType?: string; lookaheadMinutes?: unknown };
  delivery?: string[];
  focusQuery?: string;
  topicQuery?: string;
  dueWithinHours?: number;
  includeOverdue?: boolean;
}): string {
  const templateId = toString(routine.templateId).trim() || toString(routine.id).trim();
  const timing = buildRoutineTimingSignature(routine.timing);
  const fallbackTimingKind = deriveRoutineTimingKind({
    timing: isRecord(routine.timing)
      ? { kind: toString(routine.timing.kind).trim() || undefined }
      : undefined,
    trigger: routine.trigger,
  });
  const triggerLookaheadMinutes = routine.trigger?.lookaheadMinutes;
  return JSON.stringify({
    templateId,
    timing: timing ?? (
      fallbackTimingKind
        ? {
            kind: fallbackTimingKind,
            ...(Number.isFinite(triggerLookaheadMinutes)
              ? { minutes: Number(triggerLookaheadMinutes) }
              : {}),
          }
        : null
    ),
    delivery: buildRoutineDeliverySignature(routine.delivery),
    ...(toString(routine.focusQuery).trim()
      ? { focusQuery: toString(routine.focusQuery).trim().toLowerCase() }
      : {}),
    ...(templateId === 'topic-watch' && toString(routine.topicQuery).trim()
      ? { topicQuery: toString(routine.topicQuery).trim().toLowerCase() }
      : {}),
    ...(templateId === 'deadline-watch'
      ? {
          dueWithinHours: Number.isFinite(routine.dueWithinHours) ? Number(routine.dueWithinHours) : 24,
          includeOverdue: routine.includeOverdue !== false,
        }
      : {}),
  });
}

function findMatchingRoutineForCreate(
  routines: ReadonlyArray<{
    id?: string;
    templateId?: string;
    name?: string;
    timing?: unknown;
    trigger?: { mode?: string; eventType?: string; lookaheadMinutes?: unknown };
    delivery?: string[];
    focusQuery?: string;
    topicQuery?: string;
    dueWithinHours?: number;
    includeOverdue?: boolean;
  }>,
  input: {
    templateId: string;
    timing?: unknown;
    defaultTiming?: unknown;
    delivery?: readonly string[];
    defaultDelivery?: readonly string[];
    config?: unknown;
  },
): {
  id?: string;
  name?: string;
} | null {
  const candidateSignature = buildRoutineCreateDedupSignature(input);
  return routines.find((routine) => (
    (toString(routine.templateId).trim() || toString(routine.id).trim()) === input.templateId
    && buildRoutineViewDedupSignature(routine) === candidateSignature
  )) ?? null;
}

function buildRoutineSemanticHints(
  routine: {
    id?: string;
    templateId?: string;
    name?: string;
    category?: string;
    externalCommMode?: string;
    topicQuery?: string;
    dueWithinHours?: number;
    includeOverdue?: boolean;
    delivery?: string[];
    timing?: { kind?: string };
    config?: { topicQuery?: string; dueWithinHours?: number; includeOverdue?: boolean };
    trigger?: { mode?: string; eventType?: string };
  },
): string[] {
  const hints: string[] = [];
  if (routine.category === 'scheduled') {
    hints.push('scheduled recurring');
  }
  if (routine.externalCommMode === 'draft_only') {
    hints.push('email inbox message draft reply follow up');
  }
  const timingKind = deriveRoutineTimingKind(routine);
  if (timingKind === 'after_meetings') {
    hints.push('post meeting follow up');
  }
  if (timingKind === 'before_meetings') {
    hints.push('meeting prep preparation');
  }
  if ((routine.templateId ?? routine.id) === 'topic-watch') {
    hints.push('watch notify mentions topic tracking');
  }
  if ((routine.templateId ?? routine.id) === 'deadline-watch') {
    hints.push('deadline due soon overdue task pressure reminders');
  }
  const normalizedIdentity = `${routine.id ?? ''} ${routine.templateId ?? ''} ${routine.name ?? ''} ${routineTopicQuery(routine)}`.toLowerCase();
  if (normalizedIdentity.includes('pre-meeting') || normalizedIdentity.includes('pre meeting')) {
    hints.push('meeting prep');
  }
  if (normalizedIdentity.includes('follow-up') || normalizedIdentity.includes('follow up')) {
    hints.push('follow up');
  }
  return hints;
}

const ROUTINE_CRON_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function parseRoutineCronNumber(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseRoutineCronDays(field: string): number[] | null {
  if (field === '*') return [];
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const rangeMatch = trimmed.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 7 || start > end) {
        return null;
      }
      for (let day = start; day <= end; day += 1) {
        values.add(day === 7 ? 0 : day);
      }
      continue;
    }
    const value = parseRoutineCronNumber(trimmed, 0, 7);
    if (value == null) return null;
    values.add(value === 7 ? 0 : value);
  }
  return [...values].sort((left, right) => left - right);
}

function sameRoutineDayList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function joinRoutineWords(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function formatRoutineMinute(minute: number): string {
  return minute === 0 ? 'on the hour' : `:${String(minute).padStart(2, '0')}`;
}

function formatRoutineTime(hour: number, minute: number): string {
  if (hour === 12 && minute === 0) return 'noon';
  if (hour === 0 && minute === 0) return 'midnight';
  const meridiem = hour >= 12 ? 'p.m.' : 'a.m.';
  const normalizedHour = hour % 12 || 12;
  return minute === 0
    ? `${normalizedHour} ${meridiem}`
    : `${normalizedHour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function formatRoutineLookaheadMinutes(minutes: unknown): string {
  if (!Number.isFinite(minutes)) return '';
  const value = Number(minutes);
  if (value % 1440 === 0) {
    const days = value / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function summarizeRoutineCronForUser(cron: string | undefined): string {
  const parts = toString(cron).trim().split(/\s+/g);
  if (parts.length !== 5) return 'Custom schedule';
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (/^\*\/\d+$/.test(minuteField) && hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(minuteField.slice(2));
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
  }
  const minute = parseRoutineCronNumber(minuteField, 0, 59);
  if (minute == null) return 'Custom schedule';
  if (hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return minute === 0 ? 'Hourly' : `Hourly at ${formatRoutineMinute(minute)}`;
  }
  if (/^\*\/\d+$/.test(hourField) && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(hourField.slice(2));
    if (interval === 1) {
      return minute === 0 ? 'Hourly' : `Hourly at ${formatRoutineMinute(minute)}`;
    }
    return minute === 0
      ? `Every ${interval} hours on the hour`
      : `Every ${interval} hours at ${formatRoutineMinute(minute)}`;
  }
  const hour = parseRoutineCronNumber(hourField, 0, 23);
  if (hour == null) return 'Custom schedule';
  const time = formatRoutineTime(hour, minute);
  if (dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return `Daily at ${time}`;
  }
  if (dayOfMonthField === '*' && monthField === '*') {
    const days = parseRoutineCronDays(dayOfWeekField);
    if (days) {
      if (sameRoutineDayList(days, [1, 2, 3, 4, 5])) {
        return `Weekdays at ${time}`;
      }
      if (sameRoutineDayList(days, [0, 6])) {
        return `Weekends at ${time}`;
      }
      if (days.length === 1) {
        return `Every ${ROUTINE_CRON_DAY_NAMES[days[0]]} at ${time}`;
      }
      if (days.length > 1) {
        return `Every ${joinRoutineWords(days.map((day) => ROUTINE_CRON_DAY_NAMES[day]))} at ${time}`;
      }
    }
  }
  const dayOfMonth = parseRoutineCronNumber(dayOfMonthField, 1, 31);
  if (dayOfMonth != null && monthField === '*' && dayOfWeekField === '*') {
    return `Monthly on day ${dayOfMonth} at ${time}`;
  }
  return 'Custom schedule';
}

function formatRoutineTriggerSummaryForUser(
  trigger: { mode?: string; cron?: string; eventType?: string; lookaheadMinutes?: unknown } | undefined,
): string {
  if (!trigger || typeof trigger !== 'object') return 'Run on demand';
  if (trigger.mode === 'cron') {
    return summarizeRoutineCronForUser(trigger.cron);
  }
  if (trigger.mode === 'event') {
    const label = trigger.eventType === 'upcoming_event'
      ? 'Before meetings'
      : trigger.eventType === 'event_ended'
        ? 'After meetings'
        : typeof trigger.eventType === 'string' && trigger.eventType.trim()
          ? trigger.eventType.replaceAll('_', ' ')
          : 'Event-driven';
    const lookahead = formatRoutineLookaheadMinutes(trigger.lookaheadMinutes);
    return lookahead ? `${label} · ${lookahead}` : label;
  }
  if (trigger.mode === 'horizon') {
    const lookahead = formatRoutineLookaheadMinutes(trigger.lookaheadMinutes);
    return lookahead ? `Daily agenda check · ${lookahead}` : 'Daily agenda check';
  }
  return 'Run on demand';
}

function formatBriefKindLabelForUser(kind: string): string {
  return kind
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function isDirectMailboxReplyTarget(value: unknown): value is { to: string; subject: string } {
  return isRecord(value)
    && typeof value.to === 'string'
    && typeof value.subject === 'string';
}

function isSecondBrainFocusItemType(value: string): value is SecondBrainFocusItemType {
  return value === 'note'
    || value === 'task'
    || value === 'calendar'
    || value === 'person'
    || value === 'library'
    || value === 'brief'
    || value === 'routine';
}

function normalizeSecondBrainFocusContinuationItems(value: unknown): SecondBrainFocusContinuationItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && toString(entry.id).trim().length > 0)
    .map((entry) => ({
      id: toString(entry.id).trim(),
      ...(toString(entry.label).trim() ? { label: toString(entry.label).trim() } : {}),
    }));
}

function readSecondBrainFocusContinuationState(
  continuityThread: ContinuityThreadRecord | null | undefined,
): SecondBrainFocusContinuationPayload | null {
  const state = continuityThread?.continuationState;
  if (!state || state.kind !== SECOND_BRAIN_FOCUS_CONTINUATION_KIND) return null;
  const byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>> = {};
  if (isRecord(state.payload.byType)) {
    for (const [key, rawEntry] of Object.entries(state.payload.byType)) {
      if (!isSecondBrainFocusItemType(key) || !isRecord(rawEntry)) continue;
      const items = normalizeSecondBrainFocusContinuationItems(rawEntry.items);
      if (items.length === 0) continue;
      const focusId = toString(rawEntry.focusId).trim() || undefined;
      byType[key] = {
        ...(focusId && items.some((item) => item.id === focusId) ? { focusId } : {}),
        items,
      };
    }
  }

  const legacyItemType = toString(state.payload.itemType).trim();
  if (isSecondBrainFocusItemType(legacyItemType) && !byType[legacyItemType]) {
    const items = normalizeSecondBrainFocusContinuationItems(state.payload.items);
    if (items.length > 0) {
      const focusId = toString(state.payload.focusId).trim() || undefined;
      byType[legacyItemType] = {
        ...(focusId && items.some((item) => item.id === focusId) ? { focusId } : {}),
        items,
      };
    }
  }

  const availableTypes = Object.keys(byType).filter(isSecondBrainFocusItemType);
  if (availableTypes.length === 0) return null;
  const activeItemType = toString(state.payload.activeItemType).trim();
  const preferredActive = isSecondBrainFocusItemType(activeItemType) && byType[activeItemType]
    ? activeItemType
    : isSecondBrainFocusItemType(legacyItemType) && byType[legacyItemType]
      ? legacyItemType
      : availableTypes[0];
  return {
    activeItemType: preferredActive,
    byType,
  };
}

function getSecondBrainFocusEntry(
  focusState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
): SecondBrainFocusContinuationEntry | null {
  return focusState?.byType[itemType] ?? null;
}

function buildSecondBrainFocusContinuationState(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
  items: readonly SecondBrainFocusContinuationItem[],
  options?: { preferredFocusId?: string; fallbackFocusIndex?: number; remove?: boolean; activate?: boolean },
): ContinuityThreadContinuationState | null {
  const byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>> = {};
  for (const [key, entry] of Object.entries(existingState?.byType ?? {})) {
    if (!isSecondBrainFocusItemType(key) || !entry) continue;
    byType[key] = {
      ...(entry.focusId ? { focusId: entry.focusId } : {}),
      items: entry.items.map((item) => ({ ...item })),
    };
  }

  if (options?.remove) {
    delete byType[itemType];
  } else {
    const normalizedItems = items
      .filter((item) => toString(item.id).trim().length > 0)
      .map((item) => ({
        id: toString(item.id).trim(),
        ...(toString(item.label).trim() ? { label: toString(item.label).trim() } : {}),
      }));
    if (normalizedItems.length === 0) return null;
    const preferredFocusId = toString(options?.preferredFocusId).trim();
    const fallbackIndex = Math.max(0, options?.fallbackFocusIndex ?? 0);
    const focusId = preferredFocusId && normalizedItems.some((item) => item.id === preferredFocusId)
      ? preferredFocusId
      : normalizedItems[Math.min(fallbackIndex, normalizedItems.length - 1)]?.id;
    byType[itemType] = {
      ...(focusId ? { focusId } : {}),
      items: normalizedItems,
    };
  }

  const availableTypes = Object.keys(byType).filter(isSecondBrainFocusItemType);
  if (availableTypes.length === 0) return null;
  const nextActiveItemType = options?.activate === false
    ? (
        existingState?.activeItemType && byType[existingState.activeItemType]
          ? existingState.activeItemType
          : availableTypes[0]
      )
    : (byType[itemType] ? itemType : availableTypes[0]);
  const activeEntry = byType[nextActiveItemType];
  return {
    kind: SECOND_BRAIN_FOCUS_CONTINUATION_KIND,
    payload: {
      activeItemType: nextActiveItemType,
      itemType: nextActiveItemType,
      ...(activeEntry?.focusId ? { focusId: activeEntry.focusId } : {}),
      items: activeEntry?.items.map((item) => ({ ...item })) ?? [],
      byType: Object.fromEntries(
        availableTypes.map((type) => [
          type,
          {
            ...(byType[type]?.focusId ? { focusId: byType[type]?.focusId } : {}),
            items: byType[type]?.items.map((item) => ({ ...item })) ?? [],
          },
        ]),
      ),
    },
  };
}

function buildSecondBrainFocusMetadata(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
  items: readonly SecondBrainFocusContinuationItem[],
  options?: { preferredFocusId?: string; fallbackFocusIndex?: number; remove?: boolean; activate?: boolean },
): Record<string, unknown> | undefined {
  const continuationState = buildSecondBrainFocusContinuationState(existingState, itemType, items, options);
  return continuationState ? { continuationState } : undefined;
}

function buildSecondBrainFocusRemovalMetadata(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
): Record<string, unknown> {
  return {
    continuationState: buildSecondBrainFocusContinuationState(existingState, itemType, [], { remove: true }),
  };
}

function buildDirectHandlerResponseSource(
  candidate: string,
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
  llmProviderName: string | undefined,
): ResponseSourceMetadata | null {
  const notice = candidate === 'personal_assistant'
    ? 'Handled directly by Second Brain.'
    : candidate === 'provider_read'
      ? 'Handled directly by provider tools.'
      : undefined;
  const resolvedProviderName = selectedExecutionProfile?.providerType?.trim()
    || llmProviderName?.trim()
    || '';
  const resolvedLocality = selectedExecutionProfile?.providerLocality
    ?? (resolvedProviderName ? getProviderLocalityFromName(resolvedProviderName) : undefined);
  const resolvedTier = selectedExecutionProfile?.providerTier
    ?? (resolvedProviderName ? getProviderTier(resolvedProviderName) : undefined);
  switch (candidate) {
    case 'personal_assistant':
      if (resolvedLocality) {
        return {
          locality: resolvedLocality,
          ...(resolvedProviderName ? { providerName: resolvedProviderName } : {}),
          ...(selectedExecutionProfile?.providerName
            && selectedExecutionProfile.providerName !== resolvedProviderName
            ? { providerProfileName: selectedExecutionProfile.providerName }
            : {}),
          ...(selectedExecutionProfile?.providerModel
            ? { model: selectedExecutionProfile.providerModel }
            : {}),
          ...(resolvedTier ? { providerTier: resolvedTier } : {}),
          usedFallback: false,
          ...(notice ? { notice } : {}),
        };
      }
      return {
        locality: 'local',
        providerName: 'second_brain',
        usedFallback: false,
        ...(notice ? { notice } : {}),
      };
    case 'provider_read':
      if (resolvedLocality) {
        return {
          locality: resolvedLocality,
          ...(resolvedProviderName ? { providerName: resolvedProviderName } : {}),
          ...(selectedExecutionProfile?.providerName
            && selectedExecutionProfile.providerName !== resolvedProviderName
            ? { providerProfileName: selectedExecutionProfile.providerName }
            : {}),
          ...(selectedExecutionProfile?.providerModel
            ? { model: selectedExecutionProfile.providerModel }
            : {}),
          ...(resolvedTier ? { providerTier: resolvedTier } : {}),
          usedFallback: false,
          ...(notice ? { notice } : {}),
        };
      }
      return {
        locality: 'local',
        providerName: 'control_plane',
        usedFallback: false,
        ...(notice ? { notice } : {}),
      };
    default:
      return null;
  }
}

function extractQuotedText(text: string): string {
  const match = matchWithCollapsedWhitespaceFallback(text, /(["'])([\s\S]+?)\1/);
  return match?.[2]?.trim() ?? '';
}

const SECOND_BRAIN_WRAPPED_WORD_PREFIX_EXCLUSIONS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'up',
  'via',
  'with',
]);

function normalizeSecondBrainInlineFieldValue(value: string): string {
  const repairedWrappedWords = value.replace(
    /\b([A-Za-z]{3,4})\s*\n\s+([a-z]{2,})\b/g,
    (_fullMatch, left: string, right: string) => {
      if (SECOND_BRAIN_WRAPPED_WORD_PREFIX_EXCLUSIONS.has(left.toLowerCase())) {
        return `${left} ${right}`;
      }
      return `${left}${right}`;
    },
  );
  return collapseWhitespaceForSecondBrainParsing(repairedWrappedWords);
}

function normalizeSecondBrainReadQueryValue(value: string): string {
  return normalizeSecondBrainInlineFieldValue(value).replace(/^[("'`\s]+|[)"'`.,!?;:\s]+$/g, '').trim();
}

function extractSecondBrainTextBody(text: string): string {
  const sayingMatch = text.match(/\b(?:saying|say|says|write|content)\b\s*:?\s*(["'])([\s\S]+?)\1/i);
  if (sayingMatch?.[2]?.trim()) {
    return sayingMatch[2].trim();
  }
  return extractQuotedText(text);
}

function extractExplicitNamedSecondBrainTitle(text: string): string {
  const namedMatch = matchWithCollapsedWhitespaceFallback(text, /\b(?:called|named|titled)\s*(["'])([\s\S]+?)\1/i);
  return normalizeSecondBrainInlineFieldValue(namedMatch?.[2]?.trim() ?? '');
}

function extractNamedSecondBrainTitle(text: string): string {
  const explicit = extractExplicitNamedSecondBrainTitle(text);
  if (explicit) {
    return explicit;
  }
  return normalizeSecondBrainInlineFieldValue(extractQuotedText(text));
}

function extractRetitledSecondBrainTitle(text: string): string {
  const patterns = [
    /\brename\b[\s\S]*?\bto\b\s*(["'])([\s\S]+?)\1/i,
    /\b(?:change|update)\b[\s\S]*?\btitle\b[\s\S]*?\bto\b\s*(["'])([\s\S]+?)\1/i,
  ];
  for (const pattern of patterns) {
    const match = matchWithCollapsedWhitespaceFallback(text, pattern);
    const candidate = normalizeSecondBrainInlineFieldValue(match?.[2]?.trim() ?? '');
    if (candidate) {
      return candidate;
    }
  }
  return '';
}

function extractSecondBrainTaskStatus(text: string): 'todo' | 'in_progress' | 'done' | undefined {
  if (/\b(done|complete|completed|finish|finished)\b/i.test(text)) {
    return 'done';
  }
  if (/\b(in[\s-]?progress|started|working on)\b/i.test(text)) {
    return 'in_progress';
  }
  if (/\b(to[\s-]?do|todo|not started)\b/i.test(text)) {
    return 'todo';
  }
  return undefined;
}

function extractSecondBrainTaskPriority(text: string): 'low' | 'medium' | 'high' | undefined {
  const labeled = matchWithCollapsedWhitespaceFallback(
    text,
    /\bpriority\b(?:\s+(?:is|to|as|for|with|include|including))?\s*:?\s*(high|medium|low)\b/i,
  );
  if (labeled?.[1]) {
    return labeled[1].trim().toLowerCase() as 'low' | 'medium' | 'high';
  }
  const inline = matchWithCollapsedWhitespaceFallback(text, /\b(high|medium|low)\s+priority\b/i);
  if (inline?.[1]) {
    return inline[1].trim().toLowerCase() as 'low' | 'medium' | 'high';
  }
  return undefined;
}

function extractQuotedLabeledValue(text: string, labels: string[]): string {
  const escaped = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(`\\b(?:${escaped})\\b(?:\\s+(?:is|to|as|for|with|include|including))?\\s*:?\\s*([\"'])([\\s\\S]+?)\\1`, 'i');
  const match = matchWithCollapsedWhitespaceFallback(text, pattern);
  return match?.[2]?.trim() ?? '';
}

function extractEmailAddressFromText(text: string): string {
  const match = matchWithCollapsedWhitespaceFallback(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0]?.trim() ?? '';
}

function normalizePhoneNumber(text: string): string {
  const trimmed = text.trim().replace(/^[("']+|[)"',.;:]+$/g, '');
  if (!trimmed) return '';
  const digitCount = trimmed.replace(/\D+/g, '').length;
  if (digitCount < 6) return '';
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return '';
  return trimmed.replace(/\s+/g, ' ');
}

function extractPhoneNumberFromText(text: string): string {
  const labeled = normalizePhoneNumber(extractQuotedLabeledValue(text, ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'tel']));
  if (labeled) {
    return labeled;
  }
  const match = matchWithCollapsedWhitespaceFallback(text, /\b(?:phone(?:\s+number)?|mobile(?:\s+number)?|telephone|tel)\b(?:\s+(?:is|to|as|for|with|include|including))?\s*:?[\s"']*([+()\d][\d\s().-]{4,}\d)/i);
  return normalizePhoneNumber(match?.[1] ?? '');
}

function extractUrlFromText(text: string): string {
  const labeled = extractQuotedLabeledValue(text, ['url', 'link']);
  if (labeled) {
    return labeled;
  }
  const match = matchWithCollapsedWhitespaceFallback(text, /\bhttps?:\/\/[^\s"'`<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '').trim() ?? '';
}

function collapseWhitespaceForSecondBrainParsing(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function matchWithCollapsedWhitespaceFallback(
  text: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  const directMatch = text.match(pattern);
  if (directMatch) {
    return directMatch;
  }
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (!collapsed || collapsed === text) {
    return null;
  }
  return collapsed.match(pattern);
}

const SECOND_BRAIN_PERSON_NAME_IGNORE = new Set([
  'second brain',
  'google workspace',
  'microsoft 365',
  'ollama cloud',
  'guardian agent',
  'guardian',
]);
const SECOND_BRAIN_PERSON_NAME_FIELD_PATTERN = /^(?:with|phone|email|title|company|location|notes?)\b/i;

function isPlausibleSecondBrainPersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (SECOND_BRAIN_PERSON_NAME_IGNORE.has(lower)) return false;
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][A-Za-z'-]+$/.test(word));
}

function skipSecondBrainWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
}

function skipSecondBrainNameLeadSeparators(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (text.startsWith('...', index)) {
      index += 3;
      continue;
    }
    if (char === '…') {
      index += 1;
      continue;
    }
    if ('-,:;()'.includes(char)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function readSecondBrainPersonNameWord(
  text: string,
  start: number,
): { word: string; nextIndex: number } | null {
  const match = text.slice(start).match(/^[A-Z][A-Za-z'-]+/);
  if (!match?.[0]) {
    return null;
  }
  return {
    word: match[0],
    nextIndex: start + match[0].length,
  };
}

function hasSecondBrainPersonNameBoundary(text: string, start: number): boolean {
  const boundaryIndex = skipSecondBrainWhitespace(text, start);
  if (boundaryIndex >= text.length) {
    return true;
  }
  if (text.startsWith('...', boundaryIndex) || text.startsWith('…', boundaryIndex)) {
    return true;
  }
  const boundaryChar = text[boundaryIndex] ?? '';
  if (',.;:()'.includes(boundaryChar)) {
    return true;
  }
  return SECOND_BRAIN_PERSON_NAME_FIELD_PATTERN.test(text.slice(boundaryIndex));
}

function extractSecondBrainLeadingPersonName(text: string, start = 0): string {
  let index = skipSecondBrainWhitespace(text, start);
  const words: string[] = [];
  while (words.length < 4) {
    const nextWord = readSecondBrainPersonNameWord(text, index);
    if (!nextWord) {
      break;
    }
    words.push(nextWord.word);
    index = nextWord.nextIndex;
    const nextIndex = skipSecondBrainWhitespace(text, index);
    if (nextIndex === index) {
      break;
    }
    index = nextIndex;
    if (!readSecondBrainPersonNameWord(text, index)) {
      break;
    }
  }
  if (words.length < 2) {
    return '';
  }
  return hasSecondBrainPersonNameBoundary(text, index) ? words.join(' ') : '';
}

function collectSecondBrainFallbackPersonNameCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char < 'A' || char > 'Z') {
      continue;
    }
    const previous = text[index - 1] ?? '';
    if ((previous >= 'A' && previous <= 'Z') || (previous >= 'a' && previous <= 'z') || previous === '\'' || previous === '-') {
      continue;
    }
    const candidate = extractSecondBrainLeadingPersonName(text, index);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    index += candidate.length - 1;
  }
  return candidates;
}

function extractSecondBrainFallbackPersonName(text: string): string {
  const labeled = normalizeSecondBrainInlineFieldValue(extractQuotedLabeledValue(text, ['name']));
  if (isPlausibleSecondBrainPersonName(labeled)) {
    return labeled;
  }

  const candidateTexts = [text];
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (collapsed && collapsed !== text) {
    candidateTexts.push(collapsed);
  }
  for (const candidateText of candidateTexts) {
    for (const match of candidateText.matchAll(/\b(?:named|called)\b/gi)) {
      const candidate = extractSecondBrainLeadingPersonName(candidateText, (match.index ?? 0) + match[0].length);
      if (isPlausibleSecondBrainPersonName(candidate)) {
        return candidate;
      }
    }
    for (const match of candidateText.matchAll(/\b(?:person|contact)\b(?:\s+in\s+my\s+second\s+brain\b)?/gi)) {
      const candidate = extractSecondBrainLeadingPersonName(
        candidateText,
        skipSecondBrainNameLeadSeparators(candidateText, (match.index ?? 0) + match[0].length),
      );
      if (isPlausibleSecondBrainPersonName(candidate)) {
        return candidate;
      }
    }
    const leadingCandidate = extractSecondBrainLeadingPersonName(candidateText);
    if (isPlausibleSecondBrainPersonName(leadingCandidate)) {
      return leadingCandidate;
    }
  }

  const candidates = collectSecondBrainFallbackPersonNameCandidates(candidateTexts.join('\n'))
    .filter(isPlausibleSecondBrainPersonName);
  return candidates[candidates.length - 1] ?? '';
}

function extractSecondBrainPersonRelationship(
  text: string,
): 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined {
  const match = matchWithCollapsedWhitespaceFallback(text, /\b(?:relationship|as|mark(?:ed)?\s+as)\s+(?:a\s+)?(work|personal|family|vendor|other)\b/i);
  return match?.[1]?.trim().toLowerCase() as 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined;
}

function extractSecondBrainReadTopicQuery(text: string): string {
  const candidateTexts = [text];
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (collapsed && collapsed !== text) {
    candidateTexts.push(collapsed);
  }

  const patterns = [
    /\b(?:about|for|related to|matching)\b\s*(["'])([\s\S]+?)\1/i,
    /\b(?:about|for|related to|matching)\b\s+(.+?)(?=$|[.?!])/i,
  ];
  for (const candidateText of candidateTexts) {
    for (const pattern of patterns) {
      const match = candidateText.match(pattern);
      const candidate = normalizeSecondBrainReadQueryValue(match?.[2] ?? match?.[1] ?? '');
      if (candidate) {
        return candidate;
      }
    }
  }
  return '';
}

function resolveDirectSecondBrainReadQuery(
  text: string,
  itemType: string,
  decision: IntentGatewayDecision,
): { query: string; exactMatch?: boolean } | null {
  const explicitQuery = normalizeSecondBrainReadQueryValue(toString(decision.entities.query));
  if (explicitQuery) {
    return { query: explicitQuery };
  }

  switch (itemType) {
    case 'person': {
      const quoted = normalizeSecondBrainReadQueryValue(extractQuotedText(text));
      if (quoted) {
        return { query: quoted, exactMatch: true };
      }
      const named = normalizeSecondBrainReadQueryValue(extractSecondBrainFallbackPersonName(text));
      if (named) {
        return { query: named, exactMatch: true };
      }
      return null;
    }
    case 'library': {
      const topicQuery = extractSecondBrainReadTopicQuery(text);
      if (topicQuery) {
        return { query: topicQuery };
      }
      const quoted = normalizeSecondBrainReadQueryValue(extractQuotedText(text));
      return quoted ? { query: quoted } : null;
    }
    default:
      return null;
  }
}

function normalizeRoutineNameForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeRoutineTemplateIdForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractRoutineEnabledState(text: string): boolean | undefined {
  if (/\b(?:disable|disabled|pause|paused|deactivate|turn\s+off|stop)\b/i.test(text)) {
    return false;
  }
  if (/\b(?:enable|enabled|resume|resumed|activate|turn\s+on|start)\b/i.test(text)) {
    return true;
  }
  return undefined;
}

function extractSecondBrainRoutingBias(
  text: string,
): 'local_first' | 'balanced' | 'quality_first' | undefined {
  if (/\bquality[\s_-]*first\b/i.test(text)) {
    return 'quality_first';
  }
  if (/\blocal[\s_-]*first\b/i.test(text)) {
    return 'local_first';
  }
  if (/\bbalanced\b/i.test(text)) {
    return 'balanced';
  }
  return undefined;
}

function extractRoutineDeliveryDefaults(
  text: string,
): Array<'web' | 'cli' | 'telegram'> | undefined {
  if (!/\b(?:deliver|delivery|channel|channels|surface|surfaces|send)\b/i.test(text)) {
    return undefined;
  }
  const channels: Array<'web' | 'cli' | 'telegram'> = [];
  if (/\bweb\b/i.test(text)) channels.push('web');
  if (/\bcli\b/i.test(text)) channels.push('cli');
  if (/\btelegram\b/i.test(text)) channels.push('telegram');
  return channels.length > 0 ? channels : undefined;
}

function extractRoutineLookaheadMinutes(text: string): number | undefined {
  if (!/\blookahead\b|\bwindow\b/i.test(text)) {
    return undefined;
  }
  const match = text.match(/\b(\d{1,5})\s*(?:minute|minutes|min)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractQuotedPhrase(text: string): string | undefined {
  const match = text.match(/["“]([^"”]+)["”]/);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

const ROUTINE_SCHEDULE_WEEKDAY_MAP: Record<string, 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'> = {
  sunday: 'sunday',
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
};

function parseRoutineClockTimePhrase(text: string): string | undefined {
  const match = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    ?? text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):(\d{2})\b/);
  if (!match) return undefined;
  const hourRaw = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  let hour = hourRaw;
  if (meridiem === 'am') {
    hour = hourRaw === 12 ? 0 : hourRaw;
  } else if (meridiem === 'pm') {
    hour = hourRaw === 12 ? 12 : hourRaw + 12;
  }
  if (hour < 0 || hour > 23) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function extractRoutineScheduleTiming(text: string): Record<string, unknown> | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/\b(?:manual only|run on demand|manually)\b/i.test(normalized)) {
    return { kind: 'manual' };
  }
  const hourlyMatch = normalized.match(/\b(?:every|each)\s+hour\b(?:\s+at\s+(?:minute\s+)?)?[: ]?(\d{1,2})?\b/i);
  if (hourlyMatch) {
    const minute = Number(hourlyMatch[1] ?? '0');
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      return {
        kind: 'scheduled',
        schedule: {
          cadence: 'hourly',
          minute,
        },
      };
    }
  }
  const time = parseRoutineClockTimePhrase(normalized);
  if (!time) return undefined;
  if (/\b(?:weekdays|every weekday|each weekday)\b/i.test(normalized)) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'weekdays',
        time,
      },
    };
  }
  const fortnightlyMatch = normalized.match(/\b(?:fortnightly|biweekly|bi-weekly|every 2 weeks|every other)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (fortnightlyMatch?.[1]) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'fortnightly',
        dayOfWeek: ROUTINE_SCHEDULE_WEEKDAY_MAP[fortnightlyMatch[1].toLowerCase()],
        time,
      },
    };
  }
  const weekdayMatch = normalized.match(/\b(?:every|weekly on|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekdayMatch?.[1]) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'weekly',
        dayOfWeek: ROUTINE_SCHEDULE_WEEKDAY_MAP[weekdayMatch[1].toLowerCase()],
        time,
      },
    };
  }
  const monthlyMatch = normalized.match(/\b(?:monthly|every month|each month)\s+(?:on\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monthlyMatch?.[1]) {
    const dayOfMonth = Number(monthlyMatch[1]);
    if (Number.isFinite(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31) {
      return {
        kind: 'scheduled',
        schedule: {
          cadence: 'monthly',
          dayOfMonth,
          time,
        },
      };
    }
  }
  if (/\b(?:daily|every day|each day)\b/i.test(normalized)) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'daily',
        time,
      },
    };
  }
  return undefined;
}

function extractRoutineTopicWatchQuery(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const quoted = extractQuotedPhrase(normalized);
  if (quoted) return quoted;
  const trailingMatch = normalized.match(/\b(?:mention|mentions|mentioned|about|related to|watch for|watch)\s+(.+?)(?:[.?!]|$)/i);
  const topicQuery = trailingMatch?.[1]?.trim();
  return topicQuery || undefined;
}

function extractRoutineFocusQuery(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const quoted = extractQuotedPhrase(normalized);
  if (quoted) return quoted;
  const match = normalized.match(/\b(?:for|about|related to|focused on|focus on)\s+(.+?)(?=\s+\b(?:every|each|daily|weekdays|weekly|fortnightly|monthly|at|before|after|on)\b|[.?!]|$)/i);
  const focusQuery = match?.[1]?.trim();
  return focusQuery || undefined;
}

function extractRoutineDueWithinHours(text: string): number | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const hourMatch = normalized.match(/\b(\d{1,3})\s*(?:hour|hours)\b/i);
  if (hourMatch?.[1]) {
    const value = Number(hourMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (/\btomorrow\b/i.test(normalized)) return 24;
  if (/\bnext\s+week\b/i.test(normalized)) return 24 * 7;
  return undefined;
}

function extractRoutineIncludeOverdue(text: string): boolean | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/\b(?:include|with)\s+overdue\b/i.test(normalized) || /\boverdue\b/i.test(normalized)) {
    return true;
  }
  if (/\b(?:without|exclude|excluding|ignore)\s+overdue\b/i.test(normalized) || /\bupcoming tasks only\b/i.test(normalized)) {
    return false;
  }
  return undefined;
}

function extractCustomSecondBrainRoutineCreate(
  text: string,
): {
  templateId: 'topic-watch' | 'deadline-watch' | 'scheduled-review';
  config: Record<string, unknown>;
} | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (
    /\b(?:scheduled\s+review|review)\b/i.test(normalized)
    && /\b(?:every|each|hourly|daily|weekdays|weekly|fortnightly|monthly|biweekly|bi-weekly|every 2 weeks)\b/i.test(normalized)
  ) {
    return {
      templateId: 'scheduled-review',
      config: {},
    };
  }

  if (/\b(?:due|deadline|overdue)\b/i.test(normalized)) {
    const dueWithinHours = extractRoutineDueWithinHours(normalized);
    const includeOverdue = extractRoutineIncludeOverdue(normalized);
    return {
      templateId: 'deadline-watch',
      config: {
        ...(Number.isFinite(dueWithinHours) ? { dueWithinHours } : {}),
        ...(typeof includeOverdue === 'boolean' ? { includeOverdue } : {}),
      },
    };
  }

  if (/\b(?:mention|mentions|mentioned|about|related to|watch for|watch)\b/i.test(normalized)) {
    const topicQuery = extractRoutineTopicWatchQuery(normalized);
    if (topicQuery) {
      return {
        templateId: 'topic-watch',
        config: { topicQuery },
      };
    }
  }

  return null;
}

function normalizeRoutineTriggerModeForTool(
  value: unknown,
): 'cron' | 'event' | 'horizon' | 'manual' | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'cron':
    case 'event':
    case 'horizon':
    case 'manual':
      return normalized;
    default:
      return undefined;
  }
}

function normalizeRoutineEventTypeForTool(
  value: unknown,
): 'upcoming_event' | 'event_ended' | 'task_due' | 'task_overdue' | undefined {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
  switch (normalized) {
    case 'upcoming':
    case 'upcoming_event':
      return 'upcoming_event';
    case 'ended':
    case 'event_ended':
      return 'event_ended';
    case 'task_due':
    case 'due':
      return 'task_due';
    case 'task_overdue':
    case 'overdue':
      return 'task_overdue';
    default:
      return undefined;
  }
}

function buildToolSafeRoutineTrigger(
  trigger: Record<string, unknown> | undefined,
  fallbackTrigger?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const mode = normalizeRoutineTriggerModeForTool(trigger?.mode) ?? normalizeRoutineTriggerModeForTool(fallbackTrigger?.mode);
  if (!mode) return undefined;

  if (mode === 'manual') {
    return { mode };
  }

  if (mode === 'cron') {
    const cron = toString(trigger?.cron).trim() || toString(fallbackTrigger?.cron).trim();
    return cron ? { mode, cron } : { mode };
  }

  if (mode === 'event') {
    const eventType = normalizeRoutineEventTypeForTool(trigger?.eventType)
      ?? normalizeRoutineEventTypeForTool(fallbackTrigger?.eventType);
    const lookaheadMinutes = Number.isFinite(trigger?.lookaheadMinutes)
      ? Number(trigger?.lookaheadMinutes)
      : Number.isFinite(fallbackTrigger?.lookaheadMinutes)
        ? Number(fallbackTrigger?.lookaheadMinutes)
        : undefined;
    return {
      mode,
      ...(eventType ? { eventType } : {}),
      ...(lookaheadMinutes != null ? { lookaheadMinutes } : {}),
    };
  }

  const lookaheadMinutes = Number.isFinite(trigger?.lookaheadMinutes)
    ? Number(trigger?.lookaheadMinutes)
    : Number.isFinite(fallbackTrigger?.lookaheadMinutes)
      ? Number(fallbackTrigger?.lookaheadMinutes)
      : undefined;
  return {
    mode,
    ...(lookaheadMinutes != null ? { lookaheadMinutes } : {}),
  };
}

const GMAIL_UNREAD_CONTINUATION_KIND = 'gmail_unread_list';
const GMAIL_RECENT_SENDERS_CONTINUATION_KIND = 'gmail_recent_senders_list';
const GMAIL_RECENT_SUMMARY_CONTINUATION_KIND = 'gmail_recent_summary_list';
const M365_UNREAD_CONTINUATION_KIND = 'm365_unread_list';
const M365_RECENT_SENDERS_CONTINUATION_KIND = 'm365_recent_senders_list';
const M365_RECENT_SUMMARY_CONTINUATION_KIND = 'm365_recent_summary_list';

export interface ChatAgentClassDeps {
  log: Logger;
}

export interface ChatAgentPublicApi extends BaseAgent {
  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null;
  hasSuspendedApproval(approvalId: string, scope?: ApprovalContinuationScope): boolean;
  hasAutomationApprovalContinuation(approvalId: string): boolean;
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
  continueDirectRouteAfterApproval(
    pendingAction: PendingActionRecord | null,
    approvalId: string,
    decision: 'approved' | 'denied',
    approvalResult?: ToolApprovalDecisionResult,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null>;
  continueAutomationAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
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
    intentGateway?: IntentGateway,
    resolveAssistantResponseStyle?: () => AssistantResponseStyleConfig | undefined,
  ): ChatAgentPublicApi;
}

export function createChatAgentClass({ log }: ChatAgentClassDeps): ChatAgentConstructor {
interface SuspendedSession {
  scope: Required<ApprovalContinuationScope>;
  llmMessages: import('./llm/types.js').ChatMessage[];
  pendingTools: StoredToolLoopPendingTool[];
  originalMessage: UserMessage;
  ctx: AgentContext;
}

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
  /** Suspended tool loops waiting for approval, keyed by logical chat surface. */
  private suspendedSessions = new Map<string, SuspendedSession>();
  /** Approval follow-up copy, prompt formatting, and remediation continuations. */
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
    intentGateway?: IntentGateway,
    resolveAssistantResponseStyle?: () => AssistantResponseStyleConfig | undefined,
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
      tools,
    });
    this.intentGateway = intentGateway ?? new IntentGateway();
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
  ): { content: string; metadata?: Record<string, unknown> } | null {
    if (!this.tools?.isEnabled()) return null;
    const normalized = stripLeadingContextPrefix(message.content).replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const asksForPendingApprovals = /^pending approvals?\??$/i.test(normalized)
      || /(?:\bwhat\b|\bwhich\b|\bshow\b|\blist\b|\bare there\b|\bdo i have\b|\bany\b|\bcurrent\b).*(?:\bpending approvals?\b|\bapprovals?\b.*\bpending\b)/i.test(normalized)
      || /(?:\bpending approvals?\b|\bapprovals?\b.*\bpending\b).*\b(?:right now|currently|today)\b/i.test(normalized);
    if (!asksForPendingApprovals) return null;

    const surfaceId = this.getCodeSessionSurfaceId(message);
    let pendingAction = this.getPendingApprovalAction(message.userId, message.channel, surfaceId);
    if (!pendingAction) {
      const liveApprovalIds = this.tools.listPendingApprovalIdsForUser?.(message.userId, message.channel, {
        includeUnscoped: message.channel === 'web',
      }) ?? [];
      if (liveApprovalIds.length > 0) {
        this.setPendingApprovals(`${message.userId}:${message.channel}`, liveApprovalIds, surfaceId);
        pendingAction = this.getPendingApprovalAction(message.userId, message.channel, surfaceId);
      }
    }

    const approvalIds = pendingAction?.blocker.approvalIds ?? [];
    const summaries = approvalIds.length > 0
      ? this.tools.getApprovalSummaries?.(approvalIds)
      : undefined;
    const content = this.formatPendingApprovalPrompt(approvalIds, summaries);
    const pendingActionMeta = toPendingActionClientMetadata(pendingAction);
    return {
      content,
      metadata: pendingActionMeta ? { pendingAction: pendingActionMeta } : undefined,
    };
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

  private shouldPreferAnswerFirstForSkills(skills: readonly ResolvedSkill[]): boolean {
    return skills.some((skill) => (
      skill.id === 'writing-plans'
      || skill.id === 'verification-before-completion'
      || skill.id === 'code-review'
    ));
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
      isResponseDegraded: (content) => this.isResponseDegraded(content),
    });
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
    if (!this.fallbackChain) {
      return ctx.llm!.chat(messages, options);
    }
    const preferredOrder = Array.isArray(fallbackProviderOrder) && fallbackProviderOrder.length > 0
      ? fallbackProviderOrder
      : undefined;
    try {
      return await ctx.llm!.chat(messages, options);
    } catch (primaryError) {
      log.warn(
        { agent: this.id, error: primaryError instanceof Error ? primaryError.message : String(primaryError) },
        'Primary LLM failed, trying fallback chain',
      );
      const result = preferredOrder
        ? await this.fallbackChain.chatWithFallbackAfterProvider(ctx.llm?.name ?? 'unknown', preferredOrder, messages, options)
        : await this.fallbackChain.chatWithFallback(messages, options);
      return result.response;
    }
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
    const primaryProviderName = ctx.llm?.name ?? 'unknown';
    const primaryProviderLocality = getProviderLocalityFromName(primaryProviderName);
    const preferredOrder = Array.isArray(fallbackProviderOrder) && fallbackProviderOrder.length > 0
      ? fallbackProviderOrder
      : undefined;

    if (!this.fallbackChain) {
      try {
        const startedAt = Date.now();
        const response = await ctx.llm!.chat(messages, options);
        return {
          response,
          providerName: primaryProviderName,
          providerLocality: primaryProviderLocality,
          usedFallback: false,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      } catch (primaryError) {
        if (primaryProviderLocality === 'local' && isLocalToolCallParseError(primaryError)) {
          if (shouldBypassLocalModelComplexityGuard()) {
            throw primaryError;
          }
          throw new Error(buildLocalModelTooComplicatedMessage());
        }
        throw primaryError;
      }
    }

    try {
      const startedAt = Date.now();
      const response = await ctx.llm!.chat(messages, options);
      return {
        response,
        providerName: primaryProviderName,
        providerLocality: primaryProviderLocality,
        usedFallback: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (primaryError) {
      log.warn(
        { agent: this.id, error: primaryError instanceof Error ? primaryError.message : String(primaryError) },
        'Primary LLM failed, trying fallback chain',
      );

      if (primaryProviderLocality === 'local' && isLocalToolCallParseError(primaryError)) {
        if (shouldBypassLocalModelComplexityGuard()) {
          throw primaryError;
        }
        try {
          const startedAt = Date.now();
          const result = preferredOrder
            ? await this.fallbackChain.chatWithFallbackAfterProvider(primaryProviderName, preferredOrder, messages, options)
            : await this.fallbackChain.chatWithFallbackAfterPrimary(messages, options);
          return {
            response: result.response,
            providerName: result.providerName,
            providerLocality: getProviderLocalityFromName(result.providerName),
            usedFallback: true,
            notice: 'Retried with an alternate model after the local model failed to format a tool call.',
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        } catch (fallbackError) {
          log.warn(
            { agent: this.id, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) },
            'No alternate model available after local tool-call parsing failure',
          );
          throw new Error(buildLocalModelTooComplicatedMessage());
        }
      }

      const startedAt = Date.now();
      const result = preferredOrder
        ? await this.fallbackChain.chatWithFallbackAfterProvider(primaryProviderName, preferredOrder, messages, options)
        : await this.fallbackChain.chatWithFallback(messages, options);
      return {
        response: result.response,
        providerName: result.providerName,
        providerLocality: getProviderLocalityFromName(result.providerName),
        usedFallback: result.usedFallback || result.providerName !== primaryProviderName,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  async onMessage(message: UserMessage, ctx: AgentContext, workerManager?: WorkerManager): Promise<AgentResponse> {
    const stateAgentId = this.stateAgentId;
    const pendingActionSurfaceId = this.getCodeSessionSurfaceId(message);
    const suspendedScope = normalizeApprovalContinuationScope({
      userId: message.userId,
      channel: message.channel,
      surfaceId: pendingActionSurfaceId,
    });
    const suspendedSessionKey = buildApprovalContinuationScopeKey(suspendedScope);
    const isContinuation = message.content.includes('[User approved the pending tool action(s)')
      || message.content.includes('Tool actions have been decided');
    const suspended = isContinuation ? this.suspendedSessions.get(suspendedSessionKey) : undefined;
    const continuationMetadata = suspended?.originalMessage.metadata;
    const effectiveMessage: UserMessage = continuationMetadata
      ? {
          ...message,
          metadata: {
            ...continuationMetadata,
            ...(message.metadata ?? {}),
          },
        }
      : message;
    const requestedCodeContext = readCodeRequestMetadata(effectiveMessage.metadata);
    let resolvedCodeSession = this.resolveCodeSessionContext(effectiveMessage);
    if (resolvedCodeSession) {
      resolvedCodeSession = this.refreshCodeSessionWorkspaceAwareness(
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
    const priorHistory = this.conversationService?.getHistoryForContext({
      agentId: stateAgentId,
      userId: conversationUserId,
      channel: conversationChannel,
    }, {
      query: stripLeadingContextPrefix(scopedMessage.content),
    }) ?? [];
    let continuityThread = this.touchContinuityThread(
      pendingActionUserId,
      pendingActionChannel,
      pendingActionSurfaceId,
      effectiveCodeContext?.sessionId,
    );
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
    const approvalResult = await this.tryHandleApproval(message, ctx);
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

    // Classify intent early — session control is a control-plane operation that must
    // be handled before the worker path (which would scope the userId to the code-session
    // and return incomplete results). The gateway result is reused later to avoid a
    // redundant LLM call in the non-worker direct-intent routing path.
    const preRoutedGateway = readPreRoutedIntentGatewayMetadata(groundedScopedMessage.metadata);
    let earlyGateway: import('./runtime/intent-gateway.js').IntentGatewayRecord | null = shouldReusePreRoutedIntentGateway(preRoutedGateway)
      ? preRoutedGateway
      : null;
    const pendingAction = this.getActivePendingAction(pendingActionUserId, pendingActionChannel, pendingActionSurfaceId);
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
          conversationKey,
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
      });
      if (resolvedGatewayContent && resolvedGatewayContent !== groundedScopedMessage.content) {
        routedScopedMessage = {
          ...groundedScopedMessage,
          content: resolvedGatewayContent,
        };
      }
      continuityThread = this.updateContinuityThreadFromIntent({
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
        ? this.tryDirectRecentToolReport(routedScopedMessage)
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

    const requestIntentContent = (isContinuation && suspended)
      ? suspended.originalMessage.content
      : routedScopedMessage.content;
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

    if (isContinuation && suspended) {
      llmMessages = [...suspended.llmMessages];
      const allJobs = this.tools?.listJobs(100) ?? [];
      for (const pending of suspended.pendingTools) {
        const job = allJobs.find(j => j.id === pending.jobId);
        const resultObj = buildToolResultPayloadFromJob(job);
        llmMessages.push({
          role: 'tool',
          toolCallId: pending.toolCallId,
          content: JSON.stringify(resultObj),
        });
      }
      this.suspendedSessions.delete(suspendedSessionKey);
      skipDirectTools = true;
    } else {
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
    }

    let finalContent = '';
    let pendingActionMeta: Record<string, unknown> | undefined;
    let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
    let toolLoopPendingResume: PendingActionRecord['resume'] | undefined;
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

    if (workerManager) {
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
        const workerToolContext = this.tools?.getToolContext({
          userId: conversationUserId,
          principalId: message.principalId ?? conversationUserId,
          channel: conversationChannel,
          codeContext: effectiveCodeContext,
          requestText: routedScopedMessage.content,
          ...(selectedExecutionProfile ? { toolContextMode: selectedExecutionProfile.toolContextMode } : {}),
        }) ?? '';
        const workerRuntimeNotices = (this.tools?.getRuntimeNotices() ?? [])
          .slice(0, Math.max(0, selectedExecutionProfile?.maxRuntimeNotices ?? Number.MAX_SAFE_INTEGER));
        const workerAdditionalSections = this.buildPromptAdditionalSections(
          workerSkillPromptMaterial,
          earlyGateway?.decision,
          selectedExecutionProfile,
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
          executionProfile: selectedExecutionProfile,
        });
        const continuitySummary = summarizeContinuityThreadForGateway(continuityThread);
        // Attach codeContext to the message metadata so the worker can forward it
        // through the broker to the tool executor for auto-approve decisions.
        const workerMetadata = attachPreRoutedIntentGatewayMetadata(
          effectiveCodeContext
            ? { ...routedScopedMessage.metadata, codeContext: effectiveCodeContext }
            : routedScopedMessage.metadata,
          shouldReusePreRoutedIntentGateway(earlyGateway) ? earlyGateway : null,
        );
        const workerMessage = workerMetadata
          ? { ...routedScopedMessage, metadata: workerMetadata }
          : routedScopedMessage;
        const result = await workerManager.handleMessage({
          sessionId: `${conversationUserId}:${conversationChannel}`,
          agentId: this.id,
          userId: conversationUserId,
          grantedCapabilities: [...ctx.capabilities],
          message: workerMessage,
          systemPrompt: workerSystemPrompt,
          history: priorHistory,
          knowledgeBases: promptKnowledge.knowledgeBases,
          activeSkills: preResolvedSkills,
          additionalSections: workerAdditionalSections,
          toolContext: workerToolContext,
          runtimeNotices: workerRuntimeNotices,
          executionProfile: selectedExecutionProfile ?? undefined,
          continuity: continuitySummary,
          pendingAction: this.buildPendingActionPromptContext(pendingAction),
          pendingApprovalNotice,
          delegation: {
            requestId: message.id,
            originChannel: message.channel,
            ...(message.surfaceId ? { originSurfaceId: message.surfaceId } : {}),
            ...(continuitySummary?.continuityKey ? { continuityKey: continuitySummary.continuityKey } : {}),
            ...(continuitySummary?.activeExecutionRefs?.length ? { activeExecutionRefs: continuitySummary.activeExecutionRefs } : {}),
            ...(pendingAction?.id ? { pendingActionId: pendingAction.id } : {}),
            ...(resolvedCodeSession?.session.id ? { codeSessionId: resolvedCodeSession.session.id } : {}),
          },
        });
        const workerMeta: Record<string, unknown> = { ...(result.metadata ?? {}) };
        // Ensure responseSource is present — if the worker didn't provide one,
        // derive it from the primary provider context.
        if (!workerMeta.responseSource) {
          const primaryName = selectedExecutionProfile?.providerType || ctx.llm?.name || 'unknown';
          workerMeta.responseSource = {
            locality: selectedExecutionProfile?.providerLocality ?? getProviderLocalityFromName(primaryName),
            providerName: primaryName,
            ...(selectedExecutionProfile?.providerName && selectedExecutionProfile.providerName !== primaryName
              ? { providerProfileName: selectedExecutionProfile.providerName }
              : {}),
            ...(selectedExecutionProfile?.providerTier
              ? { providerTier: selectedExecutionProfile.providerTier }
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
      if (this.qualityFallbackEnabled && this.isResponseDegraded(finalContent) && this.fallbackChain && providerLocality === 'local') {
        log.warn({ agent: this.id }, 'Local LLM produced degraded response (no-tools path), retrying with fallback');
        try {
          const fbStartedAt = Date.now();
          const fb = fallbackProviderOrder
            ? await this.fallbackChain.chatWithFallbackAfterProvider(ctx.llm?.name ?? 'unknown', fallbackProviderOrder, llmMessages)
            : await this.fallbackChain.chatWithFallbackAfterPrimary(llmMessages);
          if (fb.response.content?.trim()) {
            finalContent = fb.response.content;
            responseSource = buildResponseSourceMetadata({
              locality: getProviderLocalityFromName(fb.providerName),
              providerName: fb.providerName,
              response: fb.response,
              usedFallback: true,
              notice: 'Retried with an alternate model after a weak local response.',
              durationMs: Date.now() - fbStartedAt,
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
      let currentContextTrustLevel: import('./tools/types.js').ContentTrustLevel = 'trusted';
      const currentTaintReasons = new Set<string>();
      if (this.shouldPreferAnswerFirstForSkills(activeSkills)) {
        try {
          const answerFirstResponse = await chatFn(
            withTaintedContentSystemPrompt(llmMessages, currentContextTrustLevel, currentTaintReasons),
            { tools: [] },
          );
          const answerFirstContent = answerFirstResponse.content?.trim() ?? '';
          if (
            answerFirstContent
            && !this.isResponseDegraded(answerFirstContent)
            && (!answerFirstResponse.toolCalls || answerFirstResponse.toolCalls.length === 0)
          ) {
            finalContent = answerFirstContent;
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

        let response = await chatFn(plannerMessages, { tools: llmToolDefs });
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

        llmMessages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        // Parallel tool execution: run all tool calls concurrently
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

        const toolResults = await Promise.allSettled(
          executeToolsConflictAware({
            toolCalls: response.toolCalls,
            toolExecOrigin,
            referenceTime: message.timestamp,
            intentDecision: directIntent?.decision,
            tools: this.tools!,
            secondBrainService: this.secondBrainService,
          })
        );
        lastToolRoundResults = toolResults.reduce<Array<{ toolName: string; result: Record<string, unknown> }>>((acc, settled) => {
          if (settled.status !== 'fulfilled') return acc;
          acc.push({
            toolName: settled.value.toolCall.name,
            result: settled.value.result,
          });
          return acc;
        }, []);

        let hasPending = false;
        const deferredRemoteToolCallIds = new Set<string>();
        for (const settled of toolResults) {
          if (settled.status === 'fulfilled') {
            const { toolCall, result: toolResult } = settled.value;

            // Track pending approvals so we can auto-approve on user confirmation
            if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
              pendingIds.push(String(toolResult.approvalId));
              hasPending = true;
            }
            if (isDeferredRemoteSandboxToolResult(toolResult)) {
              deferredRemoteToolCallIds.add(toolCall.id);
            }

            // Strip approval IDs from pending_approval results so the LLM
            // doesn't echo them.  The structured metadata handles approval rendering.
            let resultForLlm = toolResult;
            if (toolResult.status === 'pending_approval') {
              const { approvalId: _stripped, jobId: _stripJob, ...rest } = toolResult as Record<string, unknown>;
              resultForLlm = { ...rest, message: 'This action needs your approval. The approval UI is shown to the user automatically.' };
            }

            const scannedToolResult = this.sanitizeToolResultForLlm(
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

            // Deferred tool loading: if find_tools was called, merge returned definitions
            if (toolCall.name === 'find_tools' && toolResult.success) {
              const searchOutput = toolResult.output as { tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; risk: string; category?: string; examples?: unknown[] }> } | undefined;
              if (searchOutput?.tools) {
                for (const discovered of searchOutput.tools) {
                  if (!llmToolDefs.some((d) => d.name === discovered.name)) {
                    const disc = {
                      name: discovered.name,
                      description: discovered.description,
                      risk: discovered.risk as import('./tools/types.js').ToolRisk,
                      parameters: discovered.parameters,
                      category: discovered.category as import('./tools/types.js').ToolCategory | undefined,
                    };
                    allToolDefs.push(disc);
                    llmToolDefs.push(toLLMToolDef(disc, toolResultProviderKind));
                  }
                }
              }
            }
          } else {
            // Push error result for rejected tool calls
            const failedTc = response.toolCalls[toolResults.indexOf(settled)];
            llmMessages.push({
              role: 'tool',
              toolCallId: failedTc?.id ?? '',
              content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
            });
          }
        }

        // Non-blocking approvals: only break if EVERY tool in this round is
        // pending approval.  When some tools succeeded, the LLM already sees their
        // results alongside the pending status, so it can compose a natural response
        // that acknowledges what's waiting and what it plans to do next.
        if (hasPending) {
          const allBlocked = toolResults.every(
            (s) => s.status === 'fulfilled'
              && (
                (s.value.result as Record<string, unknown>).status === 'pending_approval'
                || isDeferredRemoteSandboxToolResult(s.value.result as Record<string, unknown>)
              ),
          );
          if (allBlocked) {
            // Remove the 'pending' tool result messages we just pushed, so we don't send duplicate toolCallIds when resuming
            llmMessages.splice(-toolResults.length, toolResults.length);
            pruneDeferredRemoteSandboxToolCalls(llmMessages, deferredRemoteToolCallIds);

            // Suspended Execution: cache the loop state so we can resume directly
            // when the user approves via out-of-band UI.
            const pendingTools: StoredToolLoopPendingTool[] = toolResults
              .filter((s) => s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval')
              .map((s) => {
                 const result = (s as any).value.result as Record<string, unknown>;
                 const toolCall = (s as any).value.toolCall;
                 return {
                   approvalId: String(result.approvalId),
                   toolCallId: toolCall.id,
                   jobId: String(result.jobId),
                   name: toolCall.name,
                 };
              });
              
            this.suspendedSessions.set(suspendedSessionKey, {
              scope: suspendedScope,
              llmMessages: [...llmMessages],
              pendingTools,
              originalMessage: selectSuspendedOriginalMessage({
                isContinuation,
                existing: suspended?.originalMessage,
                current: routedScopedMessage,
              }),
              ctx,
            });
            toolLoopPendingResume = {
              kind: 'tool_loop',
              payload: this.buildToolLoopResumePayload({
                llmMessages,
                pendingTools,
                originalMessage: selectSuspendedOriginalMessage({
                  isContinuation,
                  existing: suspended?.originalMessage,
                  current: routedScopedMessage,
                }),
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
              }),
            };
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

      if (!finalContent && lastToolRoundResults.length > 0) {
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
        && this.isResponseDegraded(finalContent)
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
          const fallbackStartedAt = Date.now();
          const fallbackResult = fallbackProviderOrder
            ? await this.fallbackChain.chatWithFallbackAfterProvider(ctx.llm?.name ?? 'unknown', fallbackProviderOrder, fbMessages, { tools: externalToolDefs })
            : await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
          const fbProvider = fallbackResult.providerName;
          responseSource = buildResponseSourceMetadata({
            locality: getProviderLocalityFromName(fbProvider),
            providerName: fbProvider,
            response: fallbackResult.response,
            usedFallback: true,
            notice: 'Retried with an alternate model after a weak local response.',
            durationMs: Date.now() - fallbackStartedAt,
          });

          // If the fallback LLM returned tool calls, execute them (single round)
          if (fallbackResult.response.toolCalls?.length && this.tools) {
            log.info({ agent: this.id, provider: fbProvider, toolCount: fallbackResult.response.toolCalls.length },
              'Fallback provider requested tool calls, executing');
            fbMessages.push({ role: 'assistant' as const, content: fallbackResult.response.content ?? '', toolCalls: fallbackResult.response.toolCalls });
            const fbToolOrigin = {
              origin: 'assistant' as const,
              agentId: this.id,
              userId: conversationUserId,
              principalId: message.principalId ?? conversationUserId,
              principalRole: message.principalRole ?? 'owner',
              channel: conversationChannel,
              requestId: message.id,
              allowModelMemoryMutation,
              agentContext: { checkAction: ctx.checkAction },
              codeContext: effectiveCodeContext,
              activeSkills: activeSkills.map((skill) => skill.id),
              requestText: stripLeadingContextPrefix(routedScopedMessage.content),
            };
            const fbToolResults = await Promise.allSettled(
              executeToolsConflictAware({
                toolCalls: fallbackResult.response.toolCalls,
                toolExecOrigin: fbToolOrigin,
                referenceTime: message.timestamp,
                intentDecision: directIntent?.decision,
                tools: this.tools!,
                secondBrainService: this.secondBrainService,
              })
            );
            let fallbackHasPending = false;
            for (const settled of fbToolResults) {
              if (settled.status === 'fulfilled') {
                const { toolCall, result: toolResult } = settled.value;

                if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
                  pendingIds.push(String(toolResult.approvalId));
                  fallbackHasPending = true;
                }

                let resultForLlm = toolResult;
                if (toolResult.status === 'pending_approval') {
                  const { approvalId: _stripped, jobId: _stripJob, ...rest } = toolResult as Record<string, unknown>;
                  resultForLlm = {
                    ...rest,
                    message: 'This action needs your approval. The approval UI is shown to the user automatically.',
                  };
                }

                const scannedToolResult = this.sanitizeToolResultForLlm(
                  toolCall.name,
                  resultForLlm,
                  'external',
                );
                fbMessages.push({
                  role: 'tool' as const,
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
                      if (!llmToolDefs.some((d) => d.name === discovered.name)) {
                        const disc = {
                          name: discovered.name,
                          description: discovered.description,
                          risk: discovered.risk as import('./tools/types.js').ToolRisk,
                          parameters: discovered.parameters,
                          category: discovered.category as import('./tools/types.js').ToolCategory | undefined,
                        };
                        allToolDefs.push(disc);
                        llmToolDefs.push(toLLMToolDef(disc, toolResultProviderKind));
                      }
                    }
                    externalToolDefs = allToolDefs.map((d) => toLLMToolDef(d, 'external'));
                  }
                }
              } else {
                const failedTc = fallbackResult.response.toolCalls[fbToolResults.indexOf(settled)];
                fbMessages.push({
                  role: 'tool' as const,
                  toolCallId: failedTc?.id ?? '',
                  content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
                });
              }
            }

            if (fallbackHasPending) {
              const allPending = fbToolResults.every(
                (s) => s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval',
              );
              if (allPending) {
                fbMessages.splice(-fbToolResults.length, fbToolResults.length);
                const pendingTools: StoredToolLoopPendingTool[] = fbToolResults
                  .filter((s): s is PromiseFulfilledResult<{ toolCall: { id: string; name: string; arguments?: string }; result: Record<string, unknown> }> =>
                    s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval')
                  .map((s) => ({
                    approvalId: String(s.value.result.approvalId),
                    toolCallId: s.value.toolCall.id,
                    jobId: String(s.value.result.jobId),
                    name: s.value.toolCall.name,
                  }));
                this.suspendedSessions.set(suspendedSessionKey, {
                  scope: suspendedScope,
                  llmMessages: [...fbMessages],
                  pendingTools,
                  originalMessage: selectSuspendedOriginalMessage({
                    isContinuation,
                    existing: suspended?.originalMessage,
                    current: routedScopedMessage,
                  }),
                  ctx,
                });
                toolLoopPendingResume = {
                  kind: 'tool_loop',
                  payload: this.buildToolLoopResumePayload({
                    llmMessages: fbMessages,
                    pendingTools,
                    originalMessage: selectSuspendedOriginalMessage({
                      isContinuation,
                      existing: suspended?.originalMessage,
                      current: routedScopedMessage,
                    }),
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
                  }),
                };
              } else {
                const finalFbStartedAt = Date.now();
                const finalFb = fallbackProviderOrder
                  ? await this.fallbackChain.chatWithFallbackAfterProvider(fallbackResult.providerName, fallbackProviderOrder, fbMessages, { tools: externalToolDefs })
                  : await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
                if (finalFb.response.content?.trim()) {
                  finalContent = finalFb.response.content;
                  responseSource = buildResponseSourceMetadata({
                    locality: getProviderLocalityFromName(finalFb.providerName),
                    providerName: finalFb.providerName,
                    response: finalFb.response,
                    usedFallback: true,
                    notice: 'Retried with an alternate model after local execution degraded.',
                    durationMs: Date.now() - finalFbStartedAt,
                  });
                  log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
                }
              }
            } else {
              // One more chat call to get the final text response from fallback
              const finalFbStartedAt = Date.now();
              const finalFb = fallbackProviderOrder
                ? await this.fallbackChain.chatWithFallbackAfterProvider(fallbackResult.providerName, fallbackProviderOrder, fbMessages, { tools: externalToolDefs })
                : await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
              if (finalFb.response.content?.trim()) {
                finalContent = finalFb.response.content;
                responseSource = buildResponseSourceMetadata({
                  locality: getProviderLocalityFromName(finalFb.providerName),
                  providerName: finalFb.providerName,
                  response: finalFb.response,
                  usedFallback: true,
                  notice: 'Retried with an alternate model after local execution degraded.',
                  durationMs: Date.now() - finalFbStartedAt,
                });
                log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
              }
            }
          } else if (fallbackResult.response.content?.trim()) {
            finalContent = fallbackResult.response.content;
            responseSource = buildResponseSourceMetadata({
              locality: getProviderLocalityFromName(fbProvider),
              providerName: fbProvider,
              response: fallbackResult.response,
              usedFallback: true,
              notice: 'Retried with an alternate model after a weak local response.',
              durationMs: Date.now() - fallbackStartedAt,
            });
            log.info({ agent: this.id, provider: fbProvider },
              'Fallback provider produced successful response');
          }
        } catch (fallbackErr) {
          log.warn({ agent: this.id, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
            'Fallback chain also failed');
        }
      }

      // Store pending approvals for this user so they can be approved/denied explicitly
      if (pendingIds.length > 0) {
        const existing = this.getPendingApprovalIds(
          pendingActionUserId,
          pendingActionChannel,
          pendingActionSurfaceId,
        );
        const merged = [...new Set([...existing, ...pendingIds])];
        this.setPendingApprovals(pendingActionUserKey, merged, pendingActionSurfaceId);
        const summaries = this.tools?.getApprovalSummaries(merged);
        const approvalSummaries = merged.map((id) => {
          const summary = summaries?.get(id);
          return {
            id,
            toolName: summary?.toolName ?? 'unknown',
            argsPreview: summary?.argsPreview ?? '',
            actionLabel: summary?.actionLabel ?? '',
          };
        });
        const pendingActionResult = this.setPendingApprovalAction(
          pendingActionUserId,
          pendingActionChannel,
          pendingActionSurfaceId,
          {
            prompt: 'Approval required for the pending action.',
            approvalIds: merged,
            approvalSummaries,
            originalUserContent: routedScopedMessage.content,
            route: directIntent?.decision.route,
            operation: directIntent?.decision.operation,
            summary: directIntent?.decision.summary,
            turnRelation: directIntent?.decision.turnRelation,
            resolution: directIntent?.decision.resolution,
            missingFields: directIntent?.decision.missingFields,
            provenance: directIntent?.decision.provenance,
            entities: directIntent?.decision.entities as Record<string, unknown> | undefined,
            ...(toolLoopPendingResume ? { resume: toolLoopPendingResume } : {}),
            ...(resolvedCodeSession?.session.id ? { codeSessionId: resolvedCodeSession.session.id } : {}),
          },
        );
        pendingActionMeta = toPendingActionClientMetadata(pendingActionResult.action);
        if (pendingActionResult.collisionPrompt) {
          finalContent = pendingActionResult.collisionPrompt;
        } else if (pendingActionResult.action?.blocker.approvalSummaries?.length
          && (shouldUseStructuredPendingApprovalMessage(finalContent) || this.isResponseDegraded(finalContent))) {
          finalContent = formatPendingApprovalMessage(pendingActionResult.action.blocker.approvalSummaries);
        }
      }

      if (!finalContent && lastToolRoundResults.length > 0) {
        finalContent = summarizeToolRoundFallback(lastToolRoundResults);
      }

      // Local models sometimes emit generic approval copy without ever producing
      // a real pending approval object. Never show approval text unless the
      // runtime actually has pending approval metadata to back it.
      if (!pendingActionMeta && isPhantomPendingApprovalMessage(finalContent)) {
        finalContent = lastToolRoundResults.length > 0
          ? summarizeToolRoundFallback(lastToolRoundResults)
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
    return message.surfaceId?.trim() || message.userId?.trim() || 'default-surface';
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

  private refreshCodeSessionWorkspaceAwareness(
    resolved: ResolvedCodeSessionContext,
    messageContent?: string,
  ): ResolvedCodeSessionContext {
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
    const nextResolved = Object.keys(updates).length === 0
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

  private formatCodePlanSummary(results: Array<{ toolName: string; result: Record<string, unknown> }>): string {
    const planResult = results.find((entry) => entry.toolName === 'code_plan');
    if (!planResult || !isRecord(planResult.result.output)) return '';
    const output = planResult.result.output as Record<string, unknown>;
    const goal = toString(output.goal);
    const workflow = isRecord(output.workflow) ? output.workflow : null;
    const execution = isRecord(output.execution) ? output.execution : null;
    const isolation = execution && isRecord(execution.isolation) ? execution.isolation : null;
    const plan = Array.isArray(output.plan) ? output.plan.map((step) => `- ${String(step)}`) : [];
    const verification = Array.isArray(output.verification)
      ? output.verification.map((step) => `- ${String(step)}`)
      : [];
    const isolationLevel = toString(isolation?.level).trim();
    const isolationLines = isolation && isolationLevel && isolationLevel !== 'none'
      ? [
          isolationLevel
            ? `- Level: ${isolationLevel}`
            : '',
          toString(isolation.backendKind).trim()
            ? `- Backend: ${toString(isolation.backendKind).trim()}`
            : '',
          toString(isolation.profileId).trim()
            ? `- Profile: ${toString(isolation.profileId).trim()}`
            : '',
          Array.isArray(isolation.candidateOperations) && isolation.candidateOperations.length > 0
            ? `- Candidate operations: ${isolation.candidateOperations.map((value) => String(value)).join(', ')}`
            : '',
          toString(isolation.reason).trim()
            ? `- Reason: ${toString(isolation.reason).trim()}`
            : '',
        ].filter((value) => value)
      : [];
    const sections = [
      goal ? `Goal: ${goal}` : '',
      workflow?.label ? `Workflow: ${toString(workflow.label)}` : '',
      plan.length > 0 ? `Plan:\n${plan.join('\n')}` : '',
      verification.length > 0 ? `Verification:\n${verification.join('\n')}` : '',
      isolationLines.length > 0 ? `Isolation:\n${isolationLines.join('\n')}` : '',
    ].filter((value) => value);
    return sections.join('\n\n');
  }

  private extractPlannedWorkflowType(
    results: Array<{ toolName: string; result: Record<string, unknown> }>,
  ): CodeSessionWorkflowType | null {
    const planResult = results.find((entry) => entry.toolName === 'code_plan');
    if (!planResult || !isRecord(planResult.result.output)) return null;
    const output = planResult.result.output as Record<string, unknown>;
    const workflow = isRecord(output.workflow) ? output.workflow : null;
    const value = toString(workflow?.type).trim();
    if (value === 'implementation'
      || value === 'bug_fix'
      || value === 'code_review'
      || value === 'refactor'
      || value === 'test_repair'
      || value === 'dependency_review'
      || value === 'spec_to_plan') {
      return value;
    }
    return null;
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
    if (!this.codeSessionStore) return;
    const sessionPendingApprovals = this.tools?.listPendingApprovalsForCodeSession(session.id, 20) ?? [];
    const pending = sessionPendingApprovals.length === 0
      ? this.getPendingApprovals(`${conversationUserId}:${conversationChannel}`)
      : null;
    const approvalSummaries = pending?.ids.length
      ? this.tools?.getApprovalSummaries(pending.ids)
      : undefined;
    const pendingApprovals = sessionPendingApprovals.length > 0
      ? sessionPendingApprovals
      : pending?.ids.length
        ? pending.ids.map((id) => {
            const summary = approvalSummaries?.get(id);
            return {
              id,
              toolName: summary?.toolName ?? 'unknown',
              argsPreview: summary?.argsPreview ?? '',
              actionLabel: summary?.actionLabel ?? '',
            };
          })
        : [];
    const sessionJobs = this.tools?.listJobsForCodeSession(session.id, 100) ?? [];
    const recentJobs = (sessionJobs.length > 0
      ? sessionJobs
      : (this.tools?.listJobs(100) ?? [])
        .filter((job) => job.userId === conversationUserId && job.channel === conversationChannel))
      .slice(0, 20)
      .map((job) => ({
        id: job.id,
        toolName: job.toolName,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        durationMs: job.durationMs,
        resultPreview: job.resultPreview,
        argsPreview: job.argsPreview,
        error: job.error,
        verificationStatus: job.verificationStatus,
        verificationEvidence: job.verificationEvidence,
        approvalId: job.approvalId,
        requestId: job.requestId,
        remoteExecution: job.remoteExecution
          ? { ...job.remoteExecution }
          : undefined,
      }));
    const planSummary = this.formatCodePlanSummary(lastToolRoundResults) || session.workState.planSummary;
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: session.workState.focusSummary,
      planSummary,
      pendingApprovals,
      recentJobs,
      verification: session.workState.verification,
      previous: session.workState.workflow,
      plannedWorkflowType: this.extractPlannedWorkflowType(lastToolRoundResults),
      hasRepoEvidence: Boolean(
        session.workState.workspaceProfile?.summary
          || session.workState.workspaceMap?.indexedFileCount
          || session.workState.workingSet?.files?.length,
      ),
      workspaceTrustState: getEffectiveCodeWorkspaceTrustState(
        session.workState.workspaceTrust,
        session.workState.workspaceTrustReview,
      ) ?? session.workState.workspaceTrust?.state ?? null,
      remoteExecutionTargets: this.tools?.getRemoteExecutionTargets?.(),
    });
    const nextCompactedSummary = runtimeState?.contextAssembly?.compactedSummaryPreview
      || (
        runtimeState?.contextAssembly?.contextCompactionApplied
          && typeof runtimeState.contextAssembly.contextCharsBeforeCompaction === 'number'
          && typeof runtimeState.contextAssembly.contextCharsAfterCompaction === 'number'
          ? `Older context was compacted from ${runtimeState.contextAssembly.contextCharsBeforeCompaction} to ${runtimeState.contextAssembly.contextCharsAfterCompaction} chars.${Array.isArray(runtimeState.contextAssembly.contextCompactionStages) && runtimeState.contextAssembly.contextCompactionStages.length > 0 ? ` Stages: ${runtimeState.contextAssembly.contextCompactionStages.join(', ')}.` : ''}`
          : session.workState.compactedSummary
      );
    const compactedSummaryUpdatedAt = nextCompactedSummary && nextCompactedSummary !== session.workState.compactedSummary
      ? Date.now()
      : session.workState.compactedSummaryUpdatedAt;
    const compactedSummary = nextCompactedSummary;
    const status = pendingApprovals.length > 0
      ? 'awaiting_approval'
      : recentJobs.some((job) => job.status === 'failed' || job.status === 'denied')
        ? 'blocked'
        : recentJobs.some((job) => job.status === 'running')
          ? 'active'
          : 'active';

    this.codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      status,
      workState: {
        ...session.workState,
        focusSummary: session.workState.focusSummary,
        workspaceProfile: session.workState.workspaceProfile,
        planSummary,
        compactedSummary,
        compactedSummaryUpdatedAt,
        workflow,
        activeSkills: activeSkills.map((skill) => skill.id),
        pendingApprovals,
        recentJobs,
      },
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

  private tryDirectRecentToolReport(message: UserMessage): string | null {
    if (!this.tools?.isEnabled()) return null;
    if (!_isToolReportQuery(message.content)) return null;

    const jobs = this.tools.listJobs(50)
      .filter((job) => job.userId === message.userId && job.channel === message.channel);

    const report = _formatToolReport(jobs);
    return report || null;
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
    if (!this.tools?.isEnabled()) return null;
    if (!decision || decision.route !== 'coding_task') return null;
    const { userId: pendingUserId, channel: pendingChannel } = this.parsePendingActionUserKey(userKey);
    const backendId = normalizeCodingBackendSelection(decision.entities.codingBackend);
    const isCodingRunStatusCheck = decision.entities.codingRunStatusCheck === true;
    let effectiveCodeContext = codeContext ? { ...codeContext } : undefined;
    let currentSessionRecord = effectiveCodeContext?.sessionId
      ? this.codeSessionStore?.getSession(effectiveCodeContext.sessionId, message.userId?.trim())
        ?? this.codeSessionStore?.getSession(effectiveCodeContext.sessionId)
      : null;
    let switchResponsePrefix = '';
    let switchResponseMetadata: Record<string, unknown> | undefined;
    const explicitWorkspaceTarget = await this.ensureExplicitCodingTaskWorkspaceTarget({
      message,
      ctx,
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
      if (!effectiveCodeContext?.sessionId) {
        return { content: `I can only check recent ${backendId || 'coding backend'} runs from an active coding workspace.` };
      }

      this.recordIntentRoutingTrace('direct_tool_call_started', {
        message,
        details: {
          toolName: 'coding_backend_status',
          ...(backendId ? { backendId } : {}),
          codeSessionId: effectiveCodeContext.sessionId,
          workspaceRoot: effectiveCodeContext.workspaceRoot,
        },
      });
      const statusResult = await this.tools.executeModelTool(
        'coding_backend_status',
        {},
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
          codeContext: effectiveCodeContext,
        },
      );
      this.recordIntentRoutingTrace('direct_tool_call_completed', {
        message,
        details: {
          toolName: 'coding_backend_status',
          ...(backendId ? { backendId } : {}),
          status: statusResult.status,
          success: toBoolean(statusResult.success),
          message: toString(statusResult.message),
        },
      });
      if (!toBoolean(statusResult.success)) {
        const failure = toString(statusResult.message) || toString(statusResult.error) || `I could not inspect recent ${backendId || 'coding backend'} runs.`;
        return {
          content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${failure}` : failure,
          metadata: switchResponseMetadata,
        };
      }

      const sessions = (isRecord(statusResult.output) && Array.isArray(statusResult.output.sessions)
        ? statusResult.output.sessions
        : []) as Array<Record<string, unknown>>;
      const matches = sessions
        .filter((session) => !backendId || toString(session.backendId) === backendId)
        .sort((a, b) => {
          const aTime = toNumber(a.completedAt) || toNumber(a.startedAt) || 0;
          const bTime = toNumber(b.completedAt) || toNumber(b.startedAt) || 0;
          return bTime - aTime;
        });
      if (matches.length === 0) {
        const content = `I couldn't find any recent ${backendId || 'coding backend'} runs for this coding workspace.`;
        return {
          content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${content}` : content,
          metadata: switchResponseMetadata,
        };
      }

      const latest = matches[0];
      const backendName = toString(latest.backendName) || backendId;
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
        content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${content}` : content,
        metadata: switchResponseMetadata,
      };
    }

    const delegatedTask = stripLeadingContextPrefix(decision.resolvedContent?.trim() || message.content).trim();
    this.recordIntentRoutingTrace('direct_tool_call_started', {
      message,
      contentPreview: delegatedTask,
      details: {
        toolName: 'coding_backend_run',
        backendId,
        codeSessionId: effectiveCodeContext?.sessionId,
        workspaceRoot: effectiveCodeContext?.workspaceRoot,
      },
    });
    const result = await this.tools.executeModelTool(
      'coding_backend_run',
      {
        task: delegatedTask,
        backend: backendId,
      },
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
        ...(effectiveCodeContext ? { codeContext: effectiveCodeContext } : {}),
      },
    );

    this.recordIntentRoutingTrace('direct_tool_call_completed', {
      message,
      details: {
        toolName: 'coding_backend_run',
        backendId,
        status: result.status,
        success: toBoolean(result.success),
        message: toString(result.message),
      },
      contentPreview: toString(result.output && isRecord(result.output) ? result.output.output : undefined),
    });

    if (result.status === 'pending_approval') {
      const approvalId = toString(result.approvalId);
      let pendingIds: string[] = [];
      if (approvalId) {
        const existingIds = this.getPendingApprovalIds(pendingUserId, pendingChannel, message.surfaceId);
        pendingIds = [...new Set([...existingIds, approvalId])];
        this.setPendingApprovals(userKey, pendingIds, message.surfaceId);
      } else {
        this.syncPendingApprovalsFromExecutor(
          message.userId,
          message.channel,
          pendingUserId,
          pendingChannel,
          message.surfaceId,
          message.content,
        );
        pendingIds = this.getPendingApprovalIds(pendingUserId, pendingChannel, message.surfaceId);
      }
      const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
      const prompt = [
        `I need approval to run ${backendId} for this coding task.`,
        'Once approved, I\'ll launch it in:',
        currentSessionRecord
          ? formatDirectCodeSessionLine(currentSessionRecord, true)
          : `- CURRENT: ${effectiveCodeContext?.workspaceRoot ?? '(unknown workspace)'}`,
      ].join('\n');
      const pendingActionResult = this.setPendingApprovalAction(
        pendingUserId,
        pendingChannel,
        message.surfaceId,
        {
          prompt,
          approvalIds: pendingIds,
          approvalSummaries: pendingIds.map((id) => {
            const summary = summaries?.get(id);
            return {
              id,
              toolName: summary?.toolName ?? 'unknown',
              argsPreview: summary?.argsPreview ?? '',
              actionLabel: summary?.actionLabel ?? '',
            };
          }),
          originalUserContent: delegatedTask,
          route: decision.route,
          operation: decision.operation,
          summary: decision.summary,
          turnRelation: decision.turnRelation,
          resolution: decision.resolution,
          missingFields: decision.missingFields,
          provenance: decision.provenance,
          entities: toPendingActionEntities(decision.entities),
          codeSessionId: effectiveCodeContext?.sessionId,
        },
      );
      const content = pendingActionResult.collisionPrompt ?? prompt;
      return {
        content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${content}` : content,
        metadata: {
          ...(switchResponseMetadata ?? {}),
          ...(effectiveCodeContext?.sessionId ? { codeSessionResolved: true, codeSessionId: effectiveCodeContext.sessionId } : {}),
          ...(toPendingActionClientMetadata(pendingActionResult.action) ? { pendingAction: toPendingActionClientMetadata(pendingActionResult.action) } : {}),
        },
      };
    }

    const runResult = isRecord(result.output) ? result.output : null;
    const backendName = toString(runResult?.backendName) || backendId;
    const backendOutput = toString(runResult?.output)?.trim();
    const sessionId = effectiveCodeContext?.sessionId || toString(runResult?.codeSessionId);

    const metadata: Record<string, unknown> = {
      codingBackendDelegated: true,
      codingBackendId: backendId,
      ...(switchResponseMetadata ?? {}),
      ...(sessionId ? { codeSessionResolved: true, codeSessionId: sessionId } : {}),
    };

    const content = backendOutput || `${backendName} completed successfully.`;
    if (toBoolean(result.success)) {
      return {
        content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${content}` : content,
        metadata,
      };
    }

    const failureMessage = backendOutput
      || toString(result.message)
      || `${backendName} could not complete the requested task.`;
    return {
      content: switchResponsePrefix ? `${switchResponsePrefix}\n\n${failureMessage}` : failureMessage,
      metadata,
    };
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

  private isResponseDegraded(content: string | undefined): boolean {
    return _isResponseDegraded(content);
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
    const isPolicyScoped = /(allowlist|allow list|allowed domains|alloweddomains|allowed paths|allowed commands|outside the sandbox|blocked by policy|not in the allowed|not in alloweddomains|outside allowed paths|outside the authorized workspace root|outside the authorized workspace)/.test(`${latestUser}\n${lower}`);

    return isPolicyScoped && (claimsToolMissing || pushesManualConfig);
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
      getAutomationApprovalContinuation: (userKey, nowMs) => this.getAutomationApprovalContinuation(userKey, nowMs),
      setAutomationApprovalContinuation: (userKey, originalMessage, automationCtx, pendingApprovalIds, expiresAt) => this.setAutomationApprovalContinuation(
        userKey,
        originalMessage,
        automationCtx,
        pendingApprovalIds,
        expiresAt,
      ),
      clearAutomationApprovalContinuation: (userKey) => this.clearAutomationApprovalContinuation(userKey),
      tryDirectAutomationAuthoring: (automationMessage, automationCtx, userKey, codeContext, options) => this.tryDirectAutomationAuthoring(
        automationMessage,
        automationCtx,
        userKey,
        codeContext,
        options,
      ),
      resumeStoredToolLoopPendingAction: (pendingAction, options) => this.resumeStoredToolLoopPendingAction(pendingAction, options),
      resumeStoredDirectRoutePendingAction: (pendingAction, options) => this.resumeStoredDirectRoutePendingAction(pendingAction, options),
      normalizeDirectRouteContinuationResponse: (response, userId, channel, surfaceId) => this.normalizeDirectRouteContinuationResponse(
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
      codeSessionId?: string;
    },
    nowMs: number = Date.now(),
  ) {
    return this.orchestrationState.setPendingApprovalActionForRequest(userKey, surfaceId, input, nowMs);
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

  private getAutomationApprovalContinuation(
    userKey: string,
    nowMs: number = Date.now(),
  ) {
    return this.approvalState.getAutomationApprovalContinuation(userKey, nowMs);
  }

  private setAutomationApprovalContinuation(
    userKey: string,
    originalMessage: UserMessage,
    ctx: AgentContext,
    pendingApprovalIds: string[],
    expiresAt: number = Date.now() + PENDING_APPROVAL_TTL_MS,
  ): void {
    this.approvalState.setAutomationApprovalContinuation(
      userKey,
      originalMessage,
      ctx,
      pendingApprovalIds,
      expiresAt,
    );
  }

  private clearAutomationApprovalContinuation(userKey: string): void {
    this.approvalState.clearAutomationApprovalContinuation(userKey);
  }

  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null {
    return this.approvalState.takeApprovalFollowUp(approvalId, decision);
  }

  hasSuspendedApproval(
    approvalId: string,
    scope?: ApprovalContinuationScope,
  ): boolean {
    return !!findSuspendedApprovalState(this.suspendedSessions.values(), approvalId, scope);
  }

  hasAutomationApprovalContinuation(approvalId: string): boolean {
    return this.approvalState.hasAutomationApprovalContinuation(approvalId);
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
    const normalizedScope = normalizeApprovalContinuationScope({
      userId: args.userId,
      channel: args.channel,
      surfaceId: args.surfaceId,
    });
    for (const [key, session] of this.suspendedSessions.entries()) {
      const matchesScope = session.scope.userId === normalizedScope.userId
        && session.scope.channel === normalizedScope.channel
        && session.scope.surfaceId === normalizedScope.surfaceId;
      const matchesApproval = session.pendingTools.some((tool) => approvalIds.has(tool.approvalId));
      if (matchesScope || matchesApproval) {
        this.suspendedSessions.delete(key);
      }
    }
    for (const approvalId of approvalIds) {
      this.clearApprovalFollowUp(approvalId);
    }
    this.clearAutomationApprovalContinuation(`${args.userId}:${args.channel}`);
  }

  async continueDirectRouteAfterApproval(
    pendingAction: PendingActionRecord | null,
    approvalId: string,
    decision: 'approved' | 'denied',
    approvalResult?: ToolApprovalDecisionResult,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return continueDirectRouteAfterApprovalHelper({
      pendingAction,
      approvalId,
      decision,
      approvalResult,
      stateAgentId: this.stateAgentId,
      resumeStoredToolLoopPendingAction: (action, options) => this.resumeStoredToolLoopPendingAction(action, options),
      resumeStoredDirectRoutePendingAction: (action, options) => this.resumeStoredDirectRoutePendingAction(action, options),
      normalizeDirectRouteContinuationResponse: (response, userId, channel, surfaceId) => this.normalizeDirectRouteContinuationResponse(
        response,
        userId,
        channel,
        surfaceId,
      ),
    });
  }

  async continueAutomationAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const match = this.approvalState.findAutomationApprovalContinuation(approvalId);
    if (!match) return null;
    const { userKey, continuation } = match;
    if (decision !== 'approved') {
      this.clearAutomationApprovalContinuation(userKey);
      return null;
    }
    const stillPending = continuation.pendingApprovalIds.filter((id) => id !== approvalId.trim());
    if (stillPending.length > 0) {
      this.setAutomationApprovalContinuation(userKey, continuation.originalMessage, continuation.ctx, stillPending, continuation.expiresAt);
      return null;
    }
    this.clearAutomationApprovalContinuation(userKey);
    return this.tryDirectAutomationAuthoring(continuation.originalMessage, continuation.ctx, userKey, undefined, {
      assumeAuthoring: true,
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
    if (!this.tools?.isEnabled()) return null;

    if (decision?.route === 'email_task' && decision.entities.emailProvider === 'm365') {
      return this.tryDirectMicrosoft365Write(message, ctx, userKey);
    }

    const intent = parseDirectGmailWriteIntent(message.content);
    if (!intent) return null;

    let to = intent.to?.trim();
    let subject = intent.subject?.trim();
    const body = intent.body?.trim();

    if (intent.replyTarget === 'latest_unread') {
      if (!body) {
        return `To ${intent.mode} a reply to the newest unread Gmail message, I need the body.`;
      }
      const replyTarget = await this.resolveLatestUnreadGmailReplyTarget(message, ctx, userKey);
      if (!replyTarget) {
        return 'I checked Gmail and could not find an unread message to reply to.';
      }
      if (typeof replyTarget === 'string') {
        return replyTarget;
      }
      if (!isDirectMailboxReplyTarget(replyTarget)) {
        return replyTarget;
      }
      to = replyTarget.to;
      subject = replyTarget.subject;
    }

    if (!to || !subject || !body) {
      const missing: string[] = [];
      if (!to) missing.push('recipient email');
      if (!subject) missing.push('subject');
      if (!body) missing.push('body');
      return `To ${intent.mode} a Gmail email, I need the ${missing.join(', ')}.`;
    }

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
      ...(message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
    };

    const raw = buildGmailRawMessage({
      to,
      subject,
      body,
    });
    const method = intent.mode === 'send' ? 'send' : 'create';
    const resource = intent.mode === 'send' ? 'users messages' : 'users drafts';
    const json = intent.mode === 'send'
      ? { raw }
      : { message: { raw } };

    const toolResult = await this.tools.executeModelTool(
      'gws',
      {
        service: 'gmail',
        resource,
        method,
        params: { userId: 'me' },
        json,
      },
      toolRequest,
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
        if (approvalId) {
          this.setApprovalFollowUp(approvalId, {
            approved: intent.mode === 'send'
              ? 'I sent the Gmail message.'
              : 'I drafted the Gmail message.',
            denied: intent.mode === 'send'
              ? 'I did not send the Gmail message.'
              : 'I did not draft the Gmail message.',
          });
        }
        const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
        const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
        const pendingActionResult = this.setPendingApprovalActionForRequest(
          userKey,
          message.surfaceId,
          {
            prompt,
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: message.content,
            route: 'email_task',
            operation: intent.mode,
            summary: intent.mode === 'send' ? 'Sends a Gmail message.' : 'Creates a Gmail draft.',
            turnRelation: 'new_request',
            resolution: 'ready',
          },
        );
        return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
          `I prepared a Gmail ${intent.mode} to ${to} with subject "${subject}", but it needs approval first.`,
          prompt,
        ].filter(Boolean).join('\n\n'));
      }
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Google Workspace request failed.';
      return `I tried to ${intent.mode} the Gmail message, but it failed: ${msg}`;
    }

    return intent.mode === 'send'
      ? `I sent the Gmail message to ${to} with subject "${subject}".`
      : `I drafted a Gmail message to ${to} with subject "${subject}".`;
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
    }, {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      clearAutomationApprovalContinuation: (nextUserKey) => this.clearAutomationApprovalContinuation(nextUserKey),
      setAutomationApprovalContinuation: (nextUserKey, originalMessage, nextCtx, pendingApprovalIds) => this.setAutomationApprovalContinuation(
        nextUserKey,
        originalMessage,
        nextCtx,
        pendingApprovalIds,
      ),
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
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
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
    }, {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      clearAutomationApprovalContinuation: (nextUserKey) => this.clearAutomationApprovalContinuation(nextUserKey),
      setAutomationApprovalContinuation: (nextUserKey, originalMessage, nextCtx, pendingApprovalIds) => this.setAutomationApprovalContinuation(
        nextUserKey,
        originalMessage,
        nextCtx,
        pendingApprovalIds,
      ),
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
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
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
    }, {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      clearAutomationApprovalContinuation: (nextUserKey) => this.clearAutomationApprovalContinuation(nextUserKey),
      setAutomationApprovalContinuation: (nextUserKey, originalMessage, nextCtx, pendingApprovalIds) => this.setAutomationApprovalContinuation(
        nextUserKey,
        originalMessage,
        nextCtx,
        pendingApprovalIds,
      ),
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
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
    });
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
    }, {
      agentId: this.id,
      tools: this.tools,
      setApprovalFollowUp: (approvalId, copy) => this.setApprovalFollowUp(approvalId, copy),
      clearAutomationApprovalContinuation: (nextUserKey) => this.clearAutomationApprovalContinuation(nextUserKey),
      setAutomationApprovalContinuation: (nextUserKey, originalMessage, nextCtx, pendingApprovalIds) => this.setAutomationApprovalContinuation(
        nextUserKey,
        originalMessage,
        nextCtx,
        pendingApprovalIds,
      ),
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
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(
        result,
        fallbackContent,
      ),
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
      this.recordIntentRoutingTrace('gateway_classified', {
        message,
        details: {
          source: 'pre_routed',
          mode: preRouted.mode,
          available: preRouted.available,
          promptProfile: preRouted.promptProfile,
          route: preRouted.decision.route,
          confidence: preRouted.decision.confidence,
          operation: preRouted.decision.operation,
          routeSource: preRouted.decision.provenance?.route,
          operationSource: preRouted.decision.provenance?.operation,
          turnRelation: preRouted.decision.turnRelation,
          resolution: preRouted.decision.resolution,
          missingFields: preRouted.decision.missingFields,
          simpleVsComplex: preRouted.decision.simpleVsComplex,
          entitySources: preRouted.decision.provenance?.entities,
          emailProvider: preRouted.decision.entities.emailProvider,
          codingBackend: preRouted.decision.entities.codingBackend,
          latencyMs: preRouted.latencyMs,
          model: preRouted.model,
          rawResponsePreview: preRouted.rawResponsePreview,
        },
      });
      return preRouted;
    }
    if (!ctx.llm) return preRouted ?? null;
    const classified = await this.intentGateway.classify(
      {
        content: stripLeadingContextPrefix(message.content),
        channel: message.channel,
        recentHistory: options?.recentHistory,
        pendingAction: options?.pendingAction
          ? summarizePendingActionForGateway(options.pendingAction)
          : null,
        continuity: summarizeContinuityThreadForGateway(options?.continuityThread),
        enabledManagedProviders: this.enabledManagedProviders ? [...this.enabledManagedProviders] : [],
        availableCodingBackends: ['codex', 'claude-code', 'gemini-cli', 'aider'],
      },
      (messages, options) => this.chatWithFallback(
        ctx,
        messages,
        { ...options, signal: message.abortSignal },
        readSelectedExecutionProfileMetadata(message.metadata)?.fallbackProviderOrder,
      ),
    );
    this.recordIntentRoutingTrace('gateway_classified', {
      message,
      details: classified
        ? {
            source: 'agent',
            mode: classified.mode,
            available: classified.available,
            promptProfile: classified.promptProfile,
            route: classified.decision.route,
            confidence: classified.decision.confidence,
            operation: classified.decision.operation,
            routeSource: classified.decision.provenance?.route,
            operationSource: classified.decision.provenance?.operation,
            turnRelation: classified.decision.turnRelation,
            resolution: classified.decision.resolution,
            missingFields: classified.decision.missingFields,
            simpleVsComplex: classified.decision.simpleVsComplex,
            entitySources: classified.decision.provenance?.entities,
            emailProvider: classified.decision.entities.emailProvider,
            codingBackend: classified.decision.entities.codingBackend,
            continuityKey: options?.continuityThread?.continuityKey,
            latencyMs: classified.latencyMs,
            model: classified.model,
            rawResponsePreview: classified.rawResponsePreview,
          }
        : { source: 'agent', available: false },
    });
    return classified;
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
    if (!this.tools?.isEnabled() || !this.conversationService) return null;

    const directScheduledIntent = parseScheduledEmailAutomationIntent(message.content);
    const directScheduleOnlyIntent = parseScheduledEmailScheduleIntent(message.content);
    const directDetailIntent = parseDirectGmailWriteIntent(message.content);
    if (directScheduledIntent && directDetailIntent && directDetailIntent.subject && directDetailIntent.body) {
      return this.createDirectScheduledEmailAutomation(
        {
          schedule: directScheduledIntent,
          detail: directDetailIntent,
          message,
          ctx,
          userKey,
        },
      );
    }

    const history = this.conversationService.getHistoryForContext({
      agentId: stateAgentId,
      userId: message.userId,
      channel: message.channel,
    });
    if (history.length === 0) return null;

    const recentHistory = [...history].reverse();
    const priorDetailedContext = recentHistory.find((entry) => {
      const detail = parseDirectGmailWriteIntent(entry.content);
      return Boolean(detail?.subject && detail.body);
    });
    const priorScheduleContext = recentHistory.find((entry) => (
      parseScheduledEmailAutomationIntent(entry.content)
      || parseScheduledEmailScheduleIntent(entry.content)
    ));
    const detailIntent = (directDetailIntent && (directDetailIntent.subject || directDetailIntent.body || directDetailIntent.to))
      ? directDetailIntent
      : priorDetailedContext
        ? parseDirectGmailWriteIntent(priorDetailedContext.content)
        : null;
    const scheduledIntent = directScheduledIntent
      ?? (directScheduleOnlyIntent && detailIntent?.to
        ? { to: detailIntent.to, ...directScheduleOnlyIntent }
        : null)
      ?? (priorScheduleContext
        ? parseScheduledEmailAutomationIntent(priorScheduleContext.content)
          ?? (detailIntent?.to
            ? { to: detailIntent.to, ...parseScheduledEmailScheduleIntent(priorScheduleContext.content)! }
            : null)
        : null);
    const shouldTreatAsFollowUp = Boolean(
      directScheduleOnlyIntent
      || (directDetailIntent && (directDetailIntent.subject || directDetailIntent.body))
      || isAffirmativeContinuation(message.content),
    );
    if (!shouldTreatAsFollowUp) return null;
    if (!scheduledIntent || !detailIntent) return null;

    const subject = detailIntent.subject?.trim();
    const body = detailIntent.body?.trim();
    if (!subject || !body) {
      return 'To schedule that email automation, I still need both the subject and the body text.';
    }

    const to = detailIntent.to?.trim() || scheduledIntent.to;
    if (!to) {
      return 'To schedule that email automation, I still need the recipient email address.';
    }

    return this.createDirectScheduledEmailAutomation({
      schedule: { ...scheduledIntent, to },
      detail: { ...detailIntent, to, subject, body },
      message,
      ctx,
      userKey,
    });
  }

  private async createDirectScheduledEmailAutomation(input: {
    schedule: { to: string; cron: string; runOnce: boolean };
    detail: { to?: string; subject?: string; body?: string };
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
  }): Promise<string | { content: string; metadata?: Record<string, unknown> }> {
    const to = input.detail.to?.trim() || input.schedule.to;
    const subject = input.detail.subject?.trim() || '';
    const body = normalizeScheduledEmailBody(input.detail.body, subject);
    const raw = buildGmailRawMessage({ to, subject, body });
    const taskName = input.schedule.runOnce
      ? `Scheduled Email to ${to}`
      : `Recurring Email to ${to}`;
    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: input.message.userId,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    };

    const toolResult = await this.tools!.executeModelTool(
      'automation_save',
      {
        id: taskName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'scheduled-email-automation',
        name: taskName,
        enabled: true,
        kind: 'standalone_task',
        task: {
          target: 'gws',
          args: {
            service: 'gmail',
            resource: 'users messages',
            method: 'send',
            params: { userId: 'me' },
            json: { raw },
          },
        },
        schedule: {
          enabled: true,
          cron: input.schedule.cron,
          runOnce: input.schedule.runOnce,
        },
      },
      toolRequest,
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId);
        const existingIds = this.getPendingApprovals(input.userKey)?.ids ?? [];
        const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
        if (approvalId) {
          this.setApprovalFollowUp(approvalId, {
            approved: input.schedule.runOnce
              ? `I created the one-shot email automation to ${to}.`
              : `I created the recurring email automation to ${to}.`,
            denied: 'I did not create the scheduled email automation.',
          });
        }
        const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
        const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
        const pendingActionResult = this.setPendingApprovalActionForRequest(
          input.userKey,
          input.message.surfaceId,
          {
            prompt,
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: input.message.content,
            route: 'automation_authoring',
            operation: 'schedule',
            summary: input.schedule.runOnce
              ? 'Creates a one-shot scheduled email automation.'
              : 'Creates a recurring scheduled email automation.',
            turnRelation: 'new_request',
            resolution: 'ready',
          },
        );
        return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
          `I prepared a ${input.schedule.runOnce ? 'one-shot' : 'recurring'} email automation to ${to}.`,
          prompt,
        ].filter(Boolean).join('\n\n'));
      }
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Scheduled email automation creation failed.';
      return `I tried to create the scheduled email automation, but it failed: ${msg}`;
    }

    return input.schedule.runOnce
      ? `I created a one-shot email automation to ${to}. It will run on the next scheduled time.`
      : `I created a recurring email automation to ${to}.`;
  }

  private async tryDirectGoogleWorkspaceRead(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: IntentGatewayDecision,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;

    if (decision?.route === 'email_task' && decision.entities.emailProvider === 'm365') {
      return this.tryDirectMicrosoft365Read(message, ctx, userKey, decision, continuityThread);
    }

    const intent = this.resolveDirectMailboxReadIntent('gmail', message.content, decision, continuityThread);
    if (!intent) return null;
    const continuationKind = this.getDirectMailboxContinuationKind('gmail', intent.kind);
    const priorWindow = continuationKind
      ? readPagedListContinuationState(continuityThread, continuationKind)
      : null;
    const requestedWindow = continuationKind
      ? resolvePagedListWindow({
          continuityThread,
          continuationKind,
          content: message.content,
          total: priorWindow?.total ?? Math.max(intent.count, 1),
          turnRelation: decision?.turnRelation,
          defaultPageSize: Math.max(intent.count, 1),
        })
      : null;

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
      ...(message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
    };

    const listParams: Record<string, unknown> = {
      userId: 'me',
      maxResults: Math.max(
        intent.count,
        1,
        requestedWindow ? requestedWindow.offset + Math.max(requestedWindow.limit, 1) : 0,
      ),
    };
    if (intent.kind === 'gmail_unread') {
      listParams.q = 'is:unread';
    }

    const listResult = await this.tools.executeModelTool(
      'gws',
      {
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: listParams,
      },
      toolRequest,
    );

    if (!toBoolean(listResult.success)) {
      const status = toString(listResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(listResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
        if (approvalId) {
          this.setApprovalFollowUp(approvalId, {
            approved: 'I completed the Gmail inbox check.',
            denied: 'I did not check Gmail.',
          });
        }
        const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
        const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
        const pendingActionResult = this.setPendingApprovalActionForRequest(
          userKey,
          message.surfaceId,
          {
            prompt,
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: message.content,
            route: 'email_task',
            operation: 'read',
            summary: 'Checks Gmail for unread messages.',
            turnRelation: 'new_request',
            resolution: 'ready',
          },
        );
        return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
          'I prepared a Gmail inbox check, but it needs approval first.',
          prompt,
        ].filter(Boolean).join('\n\n'));
      }
      const msg = toString(listResult.message) || toString(listResult.error) || 'Google Workspace request failed.';
      return `I tried to check Gmail for unread messages, but it failed: ${msg}`;
    }

    const output = (listResult.output && typeof listResult.output === 'object'
      ? listResult.output
      : null) as { messages?: unknown; resultSizeEstimate?: unknown } | null;
    const messages = output && Array.isArray(output.messages)
      ? output.messages as Array<{ id?: unknown }>
      : [];
    const resultSizeEstimate = output ? toNumber(output.resultSizeEstimate) : null;
    const totalMessages = Math.max(resultSizeEstimate ?? 0, messages.length, priorWindow?.total ?? 0);
    const window = continuationKind
      ? resolvePagedListWindow({
          continuityThread,
          continuationKind,
          content: message.content,
          total: totalMessages,
          turnRelation: decision?.turnRelation,
          defaultPageSize: Math.max(intent.count, 1),
        })
      : {
          offset: 0,
          limit: Math.min(messages.length, Math.max(intent.count, 1)),
          total: totalMessages,
        };
    const pageMessages = messages.slice(window.offset, window.offset + window.limit);
    const continuationState = continuationKind && (window.offset + pageMessages.length) < totalMessages
      ? buildPagedListContinuationState(continuationKind, {
          offset: window.offset,
          limit: Math.max(pageMessages.length, window.limit),
          total: totalMessages,
        }) as unknown as Record<string, unknown>
      : null;

    if (messages.length === 0) {
      if (intent.kind === 'gmail_recent_senders') {
        return 'I checked Gmail and could not find any recent messages.';
      }
      if (intent.kind === 'gmail_recent_summary') {
        return 'I checked Gmail and could not find any recent messages to summarize.';
      }
      return 'I checked Gmail and found no unread messages.';
    }

    if (pageMessages.length === 0 && window.offset >= totalMessages) {
      return continuationState
        ? { content: 'No additional Gmail messages remain.', metadata: { continuationState } }
        : 'No additional Gmail messages remain.';
    }

    const displayLimit = Math.min(pageMessages.length, Math.max(intent.count, 1));
    const summaries: GmailMessageSummary[] = [];
    for (const entry of pageMessages.slice(0, displayLimit)) {
      const id = toString(entry.id);
      if (!id) continue;

      const detailResult = await this.tools.executeModelTool(
        'gws',
        {
          service: 'gmail',
          resource: 'users messages',
          method: 'get',
          params: {
            userId: 'me',
            messageId: id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          },
        },
        toolRequest,
      );

      if (!toBoolean(detailResult.success)) continue;

      const summary = summarizeGmailMessage(detailResult.output);
      if (summary) summaries.push(summary);
    }

    if (intent.kind === 'gmail_recent_senders') {
      if (summaries.length === 0) {
        return `I found ${pageMessages.length} recent message${pageMessages.length === 1 ? '' : 's'}, but I could not read their sender metadata.`;
      }
      const lines = [`The senders of the last ${summaries.length} email${summaries.length === 1 ? '' : 's'} are:`];
      for (const [index, summary] of summaries.entries()) {
        const from = summary.from || 'Unknown sender';
        const subject = summary.subject || '(no subject)';
        lines.push(`${index + 1}. ${from} — ${subject}`);
      }
      return continuationState
        ? { content: lines.join('\n'), metadata: { continuationState } }
        : lines.join('\n');
    }

    if (intent.kind === 'gmail_recent_summary') {
      if (summaries.length === 0) {
        return `I found ${pageMessages.length} recent message${pageMessages.length === 1 ? '' : 's'}, but I could not read enough metadata to summarize them.`;
      }
      const lines = [`Here are the last ${summaries.length} email${summaries.length === 1 ? '' : 's'}:`];
      for (const [index, summary] of summaries.entries()) {
        const subject = summary.subject || '(no subject)';
        const from = summary.from || 'Unknown sender';
        lines.push(`${index + 1}. ${subject} — ${from}`);
        if (summary.date) lines.push(`   ${summary.date}`);
        if (summary.snippet) lines.push(`   ${summary.snippet}`);
      }
      return continuationState
        ? { content: lines.join('\n'), metadata: { continuationState } }
        : lines.join('\n');
    }

    const lines = [
      `I checked Gmail and found ${totalMessages} unread message${totalMessages === 1 ? '' : 's'}.`,
    ];

    if (summaries.length === 0) {
      for (const [index, entry] of pageMessages.slice(0, displayLimit).entries()) {
        const id = toString(entry.id);
        if (!id) continue;
        lines.push(`${index + 1}. Message ID: ${id}`);
      }
    } else {
      for (const [index, summary] of summaries.entries()) {
        const subject = summary.subject || '(no subject)';
        const from = summary.from || 'Unknown sender';
        lines.push(`${index + 1}. ${subject} — ${from}`);
        if (summary.date) lines.push(`   ${summary.date}`);
        if (summary.snippet) lines.push(`   ${summary.snippet}`);
      }
    }

    if (totalMessages > window.offset + displayLimit) {
      const remaining = totalMessages - (window.offset + displayLimit);
      lines.push(`...and ${remaining} more unread message${remaining === 1 ? '' : 's'}.`);
    }

    if (intent.kind === 'gmail_unread') {
      lines.push('Ask me to read or summarize any of these if you want the full details.');
    }

    return continuationState
      ? { content: lines.join('\n'), metadata: { continuationState } }
      : lines.join('\n');
  }

  private async tryDirectMicrosoft365Write(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;

    const intent = parseDirectGmailWriteIntent(message.content);
    if (!intent) return null;

    let to = intent.to?.trim();
    let subject = intent.subject?.trim();
    const body = intent.body?.trim();

    if (intent.replyTarget === 'latest_unread') {
      if (!body) {
        return `To ${intent.mode} a reply to the newest unread Outlook message, I need the body.`;
      }
      const replyTarget = await this.resolveLatestUnreadMicrosoft365ReplyTarget(message, ctx, userKey);
      if (!replyTarget) {
        return 'I checked Outlook and could not find an unread message to reply to.';
      }
      if (typeof replyTarget === 'string') {
        return replyTarget;
      }
      if (!isDirectMailboxReplyTarget(replyTarget)) {
        return replyTarget;
      }
      to = replyTarget.to;
      subject = replyTarget.subject;
    }

    if (!to || !subject || !body) {
      const missing: string[] = [];
      if (!to) missing.push('recipient email');
      if (!subject) missing.push('subject');
      if (!body) missing.push('body');
      return `To ${intent.mode} an Outlook email, I need the ${missing.join(', ')}.`;
    }
    const toolName = intent.mode === 'send' ? 'outlook_send' : 'outlook_draft';
    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
      ...(message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
    };

    const toolResult = await this.tools.executeModelTool(
      toolName,
      { to, subject, body },
      toolRequest,
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
        if (approvalId) {
          this.setApprovalFollowUp(approvalId, {
            approved: intent.mode === 'send'
              ? 'I sent the Outlook message.'
              : 'I drafted the Outlook message.',
            denied: intent.mode === 'send'
              ? 'I did not send the Outlook message.'
              : 'I did not draft the Outlook message.',
          });
        }
        const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
        const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
        const pendingActionResult = this.setPendingApprovalActionForRequest(
          userKey,
          message.surfaceId,
          {
            prompt,
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: message.content,
            route: 'email_task',
            operation: intent.mode,
            summary: intent.mode === 'send' ? 'Sends an Outlook message.' : 'Creates an Outlook draft.',
            turnRelation: 'new_request',
            resolution: 'ready',
            entities: { emailProvider: 'm365' },
          },
        );
        return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
          `I prepared an Outlook ${intent.mode} to ${to} with subject "${subject}", but it needs approval first.`,
          prompt,
        ].filter(Boolean).join('\n\n'));
      }
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Microsoft 365 request failed.';
      return `I tried to ${intent.mode} the Outlook message, but it failed: ${msg}`;
    }

    return intent.mode === 'send'
      ? `I sent the Outlook message to ${to} with subject "${subject}".`
      : `I drafted an Outlook message to ${to} with subject "${subject}".`;
  }

  private async tryDirectMicrosoft365Read(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    decision?: IntentGatewayDecision,
    continuityThread?: ContinuityThreadRecord | null,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;

    const intent = this.resolveDirectMailboxReadIntent('m365', message.content, decision, continuityThread);
    if (!intent) return null;
    const continuationKind = this.getDirectMailboxContinuationKind('m365', intent.kind);
    const priorWindow = continuationKind
      ? readPagedListContinuationState(continuityThread, continuationKind)
      : null;
    const requestedWindow = continuationKind
      ? resolvePagedListWindow({
          continuityThread,
          continuationKind,
          content: message.content,
          total: priorWindow?.total ?? Math.max(intent.count, 1),
          turnRelation: decision?.turnRelation,
          defaultPageSize: Math.max(intent.count, 1),
        })
      : null;

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
      ...(message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
    };

    const listParams: Record<string, unknown> = {
      $top: Math.max(
        intent.count,
        1,
        requestedWindow ? requestedWindow.offset + Math.max(requestedWindow.limit, 1) : 0,
      ),
      $select: 'id,subject,receivedDateTime,from,isRead',
      $orderby: 'receivedDateTime desc',
    };
    if (intent.kind === 'gmail_unread') {
      listParams.$filter = 'isRead eq false';
    }

    const listResult = await this.tools.executeModelTool(
      'm365',
      {
        service: 'mail',
        resource: 'me/messages',
        method: 'list',
        params: listParams,
      },
      toolRequest,
    );

    if (!toBoolean(listResult.success)) {
      const status = toString(listResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(listResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
        if (approvalId) {
          this.setApprovalFollowUp(approvalId, {
            approved: 'I completed the Outlook inbox check.',
            denied: 'I did not check Outlook.',
          });
        }
        const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
        const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
        const pendingActionResult = this.setPendingApprovalActionForRequest(
          userKey,
          message.surfaceId,
          {
            prompt,
            approvalIds: pendingIds,
            approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
            originalUserContent: message.content,
            route: 'email_task',
            operation: 'read',
            summary: 'Checks Outlook for recent messages.',
            turnRelation: 'new_request',
            resolution: 'ready',
            entities: { emailProvider: 'm365' },
          },
        );
        return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
          'I prepared an Outlook inbox check, but it needs approval first.',
          prompt,
        ].filter(Boolean).join('\n\n'));
      }
      const msg = toString(listResult.message) || toString(listResult.error) || 'Microsoft 365 request failed.';
      return `I tried to check Outlook for messages, but it failed: ${msg}`;
    }

    const output = isRecord(listResult.output) ? listResult.output : null;
    const messages = Array.isArray(output?.value)
      ? output.value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const hasMore = Boolean(toString(output?.['@odata.nextLink']).trim());
    const totalMessages = Math.max(
      messages.length + (hasMore ? 1 : 0),
      priorWindow?.total ?? 0,
    );
    const window = continuationKind
      ? resolvePagedListWindow({
          continuityThread,
          continuationKind,
          content: message.content,
          total: totalMessages,
          turnRelation: decision?.turnRelation,
          defaultPageSize: Math.max(intent.count, 1),
        })
      : {
          offset: 0,
          limit: Math.min(messages.length, Math.max(intent.count, 1)),
          total: totalMessages,
        };
    const pageMessages = messages.slice(window.offset, window.offset + window.limit);
    const continuationState = continuationKind && ((window.offset + pageMessages.length) < totalMessages || hasMore)
      ? buildPagedListContinuationState(continuationKind, {
          offset: window.offset,
          limit: Math.max(pageMessages.length, window.limit),
          total: totalMessages,
        }) as unknown as Record<string, unknown>
      : null;

    if (messages.length === 0) {
      if (intent.kind === 'gmail_recent_senders') {
        return 'I checked Outlook and could not find any recent messages.';
      }
      if (intent.kind === 'gmail_recent_summary') {
        return 'I checked Outlook and could not find any recent messages to summarize.';
      }
      return 'I checked Outlook and found no unread messages.';
    }

    if (pageMessages.length === 0 && window.offset >= totalMessages) {
      return continuationState
        ? { content: 'No additional Outlook messages remain.', metadata: { continuationState } }
        : 'No additional Outlook messages remain.';
    }

    const displayLimit = Math.min(pageMessages.length, Math.max(intent.count, 1));

    if (intent.kind === 'gmail_recent_senders') {
      const lines = [`The senders of the last ${displayLimit} Outlook email${displayLimit === 1 ? '' : 's'} are:`];
      for (const [index, entry] of pageMessages.slice(0, displayLimit).entries()) {
        const from = summarizeM365From(entry.from) || 'Unknown sender';
        const subject = toString(entry.subject) || '(no subject)';
        lines.push(`${index + 1}. ${from} — ${subject}`);
      }
      return continuationState
        ? { content: lines.join('\n'), metadata: { continuationState } }
        : lines.join('\n');
    }

    if (intent.kind === 'gmail_recent_summary') {
      const lines = [`Here are the last ${displayLimit} Outlook email${displayLimit === 1 ? '' : 's'}:`];
      for (const [index, entry] of pageMessages.slice(0, displayLimit).entries()) {
        const subject = toString(entry.subject) || '(no subject)';
        const from = summarizeM365From(entry.from) || 'Unknown sender';
        lines.push(`${index + 1}. ${subject} — ${from}`);
        const received = toString(entry.receivedDateTime);
        if (received) lines.push(`   ${received}`);
      }
      return continuationState
        ? { content: lines.join('\n'), metadata: { continuationState } }
        : lines.join('\n');
    }

    const lines = [
      `Here are the latest ${displayLimit} unread Outlook message${displayLimit === 1 ? '' : 's'}:`,
    ];
    for (const [index, entry] of pageMessages.slice(0, displayLimit).entries()) {
      const subject = toString(entry.subject) || '(no subject)';
      const from = summarizeM365From(entry.from) || 'Unknown sender';
      lines.push(`${index + 1}. ${subject} — ${from}`);
      const received = toString(entry.receivedDateTime);
      if (received) lines.push(`   ${received}`);
    }
    if (totalMessages > window.offset + displayLimit) {
      const remaining = totalMessages - (window.offset + displayLimit);
      lines.push(`...and at least ${remaining} more unread Outlook message${remaining === 1 ? '' : 's'}.`);
    }
    lines.push('Ask me to read or summarize any of these if you want the full details.');
    return continuationState
      ? { content: lines.join('\n'), metadata: { continuationState } }
      : lines.join('\n');
  }

  private getDirectMailboxContinuationKind(
    provider: 'gmail' | 'm365',
    kind: NonNullable<ReturnType<typeof parseDirectGoogleWorkspaceIntent>>['kind'],
  ): string {
    if (provider === 'gmail') {
      switch (kind) {
        case 'gmail_recent_senders':
          return GMAIL_RECENT_SENDERS_CONTINUATION_KIND;
        case 'gmail_recent_summary':
          return GMAIL_RECENT_SUMMARY_CONTINUATION_KIND;
        case 'gmail_unread':
        default:
          return GMAIL_UNREAD_CONTINUATION_KIND;
      }
    }
    switch (kind) {
      case 'gmail_recent_senders':
        return M365_RECENT_SENDERS_CONTINUATION_KIND;
      case 'gmail_recent_summary':
        return M365_RECENT_SUMMARY_CONTINUATION_KIND;
      case 'gmail_unread':
      default:
        return M365_UNREAD_CONTINUATION_KIND;
    }
  }

  private resolveDirectMailboxReadIntent(
    provider: 'gmail' | 'm365',
    content: string,
    decision?: IntentGatewayDecision | null,
    continuityThread?: ContinuityThreadRecord | null,
  ): NonNullable<ReturnType<typeof parseDirectGoogleWorkspaceIntent>> | null {
    const decisionDriven = this.resolveDecisionMailboxReadIntent(provider, content, decision);
    if (decisionDriven) return decisionDriven;
    const parsed = parseDirectGoogleWorkspaceIntent(content);
    if (parsed) return parsed;
    if (!hasPagedListFollowUpRequest(content, decision?.turnRelation)) {
      return null;
    }
    const continuationKinds = provider === 'gmail'
      ? [
          [GMAIL_UNREAD_CONTINUATION_KIND, 'gmail_unread'],
          [GMAIL_RECENT_SENDERS_CONTINUATION_KIND, 'gmail_recent_senders'],
          [GMAIL_RECENT_SUMMARY_CONTINUATION_KIND, 'gmail_recent_summary'],
        ] as const
      : [
          [M365_UNREAD_CONTINUATION_KIND, 'gmail_unread'],
          [M365_RECENT_SENDERS_CONTINUATION_KIND, 'gmail_recent_senders'],
          [M365_RECENT_SUMMARY_CONTINUATION_KIND, 'gmail_recent_summary'],
        ] as const;
    for (const [continuationKind, kind] of continuationKinds) {
      const prior = readPagedListContinuationState(continuityThread, continuationKind);
      if (!prior) continue;
      return {
        kind,
        count: Math.max(1, prior.limit),
      };
    }
    return null;
  }

  private resolveDecisionMailboxReadIntent(
    provider: 'gmail' | 'm365',
    content: string,
    decision?: IntentGatewayDecision | null,
  ): NonNullable<ReturnType<typeof parseDirectGoogleWorkspaceIntent>> | null {
    if (!decision || decision.route !== 'email_task' || decision.operation !== 'read') {
      return null;
    }
    const declaredProvider = decision.entities.emailProvider;
    if (declaredProvider && ((provider === 'gmail' && declaredProvider !== 'gws')
      || (provider === 'm365' && declaredProvider !== 'm365'))) {
      return null;
    }
    const mailboxReadMode = decision.entities.mailboxReadMode;
    if (!mailboxReadMode) return null;
    return {
      kind: mailboxReadMode === 'latest' ? 'gmail_recent_summary' : 'gmail_unread',
      count: parseRequestedEmailCount(content),
    };
  }

  private async resolveLatestUnreadGmailReplyTarget(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
  ): Promise<{ to: string; subject: string } | string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;
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
      'gws',
      {
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: {
          userId: 'me',
          maxResults: 1,
          q: 'is:unread',
        },
      },
      toolRequest,
    );

    if (!toBoolean(listResult.success)) {
      const blocked = this.buildPendingMailboxReplyLookupApproval(
        listResult,
        userKey,
        message,
        'Gmail',
      );
      if (blocked) return blocked;
      const msg = toString(listResult.message) || toString(listResult.error) || 'Gmail request failed.';
      return `I tried to look up the newest unread Gmail message for the reply draft, but it failed: ${msg}`;
    }

    const output = isRecord(listResult.output) ? listResult.output : null;
    const messages = Array.isArray(output?.messages)
      ? output.messages.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const newest = messages[0];
    const id = toString(newest?.id);
    if (!id) return null;

    const detailResult = await this.tools.executeModelTool(
      'gws',
      {
        service: 'gmail',
        resource: 'users messages',
        method: 'get',
        params: {
          userId: 'me',
          messageId: id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject'],
        },
      },
      toolRequest,
    );
    if (!toBoolean(detailResult.success)) {
      const msg = toString(detailResult.message) || toString(detailResult.error) || 'Gmail request failed.';
      return `I found the newest unread Gmail message, but I couldn't read enough metadata to draft the reply: ${msg}`;
    }

    const summary = summarizeGmailMessage(detailResult.output);
    const to = this.extractEmailAddress(summary?.from);
    if (!to) {
      return 'I found the newest unread Gmail message, but I could not determine the sender email address.';
    }
    return {
      to,
      subject: this.buildReplySubject(toString(summary?.subject)),
    };
  }

  private async resolveLatestUnreadMicrosoft365ReplyTarget(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
  ): Promise<{ to: string; subject: string } | string | { content: string; metadata?: Record<string, unknown> } | null> {
    if (!this.tools?.isEnabled()) return null;
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
      'm365',
      {
        service: 'mail',
        resource: 'me/messages',
        method: 'list',
        params: {
          $top: 1,
          $filter: 'isRead eq false',
          $select: 'id,subject,receivedDateTime,from,isRead',
          $orderby: 'receivedDateTime desc',
        },
      },
      toolRequest,
    );

    if (!toBoolean(listResult.success)) {
      const blocked = this.buildPendingMailboxReplyLookupApproval(
        listResult,
        userKey,
        message,
        'Outlook',
      );
      if (blocked) return blocked;
      const msg = toString(listResult.message) || toString(listResult.error) || 'Microsoft 365 request failed.';
      return `I tried to look up the newest unread Outlook message for the reply draft, but it failed: ${msg}`;
    }

    const output = isRecord(listResult.output) ? listResult.output : null;
    const messages = Array.isArray(output?.value)
      ? output.value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const newest = messages[0];
    if (!newest) return null;
    const to = this.extractMicrosoft365EmailAddress(newest.from);
    if (!to) {
      return 'I found the newest unread Outlook message, but I could not determine the sender email address.';
    }
    return {
      to,
      subject: this.buildReplySubject(toString(newest.subject)),
    };
  }

  private buildPendingMailboxReplyLookupApproval(
    toolResult: Record<string, unknown>,
    userKey: string,
    message: UserMessage,
    providerLabel: 'Gmail' | 'Outlook',
  ): string | { content: string; metadata?: Record<string, unknown> } | null {
    const status = toString(toolResult.status);
    if (status !== 'pending_approval') return null;
    const approvalId = toString(toolResult.approvalId);
    const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
    const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
    if (approvalId) {
      this.setApprovalFollowUp(approvalId, {
        approved: `I looked up the newest unread ${providerLabel} message.`,
        denied: `I did not check ${providerLabel}.`,
      });
    }
    const summaries = pendingIds.length > 0 ? this.tools?.getApprovalSummaries(pendingIds) : undefined;
    const prompt = this.formatPendingApprovalPrompt(pendingIds, summaries);
    const pendingActionResult = this.setPendingApprovalActionForRequest(
      userKey,
      message.surfaceId,
      {
        prompt,
        approvalIds: pendingIds,
        approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
        originalUserContent: message.content,
        route: 'email_task',
        operation: 'read',
        summary: `Checks ${providerLabel} for the newest unread message before drafting a reply.`,
        turnRelation: 'new_request',
        resolution: 'ready',
      },
    );
    return this.buildPendingApprovalBlockedResponse(pendingActionResult, [
      `I prepared a ${providerLabel} inbox check to resolve the reply target, but it needs approval first.`,
      prompt,
    ].filter(Boolean).join('\n\n'));
  }

  private buildReplySubject(subject: string): string {
    const trimmed = subject.trim() || '(no subject)';
    return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
  }

  private extractEmailAddress(value: string | undefined): string {
    const text = toString(value).trim();
    if (!text) return '';
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0]?.trim() ?? '';
  }

  private extractMicrosoft365EmailAddress(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    const emailAddress = isRecord(record.emailAddress) ? record.emailAddress : null;
    return toString(emailAddress?.address).trim();
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
    const directSave = await this.tryDirectFilesystemSave(
      message,
      ctx,
      userKey,
      conversationKey,
      codeContext,
      originalUserContent,
      gatewayDecision,
    );
    if (directSave) return directSave;
    return tryDirectFilesystemSearchHelper({
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

  private async tryDirectFilesystemSave(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    conversationKey: ConversationKey,
    codeContext?: { workspaceRoot: string; sessionId?: string },
    originalUserContent?: string,
    gatewayDecision?: IntentGatewayDecision,
  ): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
    return tryDirectFilesystemSaveHelper({
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
    conversationKey: ConversationKey,
  ): string | null {
    return resolveRetryAfterFailureContinuationContentHelper({
      content,
      continuityThread,
      conversationKey,
      readLatestAssistantOutput: (nextConversationKey) => this.readLatestAssistantOutput(nextConversationKey),
    });
  }

  private readLatestAssistantOutput(conversationKey: ConversationKey): string {
    return readLatestAssistantOutputHelper({
      conversationService: this.conversationService,
      conversationKey,
    });
  }

  private async resumeStoredDirectRoutePendingAction(
    pendingAction: PendingActionRecord,
    options?: { pendingActionAlreadyCleared?: boolean; approvalResult?: ToolApprovalDecisionResult },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return resumeStoredDirectRoutePendingActionHelper({
      pendingAction,
      options,
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
      executeStoredFilesystemSave: (input) => this.executeStoredFilesystemSave(input),
      executeStoredSecondBrainMutation: (nextPendingAction, resume, approvalResult) => this.executeStoredSecondBrainMutation(
        nextPendingAction,
        resume,
        approvalResult,
      ),
    });
  }

  private normalizeDirectRouteContinuationResponse(
    response: { content: string; metadata?: Record<string, unknown> },
    userId: string,
    channel: string,
    surfaceId?: string,
  ): { content: string; metadata?: Record<string, unknown> } {
    return normalizeDirectRouteContinuationResponseHelper({
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

  private buildToolLoopResumePayload(
    input: Parameters<typeof buildToolLoopResumePayload>[0],
  ): Record<string, unknown> {
    return buildToolLoopResumePayload(input);
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

  private async resumeStoredToolLoopPendingAction(
    pendingAction: PendingActionRecord,
    options?: {
      approvalId?: string;
      pendingActionAlreadyCleared?: boolean;
      approvalResult?: ToolApprovalDecisionResult;
      ctx?: AgentContext;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return resumeStoredToolLoopPendingActionHelper({
      pendingAction,
      options,
      agentId: this.id,
      tools: this.tools,
      secondBrainService: this.secondBrainService,
      maxToolRounds: this.maxToolRounds,
      contextBudget: this.contextBudget,
      normalizePrincipalRole: (value) => normalizeFilesystemResumePrincipalRole(value),
      buildChatRunner: (input) => this.buildStoredToolLoopChatFn(input),
      completePendingAction: (actionId, nowMs) => this.completePendingAction(actionId, nowMs),
      sanitizeToolResultForLlm: (toolName, result, providerKind) => this.sanitizeToolResultForLlm(
        toolName,
        result,
        providerKind,
      ),
      isResponseDegraded: (content) => this.isResponseDegraded(content),
      storeSuspendedSession: ({ scope, llmMessages, pendingTools, originalMessage, ctx }) => {
        const normalizedScope = normalizeApprovalContinuationScope(scope);
        this.suspendedSessions.set(
          buildApprovalContinuationScopeKey(normalizedScope),
          {
            scope: normalizedScope,
            llmMessages,
            pendingTools,
            originalMessage,
            ...(ctx
              ? { ctx }
              : {
                  ctx: {
                    agentId: this.id,
                    emit: async () => {},
                    checkAction: () => {},
                    capabilities: [],
                  } as AgentContext,
                }),
          },
        );
      },
      setPendingApprovalAction: (userId, channel, surfaceId, action, nowMs) => this.setPendingApprovalAction(
        userId,
        channel,
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

  private async executeStoredSecondBrainMutation(
    pendingAction: PendingActionRecord,
    resume: SecondBrainMutationResumePayload,
    approvalResult?: ToolApprovalDecisionResult,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    return executeStoredSecondBrainMutationHelper({
      pendingAction,
      resume,
      approvalResult,
      agentId: this.id,
      tools: this.tools,
      getContinuityThread: (userId, nowMs) => this.getContinuityThread(userId, nowMs),
      readSecondBrainFocusContinuationState,
      buildDirectSecondBrainMutationSuccessResponse: (descriptor, output, focusState) => this.buildDirectSecondBrainMutationSuccessResponse(
        descriptor,
        output,
        focusState as SecondBrainFocusContinuationPayload | null | undefined,
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
      buildPendingApprovalBlockedResponse: (result, fallbackContent) => this.buildPendingApprovalBlockedResponse(result, fallbackContent),
    });
  }

}

}
