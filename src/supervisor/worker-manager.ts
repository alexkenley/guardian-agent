import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxedSpawn, detectSandboxHealth, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { createLogger } from '../util/logging.js';
import { BrokerServer } from '../broker/broker-server.js';
import { CapabilityTokenManager } from '../broker/capability-token.js';
import type { ToolExecutor } from '../tools/executor.js';
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
import { formatPendingApprovalMessage } from '../runtime/pending-approval-copy.js';
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
  type SelectedExecutionProfile,
} from '../runtime/execution-profiles.js';
import { readPreRoutedIntentGatewayMetadata, type IntentGatewayDecision } from '../runtime/intent-gateway.js';
import type { IntentRoutingTraceLog, IntentRoutingTraceStage } from '../runtime/intent-routing-trace.js';
import type { DelegatedWorkerProgressEvent, RunTimelineStore } from '../runtime/run-timeline.js';
import { readWorkerExecutionMetadata } from '../runtime/worker-execution-metadata.js';

const log = createLogger('worker-manager');
const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;
const WORKER_WORKSPACE_CLEANUP_MAX_RETRIES = 10;
const WORKER_WORKSPACE_CLEANUP_RETRY_DELAY_MS = 100;
const EXACT_FILE_REQUEST_PATTERN = /\b(?:which\s+files?|what\s+files?|exact\s+files?|exact\s+file\s+paths?|cite\s+the\s+exact\s+files?)\b/i;
const IMPLEMENTATION_LOOKUP_PATTERN = /\b(?:implement|implements|implemented|define|defines|render|rendering|path|paths)\b/i;
const FILE_REFERENCE_PATTERN = /\b(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|rs|py|go|java|kt|swift|rb|php|css|html)\b|\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|rs|py|go|java|kt|swift|rb|php|css|html)\b/i;
const INSUFFICIENT_RESULT_PATTERNS = [
  /\btruncated\b/i,
  /\b(?:cannot|can't)\s+(?:give|cite|identify|provide)\b.*\b(?:exact\s+files?|file\s+paths?)\b/i,
  /\bsearch(?:es)?\s+came\s+back\s+empty\b/i,
  /\bneed(?:ed)?\s+to\b.*\b(?:targeted|narrower|broader)\s+search/i,
  /\bwould\s+you\s+like\s+me\s+to\s+run\b/i,
  /\bdon't\s+have\s+enough\s+evidence\b/i,
];

const workerManagerPath = fileURLToPath(import.meta.url);
const workerManagerDir = dirname(workerManagerPath);

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
  runTimeline?: Pick<RunTimelineStore, 'ingestDelegatedWorkerProgress'>;
  now?: () => number;
}

interface ResolvedDelegatedTargetMetadata {
  agentId: string;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
}

interface DelegatedEvidenceContractContext {
  kind: 'repo_grounded' | 'filesystem_mutation' | 'security_analysis';
  failureSummary: string;
}

interface DelegatedResultSufficiencyFailure {
  kind: 'exact_file_references' | 'terminal_result';
  failureSummary: string;
  retryReason: string;
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

interface DirectAutomationContinuation {
  request: WorkerMessageRequest;
  pendingApprovalIds: string[];
  expiresAt: number;
}

interface WorkerSuspendedApprovalState {
  workerId: string;
  workerSessionKey: string;
  sessionId: string;
  agentId: string;
  userId: string;
  principalId: string;
  principalRole: NonNullable<UserMessage['principalRole']>;
  channel: string;
  approvalIds: string[];
  expiresAt: number;
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
  private readonly directPendingApprovals = new Map<string, { ids: string[]; expiresAt: number }>();
  private readonly directAutomationContinuations = new Map<string, DirectAutomationContinuation>();
  private readonly workerSuspendedApprovalsBySession = new Map<string, WorkerSuspendedApprovalState>();
  private readonly workerSuspendedApprovalToSession = new Map<string, string>();
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
    const canDirectAutomation = intentDecision?.route === 'automation_authoring'
      && ['create', 'update', 'schedule'].includes(intentDecision.operation);
    if (canDirectAutomation) {
      const directAutomation = await this.tryDirectAutomationAuthoring(input, {
        assumeAuthoring: true,
        intentDecision,
      });
      if (directAutomation) return directAutomation;
    }

