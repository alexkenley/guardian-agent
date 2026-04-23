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
import {
  attachPreRoutedIntentGatewayMetadata,
  readPreRoutedIntentGatewayMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRecord,
} from '../runtime/intent-gateway.js';
import type { IntentRoutingTraceLog, IntentRoutingTraceStage } from '../runtime/intent-routing-trace.js';
import type { DelegatedWorkerProgressEvent, RunTimelineStore } from '../runtime/run-timeline.js';
import { readWorkerExecutionMetadata } from '../runtime/worker-execution-metadata.js';
import {
  buildDelegatedExecutionMetadata,
  buildDelegatedSyntheticEnvelope,
  readDelegatedResultEnvelope,
  readExecutionEvents,
} from '../runtime/execution/metadata.js';
import {
  buildStepReceipts,
  collectMissingEvidenceKinds,
  filterDependencySatisfiedStepReceipts,
  matchPlannedStepForTool,
  readUnsatisfiedRequiredSteps,
} from '../runtime/execution/task-plan.js';
import {
  buildDelegatedTaskContract,
  verifyDelegatedResult,
} from '../runtime/execution/verifier.js';
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

function clonePlannedStepsFromTaskContract(
  taskContract: DelegatedResultEnvelope['taskContract'],
): NonNullable<IntentGatewayDecision['plannedSteps']> | undefined {
  if (taskContract.plan.steps.length <= 0) {
    return undefined;
  }
  return taskContract.plan.steps.map((step) => ({
    kind: step.kind,
    summary: step.summary,
    ...(step.expectedToolCategories?.length
      ? { expectedToolCategories: [...step.expectedToolCategories] }
      : {}),
    ...(step.required === false ? { required: false } : {}),
    ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
  }));
}

function shouldAdoptDelegatedTaskContract(
  current: DelegatedResultEnvelope['taskContract'],
  candidate: DelegatedResultEnvelope['taskContract'],
): boolean {
  if (candidate.plan.steps.length <= 0) {
    return false;
  }
  if (current.kind !== candidate.kind) {
    return false;
  }
  if (current.route && candidate.route && current.route !== candidate.route) {
    return false;
  }
  if (current.operation && candidate.operation && current.operation !== candidate.operation) {
    return false;
  }
  return candidate.plan.planId !== current.plan.planId
    || candidate.plan.steps.length !== current.plan.steps.length
    || candidate.plan.steps.some((step, index) => {
      const currentStep = current.plan.steps[index];
      return !currentStep
        || currentStep.kind !== step.kind
        || currentStep.summary !== step.summary;
    })
    || ((candidate.summary?.trim() ?? '') !== (current.summary?.trim() ?? ''));
}

function buildDelegatedRetryIntentGatewayRecord(input: {
  baseRecord: IntentGatewayRecord | null | undefined;
  baseDecision: IntentGatewayDecision | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
}): IntentGatewayRecord | null {
  const plannedSteps = clonePlannedStepsFromTaskContract(input.taskContract);
  if (!plannedSteps || plannedSteps.length <= 0) {
    return input.baseRecord ?? null;
  }
  const baseDecision = input.baseDecision ?? input.baseRecord?.decision;
  if (!baseDecision) {
    return input.baseRecord ?? null;
  }
  return {
    mode: input.baseRecord?.mode ?? 'confirmation',
    available: input.baseRecord?.available ?? true,
    model: input.baseRecord?.model ?? 'delegated.retry',
    latencyMs: input.baseRecord?.latencyMs ?? 0,
    ...(input.baseRecord?.promptProfile ? { promptProfile: input.baseRecord.promptProfile } : {}),
    decision: {
      ...baseDecision,
      ...(input.taskContract.route ? { route: input.taskContract.route as IntentGatewayDecision['route'] } : {}),
      ...(input.taskContract.operation ? { operation: input.taskContract.operation as IntentGatewayDecision['operation'] } : {}),
      ...(input.taskContract.summary?.trim() ? { summary: input.taskContract.summary.trim() } : {}),
      plannedSteps,
    },
  };
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
  runTimeline?: Pick<RunTimelineStore, 'ingestDelegatedWorkerProgress' | 'ingestDelegatedExecutionEvents'>;
  now?: () => number;
}

