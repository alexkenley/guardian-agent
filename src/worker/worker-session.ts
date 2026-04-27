import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { UserMessage } from '../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ContentTrustLevel, ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import {
  formatPendingApprovalMessage,
  isPhantomPendingApprovalMessage,
} from '../runtime/pending-approval-copy.js';
import { sanitizePendingActionPrompt } from '../runtime/pending-actions.js';
import {
  buildChatResponseSourceMetadata,
  buildLocalModelTooComplicatedMessage,
  isLocalToolCallParseError,
  shouldBypassLocalModelComplexityGuard,
  type ResponseSourceMetadata,
} from '../runtime/model-routing-ux.js';
import { tryAutomationPreRoute } from '../runtime/automation-prerouter.js';
import { tryAutomationControlPreRoute } from '../runtime/automation-control-prerouter.js';
import { tryAutomationOutputPreRoute } from '../runtime/automation-output-prerouter.js';
import { tryBrowserPreRoute } from '../runtime/browser-prerouter.js';
import {
  resolveDirectIntentRoutingCandidates,
} from '../runtime/direct-intent-routing.js';
import {
  enrichIntentGatewayRecordWithContentPlan,
  IntentGateway,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
  toIntentGatewayClientMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRecord,
} from '../runtime/intent-gateway.js';
import {
  buildChatMessagesFromHistory,
  buildSystemPromptWithContext,
  type PromptAssemblyAdditionalSection,
  type PromptAssemblyContinuity,
  type PromptAssemblyKnowledgeBase,
  type PromptAssemblyPendingAction,
} from '../runtime/context-assembly.js';
import {
  readSelectedExecutionProfileMetadata,
  type SelectedExecutionProfile,
} from '../runtime/execution-profiles.js';
import {
  handleDirectReasoningMode,
  shouldHandleDirectReasoningMode,
  type DirectReasoningTraceContext,
} from '../runtime/direct-reasoning-mode.js';
import type { DirectReasoningGraphContext } from '../runtime/execution-graph/direct-reasoning-node.js';
import {
  buildRoutedIntentAdditionalSection,
  buildToolExecutionCorrectionPrompt,
  prepareToolExecutionForIntent,
} from '../runtime/routed-tool-execution.js';
import { readApprovalOutcomeContinuationMetadata } from '../runtime/approval-continuations.js';
import {
  buildWorkerExecutionMetadata,
  type WorkerExecutionLifecycle,
  type WorkerExecutionSource,
  type WorkerExecutionTerminationReason,
} from '../runtime/worker-execution-metadata.js';
import {
  attachWorkerSuspensionMetadata,
  readWorkerSuspensionMetadata,
  WORKER_SUSPENSION_SCHEMA_VERSION,
  type SerializedWorkerSuspensionSession,
} from '../runtime/worker-suspension.js';
import {
  buildDelegatedExecutionMetadata,
  readDelegatedResultEnvelope,
} from '../runtime/execution/metadata.js';
import {
  buildRecoveryAdvisorMessages,
  parseRecoveryAdvisorProposal,
  type RecoveryAdvisorRequest,
} from '../runtime/execution/recovery-advisor.js';
import {
  buildDelegatedTaskContract,
} from '../runtime/execution/verifier.js';
import {
  buildStepReceipts,
  computeWorkerRunStatus,
  findAnswerStepId,
  matchPlannedStepForTool,
} from '../runtime/execution/task-plan.js';
import type {
  Claim,
  DelegatedTaskContract,
  DelegatedResultEnvelope,
  EvidenceReceipt,
  ExecutionEvent,
  Interruption,
  ProviderSelectionSnapshot,
  WorkerRunStatus,
  WorkerStopReason,
} from '../runtime/execution/types.js';
import {
  runLlmLoop,
  type LlmLoopOutcome,
  type LlmLoopToolEvent,
  type PolicyBlockedToolSample,
} from './worker-llm-loop.js';
import {
  attachWorkerAutomationAuthoringResumeMetadata,
  buildWorkerAutomationAuthoringResume,
  buildWorkerAutomationAuthoringResumeMessage,
  readWorkerAutomationAuthoringResumeMetadata,
} from './automation-resume.js';
import { BrokerClient } from '../broker/broker-client.js';
import { buildToolResultPayloadFromJob } from '../tools/job-results.js';
import { shouldAllowModelMemoryMutation } from '../util/memory-intent.js';
import { isToolReportQuery, formatToolReport } from '../util/tool-report.js';
import {
  formatToolResultForLLM,
  getCodeSessionPromptRelativePath,
  stripLeadingContextPrefix,
  toLLMToolDef,
} from '../chat-agent-helpers.js';
import {
  buildAnswerFirstSkillFallbackResponse,
  buildAnswerFirstSkillCorrectionPrompt,
  isAnswerFirstSkillResponseSufficient,
  shouldUseAnswerFirstForSkills,
} from '../util/answer-first-skills.js';
import type { ExecutionPlan, PlanNode } from '../runtime/planner/types.js';
import type { PlanExecutionOutcome, PlanExecutionPauseControl } from '../runtime/planner/orchestrator.js';

const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;
const EMPTY_RESPONSE_FALLBACK_CONTENT = 'I could not generate a final response for that request.';
const TOOL_TRACE_PREVIEW_MAX_CHARS = 12_000;
const TOOL_TRACE_PREVIEW_TOOL_NAMES = new Set(['fs_list', 'fs_read', 'fs_search', 'code_symbol_search']);
const PLANNER_TOOL_ALIASES = new Map<string, string>([
  ['fs_readfile', 'fs_read'],
  ['fs_writefile', 'fs_write'],
  ['read_file', 'fs_read'],
  ['write_file', 'fs_write'],
  ['mkdir', 'fs_mkdir'],
]);

interface PendingApprovalState {
  ids: string[];
  expiresAt: number;
}

interface ToolReportScope {
  userId: string;
  channel: string;
  requestId?: string;
  codeSessionId?: string;
}

interface SuspendedToolCall {
  approvalId: string;
  toolCallId: string;
  jobId: string;
  name: string;
}

interface SuspendedToolLoopSession {
  kind: 'tool_loop';
  llmMessages: ChatMessage[];
  pendingTools: SuspendedToolCall[];
  originalMessage: UserMessage;
  taskContract?: DelegatedTaskContract;
  executionProfile?: SelectedExecutionProfile;
}

interface SuspendedPlannerNode {
  nodeId: string;
  approvalId: string;
  jobId: string;
  toolName: string;
}

interface PlannerTrustSnapshot {
  contentTrustLevel: ContentTrustLevel;
  taintReasons: string[];
}

interface SuspendedPlannerSession {
  kind: 'planner';
  plan: ExecutionPlan;
  pendingNodes: SuspendedPlannerNode[];
  originalMessage: UserMessage;
  trustState: PlannerTrustSnapshot;
  executionProfile?: SelectedExecutionProfile;
}

type SuspendedSession = SuspendedToolLoopSession | SuspendedPlannerSession;

interface PendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
}

interface PolicyRemediationCandidate {
  action: 'add_path' | 'add_domain' | 'add_command';
  value: string;
  sourceToolName: string;
}

export interface WorkerGroundedSynthesisRequest {
  messages: ChatMessage[];
  responseFormat?: ChatOptions['responseFormat'];
  maxTokens?: number;
  temperature?: number;
}

type BrokeredChatResponse = ChatResponse & {
  providerName?: string;
  providerLocality?: 'local' | 'external';
};

function buildWorkerPromptAdditionalSections(
  baseSections: PromptAssemblyAdditionalSection[] | undefined,
  intentDecision?: IntentGatewayDecision | null,
): PromptAssemblyAdditionalSection[] | undefined {
  const sections = [...(baseSections ?? [])];
  const routedIntentSection = buildRoutedIntentAdditionalSection(intentDecision);
  if (routedIntentSection && !sections.some((section) => section.section === routedIntentSection.section)) {
    sections.push(routedIntentSection);
  }
  return sections.length > 0 ? sections : undefined;
}

function shouldReuseWorkerPreRoutedIntentGateway(
  record: IntentGatewayRecord | null | undefined,
): record is IntentGatewayRecord {
  if (!record) return false;
  if (record.available === false) return true;
  return shouldReusePreRoutedIntentGateway(record);
}

export interface WorkerMessageHandleParams {
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBases: PromptAssemblyKnowledgeBase[];
  activeSkills: Array<{ id: string; name: string; summary: string; description?: string; role?: string; sourcePath?: string }>;
  additionalSections?: PromptAssemblyAdditionalSection[];
  toolContext: string;
  runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
  executionProfile?: SelectedExecutionProfile;
  continuity?: PromptAssemblyContinuity | null;
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  /** Whether a fallback provider is available on the supervisor side for quality-based retry. */
  hasFallbackProvider?: boolean;
  /** Run this turn through the brokered direct-reasoning read-only loop. */
  directReasoning?: boolean;
  directReasoningTrace?: DirectReasoningTraceContext;
  directReasoningGraphContext?: DirectReasoningGraphContext;
  directReasoningGraphLifecycle?: 'standalone' | 'node_only';
  returnExecutionGraphArtifacts?: boolean;
  /** Run a no-tools grounded synthesis node for the execution graph controller. */
  groundedSynthesis?: WorkerGroundedSynthesisRequest;
  /** Run a no-tools recovery advisor call for a failed delegated contract. */
  recoveryAdvisor?: RecoveryAdvisorRequest;
}

function buildApprovalPendingActionMetadata(
  approvals: PendingApprovalMetadata[],
  responseSource?: ResponseSourceMetadata,
  source: WorkerExecutionSource = 'tool_loop',
): Record<string, unknown> {
  return {
    pendingAction: {
      status: 'pending',
      blocker: {
        kind: 'approval',
        prompt: formatPendingApprovalMessage(approvals),
        approvalSummaries: approvals.map((approval) => ({ ...approval })),
      },
    },
    continueConversationAfterApproval: true,
    ...buildWorkerExecutionMetadata({
      lifecycle: 'blocked',
      source,
      completionReason: 'approval_pending',
      responseQuality: 'final',
      blockerKind: 'approval',
      pendingApprovalCount: approvals.length,
    }),
    ...(responseSource ? { responseSource } : {}),
  };
}

function buildClarificationPendingActionMetadata(
  prompt: string,
  responseSource?: ResponseSourceMetadata,
): Record<string, unknown> {
  return {
    pendingAction: {
      status: 'pending',
      blocker: {
        kind: 'clarification',
        prompt,
      },
    },
    ...buildWorkerExecutionMetadata({
      lifecycle: 'blocked',
      source: 'tool_loop',
      completionReason: 'model_response',
      responseQuality: 'final',
      blockerKind: 'clarification',
    }),
    ...(responseSource ? { responseSource } : {}),
  };
}

function buildPolicyBlockedClarificationPrompt(
  samples: Array<{ toolName: string; message: string }>,
): string {
  const bullets = samples
    .map(({ toolName, message }) => `- ${toolName}: ${message || 'blocked by tool policy.'}`)
    .join('\n');
  return [
    'I could not complete the requested action because tool policy blocked it.',
    bullets,
    'Approve an allowlist update (for example via update_tool_policy with action "add_path", "add_domain", or "add_command"), or tell me a different target that is already allowed, and I will retry.',
  ].join('\n\n');
}

function buildToolLoopExecutionMetadata(
  outcome: LlmLoopOutcome,
  options?: {
    phantomApproval?: boolean;
    runStatus?: WorkerRunStatus;
  },
): Record<string, unknown> {
  const phantomApproval = options?.phantomApproval === true;
  const lifecycle = phantomApproval
    ? 'failed'
    : mapWorkerExecutionLifecycle(options?.runStatus, outcome.stopReason);
  return buildWorkerExecutionMetadata({
    lifecycle,
    source: 'tool_loop',
    completionReason: phantomApproval ? 'phantom_approval_response' : outcome.completionReason,
    responseQuality: phantomApproval ? 'degraded' : outcome.responseQuality,
    terminationReason: phantomApproval
      ? 'clean_exit'
      : mapWorkerExecutionTerminationReason(options?.runStatus, outcome.stopReason),
    roundCount: outcome.roundCount,
    toolCallCount: outcome.toolCallCount,
    toolResultCount: outcome.toolResultCount,
    successfulToolResultCount: outcome.successfulToolResultCount,
  });
}

function mapWorkerExecutionLifecycle(
  runStatus: WorkerRunStatus | undefined,
  stopReason: WorkerStopReason,
): WorkerExecutionLifecycle {
  switch (runStatus) {
    case 'completed':
      return 'completed';
    case 'suspended':
      return 'blocked';
    case 'failed':
    case 'incomplete':
    case 'max_turns':
      return 'failed';
    default:
      return stopReason === 'approval_required' ? 'blocked' : 'failed';
  }
}

function mapWorkerExecutionTerminationReason(
  runStatus: WorkerRunStatus | undefined,
  stopReason: WorkerStopReason,
): WorkerExecutionTerminationReason {
  if (stopReason === 'max_rounds' || stopReason === 'max_tokens' || runStatus === 'max_turns') {
    return 'max_rounds';
  }
  if (stopReason === 'error' || runStatus === 'failed') {
    return 'provider_error';
  }
  return 'clean_exit';
}

function deriveWorkerLoopBudget(
  taskContract: DelegatedTaskContract,
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
): { maxRounds: number; contextBudget: number } {
  const requiredStepCount = Math.max(
    1,
    taskContract.plan.steps.filter((step) => step.required !== false).length,
  );
  const baseContextBudget = selectedExecutionProfile?.contextBudget ?? 80_000;
  return {
    maxRounds: Math.min(96, 30 + Math.max(0, requiredStepCount - 1) * 10),
    contextBudget: Math.min(240_000, baseContextBudget + Math.max(0, requiredStepCount - 1) * 20_000),
  };
}

function buildAnswerOnlyTaskContract(
  taskContract: DelegatedTaskContract,
  summary: string,
): DelegatedTaskContract {
  const normalizedSummary = summary.trim() || taskContract.summary?.trim() || 'Answer the request directly.';
  return {
    ...taskContract,
    kind: 'general_answer',
    requiresEvidence: false,
    allowsAnswerFirst: true,
    requireExactFileReferences: false,
    summary: normalizedSummary,
    plan: {
      planId: `${taskContract.plan.planId}:answer_only`,
      steps: [{
        stepId: 'step_1',
        kind: 'answer',
        summary: normalizedSummary,
        required: true,
      }],
      allowAdditionalSteps: false,
    },
  };
}

