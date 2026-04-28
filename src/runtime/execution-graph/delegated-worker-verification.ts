import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  buildDelegatedSyntheticEnvelope,
  readDelegatedResultEnvelope,
} from '../execution/metadata.js';
import {
  buildStepReceipts,
  collectMissingEvidenceKinds,
  computeWorkerRunStatus,
  matchPlannedStepForTool,
} from '../execution/task-plan.js';
import type {
  DelegatedResultEnvelope,
  ExecutionEvent,
  VerificationDecision,
} from '../execution/types.js';
import { verifyDelegatedResult } from '../execution/verifier.js';
import {
  readWorkerExecutionMetadata,
  type WorkerExecutionMetadata,
} from '../worker-execution-metadata.js';
import {
  buildDelegatedRetryableFailure,
  extractDelegatedEvidenceRefs,
  shouldAdoptDelegatedTaskContract,
  type DelegatedResultSufficiencyFailure,
} from './delegated-worker-retry.js';

const DELEGATED_REQUEST_JOB_LOOKUP_LIMIT = 500;
const DELEGATED_REQUEST_JOB_SNAPSHOT_LIMIT = 120;
const DELEGATED_JOB_DRAIN_DEADLINE_MS = 2500;
const DELEGATED_JOB_DRAIN_POLL_MS = 50;
const DELEGATED_EVIDENCE_DRAIN_DEADLINE_MS = 60_000;

