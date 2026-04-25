import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { isExecutionGraphEvent, type ExecutionGraphEvent } from './graph-events.js';
import {
  ExecutionArtifactStore,
  artifactRefFromArtifact,
  type ExecutionArtifact,
} from './graph-artifacts.js';

export interface ExecutionGraphStoreOptions {
  maxGraphs?: number;
  maxEventsPerGraph?: number;
  maxArtifactsPerGraph?: number;
  maxCheckpointsPerGraph?: number;
  checkpointIntervalEvents?: number;
  persistPath?: string;
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
const DEFAULT_MAX_ARTIFACTS_PER_GRAPH = 500;
const DEFAULT_MAX_CHECKPOINTS_PER_GRAPH = 50;
const DEFAULT_CHECKPOINT_INTERVAL_EVENTS = 25;
const PERSISTENCE_VERSION = 1;

interface PersistedExecutionGraphSnapshot {
  graph: ExecutionGraph;
  events: ExecutionGraphEvent[];
  artifacts: ExecutionArtifact[];
}

export class ExecutionGraphStore {
  private readonly graphs = new Map<string, ExecutionGraph>();
  private readonly events = new Map<string, ExecutionGraphEvent[]>();
  private readonly artifacts = new Map<string, ExecutionArtifactStore>();
  private readonly maxGraphs: number;
  private readonly maxEventsPerGraph: number;
  private readonly maxArtifactsPerGraph: number;
  private readonly maxCheckpointsPerGraph: number;
  private readonly checkpointIntervalEvents: number;
  private readonly persistPath?: string;
  private readonly now: () => number;

  constructor(options: ExecutionGraphStoreOptions = {}) {
    this.maxGraphs = Math.max(1, options.maxGraphs ?? DEFAULT_MAX_GRAPHS);
    this.maxEventsPerGraph = Math.max(1, options.maxEventsPerGraph ?? DEFAULT_MAX_EVENTS_PER_GRAPH);
    this.maxArtifactsPerGraph = Math.max(1, options.maxArtifactsPerGraph ?? DEFAULT_MAX_ARTIFACTS_PER_GRAPH);
    this.maxCheckpointsPerGraph = Math.max(1, options.maxCheckpointsPerGraph ?? DEFAULT_MAX_CHECKPOINTS_PER_GRAPH);
    this.checkpointIntervalEvents = Math.max(1, options.checkpointIntervalEvents ?? DEFAULT_CHECKPOINT_INTERVAL_EVENTS);
    this.persistPath = options.persistPath?.trim() || undefined;
    this.now = options.now ?? Date.now;
    this.loadPersistedState();
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
    this.artifacts.set(graphId, new ExecutionArtifactStore({ maxArtifacts: this.maxArtifactsPerGraph }));
    this.prune();
    this.persist();
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
    this.persist();
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
    this.persist();
    return cloneArtifact(artifact);
  }

  writeArtifact<TContent extends ExecutionArtifact['content']>(
    artifact: ExecutionArtifact<TContent>,
  ): ExecutionArtifact<TContent> | null {
    const graph = this.graphs.get(artifact.graphId.trim());
    if (!graph) return null;
    const store = this.artifacts.get(graph.graphId)
      ?? new ExecutionArtifactStore({ maxArtifacts: this.maxArtifactsPerGraph });
    this.artifacts.set(graph.graphId, store);
    const written = store.writeArtifact(artifact);
    graph.artifacts = store.listArtifacts()
      .map(artifactRefFromArtifact)
      .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId));
    graph.updatedAt = Math.max(graph.updatedAt, written.createdAt);
    this.prune();
    this.persist();
    return written;
  }

  getArtifact(graphId: string, artifactId: string): ExecutionArtifact | null {
    const graph = this.graphs.get(graphId.trim());
    if (!graph) return null;
    return this.artifacts.get(graph.graphId)?.getArtifact(artifactId) ?? null;
  }

  listArtifacts(graphId: string): ExecutionArtifact[] {
    const graph = this.graphs.get(graphId.trim());
    if (!graph) return [];
    return this.artifacts.get(graph.graphId)?.listArtifacts() ?? [];
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
      this.artifacts.delete(graph.graphId);
    }
  }

  private loadPersistedState(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: number; graphs?: unknown[] };
      if (parsed.version !== PERSISTENCE_VERSION || !Array.isArray(parsed.graphs)) {
        return;
      }
      for (const item of parsed.graphs) {
        const snapshot = normalizePersistedSnapshot(item, this.maxEventsPerGraph, this.maxArtifactsPerGraph);
        if (!snapshot) continue;
        this.graphs.set(snapshot.graph.graphId, cloneGraph(snapshot.graph));
        this.events.set(snapshot.graph.graphId, snapshot.events.map(cloneEvent));
        const artifactStore = new ExecutionArtifactStore({ maxArtifacts: this.maxArtifactsPerGraph });
        for (const artifact of snapshot.artifacts) {
          artifactStore.writeArtifact(artifact);
        }
        this.artifacts.set(snapshot.graph.graphId, artifactStore);
      }
      this.prune();
    } catch {
      this.graphs.clear();
      this.events.clear();
      this.artifacts.clear();
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const graphs = this.listGraphs(this.maxGraphs)
      .map((graph) => ({
        graph,
        events: (this.events.get(graph.graphId) ?? []).map(cloneEvent),
        artifacts: this.artifacts.get(graph.graphId)?.listArtifacts() ?? [],
      }));
    const payload = JSON.stringify({
      version: PERSISTENCE_VERSION,
      graphs,
    }, null, 2);
    const tmpPath = `${this.persistPath}.tmp`;
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, this.persistPath);
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
    case 'clarification_requested':
      graph.status = 'awaiting_clarification';
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
    case 'clarification_requested':
      return 'awaiting_clarification';
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
    case 'clarification_requested':
      return 'clarification_interrupt';
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