function shouldPromoteAnswerOnlyTaskContract(
  outcome: LlmLoopOutcome,
  preferAnswerFirst: boolean,
): boolean {
  if (!preferAnswerFirst) {
    return false;
  }
  if (outcome.toolCallCount > 0 || outcome.toolResultCount > 0) {
    return false;
  }
  return outcome.completionReason === 'answer_first_response'
    || outcome.completionReason === 'answer_first_fallback';
}

function shouldUseDelegatedAnswerFirstLane(input: {
  taskContract: DelegatedTaskContract;
  intentDecision: IntentGatewayDecision | undefined;
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined;
}): boolean {
  if (!input.taskContract.allowsAnswerFirst) {
    return false;
  }
  if (input.intentDecision?.executionClass === 'direct_assistant') {
    return true;
  }
  if (input.intentDecision?.preferredAnswerPath === 'direct') {
    return true;
  }
  return input.selectedExecutionProfile?.preferredAnswerPath === 'direct';
}

function shouldAllowSkillAnswerFirstLane(input: {
  taskContract: DelegatedTaskContract;
  intentDecision: IntentGatewayDecision | undefined;
}): boolean {
  if (input.taskContract.allowsAnswerFirst) {
    return true;
  }
  if (input.taskContract.kind !== 'general_answer') {
    return false;
  }
  const requiresReadOrToolEvidence = input.taskContract.plan.steps.some((step) => (
    step.required !== false
    && (
      step.kind === 'read'
      || step.kind === 'search'
      || step.kind === 'tool_call'
      || step.kind === 'memory_save'
    )
  ));
  if (
    requiresReadOrToolEvidence
    && (
      input.intentDecision?.requiresToolSynthesis === true
      || input.intentDecision?.requiresRepoGrounding === true
      || input.intentDecision?.preferredAnswerPath === 'tool_loop'
    )
  ) {
    return false;
  }
  return true;
}

function hasActiveWritingPlansSkill(
  skills: ReadonlyArray<{ id?: string | null }>,
): boolean {
  return skills.some((skill) => skill.id === 'writing-plans');
}

function appendSystemGuidance(
  llmMessages: ChatMessage[],
  guidance: string | null | undefined,
): void {
  const normalized = guidance?.trim();
  if (!normalized) {
    return;
  }
  const firstMsg = llmMessages[0];
  if (firstMsg?.role === 'system') {
    firstMsg.content += `\n\n${normalized}`;
  } else {
    llmMessages.unshift({
      role: 'system',
      content: normalized,
    });
  }
}

function buildDelegatedAnswerFirstCorrectionPrompt(
  taskContract: DelegatedTaskContract,
  allowDelegatedAnswerFirst: boolean,
  originalRequest: string,
  skillCorrectionPrompt: string | undefined,
): string | undefined {
  if (skillCorrectionPrompt?.trim()) {
    return skillCorrectionPrompt;
  }
  if (!taskContract.allowsAnswerFirst || !allowDelegatedAnswerFirst) {
    return undefined;
  }
  const normalizedRequest = originalRequest.trim() || taskContract.summary?.trim() || 'the user request';
  return [
    'System correction: answer the request directly in plain text.',
    `Answer this request directly: "${normalizedRequest}"`,
    'Do not restate the instructions.',
    'Do not narrate what you plan to do.',
    'Do not mention tools unless the user explicitly asked about them.',
  ].join(' ');
}

function buildDelegatedModelProvenance(
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
  responseSource: ResponseSourceMetadata | undefined,
): ProviderSelectionSnapshot | undefined {
  if (!selectedExecutionProfile && !responseSource) return undefined;
  return {
    ...(selectedExecutionProfile?.providerName ? { requestedProviderName: selectedExecutionProfile.providerName } : {}),
    ...(selectedExecutionProfile?.requestedTier ? { requestedTier: selectedExecutionProfile.requestedTier } : {}),
    ...(responseSource?.providerName ? { resolvedProviderName: responseSource.providerName } : {}),
    ...(responseSource?.providerName ? { resolvedProviderType: responseSource.providerName } : {}),
    ...(responseSource?.model ? { resolvedProviderModel: responseSource.model } : {}),
    ...(responseSource?.providerProfileName ? { resolvedProviderProfileName: responseSource.providerProfileName } : {}),
    ...(responseSource?.providerTier ? { resolvedProviderTier: responseSource.providerTier } : {}),
    ...(responseSource?.locality ? { resolvedProviderLocality: responseSource.locality } : {}),
    ...(responseSource?.usedFallback === true ? { resolvedViaFallback: true } : {}),
    ...(selectedExecutionProfile?.selectionSource ? { selectionSource: selectedExecutionProfile.selectionSource } : {}),
  };
}

function normalizeEvidenceRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractRefsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    const normalized = normalizeEvidenceRef(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractRefsFromUnknown(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === 'output'
      || key === 'path'
      || key === 'file'
      || key === 'files'
      || key === 'paths'
      || key === 'workspaceRoot'
      || key === 'relativePath'
      || key === 'matches'
    ) {
      refs.push(...extractRefsFromUnknown(entry));
    }
  }
  return refs;
}

function buildEvidenceSummary(toolName: string, result: Record<string, unknown> | undefined, errorMessage?: string): string {
  if (errorMessage?.trim()) {
    return `${toolName} failed: ${errorMessage.trim()}`;
  }
  const message = typeof result?.message === 'string' && result.message.trim()
    ? result.message.trim()
    : typeof result?.error === 'string' && result.error.trim()
      ? result.error.trim()
      : typeof result?.status === 'string' && result.status.trim()
        ? `${toolName} ${result.status.trim()}`
        : `Completed ${toolName}.`;
  return message.length > 220 ? `${message.slice(0, 217).trimEnd()}...` : message;
}

function truncateInlineText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncateToolTracePreview(value: string): string {
  if (value.length <= TOOL_TRACE_PREVIEW_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, TOOL_TRACE_PREVIEW_MAX_CHARS - 25)}\n[... trace preview truncated ...]`;
}

function buildToolTracePreview(toolName: string, result: Record<string, unknown> | undefined): string | undefined {
  if (!result || !TOOL_TRACE_PREVIEW_TOOL_NAMES.has(toolName)) {
    return undefined;
  }
  const formatted = formatToolResultForLLM(toolName, result);
  if (formatted.trim()) {
    return truncateToolTracePreview(formatted);
  }
  try {
    return truncateToolTracePreview(JSON.stringify(result));
  } catch {
    return undefined;
  }
}

function buildExactFileReferenceGuidance(taskContract: DelegatedTaskContract): string | null {
  if (taskContract.requireExactFileReferences !== true) {
    return null;
  }
  const constraints = taskContract.answerConstraints;
  const lines: string[] = [
    'Exact file reference contract:',
    'Only read or cite paths that came from successful fs_search/fs_list/code_symbol_search results or successful fs_read results.',
    'Start from the repo or workspace root unless the user explicitly named a narrower path or a prior successful search result justifies narrowing the scope.',
    'Treat tests, harnesses, examples, and prompt-echo matches as leads only unless the request explicitly asks for tests or harness behavior.',
    'If the first search results are empty, too broad, or mostly echo the prompt or point at tests, broaden back to the repo root and try adjacent implementation terms before ending the turn.',
    'Do not assume a subdirectory is authoritative just because the request mentions "worker", "timeline", "contract", or similar terms; verify the implementation files from actual search results first.',
    'For exact-file repo inspections, search and symbol results are only leads; read the actual implementation files with fs_read or fs_list before answering.',
    'When the user asks where behavior is implemented, prefer non-test source files that contain the implementation logic, not files that only import, test, document, or quote that behavior.',
    'Do not invent filenames or sibling paths after an ENOENT or a failed read/list call.',
    'If a guessed path fails, go back to the successful search/list results and narrow using the exact returned relativePath values.',
    'Before the final answer, make sure the exact file paths you name match the paths backed by successful tool receipts.',
  ];

  if (constraints) {
    lines.push('');
    lines.push('Answer quality requirements:');
    if (constraints.requiresImplementationFiles) {
      lines.push('- You MUST identify and read the actual implementation files, not just files that match the search query. After searching, use fs_read on the most likely implementation files before answering.');
      lines.push('- Search broadly first (e.g., across src/runtime, src/worker, src/supervisor) then narrow by reading the most promising files. Do not stop at the first search result.');
      lines.push('- An implementation file is one that contains the primary logic for the requested functionality — not a test, not a type-only re-export, not a helper that merely imports the real implementation.');
    }
    if (constraints.requiresSymbolNames) {
      lines.push('- You MUST include the exact function names, type names, or symbol names that implement the requested functionality. Use backtick formatting for code identifiers like `functionName` or `TypeName`.');
    }
    if (constraints.readonly) {
      lines.push('- This is a read-only inspection. Do not write, create, or modify any files.');
    }
  }

  return lines.join('\n');
}

function buildDelegatedTaskPlanGuidance(taskContract: DelegatedTaskContract): string | null {
  const requiredSteps = taskContract.plan.steps.filter((step) => step.required !== false);
  if (requiredSteps.length <= 0) {
    return null;
  }
  const stepLines = requiredSteps.map((step) => {
    const dependencySummary = step.dependsOn?.length
      ? ` (depends on ${step.dependsOn.join(', ')})`
      : '';
    const toolSummary = step.expectedToolCategories?.length
      ? ` [required tools/categories: ${step.expectedToolCategories.join(', ')}]`
      : '';
    return `- ${step.stepId} [${step.kind}]${dependencySummary}: ${step.summary}${toolSummary}`;
  });
  const answerSteps = requiredSteps.filter((step) => step.kind === 'answer');
  const hasCatalogEvidenceStep = requiredSteps.some((step) => (
    step.kind !== 'answer'
    && (step.expectedToolCategories?.some(isCatalogEvidenceCategory) ?? false)
  ));
  return [
    'Delegated task contract:',
    `kind: ${taskContract.kind}`,
    ...(taskContract.route ? [`route: ${taskContract.route}`] : []),
    ...(taskContract.operation ? [`operation: ${taskContract.operation}`] : []),
    'Required planned steps:',
    ...stepLines,
    'Complete every required planned step before ending the turn.',
    ...(requiredSteps.some((step) => (step.expectedToolCategories?.length ?? 0) > 0)
      ? [
          'A tool call only satisfies a planned step when it matches that step\'s expected tool categories.',
          'When a required exact tool name is visible, call that tool directly. If it is not visible, call find_tools with that exact tool name before using substitutes.',
        ]
      : []),
    ...(hasCatalogEvidenceStep && answerSteps.length > 0
      ? [
          'Catalog/list evidence grounding rule:',
          'When answering from automation or Second Brain catalog/list tools, use exact names, ids, enabled/status fields, and summaries returned by successful tool receipts.',
          'If the catalog/list evidence has no matching item, say that plainly and base the recommendation on the absence of a match.',
          'Do not describe a catalog item as a likely match unless the returned evidence explicitly supports that relation.',
        ]
      : []),
    ...(answerSteps.length > 0
      ? [
          'Required final answer criteria:',
          ...answerSteps.map((step) => `- ${step.stepId}: ${step.summary}`),
          'Do not treat the run as complete until the final answer satisfies every required answer step above.',
        ]
      : []),
    ...(requiredSteps.some((step) => step.kind === 'write')
      ? [
          'Write-step completion rule:',
          'A write step is satisfied only by a successful filesystem mutation tool receipt such as fs_write, fs_mkdir, fs_delete, fs_move, or fs_copy. A chat answer saying the file was written is not sufficient.',
          'When a write step names an output path, call fs_write/fs_mkdir for that exact path before ending the turn. This still applies when the preceding search found no rows; create the requested output with safe empty or no-match content that respects the user format constraint.',
          'For security or credential scans, never write secret values to the output file. Write only the sanitized fields requested by the user, such as file paths and line numbers.',
        ]
      : []),
  ].join('\n');
}

function isCatalogEvidenceCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'automation'
    || normalized.startsWith('automation_')
    || normalized === 'second_brain'
    || normalized.startsWith('second_brain_');
}

function mapEvidenceStatus(result: Record<string, unknown> | undefined, errorMessage?: string): EvidenceReceipt['status'] {
  if (errorMessage) return 'failed';
  const status = typeof result?.status === 'string' ? result.status.trim().toLowerCase() : '';
  if (status === 'pending_approval') return 'pending_approval';
  if (status === 'denied' || status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'error') return 'failed';
  if (result?.success === false) return 'failed';
  return 'succeeded';
}

function canonicalizeEvidenceRef(
  value: string,
  workspaceRoot: string | undefined,
): string | null {
  const normalized = normalizeEvidenceRef(value);
  if (!normalized) return null;
  if (workspaceRoot) {
    const relativePath = getCodeSessionPromptRelativePath(normalized, workspaceRoot);
    if (relativePath && relativePath !== '.') {
      return relativePath;
    }
  }
  return normalized.replace(/\\/g, '/');
}

function canonicalizeEvidenceRefs(
  refs: string[],
  workspaceRoot: string | undefined,
): string[] {
  const canonicalRefs = new Set<string>();
  for (const ref of refs) {
    const canonical = canonicalizeEvidenceRef(ref, workspaceRoot);
    if (canonical) {
      canonicalRefs.add(canonical);
    }
  }
  return [...canonicalRefs];
}

function buildToolReceipt(
  event: LlmLoopToolEvent,
  workspaceRoot: string | undefined,
): EvidenceReceipt | null {
  if (event.phase !== 'completed') return null;
  const includeArgumentRefs = event.toolCall.name !== 'fs_search'
    && event.toolCall.name !== 'code_symbol_search';
  return {
    receiptId: `${event.toolCall.id}:receipt`,
    sourceType: 'tool_call',
    toolName: event.toolCall.name,
    status: mapEvidenceStatus(event.result, event.errorMessage),
    refs: canonicalizeEvidenceRefs([
      ...(includeArgumentRefs ? extractRefsFromUnknown(event.args) : []),
      ...extractRefsFromUnknown(event.result?.output),
      ...extractRefsFromUnknown(event.result),
    ], workspaceRoot),
    summary: buildEvidenceSummary(event.toolCall.name, event.result, event.errorMessage),
    startedAt: event.startedAt,
    endedAt: event.endedAt ?? event.startedAt,
  };
}

function buildToolExecutionEvent(event: LlmLoopToolEvent): ExecutionEvent {
  const traceResultPreview = event.phase === 'completed'
    ? buildToolTracePreview(event.toolCall.name, event.result)
    : undefined;
  const rawOutput = event.phase === 'completed' && event.result && 'output' in event.result
    ? JSON.stringify(event.result.output)
    : undefined;
  return {
    eventId: `${event.toolCall.id}:${event.phase}`,
    nodeId: event.toolCall.id,
    type: event.phase === 'started' ? 'tool_call_started' : 'tool_call_completed',
    timestamp: event.phase === 'started' ? event.startedAt : (event.endedAt ?? event.startedAt),
    payload: {
      toolCallId: event.toolCall.id,
      toolName: event.toolCall.name,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      args: event.args,
      ...(event.result ? { resultStatus: event.result.status, resultMessage: event.result.message } : {}),
      ...(traceResultPreview ? { traceResultPreview } : {}),
      ...(rawOutput ? { rawOutput } : {}),
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    },
  };
}

const READ_ONLY_EVIDENCE_TOOLS = new Set([
  'find_tools', 'fs_list', 'fs_read', 'fs_search', 'code_symbol_search',
  'code_git_diff', 'memory_search', 'memory_recall', 'sys_info',
  'sys_resources', 'sys_processes', 'web_search', 'web_fetch',
  'intel_summary', 'intel_findings', 'security_alert_search',
  'windows_defender_status', 'code_session_list', 'code_session_current',
  'code_session_attach', 'code_session_detach', 'code_session_create',
  'automation_list',
  'second_brain_overview', 'second_brain_brief_list', 'second_brain_note_list',
  'second_brain_task_list', 'second_brain_calendar_list', 'second_brain_people_list',
  'second_brain_library_list', 'second_brain_routine_list', 'second_brain_routine_catalog',
]);

function isReadOnlyEvidenceTool(toolName: string): boolean {
  return READ_ONLY_EVIDENCE_TOOLS.has(toolName);
}

function buildClaimsFromReceipts(
  receipts: EvidenceReceipt[],
  taskContract: DelegatedTaskContract,
): Claim[] {
  const claims: Claim[] = [];
  const isRepoInspection = taskContract.kind === 'repo_inspection' || taskContract.kind === 'security_analysis';
  for (const receipt of receipts) {
    if (receipt.refs.length > 0) {
      for (const ref of receipt.refs) {
        // For repo_inspection contracts, classify fs_read receipts as
        // implementation_file claims (the worker read these files to answer
        // the question) vs fs_search/fs_list receipts as file_reference claims
        // (these are search hits).
        const isImplementationRead = isRepoInspection
          && receipt.toolName === 'fs_read'
          && receipt.status === 'succeeded';
        claims.push({
          claimId: `${receipt.receiptId}:file:${ref}`,
          kind: isImplementationRead ? 'implementation_file' : 'file_reference',
          subject: ref,
          value: ref,
          evidenceReceiptIds: [receipt.receiptId],
          confidence: isImplementationRead ? 0.9 : 0.8,
        });
      }
    }
    if (
      taskContract.kind === 'filesystem_mutation'
      && receipt.status === 'succeeded'
      && receipt.toolName
      && !isReadOnlyEvidenceTool(receipt.toolName)
    ) {
      claims.push({
        claimId: `${receipt.receiptId}:mutation`,
        kind: 'filesystem_mutation',
        subject: receipt.toolName,
        value: receipt.summary,
        evidenceReceiptIds: [receipt.receiptId],
        confidence: 0.9,
      });
    }
  }
  return claims;
}

function buildAnswerReceipt(
  content: string | undefined,
  timestamp: number,
): EvidenceReceipt | null {
  const normalized = content?.trim();
  if (!normalized) {
    return null;
  }
  return {
    receiptId: `answer:${timestamp}`,
    sourceType: 'model_answer',
    status: 'succeeded',
    refs: [],
    summary: truncateInlineText(normalized, 220) ?? 'Produced a final answer.',
    startedAt: timestamp,
    endedAt: timestamp,
  };
}

function buildDelegatedClaims(
  input: {
    receipts: EvidenceReceipt[];
    taskContract: DelegatedTaskContract;
    finalUserAnswer?: string;
    answerReceiptId?: string;
  },
): Claim[] {
  const claims = buildClaimsFromReceipts(input.receipts, input.taskContract);
  if (input.finalUserAnswer?.trim() && input.answerReceiptId) {
    claims.push({
      claimId: `${input.answerReceiptId}:answer`,
      kind: 'answer',
      subject: input.taskContract.summary?.trim() || 'final_answer',
      value: input.finalUserAnswer.trim(),
      evidenceReceiptIds: [input.answerReceiptId],
      confidence: 1,
    });
    // When the contract requires symbol names, extract referenced symbol names
    // from the final answer and create symbol_reference claims.
    const symbolConstraint = input.taskContract.answerConstraints?.requiresSymbolNames;
    if (symbolConstraint && input.finalUserAnswer.trim()) {
      const symbolNames = extractSymbolNamesFromAnswer(input.finalUserAnswer);
      for (const symbolName of symbolNames) {
        claims.push({
          claimId: `${input.answerReceiptId}:symbol:${symbolName}`,
          kind: 'symbol_reference',
          subject: symbolName,
          value: symbolName,
          evidenceReceiptIds: [input.answerReceiptId],
          confidence: 0.85,
        });
      }
    }
  }
  return claims;
}

const CODE_SYMBOL_PATTERN = /`([^`]+)`/g;
// Matches PascalCase or camelCase identifiers that look like code symbols.
// Requires at least one lowercase letter (to filter out acronyms like 'AI', 'URL')
// and at least one uppercase/camelCase transition (to look like a real type/function name).
const TYPE_REFERENCE_PATTERN = /\b([A-Z][a-zA-Z0-9_]*[a-z][a-zA-Z0-9_]*)\b/g;

const COMMON_ENGLISH_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'Their',
  'For', 'And', 'But', 'Not', 'You', 'Are', 'Has', 'Can', 'Will', 'With',
  'From', 'Into', 'When', 'What', 'Which', 'Where', 'How', 'Why',
]);