export interface DelegatedJobSnapshot {
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

export interface DelegatedJobSnapshotSourceRecord {
  id: string;
  requestId?: string;
  toolName: string;
  status: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

export type DelegatedJobSnapshotLister = (
  limit: number,
) => readonly DelegatedJobSnapshotSourceRecord[];

export interface DelegatedWorkerVerificationInput {
  metadata: Record<string, unknown> | undefined;
  intentDecision: IntentGatewayDecision | undefined;
  executionProfile: SelectedExecutionProfile | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobSnapshots: DelegatedJobSnapshot[];
}

export interface DelegatedWorkerVerificationResult {
  envelope: DelegatedResultEnvelope;
  decision: VerificationDecision;
}

export interface DelegatedJobDrainResult {
  snapshots: DelegatedJobSnapshot[];
  waitedMs: number;
  inFlightRemaining: number;
}

export interface DelegatedRequestJobSnapshotInput {
  requestId: string;
  listJobs?: DelegatedJobSnapshotLister;
  lookupLimit?: number;
  snapshotLimit?: number;
}

export interface DelegatedRequestJobDrainInput extends DelegatedRequestJobSnapshotInput {
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface DelegatedEvidenceDrainExtensionTraceEvent {
  stage: 'delegated_job_wait_expired';
  details: {
    requestId: string;
    taskRunId: string;
    lifecycle: 'running';
    taskContract: DelegatedResultEnvelope['taskContract'];
    reason: string;
  };
}

export interface DelegatedEvidenceDrainExtensionResult {
  jobSnapshots: DelegatedJobSnapshot[];
  waitedMs: number;
  inFlightRemaining: number;
  verifiedResult: DelegatedWorkerVerificationResult;
  insufficiency: DelegatedResultSufficiencyFailure | null;
}

export interface DelegatedWorkerVerificationFinalizationInput {
  taskContract: DelegatedResultEnvelope['taskContract'];
  verifiedResult: DelegatedWorkerVerificationResult;
  timestamp: number;
}

export interface DelegatedWorkerVerificationFinalizationResult {
  verifiedEnvelope: DelegatedResultEnvelope;
  traceTaskContract: DelegatedResultEnvelope['taskContract'];
  traceReason: string;
  planDrift: boolean;
}

export interface DelegatedWorkerVerificationCycleInput {
  requestId: string;
  taskRunId: string;
  metadata: Record<string, unknown> | undefined;
  intentDecision: IntentGatewayDecision | undefined;
  executionProfile: SelectedExecutionProfile | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobSnapshots: DelegatedJobSnapshot[];
  attemptLabel?: string;
  drainPendingJobs: (deadlineMs: number) => Promise<DelegatedJobDrainResult>;
  trace?: (event: DelegatedEvidenceDrainExtensionTraceEvent) => void;
}

export interface DelegatedWorkerVerificationCycleResult {
  taskContract: DelegatedResultEnvelope['taskContract'];
  verifiedResult: DelegatedWorkerVerificationResult;
  insufficiency: DelegatedResultSufficiencyFailure | null;
  jobSnapshots: DelegatedJobSnapshot[];
  extendedDrain: DelegatedEvidenceDrainExtensionResult | null;
}

export function verifyDelegatedWorkerResult(
  input: DelegatedWorkerVerificationInput,
): DelegatedWorkerVerificationResult {
  const envelope = readDelegatedResultEnvelope(input.metadata);
  if (envelope) {
    const reconciledEnvelope = reconcileDelegatedEnvelopeWithJobSnapshots(envelope, input.jobSnapshots);
    return {
      envelope: reconciledEnvelope,
      decision: verifyDelegatedResult({
        envelope: reconciledEnvelope,
        gatewayDecision: input.intentDecision,
        executionProfile: input.executionProfile,
      }),
    };
  }

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

export async function runDelegatedWorkerVerificationCycle(
  input: DelegatedWorkerVerificationCycleInput,
): Promise<DelegatedWorkerVerificationCycleResult> {
  let taskContract = input.taskContract;
  let jobSnapshots = input.jobSnapshots;
  let verifiedResult = verifyDelegatedWorkerResult({
    metadata: input.metadata,
    intentDecision: input.intentDecision,
    executionProfile: input.executionProfile,
    taskContract,
    jobSnapshots,
  });
  let insufficiency = buildDelegatedRetryableFailure(verifiedResult.decision, verifiedResult.envelope);
  if (shouldAdoptDelegatedTaskContract(taskContract, verifiedResult.envelope.taskContract)) {
    taskContract = verifiedResult.envelope.taskContract;
  }

  const extendedDrain = await runDelegatedEvidenceDrainExtension({
    requestId: input.requestId,
    taskRunId: input.taskRunId,
    metadata: input.metadata,
    intentDecision: input.intentDecision,
    executionProfile: input.executionProfile,
    taskContract,
    decision: verifiedResult.decision,
    jobSnapshots,
    ...(input.attemptLabel ? { attemptLabel: input.attemptLabel } : {}),
    drainPendingJobs: input.drainPendingJobs,
    trace: input.trace,
  });
  if (extendedDrain) {
    jobSnapshots = extendedDrain.jobSnapshots;
    verifiedResult = extendedDrain.verifiedResult;
    if (shouldAdoptDelegatedTaskContract(taskContract, verifiedResult.envelope.taskContract)) {
      taskContract = verifiedResult.envelope.taskContract;
    }
    insufficiency = extendedDrain.insufficiency;
  }

  return {
    taskContract,
    verifiedResult,
    insufficiency,
    jobSnapshots,
    extendedDrain,
  };
}

export function finalizeDelegatedWorkerVerification(
  input: DelegatedWorkerVerificationFinalizationInput,
): DelegatedWorkerVerificationFinalizationResult {
  const verifiedEnvelope = attachDelegatedVerificationDecision(
    input.verifiedResult.envelope,
    input.verifiedResult.decision,
    input.timestamp,
  );
  const supervisorPlanId = input.taskContract.plan.planId;
  const envelopePlanId = verifiedEnvelope.taskContract.plan.planId;
  const planDrift = supervisorPlanId !== envelopePlanId
    || input.taskContract.plan.steps.length !== verifiedEnvelope.taskContract.plan.steps.length;
  return {
    verifiedEnvelope,
    traceTaskContract: verifiedEnvelope.taskContract,
    planDrift,
    traceReason: planDrift
      ? `Plan drift detected: supervisor=${supervisorPlanId} (${input.taskContract.plan.steps.length} step(s)); envelope=${envelopePlanId} (${verifiedEnvelope.taskContract.plan.steps.length} step(s))`
      : `Plan reconciled: ${envelopePlanId} (${verifiedEnvelope.taskContract.plan.steps.length} step(s))`,
  };
}

export function reconcileDelegatedEnvelopeWithJobSnapshots(
  envelope: DelegatedResultEnvelope,
  jobSnapshots: DelegatedJobSnapshot[],
): DelegatedResultEnvelope {
  if (jobSnapshots.length === 0) {
    return envelope;
  }
  const synthesized = synthesizeDelegatedEvidenceReceiptsFromJobs(envelope.taskContract, jobSnapshots);
  if (synthesized.evidenceReceipts.length === 0) {
    return envelope;
  }

  const evidenceReceipts = [...envelope.evidenceReceipts];
  const evidenceReceiptIds = new Set(evidenceReceipts.map((receipt) => receipt.receiptId));
  const toolReceiptStepIds = new Map<string, string>();
  for (const stepReceipt of envelope.stepReceipts) {
    for (const receiptId of stepReceipt.evidenceReceiptIds) {
      toolReceiptStepIds.set(receiptId, stepReceipt.stepId);
    }
  }
  for (const [receiptId, stepId] of synthesized.toolReceiptStepIds) {
    toolReceiptStepIds.set(receiptId, stepId);
  }
  for (const receipt of synthesized.evidenceReceipts) {
    if (evidenceReceiptIds.has(receipt.receiptId)) {
      continue;
    }
    evidenceReceipts.push(receipt);
    evidenceReceiptIds.add(receipt.receiptId);
  }

  const stepReceipts = buildStepReceipts({
    plannedTask: envelope.taskContract.plan,
    evidenceReceipts,
    toolReceiptStepIds,
    interruptions: envelope.interruptions,
  });
  const runStatus = computeWorkerRunStatus(
    envelope.taskContract.plan,
    stepReceipts,
    envelope.interruptions,
    envelope.stopReason,
  );
  return {
    ...envelope,
    runStatus,
    stepReceipts,
    evidenceReceipts,
  };
}

export function buildSyntheticDelegatedEnvelopeFromJobs(input: {
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobSnapshots: DelegatedJobSnapshot[];
  workerExecution: WorkerExecutionMetadata | undefined;
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
  const stopReason = budgetExhausted ? 'max_rounds' : 'end_turn';
  const runStatus = computeWorkerRunStatus(
    input.taskContract.plan,
    synthesized.stepReceipts,
    [],
    stopReason,
  );
  return buildDelegatedSyntheticEnvelope({
    taskContract: input.taskContract,
    runStatus,
    stopReason,
    operatorSummary: budgetExhausted
      ? 'Delegated worker exhausted its step budget before returning a typed result envelope.'
      : 'Delegated worker stopped after partial progress before returning a typed result envelope.',
    evidenceReceipts: synthesized.evidenceReceipts,
    stepReceipts: synthesized.stepReceipts,
  });
}

export function isDelegatedJobInFlight(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'queued'
    || normalized === 'running'
    || normalized === 'pending'
    || normalized === 'starting';
}

export function listDelegatedRequestJobSnapshots(
  input: DelegatedRequestJobSnapshotInput,
): DelegatedJobSnapshot[] {
  const requestId = input.requestId.trim();
  if (!requestId || typeof input.listJobs !== 'function') {
    return [];
  }
  const lookupLimit = input.lookupLimit ?? DELEGATED_REQUEST_JOB_LOOKUP_LIMIT;
  const snapshotLimit = input.snapshotLimit ?? DELEGATED_REQUEST_JOB_SNAPSHOT_LIMIT;
  return input.listJobs(lookupLimit)
    .filter((job) => job.requestId === requestId)
    .slice(0, snapshotLimit)
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

export async function awaitDelegatedRequestJobDrain(
  input: DelegatedRequestJobDrainInput,
): Promise<DelegatedJobDrainResult> {
  const deadlineMs = Math.max(0, input.deadlineMs ?? DELEGATED_JOB_DRAIN_DEADLINE_MS);
  const pollMs = Math.max(0, input.pollMs ?? DELEGATED_JOB_DRAIN_POLL_MS);
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  let snapshots = listDelegatedRequestJobSnapshots(input);
  while (now() - start < deadlineMs) {
    const inFlight = snapshots.filter((snapshot) => isDelegatedJobInFlight(snapshot.status));
    if (inFlight.length === 0) break;
    await wait(pollMs);
    snapshots = listDelegatedRequestJobSnapshots(input);
  }
  const inFlightRemaining = snapshots.filter((snapshot) => isDelegatedJobInFlight(snapshot.status)).length;
  return {
    snapshots,
    waitedMs: now() - start,
    inFlightRemaining,
  };
}

export function shouldExtendDelegatedEvidenceDrain(input: {
  taskContract: DelegatedResultEnvelope['taskContract'];
  decision: VerificationDecision;
  jobSnapshots: DelegatedJobSnapshot[];
}): boolean {
  if (!input.decision.retryable) return false;
  if (!input.jobSnapshots.some((snapshot) => isDelegatedJobInFlight(snapshot.status))) {
    return false;
  }
  const missingEvidenceKinds = input.decision.missingEvidenceKinds ?? [];
  if (missingEvidenceKinds.some((kind) => kind !== 'answer')) {
    return true;
  }
  const unsatisfiedStepIds = new Set(input.decision.unsatisfiedStepIds ?? []);
  if (unsatisfiedStepIds.size === 0) {
    return false;
  }
  return input.taskContract.plan.steps.some((step) => (
    step.required !== false
    && step.kind !== 'answer'
    && unsatisfiedStepIds.has(step.stepId)
  ));
}

export async function runDelegatedEvidenceDrainExtension(input: {
  requestId: string;
  taskRunId: string;
  metadata: Record<string, unknown> | undefined;
  intentDecision: IntentGatewayDecision | undefined;
  executionProfile: SelectedExecutionProfile | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  decision: VerificationDecision;
  jobSnapshots: DelegatedJobSnapshot[];
  attemptLabel?: string;
  drainPendingJobs: (deadlineMs: number) => Promise<DelegatedJobDrainResult>;
  trace?: (event: DelegatedEvidenceDrainExtensionTraceEvent) => void;
}): Promise<DelegatedEvidenceDrainExtensionResult | null> {
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

  const drain = await input.drainPendingJobs(DELEGATED_EVIDENCE_DRAIN_DEADLINE_MS);
  if (drain.inFlightRemaining > 0) {
    const attemptSuffix = input.attemptLabel ? ` (${input.attemptLabel})` : '';
    input.trace?.({
      stage: 'delegated_job_wait_expired',
      details: {
        requestId: input.requestId,
        taskRunId: input.taskRunId,
        lifecycle: 'running',
        taskContract: input.taskContract,
        reason: `${drain.inFlightRemaining} delegated evidence job(s) remained in flight after ${drain.waitedMs}ms extended drain${attemptSuffix}`,
      },
    });
  }

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

export function isDelegatedWorkerBudgetExhausted(terminationReason: string | undefined): boolean {
  return terminationReason === 'max_rounds'
    || terminationReason === 'max_wall_clock'
    || terminationReason === 'watchdog_kill';
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
      missingEvidenceKinds: decision.missingEvidenceKinds ? [...decision.missingEvidenceKinds] : undefined,
      unsatisfiedStepIds: decision.unsatisfiedStepIds ? [...decision.unsatisfiedStepIds] : undefined,
      qualityNotes: decision.qualityNotes ? [...decision.qualityNotes] : undefined,
    },
    events: [
      ...envelope.events.filter((event) => event.type !== 'verification_decided'),
      verificationEvent,
    ],
  };
}

function synthesizeDelegatedEvidenceReceiptsFromJobs(
  taskContract: DelegatedResultEnvelope['taskContract'],
  jobSnapshots: DelegatedJobSnapshot[],
): {
  evidenceReceipts: DelegatedResultEnvelope['evidenceReceipts'];
  stepReceipts: DelegatedResultEnvelope['stepReceipts'];
  toolReceiptStepIds: Map<string, string>;
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
      refs: extractDelegatedEvidenceRefs(snapshot.argsPreview, snapshot.resultPreview),
      summary: snapshot.error?.trim()
        || snapshot.resultPreview?.trim()
        || `${snapshot.toolName} ${snapshot.status}.`,
      startedAt: snapshot.startedAt ?? snapshot.createdAt ?? 0,
      endedAt: snapshot.completedAt ?? snapshot.startedAt ?? snapshot.createdAt ?? 0,
    });
  }
  return {
    evidenceReceipts,
    toolReceiptStepIds,
    stepReceipts: buildStepReceipts({
      plannedTask: taskContract.plan,
      evidenceReceipts,
      toolReceiptStepIds,
      interruptions: [],
    }),
  };
}

function describeMissingDelegatedEnvelope(
  workerExecution: WorkerExecutionMetadata | undefined,
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
