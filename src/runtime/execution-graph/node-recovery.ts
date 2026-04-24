import {
  artifactRefFromArtifact,
  buildRecoveryProposalArtifact,
  type ExecutionArtifact,
  type RecoveryProposalActionContent,
  type RecoveryProposalActionKind,
  type RecoveryProposalContent,
} from './graph-artifacts.js';
import { createExecutionGraphEvent, type ExecutionGraphEvent } from './graph-events.js';
import type { ExecutionArtifactRef, ExecutionGraph, ExecutionNode } from './types.js';

export interface RecoveryNodeExecutionContext {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId: string;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  sequenceStart?: number;
  now?: () => number;
  emit?: (event: ExecutionGraphEvent) => void;
}

export interface RecoveryProposalCandidateAction {
  kind: string;
  targetNodeId?: string;
  insertAfterNodeId?: string;
  retryBudget?: number;
  reason?: string;
}

export interface RecoveryProposalCandidate {
  reason?: string;
  actions?: RecoveryProposalCandidateAction[];
}

export type RecoveryGraphPatchOperation =
  | {
      kind: 'retry_node';
      targetNodeId: string;
      retryBudget: number;
      reason?: string;
    }
  | {
      kind: 'insert_synthesize_node';
      node: ExecutionNode;
      afterNodeId: string;
      requiredArtifactIds: string[];
      reason?: string;
    }
  | {
      kind: 'request_approval' | 'request_clarification';
      targetNodeId: string;
      reason?: string;
    }
  | {
      kind: 'fail_graph';
      reason: string;
    };

export interface RecoveryGraphPatch {
  proposalArtifactId: string;
  failedNodeId: string;
  advisoryOnly: true;
  operations: RecoveryGraphPatchOperation[];
}

export interface ValidatedRecoveryProposal {
  failedNodeId: string;
  reason: string;
  actions: RecoveryProposalActionContent[];
}

export interface ExecuteRecoveryProposalNodeInput {
  graph: Pick<ExecutionGraph, 'graphId' | 'nodes' | 'artifacts'>;
  failedNode: ExecutionNode;
  context: RecoveryNodeExecutionContext;
  candidate?: RecoveryProposalCandidate | null;
  verificationArtifact?: Pick<ExecutionArtifactRef, 'artifactId' | 'artifactType' | 'label'> | null;
  maxActions?: number;
}

export interface ExecuteRecoveryProposalNodeResult {
  status: 'proposed' | 'rejected';
  proposalArtifact?: ExecutionArtifact<RecoveryProposalContent>;
  patch?: RecoveryGraphPatch;
  events: ExecutionGraphEvent[];
  rejectionReason?: string;
}

const MAX_RECOVERY_ACTIONS = 3;
const MAX_RETRY_BUDGET = 3;
const EVIDENCE_ARTIFACT_TYPES = new Set([
  'SearchResultSet',
  'FileReadSet',
  'EvidenceLedger',
  'SynthesisDraft',
]);

export function executeRecoveryProposalNode(
  input: ExecuteRecoveryProposalNodeInput,
): ExecuteRecoveryProposalNodeResult {
  const events: ExecutionGraphEvent[] = [];
  let sequence = input.context.sequenceStart ?? 0;
  const now = input.context.now ?? Date.now;
  const emit = (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string): ExecutionGraphEvent => {
    sequence += 1;
    const event = createExecutionGraphEvent({
      ...baseEventContext(input.context),
      eventId: `${input.context.graphId}:${input.context.nodeId}:${eventKey}:${sequence}`,
      nodeId: input.context.nodeId,
      nodeKind: 'recover',
      kind,
      timestamp: now(),
      sequence,
      producer: 'runtime',
      payload,
    });
    events.push(event);
    input.context.emit?.(event);
    return event;
  };

  emit('node_started', {
    failedNodeId: input.failedNode.nodeId,
    failedNodeKind: input.failedNode.kind,
    ...(input.verificationArtifact ? { verificationArtifactId: input.verificationArtifact.artifactId } : {}),
    advisoryOnly: true,
  }, 'node-started');

  const candidate = input.candidate ?? buildDeterministicRecoveryProposalCandidate(input);
  const validated = validateRecoveryProposalCandidate(candidate, input);
  if (!validated) {
    const rejectionReason = 'Recovery candidate was rejected by deterministic validation.';
    emit('node_failed', {
      reason: rejectionReason,
      failedNodeId: input.failedNode.nodeId,
      advisoryOnly: true,
    }, 'node-failed');
    return { status: 'rejected', events, rejectionReason };
  }

  const proposalArtifact = buildRecoveryProposalArtifact({
    graphId: input.context.graphId,
    nodeId: input.context.nodeId,
    artifactId: `${input.context.graphId}:${input.context.nodeId}:recovery-proposal`,
    failedNodeId: validated.failedNodeId,
    reason: validated.reason,
    actions: validated.actions,
    createdAt: now(),
  });
  const artifactRef = artifactRefFromArtifact(proposalArtifact);
  emit('artifact_created', {
    artifactId: artifactRef.artifactId,
    artifactType: artifactRef.artifactType,
    label: artifactRef.label,
    ...(artifactRef.preview ? { preview: artifactRef.preview } : {}),
    ...(artifactRef.redactionPolicy ? { redactionPolicy: artifactRef.redactionPolicy } : {}),
  }, `artifact:${proposalArtifact.artifactId}`);

  const patch = buildRecoveryGraphPatch({
    graph: input.graph,
    failedNode: input.failedNode,
    proposalArtifact,
  });
  emit('recovery_proposed', {
    failedNodeId: input.failedNode.nodeId,
    proposalArtifactId: proposalArtifact.artifactId,
    actionKinds: proposalArtifact.content.actions.map((action) => action.kind),
    actionCount: proposalArtifact.content.actions.length,
    advisoryOnly: true,
    summary: proposalArtifact.content.reason,
  }, 'recovery-proposed');
  emit('node_completed', {
    proposalArtifactId: proposalArtifact.artifactId,
    failedNodeId: input.failedNode.nodeId,
    advisoryOnly: true,
  }, 'node-completed');

  return {
    status: 'proposed',
    proposalArtifact,
    patch,
    events,
  };
}