function extractSymbolNamesFromAnswer(answer: string): string[] {
  const symbols = new Set<string>();

  // Extract backtick-quoted symbols: `DelegatedTaskContract`, `buildClaims`
  const backtickMatches = answer.matchAll(CODE_SYMBOL_PATTERN);
  for (const match of backtickMatches) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // Extract PascalCase or camelCase identifiers that look like type/function names
  const typeMatches = answer.matchAll(TYPE_REFERENCE_PATTERN);
  for (const match of typeMatches) {
    const candidate = match[1];
    if (candidate && candidate.length >= 3 && !COMMON_ENGLISH_WORDS.has(candidate)) {
      symbols.add(candidate);
    }
  }

  return [...symbols];
}

function buildClaimEvents(
  claims: Claim[],
  receiptStepIds: Map<string, string>,
  timestamp: number,
): ExecutionEvent[] {
  return claims.map((claim) => {
    const stepId = claim.evidenceReceiptIds
      .map((receiptId) => receiptStepIds.get(receiptId))
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return {
      eventId: `${claim.claimId}:emitted`,
      type: 'claim_emitted',
      timestamp,
      payload: {
        claimId: claim.claimId,
        kind: claim.kind,
        subject: claim.subject,
        value: claim.value,
        evidenceReceiptIds: [...claim.evidenceReceiptIds],
        ...(stepId ? { stepId } : {}),
        summary: truncateInlineText(claim.value, 220) ?? claim.kind,
      },
    };
  });
}

function resolveToolStepId(
  event: LlmLoopToolEvent,
  taskContract: DelegatedTaskContract,
  knownStepIds: Map<string, string>,
  matchedStepIds: Set<string>,
): string | undefined {
  const existing = knownStepIds.get(event.toolCall.id);
  if (existing) {
    return existing;
  }
  const matched = matchPlannedStepForTool({
    hintStepId: event.stepId,
    toolName: event.toolCall.name,
    args: event.args,
    plannedTask: taskContract.plan,
    previouslyMatchedStepIds: matchedStepIds,
  });
  return matched;
}

function buildDelegatedResultEnvelope(input: {
  taskContract: DelegatedTaskContract;
  finalAnswerCandidate?: string;
  operatorSummary: string;
  events: ExecutionEvent[];
  receipts: EvidenceReceipt[];
  toolReceiptStepIds?: Map<string, string>;
  interruptions?: Interruption[];
  responseSource?: ResponseSourceMetadata;
  selectedExecutionProfile?: SelectedExecutionProfile | null;
  stopReason: WorkerStopReason;
}): DelegatedResultEnvelope {
  const timestamp = Date.now();
  const interruptions = input.interruptions ?? [];
  const answerReceipt = buildAnswerReceipt(input.finalAnswerCandidate, timestamp);
  const evidenceReceipts = answerReceipt
    ? [...input.receipts, answerReceipt]
    : [...input.receipts];
  const receiptStepIds = new Map(input.toolReceiptStepIds ?? []);
  const answerStepId = answerReceipt ? findAnswerStepId(input.taskContract.plan) : undefined;
  if (answerReceipt && answerStepId) {
    receiptStepIds.set(answerReceipt.receiptId, answerStepId);
  }
  const stepReceipts = buildStepReceipts({
    plannedTask: input.taskContract.plan,
    evidenceReceipts,
    toolReceiptStepIds: receiptStepIds,
    ...(answerReceipt ? { finalAnswerReceiptId: answerReceipt.receiptId } : {}),
    interruptions,
  });
  const runStatus = computeWorkerRunStatus(
    input.taskContract.plan,
    stepReceipts,
    interruptions,
    input.stopReason,
  );
  const finalUserAnswer = runStatus === 'completed'
    ? input.finalAnswerCandidate?.trim()
    : undefined;
  const claims = buildDelegatedClaims({
    receipts: evidenceReceipts,
    taskContract: input.taskContract,
    ...(finalUserAnswer && answerReceipt ? {
      finalUserAnswer,
      answerReceiptId: answerReceipt.receiptId,
    } : {}),
  });
  const claimEvents = buildClaimEvents(claims, receiptStepIds, timestamp);
  const modelProvenance = buildDelegatedModelProvenance(
    input.selectedExecutionProfile ?? null,
    input.responseSource,
  );
  return {
    taskContract: input.taskContract,
    runStatus,
    stopReason: input.stopReason,
    stepReceipts,
    ...(finalUserAnswer ? { finalUserAnswer } : {}),
    operatorSummary: input.operatorSummary,
    claims,
    evidenceReceipts,
    interruptions,
    artifacts: [],
    ...(modelProvenance ? { modelProvenance } : {}),
    events: [...input.events, ...claimEvents],
  };
}

function isEmptyResponseFallbackContent(content: string | undefined): boolean {
  return content?.trim() === EMPTY_RESPONSE_FALLBACK_CONTENT;
}

function readWorkerCompletionReason(metadata: Record<string, unknown> | undefined): string | undefined {
  const workerExecution = metadata?.workerExecution;
  if (!isRecord(workerExecution)) return undefined;
  return typeof workerExecution.completionReason === 'string'
    ? workerExecution.completionReason
    : undefined;
}

function shouldSynthesizeApprovalContinuationFallback(
  result: { content: string; metadata?: Record<string, unknown> },
): boolean {
  return isEmptyResponseFallbackContent(result.content)
    || readWorkerCompletionReason(result.metadata) === 'empty_response_fallback';
}

function buildApprovalContinuationToolReceipt(input: {
  pending: SuspendedToolCall;
  result: {
    status?: string;
    message?: string;
    output?: unknown;
    success?: boolean;
  };
  workspaceRoot?: string;
  timestamp: number;
}): EvidenceReceipt {
  const status = input.result.success === true
    ? 'succeeded'
    : input.result.status === 'denied'
      ? 'blocked'
      : 'failed';
  const resultRecord: Record<string, unknown> = {
    success: input.result.success === true,
    status,
    ...(input.result.message ? { message: input.result.message } : {}),
    ...(input.result.output !== undefined ? { output: input.result.output } : {}),
  };
  return {
    receiptId: `approval:${input.pending.approvalId}:receipt`,
    sourceType: 'tool_call',
    toolName: input.pending.name,
    status,
    refs: canonicalizeEvidenceRefs([
      ...extractRefsFromUnknown(input.result.output),
      ...extractRefsFromUnknown(resultRecord),
    ], input.workspaceRoot),
    summary: buildEvidenceSummary(
      input.pending.name,
      resultRecord,
      status === 'succeeded' ? undefined : input.result.message,
    ),
    startedAt: input.timestamp,
    endedAt: input.timestamp,
  };
}

function buildApprovalContinuationToolEvent(input: {
  pending: SuspendedToolCall;
  receipt: EvidenceReceipt;
  timestamp: number;
}): ExecutionEvent {
  return {
    eventId: `${input.receipt.receiptId}:completed`,
    nodeId: input.pending.toolCallId,
    type: 'tool_call_completed',
    timestamp: input.timestamp,
    payload: {
      toolCallId: input.pending.toolCallId,
      toolName: input.pending.name,
      approvalId: input.pending.approvalId,
      resultStatus: input.receipt.status,
      resultMessage: input.receipt.summary,
      refs: [...input.receipt.refs],
    },
  };
}

function buildReceiptStepIdsFromEnvelope(
  envelope: DelegatedResultEnvelope | undefined,
): Map<string, string> {
  const evidenceById = new Map((envelope?.evidenceReceipts ?? []).map((receipt) => [receipt.receiptId, receipt]));
  const ids = new Map<string, string>();
  for (const stepReceipt of envelope?.stepReceipts ?? []) {
    for (const receiptId of stepReceipt.evidenceReceiptIds) {
      const receipt = evidenceById.get(receiptId);
      if (receipt?.sourceType === 'tool_call') {
        ids.set(receiptId, stepReceipt.stepId);
      }
    }
  }
  return ids;
}

function removeFallbackAnswerReceipts(receipts: EvidenceReceipt[]): EvidenceReceipt[] {
  return receipts.filter((receipt) => !(
    receipt.sourceType === 'model_answer'
    && isEmptyResponseFallbackContent(receipt.summary)
  ));
}

function buildApprovalContinuationReceiptStepIds(input: {
  taskContract: DelegatedTaskContract;
  sourceEnvelope?: DelegatedResultEnvelope;
  approvedReceipts: EvidenceReceipt[];
}): Map<string, string> {
  const receiptStepIds = buildReceiptStepIdsFromEnvelope(input.sourceEnvelope);
  const matchedStepIds = new Set(receiptStepIds.values());
  for (const receipt of input.approvedReceipts) {
    if (!receipt.toolName) continue;
    const stepId = matchPlannedStepForTool({
      toolName: receipt.toolName,
      args: { refs: receipt.refs },
      plannedTask: input.taskContract.plan,
      previouslyMatchedStepIds: matchedStepIds,
    });
    if (stepId) {
      receiptStepIds.set(receipt.receiptId, stepId);
      matchedStepIds.add(stepId);
    }
  }
  return receiptStepIds;
}

