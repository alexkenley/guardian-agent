import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChatMessage, ChatOptions } from '../llm/types.js';
import { sandboxedSpawn, detectSandboxHealth, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { createLogger } from '../util/logging.js';
import { BrokerServer } from '../broker/broker-server.js';
import { CapabilityTokenManager } from '../broker/capability-token.js';
import type { ToolApprovalDecisionResult, ToolExecutor } from '../tools/executor.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { Runtime } from '../runtime/runtime.js';
import type { AgentIsolationConfig } from '../config/types.js';
import type { UserMessage } from '../agent/types.js';
import type { ResolvedSkill } from '../skills/types.js';
import {
  AssistantJobTracker,
  readDelegatedWorkerMetadata,
  type DelegatedWorkerHandoff,
  type DelegatedWorkerOperatorAction,
  type DelegatedWorkerOperatorFollowUpState,
  type DelegatedWorkerRunClass,
} from '../runtime/assistant-jobs.js';
import {
  normalizeOrchestrationRoleDescriptor,
  type OrchestrationRoleDescriptor,
} from '../runtime/orchestration-role-descriptors.js';
import { tryAutomationPreRoute, type AutomationPendingApprovalMetadata } from '../runtime/automation-prerouter.js';
import { buildPendingApprovalMetadata, formatPendingApprovalMessage } from '../runtime/pending-approval-copy.js';
import { buildApprovalOutcomeContinuationMetadata } from '../runtime/approval-continuations.js';
import type {
  PromptAssemblyAdditionalSection,
  PromptAssemblyContinuity,
  PromptAssemblyKnowledgeBase,
  PromptAssemblyPendingAction,
} from '../runtime/context-assembly.js';
import {
  resolveDelegatedExecutionDecision,
  selectEscalatedDelegatedExecutionProfile,
  selectManagedCloudSiblingDelegatedExecutionProfile,
  type SelectedExecutionProfile,
} from '../runtime/execution-profiles.js';
import {
  attachPreRoutedIntentGatewayMetadata,
  readPreRoutedIntentGatewayMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRecord,
} from '../runtime/intent-gateway.js';
import { resolveIntentCapabilityCandidates } from '../runtime/intent/capability-resolver.js';
import type { IntentRoutingTraceLog, IntentRoutingTraceStage } from '../runtime/intent-routing-trace.js';
import type { DelegatedWorkerProgressEvent, RunTimelineStore } from '../runtime/run-timeline.js';
import {
  isExecutionGraphEvent,
  createExecutionGraphEvent,
  type ExecutionGraphEvent,
} from '../runtime/execution-graph/graph-events.js';
import type { ExecutionGraphStore } from '../runtime/execution-graph/graph-store.js';
import {
  artifactRefFromArtifact,
  type ExecutionArtifact,
  type WriteSpecContent,
} from '../runtime/execution-graph/graph-artifacts.js';
import {
  buildDirectReasoningGraphContext,
  type DirectReasoningGraphContext,
} from '../runtime/execution-graph/direct-reasoning-node.js';
import {
  buildDelegatedWorkerGraphContext,
  buildDelegatedWorkerGraphCompletion,
  buildDelegatedWorkerGraphFailure,
  buildDelegatedWorkerGraphInput,
  buildDelegatedWorkerRunningMetadata,
  buildDelegatedWorkerStartProjection,
  type DelegatedWorkerGraphCompletion,
  type DelegatedWorkerGraphJobMetadata,
  type DelegatedWorkerGraphRun,
} from '../runtime/execution-graph/delegated-worker-node.js';
import {
  applyDelegatedFollowUpPolicy,
  buildDelegatedHandoff,
  buildDelegatedInsufficientResultHandoff,
  formatFailedDelegatedMessage,
  normalizeDelegatedWorkerRunClass,
  resolveDelegatedWorkerLifecycle,
} from '../runtime/execution-graph/delegated-worker-handoff.js';
import {
  isDelegatedWorkerBudgetExhausted,
  isDelegatedJobInFlight,
  shouldExtendDelegatedEvidenceDrain,
  verifyDelegatedWorkerResult,
  type DelegatedJobSnapshot,
} from '../runtime/execution-graph/delegated-worker-verification.js';
import {
  buildDelegatedRetryableFailure,
  buildDelegatedRetryAttemptPlan,
  isDelegatedAnswerSynthesisRetry,
  isDelegatedToolEvidenceRetry,
  runDelegatedGroundedAnswerSynthesisRetry,
  shouldAdoptDelegatedTaskContract,
  shouldUseSameProfileDelegatedRetry,
  type DelegatedResultSufficiencyFailure,
} from '../runtime/execution-graph/delegated-worker-retry.js';
import {
  buildWorkerSuspensionArtifact,
  readWorkerSuspensionArtifact,
} from '../runtime/execution-graph/worker-suspension-artifact.js';
import {
  buildGraphWriteSpecSynthesisMessages,
  buildGroundedSynthesisLedgerArtifact,
  completeGraphWriteSpecSynthesisNode,
} from '../runtime/execution-graph/synthesis-node.js';
import {
  executeWriteSpecMutationNode,
  resumeWriteSpecMutationNodeAfterApproval,
  type MutationNodeExecutionContext,
} from '../runtime/execution-graph/mutation-node.js';
import {
  readExecutionGraphResumePayload,
  recordGraphPendingActionInterrupt,
} from '../runtime/execution-graph/pending-action-adapter.js';
import {
  buildGraphControlledTaskRunId,
  buildGraphReadOnlyIntentGatewayRecord,
  createGraphControlledRun,
  selectGraphControllerExecutionProfile,
  shouldUseGraphControlledExecution,
} from '../runtime/execution-graph/graph-controller.js';
import {
  runRecoveryAdvisorInvocation,
} from '../runtime/execution-graph/node-recovery.js';
import { readWorkerExecutionMetadata } from '../runtime/worker-execution-metadata.js';
import {
  buildDelegatedExecutionMetadata,
  readExecutionEvents,
} from '../runtime/execution/metadata.js';
import { buildDelegatedTaskContract } from '../runtime/execution/verifier.js';
import type { RecoveryAdvisorRequest } from '../runtime/execution/recovery-advisor.js';
import {
  shouldHandleDirectReasoningMode,
  type DirectReasoningTraceContext,
} from '../runtime/direct-reasoning-mode.js';
import {
  toPendingActionClientMetadata,
  type PendingActionApprovalSummary,
  type PendingActionRecord,
  type PendingActionScope,
  type PendingActionStore,
} from '../runtime/pending-actions.js';
import {
  CHAT_CONTINUATION_TYPE_AUTOMATION_AUTHORING,
  normalizeChatContinuationPrincipalRole,
} from '../runtime/chat-agent/chat-continuation-payloads.js';
import {
  emitChatContinuationGraphResumeEvent,
  readChatContinuationGraphResume,
  recordChatContinuationGraphApproval,
  type ChatContinuationGraphResume,
} from '../runtime/chat-agent/chat-continuation-graph.js';
import {
  attachWorkerAutomationAuthoringResumeMetadata,
} from '../worker/automation-resume.js';
import {
  attachWorkerSuspensionMetadata,
  buildWorkerSuspensionEnvelope,
  readWorkerSuspensionMetadata,
  type SerializedWorkerSuspensionSession,
  type WorkerSuspensionResumeContext,
} from '../runtime/worker-suspension.js';
import type {
  DelegatedResultEnvelope,
  ExecutionEvent,
  VerificationDecision,
} from '../runtime/execution/types.js';

const log = createLogger('worker-manager');
const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;
const WORKER_WORKSPACE_CLEANUP_MAX_RETRIES = 10;
const WORKER_WORKSPACE_CLEANUP_RETRY_DELAY_MS = 100;
const workerManagerPath = fileURLToPath(import.meta.url);
const workerManagerDir = dirname(workerManagerPath);

function describeAbortReason(signal: AbortSignal): string {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'request aborted';
}

function createWorkerDispatchCanceledError(signal: AbortSignal): Error {
  return new Error(`Worker message dispatch canceled: ${describeAbortReason(signal)}`);
}

function buildWorkerSessionKey(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

export interface WorkerMessageRequest {
  sessionId: string;
  agentId: string;
  userId: string;
  grantedCapabilities: string[];
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBases?: PromptAssemblyKnowledgeBase[];
  activeSkills?: ResolvedSkill[];
  additionalSections?: PromptAssemblyAdditionalSection[];
  toolContext?: string;
  runtimeNotices?: Array<{ level: 'info' | 'warn'; message: string }>;
  executionProfile?: SelectedExecutionProfile;
  continuity?: PromptAssemblyContinuity | null;
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  delegation?: WorkerDelegationMetadata;
  directReasoning?: boolean;
  directReasoningTrace?: DirectReasoningTraceContext;
}

export interface WorkerDelegationMetadata {
  requestId?: string;
  executionId?: string;
  rootExecutionId?: string;
  originChannel: string;
  originSurfaceId?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  pendingActionId?: string;
  codeSessionId?: string;
  runClass?: DelegatedWorkerRunClass;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
}

export interface WorkerManagerObservability {
  intentRoutingTrace?: Pick<IntentRoutingTraceLog, 'record'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestDelegatedWorkerProgress' | 'ingestDelegatedExecutionEvents' | 'ingestExecutionGraphEvent'>;
  pendingActionStore?: Pick<PendingActionStore, 'replaceActive' | 'complete' | 'update' | 'findActiveByApprovalId' | 'listActiveByApprovalId'>
    & Partial<Pick<PendingActionStore, 'resolveActiveForSurface'>>;
  executionGraphStore?: Pick<ExecutionGraphStore, 'createGraph' | 'appendEvent' | 'writeArtifact' | 'getSnapshot' | 'getArtifact' | 'listArtifacts'>;
  resolveStateAgentId?: (agentId?: string) => string | undefined;
  now?: () => number;
}

interface ResolvedDelegatedTargetMetadata {
  agentId: string;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
}

function normalizeDelegatedApprovalSummaries(value: unknown): PendingActionApprovalSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: PendingActionApprovalSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const toolName = typeof item.toolName === 'string' && item.toolName.trim()
      ? item.toolName.trim()
      : 'unknown';
    const argsPreview = typeof item.argsPreview === 'string'
      ? item.argsPreview
      : '';
    const actionLabel = typeof item.actionLabel === 'string' && item.actionLabel.trim()
      ? item.actionLabel.trim()
      : undefined;
    const requestId = typeof item.requestId === 'string' && item.requestId.trim()
      ? item.requestId.trim()
      : undefined;
    const codeSessionId = typeof item.codeSessionId === 'string' && item.codeSessionId.trim()
      ? item.codeSessionId.trim()
      : undefined;
    summaries.push({
      id,
      toolName,
      argsPreview,
      ...(actionLabel ? { actionLabel } : {}),
      ...(requestId ? { requestId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
    });
    seen.add(id);
  }
  return summaries;
}

function readDelegatedPendingApprovalMetadata(metadata: Record<string, unknown> | undefined): {
  approvalIds: string[];
  approvalSummaries: PendingActionApprovalSummary[];
  prompt: string;
} | null {
  const pendingAction = isRecord(metadata?.pendingAction) ? metadata.pendingAction : null;
  const blocker = isRecord(pendingAction?.blocker) ? pendingAction.blocker : null;
  if (!blocker || blocker.kind !== 'approval') return null;
  const summaries = normalizeDelegatedApprovalSummaries(blocker.approvalSummaries);
  const idsFromSummaries = summaries.map((summary) => summary.id);
  const idsFromBlocker = Array.isArray(blocker.approvalIds)
    ? blocker.approvalIds
        .map((id) => typeof id === 'string' ? id.trim() : '')
        .filter(Boolean)
    : [];
  const approvalIds = [...new Set([...idsFromBlocker, ...idsFromSummaries])];
  if (approvalIds.length === 0) return null;
  const prompt = typeof blocker.prompt === 'string' && blocker.prompt.trim()
    ? blocker.prompt.trim()
    : formatPendingApprovalMessage(summaries);
  return {
    approvalIds,
    approvalSummaries: summaries.length > 0
      ? summaries
      : approvalIds.map((id) => ({ id, toolName: 'unknown', argsPreview: '' })),
    prompt: prompt || 'Approval required for the pending delegated action.',
  };
}

const DELEGATED_REQUEST_JOB_LOOKUP_LIMIT = 500;
const DELEGATED_REQUEST_JOB_SNAPSHOT_LIMIT = 120;
interface ExecutionGraphResumeContext {
  graphId: string;
  nodeId: string;
  resumeToken: string;
  approvalId: string;
  writeSpec: ExecutionArtifact<WriteSpecContent>;
  mutationContext: MutationNodeExecutionContext;
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>;
  artifactIds: string[];
  expiresAt: number;
}

interface WorkerSuspensionGraphResumeContext {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId: string;
  resumeToken: string;
  approvalId: string;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  resume: WorkerSuspensionResumeContext;
  session: SerializedWorkerSuspensionSession;
  artifactIds: string[];
  sequenceStart: number;
  expiresAt: number;
}

export interface WorkerProcess {
  id: string;
  sessionId: string;
  workerSessionKey: string;
  agentId: string;
  authorizedBy: string;
  authorizedChannel: string;
  grantedCapabilities: string[];
  process: ChildProcess;
  brokerServer: BrokerServer;
  workspacePath: string;
  lastActivityMs: number;
  status: 'starting' | 'ready' | 'error' | 'shutting_down';
  dispatchQueue: Promise<void>;
  pendingMessageResolve?: (result: { content: string; metadata?: Record<string, unknown> }) => void;
  pendingMessageReject?: (error: Error) => void;
}

interface WorkerApprovalContinuationTraceContext {
  sessionId: string;
  agentId: string;
  userId: string;
  surfaceId?: string;
  originalUserContent?: string;
  requestId?: string;
  messageId?: string;
  executionId?: string;
  rootExecutionId?: string;
  originChannel?: string;
  originSurfaceId?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  pendingActionId?: string;
  codeSessionId?: string;
  runClass?: DelegatedWorkerRunClass;
  taskRunId?: string;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
  executionProfile?: SelectedExecutionProfile;
  principalId: string;
  principalRole: NonNullable<UserMessage['principalRole']>;
  channel: string;
}

interface WorkerJobFollowUpActionResult {
  success: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerProcess>();
  private readonly sessionToWorker = new Map<string, string>();
  private readonly delegatedFollowUpPayloads = new Map<string, {
    content: string;
    agentId: string;
    userId: string;
    channel: string;
  }>();
  private readonly tokenManager: CapabilityTokenManager;
  private readonly tools: ToolExecutor;
  private readonly runtime: Runtime;
  private readonly config: AgentIsolationConfig;
  private readonly sandboxConfig: SandboxConfig;
  private readonly observability: WorkerManagerObservability;
  private readonly delegatedJobTracker = new AssistantJobTracker({ maxJobs: 200 });
  private readonly reapInterval: NodeJS.Timeout;

  constructor(
    tools: ToolExecutor,
    runtime: Runtime,
    config: AgentIsolationConfig,
    sandboxConfig?: SandboxConfig,
    observability: WorkerManagerObservability = {},
  ) {
    this.tools = tools;
    this.runtime = runtime;
    this.config = config;
    this.sandboxConfig = sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
    this.observability = observability;
    this.tokenManager = new CapabilityTokenManager(config.capabilityTokenTtlMs);
    this.reapInterval = setInterval(() => this.reapIdleWorkers(), 60_000);
  }

  private buildCodeSessionRegistrySection(input: WorkerMessageRequest): PromptAssemblyAdditionalSection | null {
    const toolExecutor = this.tools as ToolExecutor & {
      buildCodeSessionRegistryAdditionalSection?: (
        request?: Partial<import('../tools/types.js').ToolExecutionRequest>,
        maxSessions?: number,
      ) => PromptAssemblyAdditionalSection | null;
    };
    if (typeof toolExecutor.buildCodeSessionRegistryAdditionalSection !== 'function') {
      return null;
    }
    const codeContext = input.message.metadata?.codeContext as import('../tools/types.js').ToolExecutionRequest['codeContext'] | undefined;
    return toolExecutor.buildCodeSessionRegistryAdditionalSection({
      userId: input.userId,
      principalId: input.message.principalId ?? input.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      surfaceId: input.message.surfaceId,
      ...(codeContext ? { codeContext } : {}),
    });
  }

  private async handleDirectReasoningMessage(
    input: WorkerMessageRequest,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const requestId = input.delegation?.requestId ?? input.message.id;
    const codeContext = input.message.metadata?.codeContext as import('../tools/types.js').ToolExecutionRequest['codeContext'] | undefined;
    const traceContext: DirectReasoningTraceContext = {
      requestId,
      messageId: input.message.id,
      userId: input.userId,
      channel: input.message.channel,
      agentId: input.agentId,
      contentPreview: input.message.content,
      ...(input.delegation?.executionId ? { executionId: input.delegation.executionId } : {}),
      ...(input.delegation?.rootExecutionId ? { rootExecutionId: input.delegation.rootExecutionId } : {}),
      ...(input.delegation?.codeSessionId ?? codeContext?.sessionId
        ? { codeSessionId: input.delegation?.codeSessionId ?? codeContext?.sessionId }
        : {}),
    };
    try {
      const worker = await this.getOrSpawnWorker(
        input.sessionId,
        input.agentId,
        input.userId,
        input.message.channel,
        input.grantedCapabilities,
      );
      const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.agentId);
      return await this.dispatchToWorker(worker, {
        message: input.message,
        systemPrompt: input.systemPrompt,
        history: input.history,
        knowledgeBases: input.knowledgeBases ?? [],
        activeSkills: input.activeSkills ?? [],
        additionalSections: appendPromptAdditionalSection(
          input.additionalSections ?? [],
          this.buildCodeSessionRegistrySection(input),
        ),
        toolContext: input.toolContext ?? '',
        runtimeNotices: input.runtimeNotices ?? [],
        executionProfile: input.executionProfile,
        continuity: input.continuity,
        pendingAction: input.pendingAction,
        pendingApprovalNotice: input.pendingApprovalNotice,
        hasFallbackProvider,
        directReasoning: true,
        directReasoningTrace: traceContext,
      });
    } catch (error) {
      this.observability.intentRoutingTrace?.record({
        stage: 'direct_reasoning_failed',
        requestId,
        messageId: input.message.id,
        userId: input.userId,
        channel: input.message.channel,
        agentId: input.agentId,
        contentPreview: input.message.content,
        details: {
          ...(traceContext.executionId ? { executionId: traceContext.executionId } : {}),
          ...(traceContext.rootExecutionId ? { rootExecutionId: traceContext.rootExecutionId } : {}),
          ...(traceContext.codeSessionId ? { codeSessionId: traceContext.codeSessionId } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private buildGraphControlledFailureResponse(
    input: {
      request: WorkerMessageRequest;
      effectiveIntentDecision?: IntentGatewayDecision;
    },
    reason: string,
    graphId?: string,
  ): { content: string; metadata?: Record<string, unknown> } {
    return {
      content: `Execution graph could not complete the request: ${reason}`,
      metadata: {
        executionProfile: input.request.executionProfile ?? undefined,
        executionGraph: {
          ...(graphId ? { graphId } : {}),
          status: 'failed',
          reason,
        },
      },
    };
  }

  private async runGraphControlledExecution(input: {
    request: WorkerMessageRequest;
    target: ResolvedDelegatedTargetMetadata;
    taskContract: DelegatedResultEnvelope['taskContract'];
    preRoutedGateway: IntentGatewayRecord | null | undefined;
    effectiveIntentDecision: IntentGatewayDecision | undefined;
    requestId: string;
    taskRunId: string;
  }): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    if (!shouldUseGraphControlledExecution({
      taskContract: input.taskContract,
      decision: input.effectiveIntentDecision,
      executionProfile: input.request.executionProfile,
    })) {
      return null;
    }

    const gatewayRecord = buildGraphReadOnlyIntentGatewayRecord({
      baseRecord: input.preRoutedGateway,
      baseDecision: input.effectiveIntentDecision,
      taskContract: input.taskContract,
      originalRequest: input.request.message.content,
    });
    if (!gatewayRecord) {
      return this.buildGraphControlledFailureResponse(input, 'Graph-controlled execution could not derive a read-only routing decision.');
    }
    const graphExecutionProfile = selectGraphControllerExecutionProfile({
      runtime: this.runtime,
      target: input.target,
      decision: input.effectiveIntentDecision,
      currentProfile: input.request.executionProfile,
    });
    if (!shouldHandleDirectReasoningMode({
      gateway: gatewayRecord,
      selectedExecutionProfile: graphExecutionProfile,
    })) {
      return null;
    }

    const now = this.observability.now ?? Date.now;
    const codeContext = input.request.message.metadata?.codeContext as ToolExecutionRequest['codeContext'] | undefined;
    const run = createGraphControlledRun({
      graphStore: this.observability.executionGraphStore,
      runTimeline: this.observability.runTimeline,
      now,
      taskRunId: input.taskRunId,
      requestId: input.requestId,
      gatewayDecision: gatewayRecord.decision,
      agentId: input.target.agentId,
      userId: input.request.userId,
      channel: input.request.message.channel,
      ...(input.request.message.surfaceId ? { surfaceId: input.request.message.surfaceId } : {}),
      triggerSourceId: input.request.message.id,
      ...(input.request.delegation?.rootExecutionId ? { rootExecutionId: input.request.delegation.rootExecutionId } : {}),
      ...(input.request.delegation?.executionId ? { parentExecutionId: input.request.delegation.executionId } : {}),
      ...(input.request.delegation?.codeSessionId ?? codeContext?.sessionId
        ? { codeSessionId: input.request.delegation?.codeSessionId ?? codeContext?.sessionId }
        : {}),
    });
    const { graphId, rootExecutionId, parentExecutionId, codeSessionId } = run;
    const { readNodeId, synthesisNodeId, mutationNodeId, verificationNodeId } = run.nodeIds;
    const emitGraphEvent = run.emitGraphEvent;
    const emitArtifact = run.emitArtifact;
    const failGraph = (reason: string, nodeId?: string, nodeKind?: ExecutionGraphEvent['nodeKind']) => {
      if (nodeId && nodeKind) {
        emitGraphEvent('node_failed', { reason }, `${nodeId}:failed`, { nodeId, nodeKind });
      }
      emitGraphEvent('graph_failed', { reason }, 'graph:failed');
      return this.buildGraphControlledFailureResponse(input, reason, graphId);
    };

    emitGraphEvent('graph_started', {
      route: input.effectiveIntentDecision?.route,
      operation: input.effectiveIntentDecision?.operation,
      executionClass: input.effectiveIntentDecision?.executionClass,
      controller: 'execution_graph',
    }, 'graph:started');

    try {
      const worker = await this.getOrSpawnWorker(
        input.request.sessionId,
        input.request.agentId,
        input.request.userId,
        input.request.message.channel,
        input.request.grantedCapabilities,
      );
      const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.request.agentId);
      const additionalSections = appendPromptAdditionalSection(
        input.request.additionalSections ?? [],
        this.buildCodeSessionRegistrySection(input.request),
      );
      const readGraphContext: DirectReasoningGraphContext = buildDirectReasoningGraphContext({
        graphId,
        nodeId: readNodeId,
        requestId: input.requestId,
        executionId: input.taskRunId,
        rootExecutionId,
        parentExecutionId,
        taskExecutionId: input.taskRunId,
        channel: input.request.message.channel,
        agentId: input.target.agentId,
        userId: input.request.userId,
        codeSessionId,
        decision: gatewayRecord.decision,
      });
      const readMessage: UserMessage = {
        ...input.request.message,
        content: gatewayRecord.decision.resolvedContent ?? input.request.message.content,
        metadata: attachPreRoutedIntentGatewayMetadata(input.request.message.metadata, gatewayRecord),
      };
      const directResult = await this.dispatchToWorker(worker, {
        message: readMessage,
        systemPrompt: input.request.systemPrompt,
        history: input.request.history,
        knowledgeBases: input.request.knowledgeBases ?? [],
        activeSkills: input.request.activeSkills ?? [],
        additionalSections,
        toolContext: input.request.toolContext ?? '',
        runtimeNotices: input.request.runtimeNotices ?? [],
        executionProfile: graphExecutionProfile,
        continuity: input.request.continuity,
        pendingAction: input.request.pendingAction,
        pendingApprovalNotice: input.request.pendingApprovalNotice,
        hasFallbackProvider,
        directReasoning: true,
        directReasoningTrace: {
          requestId: input.requestId,
          messageId: input.request.message.id,
          userId: input.request.userId,
          channel: input.request.message.channel,
          agentId: input.target.agentId,
          contentPreview: input.request.message.content,
          ...(parentExecutionId ? { executionId: parentExecutionId } : {}),
          rootExecutionId,
          taskExecutionId: input.taskRunId,
          ...(codeSessionId ? { codeSessionId } : {}),
        },
        directReasoningGraphContext: readGraphContext,
        directReasoningGraphLifecycle: 'node_only',
        returnExecutionGraphArtifacts: true,
      });
      const sourceArtifacts = readExecutionGraphArtifactsFromMetadata(directResult.metadata);
      for (const artifact of sourceArtifacts) {
        this.observability.executionGraphStore?.writeArtifact(artifact);
      }
      if (directResult.metadata?.directReasoningFailed === true || sourceArtifacts.length === 0) {
        return failGraph('Read-only graph node did not produce typed evidence artifacts.', readNodeId, 'explore_readonly');
      }

      emitGraphEvent('node_started', {
        evidenceArtifactCount: sourceArtifacts.length,
        purpose: 'write_spec_candidate',
      }, `${synthesisNodeId}:started`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
      const ledgerArtifact = buildGroundedSynthesisLedgerArtifact({
        graphId,
        nodeId: synthesisNodeId,
        artifactId: `${graphId}:${synthesisNodeId}:evidence-ledger`,
        sourceArtifacts,
        createdAt: now(),
      });
      if (ledgerArtifact) {
        emitArtifact(ledgerArtifact, synthesisNodeId, 'synthesize');
      }
      const synthesisMessages = buildGraphWriteSpecSynthesisMessages({
        request: input.request.message.content,
        decision: input.effectiveIntentDecision ?? gatewayRecord.decision,
        workspaceRoot: codeContext?.workspaceRoot,
        sourceArtifacts,
        ledgerArtifact,
      });
      emitGraphEvent('llm_call_started', {
        phase: 'write_spec_synthesis',
        evidenceArtifactCount: sourceArtifacts.length,
      }, `${synthesisNodeId}:llm:started`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
      const synthesisResult = await this.dispatchToWorker(worker, {
        message: input.request.message,
        systemPrompt: input.request.systemPrompt,
        history: input.request.history,
        knowledgeBases: input.request.knowledgeBases ?? [],
        activeSkills: input.request.activeSkills ?? [],
        additionalSections,
        toolContext: input.request.toolContext ?? '',
        runtimeNotices: input.request.runtimeNotices ?? [],
        executionProfile: graphExecutionProfile,
        continuity: input.request.continuity,
        pendingAction: input.request.pendingAction,
        pendingApprovalNotice: input.request.pendingApprovalNotice,
        hasFallbackProvider,
        groundedSynthesis: {
          messages: synthesisMessages,
          responseFormat: {
            type: 'json_schema',
            name: 'graph_write_spec_candidate',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                append: { type: 'boolean' },
                summary: { type: 'string' },
              },
              required: ['path', 'content', 'append'],
            },
          },
          maxTokens: 4_000,
          temperature: 0,
        },
      });
      emitGraphEvent('llm_call_completed', {
        phase: 'write_spec_synthesis',
        resultStatus: synthesisResult.content.trim() ? 'succeeded' : 'failed',
      }, `${synthesisNodeId}:llm:completed`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
      const synthesis = completeGraphWriteSpecSynthesisNode({
        graphId,
        nodeId: synthesisNodeId,
        candidateContent: synthesisResult.content,
        sourceArtifacts,
        ledgerArtifact,
        createdAt: now(),
      });
      if (!synthesis) {
        return failGraph('Synthesis node did not produce a valid write specification.', synthesisNodeId, 'synthesize');
      }
      const { draft, writeSpec } = synthesis;
      emitArtifact(draft.artifact, synthesisNodeId, 'synthesize');
      emitArtifact(writeSpec, synthesisNodeId, 'synthesize');
      emitGraphEvent('node_completed', {
        draftArtifactId: draft.artifact.artifactId,
        writeSpecArtifactId: writeSpec.artifactId,
      }, `${synthesisNodeId}:completed`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });

      const toolRequest = buildGraphMutationToolRequest(input.request, input.requestId, codeContext, graphExecutionProfile);
      const mutationContext: MutationNodeExecutionContext = {
        graphId,
        executionId: input.taskRunId,
        rootExecutionId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        requestId: input.requestId,
        runId: input.requestId,
        nodeId: mutationNodeId,
        channel: input.request.message.channel,
        agentId: input.target.agentId,
        userId: input.request.userId,
        ...(codeSessionId ? { codeSessionId } : {}),
        verificationNodeId,
        sequenceStart: run.currentSequence(),
        now,
        emit: (event) => {
          run.ingestGraphEvent(event);
        },
      };
      const mutationResult = await executeWriteSpecMutationNode({
        writeSpec,
        executeTool: (toolName, args, request) => this.tools.executeModelTool(toolName, args, request),
        toolRequest,
        context: mutationContext,
      });
      run.updateSequenceFromEvents(mutationResult.events);
      const artifactIds = [
        ...sourceArtifacts.map((artifact) => artifact.artifactId),
        ...(ledgerArtifact ? [ledgerArtifact.artifactId] : []),
        draft.artifact.artifactId,
        writeSpec.artifactId,
        ...(mutationResult.receiptArtifact ? [mutationResult.receiptArtifact.artifactId] : []),
        ...(mutationResult.verificationArtifact ? [mutationResult.verificationArtifact.artifactId] : []),
      ];
      if (mutationResult.receiptArtifact) {
        this.observability.executionGraphStore?.writeArtifact(mutationResult.receiptArtifact);
      }
      if (mutationResult.verificationArtifact) {
        this.observability.executionGraphStore?.writeArtifact(mutationResult.verificationArtifact);
      }

      if (mutationResult.status === 'awaiting_approval' && mutationResult.receiptArtifact) {
        const approvalEvent = mutationResult.events.find((event) => event.kind === 'approval_requested');
        const approvalId = mutationResult.receiptArtifact.content.approvalId;
        if (!approvalEvent || !approvalId) {
          return failGraph('Mutation node requested approval without a resumable approval id.', mutationNodeId, 'mutate');
        }
        const approvalSummary = {
          id: approvalId,
          toolName: 'fs_write',
          argsPreview: JSON.stringify({
            path: writeSpec.content.path,
            append: writeSpec.content.append,
          }),
          actionLabel: 'approve file write',
          requestId: input.requestId,
          ...(codeSessionId ? { codeSessionId } : {}),
        };
        const pendingScope: PendingActionScope = {
          agentId: input.request.agentId,
          userId: input.request.userId,
          channel: input.request.message.channel,
          surfaceId: input.request.message.surfaceId?.trim() || input.request.message.channel,
        };
        const pendingRecord = this.observability.pendingActionStore
          ? recordGraphPendingActionInterrupt({
              store: this.observability.pendingActionStore,
              scope: pendingScope,
              event: approvalEvent,
              originalUserContent: input.request.message.content,
              intent: {
                route: input.effectiveIntentDecision?.route,
                operation: input.effectiveIntentDecision?.operation,
                summary: input.effectiveIntentDecision?.summary,
                resolvedContent: input.effectiveIntentDecision?.resolvedContent,
              },
              artifactRefs: [writeSpec, mutationResult.receiptArtifact].map(artifactRefFromArtifact),
              approvalSummaries: [approvalSummary],
              nowMs: now(),
            })
          : null;
        return {
          content: formatPendingApprovalMessage([approvalSummary]),
          metadata: {
            executionProfile: graphExecutionProfile ?? undefined,
            executionGraph: {
              graphId,
              status: 'awaiting_approval',
              artifactIds,
              writeSpecArtifactId: writeSpec.artifactId,
              receiptArtifactId: mutationResult.receiptArtifact.artifactId,
            },
            ...(pendingRecord ? { pendingAction: toPendingActionClientMetadata(pendingRecord) } : {}),
            continueConversationAfterApproval: true,
          },
        };
      }

      if (mutationResult.status !== 'succeeded' || !mutationResult.verificationArtifact) {
        return failGraph('Mutation node failed before verification completed.', mutationNodeId, 'mutate');
      }
      emitGraphEvent('graph_completed', {
        status: 'succeeded',
        artifactIds,
        writeSpecArtifactId: writeSpec.artifactId,
        receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
        verificationArtifactId: mutationResult.verificationArtifact.artifactId,
      }, 'graph:completed');
      return {
        content: `Wrote ${writeSpec.content.path} and verified the contents.`,
        metadata: {
          executionProfile: graphExecutionProfile ?? undefined,
          executionGraph: {
            graphId,
            status: 'succeeded',
            artifactIds,
            writeSpecArtifactId: writeSpec.artifactId,
            receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
            verificationArtifactId: mutationResult.verificationArtifact.artifactId,
          },
        },
      };
    } catch (error) {
      return failGraph(error instanceof Error ? error.message : String(error));
    }
  }

  async resumeExecutionGraphPendingAction(
    pendingAction: PendingActionRecord,
    options: {
      approvalId: string;
      approvalResult: ToolApprovalDecisionResult;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const payload = readExecutionGraphResumePayload(pendingAction.resume?.payload);
    if (!payload) {
      return null;
    }
    const now = this.observability.now ?? Date.now;
    const chatResume = readChatContinuationGraphResume({
      graphStore: this.observability.executionGraphStore,
      pendingAction,
    });
    if (chatResume) {
      return this.resumeChatContinuationGraphPendingAction(
        pendingAction,
        chatResume,
        options,
      );
    }
    const workerSuspension = this.reconstructWorkerSuspensionGraphResume(pendingAction, payload, options.approvalId);
    if (workerSuspension) {
      return this.resumeWorkerSuspensionGraphPendingAction(
        pendingAction,
        workerSuspension,
        options,
      );
    }
    const suspension = this.reconstructExecutionGraphSuspension(pendingAction, payload, options.approvalId);
    if (!suspension) {
      this.markExecutionGraphPendingActionFailed(pendingAction, now());
      return {
        content: 'Execution graph approval was resolved, but the persisted graph resume state is no longer available. Please retry the request.',
        metadata: {
          executionGraph: {
            graphId: payload.graphId,
            status: 'failed',
            reason: 'persisted_graph_resume_state_missing',
          },
        },
      };
    }
    if (suspension.expiresAt <= now()) {
      this.markExecutionGraphPendingActionFailed(pendingAction, now());
      return {
        content: 'Execution graph approval was resolved, but the persisted graph resume state expired. Please retry the request.',
        metadata: {
          executionGraph: {
            graphId: suspension.graphId,
            status: 'failed',
            reason: 'persisted_graph_resume_state_expired',
          },
        },
      };
    }

    let sequence = suspension.mutationContext.sequenceStart ?? 0;
    const emitGraphEvent = (
      kind: ExecutionGraphEvent['kind'],
      payloadDetails: Record<string, unknown>,
      eventKey: string,
      optionsForEvent: {
        nodeId?: string;
        nodeKind?: ExecutionGraphEvent['nodeKind'];
        producer?: ExecutionGraphEvent['producer'];
      } = {},
    ): ExecutionGraphEvent => {
      sequence += 1;
      const event = createExecutionGraphEvent({
        eventId: `${suspension.graphId}:resume:${eventKey}:${sequence}`,
        graphId: suspension.graphId,
        executionId: suspension.mutationContext.executionId,
        rootExecutionId: suspension.mutationContext.rootExecutionId,
        ...(suspension.mutationContext.parentExecutionId ? { parentExecutionId: suspension.mutationContext.parentExecutionId } : {}),
        requestId: suspension.mutationContext.requestId,
        ...(suspension.mutationContext.runId ? { runId: suspension.mutationContext.runId } : {}),
        ...(optionsForEvent.nodeId ? { nodeId: optionsForEvent.nodeId } : {}),
        ...(optionsForEvent.nodeKind ? { nodeKind: optionsForEvent.nodeKind } : {}),
        kind,
        timestamp: now(),
        sequence,
        producer: optionsForEvent.producer ?? 'supervisor',
        ...(suspension.mutationContext.channel ? { channel: suspension.mutationContext.channel } : {}),
        ...(suspension.mutationContext.agentId ? { agentId: suspension.mutationContext.agentId } : {}),
        ...(suspension.mutationContext.userId ? { userId: suspension.mutationContext.userId } : {}),
        ...(suspension.mutationContext.codeSessionId ? { codeSessionId: suspension.mutationContext.codeSessionId } : {}),
        payload: payloadDetails,
      });
      this.observability.runTimeline?.ingestExecutionGraphEvent(event);
      this.observability.executionGraphStore?.appendEvent(event);
      return event;
    };

    if (!options.approvalResult.approved) {
      emitGraphEvent('approval_resolved', {
        approvalId: options.approvalId,
        toolName: 'fs_write',
        resultStatus: 'denied',
        writeSpecArtifactId: suspension.writeSpec.artifactId,
      }, 'approval-denied', { nodeId: suspension.nodeId, nodeKind: 'mutate' });
      emitGraphEvent('node_failed', {
        reason: options.approvalResult.message || 'Approval denied.',
        writeSpecArtifactId: suspension.writeSpec.artifactId,
      }, 'node-denied', { nodeId: suspension.nodeId, nodeKind: 'mutate' });
      emitGraphEvent('graph_failed', {
        reason: options.approvalResult.message || 'Approval denied.',
      }, 'graph-denied');
      this.completeExecutionGraphPendingAction(pendingAction, now());
      return {
        content: options.approvalResult.message || 'Approval denied. I did not make the requested change.',
        metadata: {
          executionGraph: {
            graphId: suspension.graphId,
            status: 'failed',
            reason: 'approval_denied',
          },
        },
      };
    }

    const mutationResult = await resumeWriteSpecMutationNodeAfterApproval({
      writeSpec: suspension.writeSpec,
      approvedToolResult: buildToolResultFromApprovalDecision(options.approvalId, options.approvalResult),
      executeTool: (toolName, args, request) => this.tools.executeModelTool(toolName, args, request),
      toolRequest: suspension.toolRequest,
      context: {
        ...suspension.mutationContext,
        sequenceStart: sequence,
        now,
        emit: (event) => {
          sequence = Math.max(sequence, event.sequence);
          this.observability.runTimeline?.ingestExecutionGraphEvent(event);
          this.observability.executionGraphStore?.appendEvent(event);
        },
      },
      approvalId: options.approvalId,
    });
    sequence = Math.max(sequence, ...mutationResult.events.map((event) => event.sequence));
    const artifactIds = [
      ...suspension.artifactIds,
      ...(mutationResult.receiptArtifact ? [mutationResult.receiptArtifact.artifactId] : []),
      ...(mutationResult.verificationArtifact ? [mutationResult.verificationArtifact.artifactId] : []),
    ];
    if (mutationResult.receiptArtifact) {
      this.observability.executionGraphStore?.writeArtifact(mutationResult.receiptArtifact);
    }
    if (mutationResult.verificationArtifact) {
      this.observability.executionGraphStore?.writeArtifact(mutationResult.verificationArtifact);
    }
    if (mutationResult.status !== 'succeeded' || !mutationResult.verificationArtifact) {
      emitGraphEvent('graph_failed', {
        reason: 'Mutation verification failed after approval.',
        artifactIds,
      }, 'graph-failed-after-approval');
      this.completeExecutionGraphPendingAction(pendingAction, now());
      return {
        content: 'Approval was applied, but execution graph verification failed after the write.',
        metadata: {
          executionGraph: {
            graphId: suspension.graphId,
            status: 'failed',
            artifactIds,
          },
        },
      };
    }
    emitGraphEvent('graph_completed', {
      status: 'succeeded',
      artifactIds,
      writeSpecArtifactId: suspension.writeSpec.artifactId,
      receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
      verificationArtifactId: mutationResult.verificationArtifact.artifactId,
    }, 'graph-completed-after-approval');
    this.completeExecutionGraphPendingAction(pendingAction, now());
    return {
      content: `Wrote ${suspension.writeSpec.content.path} and verified the contents.`,
      metadata: {
        executionGraph: {
          graphId: suspension.graphId,
          status: 'succeeded',
          artifactIds,
          writeSpecArtifactId: suspension.writeSpec.artifactId,
          receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
          verificationArtifactId: mutationResult.verificationArtifact.artifactId,
        },
      },
    };
  }

  private async resumeWorkerSuspensionGraphPendingAction(
    pendingAction: PendingActionRecord,
    suspension: WorkerSuspensionGraphResumeContext,
    options: {
      approvalId: string;
      approvalResult: ToolApprovalDecisionResult;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const now = this.observability.now ?? Date.now;
    if (suspension.expiresAt <= now()) {
      this.markExecutionGraphPendingActionFailed(pendingAction, now());
      return {
        content: 'Execution graph approval was resolved, but the delegated worker suspension expired. Please retry the request.',
        metadata: {
          executionGraph: {
            graphId: suspension.graphId,
            status: 'failed',
            reason: 'worker_suspension_expired',
          },
        },
      };
    }

    this.emitWorkerSuspensionGraphEvent(suspension, 'interruption_resolved', {
      approvalId: options.approvalId,
      resultStatus: options.approvalResult.approved ? 'approved' : 'denied',
      resumeToken: suspension.resumeToken,
    }, 'approval-resolved');

    if (!options.approvalResult.approved) {
      this.emitWorkerSuspensionGraphEvent(suspension, 'node_failed', {
        reason: options.approvalResult.message || 'Approval denied.',
      }, 'node-denied');
      this.emitWorkerSuspensionGraphEvent(suspension, 'graph_failed', {
        reason: options.approvalResult.message || 'Approval denied.',
      }, 'graph-denied', { nodeScoped: false });
      this.completeExecutionGraphPendingAction(pendingAction, now());
      return {
        content: options.approvalResult.message || 'Approval denied. I did not continue the delegated worker action.',
        metadata: {
          executionGraph: {
            graphId: suspension.graphId,
            status: 'failed',
            reason: 'approval_denied',
          },
        },
      };
    }

    const worker = await this.getOrSpawnWorker(
      suspension.resume.sessionId,
      suspension.resume.agentId,
      suspension.resume.userId,
      suspension.resume.channel,
      [],
    );
    const continuationMetadata = attachWorkerSuspensionMetadata(
      buildApprovalOutcomeContinuationMetadata({
        approvalId: options.approvalId,
        decision: 'approved',
        resultMessage: options.approvalResult.message,
      }),
      suspension.session,
    );
    const resumeMetadata = suspension.resume.automationResume
      ? attachWorkerAutomationAuthoringResumeMetadata(continuationMetadata, suspension.resume.automationResume)
      : continuationMetadata;

    const continuationResult = await this.dispatchToWorker(worker, {
      message: {
        id: randomUUID(),
        userId: suspension.resume.userId,
        principalId: suspension.resume.principalId,
        principalRole: suspension.resume.principalRole,
        channel: suspension.resume.channel,
        ...(suspension.resume.surfaceId ? { surfaceId: suspension.resume.surfaceId } : {}),
        content: '',
        metadata: resumeMetadata,
        timestamp: now(),
      },
      systemPrompt: '',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      hasFallbackProvider: !!this.runtime.getFallbackProviderConfig?.(worker.agentId),
    });

    const traceContext = this.workerSuspensionResumeContextToTraceContext(suspension.resume);
    this.recordWorkerApprovalContinuationExecutionArtifacts(
      traceContext,
      options.approvalId,
      continuationResult.metadata,
    );
    const pendingRecord = this.recordWorkerSuspensionGraphContinuationPendingAction({
      suspension,
      worker,
      result: continuationResult,
      previousPendingAction: pendingAction,
    });
    if (pendingRecord) {
      return {
        content: continuationResult.content,
        metadata: {
          ...(continuationResult.metadata ?? {}),
          pendingAction: toPendingActionClientMetadata(pendingRecord),
          continueConversationAfterApproval: true,
        },
      };
    }

    this.emitWorkerSuspensionGraphEvent(suspension, 'node_completed', {
      status: 'succeeded',
      artifactIds: suspension.artifactIds,
    }, 'node-completed-after-approval');
    this.emitWorkerSuspensionGraphEvent(suspension, 'graph_completed', {
      status: 'succeeded',
      artifactIds: suspension.artifactIds,
    }, 'graph-completed-after-approval', { nodeScoped: false });
    this.completeExecutionGraphPendingAction(pendingAction, now());
    return {
      content: continuationResult.content,
      metadata: {
        ...(continuationResult.metadata ?? {}),
        executionGraph: {
          graphId: suspension.graphId,
          status: 'succeeded',
          artifactIds: suspension.artifactIds,
        },
      },
    };
  }

  private recordWorkerSuspensionGraphContinuationPendingAction(input: {
    suspension: WorkerSuspensionGraphResumeContext;
    worker: WorkerProcess;
    result: { content: string; metadata?: Record<string, unknown> };
    previousPendingAction: PendingActionRecord;
  }): PendingActionRecord | null {
    const store = this.observability.pendingActionStore;
    const graphStore = this.observability.executionGraphStore;
    const approvalMetadata = readDelegatedPendingApprovalMetadata(input.result.metadata);
    const workerSuspension = readWorkerSuspensionMetadata(input.result.metadata);
    if (!store || !graphStore || !approvalMetadata || !workerSuspension) {
      return null;
    }
    const nowMs = this.observability.now?.() ?? Date.now();
    const event = this.emitWorkerSuspensionGraphEvent(input.suspension, 'interruption_requested', {
      kind: 'approval',
      prompt: approvalMetadata.prompt,
      approvalIds: approvalMetadata.approvalIds,
      approvalSummaries: approvalMetadata.approvalSummaries.map((summary) => ({ ...summary })),
      resumeToken: `${input.suspension.graphId}:${input.suspension.nodeId}:approval:${approvalMetadata.approvalIds.join(',')}`,
    }, 'approval-continuation');
    const resume = {
      ...input.suspension.resume,
      workerId: input.worker.id,
      workerSessionKey: input.worker.workerSessionKey,
      approvalIds: approvalMetadata.approvalIds,
      pendingActionId: input.previousPendingAction.id,
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    };
    const artifact = buildWorkerSuspensionArtifact({
      graphId: input.suspension.graphId,
      nodeId: input.suspension.nodeId,
      envelope: buildWorkerSuspensionEnvelope({
        resume,
        session: workerSuspension,
      }),
      createdAt: nowMs,
    });
    graphStore.writeArtifact(artifact);
    return recordGraphPendingActionInterrupt({
      store,
      scope: input.previousPendingAction.scope,
      event,
      originalUserContent: input.previousPendingAction.intent.originalUserContent,
      intent: input.previousPendingAction.intent,
      artifactRefs: [artifactRefFromArtifact(artifact)],
      approvalSummaries: approvalMetadata.approvalSummaries,
      nowMs,
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    });
  }

  private emitWorkerSuspensionGraphEvent(
    suspension: WorkerSuspensionGraphResumeContext,
    kind: ExecutionGraphEvent['kind'],
    payloadDetails: Record<string, unknown>,
    eventKey: string,
    options: {
      nodeScoped?: boolean;
    } = {},
  ): ExecutionGraphEvent {
    const nodeScoped = options.nodeScoped ?? true;
    const sequence = this.nextGraphSequence(suspension.graphId, suspension.sequenceStart);
    const event = createExecutionGraphEvent({
      eventId: `${suspension.graphId}:worker-resume:${eventKey}:${sequence}`,
      graphId: suspension.graphId,
      executionId: suspension.executionId,
      rootExecutionId: suspension.rootExecutionId,
      ...(suspension.parentExecutionId ? { parentExecutionId: suspension.parentExecutionId } : {}),
      requestId: suspension.requestId,
      ...(suspension.runId ? { runId: suspension.runId } : {}),
      ...(nodeScoped ? { nodeId: suspension.nodeId, nodeKind: 'delegated_worker' } : {}),
      kind,
      timestamp: this.observability.now?.() ?? Date.now(),
      sequence,
      producer: 'supervisor',
      ...(suspension.channel ? { channel: suspension.channel } : {}),
      ...(suspension.agentId ? { agentId: suspension.agentId } : {}),
      ...(suspension.userId ? { userId: suspension.userId } : {}),
      ...(suspension.codeSessionId ? { codeSessionId: suspension.codeSessionId } : {}),
      payload: payloadDetails,
    });
    this.observability.runTimeline?.ingestExecutionGraphEvent(event);
    this.observability.executionGraphStore?.appendEvent(event);
    return event;
  }

  private nextGraphSequence(graphId: string, fallback: number): number {
    const snapshot = this.observability.executionGraphStore?.getSnapshot(graphId);
    if (!snapshot) return fallback + 1;
    return snapshot.events.reduce((highest, event) => Math.max(highest, event.sequence), fallback) + 1;
  }

  private workerSuspensionResumeContextToTraceContext(
    resume: WorkerSuspensionResumeContext,
  ): WorkerApprovalContinuationTraceContext {
    return {
      sessionId: resume.sessionId,
      agentId: resume.agentId,
      userId: resume.userId,
      ...(resume.surfaceId ? { surfaceId: resume.surfaceId } : {}),
      ...(resume.originalUserContent ? { originalUserContent: resume.originalUserContent } : {}),
      ...(resume.requestId ? { requestId: resume.requestId } : {}),
      ...(resume.messageId ? { messageId: resume.messageId } : {}),
      ...(resume.executionId ? { executionId: resume.executionId } : {}),
      ...(resume.rootExecutionId ? { rootExecutionId: resume.rootExecutionId } : {}),
      ...(resume.originChannel ? { originChannel: resume.originChannel } : {}),
      ...(resume.originSurfaceId ? { originSurfaceId: resume.originSurfaceId } : {}),
      ...(resume.continuityKey ? { continuityKey: resume.continuityKey } : {}),
      ...(resume.activeExecutionRefs?.length ? { activeExecutionRefs: [...resume.activeExecutionRefs] } : {}),
      ...(resume.pendingActionId ? { pendingActionId: resume.pendingActionId } : {}),
      ...(resume.codeSessionId ? { codeSessionId: resume.codeSessionId } : {}),
      ...(resume.runClass ? { runClass: resume.runClass } : {}),
      ...(resume.taskRunId ? { taskRunId: resume.taskRunId } : {}),
      ...(resume.agentName ? { agentName: resume.agentName } : {}),
      ...(resume.orchestration ? { orchestration: cloneOrchestrationRoleDescriptor(resume.orchestration) } : {}),
      ...(resume.executionProfile ? { executionProfile: cloneSelectedExecutionProfile(resume.executionProfile) } : {}),
      principalId: resume.principalId,
      principalRole: resume.principalRole,
      channel: resume.channel,
    };
  }

  private async resumeChatContinuationGraphPendingAction(
    pendingAction: PendingActionRecord,
    chatResume: ChatContinuationGraphResume,
    options: {
      approvalId: string;
      approvalResult: ToolApprovalDecisionResult;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const graphStore = this.observability.executionGraphStore;
    if (!graphStore || chatResume.payload.type !== 'automation_authoring') return null;
    const nowMs = this.observability.now?.() ?? Date.now();
    this.completeExecutionGraphPendingAction(pendingAction, nowMs);
    emitChatContinuationGraphResumeEvent({
      graphStore,
      runTimeline: this.observability.runTimeline,
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
        graphStore,
        runTimeline: this.observability.runTimeline,
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
        content: options.approvalResult.message || 'Approval denied. I did not continue automation authoring.',
        metadata: {
          executionGraph: {
            graphId: chatResume.graph.graphId,
            status: 'failed',
            reason: 'approval_denied',
          },
        },
      };
    }

    const resume = chatResume.payload;
    const codeContext = resume.codeContext;
    const messageMetadata = {
      ...(resume.messageMetadata ?? {}),
      ...(codeContext ? { codeContext } : {}),
    };
    const result = await this.tryDirectAutomationAuthoring(
      {
        sessionId: `chat-continuation:${pendingAction.id}`,
        agentId: pendingAction.scope.agentId,
        userId: pendingAction.scope.userId,
        grantedCapabilities: [],
        message: {
          id: randomUUID(),
          userId: pendingAction.scope.userId,
          principalId: resume.principalId ?? pendingAction.scope.userId,
          principalRole: normalizeChatContinuationPrincipalRole(resume.principalRole) ?? 'owner',
          channel: pendingAction.scope.channel,
          surfaceId: pendingAction.scope.surfaceId,
          content: resume.originalUserContent,
          timestamp: Date.now(),
          ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {}),
        },
        systemPrompt: '',
        history: [],
      },
      {
        allowRemediation: resume.allowRemediation,
        assumeAuthoring: true,
      },
    );
    emitChatContinuationGraphResumeEvent({
      graphStore,
      runTimeline: this.observability.runTimeline,
      resume: chatResume,
      kind: result ? 'graph_completed' : 'graph_failed',
      payload: {
        continuationArtifactId: chatResume.artifact.artifactId,
        resultStatus: result ? 'completed' : 'failed',
      },
      eventKey: result ? 'completed' : 'failed',
    });
    if (!result) {
      return {
        content: 'Automation authoring could not resume after approval.',
        metadata: {
          executionGraph: {
            graphId: chatResume.graph.graphId,
            status: 'failed',
          },
        },
      };
    }
    return {
      content: result.content,
      metadata: {
        ...(result.metadata ?? {}),
        executionGraph: {
          graphId: chatResume.graph.graphId,
          status: 'completed',
          continuationArtifactId: chatResume.artifact.artifactId,
        },
      },
    };
  }

  private completeExecutionGraphPendingAction(
    pendingAction: PendingActionRecord,
    nowMs: number,
  ): void {
    this.observability.pendingActionStore?.complete(pendingAction.id, nowMs);
  }

  private markExecutionGraphPendingActionFailed(
    pendingAction: PendingActionRecord,
    nowMs: number,
  ): void {
    this.observability.pendingActionStore?.update(pendingAction.id, { status: 'failed' }, nowMs);
  }

  private reconstructWorkerSuspensionGraphResume(
    pendingAction: PendingActionRecord,
    payload: ReturnType<typeof readExecutionGraphResumePayload>,
    approvalId: string,
  ): WorkerSuspensionGraphResumeContext | null {
    if (!payload) return null;
    const graphStore = this.observability.executionGraphStore;
    if (!graphStore) return null;
    const snapshot = graphStore.getSnapshot(payload.graphId);
    if (!snapshot) return null;
    const artifactIds = uniqueStrings([
      ...payload.artifactIds,
      ...(pendingAction.graphInterrupt?.artifactRefs.map((artifact) => artifact.artifactId) ?? []),
    ]);
    const artifact = artifactIds
      .map((artifactId) => graphStore.getArtifact(payload.graphId, artifactId))
      .find((candidate) => candidate?.artifactType === 'WorkerSuspension');
    const envelope = readWorkerSuspensionArtifact(artifact);
    if (!envelope || !envelope.resume.approvalIds.includes(approvalId)) {
      return null;
    }
    const graph = snapshot.graph;
    const sequenceStart = snapshot.events.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      0,
    );
    return {
      graphId: graph.graphId,
      executionId: graph.executionId,
      rootExecutionId: graph.rootExecutionId,
      ...(graph.parentExecutionId ? { parentExecutionId: graph.parentExecutionId } : {}),
      requestId: graph.requestId,
      ...(graph.runId ? { runId: graph.runId } : {}),
      nodeId: payload.nodeId,
      resumeToken: payload.resumeToken,
      approvalId,
      ...(graph.securityContext.channel ? { channel: graph.securityContext.channel } : {}),
      ...(graph.securityContext.agentId ? { agentId: graph.securityContext.agentId } : {}),
      ...(graph.securityContext.userId ? { userId: graph.securityContext.userId } : {}),
      ...(graph.securityContext.codeSessionId ? { codeSessionId: graph.securityContext.codeSessionId } : {}),
      resume: envelope.resume,
      session: envelope.session,
      artifactIds: uniqueStrings([
        ...graph.artifacts.map((artifactRef) => artifactRef.artifactId),
        ...artifactIds,
      ]),
      sequenceStart,
      expiresAt: Math.min(pendingAction.expiresAt, envelope.resume.expiresAt, envelope.session.expiresAt),
    };
  }

  private reconstructExecutionGraphSuspension(
    pendingAction: PendingActionRecord,
    payload: ReturnType<typeof readExecutionGraphResumePayload>,
    approvalId: string,
  ): ExecutionGraphResumeContext | null {
    if (!payload) return null;
    const graphStore = this.observability.executionGraphStore;
    if (!graphStore) return null;
    const snapshot = graphStore.getSnapshot(payload.graphId);
    if (!snapshot) return null;
    const writeSpec = findStoredWriteSpecArtifact({
      graphStore,
      graphId: payload.graphId,
      artifactIds: [
        ...payload.artifactIds,
        ...(pendingAction.graphInterrupt?.artifactRefs.map((artifact) => artifact.artifactId) ?? []),
      ],
    });
    if (!writeSpec) return null;
    const graph = snapshot.graph;
    const sequenceStart = snapshot.events.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      0,
    );
    const channel = graph.securityContext.channel ?? pendingAction.scope.channel;
    const userId = graph.securityContext.userId ?? pendingAction.scope.userId;
    const agentId = graph.securityContext.agentId ?? pendingAction.scope.agentId;
    const verificationNodeId = graph.nodes.find((node) => node.kind === 'verify')?.nodeId;
    return {
      graphId: graph.graphId,
      nodeId: payload.nodeId,
      resumeToken: payload.resumeToken,
      approvalId,
      writeSpec,
      mutationContext: {
        graphId: graph.graphId,
        executionId: graph.executionId,
        rootExecutionId: graph.rootExecutionId,
        ...(graph.parentExecutionId ? { parentExecutionId: graph.parentExecutionId } : {}),
        requestId: graph.requestId,
        ...(graph.runId ? { runId: graph.runId } : {}),
        nodeId: payload.nodeId,
        channel,
        agentId,
        userId,
        ...(graph.securityContext.codeSessionId ? { codeSessionId: graph.securityContext.codeSessionId } : {}),
        ...(verificationNodeId ? { verificationNodeId } : {}),
        sequenceStart,
      },
      toolRequest: {
        origin: 'assistant',
        requestId: graph.requestId,
        agentId,
        userId,
        surfaceId: graph.securityContext.surfaceId ?? pendingAction.scope.surfaceId,
        principalId: userId,
        principalRole: 'owner',
        channel,
        activeSkills: [],
      },
      artifactIds: uniqueStrings([
        ...graph.artifacts.map((artifact) => artifact.artifactId),
        ...payload.artifactIds,
      ]),
      expiresAt: pendingAction.expiresAt,
    };
  }

  private startDelegatedWorkerGraph(input: {
    request: WorkerMessageRequest;
    target: ResolvedDelegatedTargetMetadata;
    taskContract: DelegatedResultEnvelope['taskContract'];
    intentDecision?: IntentGatewayDecision;
    requestId: string;
    taskRunId: string;
    detail: string;
  }): DelegatedWorkerGraphRun | null {
    if (!input.intentDecision || !this.observability.executionGraphStore) {
      return null;
    }
    const rootExecutionId = input.request.delegation?.rootExecutionId ?? input.taskRunId;
    const parentExecutionId = input.request.delegation?.executionId;
    const codeContext = input.request.message.metadata?.codeContext as ToolExecutionRequest['codeContext'] | undefined;
    const codeSessionId = input.request.delegation?.codeSessionId ?? codeContext?.sessionId;
    const context = buildDelegatedWorkerGraphContext({
      graphId: `execution-graph:${input.taskRunId}:delegated-worker`,
      executionId: input.taskRunId,
      taskExecutionId: input.taskRunId,
      rootExecutionId,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      requestId: input.requestId,
      runId: input.requestId,
      channel: input.request.message.channel,
      agentId: input.target.agentId,
      userId: input.request.userId,
      ...(codeSessionId ? { codeSessionId } : {}),
      title: describeDelegatedTarget(input.target),
      decision: input.intentDecision,
    });
    this.observability.executionGraphStore.createGraph(buildDelegatedWorkerGraphInput({
      context,
      intent: input.intentDecision,
      securityContext: {
        agentId: input.target.agentId,
        userId: input.request.userId,
        channel: input.request.message.channel,
        ...(input.request.message.surfaceId ? { surfaceId: input.request.message.surfaceId } : {}),
        ...(codeSessionId ? { codeSessionId } : {}),
      },
      trigger: {
        type: 'user_request',
        source: input.request.message.channel,
        sourceId: input.request.message.id,
      },
      ownerAgentId: input.target.agentId,
      executionProfileName: input.request.executionProfile?.id ?? input.request.executionProfile?.providerName,
    }));
    const run: DelegatedWorkerGraphRun = { context, sequence: 0 };
    const projection = buildDelegatedWorkerStartProjection({
      context,
      sequenceStart: run.sequence,
      timestamp: this.observability.now?.() ?? Date.now(),
      decision: input.intentDecision,
      summary: input.detail,
      payload: buildDelegatedTaskContractTraceMetadata(input.taskContract),
    });
    run.sequence = projection.sequence;
    for (const event of projection.events) {
      this.observability.runTimeline?.ingestExecutionGraphEvent(event);
      this.observability.executionGraphStore?.appendEvent(event);
    }
    return run;
  }

  private completeDelegatedWorkerGraph(
    run: DelegatedWorkerGraphRun | null,
    options: {
      lifecycle: 'completed' | 'blocked' | 'failed';
      handoff: DelegatedWorkerHandoff;
      taskContract: DelegatedResultEnvelope['taskContract'];
      verification: VerificationDecision;
      workerId?: string;
      approvalMetadata?: {
        approvalIds: string[];
        approvalSummaries: PendingActionApprovalSummary[];
        prompt: string;
      };
    },
  ): DelegatedWorkerGraphCompletion | undefined {
    if (!run) return undefined;
    const sharedPayload = {
      lifecycle: options.lifecycle,
      summary: options.handoff.summary,
      reason: options.handoff.summary,
      ...(options.handoff.nextAction ? { nextAction: options.handoff.nextAction } : {}),
      ...(options.handoff.unresolvedBlockerKind ? { unresolvedBlockerKind: options.handoff.unresolvedBlockerKind } : {}),
      ...(typeof options.handoff.approvalCount === 'number' ? { approvalCount: options.handoff.approvalCount } : {}),
      ...(options.handoff.reportingMode ? { reportingMode: options.handoff.reportingMode } : {}),
      ...(options.handoff.runClass ? { runClass: options.handoff.runClass } : {}),
      ...(options.workerId ? { workerId: options.workerId } : {}),
      ...(options.approvalMetadata?.approvalIds.length
        ? { approvalIds: [...options.approvalMetadata.approvalIds] }
        : {}),
      ...(options.approvalMetadata?.approvalSummaries.length
        ? { approvalSummaries: options.approvalMetadata.approvalSummaries.map((summary) => ({ ...summary })) }
        : {}),
      ...buildDelegatedTaskContractTraceMetadata(options.taskContract),
    };
    const completion = buildDelegatedWorkerGraphCompletion({
      run,
      timestamp: this.observability.now?.() ?? Date.now(),
      lifecycle: options.lifecycle,
      verification: options.verification,
      payload: sharedPayload,
      blockerKind: options.handoff.unresolvedBlockerKind,
      blockerPrompt: options.handoff.nextAction ?? options.handoff.summary,
    });
    this.observability.executionGraphStore?.writeArtifact(completion.verificationArtifact);
    for (const event of completion.events) {
      this.observability.runTimeline?.ingestExecutionGraphEvent(event);
      this.observability.executionGraphStore?.appendEvent(event);
    }
    return completion;
  }

  private failDelegatedWorkerGraph(
    run: DelegatedWorkerGraphRun | null,
    error: unknown,
    taskContract: DelegatedResultEnvelope['taskContract'],
  ): DelegatedWorkerGraphJobMetadata | undefined {
    if (!run) return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    const sharedPayload = {
      lifecycle: 'failed',
      reason,
      summary: reason,
      ...buildDelegatedTaskContractTraceMetadata(taskContract),
    };
    const failure = buildDelegatedWorkerGraphFailure({
      run,
      timestamp: this.observability.now?.() ?? Date.now(),
      payload: sharedPayload,
    });
    for (const event of failure.events) {
      this.observability.runTimeline?.ingestExecutionGraphEvent(event);
      this.observability.executionGraphStore?.appendEvent(event);
    }
    return failure.metadata;
  }

  async handleMessage(input: WorkerMessageRequest): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const approvalResponse = await this.tryHandleDirectApprovalMessage(input);
    if (approvalResponse) return approvalResponse;

    const preRoutedGateway = readPreRoutedIntentGatewayMetadata(input.message.metadata);
    const intentDecision = preRoutedGateway?.decision;
    const delegatedTarget = resolveDelegatedTargetMetadata(this.runtime, input);
    const effectiveIntentDecision = resolveDelegatedExecutionDecision({
      gatewayDecision: intentDecision,
      orchestration: delegatedTarget.orchestration,
      parentProfile: input.executionProfile,
    });
    const directIntentCandidates = intentDecision ? resolveIntentCapabilityCandidates(intentDecision) : [];
    const canDirectAutomation = intentDecision?.route === 'automation_authoring'
      && ['create', 'update', 'schedule'].includes(intentDecision.operation)
      && directIntentCandidates.some((candidate) => candidate === 'automation' || candidate === 'scheduled_email_automation');
    if (canDirectAutomation) {
      const directAutomation = await this.tryDirectAutomationAuthoring(input, {
        assumeAuthoring: true,
        intentDecision,
      });
      if (directAutomation) return directAutomation;
    }

    if (input.directReasoning === true) {
      return this.handleDirectReasoningMessage(input);
    }

    const requestId = input.delegation?.requestId ?? input.message.id;
    const delegatedJobDetail = describeDelegatedJob(input, delegatedTarget);
    const taskContract = buildDelegatedTaskContract(
      effectiveIntentDecision ?? undefined,
    );
    let effectiveTaskContract = taskContract;

    const graphControlledResult = await this.runGraphControlledExecution({
      request: input,
      target: delegatedTarget,
      taskContract: effectiveTaskContract,
      preRoutedGateway,
      effectiveIntentDecision: effectiveIntentDecision ?? undefined,
      requestId,
      taskRunId: buildGraphControlledTaskRunId(requestId),
    });
    if (graphControlledResult) {
      return graphControlledResult;
    }

    const delegatedJob = this.delegatedJobTracker.start({
      type: 'delegated_worker',
      source: 'system',
      detail: delegatedJobDetail,
      metadata: {
        delegation: buildDelegationJobMetadata(input, { lifecycle: 'running', target: delegatedTarget }),
      },
    });
    const delegatedTaskRunId = buildDelegatedTaskRunId(delegatedJob.id);
    this.recordDelegatedWorkerTrace('delegated_worker_started', input, delegatedTarget, {
      requestId,
      taskRunId: delegatedTaskRunId,
      lifecycle: 'running',
      taskContract,
      reason: delegatedJobDetail,
    });
    this.publishDelegatedWorkerProgress(input, delegatedTarget, {
      id: `delegated-worker:${delegatedJob.id}:started`,
      kind: 'started',
      requestId,
      taskRunId: delegatedTaskRunId,
      detail: delegatedJobDetail,
    });
    this.runtime.auditLog.record({
      type: 'broker_action',
      severity: 'info',
      agentId: input.agentId,
      userId: input.userId,
      channel: input.message.channel,
      controller: 'WorkerManager',
      details: buildDelegatedAuditDetails(input, delegatedTarget, requestId, {
        actionType: 'delegated_worker_started',
      }),
    });
    const delegatedGraphRun = this.startDelegatedWorkerGraph({
      request: input,
      target: delegatedTarget,
      taskContract,
      intentDecision: effectiveIntentDecision ?? undefined,
      requestId,
      taskRunId: delegatedTaskRunId,
      detail: delegatedJobDetail,
    });

    try {
      const worker = await this.getOrSpawnWorker(
        input.sessionId,
        input.agentId,
        input.userId,
        input.message.channel,
        input.grantedCapabilities,
      );
      this.delegatedJobTracker.update(delegatedJob.id, {
        metadata: {
          delegation: buildDelegationJobMetadata(input, {
            lifecycle: 'running',
            workerId: worker.id,
            target: delegatedTarget,
            executionGraph: buildDelegatedWorkerRunningMetadata(delegatedGraphRun),
          }),
        },
      });
      // LLM calls are proxied through the broker — the worker no longer needs the provider config.
      // We only tell the worker whether a fallback provider exists for quality-based retry.
      const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.agentId);
      let additionalSections = appendPromptAdditionalSection(
        input.additionalSections ?? [],
        this.buildCodeSessionRegistrySection(input),
      );
      let effectiveInput = input;
      if (preRoutedGateway && effectiveIntentDecision && effectiveIntentDecision !== intentDecision) {
        effectiveInput = {
          ...input,
          message: {
            ...input.message,
            metadata: attachPreRoutedIntentGatewayMetadata(
              input.message.metadata,
              {
                ...preRoutedGateway,
                decision: effectiveIntentDecision,
              }
            ),
          },
        };
      }
      let effectiveExecutionProfile = input.executionProfile;
      const delegatedWorkerRunningDetail = buildDelegatedWorkerRunningDetail(
        describeDelegatedTarget(delegatedTarget),
        input.executionProfile,
        input.delegation?.codeSessionId,
      );
      this.recordDelegatedWorkerTrace('delegated_worker_running', input, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle: 'running',
        workerId: worker.id,
        taskContract,
        additionalSections,
        reason: delegatedWorkerRunningDetail,
      });
      this.publishDelegatedWorkerProgress(input, delegatedTarget, {
        id: `delegated-worker:${delegatedJob.id}:running`,
        kind: 'running',
        requestId,
        taskRunId: delegatedTaskRunId,
        workerId: worker.id,
        detail: delegatedWorkerRunningDetail,
      });

      const baseDispatchParams = {
        message: effectiveInput.message,
        systemPrompt: effectiveInput.systemPrompt,
        history: effectiveInput.history,
        knowledgeBases: effectiveInput.knowledgeBases ?? [],
        activeSkills: effectiveInput.activeSkills ?? [],
        additionalSections,
        toolContext: effectiveInput.toolContext ?? '',
        runtimeNotices: effectiveInput.runtimeNotices ?? [],
        executionProfile: effectiveExecutionProfile,
        continuity: effectiveInput.continuity,
        pendingAction: effectiveInput.pendingAction,
        pendingApprovalNotice: effectiveInput.pendingApprovalNotice,
        hasFallbackProvider,
      };

      let result = await this.dispatchToWorker(worker, baseDispatchParams);
      const firstDrain = await awaitPendingDelegatedJobs(this.tools, requestId);
      if (firstDrain.inFlightRemaining > 0) {
        this.recordDelegatedWorkerTrace('delegated_job_wait_expired', input, delegatedTarget, {
          requestId,
          taskRunId: delegatedTaskRunId,
          lifecycle: 'running',
          taskContract,
          reason: `${firstDrain.inFlightRemaining} delegated job(s) remained in flight after ${firstDrain.waitedMs}ms drain`,
        });
      }
      let jobSnapshots = firstDrain.snapshots;
      let verifiedResult = verifyDelegatedWorkerResult({
        metadata: result.metadata,
        intentDecision: effectiveIntentDecision ?? undefined,
        executionProfile: effectiveExecutionProfile,
        taskContract: effectiveTaskContract,
        jobSnapshots,
      });
      let insufficiency = buildDelegatedRetryableFailure(verifiedResult.decision, verifiedResult.envelope);
      if (shouldAdoptDelegatedTaskContract(effectiveTaskContract, verifiedResult.envelope.taskContract)) {
        effectiveTaskContract = verifiedResult.envelope.taskContract;
      }
      type AnswerSynthesisFallback = {
        verifiedResult: typeof verifiedResult;
        insufficiency: DelegatedResultSufficiencyFailure;
        jobSnapshots: DelegatedJobSnapshot[];
      };
      const buildAnswerSynthesisFallback = (): AnswerSynthesisFallback | null => (
        insufficiency && isDelegatedAnswerSynthesisRetry(insufficiency)
          ? { verifiedResult, insufficiency, jobSnapshots }
          : null
      );
      const extendedFirstDrain = await awaitExtendedDelegatedEvidenceDrain({
        tools: this.tools,
        requestId,
        metadata: result.metadata,
        intentDecision: effectiveIntentDecision ?? undefined,
        executionProfile: effectiveExecutionProfile,
        taskContract: effectiveTaskContract,
        decision: verifiedResult.decision,
        jobSnapshots,
      });
      if (extendedFirstDrain) {
        if (extendedFirstDrain.inFlightRemaining > 0) {
          this.recordDelegatedWorkerTrace('delegated_job_wait_expired', input, delegatedTarget, {
            requestId,
            taskRunId: delegatedTaskRunId,
            lifecycle: 'running',
            taskContract: effectiveTaskContract,
            reason: `${extendedFirstDrain.inFlightRemaining} delegated evidence job(s) remained in flight after ${extendedFirstDrain.waitedMs}ms extended drain`,
          });
        }
        jobSnapshots = extendedFirstDrain.jobSnapshots;
        verifiedResult = extendedFirstDrain.verifiedResult;
        if (shouldAdoptDelegatedTaskContract(effectiveTaskContract, verifiedResult.envelope.taskContract)) {
          effectiveTaskContract = verifiedResult.envelope.taskContract;
        }
        insufficiency = extendedFirstDrain.insufficiency;
      }
      let answerSynthesisFallback = buildAnswerSynthesisFallback();
      if (insufficiency) {
        const retryProfile = shouldUseSameProfileDelegatedRetry(insufficiency, effectiveExecutionProfile)
          ? effectiveExecutionProfile ?? null
          : selectDelegatedRetryExecutionProfile(
                this.runtime,
                delegatedTarget,
                effectiveIntentDecision ?? undefined,
                effectiveExecutionProfile,
                insufficiency,
              );
        if (retryProfile) {
          const retryPlan = buildDelegatedRetryAttemptPlan({
            targetLabel: describeDelegatedTarget(delegatedTarget),
            currentProfile: effectiveExecutionProfile,
            retryProfile,
            insufficiency,
            codeSessionId: input.delegation?.codeSessionId,
            baseSections: baseDispatchParams.additionalSections,
            baseRecord: preRoutedGateway,
            baseDecision: effectiveIntentDecision ?? undefined,
            taskContract: effectiveTaskContract,
          });
          effectiveExecutionProfile = retryProfile;
          effectiveInput = {
            ...input,
            ...(effectiveExecutionProfile === input.executionProfile
              ? {}
              : { executionProfile: effectiveExecutionProfile }),
            message: {
              ...input.message,
              metadata: attachPreRoutedIntentGatewayMetadata(
                input.message.metadata,
                retryPlan.intentGatewayRecord,
              ),
            },
          };
          this.recordDelegatedWorkerTrace('delegated_worker_retrying', effectiveInput, delegatedTarget, {
            requestId,
            taskRunId: delegatedTaskRunId,
            lifecycle: 'running',
            workerId: worker.id,
            taskContract: effectiveTaskContract,
            additionalSections: retryPlan.additionalSections,
            reason: retryPlan.detail,
          });
          this.publishDelegatedWorkerProgress(effectiveInput, delegatedTarget, {
            id: `delegated-worker:${delegatedJob.id}:retrying`,
            kind: 'running',
            requestId,
            taskRunId: delegatedTaskRunId,
            workerId: worker.id,
            detail: retryPlan.detail,
          });
          this.runtime.auditLog.record({
            type: 'broker_action',
            severity: 'info',
            agentId: input.agentId,
            userId: input.userId,
            channel: input.message.channel,
            controller: 'WorkerManager',
            details: buildDelegatedAuditDetails(effectiveInput, delegatedTarget, requestId, {
              actionType: 'delegated_worker_retrying',
              reason: insufficiency.retryReason,
            }),
          });
          result = await this.dispatchToWorker(worker, {
            ...baseDispatchParams,
            message: effectiveInput.message,
            systemPrompt: effectiveInput.systemPrompt,
            history: effectiveInput.history,
            knowledgeBases: effectiveInput.knowledgeBases ?? [],
            activeSkills: effectiveInput.activeSkills ?? [],
            toolContext: effectiveInput.toolContext ?? '',
            runtimeNotices: effectiveInput.runtimeNotices ?? [],
            additionalSections: retryPlan.additionalSections,
            executionProfile: retryProfile,
            continuity: effectiveInput.continuity,
            pendingAction: effectiveInput.pendingAction,
            pendingApprovalNotice: effectiveInput.pendingApprovalNotice,
          });
          const retryDrain = await awaitPendingDelegatedJobs(this.tools, requestId);
          if (retryDrain.inFlightRemaining > 0) {
            this.recordDelegatedWorkerTrace('delegated_job_wait_expired', effectiveInput, delegatedTarget, {
              requestId,
              taskRunId: delegatedTaskRunId,
              lifecycle: 'running',
              taskContract: effectiveTaskContract,
              reason: `${retryDrain.inFlightRemaining} delegated job(s) remained in flight after ${retryDrain.waitedMs}ms drain (retry)`,
            });
          }
          jobSnapshots = retryDrain.snapshots;
          verifiedResult = verifyDelegatedWorkerResult({
            metadata: result.metadata,
            intentDecision: effectiveIntentDecision ?? undefined,
            executionProfile: effectiveExecutionProfile,
            taskContract: effectiveTaskContract,
            jobSnapshots,
          });
          if (shouldAdoptDelegatedTaskContract(effectiveTaskContract, verifiedResult.envelope.taskContract)) {
            effectiveTaskContract = verifiedResult.envelope.taskContract;
          }
          insufficiency = buildDelegatedRetryableFailure(verifiedResult.decision, verifiedResult.envelope);
          const extendedRetryDrain = await awaitExtendedDelegatedEvidenceDrain({
            tools: this.tools,
            requestId,
            metadata: result.metadata,
            intentDecision: effectiveIntentDecision ?? undefined,
            executionProfile: effectiveExecutionProfile,
            taskContract: effectiveTaskContract,
            decision: verifiedResult.decision,
            jobSnapshots,
          });
          if (extendedRetryDrain) {
            if (extendedRetryDrain.inFlightRemaining > 0) {
              this.recordDelegatedWorkerTrace('delegated_job_wait_expired', effectiveInput, delegatedTarget, {
                requestId,
                taskRunId: delegatedTaskRunId,
                lifecycle: 'running',
                taskContract: effectiveTaskContract,
                reason: `${extendedRetryDrain.inFlightRemaining} delegated evidence job(s) remained in flight after ${extendedRetryDrain.waitedMs}ms extended drain (retry)`,
              });
            }
            jobSnapshots = extendedRetryDrain.jobSnapshots;
            verifiedResult = extendedRetryDrain.verifiedResult;
            if (shouldAdoptDelegatedTaskContract(effectiveTaskContract, verifiedResult.envelope.taskContract)) {
              effectiveTaskContract = verifiedResult.envelope.taskContract;
            }
            insufficiency = extendedRetryDrain.insufficiency;
          }
          answerSynthesisFallback = buildAnswerSynthesisFallback();
        }
      }
      if (insufficiency && answerSynthesisFallback) {
        const synthesisDispatchBase = {
          ...baseDispatchParams,
          message: effectiveInput.message,
          systemPrompt: effectiveInput.systemPrompt,
          history: effectiveInput.history,
          knowledgeBases: effectiveInput.knowledgeBases ?? [],
          activeSkills: effectiveInput.activeSkills ?? [],
          toolContext: effectiveInput.toolContext ?? '',
          runtimeNotices: effectiveInput.runtimeNotices ?? [],
          executionProfile: effectiveExecutionProfile,
          continuity: effectiveInput.continuity,
          pendingAction: effectiveInput.pendingAction,
          pendingApprovalNotice: effectiveInput.pendingApprovalNotice,
        };
        const synthesisResult = await runDelegatedGroundedAnswerSynthesisRetry({
          originalRequest: effectiveInput.message.content,
          history: synthesisDispatchBase.history,
          intentDecision: effectiveIntentDecision ?? undefined,
          taskContract: effectiveTaskContract,
          verifiedResult: answerSynthesisFallback.verifiedResult,
          insufficiency: answerSynthesisFallback.insufficiency,
          jobSnapshots: answerSynthesisFallback.jobSnapshots,
          requestId,
          taskRunId: delegatedTaskRunId,
          workerId: worker.id,
          executionProfile: effectiveExecutionProfile,
          now: this.observability.now ?? Date.now,
          dispatchSynthesis: (groundedSynthesis) => this.dispatchToWorker(worker, {
            ...synthesisDispatchBase,
            groundedSynthesis,
          }),
          verifyResult: (verificationInput) => verifyDelegatedWorkerResult(verificationInput),
          trace: (event) => this.recordDelegatedWorkerTrace(event.stage, effectiveInput, delegatedTarget, event.details),
          progress: (event) => this.publishDelegatedWorkerProgress(effectiveInput, delegatedTarget, event),
        });
        if (synthesisResult) {
          result = synthesisResult.result;
          verifiedResult = synthesisResult.verifiedResult;
          if (shouldAdoptDelegatedTaskContract(effectiveTaskContract, verifiedResult.envelope.taskContract)) {
            effectiveTaskContract = verifiedResult.envelope.taskContract;
          }
          insufficiency = buildDelegatedRetryableFailure(verifiedResult.decision, verifiedResult.envelope);
        }
      }
      if (insufficiency) {
        const recoveryProposal = await runRecoveryAdvisorInvocation({
          originalRequest: effectiveInput.message.content,
          taskContract: effectiveTaskContract,
          verification: verifiedResult.decision,
          jobSnapshots,
          requestId,
          messageId: effectiveInput.message.id,
          userId: effectiveInput.userId,
          channel: effectiveInput.message.channel,
          ...(effectiveInput.message.surfaceId ? { surfaceId: effectiveInput.message.surfaceId } : {}),
          agentId: delegatedTarget.agentId,
          taskRunId: delegatedTaskRunId,
          ...(effectiveInput.delegation?.executionId ? { parentExecutionId: effectiveInput.delegation.executionId } : {}),
          ...(effectiveInput.delegation?.rootExecutionId ? { rootExecutionId: effectiveInput.delegation.rootExecutionId } : {}),
          ...(effectiveInput.delegation?.codeSessionId ? { codeSessionId: effectiveInput.delegation.codeSessionId } : {}),
          intent: effectiveIntentDecision ?? undefined,
          now: this.observability.now ?? Date.now,
          dispatchAdvisor: (advisorRequest) => this.dispatchToWorker(worker, {
            ...baseDispatchParams,
            message: effectiveInput.message,
            systemPrompt: effectiveInput.systemPrompt,
            history: effectiveInput.history,
            knowledgeBases: effectiveInput.knowledgeBases ?? [],
            activeSkills: effectiveInput.activeSkills ?? [],
            toolContext: effectiveInput.toolContext ?? '',
            runtimeNotices: effectiveInput.runtimeNotices ?? [],
            additionalSections: baseDispatchParams.additionalSections,
            executionProfile: effectiveExecutionProfile,
            continuity: effectiveInput.continuity,
            pendingAction: effectiveInput.pendingAction,
            pendingApprovalNotice: effectiveInput.pendingApprovalNotice,
            recoveryAdvisor: advisorRequest,
          }),
          trace: (entry) => {
            this.observability.intentRoutingTrace?.record(entry);
          },
          persistence: {
            createGraph: (graphInput) => {
              this.observability.executionGraphStore?.createGraph(graphInput);
            },
            ingestEvent: (event) => {
              this.observability.runTimeline?.ingestExecutionGraphEvent(event);
            },
            appendEvent: (event) => {
              this.observability.executionGraphStore?.appendEvent(event);
            },
            writeArtifact: (artifact) => {
              this.observability.executionGraphStore?.writeArtifact(artifact);
            },
          },
        });
        if (recoveryProposal) {
          this.recordDelegatedWorkerTrace('delegated_worker_running', effectiveInput, delegatedTarget, {
            requestId,
            taskRunId: delegatedTaskRunId,
            lifecycle: 'running',
            workerId: worker.id,
            taskContract: effectiveTaskContract,
            reason: 'Recovery proposal recorded as advisory graph state; delegated verification failure remains authoritative.',
          });
          result = {
            content: result.content,
            metadata: {
              ...(result.metadata ?? {}),
              ...recoveryProposal.metadata,
            },
          };
        }
      }
      const verifiedEnvelope = attachDelegatedVerificationDecision(
        verifiedResult.envelope,
        verifiedResult.decision,
        this.observability.now?.() ?? Date.now(),
      );
      const supervisorPlanId = effectiveTaskContract.plan.planId;
      const envelopePlanId = verifiedEnvelope.taskContract.plan.planId;
      const planDrift = supervisorPlanId !== envelopePlanId
        || effectiveTaskContract.plan.steps.length !== verifiedEnvelope.taskContract.plan.steps.length;
      this.recordDelegatedWorkerTrace('delegated_worker_contract_reconciled', effectiveInput, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle: insufficiency ? 'failed' : 'completed',
        taskContract: verifiedEnvelope.taskContract,
        reason: planDrift
          ? `Plan drift detected: supervisor=${supervisorPlanId} (${effectiveTaskContract.plan.steps.length} step(s)); envelope=${envelopePlanId} (${verifiedEnvelope.taskContract.plan.steps.length} step(s))`
          : `Plan reconciled: ${envelopePlanId} (${verifiedEnvelope.taskContract.plan.steps.length} step(s))`,
      });
      const sanitizedVerifiedEnvelope = sanitizeDelegatedEnvelopeForOperator(verifiedEnvelope);
      const verifiedMetadata: Record<string, unknown> = {
        ...(result.metadata ?? {}),
        ...buildDelegatedExecutionMetadata(sanitizedVerifiedEnvelope),
      };
      const verifiedResultPayload = {
        content: result.content,
        metadata: verifiedMetadata,
      };
      const handoff = insufficiency
        ? buildDelegatedInsufficientResultHandoff(
          insufficiency,
          effectiveInput.delegation?.runClass,
        )
        : buildDelegatedHandoff(
          result.content,
          verifiedMetadata,
          effectiveInput.delegation?.runClass,
          verifiedResult.decision,
        );
      const lifecycle = insufficiency
        ? 'failed'
        : resolveDelegatedWorkerLifecycle(
          verifiedMetadata,
          handoff.unresolvedBlockerKind,
          verifiedResult.decision,
        );
      const normalizedResult = insufficiency
        ? {
            content: formatFailedDelegatedMessage(handoff),
            metadata: {
              ...verifiedMetadata,
              delegatedHandoff: handoff,
              delegatedSufficiencyFailure: {
                decision: insufficiency.decision.decision,
                reason: insufficiency.retryReason,
                reasons: insufficiency.decision.reasons,
              },
            },
          }
        : applyDelegatedFollowUpPolicy(verifiedResultPayload, handoff, verifiedResult.decision);
      const delegatedPendingApprovalMetadata = readDelegatedPendingApprovalMetadata(normalizedResult.metadata);
      const executionGraphCompletion = this.completeDelegatedWorkerGraph(delegatedGraphRun, {
        lifecycle,
        handoff,
        taskContract: effectiveTaskContract,
        verification: verifiedResult.decision,
        workerId: worker.id,
        ...(delegatedPendingApprovalMetadata ? { approvalMetadata: delegatedPendingApprovalMetadata } : {}),
      });
      const executionGraphMetadata = executionGraphCompletion?.metadata;
      if (executionGraphMetadata) {
        normalizedResult.metadata = {
          ...(normalizedResult.metadata ?? {}),
          executionGraph: executionGraphMetadata,
        };
      }
      const pendingApprovalRecord = this.recordDelegatedPendingApprovalAction({
        worker,
        request: effectiveInput,
        result: normalizedResult,
        target: delegatedTarget,
        taskRunId: delegatedTaskRunId,
        intentDecision: effectiveIntentDecision ?? undefined,
        graphCompletion: executionGraphCompletion,
      });
      if (pendingApprovalRecord) {
        normalizedResult.metadata = {
          ...(normalizedResult.metadata ?? {}),
          pendingAction: toPendingActionClientMetadata(pendingApprovalRecord),
          continueConversationAfterApproval: true,
        };
      } else if (delegatedPendingApprovalMetadata) {
        const metadata = { ...(normalizedResult.metadata ?? {}) };
        delete metadata.pendingAction;
        delete metadata.continueConversationAfterApproval;
        normalizedResult.metadata = metadata;
      }
      this.recordDelegatedExecutionArtifacts(
        effectiveInput,
        delegatedTarget,
        requestId,
        delegatedTaskRunId,
        normalizedResult.metadata,
        verifiedEnvelope.events,
      );
      if (handoff.reportingMode === 'held_for_operator') {
        this.delegatedFollowUpPayloads.set(delegatedJob.id, {
          content: result.content,
          agentId: input.agentId,
          userId: input.userId,
          channel: input.message.channel,
        });
      } else {
        this.delegatedFollowUpPayloads.delete(delegatedJob.id);
      }
      if (lifecycle === 'failed') {
        this.delegatedJobTracker.fail(delegatedJob.id, new Error(handoff.summary), {
          detail: handoff.summary,
          metadata: {
            delegation: buildDelegationJobMetadata(effectiveInput, {
              lifecycle,
              workerId: worker.id,
              handoff,
              target: delegatedTarget,
              executionGraph: executionGraphMetadata,
            }),
          },
        });
        this.recordDelegatedWorkerTrace('delegated_worker_failed', effectiveInput, delegatedTarget, {
          requestId,
          taskRunId: delegatedTaskRunId,
          lifecycle,
          workerId: worker.id,
          taskContract: effectiveTaskContract,
          unresolvedBlockerKind: handoff.unresolvedBlockerKind,
          approvalCount: handoff.approvalCount,
          reportingMode: handoff.reportingMode,
          runClass: handoff.runClass,
          reason: handoff.summary,
          contentPreview: handoff.summary,
          handoff,
          workerMetadata: normalizedResult.metadata,
        });
        this.publishDelegatedWorkerProgress(effectiveInput, delegatedTarget, {
          id: `delegated-worker:${delegatedJob.id}:failed`,
          kind: 'failed',
          requestId,
          taskRunId: delegatedTaskRunId,
          workerId: worker.id,
          runClass: handoff.runClass,
          unresolvedBlockerKind: handoff.unresolvedBlockerKind,
          approvalCount: handoff.approvalCount,
          reportingMode: handoff.reportingMode,
          detail: handoff.summary,
        });
        this.runtime.auditLog.record({
          type: 'broker_action',
          severity: 'warn',
          agentId: input.agentId,
          userId: input.userId,
          channel: input.message.channel,
          controller: 'WorkerManager',
          details: buildDelegatedAuditDetails(effectiveInput, delegatedTarget, requestId, {
            actionType: 'delegated_worker_failed',
            unresolvedBlockerKind: handoff.unresolvedBlockerKind,
            approvalCount: handoff.approvalCount,
            reportingMode: handoff.reportingMode,
            reason: handoff.summary,
          }),
        });
        return normalizedResult;
      }

      this.delegatedJobTracker.succeed(delegatedJob.id, {
        detail: handoff.summary,
        metadata: {
          delegation: buildDelegationJobMetadata(effectiveInput, {
            lifecycle,
            workerId: worker.id,
            handoff,
            target: delegatedTarget,
            executionGraph: executionGraphMetadata,
          }),
        },
      });
      this.recordDelegatedWorkerTrace('delegated_worker_completed', effectiveInput, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle,
        workerId: worker.id,
        taskContract: effectiveTaskContract,
        unresolvedBlockerKind: handoff.unresolvedBlockerKind,
        approvalCount: handoff.approvalCount,
        reportingMode: handoff.reportingMode,
        runClass: handoff.runClass,
        reason: handoff.summary,
        contentPreview: lifecycle === 'blocked' ? handoff.nextAction : handoff.summary,
        handoff,
        workerMetadata: normalizedResult.metadata,
      });
      this.publishDelegatedWorkerProgress(effectiveInput, delegatedTarget, {
        id: `delegated-worker:${delegatedJob.id}:completed`,
        kind: lifecycle === 'blocked' ? 'blocked' : 'completed',
        requestId,
        taskRunId: delegatedTaskRunId,
        workerId: worker.id,
        runClass: handoff.runClass,
        unresolvedBlockerKind: handoff.unresolvedBlockerKind,
        approvalCount: handoff.approvalCount,
        reportingMode: handoff.reportingMode,
        detail: lifecycle === 'blocked' ? handoff.nextAction : handoff.summary,
      });
      this.runtime.auditLog.record({
        type: 'broker_action',
        severity: lifecycle === 'blocked' ? 'warn' : 'info',
        agentId: input.agentId,
        userId: input.userId,
        channel: input.message.channel,
        controller: 'WorkerManager',
        details: buildDelegatedAuditDetails(effectiveInput, delegatedTarget, requestId, {
          actionType: 'delegated_worker_completed',
          unresolvedBlockerKind: handoff.unresolvedBlockerKind,
          approvalCount: handoff.approvalCount,
          reportingMode: handoff.reportingMode,
        }),
      });
      return normalizedResult;
    } catch (error) {
      const executionGraphMetadata = this.failDelegatedWorkerGraph(delegatedGraphRun, error, taskContract);
      this.delegatedJobTracker.fail(delegatedJob.id, error, {
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          delegation: buildDelegationJobMetadata(input, {
            lifecycle: 'failed',
            target: delegatedTarget,
            handoff: {
              summary: truncateInlineText(error instanceof Error ? error.message : String(error), 220),
              nextAction: 'Inspect the delegated worker failure details.',
            },
            executionGraph: executionGraphMetadata,
          }),
        },
      });
      this.recordDelegatedWorkerTrace('delegated_worker_failed', input, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle: 'failed',
        taskContract,
        reason: error instanceof Error ? error.message : String(error),
        contentPreview: error instanceof Error ? error.message : String(error),
      });
      this.publishDelegatedWorkerProgress(input, delegatedTarget, {
        id: `delegated-worker:${delegatedJob.id}:failed`,
        kind: 'failed',
        requestId,
        taskRunId: delegatedTaskRunId,
        detail: error instanceof Error ? error.message : String(error),
      });
      this.runtime.auditLog.record({
        type: 'broker_action',
        severity: 'warn',
        agentId: input.agentId,
        userId: input.userId,
        channel: input.message.channel,
        controller: 'WorkerManager',
        details: buildDelegatedAuditDetails(input, delegatedTarget, requestId, {
          actionType: 'delegated_worker_failed',
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
      throw error;
    }
  }

  private recordDelegatedWorkerTrace(
    stage: Extract<
      IntentRoutingTraceStage,
      | 'delegated_worker_started'
      | 'delegated_worker_running'
      | 'delegated_worker_retrying'
      | 'delegated_worker_completed'
      | 'delegated_worker_failed'
      | 'delegated_worker_contract_reconciled'
      | 'delegated_job_wait_expired'
    >,
    input: WorkerMessageRequest,
    target: ResolvedDelegatedTargetMetadata,
    options: {
      requestId: string;
      taskRunId?: string;
      lifecycle?: 'running' | 'completed' | 'blocked' | 'failed';
      workerId?: string;
      taskContract?: DelegatedResultEnvelope['taskContract'];
      additionalSections?: PromptAssemblyAdditionalSection[];
      unresolvedBlockerKind?: string;
      approvalCount?: number;
      reportingMode?: string;
      runClass?: DelegatedWorkerRunClass;
      reason?: string;
      contentPreview?: string;
      handoff?: DelegatedWorkerHandoff;
      workerMetadata?: Record<string, unknown>;
    },
  ): void {
    const delegatedExecution = resolveDelegatedExecutionIdentity(input, options.taskRunId);
    const delegatedIntent = resolveDelegatedIntentContext(input, target);
    this.observability.intentRoutingTrace?.record({
      stage,
      requestId: options.requestId,
      messageId: input.message.id,
      userId: input.userId,
      channel: input.delegation?.originChannel ?? input.message.channel,
      agentId: target.agentId,
      contentPreview: options.contentPreview ?? input.message.content,
      details: {
        ...(input.delegation?.originSurfaceId ? { originSurfaceId: input.delegation.originSurfaceId } : {}),
        ...(delegatedExecution.executionId ? { executionId: delegatedExecution.executionId } : {}),
        ...(delegatedExecution.rootExecutionId ? { rootExecutionId: delegatedExecution.rootExecutionId } : {}),
        ...(delegatedExecution.taskExecutionId ? { taskExecutionId: delegatedExecution.taskExecutionId } : {}),
        ...(input.delegation?.continuityKey ? { continuityKey: input.delegation.continuityKey } : {}),
        ...(input.delegation?.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.delegation.activeExecutionRefs] } : {}),
        ...(input.delegation?.pendingActionId ? { pendingActionId: input.delegation.pendingActionId } : {}),
        ...(input.delegation?.codeSessionId ? { codeSessionId: input.delegation.codeSessionId } : {}),
        ...(target.agentName ? { agentName: target.agentName } : {}),
        ...(target.orchestration?.role ? { orchestrationRole: target.orchestration.role } : {}),
        ...(target.orchestration?.label ? { orchestrationLabel: target.orchestration.label } : {}),
        ...(target.orchestration?.lenses?.length ? { orchestrationLenses: [...target.orchestration.lenses] } : {}),
        ...buildDelegatedIntentTraceMetadata(delegatedIntent),
        ...buildDelegatedExecutionProfileTraceMetadata(input.executionProfile),
        ...buildDelegatedTaskContractTraceMetadata(options.taskContract),
        ...buildPromptAdditionalSectionTraceMetadata(options.additionalSections),
        ...buildDelegatedHandoffTraceMetadata(options.handoff),
        ...buildDelegatedWorkerExecutionTraceMetadata(options.workerMetadata),
        ...(options.taskRunId ? { taskRunId: options.taskRunId } : {}),
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
        ...(options.workerId ? { workerId: options.workerId } : {}),
        ...(options.unresolvedBlockerKind ? { unresolvedBlockerKind: options.unresolvedBlockerKind } : {}),
        ...(typeof options.approvalCount === 'number' ? { approvalCount: options.approvalCount } : {}),
        ...(options.reportingMode ? { reportingMode: options.reportingMode } : {}),
        ...(options.runClass ? { runClass: options.runClass } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
  }

  private publishDelegatedWorkerProgress(
    input: WorkerMessageRequest,
    target: ResolvedDelegatedTargetMetadata,
    event: Omit<DelegatedWorkerProgressEvent, 'agentId' | 'agentName' | 'orchestrationLabel' | 'originChannel' | 'requestPreview' | 'continuityKey' | 'activeExecutionRefs' | 'codeSessionId' | 'timestamp' | 'runId' | 'parentRunId' | 'executionProfileName' | 'executionProfileModel' | 'executionProfileTier'>,
  ): void {
    const delegatedExecution = resolveDelegatedExecutionIdentity(input, event.taskRunId);
    this.observability.runTimeline?.ingestDelegatedWorkerProgress({
      ...event,
      runId: delegatedExecution.executionId ?? event.requestId,
      parentRunId: delegatedExecution.executionId ?? event.requestId,
      ...(delegatedExecution.executionId ? { executionId: delegatedExecution.executionId } : {}),
      ...(delegatedExecution.rootExecutionId ? { rootExecutionId: delegatedExecution.rootExecutionId } : {}),
      ...(delegatedExecution.taskExecutionId ? { taskExecutionId: delegatedExecution.taskExecutionId } : {}),
      codeSessionId: input.delegation?.codeSessionId,
      agentId: target.agentId,
      ...(target.agentName ? { agentName: target.agentName } : {}),
      ...(target.orchestration?.label ? { orchestrationLabel: target.orchestration.label } : {}),
      originChannel: input.delegation?.originChannel ?? input.message.channel,
      requestPreview: input.message.content,
      continuityKey: input.delegation?.continuityKey,
      activeExecutionRefs: input.delegation?.activeExecutionRefs,
      ...buildDelegatedExecutionProfileMetadata(input.executionProfile),
      timestamp: this.observability.now?.() ?? Date.now(),
    });
  }

  private recordDelegatedExecutionArtifacts(
    input: WorkerMessageRequest,
    target: ResolvedDelegatedTargetMetadata,
    requestId: string,
    taskRunId: string,
    metadata: Record<string, unknown> | undefined,
    traceEvents: ExecutionEvent[] = readExecutionEvents(metadata),
  ): void {
    const timelineEvents = readExecutionEvents(metadata);
    if (traceEvents.length <= 0 && timelineEvents.length <= 0) {
      return;
    }
    const delegatedExecution = resolveDelegatedExecutionIdentity(input, taskRunId);
    for (const event of traceEvents) {
      this.recordDelegatedExecutionTraceEvent(input, target, requestId, delegatedExecution, event, traceEvents);
    }
    if (timelineEvents.length > 0 && typeof this.observability.runTimeline?.ingestDelegatedExecutionEvents === 'function') {
      this.observability.runTimeline.ingestDelegatedExecutionEvents({
        parentRunId: delegatedExecution.executionId ?? requestId,
        taskRunId,
        parentExecutionId: delegatedExecution.executionId ?? requestId,
        taskExecutionId: delegatedExecution.taskExecutionId,
        rootExecutionId: delegatedExecution.rootExecutionId ?? delegatedExecution.executionId ?? requestId,
        codeSessionId: input.delegation?.codeSessionId,
        agentId: target.agentId,
        channel: input.delegation?.originChannel ?? input.message.channel,
        events: timelineEvents,
      });
    }
  }

  private recordDelegatedExecutionTraceEvent(
    input: WorkerMessageRequest,
    target: ResolvedDelegatedTargetMetadata,
    requestId: string,
    delegatedExecution: {
      executionId?: string;
      rootExecutionId?: string;
      taskExecutionId?: string;
    },
    event: ExecutionEvent,
    traceEvents: ExecutionEvent[],
  ): void {
    const stage = mapExecutionEventToTraceStage(event.type);
    const contentPreview = buildDelegatedExecutionEventPreview(event);
    this.observability.intentRoutingTrace?.record({
      stage,
      requestId,
      messageId: input.message.id,
      userId: input.userId,
      channel: input.delegation?.originChannel ?? input.message.channel,
      agentId: target.agentId,
      ...(contentPreview ? { contentPreview } : {}),
      details: {
        ...(input.delegation?.originSurfaceId ? { originSurfaceId: input.delegation.originSurfaceId } : {}),
        ...(delegatedExecution.executionId ? { executionId: delegatedExecution.executionId } : {}),
        ...(delegatedExecution.rootExecutionId ? { rootExecutionId: delegatedExecution.rootExecutionId } : {}),
        ...(delegatedExecution.taskExecutionId ? { taskExecutionId: delegatedExecution.taskExecutionId } : {}),
        ...(input.delegation?.continuityKey ? { continuityKey: input.delegation.continuityKey } : {}),
        ...(input.delegation?.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.delegation.activeExecutionRefs] } : {}),
        ...(input.delegation?.pendingActionId ? { pendingActionId: input.delegation.pendingActionId } : {}),
        ...(input.delegation?.codeSessionId ? { codeSessionId: input.delegation.codeSessionId } : {}),
        ...(target.agentName ? { agentName: target.agentName } : {}),
        ...(target.orchestration?.role ? { orchestrationRole: target.orchestration.role } : {}),
        ...(target.orchestration?.label ? { orchestrationLabel: target.orchestration.label } : {}),
        eventId: event.eventId,
        eventType: event.type,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...event.payload,
        ...this.buildDelegatedVerificationFailureTraceDetails(input, requestId, event, traceEvents),
      },
    });
  }

  private buildDelegatedVerificationFailureTraceDetails(
    input: WorkerMessageRequest,
    requestId: string,
    event: ExecutionEvent,
    traceEvents: ExecutionEvent[],
  ): Record<string, unknown> {
    if (event.type !== 'verification_decided' || event.payload.decision === 'satisfied') {
      return {};
    }

    const tracedToolResults = traceEvents
      .filter((entry) => entry.type === 'tool_call_completed')
      .map((entry) => {
        const payload = entry.payload;
        const preview = typeof payload.traceResultPreview === 'string'
          ? payload.traceResultPreview
          : undefined;
        if (!preview) {
          return null;
        }
        return {
          toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
          toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
          resultStatus: typeof payload.resultStatus === 'string' ? payload.resultStatus : undefined,
          resultMessage: typeof payload.resultMessage === 'string' ? payload.resultMessage : undefined,
          errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined,
          resultPreview: preview,
          rawOutput: typeof payload.rawOutput === 'string' ? payload.rawOutput : undefined,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .slice(-6);

    const jobSnapshots = listDelegatedRequestJobSnapshots(this.tools, requestId)
      .slice(0, 24)
      .map((job) => ({
        jobId: job.id,
        toolName: job.toolName,
        status: job.status,
        argsPreview: job.argsPreview,
        resultPreview: job.resultPreview,
        error: job.error,
      }));

    return {
      verificationFailureDiagnostics: {
        requestId,
        userId: input.userId,
        channel: input.delegation?.originChannel ?? input.message.channel,
        ...(tracedToolResults.length > 0 ? { tracedToolResults } : {}),
        ...(jobSnapshots.length > 0 ? { jobSnapshots } : {}),
      },
    };
  }

  shutdown(): void {
    clearInterval(this.reapInterval);
    for (const worker of this.workers.values()) {
      worker.status = 'shutting_down';
      this.safeKillWorker(worker);
      this.cleanupWorker(worker);
    }
    this.workers.clear();
    this.sessionToWorker.clear();
    this.delegatedFollowUpPayloads.clear();
  }

  getJobState(limit = 30) {
    this.pruneDelegatedFollowUpPayloads();
    return this.delegatedJobTracker.getState(limit);
  }

  applyJobFollowUpAction(
    jobId: string,
    action: DelegatedWorkerOperatorAction,
  ): WorkerJobFollowUpActionResult {
    const job = this.delegatedJobTracker.getJob(jobId);
    if (!job) {
      return { success: false, message: `Job ${jobId} was not found.`, statusCode: 404, errorCode: 'JOB_NOT_FOUND' };
    }
    const delegated = readDelegatedWorkerMetadata(job.metadata);
    if (!delegated?.handoff || delegated.handoff.reportingMode !== 'held_for_operator') {
      return { success: false, message: `Job ${jobId} does not support operator follow-up actions.`, statusCode: 400, errorCode: 'JOB_ACTION_UNSUPPORTED' };
    }
    if (delegated.handoff.operatorState === 'dismissed') {
      return { success: false, message: `Job ${jobId} has already been dismissed.`, statusCode: 409, errorCode: 'JOB_ALREADY_DISMISSED' };
    }

    if (action === 'keep_held') {
      return this.updateDelegatedJobFollowUpState(job, delegated, 'kept_held', {
        successMessage: `Held delegated result for ${jobId}.`,
        auditActionType: 'delegated_worker_followup_kept',
      });
    }
    if (action === 'dismiss') {
      this.delegatedFollowUpPayloads.delete(jobId);
      return this.updateDelegatedJobFollowUpState(job, delegated, 'dismissed', {
        successMessage: `Dismissed held delegated result for ${jobId}.`,
        auditActionType: 'delegated_worker_followup_dismissed',
      });
    }

    const payload = this.delegatedFollowUpPayloads.get(jobId);
    if (!payload) {
      return { success: false, message: `Held delegated result for ${jobId} is no longer available.`, statusCode: 410, errorCode: 'JOB_PAYLOAD_EXPIRED' };
    }
    const scan = this.runtime.outputGuardian.scanResponse(payload.content);
    const replayedContent = scan.clean ? payload.content : scan.sanitized;
    if (!scan.clean) {
      this.runtime.auditLog.record({
        type: 'output_redacted',
        severity: 'warn',
        agentId: payload.agentId,
        userId: payload.userId,
        channel: payload.channel,
        controller: 'WorkerManager',
        details: {
          actionType: 'delegated_worker_followup_replay_redacted',
          secretCount: scan.secrets.length,
          patterns: scan.secrets.map((secret) => secret.pattern),
          jobId,
        },
      });
    }
    const result = this.updateDelegatedJobFollowUpState(job, delegated, 'replayed', {
      successMessage: `Replayed held delegated result for ${jobId}.`,
      auditActionType: 'delegated_worker_followup_replayed',
      details: {
        content: replayedContent,
        redacted: !scan.clean,
      },
    });
    return result;
  }

  private async tryHandleDirectApprovalMessage(
    input: WorkerMessageRequest,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const pendingAction = this.findDirectApprovalPendingAction(input);
    const pendingIds = pendingAction?.blocker.approvalIds ?? [];
    if (pendingIds.length === 0) return null;

    const trimmed = input.message.content.trim();
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

    const executionGraphPendingAction = pendingAction?.resume?.kind === 'execution_graph'
      ? pendingAction
      : null;
    const results: string[] = [];
    const approvedIds = new Set<string>();
    const failedIds = new Set<string>();
    const approvalDecisionResults = new Map<string, ToolApprovalDecisionResult>();
    for (const approvalId of targetIds) {
      const decided = await this.tools.decideApproval(
        approvalId,
        decision,
        input.message.principalId ?? input.message.userId,
        input.message.principalRole ?? 'owner',
      );
      approvalDecisionResults.set(approvalId, decided);
      const approvalGranted = decision === 'approved' && (decided.approved ?? decided.success);
      const executionFailed = approvalGranted && decided.executionSucceeded === false;
      if (approvalGranted) approvedIds.add(approvalId);
      if (!decided.success || executionFailed || (decision === 'approved' && !approvalGranted)) {
        failedIds.add(approvalId);
      }
      results.push(decided.message);
    }

    if (executionGraphPendingAction && targetIds.length === 1) {
      const approvalId = targetIds[0];
      const approvalResult = approvalDecisionResults.get(approvalId);
      if (approvalResult?.success && !failedIds.has(approvalId)) {
        const resumed = await this.resumeExecutionGraphPendingAction(
          executionGraphPendingAction,
          {
            approvalId,
            approvalResult,
          },
        );
        if (resumed) {
          return {
            content: [
              ...results,
              resumed.content,
            ].filter(Boolean).join('\n\n'),
            metadata: resumed.metadata,
          };
        }
      }
    }

    this.updatePendingActionsAfterDirectApprovalDecision(targetIds, decision, approvedIds, failedIds);
    return { content: results.join('\n') };
  }

  private updateDelegatedJobFollowUpState(
    job: { id: string; metadata?: Record<string, unknown> },
    delegated: NonNullable<ReturnType<typeof readDelegatedWorkerMetadata>>,
    operatorState: DelegatedWorkerOperatorFollowUpState,
    options: {
      successMessage: string;
      auditActionType: string;
      details?: Record<string, unknown>;
    },
  ): WorkerJobFollowUpActionResult {
    const handoff = {
      ...(delegated.handoff ?? { summary: 'Delegated worker completed.', reportingMode: 'held_for_operator' as const }),
      operatorState,
    };
    this.delegatedJobTracker.update(job.id, {
      metadata: {
        delegation: {
          ...(job.metadata?.delegation && typeof job.metadata.delegation === 'object'
            ? job.metadata.delegation
            : {}),
          kind: 'brokered_worker',
          lifecycle: delegated.lifecycle ?? 'completed',
          ...(delegated.originChannel ? { originChannel: delegated.originChannel } : {}),
          ...(delegated.continuityKey ? { continuityKey: delegated.continuityKey } : {}),
          ...(delegated.codeSessionId ? { codeSessionId: delegated.codeSessionId } : {}),
          ...(delegated.runClass ? { runClass: delegated.runClass } : {}),
          handoff,
        },
      },
    });
    this.runtime.auditLog.record({
      type: 'broker_action',
      severity: 'info',
      agentId: readDelegatedAgentId(job.metadata) ?? 'unknown',
      userId: undefined,
      channel: delegated.originChannel,
      controller: 'WorkerManager',
      details: {
        actionType: options.auditActionType,
        jobId: job.id,
        reportingMode: handoff.reportingMode,
        operatorState,
      },
    });
    return {
      success: true,
      message: options.successMessage,
      ...(options.details ? { details: options.details } : {}),
    };
  }

  private pruneDelegatedFollowUpPayloads(): void {
    for (const jobId of this.delegatedFollowUpPayloads.keys()) {
      const job = this.delegatedJobTracker.getJob(jobId);
      const delegated = job ? readDelegatedWorkerMetadata(job.metadata) : null;
      if (!job || delegated?.handoff?.reportingMode !== 'held_for_operator' || delegated.handoff.operatorState === 'dismissed') {
        this.delegatedFollowUpPayloads.delete(jobId);
      }
    }
  }

  private async tryDirectAutomationAuthoring(
    input: WorkerMessageRequest,
    options?: { allowRemediation?: boolean; assumeAuthoring?: boolean; intentDecision?: IntentGatewayDecision | null },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const allowedPaths = this.tools.getPolicy?.().sandbox.allowedPaths ?? [process.cwd()];
    const workspaceRoot = allowedPaths[0] || process.cwd();
    const preflightTools = this.tools.preflightTools
      ? (requests: Array<{ name: string; args?: Record<string, unknown> }>) => this.tools.preflightTools(requests)
      : (requests: Array<{ name: string; args?: Record<string, unknown> }>) => Promise.resolve(requests.map((request) => ({
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'No worker-manager preflight available; allowing direct automation compile fallback.',
          fixes: [],
        })));
    const trackedPendingApprovalIds: string[] = [];
    const result = await tryAutomationPreRoute({
      agentId: input.agentId,
      message: input.message,
      preflightTools,
      workspaceRoot,
      allowedPaths,
      executeTool: (toolName, args, request) => {
        // Forward codeContext from the inbound message metadata so tool decisions
        // (e.g. isCodeSessionWorkspaceTool auto-approve) see the code session context.
        const msgCodeContext = input.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return this.tools.executeModelTool(toolName, args, {
          ...request,
          ...(msgCodeContext ? { codeContext: msgCodeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        trackedPendingApprovalIds.push(approvalId);
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = this.resolveDirectPendingApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = this.resolveDirectPendingApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, options);
    if (!result) {
      return null;
    }
    if (trackedPendingApprovalIds.length > 0) {
      const pendingRecord = this.recordDirectAutomationPendingApprovalAction({
        request: input,
        result,
        approvalIds: trackedPendingApprovalIds,
        intentDecision: options?.intentDecision ?? undefined,
        allowRemediation: options?.allowRemediation,
      });
      if (pendingRecord) {
        result.metadata = {
          ...(result.metadata ?? {}),
          pendingAction: toPendingActionClientMetadata(pendingRecord),
        };
      }
    }
    return result;
  }

  private resolveDirectPendingApprovalMetadata(ids: string[]): AutomationPendingApprovalMetadata[] {
    const summaries = this.tools.getApprovalSummaries(ids);
    return ids.map((id) => {
      const summary = summaries.get(id);
      return {
        id,
        toolName: summary?.toolName ?? 'unknown',
        argsPreview: summary?.argsPreview ?? '',
        actionLabel: summary?.actionLabel ?? '',
      };
    });
  }

  private findDirectApprovalPendingAction(input: WorkerMessageRequest): PendingActionRecord | null {
    const store = this.observability.pendingActionStore;
    if (!store) return null;
    if (typeof store.resolveActiveForSurface !== 'function') return null;
    const surfaceId = input.message.surfaceId?.trim() || input.message.channel;
    const pendingAction = store.resolveActiveForSurface({
      agentId: this.resolvePendingActionAgentId(input.agentId),
      userId: input.userId,
      channel: input.message.channel,
      surfaceId,
    }, this.observability.now?.() ?? Date.now());
    if (pendingAction?.blocker.kind !== 'approval') return null;
    if ((pendingAction.blocker.approvalIds?.length ?? 0) === 0) return null;
    if (pendingAction.resume?.kind === 'execution_graph') return pendingAction;
    return null;
  }

  private updatePendingActionsAfterDirectApprovalDecision(
    approvalIds: string[],
    decision: 'approved' | 'denied',
    approvedIds: Set<string>,
    failedIds: Set<string>,
  ): void {
    const store = this.observability.pendingActionStore;
    if (!store) return;
    const nowMs = this.observability.now?.() ?? Date.now();
    for (const approvalId of approvalIds) {
      const pendingAction = store.findActiveByApprovalId(approvalId);
      if (!pendingAction) continue;
      if (decision === 'denied') {
        store.update(pendingAction.id, { status: 'cancelled' }, nowMs);
        continue;
      }
      if (failedIds.has(approvalId)) {
        store.update(pendingAction.id, { status: 'failed' }, nowMs);
        continue;
      }
      if (approvedIds.has(approvalId)) {
        this.clearApprovalIdFromPendingAction(approvalId, nowMs);
      }
    }
  }

  private clearApprovalIdFromPendingAction(approvalId: string, nowMs: number): PendingActionRecord | null {
    const store = this.observability.pendingActionStore;
    if (!store) return null;
    const activeRecords = store.listActiveByApprovalId(approvalId, nowMs);
    let firstUpdated: PendingActionRecord | null = null;
    for (const active of activeRecords) {
      const remainingApprovalIds = (active.blocker.approvalIds ?? []).filter((id) => id !== approvalId);
      const updated = remainingApprovalIds.length === 0
        ? store.complete(active.id, nowMs)
        : store.update(active.id, {
            blocker: {
              ...active.blocker,
              approvalIds: remainingApprovalIds,
              approvalSummaries: (active.blocker.approvalSummaries ?? [])
                .filter((summary) => summary.id !== approvalId),
            },
          }, nowMs);
      if (!firstUpdated) {
        firstUpdated = updated;
      }
    }
    return firstUpdated;
  }

  resetPendingState(args: {
    userId: string;
    channel: string;
    approvalIds?: string[];
  }): void {
    void args;
  }

  private async getOrSpawnWorker(
    sessionId: string,
    agentId: string,
    userId: string,
    channel: string,
    grantedCapabilities: string[],
  ): Promise<WorkerProcess> {
    const workerSessionKey = buildWorkerSessionKey(sessionId, agentId);
    const existingId = this.sessionToWorker.get(workerSessionKey);
    if (existingId) {
      const existing = this.workers.get(existingId);
      if (existing && existing.status === 'ready') {
        this.refreshWorkerCapabilityToken(existing, agentId, userId, channel, grantedCapabilities);
        existing.authorizedBy = userId;
        existing.authorizedChannel = channel;
        existing.grantedCapabilities = [...grantedCapabilities];
        existing.lastActivityMs = Date.now();
        return existing;
      }
    }

    const workerId = randomUUID();
    const workspacePath = join(tmpdir(), `ga-worker-${workerId}`);
    mkdirSync(join(workspacePath, 'tmp'), { recursive: true });

    const token = this.tokenManager.mint({
      workerId,
      sessionId,
      agentId,
      authorizedBy: userId,
      authorizedChannel: channel,
      grantedCapabilities,
      maxToolCalls: this.config.capabilityTokenMaxToolCalls,
    });

    const launch = resolveWorkerLaunch(this.config.workerEntryPoint);
    const sandboxHealth = await detectSandboxHealth(this.sandboxConfig);
    // LLM calls are proxied through the broker RPC, so the worker does not need network access.
    // On strong hosts, use the strict agent-worker profile. On degraded hosts, fall back to
    // workspace-write (NOT full-access) — the worker should never have unmediated system access.
    const workerProfile = sandboxHealth.availability === 'strong'
      ? 'agent-worker' as const
      : 'workspace-write' as const;
    // Workers are full Node.js processes that need more memory than short-lived tool subprocesses.
    // On strong sandbox backends we keep a generous floor for V8. On degraded ulimit-only hosts,
    // a virtual-memory cap is not reliable for long-lived Node workers and can prevent startup.
    const workerMemoryMb = sandboxHealth.availability === 'strong'
      ? Math.max(this.config.workerMaxMemoryMb, 2048)
      : 0;
    const workerSandboxConfig = {
      ...this.sandboxConfig,
      additionalReadPaths: mergeUniquePaths(
        this.sandboxConfig.additionalReadPaths,
        launch.additionalReadPaths,
      ),
      resourceLimits: {
        ...this.sandboxConfig.resourceLimits,
        maxMemoryMb: workerMemoryMb,
        maxCpuSeconds: 0, // Workers are long-lived — no CPU time limit
      },
    };
    const child = await sandboxedSpawn(
      launch.command,
      launch.args,
      workerSandboxConfig,
      {
        profile: workerProfile,
        networkAccess: false,
        cwd: workspacePath,
        env: {
          CAPABILITY_TOKEN: token.id,
          NODE_ENV: process.env.NODE_ENV ?? 'production',
        },
      },
    );

    if (!child.stdin || !child.stdout) {
      throw new Error('Worker process streams are not available');
    }

    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const brokerServer = new BrokerServer({
      tools: this.tools,
      runtime: this.runtime,
      tokenManager: this.tokenManager,
      inputStream: child.stdout,
      outputStream: child.stdin,
      workerId,
      onNotification: (notification) => {
        const worker = this.workers.get(workerId);
        if (!worker) return;

        if (notification.method === 'worker.ready') {
          worker.status = 'ready';
          readyResolve?.();
          return;
        }

        if (notification.method === 'message.response') {
          worker.pendingMessageResolve?.({
            content: String(notification.params.content ?? ''),
            metadata: isRecord(notification.params.metadata) ? notification.params.metadata : undefined,
          });
          worker.pendingMessageResolve = undefined;
          worker.pendingMessageReject = undefined;
          return;
        }

        if (notification.method === 'trace.record' && isRecord(notification.params)) {
          this.observability.intentRoutingTrace?.record({
            stage: String(notification.params.stage ?? '') as IntentRoutingTraceStage,
            requestId: typeof notification.params.requestId === 'string' ? notification.params.requestId : undefined,
            messageId: typeof notification.params.messageId === 'string' ? notification.params.messageId : undefined,
            userId: typeof notification.params.userId === 'string' ? notification.params.userId : undefined,
            channel: typeof notification.params.channel === 'string' ? notification.params.channel : undefined,
            agentId: typeof notification.params.agentId === 'string' ? notification.params.agentId : undefined,
            contentPreview: typeof notification.params.contentPreview === 'string' ? notification.params.contentPreview : undefined,
            details: isRecord(notification.params.details) ? notification.params.details : undefined,
          });
          return;
        }

        if (notification.method === 'execution_graph.event' && isExecutionGraphEvent(notification.params)) {
          this.observability.runTimeline?.ingestExecutionGraphEvent(notification.params);
          this.observability.executionGraphStore?.appendEvent(notification.params);
          return;
        }
      },
    });

    const worker: WorkerProcess = {
      id: workerId,
      sessionId,
      workerSessionKey,
      agentId,
      authorizedBy: userId,
      authorizedChannel: channel,
      grantedCapabilities: [...grantedCapabilities],
      process: child,
      brokerServer,
      workspacePath,
      lastActivityMs: Date.now(),
      status: 'starting',
      dispatchQueue: Promise.resolve(),
    };

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const trimmed = text.trim();
      if (trimmed) {
        log.warn({ workerId, stderr: trimmed }, 'Worker stderr');
      }
    });

    child.on('error', (error) => {
      readyReject?.(error instanceof Error ? error : new Error(String(error)));
      this.handleWorkerCrash(workerId, error instanceof Error ? error : new Error(String(error)));
    });

    child.on('exit', (code, signal) => {
      if (worker.status !== 'shutting_down') {
        const detail = new Error(`Worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        readyReject?.(detail);
        this.handleWorkerCrash(workerId, detail);
      } else {
        this.cleanupWorker(worker);
      }
    });

    this.workers.set(workerId, worker);
    this.sessionToWorker.set(workerSessionKey, workerId);

    brokerServer.sendNotification('worker.initialize', {
      agentId,
      sessionId,
      alwaysLoadedTools: this.tools.listAlwaysLoadedDefinitions(),
    });

    await Promise.race([
      readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Worker initialization timed out')), 15_000);
      }),
    ]);

    return worker;
  }

  private refreshWorkerCapabilityToken(
    worker: WorkerProcess,
    agentId: string,
    userId: string,
    channel: string,
    grantedCapabilities: string[],
  ): void {
    this.tokenManager.revokeForWorker(worker.id);
    const token = this.tokenManager.mint({
      workerId: worker.id,
      sessionId: worker.sessionId,
      agentId,
      authorizedBy: userId,
      authorizedChannel: channel,
      grantedCapabilities,
      maxToolCalls: this.config.capabilityTokenMaxToolCalls,
    });
    worker.brokerServer.sendNotification('capability.refreshed', {
      capabilityToken: token.id,
      agentId,
      sessionId: worker.sessionId,
    });
  }

  private dispatchToWorker(
    worker: WorkerProcess,
    params: {
      message: UserMessage;
      systemPrompt: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      knowledgeBases: PromptAssemblyKnowledgeBase[];
      activeSkills: ResolvedSkill[];
      additionalSections: PromptAssemblyAdditionalSection[];
      toolContext: string;
      runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
      executionProfile?: SelectedExecutionProfile;
      continuity?: PromptAssemblyContinuity | null;
      pendingAction?: PromptAssemblyPendingAction | null;
      pendingApprovalNotice?: string;
      hasFallbackProvider?: boolean;
      directReasoning?: boolean;
      directReasoningTrace?: DirectReasoningTraceContext;
      directReasoningGraphContext?: DirectReasoningGraphContext;
      directReasoningGraphLifecycle?: 'standalone' | 'node_only';
      returnExecutionGraphArtifacts?: boolean;
      groundedSynthesis?: {
        messages: ChatMessage[];
        responseFormat?: ChatOptions['responseFormat'];
        maxTokens?: number;
        temperature?: number;
      };
      recoveryAdvisor?: RecoveryAdvisorRequest;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const queuedDispatch = worker.dispatchQueue.then(() => this.dispatchToWorkerNow(worker, params));
    worker.dispatchQueue = queuedDispatch.then(() => undefined, () => undefined);
    return queuedDispatch;
  }

  private dispatchToWorkerNow(
    worker: WorkerProcess,
    params: {
      message: UserMessage;
      systemPrompt: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      knowledgeBases: PromptAssemblyKnowledgeBase[];
      activeSkills: ResolvedSkill[];
      additionalSections: PromptAssemblyAdditionalSection[];
      toolContext: string;
      runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
      executionProfile?: SelectedExecutionProfile;
      continuity?: PromptAssemblyContinuity | null;
      pendingAction?: PromptAssemblyPendingAction | null;
      pendingApprovalNotice?: string;
      hasFallbackProvider?: boolean;
      directReasoning?: boolean;
      directReasoningTrace?: DirectReasoningTraceContext;
      directReasoningGraphContext?: DirectReasoningGraphContext;
      directReasoningGraphLifecycle?: 'standalone' | 'node_only';
      returnExecutionGraphArtifacts?: boolean;
      groundedSynthesis?: {
        messages: ChatMessage[];
        responseFormat?: ChatOptions['responseFormat'];
        maxTokens?: number;
        temperature?: number;
      };
      recoveryAdvisor?: RecoveryAdvisorRequest;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    if (!this.workers.has(worker.id) || worker.status !== 'ready') {
      return Promise.reject(new Error('Worker is not available for dispatch'));
    }
    const abortSignal = params.message.abortSignal;
    if (abortSignal?.aborted) {
      return Promise.reject(createWorkerDispatchCanceledError(abortSignal));
    }
    worker.lastActivityMs = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupDispatch = () => {
        clearTimeout(timeout);
        abortSignal?.removeEventListener('abort', abortDispatch);
        worker.pendingMessageResolve = undefined;
        worker.pendingMessageReject = undefined;
      };
      const wrappedResolve = (value: { content: string; metadata?: Record<string, unknown> }) => {
        if (settled) return;
        settled = true;
        cleanupDispatch();
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupDispatch();
        reject(error);
      };
      const abortDispatch = () => {
        const error = createWorkerDispatchCanceledError(abortSignal!);
        wrappedReject(error);
        this.retireAbortedWorkerDispatch(worker, error);
      };
      const timeout = setTimeout(() => {
        wrappedReject(new Error('Worker message dispatch timed out'));
      }, 1800_000);

      worker.pendingMessageResolve = wrappedResolve;
      worker.pendingMessageReject = wrappedReject;
      abortSignal?.addEventListener('abort', abortDispatch, { once: true });

      const { abortSignal: _abortSignal, ...messageForWorker } = params.message;
      try {
        worker.brokerServer.sendNotification('message.handle', {
          ...params,
          message: messageForWorker,
        });
      } catch (error) {
        wrappedReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private retireAbortedWorkerDispatch(worker: WorkerProcess, error: Error): void {
    if (!this.workers.has(worker.id) || worker.status === 'shutting_down') return;
    worker.status = 'shutting_down';
    log.warn({ workerId: worker.id, reason: error.message }, 'Worker dispatch aborted; shutting down worker');
    try {
      worker.brokerServer.sendNotification('worker.shutdown', {
        reason: 'dispatch_aborted',
        gracePeriodMs: this.config.workerShutdownGracePeriodMs,
      });
    } catch (sendError) {
      log.warn(
        {
          workerId: worker.id,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        },
        'Failed to notify worker shutdown after aborted dispatch',
      );
    }
    setTimeout(() => {
      const current = this.workers.get(worker.id);
      if (!current) return;
      this.safeKillWorker(current);
      this.cleanupWorker(current);
    }, this.config.workerShutdownGracePeriodMs);
  }

  private reapIdleWorkers(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (now - worker.lastActivityMs <= this.config.workerIdleTimeoutMs) continue;
      worker.status = 'shutting_down';
      worker.brokerServer.sendNotification('worker.shutdown', {
        reason: 'idle_timeout',
        gracePeriodMs: this.config.workerShutdownGracePeriodMs,
      });
      setTimeout(() => {
        const current = this.workers.get(worker.id);
        if (!current) return;
        this.safeKillWorker(current);
        this.cleanupWorker(current);
      }, this.config.workerShutdownGracePeriodMs);
    }
  }

  private handleWorkerCrash(workerId: string, error: Error): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = 'error';

    this.runtime.auditLog.record({
      type: 'worker_crash',
      severity: 'warn',
      agentId: worker.agentId,
      details: {
        workerId,
        reason: error.message,
      },
    });

    worker.pendingMessageReject?.(error);
    worker.pendingMessageResolve = undefined;
    worker.pendingMessageReject = undefined;
    this.cleanupWorker(worker);
  }

  private cleanupWorker(worker: WorkerProcess): void {
    this.tokenManager.revokeForWorker(worker.id);
    this.workers.delete(worker.id);
    if (this.sessionToWorker.get(worker.workerSessionKey) === worker.id) {
      this.sessionToWorker.delete(worker.workerSessionKey);
    }
    if (!existsSync(worker.workspacePath)) {
      return;
    }
    try {
      this.removeWorkspacePath(worker.workspacePath);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : undefined;
      log.warn(
        {
          workerId: worker.id,
          sessionId: worker.sessionId,
          workspacePath: worker.workspacePath,
          code,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove worker workspace during cleanup',
      );
    }
  }

  private removeWorkspacePath(workspacePath: string): void {
    rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: WORKER_WORKSPACE_CLEANUP_MAX_RETRIES,
      retryDelay: WORKER_WORKSPACE_CLEANUP_RETRY_DELAY_MS,
    });
  }

  private safeKillWorker(worker: WorkerProcess): void {
    if (worker.process.killed) return;
    try {
      worker.process.kill('SIGKILL');
    } catch (error) {
      log.warn({ workerId: worker.id, error: error instanceof Error ? error.message : String(error) }, 'Failed to kill worker');
    }
  }

  private recordDelegatedGraphPendingApprovalAction(input: {
    worker: WorkerProcess;
    request: WorkerMessageRequest;
    result: { metadata?: Record<string, unknown> };
    target: ResolvedDelegatedTargetMetadata;
    taskRunId: string;
    intentDecision?: IntentGatewayDecision;
    graphCompletion?: DelegatedWorkerGraphCompletion;
    approvalMetadata: {
      approvalIds: string[];
      approvalSummaries: PendingActionApprovalSummary[];
      prompt: string;
    };
  }): PendingActionRecord | null {
    const store = this.observability.pendingActionStore;
    const graphStore = this.observability.executionGraphStore;
    const graphCompletion = input.graphCompletion;
    const interruption = graphCompletion?.interruptEvent;
    const workerSuspension = readWorkerSuspensionMetadata(input.result.metadata);
    if (!store || !graphStore || !graphCompletion || !interruption || !workerSuspension) {
      return null;
    }
    const originChannel = input.request.delegation?.originChannel?.trim()
      || input.request.message.channel;
    const surfaceId = input.request.message.surfaceId?.trim()
      || input.request.delegation?.originSurfaceId?.trim()
      || input.request.message.channel;
    const nowMs = this.observability.now?.() ?? Date.now();
    const resume = this.buildWorkerSuspensionResumeContext({
      worker: input.worker,
      request: input.request,
      target: input.target,
      taskRunId: input.taskRunId,
      approvalIds: input.approvalMetadata.approvalIds,
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    });
    const suspensionArtifact = buildWorkerSuspensionArtifact({
      graphId: interruption.graphId,
      nodeId: interruption.nodeId ?? graphCompletion.metadata.nodeId,
      envelope: buildWorkerSuspensionEnvelope({
        resume,
        session: workerSuspension,
      }),
      createdAt: nowMs,
    });
    graphStore.writeArtifact(suspensionArtifact);
    const artifactRefs = [
      ...(graphCompletion.verificationArtifactRef ? [graphCompletion.verificationArtifactRef] : []),
      artifactRefFromArtifact(suspensionArtifact),
    ];
    return recordGraphPendingActionInterrupt({
      store,
      scope: {
        agentId: input.request.agentId,
        userId: input.request.userId,
        channel: originChannel,
        surfaceId,
      },
      event: interruption,
      originalUserContent: input.request.message.content,
      intent: {
        ...(input.intentDecision?.route ? { route: input.intentDecision.route } : {}),
        ...(input.intentDecision?.operation ? { operation: input.intentDecision.operation } : {}),
        ...(input.intentDecision?.summary ? { summary: input.intentDecision.summary } : {}),
        ...(input.intentDecision?.turnRelation ? { turnRelation: input.intentDecision.turnRelation } : {}),
        ...(input.intentDecision?.resolution ? { resolution: input.intentDecision.resolution } : {}),
        ...(input.intentDecision?.missingFields?.length ? { missingFields: input.intentDecision.missingFields } : {}),
        ...(input.intentDecision?.resolvedContent ? { resolvedContent: input.intentDecision.resolvedContent } : {}),
        ...(input.intentDecision?.provenance ? { provenance: input.intentDecision.provenance } : {}),
        ...(input.intentDecision?.entities ? { entities: input.intentDecision.entities as Record<string, unknown> } : {}),
      },
      artifactRefs,
      approvalSummaries: input.approvalMetadata.approvalSummaries,
      nowMs,
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    });
  }

  private buildWorkerSuspensionResumeContext(input: {
    worker: WorkerProcess;
    request: WorkerMessageRequest;
    target: ResolvedDelegatedTargetMetadata;
    taskRunId: string;
    approvalIds: string[];
    expiresAt: number;
  }): WorkerSuspensionResumeContext {
    const delegation = input.request.delegation;
    const requestId = delegation?.requestId?.trim() || input.request.message.id;
    const originChannel = delegation?.originChannel?.trim() || input.request.message.channel;
    const originSurfaceId = delegation?.originSurfaceId?.trim() || input.request.message.surfaceId?.trim();
    const continuityKey = delegation?.continuityKey?.trim();
    const pendingActionId = delegation?.pendingActionId?.trim();
    const codeSessionId = delegation?.codeSessionId?.trim();
    const activeExecutionRefs = delegation?.activeExecutionRefs?.length
      ? [...delegation.activeExecutionRefs]
      : undefined;
    const agentName = input.target.agentName?.trim();
    const orchestration = cloneOrchestrationRoleDescriptor(input.target.orchestration);
    return {
      workerId: input.worker.id,
      workerSessionKey: input.worker.workerSessionKey,
      sessionId: input.worker.sessionId,
      agentId: input.worker.agentId,
      userId: input.request.userId,
      ...(input.request.message.surfaceId ? { surfaceId: input.request.message.surfaceId } : {}),
      ...(input.request.message.content ? { originalUserContent: input.request.message.content } : {}),
      requestId,
      messageId: input.request.message.id,
      ...(delegation?.executionId ? { executionId: delegation.executionId } : {}),
      ...(delegation?.rootExecutionId ? { rootExecutionId: delegation.rootExecutionId } : {}),
      originChannel,
      ...(originSurfaceId ? { originSurfaceId } : {}),
      ...(continuityKey ? { continuityKey } : {}),
      ...(activeExecutionRefs ? { activeExecutionRefs } : {}),
      ...(pendingActionId ? { pendingActionId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
      ...(delegation?.runClass ? { runClass: delegation.runClass } : {}),
      taskRunId: input.taskRunId,
      ...(agentName ? { agentName } : {}),
      ...(orchestration ? { orchestration } : {}),
      ...(input.request.executionProfile ? { executionProfile: cloneSelectedExecutionProfile(input.request.executionProfile) } : {}),
      principalId: input.request.message.principalId ?? input.request.userId,
      principalRole: input.request.message.principalRole ?? 'owner',
      channel: originChannel,
      approvalIds: [...new Set(input.approvalIds)],
      expiresAt: input.expiresAt,
    };
  }

  private recordDelegatedPendingApprovalAction(input: {
    worker: WorkerProcess;
    request: WorkerMessageRequest;
    result: { metadata?: Record<string, unknown> };
    target: ResolvedDelegatedTargetMetadata;
    taskRunId: string;
    intentDecision?: IntentGatewayDecision;
    graphCompletion?: DelegatedWorkerGraphCompletion;
  }): PendingActionRecord | null {
    if (!this.observability.pendingActionStore) return null;
    const approvalMetadata = readDelegatedPendingApprovalMetadata(input.result.metadata);
    if (!approvalMetadata) return null;
    return this.recordDelegatedGraphPendingApprovalAction({
      ...input,
      approvalMetadata,
    });
  }

  private recordDirectAutomationPendingApprovalAction(input: {
    request: WorkerMessageRequest;
    result: { content: string; metadata?: Record<string, unknown> };
    approvalIds: string[];
    intentDecision?: IntentGatewayDecision;
    allowRemediation?: boolean;
  }): PendingActionRecord | null {
    const store = this.observability.pendingActionStore;
    if (!store) return null;
    const approvalIds = [...new Set(input.approvalIds.map((id) => id.trim()).filter(Boolean))];
    if (approvalIds.length === 0) return null;
    const summaries = this.tools.getApprovalSummaries(approvalIds);
    const prompt = this.readPendingApprovalPrompt(input.result.metadata)
      ?? formatPendingApprovalMessage(buildPendingApprovalMetadata(approvalIds, summaries))
      ?? 'This action needs approval before I can continue.';
    const codeContext = this.readMessageCodeContext(input.request.message);
    const originChannel = input.request.delegation?.originChannel?.trim()
      || input.request.message.channel;
    const surfaceId = input.request.message.surfaceId?.trim()
      || input.request.delegation?.originSurfaceId?.trim()
      || input.request.message.channel;
    const nowMs = this.observability.now?.() ?? Date.now();
    const approvalSummaries = buildPendingApprovalMetadata(approvalIds, summaries);
    if (input.result.metadata?.resumeAutomationAfterApprovals) {
      const graphStore = this.observability.executionGraphStore;
      if (!graphStore) return null;
      return recordChatContinuationGraphApproval({
        graphStore,
        runTimeline: this.observability.runTimeline,
        userKey: `${input.request.userId}:${originChannel}`,
        userId: input.request.userId,
        channel: originChannel,
        surfaceId,
        agentId: this.resolvePendingActionAgentId(input.request.agentId),
        requestId: input.request.message.id,
        ...(codeContext?.sessionId ? { codeSessionId: codeContext.sessionId } : {}),
        action: {
          prompt,
          approvalIds,
          approvalSummaries,
          originalUserContent: input.request.message.content,
          route: input.intentDecision?.route ?? 'automation_authoring',
          operation: input.intentDecision?.operation ?? 'create',
          summary: input.intentDecision?.summary ?? 'Creates or updates a Guardian automation.',
          turnRelation: input.intentDecision?.turnRelation ?? 'new_request',
          resolution: input.intentDecision?.resolution ?? 'ready',
          ...(input.intentDecision?.missingFields?.length ? { missingFields: input.intentDecision.missingFields } : {}),
          ...(input.intentDecision?.provenance ? { provenance: input.intentDecision.provenance } : {}),
          ...(input.intentDecision?.entities ? { entities: input.intentDecision.entities as Record<string, unknown> } : {}),
          continuation: {
            type: CHAT_CONTINUATION_TYPE_AUTOMATION_AUTHORING,
            originalUserContent: input.request.message.content,
            allowRemediation: input.allowRemediation !== false,
            principalId: input.request.message.principalId ?? input.request.userId,
            principalRole: input.request.message.principalRole,
            ...(isRecord(input.request.message.metadata) ? { messageMetadata: { ...input.request.message.metadata } } : {}),
            ...(codeContext ? { codeContext } : {}),
          },
          ...(codeContext?.sessionId ? { codeSessionId: codeContext.sessionId } : {}),
        },
        setGraphPendingActionForRequest: (_userKey, _surfaceId, action, nextNowMs) => ({
          action: recordGraphPendingActionInterrupt({
            store,
            scope: {
              agentId: this.resolvePendingActionAgentId(input.request.agentId),
              userId: input.request.userId,
              channel: originChannel,
              surfaceId,
            },
            event: action.event,
            originalUserContent: action.originalUserContent,
            intent: action.intent,
            artifactRefs: action.artifactRefs,
            approvalSummaries: action.approvalSummaries,
            transferPolicy: action.transferPolicy,
            nowMs: nextNowMs,
            expiresAt: action.expiresAt,
          }),
        }),
        nowMs,
      }).action;
    }
    return store.replaceActive(
      {
        agentId: this.resolvePendingActionAgentId(input.request.agentId),
        userId: input.request.userId,
        channel: originChannel,
        surfaceId,
      },
      {
        status: 'pending',
        transferPolicy: 'origin_surface_only',
        blocker: {
          kind: 'approval',
          prompt,
          approvalIds,
          approvalSummaries,
        },
        intent: {
          route: input.intentDecision?.route ?? 'automation_authoring',
          operation: input.intentDecision?.operation ?? 'create',
          summary: input.intentDecision?.summary ?? 'Creates or updates a Guardian automation.',
          turnRelation: input.intentDecision?.turnRelation ?? 'new_request',
          resolution: input.intentDecision?.resolution ?? 'ready',
          ...(input.intentDecision?.missingFields?.length ? { missingFields: input.intentDecision.missingFields } : {}),
          ...(input.intentDecision?.resolvedContent ? { resolvedContent: input.intentDecision.resolvedContent } : {}),
          ...(input.intentDecision?.provenance ? { provenance: input.intentDecision.provenance } : {}),
          ...(input.intentDecision?.entities ? { entities: input.intentDecision.entities as Record<string, unknown> } : {}),
          originalUserContent: input.request.message.content,
        },
        ...(input.request.delegation?.executionId ? { executionId: input.request.delegation.executionId } : {}),
        ...(input.request.delegation?.rootExecutionId ? { rootExecutionId: input.request.delegation.rootExecutionId } : {}),
        ...(codeContext?.sessionId ? { codeSessionId: codeContext.sessionId } : {}),
        expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
      },
      nowMs,
    );
  }

  private readPendingApprovalPrompt(metadata: Record<string, unknown> | undefined): string | null {
    if (!isRecord(metadata?.pendingAction) || !isRecord(metadata.pendingAction.blocker)) {
      return null;
    }
    const prompt = metadata.pendingAction.blocker.prompt;
    return typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
  }

  private readMessageCodeContext(message: UserMessage): { workspaceRoot: string; sessionId?: string } | undefined {
    const metadata = message.metadata;
    if (!isRecord(metadata?.codeContext)) return undefined;
    const workspaceRoot = typeof metadata.codeContext.workspaceRoot === 'string'
      ? metadata.codeContext.workspaceRoot.trim()
      : '';
    if (!workspaceRoot) return undefined;
    const sessionId = typeof metadata.codeContext.sessionId === 'string'
      ? metadata.codeContext.sessionId.trim()
      : '';
    return {
      workspaceRoot,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private resolvePendingActionAgentId(agentId: string): string {
    return this.observability.resolveStateAgentId?.(agentId)?.trim() || agentId;
  }

  private buildWorkerContinuationTraceRequest(
    state: WorkerApprovalContinuationTraceContext,
    approvalId: string,
  ): WorkerMessageRequest {
    const requestId = state.requestId?.trim() || state.messageId?.trim() || approvalId;
    const originChannel = state.originChannel?.trim() || state.channel;
    const originSurfaceId = state.originSurfaceId?.trim() || state.surfaceId?.trim();
    const delegation: WorkerDelegationMetadata = {
      requestId,
      originChannel,
      ...(state.executionId ? { executionId: state.executionId } : {}),
      ...(state.rootExecutionId ? { rootExecutionId: state.rootExecutionId } : {}),
      ...(originSurfaceId ? { originSurfaceId } : {}),
      ...(state.continuityKey ? { continuityKey: state.continuityKey } : {}),
      ...(state.activeExecutionRefs?.length ? { activeExecutionRefs: [...state.activeExecutionRefs] } : {}),
      ...(state.pendingActionId ? { pendingActionId: state.pendingActionId } : {}),
      ...(state.codeSessionId ? { codeSessionId: state.codeSessionId } : {}),
      ...(state.runClass ? { runClass: state.runClass } : {}),
      ...(state.agentName ? { agentName: state.agentName } : {}),
      ...(state.orchestration ? { orchestration: cloneOrchestrationRoleDescriptor(state.orchestration) } : {}),
    };
    return {
      sessionId: state.sessionId,
      agentId: state.agentId,
      userId: state.userId,
      grantedCapabilities: [],
      message: {
        id: state.messageId?.trim() || requestId,
        userId: state.userId,
        principalId: state.principalId,
        principalRole: state.principalRole,
        channel: state.channel,
        ...(state.surfaceId ? { surfaceId: state.surfaceId } : {}),
        content: state.originalUserContent ?? '',
        timestamp: Date.now(),
      },
      systemPrompt: '',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      ...(state.executionProfile ? { executionProfile: cloneSelectedExecutionProfile(state.executionProfile) } : {}),
      delegation,
    };
  }

  private buildWorkerContinuationTraceTarget(
    state: WorkerApprovalContinuationTraceContext,
  ): ResolvedDelegatedTargetMetadata {
    return {
      agentId: state.agentId,
      ...(state.agentName ? { agentName: state.agentName } : {}),
      ...(state.orchestration ? { orchestration: cloneOrchestrationRoleDescriptor(state.orchestration) } : {}),
    };
  }

  private recordWorkerApprovalContinuationExecutionArtifacts(
    state: WorkerApprovalContinuationTraceContext,
    approvalId: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const request = this.buildWorkerContinuationTraceRequest(state, approvalId);
    const target = this.buildWorkerContinuationTraceTarget(state);
    const requestId = state.requestId?.trim() || request.delegation?.requestId || approvalId;
    const taskRunId = state.taskRunId?.trim() || `delegated-approval-continuation:${approvalId}`;
    this.recordDelegatedExecutionArtifacts(
      request,
      target,
      requestId,
      taskRunId,
      metadata,
    );
  }

}

function cloneOrchestrationRoleDescriptor(
  descriptor: OrchestrationRoleDescriptor | undefined,
): OrchestrationRoleDescriptor | undefined {
  if (!descriptor) return undefined;
  return {
    role: descriptor.role,
    ...(descriptor.label ? { label: descriptor.label } : {}),
    ...(descriptor.lenses?.length ? { lenses: [...descriptor.lenses] } : {}),
  };
}

function cloneSelectedExecutionProfile(profile: SelectedExecutionProfile): SelectedExecutionProfile {
  return {
    ...profile,
    fallbackProviderOrder: [...profile.fallbackProviderOrder],
  };
}

function truncateInlineText(value: string, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeDelegatedIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function describeDelegatedTarget(target: ResolvedDelegatedTargetMetadata): string {
  return normalizeDelegatedIdentityValue(target.orchestration?.label)
    ?? normalizeDelegatedIdentityValue(target.agentName)
    ?? normalizeDelegatedIdentityValue(target.agentId)
    ?? 'Delegated worker';
}

function normalizeDelegatedProviderTier(value: SelectedExecutionProfile['providerTier'] | undefined): string | undefined {
  const normalized = normalizeDelegatedIdentityValue(value);
  return normalized ? normalized.replaceAll('_', '-') : undefined;
}

function describeDelegatedExecutionProfile(profile: SelectedExecutionProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const profileName = normalizeDelegatedIdentityValue(profile.providerName)
    ?? normalizeDelegatedIdentityValue(profile.providerType);
  const modelName = normalizeDelegatedIdentityValue(profile.providerModel);
  const tier = normalizeDelegatedProviderTier(profile.providerTier);
  if (!profileName && !modelName) return undefined;
  if (!profileName) {
    return modelName ? `model ${modelName}` : undefined;
  }
  const base = tier ? `${tier} profile ${profileName}` : `profile ${profileName}`;
  return modelName && modelName !== profileName ? `${base} (${modelName})` : base;
}

function buildDelegatedExecutionProfileMetadata(
  profile: SelectedExecutionProfile | undefined,
): Pick<DelegatedWorkerProgressEvent, 'executionProfileName' | 'executionProfileModel' | 'executionProfileTier'> {
  const executionProfileName = normalizeDelegatedIdentityValue(profile?.providerName);
  const executionProfileModel = normalizeDelegatedIdentityValue(profile?.providerModel);
  const executionProfileTier = normalizeDelegatedProviderTier(profile?.providerTier);
  return {
    ...(executionProfileName ? { executionProfileName } : {}),
    ...(executionProfileModel ? { executionProfileModel } : {}),
    ...(executionProfileTier ? { executionProfileTier } : {}),
  };
}

function buildDelegatedExecutionProfileTraceMetadata(
  profile: SelectedExecutionProfile | undefined,
): Record<string, unknown> {
  return {
    ...buildDelegatedExecutionProfileMetadata(profile),
    ...(profile?.id ? { executionProfileId: profile.id } : {}),
    ...(profile?.providerLocality ? { executionProfileLocality: profile.providerLocality } : {}),
    ...(profile?.requestedTier ? { executionProfileRequestedTier: profile.requestedTier } : {}),
    ...(profile?.routingMode ? { executionProfileRoutingMode: profile.routingMode } : {}),
    ...(profile?.selectionSource ? { executionProfileSelectionSource: profile.selectionSource } : {}),
    ...(profile?.preferredAnswerPath ? { executionProfilePreferredAnswerPath: profile.preferredAnswerPath } : {}),
    ...(profile?.expectedContextPressure ? { executionProfileExpectedContextPressure: profile.expectedContextPressure } : {}),
    ...(typeof profile?.contextBudget === 'number' ? { executionProfileContextBudget: profile.contextBudget } : {}),
    ...(profile?.toolContextMode ? { executionProfileToolContextMode: profile.toolContextMode } : {}),
    ...(typeof profile?.maxAdditionalSections === 'number'
      ? { executionProfileMaxAdditionalSections: profile.maxAdditionalSections }
      : {}),
    ...(typeof profile?.maxRuntimeNotices === 'number'
      ? { executionProfileMaxRuntimeNotices: profile.maxRuntimeNotices }
      : {}),
    ...(profile?.reason ? { executionProfileReason: profile.reason } : {}),
  };
}

function buildDelegatedWorkerExecutionTraceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (!workerExecution) return {};
  return {
    workerExecutionSource: workerExecution.source,
    workerExecutionCompletionReason: workerExecution.completionReason,
    ...(workerExecution.responseQuality ? { workerExecutionResponseQuality: workerExecution.responseQuality } : {}),
    ...(workerExecution.terminationReason ? { workerExecutionTerminationReason: workerExecution.terminationReason } : {}),
    ...(workerExecution.blockerKind ? { workerExecutionBlockerKind: workerExecution.blockerKind } : {}),
    ...(typeof workerExecution.roundCount === 'number' ? { workerExecutionRoundCount: workerExecution.roundCount } : {}),
    ...(typeof workerExecution.toolCallCount === 'number'
      ? { workerExecutionToolCallCount: workerExecution.toolCallCount }
      : {}),
    ...(typeof workerExecution.toolResultCount === 'number'
      ? { workerExecutionToolResultCount: workerExecution.toolResultCount }
      : {}),
    ...(typeof workerExecution.successfulToolResultCount === 'number'
      ? { workerExecutionSuccessfulToolResultCount: workerExecution.successfulToolResultCount }
      : {}),
    ...(typeof workerExecution.pendingApprovalCount === 'number'
      ? { workerExecutionPendingApprovalCount: workerExecution.pendingApprovalCount }
      : {}),
  };
}

function buildDelegatedTaskContractTraceMetadata(
  taskContract: DelegatedResultEnvelope['taskContract'] | undefined,
): Record<string, unknown> {
  if (!taskContract) return {};
  const requiredSteps = taskContract.plan.steps.filter((step) => step.required);
  return {
    taskContractKind: taskContract.kind,
    ...(taskContract.route ? { taskContractRoute: taskContract.route } : {}),
    ...(taskContract.operation ? { taskContractOperation: taskContract.operation } : {}),
    taskContractRequiresEvidence: taskContract.requiresEvidence,
    taskContractAllowsAnswerFirst: taskContract.allowsAnswerFirst,
    taskContractRequireExactFileReferences: taskContract.requireExactFileReferences,
    ...(taskContract.summary ? { taskContractSummary: taskContract.summary } : {}),
    taskContractPlanId: taskContract.plan.planId,
    taskContractPlanStepCount: taskContract.plan.steps.length,
    taskContractPlanRequiredStepCount: requiredSteps.length,
    taskContractPlanStepIds: taskContract.plan.steps.map((step) => step.stepId),
    taskContractPlanStepKinds: taskContract.plan.steps.map((step) => step.kind),
    taskContractRequiredStepIds: requiredSteps.map((step) => step.stepId),
  };
}

function buildPromptAdditionalSectionTraceMetadata(
  sections: PromptAssemblyAdditionalSection[] | undefined,
): Record<string, unknown> {
  if (!Array.isArray(sections) || sections.length <= 0) {
    return {};
  }
  const codeSessionRegistrySection = sections.find((section) => section.section === 'Code Session Registry');
  return {
    promptAdditionalSectionCount: sections.length,
    promptAdditionalSectionNames: sections.map((section) => section.section),
    promptAdditionalSectionModes: sections.map((section) => section.mode ?? 'default'),
    ...(codeSessionRegistrySection
      ? {
          codeSessionRegistryAttached: true,
          ...(typeof codeSessionRegistrySection.itemCount === 'number'
            ? { codeSessionRegistryItemCount: codeSessionRegistrySection.itemCount }
            : {}),
        }
      : {}),
  };
}

function resolveDelegatedIntentContext(
  input: WorkerMessageRequest,
  target: ResolvedDelegatedTargetMetadata,
): {
  decision: IntentGatewayDecision | null;
  source: 'pre_routed' | 'delegated_derived' | 'unavailable';
} {
  const preRoutedDecision = readPreRoutedIntentGatewayMetadata(input.message.metadata)?.decision ?? null;
  const decision = resolveDelegatedExecutionDecision({
    gatewayDecision: preRoutedDecision,
    orchestration: target.orchestration,
    parentProfile: input.executionProfile,
  });
  return {
    decision,
    source: preRoutedDecision
      ? 'pre_routed'
      : decision
        ? 'delegated_derived'
        : 'unavailable',
  };
}

function buildDelegatedIntentTraceMetadata(
  context: ReturnType<typeof resolveDelegatedIntentContext>,
): Record<string, unknown> {
  const decision = context.decision;
  if (!decision) {
    return { delegatedIntentSource: context.source };
  }
  return {
    delegatedIntentSource: context.source,
    delegatedIntentRoute: decision.route,
    ...(decision.operation ? { delegatedIntentOperation: decision.operation } : {}),
    ...(decision.executionClass ? { delegatedIntentExecutionClass: decision.executionClass } : {}),
    ...(decision.preferredTier ? { delegatedIntentPreferredTier: decision.preferredTier } : {}),
    ...(typeof decision.requiresRepoGrounding === 'boolean'
      ? { delegatedIntentRequiresRepoGrounding: decision.requiresRepoGrounding }
      : {}),
    ...(typeof decision.requiresToolSynthesis === 'boolean'
      ? { delegatedIntentRequiresToolSynthesis: decision.requiresToolSynthesis }
      : {}),
    ...(decision.expectedContextPressure
      ? { delegatedIntentExpectedContextPressure: decision.expectedContextPressure }
      : {}),
    ...(decision.preferredAnswerPath
      ? { delegatedIntentPreferredAnswerPath: decision.preferredAnswerPath }
      : {}),
  };
}

function buildDelegatedHandoffTraceMetadata(
  handoff: DelegatedWorkerHandoff | undefined,
): Record<string, unknown> {
  if (!handoff) return {};
  return {
    ...(handoff.summary ? { handoffSummary: handoff.summary } : {}),
    ...(handoff.nextAction ? { handoffNextAction: handoff.nextAction } : {}),
    ...(handoff.operatorState ? { handoffOperatorState: handoff.operatorState } : {}),
  };
}

function describeDelegatedJob(
  input: WorkerMessageRequest,
  target: ResolvedDelegatedTargetMetadata,
): string {
  const codeSessionId = normalizeDelegatedIdentityValue(input.delegation?.codeSessionId);
  const profileLabel = describeDelegatedExecutionProfile(input.executionProfile);
  const base = profileLabel
    ? `Delegated to ${describeDelegatedTarget(target)} using ${profileLabel}`
    : `Delegated to ${describeDelegatedTarget(target)}`;
  return codeSessionId ? `${base} in code session ${codeSessionId}.` : `${base}.`;
}

function buildDelegatedTaskRunId(jobId: string): string {
  const normalized = String(jobId || '').trim();
  return normalized ? `delegated-task:${normalized}` : `delegated-task:${randomUUID()}`;
}

function buildDelegatedWorkerRunningDetail(
  targetLabel: string,
  executionProfile: SelectedExecutionProfile | undefined,
  codeSessionId?: string,
): string {
  const profileLabel = describeDelegatedExecutionProfile(executionProfile);
  const profileSuffix = profileLabel ? ` using ${profileLabel}` : '';
  const sessionSuffix = codeSessionId?.trim() ? ` in code session ${codeSessionId.trim()}` : '';
  return `${targetLabel} is working${profileSuffix}${sessionSuffix}.`;
}

function buildGraphMutationToolRequest(
  request: WorkerMessageRequest,
  requestId: string,
  codeContext: ToolExecutionRequest['codeContext'] | undefined,
  executionProfile: SelectedExecutionProfile | undefined,
): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
  return {
    origin: 'assistant',
    requestId,
    agentId: request.agentId,
    userId: request.userId,
    surfaceId: request.message.surfaceId,
    principalId: request.message.principalId ?? request.userId,
    principalRole: request.message.principalRole ?? 'owner',
    channel: request.message.channel,
    ...(codeContext ? { codeContext } : {}),
    toolContextMode: executionProfile?.toolContextMode,
    activeSkills: request.activeSkills?.map((skill) => skill.id) ?? [],
  };
}

function buildToolResultFromApprovalDecision(
  approvalId: string,
  result: ToolApprovalDecisionResult,
): Record<string, unknown> {
  const executionSucceeded = result.executionSucceeded
    ?? result.result?.success
    ?? (result.job?.status === 'succeeded');
  return {
    success: executionSucceeded === true,
    status: executionSucceeded === true ? 'succeeded' : (result.job?.status ?? 'failed'),
    approvalId,
    ...(result.job?.id ? { jobId: result.job.id } : {}),
    message: result.message,
    ...(result.result?.output !== undefined ? { output: result.result.output } : {}),
    ...(result.result?.error ? { error: result.result.error } : {}),
  };
}

function readExecutionGraphArtifactsFromMetadata(metadata: Record<string, unknown> | undefined): ExecutionArtifact[] {
  const artifacts = metadata?.executionGraphArtifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts
    .map((artifact) => normalizeExecutionArtifact(artifact))
    .filter((artifact): artifact is ExecutionArtifact => !!artifact);
}

function findStoredWriteSpecArtifact(input: {
  graphStore: Pick<ExecutionGraphStore, 'getArtifact' | 'listArtifacts'>;
  graphId: string;
  artifactIds: string[];
}): ExecutionArtifact<WriteSpecContent> | null {
  for (const artifactId of uniqueStrings(input.artifactIds)) {
    const artifact = input.graphStore.getArtifact(input.graphId, artifactId);
    if (isWriteSpecArtifact(artifact)) {
      return artifact;
    }
  }
  return input.graphStore.listArtifacts(input.graphId).find(isWriteSpecArtifact) ?? null;
}

function isWriteSpecArtifact(
  artifact: ExecutionArtifact | null | undefined,
): artifact is ExecutionArtifact<WriteSpecContent> {
  if (!artifact || artifact.artifactType !== 'WriteSpec') {
    return false;
  }
  const content = artifact.content as Partial<WriteSpecContent>;
  return content.operation === 'write_file'
    && typeof content.path === 'string'
    && typeof content.append === 'boolean'
    && typeof content.content === 'string'
    && typeof content.contentHash === 'string'
    && typeof content.contentBytes === 'number'
    && Array.isArray(content.sourceArtifactIds);
}

function normalizeExecutionArtifact(value: unknown): ExecutionArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.artifactId !== 'string'
    || typeof artifact.graphId !== 'string'
    || typeof artifact.nodeId !== 'string'
    || typeof artifact.artifactType !== 'string'
    || typeof artifact.label !== 'string'
    || typeof artifact.content !== 'object'
    || artifact.content === null
  ) {
    return null;
  }
  return artifact as unknown as ExecutionArtifact;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

const DELEGATED_JOB_DRAIN_DEADLINE_MS = 2500;
const DELEGATED_EVIDENCE_DRAIN_DEADLINE_MS = 60_000;
const DELEGATED_JOB_DRAIN_POLL_MS = 50;

async function awaitExtendedDelegatedEvidenceDrain(input: {
  tools: ToolExecutor;
  requestId: string;
  metadata: Record<string, unknown> | undefined;
  intentDecision: IntentGatewayDecision | undefined;
  executionProfile: SelectedExecutionProfile | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  decision: VerificationDecision;
  jobSnapshots: DelegatedJobSnapshot[];
}) {
  const workerExecution = readWorkerExecutionMetadata(input.metadata);
  if (isDelegatedWorkerBudgetExhausted(workerExecution?.terminationReason)) {
    return null;
  }
  if (!shouldExtendDelegatedEvidenceDrain({
    taskContract: input.taskContract,
    decision: input.decision,
    jobSnapshots: input.jobSnapshots,
  })) {
    return null;
  }
  const drain = await awaitPendingDelegatedJobs(
    input.tools,
    input.requestId,
    DELEGATED_EVIDENCE_DRAIN_DEADLINE_MS,
  );
  const verifiedResult = verifyDelegatedWorkerResult({
    metadata: input.metadata,
    intentDecision: input.intentDecision,
    executionProfile: input.executionProfile,
    taskContract: input.taskContract,
    jobSnapshots: drain.snapshots,
  });
  return {
    jobSnapshots: drain.snapshots,
    waitedMs: drain.waitedMs,
    inFlightRemaining: drain.inFlightRemaining,
    verifiedResult,
    insufficiency: buildDelegatedRetryableFailure(verifiedResult.decision, verifiedResult.envelope),
  };
}

async function awaitPendingDelegatedJobs(
  tools: ToolExecutor,
  requestId: string,
  deadlineMs: number = DELEGATED_JOB_DRAIN_DEADLINE_MS,
): Promise<{ snapshots: DelegatedJobSnapshot[]; waitedMs: number; inFlightRemaining: number }> {
  const start = Date.now();
  let snapshots = listDelegatedRequestJobSnapshots(tools, requestId);
  while (Date.now() - start < deadlineMs) {
    const inFlight = snapshots.filter((snapshot) => isDelegatedJobInFlight(snapshot.status));
    if (inFlight.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, DELEGATED_JOB_DRAIN_POLL_MS));
    snapshots = listDelegatedRequestJobSnapshots(tools, requestId);
  }
  const inFlightRemaining = snapshots.filter((snapshot) => isDelegatedJobInFlight(snapshot.status)).length;
  return {
    snapshots,
    waitedMs: Date.now() - start,
    inFlightRemaining,
  };
}

function listDelegatedRequestJobSnapshots(
  tools: ToolExecutor,
  requestId: string,
): DelegatedJobSnapshot[] {
  if (!requestId || typeof (tools as { listJobs?: unknown }).listJobs !== 'function') {
    return [];
  }
  return tools.listJobs(DELEGATED_REQUEST_JOB_LOOKUP_LIMIT)
    .filter((job) => job.requestId === requestId)
    .slice(0, DELEGATED_REQUEST_JOB_SNAPSHOT_LIMIT)
    .map((job) => ({
      id: job.id,
      toolName: job.toolName,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      argsPreview: job.argsPreview,
      resultPreview: job.resultPreview,
      error: job.error,
    }));
}

function attachDelegatedVerificationDecision(
  envelope: DelegatedResultEnvelope,
  decision: VerificationDecision,
  timestamp: number,
): DelegatedResultEnvelope {
  const verificationEvent: ExecutionEvent = {
    eventId: `verification:${decision.decision}`,
    type: 'verification_decided',
    timestamp,
    payload: {
      decision: decision.decision,
      reasons: [...decision.reasons],
      retryable: decision.retryable,
      ...(decision.requiredNextAction ? { requiredNextAction: decision.requiredNextAction } : {}),
      ...(decision.missingEvidenceKinds ? { missingEvidenceKinds: [...decision.missingEvidenceKinds] } : {}),
      ...(decision.unsatisfiedStepIds ? { unsatisfiedStepIds: [...decision.unsatisfiedStepIds] } : {}),
      ...(decision.qualityNotes ? { qualityNotes: [...decision.qualityNotes] } : {}),
      summary: decision.reasons[0] ?? 'Verification completed.',
    },
  };
  return {
    ...envelope,
    verification: {
      ...decision,
      reasons: [...decision.reasons],
      ...(decision.missingEvidenceKinds ? { missingEvidenceKinds: [...decision.missingEvidenceKinds] } : {}),
      ...(decision.unsatisfiedStepIds ? { unsatisfiedStepIds: [...decision.unsatisfiedStepIds] } : {}),
      ...(decision.qualityNotes ? { qualityNotes: [...decision.qualityNotes] } : {}),
    },
    events: [
      ...envelope.events.filter((event) => event.type !== 'verification_decided'),
      verificationEvent,
    ],
  };
}

function sanitizeDelegatedEnvelopeForOperator(
  envelope: DelegatedResultEnvelope,
): DelegatedResultEnvelope {
  return {
    ...envelope,
    events: envelope.events.map((event) => {
      if (!('traceResultPreview' in event.payload)) {
        return event;
      }
      const { traceResultPreview: _traceResultPreview, ...payload } = event.payload;
      return {
        ...event,
        payload,
      };
    }),
  };
}

function appendPromptAdditionalSection(
  sections: PromptAssemblyAdditionalSection[],
  extraSection: PromptAssemblyAdditionalSection | null,
): PromptAssemblyAdditionalSection[] {
  if (!extraSection) {
    return [...sections];
  }
  if (sections.some((section) => section.section === extraSection.section)) {
    return [...sections];
  }
  return [...sections, extraSection];
}

function mapExecutionEventToTraceStage(
  type: ExecutionEvent['type'],
): Extract<
  IntentRoutingTraceStage,
  | 'delegated_tool_call_started'
  | 'delegated_tool_call_completed'
  | 'delegated_interruption_requested'
  | 'delegated_interruption_resolved'
  | 'delegated_claim_emitted'
  | 'delegated_verification_decided'
> {
  switch (type) {
    case 'tool_call_started':
      return 'delegated_tool_call_started';
    case 'tool_call_completed':
      return 'delegated_tool_call_completed';
    case 'interruption_requested':
      return 'delegated_interruption_requested';
    case 'interruption_resolved':
      return 'delegated_interruption_resolved';
    case 'claim_emitted':
      return 'delegated_claim_emitted';
    case 'verification_decided':
    default:
      return 'delegated_verification_decided';
  }
}

function buildDelegatedExecutionEventPreview(event: ExecutionEvent): string | undefined {
  const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName.trim() : '';
  const stepId = typeof event.payload.stepId === 'string' ? event.payload.stepId.trim() : '';
  const summary = typeof event.payload.summary === 'string' ? event.payload.summary.trim() : '';
  const prompt = typeof event.payload.prompt === 'string' ? event.payload.prompt.trim() : '';
  if (toolName && stepId) return `${stepId}: ${toolName}`;
  if (toolName) return toolName;
  if (stepId && summary) return `${stepId}: ${truncateInlineText(summary, 220) ?? summary}`;
  if (stepId) return stepId;
  if (summary) return truncateInlineText(summary, 220);
  if (prompt) return truncateInlineText(prompt, 220);
  return undefined;
}

function selectDelegatedRetryExecutionProfile(
  runtime: Runtime,
  target: ResolvedDelegatedTargetMetadata,
  intentDecision: IntentGatewayDecision | undefined,
  currentProfile: SelectedExecutionProfile | undefined,
  insufficiency?: DelegatedResultSufficiencyFailure,
): SelectedExecutionProfile | null {
  const config = runtime.getConfigSnapshot?.();
  if (!config) return currentProfile ?? null;
  if (insufficiency && isDelegatedToolEvidenceRetry(insufficiency)) {
    const sibling = selectManagedCloudSiblingDelegatedExecutionProfile({
      config,
      currentProfile,
      parentProfile: currentProfile,
      gatewayDecision: intentDecision,
      orchestration: target.orchestration,
      mode: currentProfile?.routingMode,
    });
    if (sibling) {
      return sibling;
    }
  }
  const escalated = selectEscalatedDelegatedExecutionProfile({
    config,
    currentProfile,
    parentProfile: currentProfile,
    gatewayDecision: intentDecision,
    orchestration: target.orchestration,
    mode: currentProfile?.routingMode,
  });
  return escalated ?? currentProfile ?? null;
}

function readDelegatedAgentId(metadata: Record<string, unknown> | undefined): string | undefined {
  const delegation = metadata?.delegation;
  if (!isRecord(delegation)) return undefined;
  const agentId = delegation.agentId;
  return typeof agentId === 'string' && agentId.trim().length > 0 ? agentId : undefined;
}

function resolveDelegatedTargetMetadata(
  runtime: Runtime,
  input: WorkerMessageRequest,
): ResolvedDelegatedTargetMetadata {
  const registeredAgent = runtime.registry?.get?.(input.agentId);
  const explicitOrchestration = normalizeOrchestrationRoleDescriptor(input.delegation?.orchestration);
  const registeredOrchestration = normalizeOrchestrationRoleDescriptor(registeredAgent?.definition?.orchestration);
  const agentName = input.delegation?.agentName?.trim() || registeredAgent?.agent?.name?.trim();
  return {
    agentId: input.agentId,
    ...(agentName ? { agentName } : {}),
    ...(explicitOrchestration ?? registeredOrchestration
      ? { orchestration: explicitOrchestration ?? registeredOrchestration }
      : {}),
  };
}

function resolveDelegatedExecutionIdentity(
  input: WorkerMessageRequest,
  taskRunId?: string,
): {
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
} {
  const executionId = normalizeDelegatedIdentityValue(input.delegation?.executionId)
    ?? normalizeDelegatedIdentityValue(input.delegation?.requestId)
    ?? normalizeDelegatedIdentityValue(input.message.id);
  const rootExecutionId = normalizeDelegatedIdentityValue(input.delegation?.rootExecutionId)
    ?? executionId;
  const taskExecutionId = normalizeDelegatedIdentityValue(taskRunId);
  return {
    ...(executionId ? { executionId } : {}),
    ...(rootExecutionId ? { rootExecutionId } : {}),
    ...(taskExecutionId ? { taskExecutionId } : {}),
  };
}

function buildDelegatedAuditDetails(
  input: WorkerMessageRequest,
  target: ResolvedDelegatedTargetMetadata,
  requestId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const delegatedExecution = resolveDelegatedExecutionIdentity(input);
  const delegatedIntent = resolveDelegatedIntentContext(input, target);
  return {
    sessionId: input.sessionId,
    requestId,
    ...(delegatedExecution.executionId ? { executionId: delegatedExecution.executionId } : {}),
    ...(delegatedExecution.rootExecutionId ? { rootExecutionId: delegatedExecution.rootExecutionId } : {}),
    ...(input.delegation?.continuityKey ? { continuityKey: input.delegation.continuityKey } : {}),
    ...(input.delegation?.codeSessionId ? { codeSessionId: input.delegation.codeSessionId } : {}),
    ...buildDelegatedIntentTraceMetadata(delegatedIntent),
    ...extra,
  };
}

function buildDelegationJobMetadata(
  input: WorkerMessageRequest,
  options: {
    lifecycle: 'running' | 'completed' | 'blocked' | 'failed';
    workerId?: string;
    handoff?: DelegatedWorkerHandoff;
    target?: ResolvedDelegatedTargetMetadata;
    executionGraph?: DelegatedWorkerGraphJobMetadata;
  },
): Record<string, unknown> {
  const delegatedExecution = resolveDelegatedExecutionIdentity(input);
  const executionProfileMetadata = buildDelegatedExecutionProfileMetadata(input.executionProfile);
  return {
    kind: 'brokered_worker',
    lifecycle: options.lifecycle,
    agentId: options.target?.agentId ?? input.agentId,
    ...(options.target?.agentName ? { agentName: options.target.agentName } : {}),
    ...(options.target?.orchestration ? { orchestration: options.target.orchestration } : {}),
    workerSessionId: input.sessionId,
    originChannel: input.delegation?.originChannel ?? input.message.channel,
    runClass: normalizeDelegatedWorkerRunClass(input.delegation?.runClass),
    ...(delegatedExecution.executionId ? { executionId: delegatedExecution.executionId } : {}),
    ...(delegatedExecution.rootExecutionId ? { rootExecutionId: delegatedExecution.rootExecutionId } : {}),
    ...(input.delegation?.originSurfaceId ? { originSurfaceId: input.delegation.originSurfaceId } : {}),
    ...(input.delegation?.requestId ? { requestId: input.delegation.requestId } : {}),
    ...(input.delegation?.continuityKey ? { continuityKey: input.delegation.continuityKey } : {}),
    ...(input.delegation?.activeExecutionRefs?.length ? { activeExecutionRefs: [...input.delegation.activeExecutionRefs] } : {}),
    ...(input.delegation?.pendingActionId ? { pendingActionId: input.delegation.pendingActionId } : {}),
    ...(input.delegation?.codeSessionId ? { codeSessionId: input.delegation.codeSessionId } : {}),
    ...(Object.keys(executionProfileMetadata).length > 0
      ? { executionProfile: executionProfileMetadata }
      : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.handoff ? { handoff: options.handoff } : {}),
    ...(options.executionGraph ? { executionGraph: options.executionGraph } : {}),
  };
}

function resolveWorkerLaunch(configuredEntryPoint?: string): {
  command: string;
  args: string[];
  additionalReadPaths: string[];
} {
  const resolvedEntry = configuredEntryPoint?.trim()
    ? resolve(configuredEntryPoint)
    : resolveDefaultWorkerEntry();
  const additionalReadPaths = new Set<string>([
    resolveWorkerRuntimeRoot(resolvedEntry),
    resolveWorkerRuntimeRoot(workerManagerDir),
  ]);
  const extension = extname(resolvedEntry);
  if (extension === '.ts') {
    const tsxLoaderPath = resolve(workerManagerDir, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const tsxImportTarget = existsSync(tsxLoaderPath) ? pathToFileURL(tsxLoaderPath).href : 'tsx';
    if (tsxImportTarget !== 'tsx') {
      additionalReadPaths.add(resolveWorkerRuntimeRoot(tsxLoaderPath));
    }
    return {
      command: process.execPath,
      args: ['--import', tsxImportTarget, resolvedEntry],
      additionalReadPaths: [...additionalReadPaths],
    };
  }
  return {
    command: process.execPath,
    args: [resolvedEntry],
    additionalReadPaths: [...additionalReadPaths],
  };
}

function resolveDefaultWorkerEntry(): string {
  if (workerManagerPath.endsWith('.ts')) {
    return resolve(workerManagerDir, '..', 'worker', 'worker-entry.ts');
  }
  return resolve(workerManagerDir, '..', 'worker', 'worker-entry.js');
}

function resolveWorkerRuntimeRoot(pathValue: string): string {
  const resolvedPath = resolve(pathValue);
  let current = resolvedPath;
  try {
    current = statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
  } catch {
    current = extname(resolvedPath) ? dirname(resolvedPath) : resolvedPath;
  }

  const packageRoot = findNearestPackageRoot(current);
  if (packageRoot) return packageRoot;

  let cursor = current;
  while (true) {
    const base = dirname(cursor);
    if (base === cursor) break;
    const segment = basename(cursor);
    if (segment === 'src' || segment === 'dist') {
      return base;
    }
    cursor = base;
  }

  return current;
}

function findNearestPackageRoot(startDir: string): string | null {
  let cursor = resolve(startDir);
  while (true) {
    if (existsSync(join(cursor, 'package.json'))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

function mergeUniquePaths(...groups: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const pathValue of group ?? []) {
      const trimmed = pathValue?.trim();
      if (!trimmed) continue;
      merged.add(resolve(trimmed));
    }
  }
  return [...merged];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
