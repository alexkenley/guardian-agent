import type { IntentGatewayDecision } from '../intent/types.js';
import type { VerificationDecision } from '../execution/types.js';
import {
  artifactRefFromArtifact,
  buildVerificationResultArtifact,
  type ExecutionArtifact,
  type VerificationCheckRecord,
  type VerificationResultContent,
} from './graph-artifacts.js';
import {
  createExecutionGraphEvent,
  type ExecutionGraphEvent,
  type ExecutionGraphEventKind,
} from './graph-events.js';
import type { ExecutionNode, ExecutionNodeKind } from './types.js';

export interface DelegatedWorkerGraphContext {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId: string;
  nodeId: string;
  nodeKind: Extract<ExecutionNodeKind, 'delegated_worker'>;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  title: string;
}

export interface BuildDelegatedWorkerGraphContextInput {
  graphId?: string;
  requestId?: string;
  runId?: string;
  executionId?: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  taskExecutionId?: string;
  nodeId?: string;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  title?: string;
  decision?: IntentGatewayDecision | null;
}

export interface BuildDelegatedWorkerNodeInput {
  context: DelegatedWorkerGraphContext;
  ownerAgentId?: string;
  executionProfileName?: string;
}

export interface DelegatedWorkerGraphEventInput {
  kind: ExecutionGraphEventKind;
  sequence: number;
  timestamp: number;
  eventId: string;
  payload?: Record<string, unknown>;
  nodeScoped?: boolean;
}

export interface DelegatedWorkerStartProjectionInput {
  context: DelegatedWorkerGraphContext;
  sequenceStart: number;
  timestamp: number;
  decision: IntentGatewayDecision;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface DelegatedWorkerStartProjection {
  events: ExecutionGraphEvent[];
  sequence: number;
}

export type DelegatedWorkerGraphLifecycle = 'completed' | 'blocked' | 'failed';
export type DelegatedWorkerGraphBlockerKind = 'approval' | 'clarification' | 'workspace_switch' | 'auth' | 'policy' | 'missing_context';

export interface DelegatedWorkerTerminalProjectionInput {
  context: DelegatedWorkerGraphContext;
  sequenceStart: number;
  timestamp: number;
  lifecycle: DelegatedWorkerGraphLifecycle;
  verification: VerificationDecision;
  payload: Record<string, unknown>;
  blockerKind?: string;
  blockerPrompt?: string;
  subjectArtifactId?: string;
}

export interface DelegatedWorkerTerminalProjection {
  verificationArtifact: ExecutionArtifact<VerificationResultContent>;
  events: ExecutionGraphEvent[];
  sequence: number;
}

export function buildDelegatedWorkerGraphContext(
  input: BuildDelegatedWorkerGraphContextInput,
): DelegatedWorkerGraphContext {
  const requestId = normalizeText(input.requestId)
    ?? normalizeText(input.taskExecutionId)
    ?? 'delegated-worker';
  const executionId = normalizeText(input.executionId)
    ?? normalizeText(input.taskExecutionId)
    ?? requestId;
  const rootExecutionId = normalizeText(input.rootExecutionId) ?? executionId;
  const title = normalizeText(input.title)
    ?? normalizeText(input.decision?.summary)
    ?? 'Delegated worker';
  return {
    graphId: normalizeText(input.graphId) ?? `execution-graph:${executionId}:delegated-worker`,
    executionId,
    rootExecutionId,
    ...(normalizeText(input.parentExecutionId) ? { parentExecutionId: normalizeText(input.parentExecutionId) } : {}),
    requestId,
    runId: normalizeText(input.runId) ?? requestId,
    nodeId: normalizeText(input.nodeId) ?? `node:${executionId}:delegated_worker`,
    nodeKind: 'delegated_worker',
    ...(normalizeText(input.channel) ? { channel: normalizeText(input.channel) } : {}),
    ...(normalizeText(input.agentId) ? { agentId: normalizeText(input.agentId) } : {}),
    ...(normalizeText(input.userId) ? { userId: normalizeText(input.userId) } : {}),
    ...(normalizeText(input.codeSessionId) ? { codeSessionId: normalizeText(input.codeSessionId) } : {}),
    title,
  };
}

export function buildDelegatedWorkerNode(input: BuildDelegatedWorkerNodeInput): ExecutionNode {
  return {
    nodeId: input.context.nodeId,
    graphId: input.context.graphId,
    kind: input.context.nodeKind,
    status: 'pending',
    title: input.context.title,
    requiredInputIds: [],
    outputArtifactTypes: ['VerificationResult'],
    allowedToolCategories: [],
    approvalPolicy: 'if_required',
    checkpointPolicy: 'phase_boundary',
    ...(normalizeText(input.ownerAgentId) ? { ownerAgentId: normalizeText(input.ownerAgentId) } : {}),
    ...(normalizeText(input.executionProfileName) ? { executionProfileName: normalizeText(input.executionProfileName) } : {}),
  };
}

export function buildDelegatedWorkerGraphEvent(
  context: DelegatedWorkerGraphContext,
  input: DelegatedWorkerGraphEventInput,
): ExecutionGraphEvent {
  const nodeScoped = input.nodeScoped ?? true;
  return createExecutionGraphEvent({
    eventId: input.eventId,
    graphId: context.graphId,
    executionId: context.executionId,
    rootExecutionId: context.rootExecutionId,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    requestId: context.requestId,
    runId: context.runId,
    ...(nodeScoped ? { nodeId: context.nodeId, nodeKind: context.nodeKind } : {}),
    kind: input.kind,
    timestamp: input.timestamp,
    sequence: input.sequence,
    producer: 'supervisor',
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.codeSessionId ? { codeSessionId: context.codeSessionId } : {}),
    payload: {
      title: context.title,
      ...(input.payload ?? {}),
    },
  });
}