    const requestId = input.delegation?.requestId ?? input.message.id;
    const delegatedJobDetail = describeDelegatedJob(input, delegatedTarget);
    const evidenceContract = buildDelegatedEvidenceContractContext(input, effectiveIntentDecision ?? undefined);

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
          }),
        },
      });
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

      // LLM calls are proxied through the broker — the worker no longer needs the provider config.
      // We only tell the worker whether a fallback provider exists for quality-based retry.
      const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.agentId);
      const baseDispatchParams = {
        message: input.message,
        systemPrompt: input.systemPrompt,
        history: input.history,
        knowledgeBases: input.knowledgeBases ?? [],
        activeSkills: input.activeSkills ?? [],
        additionalSections: input.additionalSections ?? [],
        toolContext: input.toolContext ?? '',
        runtimeNotices: input.runtimeNotices ?? [],
        executionProfile: input.executionProfile,
        continuity: input.continuity,
        pendingAction: input.pendingAction,
        pendingApprovalNotice: input.pendingApprovalNotice,
        hasFallbackProvider,
      };
      let effectiveInput = input;
      let effectiveExecutionProfile = input.executionProfile;
      let result = await this.dispatchToWorker(worker, baseDispatchParams);
      let insufficiency = assessDelegatedResultSufficiency(
        input,
        result.content,
        result.metadata,
        effectiveIntentDecision ?? undefined,
      );
      if (insufficiency) {
        const retryProfile = selectDelegatedRetryExecutionProfile(
          this.runtime,
          delegatedTarget,
          effectiveIntentDecision ?? undefined,
          effectiveExecutionProfile,
        );
        if (retryProfile) {
          const retryDetail = buildDelegatedRetryDetail(
            describeDelegatedTarget(delegatedTarget),
            retryProfile,
            insufficiency,
            input.delegation?.codeSessionId,
          );
          effectiveExecutionProfile = retryProfile;
          effectiveInput = effectiveExecutionProfile === input.executionProfile
            ? input
            : { ...input, executionProfile: effectiveExecutionProfile };
          this.recordDelegatedWorkerTrace('delegated_worker_retrying', effectiveInput, delegatedTarget, {
            requestId,
            taskRunId: delegatedTaskRunId,
            lifecycle: 'running',
            workerId: worker.id,
            reason: retryDetail,
          });
          this.publishDelegatedWorkerProgress(effectiveInput, delegatedTarget, {
            id: `delegated-worker:${delegatedJob.id}:retrying`,
            kind: 'running',
            requestId,
            taskRunId: delegatedTaskRunId,
            workerId: worker.id,
            detail: retryDetail,
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
            additionalSections: appendDelegatedRetrySection(
              baseDispatchParams.additionalSections,
              insufficiency,
            ),
            executionProfile: retryProfile,
          });
          insufficiency = assessDelegatedResultSufficiency(
            input,
            result.content,
            result.metadata,
            effectiveIntentDecision ?? undefined,
          );
        }
      }
      const handoff = insufficiency
        ? buildDelegatedInsufficientResultHandoff(
          insufficiency,
          effectiveInput.delegation?.runClass,
        )
        : buildDelegatedHandoff(
          result.content,
          result.metadata,
          effectiveInput.delegation?.runClass,
          evidenceContract,
        );
      const lifecycle = insufficiency
        ? 'failed'
        : resolveDelegatedWorkerLifecycle(
          result.metadata,
          handoff.unresolvedBlockerKind,
          evidenceContract,
        );
      const normalizedResult = insufficiency
        ? {
            content: formatFailedDelegatedMessage(handoff),
            metadata: {
              ...(result.metadata ?? {}),
              delegatedHandoff: handoff,
              delegatedSufficiencyFailure: {
                kind: insufficiency.kind,
                reason: insufficiency.retryReason,
              },
            },
          }
        : applyDelegatedFollowUpPolicy(result, handoff, evidenceContract);
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
            }),
          },
        });
      this.recordDelegatedWorkerTrace('delegated_worker_failed', effectiveInput, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle,
        workerId: worker.id,
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
          }),
        },
      });
      this.recordDelegatedWorkerTrace('delegated_worker_completed', effectiveInput, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle,
        workerId: worker.id,
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
          }),
        },
      });
      this.recordDelegatedWorkerTrace('delegated_worker_failed', input, delegatedTarget, {
        requestId,
        taskRunId: delegatedTaskRunId,
        lifecycle: 'failed',
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
    >,
    input: WorkerMessageRequest,
    target: ResolvedDelegatedTargetMetadata,
    options: {
      requestId: string;
      taskRunId?: string;
      lifecycle?: 'running' | 'completed' | 'blocked' | 'failed';
      workerId?: string;
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

  shutdown(): void {
    clearInterval(this.reapInterval);
    for (const worker of this.workers.values()) {
      worker.status = 'shutting_down';
      this.safeKillWorker(worker);
      this.cleanupWorker(worker);
    }
    this.workers.clear();
    this.sessionToWorker.clear();
    this.directPendingApprovals.clear();
    this.directAutomationContinuations.clear();
    this.workerSuspendedApprovalsBySession.clear();
    this.workerSuspendedApprovalToSession.clear();
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
    const pendingIds = this.getDirectPendingApprovalIds(input.sessionId);
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

    const results: string[] = [];
    const approvedIds = new Set<string>();
    const failedIds = new Set<string>();
    for (const approvalId of targetIds) {
      const decided = await this.tools.decideApproval(
        approvalId,
        decision,
        input.message.principalId ?? input.message.userId,
        input.message.principalRole ?? 'owner',
      );
      const approvalGranted = decision === 'approved' && (decided.approved ?? decided.success);
      const executionFailed = approvalGranted && decided.executionSucceeded === false;
      if (approvalGranted) approvedIds.add(approvalId);
      if (!decided.success || executionFailed || (decision === 'approved' && !approvalGranted)) {
        failedIds.add(approvalId);
      }
      results.push(decided.message);
    }

    this.consumeDirectPendingApprovals(input.sessionId, targetIds);
    const continuation = this.getDirectAutomationContinuation(input.sessionId);
    if (continuation) {
      const affected = targetIds.filter((id) => continuation.pendingApprovalIds.includes(id));
      if (decision === 'approved' && affected.length > 0) {
        const resolvedIds = new Set(affected.filter((id) => approvedIds.has(id) || failedIds.has(id)));
        const stillPending = continuation.pendingApprovalIds.filter((id) => !resolvedIds.has(id));
        if (stillPending.length === 0) {
          if (affected.some((id) => failedIds.has(id))) {
            this.directAutomationContinuations.delete(input.sessionId);
          } else {
            this.directAutomationContinuations.delete(input.sessionId);
            const retry = await this.tryDirectAutomationAuthoring({
              ...continuation.request,
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
          this.directAutomationContinuations.set(input.sessionId, {
            ...continuation,
            pendingApprovalIds: stillPending,
          });
        }
      } else if (affected.length > 0 && (decision === 'denied' || affected.some((id) => failedIds.has(id)))) {
        this.directAutomationContinuations.delete(input.sessionId);
      }
    }
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
        const existingIds = this.getDirectPendingApprovalIds(input.sessionId);
        this.directPendingApprovals.set(input.sessionId, {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        });
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
      this.directAutomationContinuations.delete(input.sessionId);
      return null;
    }
    if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
      this.directAutomationContinuations.set(input.sessionId, {
        request: input,
        pendingApprovalIds: trackedPendingApprovalIds,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      });
    } else {
      this.directAutomationContinuations.delete(input.sessionId);
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

  private getDirectPendingApprovalIds(sessionId: string, nowMs: number = Date.now()): string[] {
    const pending = this.directPendingApprovals.get(sessionId);
    if (!pending) return [];
    if (pending.expiresAt <= nowMs) {
      this.directPendingApprovals.delete(sessionId);
      return [];
    }
    return [...pending.ids];
  }

  private consumeDirectPendingApprovals(sessionId: string, consumedIds: string[]): void {
    const pending = this.directPendingApprovals.get(sessionId);
    if (!pending) return;
    const remaining = pending.ids.filter((id) => !consumedIds.includes(id));
    if (remaining.length === 0) {
      this.directPendingApprovals.delete(sessionId);
      return;
    }
    this.directPendingApprovals.set(sessionId, {
      ids: remaining,
      expiresAt: pending.expiresAt,
    });
  }

  private getDirectAutomationContinuation(
    sessionId: string,
    nowMs: number = Date.now(),
  ): DirectAutomationContinuation | null {
    const continuation = this.directAutomationContinuations.get(sessionId);
    if (!continuation) return null;
    if (continuation.expiresAt <= nowMs) {
      this.directAutomationContinuations.delete(sessionId);
      return null;
    }
    return continuation;
  }

  hasAutomationApprovalContinuation(approvalId: string): boolean {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return false;
    for (const continuation of this.directAutomationContinuations.values()) {
      if (continuation.pendingApprovalIds.includes(normalizedId)) {
        return true;
      }
    }
    return false;
  }

  hasSuspendedApproval(approvalId: string): boolean {
    return !!this.getWorkerSuspendedApprovalState(approvalId);
  }

  resetPendingState(args: {
    userId: string;
    channel: string;
    approvalIds?: string[];
  }): void {
    const approvalIds = new Set((args.approvalIds ?? []).map((id) => id.trim()).filter(Boolean));
    for (const [sessionId, continuation] of this.directAutomationContinuations.entries()) {
      const matchesScope = continuation.request.userId === args.userId
        && continuation.request.message.channel === args.channel;
      const matchesApproval = continuation.pendingApprovalIds.some((id) => approvalIds.has(id));
      if (matchesScope || matchesApproval) {
        this.directAutomationContinuations.delete(sessionId);
      }
    }
    for (const [sessionId, pending] of this.directPendingApprovals.entries()) {
      if (pending.ids.some((id) => approvalIds.has(id))) {
        this.directPendingApprovals.delete(sessionId);
      }
    }
    for (const [workerSessionKey, state] of this.workerSuspendedApprovalsBySession.entries()) {
      const matchesScope = state.userId === args.userId && state.channel === args.channel;
      const matchesApproval = state.approvalIds.some((id) => approvalIds.has(id));
      if (matchesScope || matchesApproval) {
        this.clearWorkerSuspendedApprovals(workerSessionKey);
      }
    }
  }

  async continueAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resultMessage?: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return null;
    const workerContinuation = await this.continueWorkerAfterApproval(normalizedId, decision, resultMessage);
    if (workerContinuation) return workerContinuation;
    for (const [sessionId, continuation] of this.directAutomationContinuations.entries()) {
      if (!continuation.pendingApprovalIds.includes(normalizedId)) continue;
      if (decision !== 'approved') {
        this.directAutomationContinuations.delete(sessionId);
        return null;
      }
      const stillPending = continuation.pendingApprovalIds.filter((id) => id !== normalizedId);
      if (stillPending.length > 0) {
        this.directAutomationContinuations.set(sessionId, {
          ...continuation,
          pendingApprovalIds: stillPending,
        });
        return null;
      }
      this.directAutomationContinuations.delete(sessionId);
      return this.tryDirectAutomationAuthoring(continuation.request);
    }

    if (decision === 'approved') {
      for (const [sessionId, continuation] of this.directAutomationContinuations.entries()) {
        const livePendingIds = new Set(this.tools.listPendingApprovalIdsForUser?.(
          continuation.request.userId,
          continuation.request.message.channel,
          {
            includeUnscoped: continuation.request.message.channel === 'web',
            principalId: continuation.request.message.principalId ?? continuation.request.userId,
          },
        ) ?? []);
        const stillPending = continuation.pendingApprovalIds.filter((id) => livePendingIds.has(id));
        if (stillPending.length === 0) {
          this.directAutomationContinuations.delete(sessionId);
          return this.tryDirectAutomationAuthoring(continuation.request);
        }
        if (stillPending.length !== continuation.pendingApprovalIds.length) {
          this.directAutomationContinuations.set(sessionId, {
            ...continuation,
            pendingApprovalIds: stillPending,
          });
        }
      }
    }
    return null;
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
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    if (!this.workers.has(worker.id) || worker.status !== 'ready') {
      return Promise.reject(new Error('Worker is not available for dispatch'));
    }
    worker.lastActivityMs = Date.now();

    return new Promise((resolve, reject) => {
      worker.pendingMessageResolve = resolve;
      worker.pendingMessageReject = reject;

      const timeout = setTimeout(() => {
        if (worker.pendingMessageReject) {
          worker.pendingMessageReject(new Error('Worker message dispatch timed out'));
          worker.pendingMessageResolve = undefined;
          worker.pendingMessageReject = undefined;
        }
      }, 1800_000);

      const wrappedResolve = (value: { content: string; metadata?: Record<string, unknown> }) => {
        clearTimeout(timeout);
        this.syncWorkerSuspendedApprovals(worker, params.message, value.metadata);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      worker.pendingMessageResolve = wrappedResolve;
      worker.pendingMessageReject = wrappedReject;

      worker.brokerServer.sendNotification('message.handle', {
        ...params,
      });
    });
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
    this.clearWorkerSuspendedApprovals(worker.workerSessionKey);
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

  private syncWorkerSuspendedApprovals(
    worker: WorkerProcess,
    message: UserMessage,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const continueConversationAfterApproval = metadata?.continueConversationAfterApproval === true;
    const approvalIds = continueConversationAfterApproval
      ? extractPendingActionApprovalIds(metadata?.pendingAction)
      : [];
    this.clearWorkerSuspendedApprovals(worker.workerSessionKey);
    if (approvalIds.length === 0) return;
    this.setWorkerSuspendedApprovals({
      workerId: worker.id,
      workerSessionKey: worker.workerSessionKey,
      sessionId: worker.sessionId,
      agentId: worker.agentId,
      userId: message.userId,
      principalId: message.principalId ?? message.userId,
      principalRole: message.principalRole ?? 'owner',
      channel: message.channel,
      approvalIds: [...new Set(approvalIds)],
      expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
    });
  }

  private setWorkerSuspendedApprovals(state: WorkerSuspendedApprovalState): void {
    this.workerSuspendedApprovalsBySession.set(state.workerSessionKey, state);
    for (const approvalId of state.approvalIds) {
      this.workerSuspendedApprovalToSession.set(approvalId, state.workerSessionKey);
    }
  }

  private clearWorkerSuspendedApprovals(workerSessionKey: string): void {
    const existing = this.workerSuspendedApprovalsBySession.get(workerSessionKey);
    if (!existing) return;
    for (const approvalId of existing.approvalIds) {
      this.workerSuspendedApprovalToSession.delete(approvalId);
    }
    this.workerSuspendedApprovalsBySession.delete(workerSessionKey);
  }

  private getWorkerSuspendedApprovalState(
    approvalId: string,
    nowMs: number = Date.now(),
  ): WorkerSuspendedApprovalState | null {
    const workerSessionKey = this.workerSuspendedApprovalToSession.get(approvalId.trim());
    if (!workerSessionKey) return null;
    const state = this.workerSuspendedApprovalsBySession.get(workerSessionKey);
    if (!state) {
      this.workerSuspendedApprovalToSession.delete(approvalId.trim());
      return null;
    }
    if (state.expiresAt <= nowMs) {
      this.clearWorkerSuspendedApprovals(workerSessionKey);
      return null;
    }
    return state;
  }

  private async continueWorkerAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resultMessage?: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const state = this.getWorkerSuspendedApprovalState(approvalId);
    if (!state) return null;

    if (decision !== 'approved') {
      this.clearWorkerSuspendedApprovals(state.workerSessionKey);
      return null;
    }

    const pendingIds = new Set(this.tools.listApprovals(500, 'pending').map((entry) => entry.id));
    const remaining = state.approvalIds.filter((id) => id !== approvalId && pendingIds.has(id));
    if (remaining.length > 0) {
      this.clearWorkerSuspendedApprovals(state.workerSessionKey);
      this.setWorkerSuspendedApprovals({
        ...state,
        approvalIds: remaining,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      });
      return null;
    }

    const worker = this.workers.get(state.workerId);
    this.clearWorkerSuspendedApprovals(state.workerSessionKey);
    if (!worker || worker.status !== 'ready') return null;

    return this.dispatchToWorker(worker, {
      message: {
        id: randomUUID(),
        userId: state.userId,
        principalId: state.principalId,
        principalRole: state.principalRole,
        channel: state.channel,
        content: '',
        metadata: buildApprovalOutcomeContinuationMetadata({
          approvalId,
          decision,
          resultMessage,
        }),
        timestamp: Date.now(),
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
  }
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

function buildDelegatedRetryDetail(
  targetLabel: string,
  executionProfile: SelectedExecutionProfile | undefined,
  insufficiency: DelegatedResultSufficiencyFailure,
  codeSessionId?: string,
): string {
  const profileLabel = describeDelegatedExecutionProfile(executionProfile);
  const profileSuffix = profileLabel ? ` with ${profileLabel}` : '';
  const sessionSuffix = codeSessionId?.trim() ? ` in code session ${codeSessionId.trim()}` : '';
  return `Retrying ${targetLabel}${profileSuffix}${sessionSuffix} because ${insufficiency.retryReason}`;
}

function appendDelegatedRetrySection(
  sections: PromptAssemblyAdditionalSection[],
  insufficiency: DelegatedResultSufficiencyFailure,
): PromptAssemblyAdditionalSection[] {
  return [
    ...sections,
    {
      section: 'Delegated Retry Directive',
      mode: 'plain',
      content: [
        'The previous delegated attempt was not sufficient for the user request.',
        `Failure mode: ${insufficiency.failureSummary}`,
        'Retry this once now using the stronger execution profile.',
        'Do not ask the user whether to narrow the search. Narrow it yourself.',
        'Use targeted repo inspection and return exact file paths or exact file citations in the final answer.',
      ].join('\n'),
    },
  ];
}

function buildDelegatedInsufficientResultHandoff(
  insufficiency: DelegatedResultSufficiencyFailure,
  runClassInput?: DelegatedWorkerRunClass,
): DelegatedWorkerHandoff {
  return {
    summary: insufficiency.failureSummary,
    runClass: normalizeDelegatedRunClass(runClassInput),
    nextAction: 'Inspect the delegated worker failure details before retrying.',
    reportingMode: 'inline_response',
  };
}

function assessDelegatedResultSufficiency(
  input: WorkerMessageRequest,
  content: string,
  metadata: Record<string, unknown> | undefined,
  intentDecision: IntentGatewayDecision | undefined,
): DelegatedResultSufficiencyFailure | null {
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (!workerExecution) return null;
  if (
    workerExecution.completionReason === 'intermediate_response'
    || workerExecution.responseQuality === 'intermediate'
  ) {
    return {
      kind: 'terminal_result',
      failureSummary: 'Delegated worker returned a progress update instead of a terminal result.',
      retryReason: 'the previous attempt stopped at a progress update instead of completing the delegated task',
    };
  }
  if (!intentDecision || workerExecution.lifecycle !== 'completed') return null;
  if ((workerExecution.successfulToolResultCount ?? 0) <= 0) return null;
  if (!requestNeedsExactFileReferences(input.message.content, intentDecision)) return null;
  if (contentHasConcreteFileReferences(content)) return null;
  if (!contentSignalsInsufficientGroundedLookup(content)) return null;
  return {
    kind: 'exact_file_references',
    failureSummary: 'Delegated worker did not return the exact file references requested after repo inspection.',
    retryReason: 'the previous answer admitted truncation or uncertainty instead of naming the exact files',
  };
}

function requestNeedsExactFileReferences(
  requestText: string,
  intentDecision: IntentGatewayDecision,
): boolean {
  if (!(intentDecision.requiresRepoGrounding === true || intentDecision.executionClass === 'repo_grounded')) {
    return false;
  }
  if (!isReadOnlyFilesystemOperation(intentDecision.operation) && intentDecision.route !== 'coding_task' && intentDecision.route !== 'security_task') {
    return false;
  }
  return EXACT_FILE_REQUEST_PATTERN.test(requestText) && IMPLEMENTATION_LOOKUP_PATTERN.test(requestText);
}

function contentHasConcreteFileReferences(content: string): boolean {
  return FILE_REFERENCE_PATTERN.test(content);
}

function contentSignalsInsufficientGroundedLookup(content: string): boolean {
  const normalized = String(content ?? '');
  return INSUFFICIENT_RESULT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function selectDelegatedRetryExecutionProfile(
  runtime: Runtime,
  target: ResolvedDelegatedTargetMetadata,
  intentDecision: IntentGatewayDecision | undefined,
  currentProfile: SelectedExecutionProfile | undefined,
): SelectedExecutionProfile | null {
  const config = runtime.getConfigSnapshot?.();
  if (!config) return null;
  return selectEscalatedDelegatedExecutionProfile({
    config,
    currentProfile,
    parentProfile: currentProfile,
    gatewayDecision: intentDecision,
    orchestration: target.orchestration,
    mode: currentProfile?.routingMode,
  });
}

function readApprovalSummaryCount(metadata: Record<string, unknown> | undefined): number {
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (typeof workerExecution?.pendingApprovalCount === 'number') {
    return workerExecution.pendingApprovalCount;
  }
  const pendingAction = metadata?.pendingAction;
  if (!isRecord(pendingAction) || !isRecord(pendingAction.blocker) || !Array.isArray(pendingAction.blocker.approvalSummaries)) {
    return 0;
  }
  return pendingAction.blocker.approvalSummaries.length;
}

function readPendingActionKind(metadata: Record<string, unknown> | undefined): string | undefined {
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (workerExecution?.blockerKind?.trim()) {
    return workerExecution.blockerKind.trim();
  }
  const pendingAction = metadata?.pendingAction;
  if (!isRecord(pendingAction) || !isRecord(pendingAction.blocker)) return undefined;
  const kind = pendingAction.blocker.kind;
  return typeof kind === 'string' && kind.trim() ? kind.trim() : undefined;
}

function buildDelegatedEvidenceContractContext(
  input: WorkerMessageRequest,
  intentDecision: IntentGatewayDecision | undefined,
): DelegatedEvidenceContractContext | undefined {
  if (!intentDecision) return undefined;

  if (intentDecision.route === 'filesystem_task' && !isReadOnlyFilesystemOperation(intentDecision.operation)) {
    return {
      kind: 'filesystem_mutation',
      failureSummary: 'Delegated worker claimed a filesystem change without producing a successful tool result or a real blocker.',
    };
  }

  if (intentDecision.route === 'security_task' && (intentDecision.requiresRepoGrounding === true || hasDelegatedWorkspaceContext(input))) {
    return {
      kind: 'security_analysis',
      failureSummary: 'Delegated worker returned source-backed security findings without collecting successful tool results or evidence.',
    };
  }

  if (intentDecision.requiresRepoGrounding === true || intentDecision.executionClass === 'repo_grounded') {
    return {
      kind: 'repo_grounded',
      failureSummary: 'Delegated worker returned a repo-grounded answer without collecting successful tool results or evidence.',
    };
  }

  return undefined;
}

function resolveDelegatedWorkerLifecycle(
  metadata: Record<string, unknown> | undefined,
  unresolvedBlockerKind?: string,
  evidenceContract?: DelegatedEvidenceContractContext,
): 'completed' | 'blocked' | 'failed' {
  if (violatesDelegatedEvidenceContract(evidenceContract, metadata)) {
    return 'failed';
  }
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (workerExecution?.lifecycle) {
    return workerExecution.lifecycle;
  }
  return unresolvedBlockerKind ? 'blocked' : 'completed';
}

function buildDelegatedFailureSummary(
  content: string,
  metadata: Record<string, unknown> | undefined,
  evidenceContract?: DelegatedEvidenceContractContext,
): string | undefined {
  if (violatesDelegatedEvidenceContract(evidenceContract, metadata)) {
    return evidenceContract?.failureSummary;
  }
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (!workerExecution || workerExecution.lifecycle !== 'failed') {
    return undefined;
  }
  if (workerExecution.completionReason === 'phantom_approval_response') {
    return 'Delegated worker claimed approval was required without creating a real approval request.';
  }
  if (workerExecution.completionReason === 'intermediate_response' || workerExecution.responseQuality === 'intermediate') {
    return 'Delegated worker returned a progress update instead of a terminal result.';
  }
  if (
    workerExecution.completionReason === 'degraded_response'
    || workerExecution.completionReason === 'empty_response_fallback'
    || workerExecution.responseQuality === 'degraded'
  ) {
    return 'Delegated worker did not produce a usable terminal result.';
  }
  const summary = truncateInlineText(content, 220);
  return summary || 'Delegated worker failed.';
}

function buildDelegatedHandoff(
  content: string,
  metadata: Record<string, unknown> | undefined,
  runClassInput?: DelegatedWorkerRunClass,
  evidenceContract?: DelegatedEvidenceContractContext,
): DelegatedWorkerHandoff {
  const unresolvedBlockerKind = readPendingActionKind(metadata);
  const lifecycle = resolveDelegatedWorkerLifecycle(metadata, unresolvedBlockerKind, evidenceContract);
  const summary = buildDelegatedFailureSummary(content, metadata, evidenceContract)
    ?? truncateInlineText(content, 220)
    ?? (lifecycle === 'failed' ? 'Delegated worker failed.' : 'Delegated worker completed.');
  const approvalCount = readApprovalSummaryCount(metadata);
  const runClass = normalizeDelegatedRunClass(runClassInput);
  let nextAction = 'Result returned inline to the original conversation.';
  let reportingMode: DelegatedWorkerHandoff['reportingMode'] = 'inline_response';
  let operatorState: DelegatedWorkerHandoff['operatorState'] | undefined;

  if (unresolvedBlockerKind === 'approval') {
    nextAction = 'Resolve the pending approval(s) to continue the delegated run.';
    reportingMode = 'held_for_approval';
  } else if (unresolvedBlockerKind === 'clarification') {
    nextAction = 'Resolve the clarification to continue the delegated run.';
    reportingMode = 'status_only';
  } else if (unresolvedBlockerKind === 'workspace_switch') {
    nextAction = 'Switch to the requested coding workspace to continue the delegated run.';
    reportingMode = 'status_only';
  } else if (lifecycle === 'failed') {
    nextAction = 'Inspect the delegated worker failure details before retrying.';
  } else if (runClass === 'long_running' || runClass === 'automation_owned') {
    // TODO(background-delegation-uplift): Broaden run-class adoption beyond this brokered worker path,
    // define stronger per-class follow-up defaults, and extend this from bounded held-result handling
    // into richer long-running/background delegation behavior with better timeline/query visibility.
    nextAction = 'Replay or dismiss the held delegated result.';
    reportingMode = 'held_for_operator';
    operatorState = 'pending';
  }

  return {
    summary,
    ...(unresolvedBlockerKind ? { unresolvedBlockerKind } : {}),
    ...(approvalCount > 0 ? { approvalCount } : {}),
    runClass,
    nextAction,
    reportingMode,
    ...(operatorState ? { operatorState } : {}),
  };
}

function applyDelegatedFollowUpPolicy(
  result: { content: string; metadata?: Record<string, unknown> },
  handoff: DelegatedWorkerHandoff,
  evidenceContract?: DelegatedEvidenceContractContext,
): { content: string; metadata?: Record<string, unknown> } {
  const lifecycle = resolveDelegatedWorkerLifecycle(result.metadata, handoff.unresolvedBlockerKind, evidenceContract);
  const metadata: Record<string, unknown> = {
    ...(result.metadata ?? {}),
    delegatedHandoff: handoff,
  };

  if (lifecycle === 'failed') {
    return {
      content: formatFailedDelegatedMessage(handoff),
      metadata,
    };
  }

  if (handoff.reportingMode !== 'status_only') {
    if (handoff.reportingMode === 'held_for_operator') {
      return {
        content: formatHeldForOperatorDelegatedMessage(handoff),
        metadata,
      };
    }
    return {
      content: result.content,
      metadata,
    };
  }

  return {
    content: formatStatusOnlyDelegatedMessage(handoff, metadata),
    metadata,
  };
}

function formatStatusOnlyDelegatedMessage(
  handoff: DelegatedWorkerHandoff,
  metadata: Record<string, unknown>,
): string {
  const header = handoff.unresolvedBlockerKind === 'clarification'
    ? 'Delegated work is paused: clarification required.'
    : handoff.unresolvedBlockerKind === 'workspace_switch'
      ? 'Delegated work is paused: workspace switch required.'
      : 'Delegated work is paused.';
  const blockerPrompt = readPendingActionPrompt(metadata);
  const parts = [
    header,
    blockerPrompt,
    handoff.summary,
    handoff.nextAction,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(parts)].join('\n');
}

function formatHeldForOperatorDelegatedMessage(handoff: DelegatedWorkerHandoff): string {
  const parts = [
    'Delegated work completed and is held for operator review.',
    handoff.summary,
    handoff.nextAction,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(parts)].join('\n');
}

function formatFailedDelegatedMessage(handoff: DelegatedWorkerHandoff): string {
  const parts = [
    'Delegated work failed.',
    handoff.summary,
    handoff.nextAction,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(parts)].join('\n');
}

function readPendingActionPrompt(metadata: Record<string, unknown> | undefined): string | undefined {
  const pendingAction = metadata?.pendingAction;
  if (!isRecord(pendingAction) || !isRecord(pendingAction.blocker)) return undefined;
  const prompt = pendingAction.blocker.prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
}

function violatesDelegatedEvidenceContract(
  evidenceContract: DelegatedEvidenceContractContext | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!evidenceContract) {
    return false;
  }
  if (readPendingActionKind(metadata)) {
    return false;
  }
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (!workerExecution || workerExecution.lifecycle !== 'completed') {
    return false;
  }
  return (workerExecution.successfulToolResultCount ?? 0) <= 0;
}

function hasDelegatedWorkspaceContext(input: WorkerMessageRequest): boolean {
  if (normalizeDelegatedIdentityValue(input.delegation?.codeSessionId)) {
    return true;
  }
  return (input.delegation?.activeExecutionRefs ?? []).some((ref) =>
    typeof ref === 'string' && ref.trim().toLowerCase().startsWith('code_session:'));
}

function isReadOnlyFilesystemOperation(operation: IntentGatewayDecision['operation']): boolean {
  return operation === 'inspect' || operation === 'read' || operation === 'search';
}

function normalizeDelegatedRunClass(value: unknown): DelegatedWorkerRunClass {
  if (value === 'in_invocation' || value === 'short_lived' || value === 'long_running' || value === 'automation_owned') {
    return value;
  }
  return 'short_lived';
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
    runClass: normalizeDelegatedRunClass(input.delegation?.runClass),
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
    const tsxImportTarget = existsSync(tsxLoaderPath) ? tsxLoaderPath : 'tsx';
    if (tsxImportTarget !== 'tsx') {
      additionalReadPaths.add(resolveWorkerRuntimeRoot(tsxImportTarget));
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

function extractPendingActionApprovalIds(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.blocker)) return [];
  const approvalSummaries = value.blocker.approvalSummaries;
  if (!Array.isArray(approvalSummaries)) return [];
  return approvalSummaries
    .map((item) => isRecord(item) ? item.id : undefined)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