interface ResolvedDelegatedTargetMetadata {
  agentId: string;
  agentName?: string;
  orchestration?: OrchestrationRoleDescriptor;
}

interface DelegatedResultSufficiencyFailure {
  decision: VerificationDecision;
  failureSummary: string;
  retryReason: string;
  unsatisfiedSteps: Array<{
    stepId: string;
    summary: string;
    status: 'missing' | 'failed' | 'blocked';
    reason?: string;
  }>;
  satisfiedSteps: Array<{
    stepId: string;
    summary: string;
    refs?: string[];
  }>;
}

interface DelegatedJobSnapshot {
  id: string;
  toolName: string;
  status: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
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
    const taskContract = buildDelegatedTaskContract(
      effectiveIntentDecision ?? undefined,
    );
    let effectiveTaskContract = taskContract;

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
      // LLM calls are proxied through the broker — the worker no longer needs the provider config.
      // We only tell the worker whether a fallback provider exists for quality-based retry.
      const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.agentId);
      const additionalSections = appendPromptAdditionalSection(
        input.additionalSections ?? [],
        this.buildCodeSessionRegistrySection(input),
      );
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
      if (insufficiency) {
        const retryProfile = selectDelegatedRetryExecutionProfile(
          this.runtime,
          delegatedTarget,
          effectiveIntentDecision ?? undefined,
          effectiveExecutionProfile,
        );
        if (retryProfile) {
          const retryUsesSameProfile = isSameExecutionProfile(retryProfile, effectiveExecutionProfile);
          const retryDetail = buildDelegatedRetryDetail(
            describeDelegatedTarget(delegatedTarget),
            retryProfile,
            insufficiency,
            input.delegation?.codeSessionId,
          );
          const retryAdditionalSections = appendDelegatedRetrySection(
            baseDispatchParams.additionalSections,
            insufficiency,
            { sameProfile: retryUsesSameProfile },
          );
          effectiveExecutionProfile = retryProfile;
          const retryGatewayRecord = buildDelegatedRetryIntentGatewayRecord({
            baseRecord: preRoutedGateway,
            baseDecision: effectiveIntentDecision ?? undefined,
            taskContract: effectiveTaskContract,
          });
          effectiveInput = {
            ...input,
            ...(effectiveExecutionProfile === input.executionProfile
              ? {}
              : { executionProfile: effectiveExecutionProfile }),
            message: {
              ...input.message,
              metadata: attachPreRoutedIntentGatewayMetadata(
                input.message.metadata,
                retryGatewayRecord,
              ),
            },
          };
          this.recordDelegatedWorkerTrace('delegated_worker_retrying', effectiveInput, delegatedTarget, {
            requestId,
            taskRunId: delegatedTaskRunId,
            lifecycle: 'running',
            workerId: worker.id,
            taskContract: effectiveTaskContract,
            additionalSections: retryAdditionalSections,
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
            message: effectiveInput.message,
            systemPrompt: effectiveInput.systemPrompt,
            history: effectiveInput.history,
            knowledgeBases: effectiveInput.knowledgeBases ?? [],
            activeSkills: effectiveInput.activeSkills ?? [],
            toolContext: effectiveInput.toolContext ?? '',
            runtimeNotices: effectiveInput.runtimeNotices ?? [],
            additionalSections: retryAdditionalSections,
            executionProfile: retryProfile,
            continuity: effectiveInput.continuity,
            pendingAction: effectiveInput.pendingAction,
            pendingApprovalNotice: effectiveInput.pendingApprovalNotice,
            priorSatisfiedStepReceipts: filterDependencySatisfiedStepReceipts(
              effectiveTaskContract.plan,
              verifiedResult.envelope.stepReceipts,
            ),
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

    const jobSnapshots = typeof (this.tools as { listJobs?: unknown }).listJobs === 'function'
      ? this.tools.listJobs(100)
        .filter((job) => job.requestId === requestId)
        .slice(0, 12)
        .map((job) => ({
          jobId: job.id,
          toolName: job.toolName,
          status: job.status,
          argsPreview: job.argsPreview,
          resultPreview: job.resultPreview,
          error: job.error,
        }))
      : [];

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
      priorSatisfiedStepReceipts?: DelegatedResultEnvelope['stepReceipts'];
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
      priorSatisfiedStepReceipts?: DelegatedResultEnvelope['stepReceipts'];
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
  options?: { sameProfile?: boolean },
): PromptAssemblyAdditionalSection[] {
  const retryInstruction = options?.sameProfile
    ? 'Retry this once now on the same execution profile, but follow the corrective directive strictly instead of repeating the broad search.'
    : 'Retry this once now using the stronger execution profile.';
  const missingEvidenceKinds = insufficiency.decision.missingEvidenceKinds ?? [];
  const unsatisfiedLines = insufficiency.unsatisfiedSteps.length > 0
    ? insufficiency.unsatisfiedSteps.map((step) => buildDelegatedRetryStepLine(step))
    : ['- none recorded'];
  const satisfiedSummary = insufficiency.satisfiedSteps.length > 0
    ? insufficiency.satisfiedSteps.map((step) => `${step.stepId} (${step.summary})`).join('; ')
    : 'none';
  const satisfiedRefLines = insufficiency.satisfiedSteps
    .filter((step) => Array.isArray(step.refs) && step.refs.length > 0)
    .map((step) => `- ${step.stepId}: ${step.refs?.join(', ')}`);
  if (missingEvidenceKinds.includes('execution_evidence')) {
    return [
      ...sections,
      {
        section: 'Delegated Retry Directive',
        mode: 'plain',
        content: [
          'The previous delegated attempt was not sufficient for the user request.',
          `Failure mode: ${insufficiency.failureSummary}`,
          'Unsatisfied required steps:',
          ...unsatisfiedLines,
          `Already satisfied steps: ${satisfiedSummary}`,
          ...(satisfiedRefLines.length > 0
            ? [
                'Grounded file/path candidates from already satisfied steps:',
                ...satisfiedRefLines,
                'Reuse those grounded candidates before starting any new speculative search.',
              ]
            : []),
          retryInstruction,
          'Discovering or listing tools does not satisfy an execution request.',
          'If you used find_tools to load code_remote_exec or another execution tool, call that tool in this retry.',
          'Complete the remaining required steps now. Do not re-run satisfied steps.',
          'Do not ask the user whether to proceed when the original request already told you to run the command or verification step.',
          'Only pause if a real tool result returns pending_approval or another real blocker.',
        ].join('\n'),
      },
    ];
  }
  return [
    ...sections,
    {
      section: 'Delegated Retry Directive',
      mode: 'plain',
      content: [
        'The previous delegated attempt was not sufficient for the user request.',
        `Failure mode: ${insufficiency.failureSummary}`,
        'Unsatisfied required steps:',
        ...unsatisfiedLines,
        `Already satisfied steps: ${satisfiedSummary}`,
        ...(satisfiedRefLines.length > 0
          ? [
              'Grounded file/path candidates from already satisfied steps:',
              ...satisfiedRefLines,
              'Reuse those grounded candidates before starting any new speculative search.',
            ]
          : []),
        retryInstruction,
        'Complete the remaining required steps now. Do not re-run satisfied steps.',
        'Do not ask the user whether to narrow the search. Narrow it yourself.',
        'Use targeted repo inspection and return exact file paths or exact file citations in the final answer.',
        'Do not invent filenames or sibling paths after an ENOENT or a failed read/list call.',
        'Only read or cite paths that came from successful fs_search/fs_list/code_symbol_search results or successful fs_read results.',
        'If you are about to conclude that an implementation path does not exist, enumerate likely directories with fs_list first instead of relying on content search alone.',
        'If a search result is truncated or only reports that matches exist, immediately narrow the scope with fs_list/fs_search/fs_read until you can cite the exact files.',
        'If a later answer step depended on the missing grounding step, redo that answer after you finish the remaining grounding work.',
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

function buildDelegatedRetryableFailure(
  decision: VerificationDecision,
  envelope: DelegatedResultEnvelope,
): DelegatedResultSufficiencyFailure | null {
  if (!decision.retryable) return null;
  if (decision.decision !== 'insufficient' && decision.decision !== 'contradicted') return null;
  const unsatisfiedSteps = collectDelegatedUnsatisfiedSteps(envelope, decision);
  const satisfiedSteps = collectDelegatedSatisfiedSteps(envelope);
  return {
    decision,
    failureSummary: decision.reasons[0]?.trim() || 'Delegated worker did not satisfy the task contract.',
    retryReason: buildDelegatedRetryReason(decision, unsatisfiedSteps),
    unsatisfiedSteps,
    satisfiedSteps,
  };
}

function buildDelegatedRetryReason(
  decision: VerificationDecision,
  unsatisfiedSteps: DelegatedResultSufficiencyFailure['unsatisfiedSteps'],
): string {
  if (unsatisfiedSteps.length > 0) {
    return `required steps remain unsatisfied (${formatDelegatedStepIds(unsatisfiedSteps.map((step) => step.stepId))})`;
  }
  const missingEvidenceKinds = decision.missingEvidenceKinds ?? [];
  if (missingEvidenceKinds.includes('file_reference_claim')) {
    return 'the previous answer did not name the exact files or code paths that were requested';
  }
  if (missingEvidenceKinds.includes('implementation_file_claim')) {
    return 'the previous answer did not identify the actual implementation files for the requested functionality';
  }
  if (missingEvidenceKinds.includes('symbol_reference_claim')) {
    return 'the previous answer did not reference the requested function or type names';
  }
  if (missingEvidenceKinds.includes('readonly_violation')) {
    return 'the previous attempt modified files when the request specified read-only inspection';
  }
  if (missingEvidenceKinds.includes('filesystem_mutation_receipt')) {
    return 'the previous attempt claimed a filesystem change without producing a successful tool result or a real blocker';
  }
  if (missingEvidenceKinds.includes('execution_evidence')) {
    return 'the previous attempt did not actually execute the requested command or verification step';
  }
  if (missingEvidenceKinds.includes('repo_evidence')) {
    return 'the previous attempt answered without collecting successful repo evidence';
  }
  if (missingEvidenceKinds.includes('security_evidence')) {
    return 'the previous attempt answered without collecting successful security evidence';
  }
  if (missingEvidenceKinds.includes('delegated_result_envelope')) {
    return 'the previous attempt did not return the typed delegated result envelope required by the protocol';
  }
  return decision.reasons[0]?.trim().toLowerCase()
    || 'the previous attempt did not satisfy the delegated task contract';
}

function collectDelegatedUnsatisfiedSteps(
  envelope: DelegatedResultEnvelope,
  decision: VerificationDecision,
): DelegatedResultSufficiencyFailure['unsatisfiedSteps'] {
  const stepById = new Map(envelope.taskContract.plan.steps.map((step) => [step.stepId, step]));
  const receiptByStepId = new Map(envelope.stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  const evidenceById = new Map(envelope.evidenceReceipts.map((receipt) => [receipt.receiptId, receipt]));
  const unsatisfiedStepIds = decision.unsatisfiedStepIds?.length
    ? [...new Set(decision.unsatisfiedStepIds)]
    : readUnsatisfiedRequiredSteps(
        envelope.taskContract.plan,
        envelope.stepReceipts,
      ).map((step) => step.stepId);

  return unsatisfiedStepIds.map((stepId) => {
    const step = stepById.get(stepId);
    const receipt = receiptByStepId.get(stepId);
    const evidenceReason = receipt?.evidenceReceiptIds
      .map((receiptId) => evidenceById.get(receiptId)?.summary?.trim())
      .find((summary): summary is string => !!summary);
    const fallbackReason = receipt?.summary?.trim();
    return {
      stepId,
      summary: step?.summary ?? fallbackReason ?? stepId,
      status: receipt?.status === 'blocked'
        ? 'blocked'
        : receipt?.status === 'failed'
          ? 'failed'
          : 'missing',
      ...(evidenceReason || fallbackReason
        ? { reason: evidenceReason ?? fallbackReason }
        : {}),
    };
  });
}

function collectDelegatedSatisfiedSteps(
  envelope: DelegatedResultEnvelope,
): DelegatedResultSufficiencyFailure['satisfiedSteps'] {
  const stepById = new Map(envelope.taskContract.plan.steps.map((step) => [step.stepId, step]));
  const evidenceById = new Map(envelope.evidenceReceipts.map((receipt) => [receipt.receiptId, receipt]));
  return filterDependencySatisfiedStepReceipts(
    envelope.taskContract.plan,
    envelope.stepReceipts,
  )
    .map((receipt) => ({
      stepId: receipt.stepId,
      summary: stepById.get(receipt.stepId)?.summary ?? receipt.summary,
      refs: dedupeDelegatedRetryRefs(
        receipt.evidenceReceiptIds.flatMap((receiptId) => evidenceById.get(receiptId)?.refs ?? []),
      ),
    }));
}

function dedupeDelegatedRetryRefs(refs: string[]): string[] {
  const deduped = new Set<string>();
  for (const ref of refs) {
    const normalized = typeof ref === 'string'
      ? ref.trim().replace(/\\/g, '/')
      : '';
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
    if (deduped.size >= 8) {
      break;
    }
  }
  return [...deduped];
}

function buildDelegatedRetryStepLine(
  step: DelegatedResultSufficiencyFailure['unsatisfiedSteps'][number],
): string {
  const reasonSuffix = step.reason?.trim() ? ` (${step.reason.trim()})` : '';
  return `- ${step.stepId}: ${step.summary} [${step.status}]${reasonSuffix}`;
}

function formatDelegatedStepIds(stepIds: string[]): string {
  return stepIds.join(', ');
}

function verifyDelegatedWorkerResult(input: {
  metadata: Record<string, unknown> | undefined;
  intentDecision: IntentGatewayDecision | undefined;
  executionProfile: SelectedExecutionProfile | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobSnapshots: DelegatedJobSnapshot[];
}): {
  envelope: DelegatedResultEnvelope;
  decision: VerificationDecision;
} {
  const envelope = readDelegatedResultEnvelope(input.metadata);
  if (!envelope) {
    const workerExecution = readWorkerExecutionMetadata(input.metadata);
    const partialEnvelope = buildSyntheticDelegatedEnvelopeFromJobs({
      taskContract: input.taskContract,
      jobSnapshots: input.jobSnapshots,
      workerExecution,
    });
    if (partialEnvelope) {
      return {
        envelope: partialEnvelope,
        decision: verifyDelegatedResult({
          envelope: partialEnvelope,
          gatewayDecision: input.intentDecision,
          executionProfile: input.executionProfile,
        }),
      };
    }
    const missingReason = describeMissingDelegatedEnvelope(workerExecution);
    const stepReceipts = buildStepReceipts({
      plannedTask: input.taskContract.plan,
      evidenceReceipts: [],
      interruptions: [],
    });
    return {
      envelope: buildDelegatedSyntheticEnvelope({
        taskContract: input.taskContract,
        runStatus: 'failed',
        stopReason: 'error',
        operatorSummary: missingReason,
        stepReceipts,
      }),
      decision: {
        decision: 'contradicted',
        reasons: [missingReason],
        retryable: false,
        requiredNextAction: 'Inspect the delegated worker failure details before retrying.',
        missingEvidenceKinds: [
          'delegated_result_envelope',
          ...collectMissingEvidenceKinds(input.taskContract.plan, stepReceipts),
        ],
        unsatisfiedStepIds: input.taskContract.plan.steps
          .filter((step) => step.required !== false)
          .map((step) => step.stepId),
      },
    };
  }
  return {
    envelope,
    decision: verifyDelegatedResult({
      envelope,
      gatewayDecision: input.intentDecision,
      executionProfile: input.executionProfile,
    }),
  };
}

function buildSyntheticDelegatedEnvelopeFromJobs(input: {
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobSnapshots: DelegatedJobSnapshot[];
  workerExecution: ReturnType<typeof readWorkerExecutionMetadata>;
}): DelegatedResultEnvelope | null {
  const hasInFlightJobs = input.jobSnapshots.some((snapshot) => isDelegatedJobInFlight(snapshot.status));
  const hasToolActivity = (input.workerExecution?.toolCallCount ?? 0) > 0
    || (input.workerExecution?.toolResultCount ?? 0) > 0
    || (input.workerExecution?.roundCount ?? 0) > 0
    || input.jobSnapshots.length > 0;
  const terminationReason = input.workerExecution?.terminationReason;
  const budgetExhausted = terminationReason === 'max_rounds'
    || terminationReason === 'max_wall_clock'
    || terminationReason === 'watchdog_kill';
  if (!budgetExhausted && !hasInFlightJobs && !hasToolActivity) {
    return null;
  }
  const synthesized = synthesizeDelegatedEvidenceReceiptsFromJobs(input.taskContract, input.jobSnapshots);
  return buildDelegatedSyntheticEnvelope({
    taskContract: input.taskContract,
    runStatus: budgetExhausted ? 'max_turns' : 'incomplete',
    stopReason: budgetExhausted ? 'max_rounds' : 'error',
    operatorSummary: budgetExhausted
      ? 'Delegated worker exhausted its step budget before returning a typed result envelope.'
      : 'Delegated worker stopped after partial progress before returning a typed result envelope.',
    evidenceReceipts: synthesized.evidenceReceipts,
    stepReceipts: synthesized.stepReceipts,
  });
}

function synthesizeDelegatedEvidenceReceiptsFromJobs(
  taskContract: DelegatedResultEnvelope['taskContract'],
  jobSnapshots: DelegatedJobSnapshot[],
): {
  evidenceReceipts: DelegatedResultEnvelope['evidenceReceipts'];
  stepReceipts: DelegatedResultEnvelope['stepReceipts'];
} {
  const evidenceReceipts: DelegatedResultEnvelope['evidenceReceipts'] = [];
  const toolReceiptStepIds = new Map<string, string>();
  const previouslyMatchedStepIds = new Set<string>();
  const sortedSnapshots = [...jobSnapshots].sort((left, right) => (
    (left.startedAt ?? left.createdAt ?? 0) - (right.startedAt ?? right.createdAt ?? 0)
  ));
  for (const snapshot of sortedSnapshots) {
    const receiptStatus = mapDelegatedJobSnapshotToEvidenceStatus(snapshot.status);
    if (!receiptStatus) continue;
    const args = parseDelegatedJobArgsPreview(snapshot.argsPreview);
    const matchedStepId = matchPlannedStepForTool({
      toolName: snapshot.toolName,
      args,
      plannedTask: taskContract.plan,
      previouslyMatchedStepIds,
    });
    if (matchedStepId) {
      previouslyMatchedStepIds.add(matchedStepId);
    }
    const receiptId = `job:${snapshot.id}`;
    if (matchedStepId) {
      toolReceiptStepIds.set(receiptId, matchedStepId);
    }
    evidenceReceipts.push({
      receiptId,
      sourceType: 'tool_call',
      toolName: snapshot.toolName,
      status: receiptStatus,
      refs: [],
      summary: snapshot.error?.trim()
        || snapshot.resultPreview?.trim()
        || `${snapshot.toolName} ${snapshot.status}.`,
      startedAt: snapshot.startedAt ?? snapshot.createdAt ?? 0,
      endedAt: snapshot.completedAt ?? snapshot.startedAt ?? snapshot.createdAt ?? 0,
    });
  }
  return {
    evidenceReceipts,
    stepReceipts: buildStepReceipts({
      plannedTask: taskContract.plan,
      evidenceReceipts,
      toolReceiptStepIds,
      interruptions: [],
    }),
  };
}

const DELEGATED_JOB_DRAIN_DEADLINE_MS = 2500;
const DELEGATED_JOB_DRAIN_POLL_MS = 50;

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
  return tools.listJobs(100)
    .filter((job) => job.requestId === requestId)
    .slice(0, 24)
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

function describeMissingDelegatedEnvelope(
  workerExecution: ReturnType<typeof readWorkerExecutionMetadata>,
): string {
  switch (workerExecution?.terminationReason) {
    case 'disconnect':
      return 'Delegated worker disconnected before returning a typed result envelope.';
    case 'provider_error':
      return 'Delegated worker hit a provider error before returning a typed result envelope.';
    case 'max_rounds':
    case 'max_wall_clock':
    case 'watchdog_kill':
      return 'Delegated worker stopped before returning a typed result envelope.';
    default:
      return 'Delegated worker did not return a typed result envelope.';
  }
}

function isDelegatedJobInFlight(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'queued'
    || normalized === 'running'
    || normalized === 'pending'
    || normalized === 'starting';
}

function mapDelegatedJobSnapshotToEvidenceStatus(
  status: string | undefined,
): DelegatedResultEnvelope['evidenceReceipts'][number]['status'] | null {
  switch (status?.trim().toLowerCase()) {
    case 'succeeded':
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'error':
    case 'canceled':
    case 'cancelled':
      return 'failed';
    case 'pending_approval':
      return 'pending_approval';
    case 'blocked':
      return 'blocked';
    default:
      return null;
  }
}

function parseDelegatedJobArgsPreview(argsPreview: string | undefined): Record<string, unknown> {
  if (typeof argsPreview !== 'string' || !argsPreview.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(argsPreview) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
): SelectedExecutionProfile | null {
  const config = runtime.getConfigSnapshot?.();
  if (!config) return currentProfile ?? null;
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

function isSameExecutionProfile(
  left: SelectedExecutionProfile | undefined,
  right: SelectedExecutionProfile | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftId = typeof left.id === 'string' ? left.id.trim() : '';
  const rightId = typeof right.id === 'string' ? right.id.trim() : '';
  if (leftId && rightId && leftId === rightId) return true;
  return left.providerName === right.providerName
    && left.providerModel === right.providerModel
    && left.providerTier === right.providerTier
    && left.providerLocality === right.providerLocality;
}

function readApprovalSummaryCount(metadata: Record<string, unknown> | undefined): number {
  const approvalInterruption = readDelegatedApprovalInterruption(metadata);
  if (approvalInterruption) {
    return approvalInterruption.approvalSummaries?.length ?? 0;
  }
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
  const interruptionKind = readDelegatedInterruptionKind(metadata);
  if (interruptionKind) {
    return interruptionKind;
  }
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (workerExecution?.blockerKind?.trim()) {
    return workerExecution.blockerKind.trim();
  }
  const pendingAction = metadata?.pendingAction;
  if (!isRecord(pendingAction) || !isRecord(pendingAction.blocker)) return undefined;
  const kind = pendingAction.blocker.kind;
  return typeof kind === 'string' && kind.trim() ? kind.trim() : undefined;
}

function resolveDelegatedWorkerLifecycle(
  metadata: Record<string, unknown> | undefined,
  unresolvedBlockerKind?: string,
  verification?: VerificationDecision,
): 'completed' | 'blocked' | 'failed' {
  if (verification) {
    if (verification.decision === 'blocked' || verification.decision === 'policy_blocked') {
      return 'blocked';
    }
    if (verification.decision === 'insufficient' || verification.decision === 'contradicted') {
      return 'failed';
    }
    if (verification.decision === 'satisfied') {
      return 'completed';
    }
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
  verification?: VerificationDecision,
): string | undefined {
  if (verification && verification.decision !== 'satisfied' && verification.decision !== 'blocked') {
    return verification.reasons[0]
      ?? verification.requiredNextAction
      ?? 'Delegated worker did not satisfy the task contract.';
  }
  const delegatedEnvelope = readDelegatedResultEnvelope(metadata);
  if (delegatedEnvelope) {
    if (delegatedEnvelope.runStatus === 'max_turns') {
      return 'Delegated worker ran out of turns before satisfying every required step.';
    }
    if (delegatedEnvelope.runStatus === 'incomplete') {
      const unsatisfied = delegatedEnvelope.stepReceipts
        .filter((receipt) => receipt.status !== 'satisfied')
        .map((receipt) => receipt.stepId);
      return unsatisfied.length > 0
        ? `Delegated worker stopped before satisfying required steps: ${formatDelegatedStepIds(unsatisfied)}.`
        : 'Delegated worker stopped before satisfying the task contract.';
    }
    if (delegatedEnvelope.runStatus === 'failed' && delegatedEnvelope.stopReason === 'error') {
      return 'Delegated worker failed before satisfying the required steps.';
    }
  }
  const workerExecution = readWorkerExecutionMetadata(metadata);
  if (!workerExecution || workerExecution.lifecycle !== 'failed') {
    return undefined;
  }
  if (workerExecution.completionReason === 'phantom_approval_response') {
    return 'Delegated worker claimed approval was required without creating a real approval request.';
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
  verification?: VerificationDecision,
): DelegatedWorkerHandoff {
  const unresolvedBlockerKind = resolveDelegatedBlockedKind(metadata, verification);
  const lifecycle = resolveDelegatedWorkerLifecycle(metadata, unresolvedBlockerKind, verification);
  const summary = buildDelegatedFailureSummary(content, metadata, verification)
    ?? truncateInlineText(content, 220)
    ?? (lifecycle === 'failed' ? 'Delegated worker failed.' : 'Delegated worker completed.');
  const approvalCount = readApprovalSummaryCount(metadata);
  const runClass = normalizeDelegatedRunClass(runClassInput);
  let nextAction = verification?.requiredNextAction ?? 'Result returned inline to the original conversation.';
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
  } else if (unresolvedBlockerKind === 'policy_blocked') {
    nextAction = verification?.requiredNextAction ?? 'Resolve the policy blocker before retrying.';
    reportingMode = 'status_only';
  } else if (lifecycle === 'failed') {
    nextAction = verification?.requiredNextAction ?? 'Inspect the delegated worker failure details before retrying.';
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
    ...(verification?.qualityNotes && verification.qualityNotes.length > 0
      ? { qualityNotes: verification.qualityNotes }
      : {}),
  };
}

function applyDelegatedFollowUpPolicy(
  result: { content: string; metadata?: Record<string, unknown> },
  handoff: DelegatedWorkerHandoff,
  verification?: VerificationDecision,
): { content: string; metadata?: Record<string, unknown> } {
  const lifecycle = resolveDelegatedWorkerLifecycle(result.metadata, handoff.unresolvedBlockerKind, verification);
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
    // Surface quality notes as a suffix when the verification is satisfied
    // but the answer has potential quality caveats
    const qualitySuffix = (handoff.qualityNotes && handoff.qualityNotes.length > 0)
      ? `\n\n⚠️ ${handoff.qualityNotes.join(' ')}`
      : '';
    return {
      content: qualitySuffix ? `${result.content}${qualitySuffix}` : result.content,
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
      : handoff.unresolvedBlockerKind === 'policy_blocked'
        ? 'Delegated work is paused: policy blocker must be resolved.'
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
  const interruptionPrompt = readDelegatedInterruptionPrompt(metadata);
  if (interruptionPrompt) {
    return interruptionPrompt;
  }
  const pendingAction = metadata?.pendingAction;
  if (!isRecord(pendingAction) || !isRecord(pendingAction.blocker)) return undefined;
  const prompt = pendingAction.blocker.prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
}

function resolveDelegatedBlockedKind(
  metadata: Record<string, unknown> | undefined,
  verification?: VerificationDecision,
): string | undefined {
  if (verification?.decision === 'policy_blocked') {
    return 'policy_blocked';
  }
  return readPendingActionKind(metadata);
}

function readDelegatedApprovalInterruption(
  metadata: Record<string, unknown> | undefined,
): DelegatedResultEnvelope['interruptions'][number] | undefined {
  return readDelegatedResultEnvelope(metadata)?.interruptions.find((interruption) => interruption.kind === 'approval');
}

function readDelegatedInterruptionKind(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const interruption = readDelegatedResultEnvelope(metadata)?.interruptions[0];
  if (!interruption) {
    return undefined;
  }
  switch (interruption.kind) {
    case 'approval':
    case 'clarification':
    case 'workspace_switch':
      return interruption.kind;
    case 'policy_blocked':
      return 'policy_blocked';
    default:
      return undefined;
  }
}

function readDelegatedInterruptionPrompt(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const prompt = readDelegatedResultEnvelope(metadata)?.interruptions[0]?.prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
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
