import type {
  DelegatedWorkerHandoff,
  DelegatedWorkerRunClass,
} from '../assistant-jobs.js';
import { readDelegatedResultEnvelope } from '../execution/metadata.js';
import type {
  DelegatedResultEnvelope,
  VerificationDecision,
} from '../execution/types.js';
import { readWorkerExecutionMetadata } from '../worker-execution-metadata.js';

export interface DelegatedInsufficientResultHandoffInput {
  failureSummary: string;
  decision: Pick<VerificationDecision, 'requiredNextAction'>;
}

export function buildDelegatedInsufficientResultHandoff(
  insufficiency: DelegatedInsufficientResultHandoffInput,
  runClassInput?: DelegatedWorkerRunClass,
): DelegatedWorkerHandoff {
  return {
    summary: insufficiency.failureSummary,
    runClass: normalizeDelegatedWorkerRunClass(runClassInput),
    nextAction: insufficiency.decision.requiredNextAction
      ?? 'Inspect the delegated worker failure details before retrying.',
    reportingMode: 'inline_response',
  };
}

export function buildDelegatedHandoff(
  content: string,
  metadata: Record<string, unknown> | undefined,
  runClassInput?: DelegatedWorkerRunClass,
  verification?: VerificationDecision,
): DelegatedWorkerHandoff {
  const unresolvedBlockerKind = resolveDelegatedBlockedKind(metadata, verification);
  const lifecycle = resolveDelegatedWorkerLifecycle(metadata, unresolvedBlockerKind, verification);
  const summary = buildDelegatedFailureSummary(content, metadata, verification)
    ?? truncateDelegatedHandoffText(content, 220)
    ?? (lifecycle === 'failed' ? 'Delegated worker failed.' : 'Delegated worker completed.');
  const approvalCount = readApprovalSummaryCount(metadata);
  const runClass = normalizeDelegatedWorkerRunClass(runClassInput);
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

export function applyDelegatedFollowUpPolicy(
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
    // but the answer has potential quality caveats.
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

export function resolveDelegatedWorkerLifecycle(
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

export function normalizeDelegatedWorkerRunClass(value: unknown): DelegatedWorkerRunClass {
  if (value === 'in_invocation' || value === 'short_lived' || value === 'long_running' || value === 'automation_owned') {
    return value;
  }
  return 'short_lived';
}

export function formatFailedDelegatedMessage(handoff: DelegatedWorkerHandoff): string {
  const parts = [
    'Delegated work failed.',
    handoff.summary,
    handoff.nextAction,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(parts)].join('\n');
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
  const summary = truncateDelegatedHandoffText(content, 220);
  return summary || 'Delegated worker failed.';
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

function formatDelegatedStepIds(stepIds: string[]): string {
  return stepIds.join(', ');
}

function truncateDelegatedHandoffText(value: string, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
