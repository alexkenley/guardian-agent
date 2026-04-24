import type {
  DashboardRunStatus,
  DashboardRunSummary,
  DashboardRunTimelineItem,
} from '../run-timeline.js';
import type { ExecutionGraphEvent } from './graph-events.js';
import type { ExecutionNodeKind } from './types.js';

export interface ExecutionGraphTimelineProjection {
  runId: string;
  baseStatus?: DashboardRunStatus;
  summary: Partial<DashboardRunSummary>;
  items: DashboardRunTimelineItem[];
}

export function projectExecutionGraphEventToTimeline(
  event: ExecutionGraphEvent,
): ExecutionGraphTimelineProjection | null {
  const runId = normalizeText(event.runId)
    ?? normalizeText(event.requestId)
    ?? normalizeText(event.graphId);
  if (!runId) return null;
  const item = buildGraphTimelineItem(runId, event);
  return {
    runId,
    ...(mapGraphEventToBaseStatus(event) ? { baseStatus: mapGraphEventToBaseStatus(event) } : {}),
    summary: buildGraphSummaryPatch(runId, event),
    items: item ? [item] : [],
  };
}

function buildGraphSummaryPatch(runId: string, event: ExecutionGraphEvent): Partial<DashboardRunSummary> {
  const title = normalizeText(stringPayload(event, 'title'))
    ?? normalizeText(stringPayload(event, 'summary'))
    ?? (event.nodeKind === 'explore_readonly' ? 'Direct reasoning exploration' : 'Execution graph');
  return {
    executionId: event.executionId,
    rootExecutionId: event.rootExecutionId,
    ...(event.parentExecutionId ? { parentExecutionId: event.parentExecutionId } : {}),
    ...(event.channel ? { channel: event.channel } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.codeSessionId ? { codeSessionId: event.codeSessionId } : {}),
    groupId: event.rootExecutionId || event.graphId || runId,
    kind: 'assistant_dispatch',
    title,
    startedAt: event.timestamp,
    tags: [
      'execution-graph',
      ...(event.nodeKind ? [event.nodeKind] : []),
      ...(event.producer ? [event.producer] : []),
    ],
  };
}

function buildGraphTimelineItem(
  runId: string,
  event: ExecutionGraphEvent,
): DashboardRunTimelineItem | null {
  const shared = {
    id: `graph-event:${event.eventId}:${runId}`,
    runId,
    timestamp: event.timestamp,
    source: 'execution_graph' as const,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
  };
  const toolName = normalizeText(stringPayload(event, 'toolName'));
  const detail = buildGraphEventDetail(event);
  switch (event.kind) {
    case 'graph_started':
      return { ...shared, type: 'run_started', status: 'running', title: 'Execution graph started', ...(detail ? { detail } : {}) };
    case 'node_started':
      return { ...shared, type: 'note', status: 'running', title: `${humanizeNodeKind(event.nodeKind)} started`, ...(detail ? { detail } : {}) };
    case 'llm_call_started':
      return { ...shared, type: 'note', status: 'running', title: 'Model call started', ...(detail ? { detail } : {}) };
    case 'llm_call_completed':
      return { ...shared, type: 'note', status: graphEventHasError(event) ? 'failed' : 'succeeded', title: graphEventHasError(event) ? 'Model call failed' : 'Model call completed', ...(detail ? { detail } : {}) };
    case 'tool_call_started':
      return {
        ...shared,
        type: 'tool_call_started',
        status: 'running',
        title: `Tool started: ${humanizeToolName(toolName ?? 'tool')}`,
        ...(detail ? { detail } : {}),
        ...(toolName ? { toolName } : {}),
      };
    case 'tool_call_completed':
      return {
        ...shared,
        type: 'tool_call_completed',
        status: mapToolCompletionStatus(event),
        title: buildToolCompletionTitle(toolName, event),
        ...(detail ? { detail } : {}),
        ...(toolName ? { toolName } : {}),
      };
    case 'artifact_created':
      return { ...shared, type: 'note', status: 'succeeded', title: `Artifact created: ${normalizeText(stringPayload(event, 'artifactType')) ?? 'artifact'}`, ...(detail ? { detail } : {}) };
    case 'approval_requested':
      return { ...shared, type: 'approval_requested', status: 'blocked', title: 'Approval requested', ...(detail ? { detail } : {}), ...(normalizeText(stringPayload(event, 'approvalId')) ? { approvalId: normalizeText(stringPayload(event, 'approvalId')) } : {}) };
    case 'approval_resolved':
      return { ...shared, type: 'approval_resolved', status: graphEventHasError(event) ? 'failed' : 'succeeded', title: graphEventHasError(event) ? 'Approval denied' : 'Approval resolved', ...(detail ? { detail } : {}), ...(normalizeText(stringPayload(event, 'approvalId')) ? { approvalId: normalizeText(stringPayload(event, 'approvalId')) } : {}) };
    case 'verification_completed':
      return { ...shared, type: 'verification_completed', status: mapVerificationStatus(event), title: 'Verification completed', ...(detail ? { detail } : {}) };
    case 'recovery_proposed':
      return { ...shared, type: 'note', status: 'warning', title: 'Recovery proposed', ...(detail ? { detail } : {}) };
    case 'node_completed':
      return { ...shared, type: 'note', status: 'succeeded', title: `${humanizeNodeKind(event.nodeKind)} completed`, ...(detail ? { detail } : {}) };
    case 'node_failed':
      return { ...shared, type: 'note', status: 'failed', title: `${humanizeNodeKind(event.nodeKind)} failed`, ...(detail ? { detail } : {}) };
    case 'graph_completed':
      return { ...shared, type: 'run_completed', status: 'succeeded', title: 'Execution graph completed', ...(detail ? { detail } : {}) };
    case 'graph_failed':
      return { ...shared, type: 'run_failed', status: 'failed', title: 'Execution graph failed', ...(detail ? { detail } : {}) };
  }
}

