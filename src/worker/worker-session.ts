import { randomUUID } from 'node:crypto';
import type { UserMessage } from '../agent/types.js';
import { getProviderTier } from '../llm/provider-metadata.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ContentTrustLevel, ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import {
  formatPendingApprovalMessage,
  isPhantomPendingApprovalMessage,
} from '../runtime/pending-approval-copy.js';
import { sanitizePendingActionPrompt } from '../runtime/pending-actions.js';
import {
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
  buildRoutedIntentAdditionalSection,
  buildToolExecutionCorrectionPrompt,
  prepareToolExecutionForIntent,
} from '../runtime/routed-tool-execution.js';
import { readApprovalOutcomeContinuationMetadata } from '../runtime/approval-continuations.js';
import {
  buildWorkerExecutionMetadata,
  type WorkerExecutionSource,
} from '../runtime/worker-execution-metadata.js';
import {
  buildDelegatedExecutionMetadata,
} from '../runtime/execution/metadata.js';
import {
  buildDelegatedTaskContract,
} from '../runtime/execution/verifier.js';
import type {
  Claim,
  DelegatedResultEnvelope,
  EvidenceReceipt,
  ExecutionEvent,
  Interruption,
  ProviderSelectionSnapshot,
} from '../runtime/execution/types.js';
import {
  runLlmLoop,
  type LlmLoopOutcome,
  type LlmLoopToolEvent,
} from './worker-llm-loop.js';
import { BrokerClient } from '../broker/broker-client.js';
import { buildToolResultPayloadFromJob } from '../tools/job-results.js';
import { shouldAllowModelMemoryMutation } from '../util/memory-intent.js';
import { isToolReportQuery, formatToolReport } from '../util/tool-report.js';
import {
  formatToolResultForLLM,
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

interface AutomationApprovalContinuation {
  originalMessage: UserMessage;
  pendingApprovalIds: string[];
  expiresAt: number;
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
  options?: { phantomApproval?: boolean },
): Record<string, unknown> {
  const phantomApproval = options?.phantomApproval === true;
  const lifecycle = phantomApproval || outcome.responseQuality !== 'final'
    ? 'failed'
    : 'completed';
  return buildWorkerExecutionMetadata({
    lifecycle,
    source: 'tool_loop',
    completionReason: phantomApproval ? 'phantom_approval_response' : outcome.completionReason,
    responseQuality: phantomApproval ? 'degraded' : outcome.responseQuality,
    roundCount: outcome.roundCount,
    toolCallCount: outcome.toolCallCount,
    toolResultCount: outcome.toolResultCount,
    successfulToolResultCount: outcome.successfulToolResultCount,
  });
}

function buildDelegatedVerificationHints(
  outcome: Pick<LlmLoopOutcome, 'completionReason' | 'responseQuality'>,
  options?: {
    phantomApproval?: boolean;
    completionReason?: string;
    responseQuality?: string;
  },
): NonNullable<DelegatedResultEnvelope['verificationHints']> {
  return {
    completionReason: options?.completionReason
      ?? (options?.phantomApproval ? 'phantom_approval_response' : outcome.completionReason),
    responseQuality: options?.responseQuality
      ?? (options?.phantomApproval ? 'degraded' : outcome.responseQuality),
  };
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
    if (key === 'path' || key === 'file' || key === 'files' || key === 'paths' || key === 'workspaceRoot') {
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

function mapEvidenceStatus(result: Record<string, unknown> | undefined, errorMessage?: string): EvidenceReceipt['status'] {
  if (errorMessage) return 'failed';
  const status = typeof result?.status === 'string' ? result.status.trim().toLowerCase() : '';
  if (status === 'pending_approval') return 'pending_approval';
  if (status === 'denied' || status === 'failed' || status === 'error') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (result?.success === false) return 'failed';
  return 'succeeded';
}

function buildToolReceipt(event: LlmLoopToolEvent): EvidenceReceipt | null {
  if (event.phase !== 'completed') return null;
  return {
    receiptId: `${event.toolCall.id}:receipt`,
    sourceType: 'tool_call',
    toolName: event.toolCall.name,
    status: mapEvidenceStatus(event.result, event.errorMessage),
    refs: [...new Set([
      ...extractRefsFromUnknown(event.args),
      ...extractRefsFromUnknown(event.result?.output),
      ...extractRefsFromUnknown(event.result),
    ])],
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
  'code_session_attach', 'code_session_detach', 'code_session_create'
]);

function isReadOnlyEvidenceTool(toolName: string): boolean {
  return READ_ONLY_EVIDENCE_TOOLS.has(toolName);
}

function buildClaimsFromReceipts(
  receipts: EvidenceReceipt[],
  taskContract: ReturnType<typeof buildDelegatedTaskContract>,
): Claim[] {
  const claims: Claim[] = [];
  for (const receipt of receipts) {
    if (receipt.refs.length > 0) {
      for (const ref of receipt.refs) {
        claims.push({
          claimId: `${receipt.receiptId}:file:${ref}`,
          kind: 'file_reference',
          subject: ref,
          value: ref,
          evidenceReceiptIds: [receipt.receiptId],
          confidence: 0.8,
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

function buildDelegatedResultEnvelope(input: {
  intentDecision: IntentGatewayDecision | undefined;
  finalUserAnswer?: string;
  operatorSummary: string;
  events: ExecutionEvent[];
  receipts: EvidenceReceipt[];
  interruptions?: Interruption[];
  responseSource?: ResponseSourceMetadata;
  selectedExecutionProfile?: SelectedExecutionProfile | null;
  verificationHints?: DelegatedResultEnvelope['verificationHints'];
}): DelegatedResultEnvelope {
  const taskContract = buildDelegatedTaskContract(input.intentDecision);
  return {
    taskContract,
    ...(input.finalUserAnswer?.trim() ? { finalUserAnswer: input.finalUserAnswer.trim() } : {}),
    operatorSummary: input.operatorSummary,
    claims: buildClaimsFromReceipts(input.receipts, taskContract),
    evidenceReceipts: input.receipts,
    interruptions: input.interruptions ?? [],
    artifacts: [],
    ...(input.verificationHints ? { verificationHints: input.verificationHints } : {}),
    ...(buildDelegatedModelProvenance(input.selectedExecutionProfile ?? null, input.responseSource)
      ? {
          modelProvenance: buildDelegatedModelProvenance(
            input.selectedExecutionProfile ?? null,
            input.responseSource,
          ),
        }
      : {}),
    events: input.events,
  };
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
  if (response.providerLocality !== 'local' && response.providerLocality !== 'external') {
    return undefined;
  }
  const actualProviderName = typeof response.providerName === 'string'
    ? response.providerName.trim()
    : '';
  const useSelectedExecutionProfile = !!executionProfile
    && (
      !actualProviderName
      || actualProviderName === executionProfile.providerName
      || actualProviderName === executionProfile.providerType
    );
  const providerName = useSelectedExecutionProfile
    ? executionProfile.providerType
    : actualProviderName;
  const providerProfileName = useSelectedExecutionProfile
    && executionProfile.providerName !== executionProfile.providerType
    ? executionProfile.providerName
    : undefined;
  return {
    locality: response.providerLocality,
    ...(providerName ? { providerName } : {}),
    ...(providerProfileName ? { providerProfileName } : {}),
    ...((useSelectedExecutionProfile ? executionProfile.providerTier : getProviderTier(providerName))
      ? { providerTier: (useSelectedExecutionProfile ? executionProfile.providerTier : getProviderTier(providerName)) }
      : {}),
    ...(response.model?.trim() ? { model: response.model.trim() } : {}),
    usedFallback: options.usedFallback,
    ...(options.notice ? { notice: options.notice } : {}),
  };
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

function buildPlannerEvidenceReceipts(
  plan: ExecutionPlan,
  timestamp: number,
): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [];
  for (const node of Object.values(plan.nodes ?? {})) {
    const receiptStatus = buildPlannerReceiptStatus(node.status);
    if (!receiptStatus) continue;
    const toolName = node.actionType === 'execute_code'
      ? 'code_remote_exec'
      : node.target;
    const detail = readPlannerNodeResultDetail(node.result);
    receipts.push({
      receiptId: `planner:${plan.id}:${node.id}`,
      sourceType: 'tool_call',
      ...(toolName?.trim() ? { toolName: toolName.trim() } : {}),
      status: receiptStatus,
      refs: [...new Set(extractRefsFromUnknown(node.result))],
      summary: detail ?? `${toolName || node.actionType} ${receiptStatus}`,
      startedAt: timestamp,
      endedAt: timestamp,
    });
  }
  return receipts;
}

function buildPlannerExecutionEvents(
  plan: ExecutionPlan,
  timestamp: number,
): ExecutionEvent[] {
  return Object.values(plan.nodes ?? {})
    .filter((node) => buildPlannerReceiptStatus(node.status) !== null)
    .map((node) => ({
      eventId: `planner:${plan.id}:${node.id}:completed`,
      nodeId: node.id,
      type: 'tool_call_completed' as const,
      timestamp,
      payload: {
        toolName: node.actionType === 'execute_code' ? 'code_remote_exec' : node.target,
        resultStatus: normalizePlannerNodeStatus(node.status),
        ...(readPlannerNodeResultDetail(node.result)
          ? { resultMessage: readPlannerNodeResultDetail(node.result) }
          : {}),
      },
    }));
}

function buildPlannerCompletionEvent(
  content: string,
  timestamp: number,
): ExecutionEvent {
  return {
    eventId: randomUUID(),
    type: 'claim_emitted',
    timestamp,
    payload: {
      kind: 'answer',
      content,
    },
  };
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
  const receipts = input.plan ? buildPlannerEvidenceReceipts(input.plan, timestamp) : [];
  const events = input.plan
    ? [...buildPlannerExecutionEvents(input.plan, timestamp), buildPlannerCompletionEvent(input.content, timestamp)]
    : [buildPlannerCompletionEvent(input.content, timestamp)];
  return buildDelegatedResultEnvelope({
    intentDecision: input.intentDecision ?? undefined,
    finalUserAnswer: input.content,
    operatorSummary: input.content,
    events,
    receipts,
    responseSource: input.responseSource,
    selectedExecutionProfile: input.selectedExecutionProfile,
    verificationHints: {
      completionReason: input.status,
      responseQuality: 'final',
    },
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
    const results = await this.client.searchTools(query);
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
  private automationContinuation: AutomationApprovalContinuation | null = null;
  private lastToolReportScope: ToolReportScope | null = null;

  constructor(client: BrokerClient) {
    this.client = client;
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
    this.lastToolReportScope = {
      userId: message.userId,
      channel: message.channel,
      ...(requestId ? { requestId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
    };
  }

  private resolveToolReportScope(
    message: UserMessage,
    codeContext: { workspaceRoot: string; sessionId?: string } | undefined,
  ): ToolReportScope {
    if (
      this.lastToolReportScope
      && this.lastToolReportScope.userId === message.userId
      && this.lastToolReportScope.channel === message.channel
    ) {
      return { ...this.lastToolReportScope };
    }
    const codeSessionId = codeContext?.sessionId?.trim();
    return {
      userId: message.userId,
      channel: message.channel,
      ...(codeSessionId ? { codeSessionId } : {}),
    };
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

    const approvalResponse = await this.tryHandleApprovalMessage(params.message, chatFn, toolExecutor, params);
    if (approvalResponse) {
      return approvalResponse;
    }

    const directIntent = await this.classifyIntentGateway(params.message, chatFn);
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
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
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
        metadata: buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource, 'planner'),
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
    const approvedIds = new Set<string>();
    const failedIds = new Set<string>();
    for (const approvalId of targetIds) {
      const decided = await this.client.decideApproval(
        approvalId,
        decision,
        message.principalId ?? message.userId,
        message.principalRole ?? 'owner',
      );
      results.push(decided.message);
      const approvalGranted = decision === 'approved' && (decided.approved ?? decided.success);
      const executionFailed = approvalGranted && decided.executionSucceeded === false;
      approvedAny ||= approvalGranted;
      if (approvalGranted) approvedIds.add(approvalId);
      if (!decided.success || executionFailed || (decision === 'approved' && !approvalGranted)) {
        failedIds.add(approvalId);
      }
    }

    if (decision === 'approved' && approvedAny && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(chatFn, toolExecutor, params);
    }

    this.consumePendingApprovals(targetIds);
    if (this.automationContinuation) {
      const affected = targetIds.filter((id) => this.automationContinuation?.pendingApprovalIds.includes(id));
      if (decision === 'approved' && affected.length > 0) {
        const resolvedIds = new Set(affected.filter((id) => approvedIds.has(id) || failedIds.has(id)));
        const stillPending = this.automationContinuation.pendingApprovalIds.filter((id) => !resolvedIds.has(id));
        if (stillPending.length === 0) {
          if (affected.some((id) => failedIds.has(id))) {
            this.automationContinuation = null;
          } else {
            const originalMessage = this.automationContinuation.originalMessage;
            this.automationContinuation = null;
            const retry = await this.tryDirectAutomationAuthoring(originalMessage, toolExecutor, {
              assumeAuthoring: true,
            });
            if (retry) {
              results.push('');
              results.push(retry.content);
              return {
                content: results.join('\n'),
                metadata: retry.metadata,
              };
            }
          }
        } else {
          this.automationContinuation = {
            ...this.automationContinuation,
            pendingApprovalIds: stillPending,
          };
        }
      } else if (affected.length > 0 && (decision === 'denied' || affected.some((id) => failedIds.has(id)))) {
        this.automationContinuation = null;
      }
    }
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
    for (const pending of suspended.pendingTools) {
      const result = await this.client.getApprovalResult(pending.approvalId);
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

    return this.executeLoop(
      suspended.originalMessage,
      resumedMessages,
      chatFn,
      toolExecutor,
      {
        ...params,
        message: suspended.originalMessage,
      },
    );
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
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
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
        metadata: buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource, 'planner'),
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
    if (!result) {
      this.automationContinuation = null;
      return null;
    }
    if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
      this.automationContinuation = {
        originalMessage: message,
        pendingApprovalIds: trackedPendingApprovalIds,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
    } else {
      this.automationContinuation = null;
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
      return preRouted;
    }
    return this.intentGateway.classify(
      {
        content: stripLeadingContextPrefix(message.content),
        channel: message.channel,
      },
      chatFn,
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
    const pendingTools: SuspendedToolCall[] = [];
    const delegatedEvents: ExecutionEvent[] = [];
    const evidenceReceipts = new Map<string, EvidenceReceipt>();
    let responseSource: ResponseSourceMetadata | undefined;
    const codeContext = params.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    const selectedExecutionProfile = params.executionProfile
      ?? readSelectedExecutionProfileMetadata(params.message.metadata);

    const allowModelMemoryMutation = shouldAllowModelMemoryMutation(message.content);
    const toolExecutionCorrectionPrompt = buildToolExecutionCorrectionPrompt(intentDecision);
    const answerFirstOriginalRequest = stripLeadingContextPrefix(message.content);
    const recordDelegatedToolEvent = (event: LlmLoopToolEvent): void => {
      delegatedEvents.push(buildToolExecutionEvent(event));
      const receipt = buildToolReceipt(event);
      if (receipt) {
        evidenceReceipts.set(receipt.receiptId, receipt);
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
      6,
      selectedExecutionProfile?.contextBudget ?? 80_000,
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
        preferAnswerFirst: shouldUseAnswerFirstForSkills(params.activeSkills, answerFirstOriginalRequest),
        answerFirstCorrectionPrompt: buildAnswerFirstSkillCorrectionPrompt(params.activeSkills, answerFirstOriginalRequest),
        answerFirstFallbackContent: buildAnswerFirstSkillFallbackResponse(params.activeSkills, answerFirstOriginalRequest),
        answerFirstResponseIsSufficient: (content) => isAnswerFirstSkillResponseSufficient(
          params.activeSkills,
          content,
          answerFirstOriginalRequest,
        ),
        toolExecutionCorrectionPrompt,
        onToolEvent: recordDelegatedToolEvent,
      },
    );

    if (pendingTools.length > 0) {
      this.rememberToolReportScope(message, codeContext, toolExecutor);
      const ids = pendingTools.map((pending) => pending.approvalId);
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
      this.suspendedSession = {
        kind: 'tool_loop',
        llmMessages: result.messages,
        pendingTools,
        originalMessage: {
          ...message,
          ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
        },
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
        intentDecision,
        operatorSummary: pendingContent,
        events: [...delegatedEvents, ...interruptionEvents],
        receipts: [...evidenceReceipts.values()],
        interruptions,
        responseSource,
        selectedExecutionProfile,
        verificationHints: buildDelegatedVerificationHints(result.outcome, {
          completionReason: 'approval_pending',
          responseQuality: 'final',
        }),
      });
      return {
        content: pendingContent,
        metadata: {
          ...buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource),
          ...buildDelegatedExecutionMetadata(envelope),
        },
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
        intentDecision,
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
        interruptions,
        responseSource,
        selectedExecutionProfile,
        verificationHints: buildDelegatedVerificationHints(result.outcome),
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
    const completionEvent: ExecutionEvent = {
      eventId: randomUUID(),
      type: 'claim_emitted',
      timestamp: Date.now(),
      payload: {
        kind: 'answer',
        content: finalContent,
      },
    };
    const envelope = buildDelegatedResultEnvelope({
      intentDecision,
      finalUserAnswer: phantomApproval ? undefined : finalContent,
      operatorSummary: finalContent,
      events: [...delegatedEvents, completionEvent],
      receipts: [...evidenceReceipts.values()],
      responseSource,
      selectedExecutionProfile,
      verificationHints: buildDelegatedVerificationHints(result.outcome, { phantomApproval }),
    });
    return {
      content: finalContent,
      metadata: {
        ...buildToolLoopExecutionMetadata(result.outcome, { phantomApproval }),
        ...buildDelegatedExecutionMetadata(envelope),
        ...(responseSource ? { responseSource } : {}),
      },
    };
  }

  private getPendingApprovalIds(nowMs: number = Date.now()): string[] {
    if (!this.pendingApprovals) return [];
    if (this.pendingApprovals.expiresAt <= nowMs) {
      this.pendingApprovals = null;
      this.automationContinuation = null;
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