function normalizePersistedSnapshot(
  value: unknown,
  maxEventsPerGraph: number,
  maxArtifactsPerGraph: number,
): PersistedExecutionGraphSnapshot | null {
  if (!isRecord(value)) return null;
  const graph = normalizePersistedGraph(value.graph);
  if (!graph) return null;
  const events = (Array.isArray(value.events) ? value.events : [])
    .filter(isExecutionGraphEvent)
    .filter((event) => event.graphId === graph.graphId)
    .sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId))
    .slice(-maxEventsPerGraph)
    .map(cloneEvent);
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : [])
    .map(normalizePersistedArtifact)
    .filter((artifact): artifact is ExecutionArtifact => !!artifact && artifact.graphId === graph.graphId)
    .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId))
    .slice(-maxArtifactsPerGraph);
  graph.artifacts = artifacts
    .map(artifactRefFromArtifact)
    .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId));
  return { graph, events, artifacts };
}

function normalizePersistedGraph(value: unknown): ExecutionGraph | null {
  if (!isRecord(value)) return null;
  const graphId = readString(value.graphId);
  const executionId = readString(value.executionId);
  const rootExecutionId = readString(value.rootExecutionId) || executionId;
  const requestId = readString(value.requestId);
  const createdAt = readFiniteNumber(value.createdAt);
  const updatedAt = readFiniteNumber(value.updatedAt);
  const intent = normalizePersistedIntent(value.intent);
  if (!graphId || !executionId || !rootExecutionId || !requestId || createdAt === null || updatedAt === null || !intent) {
    return null;
  }
  return {
    graphId,
    executionId,
    rootExecutionId,
    ...(readString(value.parentExecutionId) ? { parentExecutionId: readString(value.parentExecutionId) } : {}),
    requestId,
    ...(readString(value.runId) ? { runId: readString(value.runId) } : {}),
    createdAt,
    updatedAt,
    status: normalizeGraphStatus(value.status),
    intent,
    securityContext: normalizeSecurityContext(value.securityContext),
    trigger: normalizeTrigger(value.trigger),
    nodes: (Array.isArray(value.nodes) ? value.nodes : [])
      .map((node) => normalizeNode(node, graphId))
      .filter((node): node is ExecutionNode => !!node),
    edges: (Array.isArray(value.edges) ? value.edges : [])
      .map((edge) => normalizeEdge(edge, graphId))
      .filter((edge): edge is ExecutionEdge => !!edge),
    artifacts: [],
    checkpoints: (Array.isArray(value.checkpoints) ? value.checkpoints : [])
      .map((checkpoint) => normalizeCheckpoint(checkpoint, graphId))
      .filter((checkpoint): checkpoint is ExecutionCheckpointRef => !!checkpoint),
  };
}

