import type { IntentGatewayDecision } from '../intent/types.js';
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

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
