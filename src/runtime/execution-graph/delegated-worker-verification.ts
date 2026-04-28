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
  VerificationDecision,
} from '../execution/types.js';
import { verifyDelegatedResult } from '../execution/verifier.js';
import {
  readWorkerExecutionMetadata,
  type WorkerExecutionMetadata,
} from '../worker-execution-metadata.js';
import { extractDelegatedEvidenceRefs } from './delegated-worker-retry.js';

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

export function isDelegatedWorkerBudgetExhausted(terminationReason: string | undefined): boolean {
  return terminationReason === 'max_rounds'
    || terminationReason === 'max_wall_clock'
    || terminationReason === 'watchdog_kill';
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