export function validateRecoveryProposalCandidate(
  candidate: RecoveryProposalCandidate | null | undefined,
  input: Pick<ExecuteRecoveryProposalNodeInput, 'graph' | 'failedNode' | 'maxActions'>,
): ValidatedRecoveryProposal | null {
  if (!candidate || input.failedNode.status !== 'failed') {
    return null;
  }
  const maxActions = Math.max(1, Math.min(MAX_RECOVERY_ACTIONS, input.maxActions ?? MAX_RECOVERY_ACTIONS));
  const rawActions = Array.isArray(candidate.actions) ? candidate.actions : [];
  if (rawActions.length <= 0 || rawActions.length > maxActions) {
    return null;
  }
  const actions: RecoveryProposalActionContent[] = [];
  for (const action of rawActions) {
    const validated = validateRecoveryProposalAction(action, input);
    if (!validated) {
      return null;
    }
    actions.push(validated);
  }
  return {
    failedNodeId: input.failedNode.nodeId,
    reason: normalizeText(candidate.reason) ?? 'Recovery node proposed a bounded graph retry.',
    actions,
  };
}

export function buildDeterministicRecoveryProposalCandidate(
  input: Pick<ExecuteRecoveryProposalNodeInput, 'graph' | 'failedNode'>,
): RecoveryProposalCandidate {
  if (input.failedNode.kind === 'synthesize' && evidenceArtifactRefs(input.graph).length > 0) {
    return {
      reason: 'Retry synthesis from the existing typed evidence artifacts.',
      actions: [{
        kind: 'insert_synthesize_node',
        insertAfterNodeId: input.failedNode.nodeId,
        reason: 'Evidence is present, so recovery can create a bounded no-tools synthesis retry.',
      }],
    };
  }
  if (input.failedNode.kind === 'approval_interrupt') {
    return {
      reason: 'The graph is blocked on an approval interrupt.',
      actions: [{
        kind: 'request_approval',
        targetNodeId: input.failedNode.nodeId,
        reason: 'Request the missing approval without approving it automatically.',
      }],
    };
  }
  if (input.failedNode.kind === 'mutate' || input.failedNode.kind === 'explore_readonly' || input.failedNode.kind === 'delegated_worker') {
    return {
      reason: `Retry failed ${input.failedNode.kind} node with a single bounded retry budget.`,
      actions: [{
        kind: 'retry_node',
        targetNodeId: input.failedNode.nodeId,
        retryBudget: 1,
      }],
    };
  }
  return {
    reason: 'No safe retry or graph edit is available for the failed node.',
    actions: [{
      kind: 'fail_graph',
      reason: 'No safe retry or graph edit is available for the failed node.',
    }],
  };
}