export function buildDelegatedWorkerStartProjection(
  input: DelegatedWorkerStartProjectionInput,
): DelegatedWorkerStartProjection {
  let sequence = input.sequenceStart;
  const events: ExecutionGraphEvent[] = [];
  const emit = (
    kind: ExecutionGraphEventKind,
    payload: Record<string, unknown>,
    eventKey: string,
    nodeScoped = true,
  ) => {
    sequence += 1;
    const event = buildDelegatedWorkerGraphEvent(input.context, {
      kind,
      sequence,
      timestamp: input.timestamp,
      eventId: `${input.context.graphId}:${eventKey}:${sequence}`,
      payload,
      nodeScoped,
    });
    events.push(event);
  };
  emit('graph_started', {
    route: input.decision.route,
    operation: input.decision.operation,
    executionClass: input.decision.executionClass,
    controller: 'delegated_worker',
    ...(input.payload ?? {}),
  }, 'graph:started', false);
  emit('node_started', {
    summary: input.summary,
    lifecycle: 'running',
    ...(input.payload ?? {}),
  }, 'node:started');
  return { events, sequence };
}

export function buildDelegatedWorkerTerminalProjection(
  input: DelegatedWorkerTerminalProjectionInput,
): DelegatedWorkerTerminalProjection {
  let sequence = input.sequenceStart;
  const events: ExecutionGraphEvent[] = [];
  const verificationArtifact = buildVerificationResultArtifact({
    graphId: input.context.graphId,
    nodeId: input.context.nodeId,
    artifactId: `${input.context.graphId}:${input.context.nodeId}:verification`,
    subjectArtifactId: input.subjectArtifactId ?? `delegated-result:${input.context.executionId}`,
    checks: buildDelegatedWorkerVerificationChecks(input.verification),
    createdAt: input.timestamp,
  });
  const emit = (
    kind: ExecutionGraphEventKind,
    payload: Record<string, unknown>,
    eventKey: string,
    nodeScoped = true,
  ) => {
    sequence += 1;
    const event = buildDelegatedWorkerGraphEvent(input.context, {
      kind,
      sequence,
      timestamp: input.timestamp,
      eventId: `${input.context.graphId}:${eventKey}:${sequence}`,
      payload,
      nodeScoped,
    });
    events.push(event);
  };
  const verificationRef = artifactRefFromArtifact(verificationArtifact);
  emit('artifact_created', {
    artifactId: verificationRef.artifactId,
    artifactType: verificationRef.artifactType,
    label: verificationRef.label,
    ...(verificationRef.preview ? { preview: verificationRef.preview } : {}),
    ...(verificationRef.trustLevel ? { trustLevel: verificationRef.trustLevel } : {}),
    ...(verificationRef.taintReasons ? { taintReasons: verificationRef.taintReasons } : {}),
    ...(verificationRef.redactionPolicy ? { redactionPolicy: verificationRef.redactionPolicy } : {}),
  }, `artifact:${verificationArtifact.artifactId}`);
  emit('verification_completed', {
    verificationArtifactId: verificationArtifact.artifactId,
    decision: input.verification.decision,
    valid: verificationArtifact.content.valid,
    retryable: input.verification.retryable,
    checkCount: verificationArtifact.content.checks.length,
    failedChecks: verificationArtifact.content.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.name),
    ...(input.verification.requiredNextAction ? { requiredNextAction: input.verification.requiredNextAction } : {}),
    ...(input.verification.missingEvidenceKinds?.length ? { missingEvidenceKinds: input.verification.missingEvidenceKinds } : {}),
    ...(input.verification.unsatisfiedStepIds?.length ? { unsatisfiedStepIds: input.verification.unsatisfiedStepIds } : {}),
    ...(input.verification.qualityNotes?.length ? { qualityNotes: input.verification.qualityNotes } : {}),
  }, 'verification:completed');
  if (input.lifecycle === 'failed') {
    emit('node_failed', {
      ...input.payload,
      verificationArtifactId: verificationArtifact.artifactId,
      reason: normalizeText(String(input.payload.reason ?? '')) ?? normalizeText(String(input.payload.summary ?? '')) ?? 'Delegated worker failed.',
    }, 'node:failed');
    emit('graph_failed', {
      ...input.payload,
      verificationArtifactId: verificationArtifact.artifactId,
      reason: normalizeText(String(input.payload.reason ?? '')) ?? normalizeText(String(input.payload.summary ?? '')) ?? 'Delegated worker failed.',
    }, 'graph:failed', false);
    return { verificationArtifact, events, sequence };
  }
  if (input.lifecycle === 'blocked') {
    emit('interruption_requested', {
      ...input.payload,
      verificationArtifactId: verificationArtifact.artifactId,
      kind: normalizeDelegatedGraphBlockerKind(input.blockerKind),
      prompt: normalizeText(input.blockerPrompt) ?? normalizeText(String(input.payload.summary ?? '')) ?? 'Delegated worker is blocked.',
    }, 'node:interruption');
    return { verificationArtifact, events, sequence };
  }
  emit('node_completed', {
    ...input.payload,
    verificationArtifactId: verificationArtifact.artifactId,
  }, 'node:completed');
  emit('graph_completed', {
    ...input.payload,
    verificationArtifactId: verificationArtifact.artifactId,
  }, 'graph:completed', false);
  return { verificationArtifact, events, sequence };
}

