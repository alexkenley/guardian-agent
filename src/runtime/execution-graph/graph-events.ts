import type { ExecutionArtifactRef, ExecutionNodeKind } from './types.js';

export type ExecutionGraphEventKind =
  | 'graph_started'
  | 'node_started'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'artifact_created'
  | 'approval_requested'
  | 'approval_resolved'
  | 'clarification_requested'
  | 'clarification_resolved'
  | 'verification_completed'
  | 'recovery_proposed'
  | 'node_completed'
  | 'node_failed'
  | 'graph_completed'
  | 'graph_failed';

export interface ExecutionGraphEvent {
  eventId: string;
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId?: string;
  nodeKind?: ExecutionNodeKind;
  kind: ExecutionGraphEventKind;
  timestamp: number;
  sequence: number;
  producer: 'runtime' | 'brokered_worker' | 'supervisor';
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  payload: Record<string, unknown>;
}

export interface CreateExecutionGraphEventInput {
  eventId: string;
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId?: string;
  nodeKind?: ExecutionNodeKind;
  kind: ExecutionGraphEventKind;
  timestamp: number;
  sequence: number;
  producer: ExecutionGraphEvent['producer'];
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  payload?: Record<string, unknown>;
}

export function createExecutionGraphEvent(input: CreateExecutionGraphEventInput): ExecutionGraphEvent {
  return {
    eventId: input.eventId,
    graphId: input.graphId,
    executionId: input.executionId,
    rootExecutionId: input.rootExecutionId,
    ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
    requestId: input.requestId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.nodeKind ? { nodeKind: input.nodeKind } : {}),
    kind: input.kind,
    timestamp: input.timestamp,
    sequence: input.sequence,
    producer: input.producer,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    payload: input.payload ?? {},
  };
}

export function createArtifactCreatedEvent(input: {
  eventId: string;
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId: string;
  timestamp: number;
  sequence: number;
  producer: ExecutionGraphEvent['producer'];
  artifact: ExecutionArtifactRef;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
}): ExecutionGraphEvent {
  return createExecutionGraphEvent({
    eventId: input.eventId,
    graphId: input.graphId,
    executionId: input.executionId,
    rootExecutionId: input.rootExecutionId,
    ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
    requestId: input.requestId,
    ...(input.runId ? { runId: input.runId } : {}),
    nodeId: input.nodeId,
    kind: 'artifact_created',
    timestamp: input.timestamp,
    sequence: input.sequence,
    producer: input.producer,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    payload: {
      artifactId: input.artifact.artifactId,
      artifactType: input.artifact.artifactType,
      label: input.artifact.label,
      ...(input.artifact.preview ? { preview: input.artifact.preview } : {}),
      ...(input.artifact.trustLevel ? { trustLevel: input.artifact.trustLevel } : {}),
      ...(input.artifact.taintReasons ? { taintReasons: input.artifact.taintReasons } : {}),
      ...(input.artifact.redactionPolicy ? { redactionPolicy: input.artifact.redactionPolicy } : {}),
    },
  });
}

export function isExecutionGraphEvent(value: unknown): value is ExecutionGraphEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.eventId === 'string'
    && typeof record.graphId === 'string'
    && typeof record.executionId === 'string'
    && typeof record.rootExecutionId === 'string'
    && typeof record.requestId === 'string'
    && isExecutionGraphEventKind(record.kind)
    && typeof record.timestamp === 'number'
    && Number.isFinite(record.timestamp)
    && typeof record.sequence === 'number'
    && Number.isFinite(record.sequence)
    && (record.producer === 'runtime' || record.producer === 'brokered_worker' || record.producer === 'supervisor')
    && !!record.payload
    && typeof record.payload === 'object'
    && !Array.isArray(record.payload);
}

function isExecutionGraphEventKind(value: unknown): value is ExecutionGraphEventKind {
  switch (value) {
    case 'graph_started':
    case 'node_started':
    case 'llm_call_started':
    case 'llm_call_completed':
    case 'tool_call_started':
    case 'tool_call_completed':
    case 'artifact_created':
    case 'approval_requested':
    case 'approval_resolved':
    case 'clarification_requested':
    case 'clarification_resolved':
    case 'verification_completed':
    case 'recovery_proposed':
    case 'node_completed':
    case 'node_failed':
    case 'graph_completed':
    case 'graph_failed':
      return true;
    default:
      return false;
  }
}