function buildApprovalContinuationSynthesisMessages(input: {
  originalMessage: UserMessage;
  resumedMessages: ChatMessage[];
  approvedReceipts: EvidenceReceipt[];
  sourceEnvelope?: DelegatedResultEnvelope;
}): ChatMessage[] {
  const sourceReceipts = removeFallbackAnswerReceipts(input.sourceEnvelope?.evidenceReceipts ?? [])
    .filter((receipt) => receipt.status === 'succeeded')
    .slice(0, 30);
  const toolTranscript = input.resumedMessages
    .filter((message) => message.role === 'tool' && message.content.trim())
    .slice(-8)
    .map((message, index) => `- tool_${index + 1}${message.toolCallId ? ` (${message.toolCallId})` : ''}: ${truncateInlineText(message.content, 1_200) ?? ''}`);
  const receiptLines = [...input.approvedReceipts, ...sourceReceipts]
    .filter((receipt) => receipt.status === 'succeeded')
    .map((receipt, index) => {
      const refs = receipt.refs.length > 0 ? ` refs=${receipt.refs.slice(0, 8).join(', ')}` : '';
      const toolName = receipt.toolName ? ` tool=${receipt.toolName}` : '';
      return `- evidence_${index + 1}: id=${receipt.receiptId} source=${receipt.sourceType}${toolName}${refs} summary=${truncateInlineText(receipt.summary, 800) ?? ''}`;
    });
  return [
    {
      role: 'system',
      content: [
        'You are GuardianAgent approval-continuation grounded synthesis.',
        'No tools are available in this pass. Use only the approved tool results, gathered evidence, and original request below.',
        'Do not execute actions, request approval, or claim that additional tool calls were made.',
        'Produce the final user-facing answer that the approved tool result now enables.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original request:',
        input.originalMessage.content,
        '',
        'Approved tool result transcript:',
        ...(toolTranscript.length > 0 ? toolTranscript : ['- none']),
        '',
        'Evidence receipts:',
        ...(receiptLines.length > 0 ? receiptLines : ['- none']),
        '',
        'Write the final answer now. Keep it concise and grounded in the evidence.',
      ].join('\n'),
    },
  ];
}

function buildExecutionProfileResponseSource(
  executionProfile: SelectedExecutionProfile | null | undefined,
): ResponseSourceMetadata | undefined {
  if (!executionProfile) return undefined;
  return {
    locality: executionProfile.providerLocality,
    providerName: executionProfile.providerType,
    ...(executionProfile.providerName !== executionProfile.providerType
      ? { providerProfileName: executionProfile.providerName }
      : {}),
    providerTier: executionProfile.providerTier,
    ...(executionProfile.providerModel?.trim()
      ? { model: executionProfile.providerModel.trim() }
      : {}),
    usedFallback: false,
  };
}

function buildChatResponseSource(
  response: BrokeredChatResponse,
  executionProfile: SelectedExecutionProfile | null | undefined,
  options: {
    usedFallback: boolean;
    notice?: string;
  },
): ResponseSourceMetadata | undefined {
  return buildChatResponseSourceMetadata({
    response,
    selectedExecutionProfile: executionProfile,
    providerName: response.providerName,
    providerLocality: response.providerLocality,
    usedFallback: options.usedFallback,
    notice: options.notice,
  });
}

function createPlannerPauseControl(result: unknown): PlanExecutionPauseControl {
  return {
    kind: 'pause_execution',
    reason: 'pending_approval',
    result,
  };
}