function normalizePersistedIntent(value: unknown): IntentGatewayDecision | null {
  if (!isRecord(value)) return null;
  const route = readString(value.route);
  const confidence = readString(value.confidence);
  const operation = readString(value.operation);
  const summary = readString(value.summary);
  const turnRelation = readString(value.turnRelation);
  const resolution = readString(value.resolution);
  if (!route || !confidence || !operation || !summary || !turnRelation || !resolution) return null;
  return {
    ...value,
    route,
    confidence,
    operation,
    summary,
    turnRelation,
    resolution,
    missingFields: readStringArray(value.missingFields),
    entities: isRecord(value.entities) ? { ...value.entities } : {},
  } as unknown as IntentGatewayDecision;
}

function normalizeSecurityContext(value: unknown): ExecutionSecurityContext {
  if (!isRecord(value)) return {};
  const agentIdentity = isRecord(value.agentIdentity)
    ? {
        agentId: readString(value.agentIdentity.agentId),
        ...(readString(value.agentIdentity.registryEntryId) ? { registryEntryId: readString(value.agentIdentity.registryEntryId) } : {}),
        ...(readString(value.agentIdentity.version) ? { version: readString(value.agentIdentity.version) } : {}),
        ...(readString(value.agentIdentity.policySetId) ? { policySetId: readString(value.agentIdentity.policySetId) } : {}),
        ...(readStringArray(value.agentIdentity.allowedMemoryScopes).length > 0
          ? { allowedMemoryScopes: readStringArray(value.agentIdentity.allowedMemoryScopes) }
          : {}),
      }
    : null;
  return {
    ...(readString(value.agentId) ? { agentId: readString(value.agentId) } : {}),
    ...(readString(value.userId) ? { userId: readString(value.userId) } : {}),
    ...(readString(value.channel) ? { channel: readString(value.channel) } : {}),
    ...(readString(value.surfaceId) ? { surfaceId: readString(value.surfaceId) } : {}),
    ...(readString(value.codeSessionId) ? { codeSessionId: readString(value.codeSessionId) } : {}),
    ...(agentIdentity?.agentId ? { agentIdentity: agentIdentity as ExecutionSecurityContext['agentIdentity'] } : {}),
    ...(value.contentTrustLevel === 'trusted' || value.contentTrustLevel === 'low_trust' || value.contentTrustLevel === 'quarantined'
      ? { contentTrustLevel: value.contentTrustLevel }
      : {}),
    ...(readStringArray(value.taintReasons).length > 0 ? { taintReasons: readStringArray(value.taintReasons) } : {}),
  };
}

function normalizeTrigger(value: unknown): ExecutionGraphTrigger {
  if (!isRecord(value)) return { type: 'user_request' };
  const type = value.type === 'manual' || value.type === 'scheduled' || value.type === 'event'
    ? value.type
    : 'user_request';
  return {
    type,
    ...(readString(value.source) ? { source: readString(value.source) } : {}),
    ...(readString(value.sourceId) ? { sourceId: readString(value.sourceId) } : {}),
  };
}

function normalizeNode(value: unknown, graphId: string): ExecutionNode | null {
  if (!isRecord(value)) return null;
  const nodeId = readString(value.nodeId);
  const kind = normalizeNodeKind(value.kind);
  const title = readString(value.title);
  if (!nodeId || !kind || !title) return null;
  return {
    nodeId,
    graphId,
    kind,
    status: normalizeNodeStatus(value.status),
    title,
    requiredInputIds: readStringArray(value.requiredInputIds),
    outputArtifactTypes: readStringArray(value.outputArtifactTypes)
      .filter(isExecutionArtifactType) as ExecutionNode['outputArtifactTypes'],
    allowedToolCategories: readStringArray(value.allowedToolCategories),
    ...(value.approvalPolicy === 'none' || value.approvalPolicy === 'if_required' || value.approvalPolicy === 'always'
      ? { approvalPolicy: value.approvalPolicy }
      : {}),
    ...(value.checkpointPolicy === 'phase_boundary' || value.checkpointPolicy === 'interval' || value.checkpointPolicy === 'terminal_only'
      ? { checkpointPolicy: value.checkpointPolicy }
      : {}),
    ...(readString(value.executionProfileName) ? { executionProfileName: readString(value.executionProfileName) } : {}),
    ...(readString(value.ownerAgentId) ? { ownerAgentId: readString(value.ownerAgentId) } : {}),
    ...(readString(value.policySetId) ? { policySetId: readString(value.policySetId) } : {}),
    ...(readFiniteNumber(value.timeoutMs) !== null ? { timeoutMs: readFiniteNumber(value.timeoutMs)! } : {}),
    ...(readFiniteNumber(value.retryLimit) !== null ? { retryLimit: readFiniteNumber(value.retryLimit)! } : {}),
    ...(readFiniteNumber(value.startedAt) !== null ? { startedAt: readFiniteNumber(value.startedAt)! } : {}),
    ...(readFiniteNumber(value.completedAt) !== null ? { completedAt: readFiniteNumber(value.completedAt)! } : {}),
    ...(readString(value.terminalReason) ? { terminalReason: readString(value.terminalReason) } : {}),
  };
}

