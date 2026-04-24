import type { IntentGatewayDecision } from '../intent/types.js';
import {
  createExecutionGraphEvent,
  type ExecutionGraphEvent,
  type ExecutionGraphEventKind,
} from './graph-events.js';
import type { ExecutionNodeKind } from './types.js';

export interface DirectReasoningGraphContext {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId: string;
  nodeId: string;
  nodeKind: Extract<ExecutionNodeKind, 'explore_readonly'>;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  summary?: string;
}

export interface BuildDirectReasoningGraphContextInput {
  requestId?: string;
  runId?: string;
  executionId?: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  taskExecutionId?: string;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  decision?: IntentGatewayDecision | null;
}

export interface DirectReasoningGraphEventInput {
  kind: ExecutionGraphEventKind;
  sequence: number;
  timestamp: number;
  eventId: string;
  payload?: Record<string, unknown>;
}

export function buildDirectReasoningGraphContext(
  input: BuildDirectReasoningGraphContextInput,
): DirectReasoningGraphContext {
  const requestId = normalizeText(input.requestId)
    ?? normalizeText(input.taskExecutionId)
    ?? 'direct-reasoning';
  const runId = normalizeText(input.runId)
    ?? normalizeText(input.taskExecutionId)
    ?? requestId;
  const executionId = normalizeText(input.executionId)
    ?? normalizeText(input.taskExecutionId)
    ?? requestId;
  const rootExecutionId = normalizeText(input.rootExecutionId) ?? executionId;
  return {
    graphId: `execution-graph:${executionId}:direct-reasoning`,
    executionId,
    rootExecutionId,
    ...(normalizeText(input.parentExecutionId) ? { parentExecutionId: normalizeText(input.parentExecutionId) } : {}),
    requestId,
    runId,
    nodeId: `node:${executionId}:explore_readonly`,
    nodeKind: 'explore_readonly',
    ...(normalizeText(input.channel) ? { channel: normalizeText(input.channel) } : {}),
    ...(normalizeText(input.agentId) ? { agentId: normalizeText(input.agentId) } : {}),
    ...(normalizeText(input.userId) ? { userId: normalizeText(input.userId) } : {}),
    ...(normalizeText(input.codeSessionId) ? { codeSessionId: normalizeText(input.codeSessionId) } : {}),
    ...(normalizeText(input.decision?.summary) ? { summary: normalizeText(input.decision?.summary) } : {}),
  };
}

export function buildDirectReasoningGraphEvent(
  context: DirectReasoningGraphContext,
  input: DirectReasoningGraphEventInput,
): ExecutionGraphEvent {
  return createExecutionGraphEvent({
    eventId: input.eventId,
    graphId: context.graphId,
    executionId: context.executionId,
    rootExecutionId: context.rootExecutionId,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    requestId: context.requestId,
    runId: context.runId,
    nodeId: context.nodeId,
    nodeKind: context.nodeKind,
    kind: input.kind,
    timestamp: input.timestamp,
    sequence: input.sequence,
    producer: 'brokered_worker',
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.codeSessionId ? { codeSessionId: context.codeSessionId } : {}),
    payload: {
      ...(context.summary ? { summary: context.summary, title: 'Direct reasoning exploration' } : { title: 'Direct reasoning exploration' }),
      ...(input.payload ?? {}),
    },
  });
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