function extractPlannerMkdirPath(command: string): string | undefined {
  const match = command.match(/^mkdir(?:\s+-p)?\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`;&|<>]+))$/);
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  const normalized = candidate?.trim();
  return normalized ? normalized : undefined;
}

function normalizePlannerNodeStatus(status: PlanNode['status'] | undefined): PlanNode['status'] {
  if (status === 'running' || status === 'success' || status === 'failed') {
    return status;
  }
  return 'pending';
}

function truncatePlannerInlineText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizePlannerNodeIds(nodeIds: string[], maxItems = 5): string | undefined {
  if (nodeIds.length === 0) return undefined;
  const visible = nodeIds.slice(0, maxItems).join(', ');
  if (nodeIds.length <= maxItems) return visible;
  return `${visible}, +${nodeIds.length - maxItems} more`;
}

function readPlannerNodeResultDetail(result: unknown): string | undefined {
  if (result instanceof Error) {
    return truncatePlannerInlineText(result.message, 120);
  }
  if (typeof result === 'string') {
    return truncatePlannerInlineText(result, 120);
  }
  if (!isRecord(result)) return undefined;

  const candidates = [
    typeof result.reflectionReason === 'string' ? result.reflectionReason : undefined,
    typeof result.error === 'string' ? result.error : undefined,
    typeof result.message === 'string' ? result.message : undefined,
    typeof result.status === 'string' && result.status !== 'succeeded'
      ? `status ${result.status}`
      : undefined,
  ];
  for (const candidate of candidates) {
    const normalized = truncatePlannerInlineText(candidate, 120);
    if (normalized) return normalized;
  }
  if (result.originalResult !== undefined) {
    return readPlannerNodeResultDetail(result.originalResult);
  }
  return undefined;
}

function summarizePlannerFailedNodes(nodes: PlanNode[], maxItems = 4): string | undefined {
  if (nodes.length === 0) return undefined;
  const visible = nodes.slice(0, maxItems).map((node) => {
    const detail = readPlannerNodeResultDetail(node.result);
    return detail ? `${node.id} (${detail})` : node.id;
  });
  if (nodes.length > maxItems) {
    visible.push(`+${nodes.length - maxItems} more`);
  }
  return visible.join('; ');
}

function buildPlannerExecutionMetadata(
  plan: ExecutionPlan,
  status: 'completed' | 'failed' | 'unsupported_actions',
  options?: { unsupportedActions?: string[] },
): Record<string, unknown> {
  const nodes = Object.values(plan.nodes ?? {});
  const completed = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'success');
  const failed = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'failed');
  const running = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'running');
  const pending = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'pending');

  return {
    plannerExecution: {
      status,
      totalNodes: nodes.length,
      completedNodeCount: completed.length,
      failedNodeCount: failed.length,
      runningNodeCount: running.length,
      pendingNodeCount: pending.length,
      completedNodeIds: completed.map((node) => node.id),
      failedNodes: failed.map((node) => ({
        id: node.id,
        ...(node.target ? { target: node.target } : {}),
        ...(readPlannerNodeResultDetail(node.result) ? { detail: readPlannerNodeResultDetail(node.result) } : {}),
      })),
      pendingNodeIds: pending.map((node) => node.id),
      ...(options?.unsupportedActions?.length
        ? { unsupportedActions: [...new Set(options.unsupportedActions)] }
        : {}),
    },
  };
}

function buildPlannerWorkerExecutionMetadata(
  status: 'completed' | 'failed' | 'unsupported_actions',
): Record<string, unknown> {
  return buildWorkerExecutionMetadata({
    lifecycle: status === 'completed' ? 'completed' : 'failed',
    source: 'planner',
    completionReason: status === 'completed'
      ? 'planner_completed'
      : status === 'failed'
        ? 'planner_failed'
        : 'unsupported_actions',
    responseQuality: 'final',
    terminationReason: 'clean_exit',
  });
}

function buildPlannerReceiptStatus(
  status: PlanNode['status'] | undefined,
): EvidenceReceipt['status'] | null {
  const normalized = normalizePlannerNodeStatus(status);
  if (normalized === 'success') return 'succeeded';
  if (normalized === 'failed') return 'failed';
  return null;
}

function buildPlannerDelegatedEvidence(
  plan: ExecutionPlan,
  taskContract: DelegatedTaskContract,
  timestamp: number,
): {
  receipts: EvidenceReceipt[];
  toolReceiptStepIds: Map<string, string>;
  events: ExecutionEvent[];
} {
  const receipts: EvidenceReceipt[] = [];
  const toolReceiptStepIds = new Map<string, string>();
  const events: ExecutionEvent[] = [];
  const matchedStepIds = new Set<string>();

  for (const node of Object.values(plan.nodes ?? {})) {
    const receiptStatus = buildPlannerReceiptStatus(node.status);
    if (!receiptStatus) continue;
    const toolName = node.actionType === 'execute_code'
      ? 'code_remote_exec'
      : node.target;
    const detail = readPlannerNodeResultDetail(node.result);
    const receiptId = `planner:${plan.id}:${node.id}`;
    const stepId = matchPlannedStepForTool({
      toolName,
      args: {
        target: node.target,
        description: node.description,
        inputPrompt: node.inputPrompt,
      },
      plannedTask: taskContract.plan,
      previouslyMatchedStepIds: matchedStepIds,
    });
    if (stepId) {
      matchedStepIds.add(stepId);
      toolReceiptStepIds.set(receiptId, stepId);
    }
    receipts.push({
      receiptId,
      sourceType: 'tool_call',
      ...(toolName?.trim() ? { toolName: toolName.trim() } : {}),
      status: receiptStatus,
      refs: [...new Set(extractRefsFromUnknown(node.result))],
      summary: detail ?? `${toolName || node.actionType} ${receiptStatus}`,
      startedAt: timestamp,
      endedAt: timestamp,
    });
    events.push({
      eventId: `planner:${plan.id}:${node.id}:completed`,
      nodeId: node.id,
      type: 'tool_call_completed',
      timestamp,
      payload: {
        toolName,
        resultStatus: normalizePlannerNodeStatus(node.status),
        ...(detail ? { resultMessage: detail } : {}),
        ...(stepId ? { stepId } : {}),
      },
    });
  }
  return { receipts, toolReceiptStepIds, events };
}

function buildPlannerDelegatedEnvelope(input: {
  content: string;
  status: 'completed' | 'failed' | 'unsupported_actions' | 'planner_generation_failed';
  plan?: ExecutionPlan;
  intentDecision?: IntentGatewayDecision | null;
  responseSource?: ResponseSourceMetadata;
  selectedExecutionProfile?: SelectedExecutionProfile | null;
}): DelegatedResultEnvelope {
  const timestamp = Date.now();
  const taskContract = buildDelegatedTaskContract(input.intentDecision ?? undefined);
  const delegatedEvidence = input.plan
    ? buildPlannerDelegatedEvidence(input.plan, taskContract, timestamp)
    : { receipts: [], toolReceiptStepIds: new Map<string, string>(), events: [] };
  return buildDelegatedResultEnvelope({
    taskContract,
    finalAnswerCandidate: input.content,
    operatorSummary: input.content,
    events: delegatedEvidence.events,
    receipts: delegatedEvidence.receipts,
    toolReceiptStepIds: delegatedEvidence.toolReceiptStepIds,
    responseSource: input.responseSource,
    selectedExecutionProfile: input.selectedExecutionProfile,
    stopReason: input.status === 'completed' ? 'end_turn' : 'error',
  });
}

function buildPlannerExecutionResponse(
  plan: ExecutionPlan,
  status: 'completed' | 'failed' | 'unsupported_actions',
  options?: { unsupportedActions?: string[] },
  responseSource?: ResponseSourceMetadata,
  intentDecision?: IntentGatewayDecision | null,
  selectedExecutionProfile?: SelectedExecutionProfile | null,
): { content: string; metadata?: Record<string, unknown> } {
  const nodes = Object.values(plan.nodes ?? {});
  const completed = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'success');
  const failed = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'failed');
  const running = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'running');
  const pending = nodes.filter((node) => normalizePlannerNodeStatus(node.status) === 'pending');
  const summaryParts = [`${nodes.length} node${nodes.length === 1 ? '' : 's'}`];
  if (completed.length > 0) summaryParts.push(`${completed.length} completed`);
  if (failed.length > 0) summaryParts.push(`${failed.length} failed`);
  if (running.length > 0) summaryParts.push(`${running.length} running`);
  if (pending.length > 0) summaryParts.push(`${pending.length} pending`);

  const lines = [
    status === 'unsupported_actions'
      ? 'I generated a DAG plan, but I could not execute it safely because it included unsupported planner actions.'
      : status === 'failed'
        ? 'I generated a DAG plan for your request, but execution failed.'
        : 'I generated and executed a DAG plan for your request.',
    '',
    `Plan summary: ${summaryParts.join(', ')}.`,
  ];

  if (options?.unsupportedActions?.length) {
    lines.push(`Unsupported actions: ${[...new Set(options.unsupportedActions)].join(', ')}.`);
  }

  const completedSummary = summarizePlannerNodeIds(completed.map((node) => node.id));
  if (completedSummary) {
    lines.push(`Completed nodes: ${completedSummary}.`);
  }

  const failedSummary = summarizePlannerFailedNodes(failed);
  if (failedSummary) {
    lines.push(`Failed nodes: ${failedSummary}.`);
  }

  const pendingSummary = summarizePlannerNodeIds(pending.map((node) => node.id));
  if (pendingSummary && status !== 'unsupported_actions') {
    lines.push(`Pending nodes: ${pendingSummary}.`);
  }

  const content = lines.join('\n');
  return {
    content,
    metadata: {
      ...buildPlannerExecutionMetadata(plan, status, options),
      ...buildPlannerWorkerExecutionMetadata(status),
      ...buildDelegatedExecutionMetadata(buildPlannerDelegatedEnvelope({
        content,
        status,
        plan,
        intentDecision,
        responseSource,
        selectedExecutionProfile,
      })),
      ...(responseSource ? { responseSource } : {}),
    },
  };
}

function buildPlannerFailureResponse(
  content: string,
  responseSource?: ResponseSourceMetadata,
  intentDecision?: IntentGatewayDecision | null,
  selectedExecutionProfile?: SelectedExecutionProfile | null,
): { content: string; metadata?: Record<string, unknown> } {
  return {
    content,
    metadata: {
      ...buildWorkerExecutionMetadata({
        lifecycle: 'failed',
        source: 'planner',
        completionReason: 'planner_generation_failed',
        responseQuality: 'final',
      }),
      ...buildDelegatedExecutionMetadata(buildPlannerDelegatedEnvelope({
        content,
        status: 'planner_generation_failed',
        intentDecision,
        responseSource,
        selectedExecutionProfile,
      })),
      ...(responseSource ? { responseSource } : {}),
    },
  };
}

class BrokeredToolExecutor {
  private readonly client: BrokerClient;
  private readonly toolDefinitions = new Map<string, ToolDefinition>();
  private readonly approvalMetadata = new Map<string, PendingApprovalMetadata>();
  private readonly jobs: Array<{
    id: string;
    status: string;
    toolName: string;
    approvalId?: string;
    message?: string;
  }> = [];

  constructor(client: BrokerClient) {
    this.client = client;
    for (const definition of client.getAlwaysLoadedTools()) {
      this.toolDefinitions.set(definition.name, definition);
    }
  }

  isEnabled(): boolean {
    return true;
  }

  listAlwaysLoadedDefinitions(): ToolDefinition[] {
    return [...this.toolDefinitions.values()];
  }

  listAlwaysLoadedForLlm(locality: 'local' | 'external' = 'external'): import('../llm/types.js').ToolDefinition[] {
    return this.listAlwaysLoadedDefinitions().map((definition) => toLLMToolDef(definition, locality));
  }

  listExecutedJobs(): Array<{
    id: string;
    status: string;
    toolName: string;
    approvalId?: string;
    message?: string;
  }> {
    return [...this.jobs];
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(name);
  }

  getApprovalMetadata(ids: string[]): PendingApprovalMetadata[] {
    return ids
      .map((id) => this.approvalMetadata.get(id))
      .filter((value): value is PendingApprovalMetadata => !!value);
  }

  async searchTools(query: string): Promise<ToolDefinition[]> {
    const searchTools = (this.client as unknown as {
      searchTools?: (query: string) => Promise<ToolDefinition[]> | ToolDefinition[];
    }).searchTools;
    if (typeof searchTools !== 'function') {
      return [];
    }
    const results = await searchTools.call(this.client, query);
    for (const definition of results) {
      this.toolDefinitions.set(definition.name, definition);
    }
    return results;
  }

  formatToolResultForLlm(toolName: string, result: unknown): string {
    return formatToolResultForLLM(toolName, result, []);
  }

  async executeModelTool(
    toolName: string,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ): Promise<Record<string, unknown>> {
    const result = await this.client.callTool({
      ...request,
      toolName,
      args,
    });

    this.jobs.unshift({
      id: result.jobId,
      status: result.status,
      toolName,
      approvalId: result.approvalId,
      message: result.message,
    });

    if (toolName === 'find_tools' && isRecord(result.output) && Array.isArray(result.output.tools)) {
      for (const tool of result.output.tools) {
        if (isRecord(tool) && typeof tool.name === 'string') {
          this.toolDefinitions.set(tool.name, tool as unknown as ToolDefinition);
        }
      }
    }

    if (result.approvalId) {
      this.approvalMetadata.set(result.approvalId, {
        id: result.approvalId,
        toolName: result.approvalSummary?.toolName ?? toolName,
        argsPreview: result.approvalSummary?.argsPreview ?? JSON.stringify(args).slice(0, 160),
        ...(typeof result.approvalSummary?.actionLabel === 'string'
          ? { actionLabel: result.approvalSummary.actionLabel }
          : {}),
      });
    }

    if (result.trustLevel === 'quarantined') {
      const resultRecord = result as unknown as Record<string, unknown>;
      const output = isRecord(resultRecord.output) ? resultRecord.output : null;
      return {
        ...resultRecord,
        message: typeof resultRecord.message === 'string' && resultRecord.message.trim().length > 0
          ? resultRecord.message
          : `Raw ${toolName} content was quarantined before reinjection.`,
        output: {
          ...(output ?? {}),
          rawContentAvailable: false,
          inspectionRestricted: true,
          safeHandlingNote: 'Do not claim you inspected or summarized the quarantined raw content. Explain the limitation instead.',
        },
      };
    }

    return result as unknown as Record<string, unknown>;
  }
}

export class BrokeredWorkerSession {
  private readonly client: BrokerClient;
  private readonly intentGateway = new IntentGateway();
  private pendingApprovals: PendingApprovalState | null = null;
  private suspendedSession: SuspendedSession | null = null;
  private readonly toolReportScopes = new Map<string, ToolReportScope>();

  constructor(client: BrokerClient) {
    this.client = client;
  }

  private serializeSuspendedSession(
    suspended: SuspendedSession | null,
    expiresAt: number = Date.now() + PENDING_APPROVAL_TTL_MS,
  ): SerializedWorkerSuspensionSession | null {
    if (!suspended) return null;
    const createdAt = Date.now();
    if (suspended.kind === 'tool_loop') {
      return {
        version: WORKER_SUSPENSION_SCHEMA_VERSION,
        kind: 'tool_loop',
        llmMessages: structuredClone(suspended.llmMessages),
        pendingTools: suspended.pendingTools.map((pending) => ({ ...pending })),
        originalMessage: structuredClone(suspended.originalMessage),
        ...(suspended.taskContract ? { taskContract: structuredClone(suspended.taskContract) } : {}),
        ...(suspended.executionProfile ? { executionProfile: structuredClone(suspended.executionProfile) } : {}),
        createdAt,
        expiresAt,
      };
    }
    return {
      version: WORKER_SUSPENSION_SCHEMA_VERSION,
      kind: 'planner',
      plan: structuredClone(suspended.plan),
      pendingNodes: suspended.pendingNodes.map((pending) => ({ ...pending })),
      originalMessage: structuredClone(suspended.originalMessage),
      trustState: {
        contentTrustLevel: suspended.trustState.contentTrustLevel,
        taintReasons: [...suspended.trustState.taintReasons],
      },
      ...(suspended.executionProfile ? { executionProfile: structuredClone(suspended.executionProfile) } : {}),
      createdAt,
      expiresAt,
    };
  }

  private restoreSuspendedSession(
    suspension: SerializedWorkerSuspensionSession,
    nowMs: number = Date.now(),
  ): boolean {
    if (suspension.expiresAt <= nowMs) return false;
    if (suspension.kind === 'tool_loop') {
      this.suspendedSession = {
        kind: 'tool_loop',
        llmMessages: structuredClone(suspension.llmMessages),
        pendingTools: suspension.pendingTools.map((pending) => ({ ...pending })),
        originalMessage: structuredClone(suspension.originalMessage),
        ...(suspension.taskContract ? { taskContract: structuredClone(suspension.taskContract) } : {}),
        ...(suspension.executionProfile ? { executionProfile: structuredClone(suspension.executionProfile) } : {}),
      };
      this.pendingApprovals = {
        ids: suspension.pendingTools.map((pending) => pending.approvalId),
        expiresAt: suspension.expiresAt,
      };
      return true;
    }
    this.suspendedSession = {
      kind: 'planner',
      plan: structuredClone(suspension.plan),
      pendingNodes: suspension.pendingNodes.map((pending) => ({ ...pending })),
      originalMessage: structuredClone(suspension.originalMessage),
      trustState: {
        contentTrustLevel: suspension.trustState.contentTrustLevel,
        taintReasons: [...suspension.trustState.taintReasons],
      },
      ...(suspension.executionProfile ? { executionProfile: structuredClone(suspension.executionProfile) } : {}),
    };
    this.pendingApprovals = {
      ids: suspension.pendingNodes.map((pending) => pending.approvalId),
      expiresAt: suspension.expiresAt,
    };
    return true;
  }

  private attachCurrentWorkerSuspension(
    metadata: Record<string, unknown>,
    expiresAt: number,
  ): Record<string, unknown> {
    const suspension = this.serializeSuspendedSession(this.suspendedSession, expiresAt);
    return suspension ? attachWorkerSuspensionMetadata(metadata, suspension) : metadata;
  }

  private rememberToolReportScope(
    message: UserMessage,
    codeContext: { workspaceRoot: string; sessionId?: string } | undefined,
    toolExecutor: BrokeredToolExecutor,
  ): void {
    if (toolExecutor.listExecutedJobs().length <= 0) {
      return;
    }
    const requestId = message.id?.trim();
    const codeSessionId = codeContext?.sessionId?.trim();
    this.toolReportScopes.set(this.buildToolReportScopeKey(message.userId, message.channel), {
      userId: message.userId,
      channel: message.channel,
      ...(requestId ? { requestId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
    });
  }

  private resolveToolReportScope(
    message: UserMessage,
    codeContext: { workspaceRoot: string; sessionId?: string } | undefined,
  ): ToolReportScope {
    const rememberedScope = this.toolReportScopes.get(
      this.buildToolReportScopeKey(message.userId, message.channel),
    );
    if (rememberedScope) {
      return { ...rememberedScope };
    }
    const codeSessionId = codeContext?.sessionId?.trim();
    return {
      userId: message.userId,
      channel: message.channel,
      ...(codeSessionId ? { codeSessionId } : {}),
    };
  }

  private buildToolReportScopeKey(userId: string, channel: string): string {
    return `${userId}::${channel}`;
  }

  private async tryStartPolicyRemediationApproval(input: {
    samples: PolicyBlockedToolSample[];
    message: UserMessage;
    messages: ChatMessage[];
    toolExecutor: BrokeredToolExecutor;
    codeContext: { workspaceRoot: string; sessionId?: string } | undefined;
    onToolEvent: (event: LlmLoopToolEvent) => void;
  }): Promise<SuspendedToolCall | null> {
    const candidate = await this.resolvePolicyRemediationCandidate(input.samples, input.toolExecutor);
    if (!candidate) return null;
    const policyTool = input.toolExecutor.getToolDefinition('update_tool_policy')
      ?? (await input.toolExecutor.searchTools('update_tool_policy')).find((definition) => definition.name === 'update_tool_policy');
    if (!policyTool) return null;

    const args = {
      action: candidate.action,
      value: candidate.value,
    };
    const toolCallId = `policy-remediation:${randomUUID()}`;
    const startedAt = Date.now();
    input.messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: toolCallId,
        name: 'update_tool_policy',
        arguments: JSON.stringify(args),
      }],
    });
    input.onToolEvent({
      phase: 'started',
      toolCall: { id: toolCallId, name: 'update_tool_policy' },
      args,
      startedAt,
    });
    const result = await input.toolExecutor.executeModelTool('update_tool_policy', args, {
      origin: 'assistant',
      requestId: input.message.id,
      userId: input.message.userId,
      channel: input.message.channel,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole ?? 'owner',
      contentTrustLevel: 'trusted',
      taintReasons: [],
      derivedFromTaintedContent: false,
      ...(input.codeContext ? { codeContext: input.codeContext } : {}),
    });
    input.onToolEvent({
      phase: 'completed',
      toolCall: { id: toolCallId, name: 'update_tool_policy' },
      args,
      startedAt,
      endedAt: Date.now(),
      result,
    });

    if (
      result.status !== 'pending_approval'
      || typeof result.approvalId !== 'string'
      || !result.approvalId.trim()
      || typeof result.jobId !== 'string'
      || !result.jobId.trim()
    ) {
      return null;
    }
    return {
      approvalId: result.approvalId,
      toolCallId,
      jobId: result.jobId,
      name: 'update_tool_policy',
    };
  }

  private async resolvePolicyRemediationCandidate(
    samples: PolicyBlockedToolSample[],
    toolExecutor: BrokeredToolExecutor,
  ): Promise<PolicyRemediationCandidate | null> {
    for (const sample of samples) {
      const definition = toolExecutor.getToolDefinition(sample.toolName)
        ?? (await toolExecutor.searchTools(sample.toolName)).find((tool) => tool.name === sample.toolName);
      const pathValue = this.readPolicyRemediationPathValue(sample, definition);
      if (pathValue) {
        return {
          action: 'add_path',
          value: pathValue,
          sourceToolName: sample.toolName,
        };
      }
    }
    return null;
  }

  private readPolicyRemediationPathValue(
    sample: PolicyBlockedToolSample,
    definition: ToolDefinition | undefined,
  ): string | null {
    if (definition?.category !== 'filesystem' && !sample.toolName.startsWith('fs_') && sample.toolName !== 'doc_create') {
      return null;
    }
    const args = isRecord(sample.args) ? sample.args : {};
    const pathKeys = sample.toolName === 'fs_move' || sample.toolName === 'fs_copy'
      ? ['destination', 'source']
      : ['path', 'cwd'];
    for (const key of pathKeys) {
      const value = typeof args[key] === 'string' ? args[key].trim() : '';
      if (!value || value === '.') continue;
      return this.normalizePolicyRemediationPathValue(sample.toolName, key, value);
    }
    return null;
  }

  private normalizePolicyRemediationPathValue(toolName: string, key: string, value: string): string {
    if (
      (toolName === 'fs_write' || toolName === 'doc_create')
      && key === 'path'
      && dirname(value) !== '.'
    ) {
      return dirname(value);
    }
    if (
      (toolName === 'fs_move' || toolName === 'fs_copy')
      && key === 'destination'
      && dirname(value) !== '.'
    ) {
      return dirname(value);
    }
    return value;
  }

  private async handleRecoveryAdvisorMessage(
    request: RecoveryAdvisorRequest,
    chatFn: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    try {
      const response = await chatFn(buildRecoveryAdvisorMessages(request), {
        responseFormat: { type: 'json_object' },
        tools: [],
        maxTokens: 900,
        temperature: 0,
      });
      const proposal = parseRecoveryAdvisorProposal(response.content);
      return {
        content: proposal?.decision === 'retry'
          ? 'Recovery advisor proposed a bounded retry.'
          : 'Recovery advisor did not propose a retry.',
        metadata: {
          executionProfile: selectedExecutionProfile ?? undefined,
          recoveryAdvisor: {
            available: !!proposal,
            ...(proposal ? { proposal } : {}),
          },
        },
      };
    } catch (error) {
      return {
        content: 'Recovery advisor failed.',
        metadata: {
          executionProfile: selectedExecutionProfile ?? undefined,
          recoveryAdvisor: {
            available: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }

  private async handleGroundedSynthesisMessage(
    request: WorkerGroundedSynthesisRequest,
    chatFn: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
    selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    try {
      const response = await chatFn(request.messages, {
        tools: [],
        maxTokens: request.maxTokens ?? 1_500,
        temperature: request.temperature ?? 0,
        ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      });
      return {
        content: response.content ?? '',
        metadata: {
          executionProfile: selectedExecutionProfile ?? undefined,
          groundedSynthesis: {
            available: true,
            ...(response.model ? { model: response.model } : {}),
            ...(response.finishReason ? { finishReason: response.finishReason } : {}),
          },
        },
      };
    } catch (error) {
      return {
        content: '',
        metadata: {
          executionProfile: selectedExecutionProfile ?? undefined,
          groundedSynthesis: {
            available: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }

  async handleMessage(params: WorkerMessageHandleParams): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const codeContext = params.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    if (codeContext?.workspaceRoot) {
      await this.client.listLoadedTools({ codeContext });
    }
    const toolExecutor = new BrokeredToolExecutor(this.client);
    const selectedExecutionProfile = params.executionProfile
      ?? readSelectedExecutionProfileMetadata(params.message.metadata);

    // LLM calls are proxied through the broker — the worker has no network access.
    const buildChatFn = (
      executionProfile: SelectedExecutionProfile | null | undefined,
    ) => (msgs: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => this.client.llmChat(
      msgs,
      opts,
      executionProfile
        ? {
            providerName: executionProfile.providerName,
            fallbackProviderOrder: executionProfile.fallbackProviderOrder,
          }
        : undefined,
    );
    const chatFn = buildChatFn(selectedExecutionProfile);

    if (params.groundedSynthesis) {
      return this.handleGroundedSynthesisMessage(params.groundedSynthesis, chatFn, selectedExecutionProfile);
    }

    if (params.recoveryAdvisor) {
      return this.handleRecoveryAdvisorMessage(params.recoveryAdvisor, chatFn, selectedExecutionProfile);
    }

    const storedSuspension = readWorkerSuspensionMetadata(params.message.metadata);
    if (!this.suspendedSession && storedSuspension) {
      this.restoreSuspendedSession(storedSuspension);
    }

    if (this.isContinuationMessage(params.message.content) && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(
        buildChatFn(this.suspendedSession.executionProfile ?? selectedExecutionProfile),
        toolExecutor,
        params,
      );
    }

    const approvalContinuation = readApprovalOutcomeContinuationMetadata(params.message.metadata);
    if (approvalContinuation && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(
        buildChatFn(this.suspendedSession.executionProfile ?? selectedExecutionProfile),
        toolExecutor,
        params,
      );
    }

    const automationAuthoringResume = readWorkerAutomationAuthoringResumeMetadata(params.message.metadata);
    if (automationAuthoringResume) {
      const resumeMessage = buildWorkerAutomationAuthoringResumeMessage(params.message, automationAuthoringResume);
      const resumed = await this.tryDirectAutomationAuthoring(resumeMessage, toolExecutor, {
        allowRemediation: automationAuthoringResume.allowRemediation,
        assumeAuthoring: true,
      });
      if (resumed) {
        this.rememberToolReportScope(resumeMessage, automationAuthoringResume.codeContext, toolExecutor);
        return resumed;
      }
      return {
        content: 'I could not resume the automation authoring request after approval.',
      };
    }

    const approvalResponse = await this.tryHandleApprovalMessage(params.message, chatFn, toolExecutor, params);
    if (approvalResponse) {
      return approvalResponse;
    }

    const directIntent = await this.classifyIntentGateway(params.message, chatFn);
    if (params.directReasoning) {
      const traceContext: DirectReasoningTraceContext = params.directReasoningTrace ?? {
        requestId: params.message.id,
        messageId: params.message.id,
        userId: params.message.userId,
        channel: params.message.channel,
        contentPreview: params.message.content,
      };
      if (!shouldHandleDirectReasoningMode({
        gateway: directIntent,
        selectedExecutionProfile,
      })) {
        this.client.recordTrace({
          stage: 'direct_reasoning_failed',
          requestId: traceContext.requestId,
          messageId: traceContext.messageId,
          userId: traceContext.userId,
          channel: traceContext.channel,
          agentId: traceContext.agentId,
          contentPreview: traceContext.contentPreview ?? params.message.content,
          details: {
            route: directIntent?.decision.route,
            operation: directIntent?.decision.operation,
            executionClass: directIntent?.decision.executionClass,
            providerName: selectedExecutionProfile?.providerName,
            providerTier: selectedExecutionProfile?.providerTier,
            reason: 'not_direct_reasoning_eligible',
          },
        });
        return this.attachIntentGatewayMetadata({
          content: 'Direct reasoning could not run because the routed intent is no longer eligible for the read-only direct reasoning path.',
          metadata: {
            executionProfile: selectedExecutionProfile ?? undefined,
            directReasoning: true,
            directReasoningMode: 'brokered_readonly',
            directReasoningFailed: true,
          },
        }, directIntent);
      }

      const result = await handleDirectReasoningMode({
        message: params.message.content,
        history: params.history,
        gateway: directIntent,
        selectedExecutionProfile,
        promptKnowledge: {
          knowledgeBases: params.knowledgeBases,
          additionalSections: params.additionalSections,
          toolContext: params.toolContext,
          runtimeNotices: params.runtimeNotices,
        },
        workspaceRoot: codeContext?.workspaceRoot,
        traceContext,
        graphContext: params.directReasoningGraphContext,
        graphLifecycle: params.directReasoningGraphLifecycle,
        returnExecutionGraphArtifacts: params.returnExecutionGraphArtifacts,
        toolRequest: {
          origin: 'assistant',
          requestId: traceContext.requestId ?? params.message.id,
          agentId: traceContext.agentId,
          userId: params.message.userId,
          surfaceId: params.message.surfaceId,
          principalId: params.message.principalId ?? params.message.userId,
          principalRole: params.message.principalRole ?? 'owner',
          channel: params.message.channel,
          codeContext,
          toolContextMode: selectedExecutionProfile?.toolContextMode,
          activeSkills: params.activeSkills.map((skill) => skill.id),
        },
      }, {
        chat: chatFn,
        executeTool: (toolName, args, request) => toolExecutor.executeModelTool(toolName, args, {
          ...request,
          origin: request.origin ?? 'assistant',
        }),
        trace: {
          record: (entry) => this.client.recordTrace(entry as unknown as Record<string, unknown>),
        },
        graphEvents: {
          emit: (event) => this.client.recordExecutionGraphEvent(event),
        },
      });
      this.rememberToolReportScope(params.message, codeContext, toolExecutor);
      return this.attachIntentGatewayMetadata(result, directIntent);
    }
    const directRouting = resolveDirectIntentRoutingCandidates(
      directIntent,
      ['automation', 'automation_control', 'automation_output', 'browser'],
    );
    if (directIntent?.decision.route === 'complex_planning_task') {
      const plannerResult = await this.tryTaskPlannerDirectly(
        params.message,
        chatFn,
        toolExecutor,
        directIntent.decision,
        selectedExecutionProfile,
      );
      if (plannerResult) {
        this.rememberToolReportScope(params.message, codeContext, toolExecutor);
        return this.attachIntentGatewayMetadata(plannerResult, directIntent);
      }
    }

    if (directIntent?.decision.resolution === 'needs_clarification') {
      const prompt = sanitizePendingActionPrompt(directIntent.decision.summary, 'clarification');
      return this.attachIntentGatewayMetadata({
        content: prompt,
        metadata: buildClarificationPendingActionMetadata(prompt),
      }, directIntent);
    }

    if ((directIntent?.decision.route === 'general_assistant' || directIntent?.decision.route === 'unknown')
      && isToolReportQuery(params.message.content)) {
      try {
        const toolReportScope = this.resolveToolReportScope(params.message, codeContext);
        const jobs = await this.client.listJobs(
          toolReportScope.userId,
          toolReportScope.channel,
          50,
          {
            requestId: toolReportScope.requestId,
            codeSessionId: toolReportScope.codeSessionId,
          },
        );
        if (jobs.length > 0) {
          const report = formatToolReport(jobs);
          if (report) {
            return this.attachIntentGatewayMetadata({ content: report }, directIntent);
          }
        }
      } catch {
        // Fall through to the normal LLM path if broker job listing fails.
      }
    }
    for (const candidate of directRouting.candidates) {
      switch (candidate) {
        case 'automation': {
          const directAutomationAuthoring = await this.tryDirectAutomationAuthoring(params.message, toolExecutor, {
            intentDecision: directIntent?.decision,
            assumeAuthoring: directRouting.gatewayDirected,
          });
          if (!directAutomationAuthoring) break;
          this.rememberToolReportScope(params.message, codeContext, toolExecutor);
          return this.attachIntentGatewayMetadata(directAutomationAuthoring, directIntent);
        }
        case 'automation_control': {
          const directAutomationControl = await this.tryDirectAutomationControl(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directAutomationControl) break;
          this.rememberToolReportScope(params.message, codeContext, toolExecutor);
          return this.attachIntentGatewayMetadata(directAutomationControl, directIntent);
        }
        case 'automation_output': {
          const directAutomationOutput = await this.tryDirectAutomationOutput(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directAutomationOutput) break;
          this.rememberToolReportScope(params.message, codeContext, toolExecutor);
          return this.attachIntentGatewayMetadata(directAutomationOutput, directIntent);
        }
        case 'browser': {
          const directBrowserAutomation = await this.tryDirectBrowserAutomation(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directBrowserAutomation) break;
          this.rememberToolReportScope(params.message, codeContext, toolExecutor);
          return this.attachIntentGatewayMetadata(directBrowserAutomation, directIntent);
        }
        default:
          break;
      }
    }

    const promptAdditionalSections = buildWorkerPromptAdditionalSections(
      params.additionalSections,
      directIntent?.decision,
    );
    const enrichedSystemPrompt = buildWorkerSystemPrompt({
      ...params,
      additionalSections: promptAdditionalSections,
    });
    const llmMessages: ChatMessage[] = buildChatMessagesFromHistory({
      systemPrompt: enrichedSystemPrompt,
      history: params.history,
      userContent: params.message.content,
    });

    return this.executeLoop(params.message, llmMessages, chatFn, toolExecutor, {
      ...params,
      executionProfile: selectedExecutionProfile ?? undefined,
    }, directIntent?.decision);
  }

  private async tryTaskPlannerDirectly(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    decision?: IntentGatewayDecision | null,
    executionProfile?: SelectedExecutionProfile | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const { TaskPlanner, BROKER_SAFE_PLANNER_ACTION_TYPES } = await import('../runtime/planner/task-planner.js');
    const allowedToolNames = this.listPlannerAllowedToolNames(toolExecutor);
    const responseSource = buildExecutionProfileResponseSource(executionProfile);
    const planner = new TaskPlanner(
      async (msgs, opts) => chatFn(msgs, opts),
      {
        allowedActionTypes: BROKER_SAFE_PLANNER_ACTION_TYPES,
        allowedToolNames,
      },
    );
    const plan = await planner.plan(message.content, decision || undefined);
    if (!plan) {
      return buildPlannerFailureResponse(
        'I tried to plan a solution for that complex request but ran into an error generating the execution DAG.',
        responseSource,
        decision,
        executionProfile,
      );
    }

    const unsupportedActions = [...new Set(
      Object.values(plan.nodes)
        .map((node) => node.actionType)
        .filter((actionType) => actionType !== 'tool_call' && actionType !== 'execute_code'),
    )];
    if (unsupportedActions.length > 0) {
      plan.status = 'failed';
      return buildPlannerExecutionResponse(
        plan,
        'unsupported_actions',
        { unsupportedActions },
        responseSource,
        decision,
        executionProfile,
      );
    }

    const execution = await this.executePlannerPlan({
      plan,
      message,
      chatFn,
      toolExecutor,
      ...(executionProfile ? { executionProfile } : {}),
    });

    if (execution.outcome.status === 'paused') {
      const ids = execution.pendingNodes.map((pending) => pending.approvalId);
      const expiresAt = Date.now() + PENDING_APPROVAL_TTL_MS;
      this.pendingApprovals = {
        ids,
        expiresAt,
      };
      this.suspendedSession = {
        kind: 'planner',
        plan,
        pendingNodes: execution.pendingNodes,
        originalMessage: {
          ...message,
          ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
        },
        trustState: execution.trustState,
        ...(executionProfile ? { executionProfile } : {}),
      };

      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: this.attachCurrentWorkerSuspension(
          buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource, 'planner'),
          expiresAt,
        ),
      };
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;
    return buildPlannerExecutionResponse(
      plan,
      execution.outcome.status === 'failed' ? 'failed' : 'completed',
      undefined,
      responseSource,
      decision,
      executionProfile,
    );
  }

  private async executePlannerPlan(input: {
    plan: ExecutionPlan;
    message: UserMessage;
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
    toolExecutor: BrokeredToolExecutor;
    executionProfile?: SelectedExecutionProfile;
    trustState?: PlannerTrustSnapshot;
  }): Promise<{
    outcome: PlanExecutionOutcome;
    pendingNodes: SuspendedPlannerNode[];
    trustState: PlannerTrustSnapshot;
  }> {
    const { BROKER_SAFE_PLANNER_ACTION_TYPES } = await import('../runtime/planner/task-planner.js');
    const allowedToolNames = this.listPlannerAllowedToolNames(input.toolExecutor);
    const reflector = new (await import('../runtime/planner/reflection.js')).SemanticReflector(
      async (msgs, opts) => input.chatFn(msgs, opts)
    );

    const compactor = new (await import('../runtime/planner/compactor.js')).ContextCompactor(
      async (msgs, opts) => input.chatFn(msgs, opts)
    );

    const recoveryPlanner = new (await import('../runtime/planner/recovery.js')).RecoveryPlanner(
      async (msgs, opts) => input.chatFn(msgs, opts),
      {
        allowedActionTypes: BROKER_SAFE_PLANNER_ACTION_TYPES,
        allowedToolNames,
      },
    );

    const learningQueue = new (await import('../runtime/planner/learning-queue.js')).ReflectiveLearningQueue(
      async (type, details) => {
        console.log(`Worker Learning Queue: ${type}`, details);
      }
    );

    const mutableTrustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> } = {
      contentTrustLevel: input.trustState?.contentTrustLevel ?? 'trusted',
      taintReasons: new Set(input.trustState?.taintReasons ?? []),
    };
    const pendingNodes: SuspendedPlannerNode[] = [];
    const orchestrator = new (await import('../runtime/planner/orchestrator.js')).AssistantOrchestrator(
      async (node) => this.executePlannerNode(node, input.message, input.toolExecutor, mutableTrustState, pendingNodes),
      reflector,
      learningQueue,
      recoveryPlanner,
      compactor
    );

    const outcome = await orchestrator.executePlan(input.plan);
    return {
      outcome,
      pendingNodes,
      trustState: {
        contentTrustLevel: mutableTrustState.contentTrustLevel,
        taintReasons: [...mutableTrustState.taintReasons],
      },
    };
  }

  private async executePlannerNode(
    node: PlanNode,
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
    pendingNodes: SuspendedPlannerNode[],
  ): Promise<Record<string, unknown> | PlanExecutionPauseControl> {
    if (node.actionType === 'tool_call') {
      const toolName = this.normalizePlannerToolName(node.target);
      const args = this.parsePlannerToolArgs(node);
      const result = await toolExecutor.executeModelTool(
        toolName,
        args,
        this.buildPlannerToolRequest(message, trustState),
      );
      if (result.status === 'pending_approval' && typeof result.approvalId === 'string' && typeof result.jobId === 'string') {
        pendingNodes.push({
          nodeId: node.id,
          approvalId: result.approvalId,
          jobId: result.jobId,
          toolName,
        });
        return createPlannerPauseControl(result);
      }
      this.updatePlannerTrustState(trustState, result);
      return result;
    }

    if (node.actionType === 'execute_code') {
      const normalizedToolCall = this.normalizePlannerExecuteCodeToToolCall(node.inputPrompt, toolExecutor);
      if (normalizedToolCall) {
        const result = await toolExecutor.executeModelTool(
          normalizedToolCall.toolName,
          normalizedToolCall.args,
          this.buildPlannerToolRequest(message, trustState),
        );
        if (result.status === 'pending_approval' && typeof result.approvalId === 'string' && typeof result.jobId === 'string') {
          pendingNodes.push({
            nodeId: node.id,
            approvalId: result.approvalId,
            jobId: result.jobId,
            toolName: normalizedToolCall.toolName,
          });
          return createPlannerPauseControl(result);
        }
        this.updatePlannerTrustState(trustState, result);
        return result;
      }

      const command = this.normalizePlannerExecuteCodeCommand(node.inputPrompt);
      const result = await toolExecutor.executeModelTool(
        'code_remote_exec',
        { command },
        this.buildPlannerToolRequest(message, trustState),
      );
      if (result.status === 'pending_approval' && typeof result.approvalId === 'string' && typeof result.jobId === 'string') {
        pendingNodes.push({
          nodeId: node.id,
          approvalId: result.approvalId,
          jobId: result.jobId,
          toolName: 'code_remote_exec',
        });
        return createPlannerPauseControl(result);
      }
      this.updatePlannerTrustState(trustState, result);
      return result;
    }

    throw Object.assign(
      new Error(`Planner action '${node.actionType}' is not implemented in brokered execution.`),
      { nonRecoverable: true },
    );
  }

  private listPlannerAllowedToolNames(toolExecutor: BrokeredToolExecutor): string[] {
    return [...new Set(
      toolExecutor.listAlwaysLoadedDefinitions()
        .map((definition) => definition.name)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()),
    )].sort((left, right) => left.localeCompare(right));
  }

  private normalizePlannerToolName(toolName: string): string {
    const trimmed = toolName.trim();
    if (!trimmed) return trimmed;
    return PLANNER_TOOL_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
  }

  private normalizePlannerExecuteCodeCommand(inputPrompt: unknown): string {
    if (typeof inputPrompt !== 'string') {
      return String(inputPrompt ?? '');
    }
    const trimmed = inputPrompt.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.command === 'string' && parsed.command.trim()) {
        return parsed.command.trim();
      }
    } catch {
      // Fall back to the raw bounded command string.
    }
    return trimmed;
  }

  private normalizePlannerExecuteCodeToToolCall(
    inputPrompt: unknown,
    toolExecutor: BrokeredToolExecutor,
  ): { toolName: string; args: Record<string, unknown> } | null {
    const command = this.normalizePlannerExecuteCodeCommand(inputPrompt);
    if (!command) return null;

    if (toolExecutor.getToolDefinition('fs_mkdir')) {
      const path = extractPlannerMkdirPath(command);
      if (path) {
        return {
          toolName: 'fs_mkdir',
          args: { path },
        };
      }
    }

    return null;
  }

  private parsePlannerToolArgs(node: PlanNode): Record<string, unknown> {
    if (isRecord(node.inputPrompt)) {
      return node.inputPrompt;
    }
    if (typeof node.inputPrompt !== 'string') {
      throw new Error(`Planner node '${node.id}' does not contain a valid JSON tool payload.`);
    }
    const parsed = JSON.parse(node.inputPrompt);
    if (!isRecord(parsed)) {
      throw new Error(`Planner node '${node.id}' did not produce an object-shaped tool payload.`);
    }
    return parsed;
  }

  private buildPlannerToolRequest(
    message: UserMessage,
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
  ): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
    const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    return {
      origin: 'assistant',
      userId: message.userId,
      surfaceId: message.surfaceId,
      principalId: message.principalId ?? message.userId,
      principalRole: message.principalRole ?? 'owner',
      channel: message.channel,
      requestId: message.id,
      contentTrustLevel: trustState.contentTrustLevel,
      taintReasons: [...trustState.taintReasons],
      derivedFromTaintedContent: trustState.contentTrustLevel !== 'trusted',
      ...(codeContext ? { codeContext } : {}),
    };
  }

  private updatePlannerTrustState(
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
    result: unknown,
  ): void {
    if (!isRecord(result)) return;
    const trustLevel = result.trustLevel === 'quarantined'
      ? 'quarantined'
      : result.trustLevel === 'low_trust'
        ? 'low_trust'
        : 'trusted';
    if (trustLevel === 'quarantined') {
      trustState.contentTrustLevel = 'quarantined';
    } else if (trustLevel === 'low_trust' && trustState.contentTrustLevel === 'trusted') {
      trustState.contentTrustLevel = 'low_trust';
    }
    const taintReasons = Array.isArray(result.taintReasons)
      ? result.taintReasons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    for (const reason of taintReasons) {
      trustState.taintReasons.add(reason);
    }
  }

  private async tryHandleApprovalMessage(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const pendingIds = this.getPendingApprovalIds();
    if (pendingIds.length === 0) return null;

    const trimmed = message.content.trim();
    const decision = APPROVAL_CONFIRM_PATTERN.test(trimmed)
      ? 'approved'
      : APPROVAL_DENY_PATTERN.test(trimmed)
        ? 'denied'
        : null;
    if (!decision) return null;

    const explicitIds = trimmed
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter((token) => APPROVAL_ID_TOKEN_PATTERN.test(token));
    const targetIds = explicitIds.length > 0 ? explicitIds : pendingIds;

    const results: string[] = [];
    let approvedAny = false;
    for (const approvalId of targetIds) {
      const decided = await this.client.decideApproval(
        approvalId,
        decision,
        message.principalId ?? message.userId,
        message.principalRole ?? 'owner',
      );
      results.push(decided.message);
      const approvalGranted = decision === 'approved' && (decided.approved ?? decided.success);
      approvedAny ||= approvalGranted;
    }

    if (decision === 'approved' && approvedAny && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(chatFn, toolExecutor, params);
    }

    this.consumePendingApprovals(targetIds);
    return { content: results.join('\n') };
  }

  private async resumeSuspendedSessionAfterApproval(
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const suspended = this.suspendedSession;
    if (!suspended) {
      return { content: 'There is no suspended action to continue.' };
    }

    if (suspended.kind === 'planner') {
      return this.resumeSuspendedPlannerAfterApproval(suspended, chatFn, toolExecutor);
    }

    const resumedMessages = [...suspended.llmMessages];
    const approvedReceipts: EvidenceReceipt[] = [];
    const approvedEvents: ExecutionEvent[] = [];
    const codeContext = suspended.originalMessage.metadata?.codeContext as { workspaceRoot?: string } | undefined;
    const workspaceRoot = codeContext?.workspaceRoot;
    for (const pending of suspended.pendingTools) {
      const result = await this.client.getApprovalResult(pending.approvalId);
      const timestamp = Date.now();
      const receipt = buildApprovalContinuationToolReceipt({
        pending,
        result,
        workspaceRoot,
        timestamp,
      });
      approvedReceipts.push(receipt);
      approvedEvents.push(buildApprovalContinuationToolEvent({
        pending,
        receipt,
        timestamp,
      }));
      const toolPayload = result.success === true
        ? buildToolResultPayloadFromJob({
          status: 'succeeded',
          resultPreview: typeof result.message === 'string' && result.output === undefined
            ? result.message
            : JSON.stringify(result.output),
        })
        : { success: false, error: result.message ?? 'Approval was denied.' };
      resumedMessages.push({
        role: 'tool',
        toolCallId: pending.toolCallId,
        content: JSON.stringify(toolPayload),
      });
    }
    this.suspendedSession = null;
    this.pendingApprovals = null;

    const resumed = await this.executeLoop(
      suspended.originalMessage,
      resumedMessages,
      chatFn,
      toolExecutor,
      {
        ...params,
        message: suspended.originalMessage,
      },
    );
    const synthesized = await this.trySynthesizeApprovalContinuationFallback({
      suspended,
      resumed,
      resumedMessages,
      approvedReceipts,
      approvedEvents,
      chatFn,
    });
    return synthesized ?? resumed;
  }

  private async trySynthesizeApprovalContinuationFallback(input: {
    suspended: SuspendedToolLoopSession;
    resumed: { content: string; metadata?: Record<string, unknown> };
    resumedMessages: ChatMessage[];
    approvedReceipts: EvidenceReceipt[];
    approvedEvents: ExecutionEvent[];
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  }): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    if (!shouldSynthesizeApprovalContinuationFallback(input.resumed)) {
      return null;
    }
    const sourceEnvelope = readDelegatedResultEnvelope(input.resumed.metadata);
    const usefulReceiptCount = input.approvedReceipts.filter((receipt) => receipt.status === 'succeeded').length
      + (sourceEnvelope?.evidenceReceipts.filter((receipt) => (
        receipt.status === 'succeeded'
        && !(receipt.sourceType === 'model_answer' && isEmptyResponseFallbackContent(receipt.summary))
      )).length ?? 0);
    if (usefulReceiptCount <= 0) {
      return null;
    }

    const response = await input.chatFn(
      buildApprovalContinuationSynthesisMessages({
        originalMessage: input.suspended.originalMessage,
        resumedMessages: input.resumedMessages,
        approvedReceipts: input.approvedReceipts,
        sourceEnvelope,
      }),
      {
        tools: [],
        maxTokens: 2_000,
        temperature: 0,
      },
    );
    const finalAnswer = response.content.trim();
    if (!finalAnswer || isEmptyResponseFallbackContent(finalAnswer)) {
      return null;
    }

    const taskContract = input.suspended.taskContract
      ?? sourceEnvelope?.taskContract
      ?? buildDelegatedTaskContract(readPreRoutedIntentGatewayMetadata(input.suspended.originalMessage.metadata)?.decision);
    const sourceReceipts = removeFallbackAnswerReceipts(sourceEnvelope?.evidenceReceipts ?? []);
    const approvedReceiptIds = new Set(input.approvedReceipts.map((receipt) => receipt.receiptId));
    const receipts = [
      ...sourceReceipts.filter((receipt) => !approvedReceiptIds.has(receipt.receiptId)),
      ...input.approvedReceipts,
    ];
    const toolReceiptStepIds = buildApprovalContinuationReceiptStepIds({
      taskContract,
      sourceEnvelope,
      approvedReceipts: input.approvedReceipts,
    });
    const responseSource = buildChatResponseSource(response as BrokeredChatResponse, input.suspended.executionProfile, {
      usedFallback: false,
    });
    const envelope = buildDelegatedResultEnvelope({
      taskContract,
      finalAnswerCandidate: finalAnswer,
      operatorSummary: finalAnswer,
      events: [
        ...(sourceEnvelope?.events ?? []),
        ...input.approvedEvents,
      ],
      receipts,
      toolReceiptStepIds,
      responseSource,
      selectedExecutionProfile: input.suspended.executionProfile,
      stopReason: 'end_turn',
    });
    return {
      content: finalAnswer,
      metadata: {
        ...(input.resumed.metadata ?? {}),
        ...buildDelegatedExecutionMetadata(envelope),
        approvalContinuationSynthesis: {
          available: true,
          reason: 'empty_response_after_approval',
          approvedReceiptCount: input.approvedReceipts.length,
        },
        ...(responseSource ? { responseSource } : {}),
      },
    };
  }

  private async resumeSuspendedPlannerAfterApproval(
    suspended: SuspendedPlannerSession,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const responseSource = buildExecutionProfileResponseSource(suspended.executionProfile);
    const resumedTrustState = {
      contentTrustLevel: suspended.trustState.contentTrustLevel,
      taintReasons: new Set(suspended.trustState.taintReasons),
    };

    for (const pending of suspended.pendingNodes) {
      const node = suspended.plan.nodes[pending.nodeId];
      if (!node) continue;

      const result = await this.client.getApprovalResult(pending.approvalId);
      if (result.success === true) {
        const approvedResult: Record<string, unknown> = {
          success: true,
          status: 'succeeded',
          ...(typeof result.jobId === 'string' ? { jobId: result.jobId } : {}),
          ...(typeof result.message === 'string' ? { message: result.message } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
        };
        node.status = 'running';
        node.result = approvedResult;
        this.updatePlannerTrustState(resumedTrustState, approvedResult);
      } else {
        node.status = 'failed';
        node.result = {
          success: false,
          status: result.status === 'denied' ? 'denied' : 'failed',
          ...(typeof result.jobId === 'string' ? { jobId: result.jobId } : {}),
          error: typeof result.message === 'string' && result.message.trim()
            ? result.message
            : 'Approval was denied.',
        };
      }
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;

    const execution = await this.executePlannerPlan({
      plan: suspended.plan,
      message: suspended.originalMessage,
      chatFn,
      toolExecutor,
      trustState: {
        contentTrustLevel: resumedTrustState.contentTrustLevel,
        taintReasons: [...resumedTrustState.taintReasons],
      },
      ...(suspended.executionProfile ? { executionProfile: suspended.executionProfile } : {}),
    });

    if (execution.outcome.status === 'paused') {
      const ids = execution.pendingNodes.map((pending) => pending.approvalId);
      const expiresAt = Date.now() + PENDING_APPROVAL_TTL_MS;
      this.pendingApprovals = {
        ids,
        expiresAt,
      };
      this.suspendedSession = {
        kind: 'planner',
        plan: suspended.plan,
        pendingNodes: execution.pendingNodes,
        originalMessage: suspended.originalMessage,
        trustState: execution.trustState,
        ...(suspended.executionProfile ? { executionProfile: suspended.executionProfile } : {}),
      };
      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: this.attachCurrentWorkerSuspension(
          buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource, 'planner'),
          expiresAt,
        ),
      };
    }

    return buildPlannerExecutionResponse(
      suspended.plan,
      execution.outcome.status === 'failed' ? 'failed' : 'completed',
      undefined,
      responseSource,
      readPreRoutedIntentGatewayMetadata(suspended.originalMessage.metadata)?.decision,
      suspended.executionProfile,
    );
  }

  private async tryDirectAutomationAuthoring(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    options?: {
      allowRemediation?: boolean;
      assumeAuthoring?: boolean;
      intentDecision?: IntentGatewayDecision | null;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const trackedPendingApprovalIds: string[] = [];
    const result = await tryAutomationPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          surfaceId: message.surfaceId,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        trackedPendingApprovalIds.push(approvalId);
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, options);
    if (!result) return null;
    if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
      result.metadata = attachWorkerAutomationAuthoringResumeMetadata(
        result.metadata,
        buildWorkerAutomationAuthoringResume(message, {
          allowRemediation: true,
        }),
      );
    }
    return result;
  }

  private async tryDirectAutomationControl(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryAutomationControlPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, { intentDecision });
  }

  private async tryDirectAutomationOutput(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryAutomationOutputPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
    }, {
      intentDecision,
    });
  }

  private async tryDirectBrowserAutomation(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryBrowserPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, { intentDecision });
  }

  private async classifyIntentGateway(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
  ): Promise<IntentGatewayRecord | null> {
    const preRouted = readPreRoutedIntentGatewayMetadata(message.metadata);
    if (shouldReuseWorkerPreRoutedIntentGateway(preRouted)) {
      return enrichIntentGatewayRecordWithContentPlan(
        preRouted,
        stripLeadingContextPrefix(message.content),
      ) ?? preRouted;
    }
    const classified = await this.intentGateway.classify(
      {
        content: stripLeadingContextPrefix(message.content),
        channel: message.channel,
      },
      chatFn,
    );
    return enrichIntentGatewayRecordWithContentPlan(
      classified,
      stripLeadingContextPrefix(message.content),
    );
  }

  private attachIntentGatewayMetadata(
    response: { content: string; metadata?: Record<string, unknown> },
    intentGateway: IntentGatewayRecord | null,
  ): { content: string; metadata?: Record<string, unknown> } {
    const gatewayMeta = toIntentGatewayClientMetadata(intentGateway);
    if (!gatewayMeta) return response;
    return {
      content: response.content,
      metadata: {
        ...(response.metadata ?? {}),
        intentGateway: gatewayMeta,
      },
    };
  }

  private async executeLoop(
    message: UserMessage,
    llmMessages: ChatMessage[],
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<BrokeredChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
    intentDecision?: IntentGatewayDecision,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const taskContract = buildDelegatedTaskContract(intentDecision);
    const pendingTools: SuspendedToolCall[] = [];
    const delegatedEvents: ExecutionEvent[] = [];
    const evidenceReceipts = new Map<string, EvidenceReceipt>();
    const toolCallStepIds = new Map<string, string>();
    const toolReceiptStepIds = new Map<string, string>();
    const matchedStepIds = new Set<string>();
    let responseSource: ResponseSourceMetadata | undefined;
    const codeContext = params.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    const selectedExecutionProfile = params.executionProfile
      ?? readSelectedExecutionProfileMetadata(params.message.metadata);

    const allowModelMemoryMutation = shouldAllowModelMemoryMutation(message.content);
    const toolExecutionCorrectionPrompt = buildToolExecutionCorrectionPrompt(intentDecision);
    const answerFirstOriginalRequest = stripLeadingContextPrefix(message.content);
    const skillAnswerFirstCandidate = shouldUseAnswerFirstForSkills(params.activeSkills, answerFirstOriginalRequest);
    const skillPrefersAnswerFirst = skillAnswerFirstCandidate
      && (
        hasActiveWritingPlansSkill(params.activeSkills)
        || shouldAllowSkillAnswerFirstLane({
          taskContract,
          intentDecision,
        })
      );
    const delegatedAnswerFirst = shouldUseDelegatedAnswerFirstLane({
      taskContract,
      intentDecision,
      selectedExecutionProfile,
    });
    const preferAnswerFirst = delegatedAnswerFirst || skillPrefersAnswerFirst;
    const answerFirstCorrectionPrompt = buildDelegatedAnswerFirstCorrectionPrompt(
      taskContract,
      delegatedAnswerFirst,
      answerFirstOriginalRequest,
      skillPrefersAnswerFirst
        ? buildAnswerFirstSkillCorrectionPrompt(params.activeSkills, answerFirstOriginalRequest)
        : undefined,
    );
    const workerLoopBudget = deriveWorkerLoopBudget(taskContract, selectedExecutionProfile);
    appendSystemGuidance(llmMessages, buildDelegatedTaskPlanGuidance(taskContract));

    appendSystemGuidance(llmMessages, buildExactFileReferenceGuidance(taskContract));
    const recordDelegatedToolEvent = (event: LlmLoopToolEvent): void => {
      const resolvedStepId = resolveToolStepId(event, taskContract, toolCallStepIds, matchedStepIds);
      const enrichedEvent = resolvedStepId ? { ...event, stepId: resolvedStepId } : event;
      if (resolvedStepId) {
        toolCallStepIds.set(event.toolCall.id, resolvedStepId);
        matchedStepIds.add(resolvedStepId);
      }
      delegatedEvents.push(buildToolExecutionEvent(enrichedEvent));
      const receipt = buildToolReceipt(enrichedEvent, codeContext?.workspaceRoot);
      if (receipt) {
        evidenceReceipts.set(receipt.receiptId, receipt);
        if (resolvedStepId) {
          toolReceiptStepIds.set(receipt.receiptId, resolvedStepId);
        }
      }
    };

    const result = await runLlmLoop(
      llmMessages,
      async (messages, options) => {
        try {
          const chatResponse = await chatFn(messages, options);
          responseSource = responseSource
            ?? buildChatResponseSource(chatResponse, selectedExecutionProfile, { usedFallback: false });
          return chatResponse;
        } catch (error) {
          if (isLocalToolCallParseError(error)) {
            if (shouldBypassLocalModelComplexityGuard()) {
              throw error;
            }
            throw new Error(buildLocalModelTooComplicatedMessage());
          }
          throw error;
        }
      },
      {
        listAlwaysLoaded: () => toolExecutor.listAlwaysLoadedDefinitions(),
        searchTools: (query) => toolExecutor.searchTools(query),
        callTool: async (request) => {
          const toolDefinition = toolExecutor.getToolDefinition(request.toolName);
          const prepared = prepareToolExecutionForIntent({
            toolName: request.toolName,
            args: request.args,
            requestText: message.content,
            referenceTime: message.timestamp,
            intentDecision,
            toolDefinition,
          });
          if (prepared.immediateResult) {
            return prepared.immediateResult as unknown as ToolRunResponse;
          }
          const runResult = await toolExecutor.executeModelTool(request.toolName, prepared.args, {
            ...request,
            surfaceId: message.surfaceId,
            ...(codeContext ? { codeContext } : {}),
          });
          return runResult as unknown as ToolRunResponse;
        },
      },
      workerLoopBudget.maxRounds,
      workerLoopBudget.contextBudget,
      (toolCall, toolResult) => {
        if (toolResult.status === 'pending_approval' && typeof toolResult.approvalId === 'string' && typeof toolResult.jobId === 'string') {
          pendingTools.push({
            approvalId: toolResult.approvalId,
            toolCallId: toolCall.id,
            jobId: toolResult.jobId,
            name: toolCall.name,
          });
        }
      },
      {
        principalId: message.principalId ?? message.userId,
        principalRole: message.principalRole ?? 'owner',
        requestId: message.id,
        userId: message.userId,
        channel: message.channel,
        surfaceId: message.surfaceId,
        ...(codeContext ? { codeContext } : {}),
        allowModelMemoryMutation,
        preferAnswerFirst,
        allowAnswerFirstCompletionWithToolExecutionCorrection: preferAnswerFirst,
        answerFirstCorrectionPrompt,
        answerFirstFallbackContent: buildAnswerFirstSkillFallbackResponse(params.activeSkills, answerFirstOriginalRequest),
        answerFirstResponseIsSufficient: (content) => isAnswerFirstSkillResponseSufficient(
          params.activeSkills,
          content,
          answerFirstOriginalRequest,
        ),
        toolExecutionCorrectionPrompt,
        plannedTask: taskContract.plan,
        onToolEvent: recordDelegatedToolEvent,
      },
    );

    if (pendingTools.length === 0) {
      const remediation = await this.tryStartPolicyRemediationApproval({
        samples: result.outcome.policyBlockedSamples ?? [],
        message,
        messages: result.messages,
        toolExecutor,
        codeContext,
        onToolEvent: recordDelegatedToolEvent,
      });
      if (remediation) {
        pendingTools.push(remediation);
      }
    }

    if (pendingTools.length > 0) {
      this.rememberToolReportScope(message, codeContext, toolExecutor);
      const ids = pendingTools.map((pending) => pending.approvalId);
      const expiresAt = Date.now() + PENDING_APPROVAL_TTL_MS;
      this.pendingApprovals = {
        ids,
        expiresAt,
      };
      this.suspendedSession = {
        kind: 'tool_loop',
        llmMessages: result.messages,
        pendingTools,
        originalMessage: {
          ...message,
          ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
        },
        taskContract,
        ...(selectedExecutionProfile ? { executionProfile: selectedExecutionProfile } : {}),
      };

      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      const interruptions: Interruption[] = [{
        interruptionId: `approval:${ids.join(',')}`,
        kind: 'approval',
        prompt: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        approvalSummaries: pendingApprovalMeta.map((approval) => ({
          id: approval.id,
          toolName: approval.toolName,
          ...(approval.argsPreview ? { argsPreview: approval.argsPreview } : {}),
        })),
        resumeToken: ids.join(','),
      }];
      const interruptionEvents: ExecutionEvent[] = interruptions.map((interruption) => ({
        eventId: `${interruption.interruptionId}:requested`,
        type: 'interruption_requested',
        timestamp: Date.now(),
        payload: {
          kind: interruption.kind,
          prompt: interruption.prompt,
          ...(interruption.approvalSummaries ? { approvalIds: interruption.approvalSummaries.map((summary) => summary.id) } : {}),
        },
      }));
      const pendingContent = pendingApprovalMeta.length > 0
        ? formatPendingApprovalMessage(pendingApprovalMeta)
        : 'This action needs approval before I can continue.';
      const envelope = buildDelegatedResultEnvelope({
        taskContract,
        operatorSummary: pendingContent,
        events: [...delegatedEvents, ...interruptionEvents],
        receipts: [...evidenceReceipts.values()],
        toolReceiptStepIds,
        interruptions,
        responseSource,
        selectedExecutionProfile,
        stopReason: result.outcome.stopReason,
      });
      return {
        content: pendingContent,
        metadata: this.attachCurrentWorkerSuspension(
          {
            ...buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource),
            ...buildDelegatedExecutionMetadata(envelope),
          },
          expiresAt,
        ),
      };
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;
    this.rememberToolReportScope(message, codeContext, toolExecutor);
    const phantomApproval = isPhantomPendingApprovalMessage(result.finalContent);

    const policyBlockedSamples = result.outcome.policyBlockedSamples ?? [];
    if (
      !phantomApproval
      && result.outcome.successfulToolResultCount === 0
      && result.outcome.toolResultCount > 0
      && policyBlockedSamples.length > 0
    ) {
      const prompt = buildPolicyBlockedClarificationPrompt(policyBlockedSamples);
      const interruptions: Interruption[] = [{
        interruptionId: randomUUID(),
        kind: 'policy_blocked',
        prompt,
      }];
      const envelope = buildDelegatedResultEnvelope({
        taskContract,
        operatorSummary: prompt,
        events: [
          ...delegatedEvents,
          {
            eventId: `${interruptions[0].interruptionId}:requested`,
            type: 'interruption_requested',
            timestamp: Date.now(),
            payload: {
              kind: 'policy_blocked',
              prompt,
            },
          },
        ],
        receipts: [...evidenceReceipts.values()],
        toolReceiptStepIds,
        interruptions,
        responseSource,
        selectedExecutionProfile,
        stopReason: result.outcome.stopReason,
      });
      return {
        content: prompt,
        metadata: {
          ...buildClarificationPendingActionMetadata(prompt, responseSource),
          ...buildDelegatedExecutionMetadata(envelope),
        },
      };
    }

    const finalContent = phantomApproval
      ? 'I did not create a real approval request for that action. Please try again.'
      : result.finalContent;
    const finalTaskContract = shouldPromoteAnswerOnlyTaskContract(
      result.outcome,
      preferAnswerFirst,
    )
      ? buildAnswerOnlyTaskContract(taskContract, answerFirstOriginalRequest || finalContent)
      : taskContract;
    const envelope = buildDelegatedResultEnvelope({
      taskContract: finalTaskContract,
      ...(phantomApproval ? {} : { finalAnswerCandidate: finalContent }),
      operatorSummary: finalContent,
      events: delegatedEvents,
      receipts: [...evidenceReceipts.values()],
      toolReceiptStepIds,
      responseSource,
      selectedExecutionProfile,
      stopReason: result.outcome.stopReason,
    });
    return {
      content: finalContent,
      metadata: {
        ...buildToolLoopExecutionMetadata(result.outcome, {
          phantomApproval,
          runStatus: envelope.runStatus,
        }),
        ...buildDelegatedExecutionMetadata(envelope),
        ...(responseSource ? { responseSource } : {}),
      },
    };
  }

  private getPendingApprovalIds(nowMs: number = Date.now()): string[] {
    if (!this.pendingApprovals) return [];
    if (this.pendingApprovals.expiresAt <= nowMs) {
      this.pendingApprovals = null;
      return [];
    }
    return [...this.pendingApprovals.ids];
  }

  private consumePendingApprovals(consumedIds: string[]): void {
    if (!this.pendingApprovals) return;
    const remaining = this.pendingApprovals.ids.filter((id) => !consumedIds.includes(id));
    if (remaining.length === 0) {
      this.pendingApprovals = null;
      return;
    }
    this.pendingApprovals = {
      ids: remaining,
      expiresAt: this.pendingApprovals.expiresAt,
    };
  }

  private isContinuationMessage(content: string): boolean {
    return content.includes('[User approved the pending tool action(s)') || content.includes('Tool actions have been decided');
  }
}

function buildWorkerSystemPrompt(params: WorkerMessageHandleParams): string {
  return buildSystemPromptWithContext({
    baseSystemPrompt: params.systemPrompt,
    knowledgeBases: params.knowledgeBases,
    activeSkills: params.activeSkills,
    additionalSections: params.additionalSections,
    toolContext: params.toolContext,
    runtimeNotices: params.runtimeNotices,
    pendingAction: params.pendingAction,
    pendingApprovalNotice: params.pendingApprovalNotice,
    continuity: params.continuity,
    ...(params.executionProfile ? { executionProfile: params.executionProfile } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