function normalizeEdge(value: unknown, graphId: string): ExecutionEdge | null {
  if (!isRecord(value)) return null;
  const edgeId = readString(value.edgeId);
  const fromNodeId = readString(value.fromNodeId);
  const toNodeId = readString(value.toNodeId);
  if (!edgeId || !fromNodeId || !toNodeId) return null;
  return {
    edgeId,
    graphId,
    fromNodeId,
    toNodeId,
    ...(readStringArray(value.artifactIds).length > 0 ? { artifactIds: readStringArray(value.artifactIds) } : {}),
  };
}

function normalizeCheckpoint(value: unknown, graphId: string): ExecutionCheckpointRef | null {
  if (!isRecord(value)) return null;
  const checkpointId = readString(value.checkpointId);
  const eventId = readString(value.eventId);
  const sequence = readFiniteNumber(value.sequence);
  const createdAt = readFiniteNumber(value.createdAt);
  const reason = value.reason === 'approval_interrupt'
    || value.reason === 'clarification_interrupt'
    || value.reason === 'terminal'
    || value.reason === 'interval'
    ? value.reason
    : value.reason === 'phase_boundary'
      ? 'phase_boundary'
      : null;
  if (!checkpointId || !eventId || sequence === null || createdAt === null || !reason) return null;
  return {
    checkpointId,
    graphId,
    eventId,
    sequence,
    reason,
    status: normalizeGraphStatus(value.status),
    createdAt,
  };
}

function normalizePersistedArtifact(value: unknown): ExecutionArtifact | null {
  if (!isRecord(value) || !isRecord(value.content)) return null;
  const artifactId = readString(value.artifactId);
  const graphId = readString(value.graphId);
  const nodeId = readString(value.nodeId);
  const artifactType = readString(value.artifactType);
  const label = readString(value.label);
  const createdAt = readFiniteNumber(value.createdAt);
  if (!artifactId || !graphId || !nodeId || !isExecutionArtifactType(artifactType) || !label || createdAt === null) {
    return null;
  }
  return {
    artifactId,
    graphId,
    nodeId,
    artifactType,
    label,
    ...(readString(value.preview) ? { preview: readString(value.preview) } : {}),
    refs: readStringArray(value.refs),
    trustLevel: value.trustLevel === 'low_trust' || value.trustLevel === 'quarantined' ? value.trustLevel : 'trusted',
    taintReasons: readStringArray(value.taintReasons),
    redactionPolicy: readString(value.redactionPolicy) || 'unspecified',
    content: clonePlainRecord(value.content),
    createdAt,
  };
}

function normalizeGraphStatus(value: unknown): ExecutionGraph['status'] {
  switch (value) {
    case 'pending':
    case 'running':
    case 'awaiting_approval':
    case 'awaiting_clarification':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'pending';
  }
}

function normalizeNodeStatus(value: unknown): ExecutionNodeStatus {
  switch (value) {
    case 'pending':
    case 'running':
    case 'awaiting_approval':
    case 'awaiting_clarification':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'pending';
  }
}

function normalizeNodeKind(value: unknown): ExecutionNode['kind'] | null {
  switch (value) {
    case 'classify':
    case 'plan':
    case 'explore_readonly':
    case 'synthesize':
    case 'mutate':
    case 'approval_interrupt':
    case 'delegated_worker':
    case 'verify':
    case 'recover':
    case 'finalize':
      return value;
    default:
      return null;
  }
}

function isExecutionArtifactType(value: string): value is ExecutionArtifact['artifactType'] {
  switch (value) {
    case 'SearchResultSet':
    case 'FileReadSet':
    case 'EvidenceLedger':
    case 'SynthesisDraft':
    case 'WriteSpec':
    case 'MutationReceipt':
    case 'VerificationResult':
    case 'RecoveryProposal':
      return true;
    default:
      return false;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    : [];
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clonePlainRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
