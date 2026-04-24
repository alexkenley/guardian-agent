import { randomUUID } from 'node:crypto';
import type { IntentGatewayDecision } from '../intent/types.js';
import type {
  ExecutionArtifactRef,
  ExecutionCheckpointRef,
  ExecutionEdge,
  ExecutionGraph,
  ExecutionGraphTrigger,
  ExecutionNode,
  ExecutionNodeStatus,
  ExecutionSecurityContext,
} from './types.js';
import type { ExecutionGraphEvent } from './graph-events.js';

export interface ExecutionGraphStoreOptions {
  maxGraphs?: number;
  maxEventsPerGraph?: number;
  maxCheckpointsPerGraph?: number;
  checkpointIntervalEvents?: number;
  now?: () => number;
}

export interface CreateExecutionGraphInput {
  graphId?: string;
  executionId: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  intent: IntentGatewayDecision;
  securityContext?: ExecutionSecurityContext;
  trigger?: ExecutionGraphTrigger;
  nodes?: ExecutionNode[];
  edges?: ExecutionEdge[];
}

export interface ExecutionGraphSnapshot {
  graph: ExecutionGraph;
  events: ExecutionGraphEvent[];
}

const DEFAULT_MAX_GRAPHS = 200;
const DEFAULT_MAX_EVENTS_PER_GRAPH = 500;
const DEFAULT_MAX_CHECKPOINTS_PER_GRAPH = 50;
const DEFAULT_CHECKPOINT_INTERVAL_EVENTS = 25;

export class ExecutionGraphStore {
  private readonly graphs = new Map<string, ExecutionGraph>();
  private readonly events = new Map<string, ExecutionGraphEvent[]>();
  private readonly maxGraphs: number;
  private readonly maxEventsPerGraph: number;
  private readonly maxCheckpointsPerGraph: number;
  private readonly checkpointIntervalEvents: number;
  private readonly now: () => number;

  constructor(options: ExecutionGraphStoreOptions = {}) {
    this.maxGraphs = Math.max(1, options.maxGraphs ?? DEFAULT_MAX_GRAPHS);
    this.maxEventsPerGraph = Math.max(1, options.maxEventsPerGraph ?? DEFAULT_MAX_EVENTS_PER_GRAPH);
    this.maxCheckpointsPerGraph = Math.max(1, options.maxCheckpointsPerGraph ?? DEFAULT_MAX_CHECKPOINTS_PER_GRAPH);
    this.checkpointIntervalEvents = Math.max(1, options.checkpointIntervalEvents ?? DEFAULT_CHECKPOINT_INTERVAL_EVENTS);
    this.now = options.now ?? Date.now;
  }

  createGraph(input: CreateExecutionGraphInput): ExecutionGraph {
    const timestamp = this.now();
    const graphId = input.graphId?.trim() || `graph:${randomUUID()}`;
    const graph: ExecutionGraph = {
      graphId,
      executionId: input.executionId,
      rootExecutionId: input.rootExecutionId ?? input.executionId,
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
      requestId: input.requestId,
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'pending',
      intent: cloneIntent(input.intent),
      securityContext: cloneSecurityContext(input.securityContext ?? {}),
      trigger: input.trigger ? { ...input.trigger } : { type: 'user_request' },
      nodes: (input.nodes ?? []).map((node) => ({ ...node, requiredInputIds: [...node.requiredInputIds], outputArtifactTypes: [...node.outputArtifactTypes], allowedToolCategories: [...node.allowedToolCategories] })),
      edges: (input.edges ?? []).map((edge) => ({ ...edge, artifactIds: edge.artifactIds ? [...edge.artifactIds] : undefined })),
      artifacts: [],
      checkpoints: [],
    };
    this.graphs.set(graphId, graph);
    this.events.set(graphId, []);
    this.prune();
    return cloneGraph(graph);
  }

  getGraph(graphId: string): ExecutionGraph | null {
    const graph = this.graphs.get(graphId.trim());
    return graph ? cloneGraph(graph) : null;
  }

  getSnapshot(graphId: string): ExecutionGraphSnapshot | null {
    const graph = this.graphs.get(graphId.trim());
    if (!graph) return null;
    return {
      graph: cloneGraph(graph),
      events: (this.events.get(graph.graphId) ?? []).map(cloneEvent),
    };
  }

  listGraphs(limit = 20): ExecutionGraph[] {
    return [...this.graphs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.graphId.localeCompare(right.graphId))
      .slice(0, Math.max(1, limit))
      .map(cloneGraph);
  }