function mapGraphEventToBaseStatus(event: ExecutionGraphEvent): DashboardRunStatus | undefined {
  switch (event.kind) {
    case 'graph_started':
    case 'node_started':
    case 'llm_call_started':
    case 'tool_call_started':
      return 'running';
    case 'approval_requested':
      return 'awaiting_approval';
    case 'graph_completed':
      return 'completed';
    case 'graph_failed':
      return 'failed';
    default:
      return undefined;
  }
}

function buildGraphEventDetail(event: ExecutionGraphEvent): string | undefined {
  const parts = [
    normalizeText(stringPayload(event, 'argsPreview')),
    normalizeText(stringPayload(event, 'resultPreview')),
    normalizeText(stringPayload(event, 'resultMessage')),
    normalizeText(stringPayload(event, 'errorMessage')),
    normalizeText(stringPayload(event, 'summary')),
    normalizeText(stringPayload(event, 'preview')),
  ].filter((value): value is string => !!value);
  return truncateText(parts.join('\n'), 220);
}

function buildToolCompletionTitle(toolName: string | undefined, event: ExecutionGraphEvent): string {
  const humanized = humanizeToolName(toolName ?? 'tool');
  const status = normalizeText(stringPayload(event, 'resultStatus'))?.toLowerCase();
  if (graphEventHasError(event) || status === 'failed' || status === 'error' || status === 'denied') {
    return `Tool failed: ${humanized}`;
  }
  if (status === 'pending_approval' || status === 'blocked') {
    return `Tool blocked: ${humanized}`;
  }
  return `Tool completed: ${humanized}`;
}

function mapToolCompletionStatus(event: ExecutionGraphEvent): DashboardRunTimelineItem['status'] {
  const status = normalizeText(stringPayload(event, 'resultStatus'))?.toLowerCase();
  if (status === 'pending_approval' || status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'error' || status === 'denied' || graphEventHasError(event)) return 'failed';
  return 'succeeded';
}

function mapVerificationStatus(event: ExecutionGraphEvent): DashboardRunTimelineItem['status'] {
  const decision = normalizeText(stringPayload(event, 'decision'))?.toLowerCase();
  if (decision === 'satisfied' || decision === 'passed') return 'succeeded';
  if (decision === 'blocked' || decision === 'policy_blocked') return 'blocked';
  if (decision === 'insufficient' || decision === 'warning') return 'warning';
  if (decision === 'failed' || decision === 'contradicted') return 'failed';
  return graphEventHasError(event) ? 'failed' : 'succeeded';
}

function graphEventHasError(event: ExecutionGraphEvent): boolean {
  return !!normalizeText(stringPayload(event, 'errorMessage'));
}

function humanizeNodeKind(kind: ExecutionNodeKind | undefined): string {
  switch (kind) {
    case 'explore_readonly':
      return 'Read-only exploration';
    case 'approval_interrupt':
      return 'Approval interrupt';
    case 'delegated_worker':
      return 'Delegated worker';
    case 'classify':
      return 'Classification';
    case 'plan':
      return 'Plan';
    case 'synthesize':
      return 'Synthesis';
    case 'mutate':
      return 'Mutation';
    case 'verify':
      return 'Verification';
    case 'recover':
      return 'Recovery';
    case 'finalize':
      return 'Finalization';
    default:
      return 'Graph node';
  }
}

function humanizeToolName(value: string): string {
  return value
    .replace(/^mcp-[^-]+-/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringPayload(event: ExecutionGraphEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function truncateText(value: string, maxChars: number): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