export function normalizeDelegatedGraphBlockerKind(
  value: string | undefined,
): DelegatedWorkerGraphBlockerKind {
  switch (value) {
    case 'approval':
    case 'clarification':
    case 'workspace_switch':
    case 'auth':
    case 'policy':
    case 'missing_context':
      return value;
    case 'policy_blocked':
      return 'policy';
    default:
      return 'missing_context';
  }
}

export function buildDelegatedWorkerVerificationChecks(
  decision: VerificationDecision,
): VerificationCheckRecord[] {
  const checks: VerificationCheckRecord[] = [{
    name: 'delegated_worker_sufficiency',
    status: decision.decision === 'satisfied' ? 'passed' : 'failed',
    ...(decision.reasons[0] ? { reason: decision.reasons[0] } : {}),
  }];
  if (decision.unsatisfiedStepIds && decision.unsatisfiedStepIds.length > 0) {
    checks.push({
      name: 'unsatisfied_required_steps',
      status: 'failed',
      reason: decision.unsatisfiedStepIds.join(', '),
    });
  }
  if (decision.missingEvidenceKinds && decision.missingEvidenceKinds.length > 0) {
    checks.push({
      name: 'missing_required_evidence',
      status: 'failed',
      reason: decision.missingEvidenceKinds.join(', '),
    });
  }
  for (const [index, note] of (decision.qualityNotes ?? []).entries()) {
    checks.push({
      name: `quality_note_${index + 1}`,
      status: 'skipped',
      reason: note,
    });
  }
  return checks;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