  appendEvent(event: ExecutionGraphEvent): ExecutionGraphEvent | null {
    const graph = this.graphs.get(event.graphId);
    if (!graph) {
      return null;
    }
    const existingEvents = this.events.get(event.graphId) ?? [];
    const nextEvents = [...existingEvents.filter((entry) => entry.eventId !== event.eventId), cloneEvent(event)]
      .sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId));
    this.events.set(event.graphId, nextEvents.slice(Math.max(0, nextEvents.length - this.maxEventsPerGraph)));
    applyEventToGraph(graph, event);
    const checkpointReason = getCheckpointReason(event, nextEvents.length, this.checkpointIntervalEvents);
    if (checkpointReason) {
      this.addCheckpoint(graph, event, checkpointReason);
    }
    graph.updatedAt = Math.max(graph.updatedAt, event.timestamp);
    this.prune();
    return cloneEvent(event);
  }

  appendArtifactRef(graphId: string, artifact: ExecutionArtifactRef): ExecutionArtifactRef | null {
    const graph = this.graphs.get(graphId.trim());
    if (!graph) return null;
    graph.artifacts = [
      ...graph.artifacts.filter((entry) => entry.artifactId !== artifact.artifactId),
      cloneArtifact(artifact),
    ].sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId));
    graph.updatedAt = Math.max(graph.updatedAt, artifact.createdAt);
    this.prune();
    return cloneArtifact(artifact);
  }

  private addCheckpoint(
    graph: ExecutionGraph,
    event: ExecutionGraphEvent,
    reason: ExecutionCheckpointRef['reason'],
  ): void {
    const checkpoint: ExecutionCheckpointRef = {
      checkpointId: `checkpoint:${event.eventId}`,
      graphId: graph.graphId,
      eventId: event.eventId,
      sequence: event.sequence,
      reason,
      status: graph.status,
      createdAt: event.timestamp,
    };
    graph.checkpoints = [...graph.checkpoints, checkpoint]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-this.maxCheckpointsPerGraph);
  }

  private prune(): void {
    const sorted = [...this.graphs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.graphId.localeCompare(right.graphId));
    for (const graph of sorted.slice(this.maxGraphs)) {
      this.graphs.delete(graph.graphId);
      this.events.delete(graph.graphId);
    }
  }
}

function applyEventToGraph(graph: ExecutionGraph, event: ExecutionGraphEvent): void {
  switch (event.kind) {
    case 'graph_started':
      graph.status = 'running';
      break;
    case 'approval_requested':
      graph.status = 'awaiting_approval';
      break;
    case 'graph_completed':
      graph.status = 'completed';
      break;
    case 'graph_failed':
      graph.status = 'failed';
      break;
    default:
      break;
  }

  if (event.nodeId) {
    const node = graph.nodes.find((entry) => entry.nodeId === event.nodeId);
    if (node) {
      const status = mapEventToNodeStatus(event);
      if (status) node.status = status;
      if (event.kind === 'node_started') node.startedAt = event.timestamp;
      if (event.kind === 'node_completed' || event.kind === 'node_failed') {
        node.completedAt = event.timestamp;
        const reason = typeof event.payload.reason === 'string' ? event.payload.reason.trim() : '';
        if (reason) node.terminalReason = reason;
      }
    }
  }
}

function mapEventToNodeStatus(event: ExecutionGraphEvent): ExecutionNodeStatus | null {
  switch (event.kind) {
    case 'node_started':
      return 'running';
    case 'approval_requested':
      return 'awaiting_approval';
    case 'node_completed':
      return 'completed';
    case 'node_failed':
      return 'failed';
    default:
      return null;
  }
}

function cloneGraph(graph: ExecutionGraph): ExecutionGraph {
  return {
    ...graph,
    intent: cloneIntent(graph.intent),
    securityContext: cloneSecurityContext(graph.securityContext),
    trigger: { ...graph.trigger },
    nodes: graph.nodes.map((node) => ({
      ...node,
      requiredInputIds: [...node.requiredInputIds],
      outputArtifactTypes: [...node.outputArtifactTypes],
      allowedToolCategories: [...node.allowedToolCategories],
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      artifactIds: edge.artifactIds ? [...edge.artifactIds] : undefined,
    })),
    artifacts: graph.artifacts.map(cloneArtifact),
    checkpoints: graph.checkpoints.map((checkpoint) => ({ ...checkpoint })),
  };
}

function getCheckpointReason(
  event: ExecutionGraphEvent,
  eventCount: number,
  interval: number,
): ExecutionCheckpointRef['reason'] | null {
  switch (event.kind) {
    case 'graph_started':
    case 'node_completed':
    case 'node_failed':
      return 'phase_boundary';
    case 'approval_requested':
      return 'approval_interrupt';
    case 'graph_completed':
    case 'graph_failed':
      return 'terminal';
    default:
      return eventCount % interval === 0 ? 'interval' : null;
  }
}

function cloneArtifact(artifact: ExecutionArtifactRef): ExecutionArtifactRef {
  return {
    ...artifact,
    ...(artifact.taintReasons ? { taintReasons: [...artifact.taintReasons] } : {}),
  };
}

function cloneEvent(event: ExecutionGraphEvent): ExecutionGraphEvent {
  return {
    ...event,
    payload: { ...event.payload },
  };
}

function cloneSecurityContext(context: ExecutionSecurityContext): ExecutionSecurityContext {
  return {
    ...context,
    ...(context.agentIdentity
      ? {
          agentIdentity: {
            ...context.agentIdentity,
            ...(context.agentIdentity.allowedMemoryScopes
              ? { allowedMemoryScopes: [...context.agentIdentity.allowedMemoryScopes] }
              : {}),
          },
        }
      : {}),
    ...(context.taintReasons ? { taintReasons: [...context.taintReasons] } : {}),
  };
}

function cloneIntent(intent: IntentGatewayDecision): IntentGatewayDecision {
  return {
    ...intent,
    missingFields: [...intent.missingFields],
    entities: { ...intent.entities },
    ...(intent.plannedSteps ? { plannedSteps: intent.plannedSteps.map((step) => ({ ...step, expectedToolCategories: step.expectedToolCategories ? [...step.expectedToolCategories] : undefined, dependsOn: step.dependsOn ? [...step.dependsOn] : undefined })) } : {}),
    ...(intent.provenance ? { provenance: { ...intent.provenance, entities: intent.provenance.entities ? { ...intent.provenance.entities } : undefined } } : {}),
  };
}