export function buildRecoveryGraphPatch(input: {
  graph: Pick<ExecutionGraph, 'graphId' | 'nodes' | 'artifacts'>;
  failedNode: ExecutionNode;
  proposalArtifact: ExecutionArtifact<RecoveryProposalContent>;
}): RecoveryGraphPatch {
  const evidenceArtifactIds = evidenceArtifactRefs(input.graph).map((artifact) => artifact.artifactId);
  const operations = input.proposalArtifact.content.actions.map((action, index): RecoveryGraphPatchOperation => {
    switch (action.kind) {
      case 'retry_node':
        return {
          kind: 'retry_node',
          targetNodeId: action.targetNodeId ?? input.failedNode.nodeId,
          retryBudget: action.retryBudget ?? 1,
          ...(action.reason ? { reason: action.reason } : {}),
        };
      case 'insert_synthesize_node': {
        const afterNodeId = action.insertAfterNodeId ?? input.failedNode.nodeId;
        return {
          kind: 'insert_synthesize_node',
          node: {
            nodeId: uniqueNodeId(input.graph, `${input.failedNode.nodeId}:recovery-synthesize:${index + 1}`),
            graphId: input.graph.graphId,
            kind: 'synthesize',
            status: 'pending',
            title: 'Recovery synthesis',
            requiredInputIds: evidenceArtifactIds,
            outputArtifactTypes: ['SynthesisDraft'],
            allowedToolCategories: [],
            checkpointPolicy: 'phase_boundary',
            retryLimit: 1,
          },
          afterNodeId,
          requiredArtifactIds: evidenceArtifactIds,
          ...(action.reason ? { reason: action.reason } : {}),
        };
      }
      case 'request_approval':
      case 'request_clarification':
        return {
          kind: action.kind,
          targetNodeId: action.targetNodeId ?? input.failedNode.nodeId,
          ...(action.reason ? { reason: action.reason } : {}),
        };
      case 'fail_graph':
        return {
          kind: 'fail_graph',
          reason: action.reason ?? input.proposalArtifact.content.reason,
        };
    }
  });
  return {
    proposalArtifactId: input.proposalArtifact.artifactId,
    failedNodeId: input.failedNode.nodeId,
    advisoryOnly: true,
    operations,
  };
}

function validateRecoveryProposalAction(
  action: RecoveryProposalCandidateAction,
  input: Pick<ExecuteRecoveryProposalNodeInput, 'graph' | 'failedNode'>,
): RecoveryProposalActionContent | null {
  const kind = normalizeRecoveryProposalActionKind(action.kind);
  if (!kind) {
    return null;
  }
  const targetNodeId = normalizeText(action.targetNodeId) ?? input.failedNode.nodeId;
  const targetNode = input.graph.nodes.find((node) => node.nodeId === targetNodeId);
  if (!targetNode || targetNode.nodeId !== input.failedNode.nodeId || targetNode.status !== 'failed') {
    return null;
  }

  switch (kind) {
    case 'retry_node': {
      const retryBudget = normalizeRetryBudget(action.retryBudget);
      if (!retryBudget) return null;
      return {
        kind,
        targetNodeId,
        retryBudget,
        ...(normalizeText(action.reason) ? { reason: normalizeText(action.reason) } : {}),
      };
    }
    case 'insert_synthesize_node': {
      const insertAfterNodeId = normalizeText(action.insertAfterNodeId) ?? input.failedNode.nodeId;
      if (!input.graph.nodes.some((node) => node.nodeId === insertAfterNodeId)) {
        return null;
      }
      if (evidenceArtifactRefs(input.graph).length <= 0) {
        return null;
      }
      return {
        kind,
        insertAfterNodeId,
        ...(normalizeText(action.reason) ? { reason: normalizeText(action.reason) } : {}),
      };
    }
    case 'request_approval':
    case 'request_clarification':
      return {
        kind,
        targetNodeId,
        ...(normalizeText(action.reason) ? { reason: normalizeText(action.reason) } : {}),
      };
    case 'fail_graph':
      return {
        kind,
        reason: normalizeText(action.reason) ?? 'Recovery cannot safely continue the graph.',
      };
  }
}

function evidenceArtifactRefs(
  graph: Pick<ExecutionGraph, 'artifacts'>,
): ExecutionArtifactRef[] {
  return graph.artifacts.filter((artifact) => (
    EVIDENCE_ARTIFACT_TYPES.has(artifact.artifactType)
    && artifact.trustLevel !== 'quarantined'
  ));
}

function normalizeRecoveryProposalActionKind(value: string): RecoveryProposalActionKind | null {
  switch (value) {
    case 'retry_node':
    case 'insert_synthesize_node':
    case 'request_approval':
    case 'request_clarification':
    case 'fail_graph':
      return value;
    default:
      return null;
  }
}

function normalizeRetryBudget(value: number | undefined): number | null {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return null;
  const budget = Math.floor(value);
  if (budget < 1 || budget > MAX_RETRY_BUDGET) return null;
  return budget;
}

function uniqueNodeId(
  graph: Pick<ExecutionGraph, 'nodes'>,
  baseNodeId: string,
): string {
  const existing = new Set(graph.nodes.map((node) => node.nodeId));
  if (!existing.has(baseNodeId)) return baseNodeId;
  let index = 2;
  let candidate = `${baseNodeId}-${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${baseNodeId}-${index}`;
  }
  return candidate;
}

function baseEventContext(context: RecoveryNodeExecutionContext): Omit<
  Parameters<typeof createExecutionGraphEvent>[0],
  'eventId' | 'kind' | 'timestamp' | 'sequence' | 'producer' | 'payload' | 'nodeId' | 'nodeKind'
> {
  return {
    graphId: context.graphId,
    executionId: context.executionId,
    rootExecutionId: context.rootExecutionId,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    requestId: context.requestId,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.codeSessionId ? { codeSessionId: context.codeSessionId } : {}),
  };
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
