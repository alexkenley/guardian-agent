import type { AuditEvent, AuditFilter } from '../../guardian/audit-log.js';
import type {
  IntentRoutingTraceEntry,
  IntentRoutingTraceListOptions,
  IntentRoutingTraceLog,
  IntentRoutingTraceStage,
} from '../intent-routing-trace.js';
import { redactSensitiveText, redactSensitiveValue } from '../../util/crypto-guardrails.js';

const DEFAULT_TRACE_LIMIT = 80;
const DEFAULT_AUDIT_LIMIT = 30;
const MAX_TRACE_LIMIT = 200;
const MAX_AUDIT_LIMIT = 100;
const PREVIEW_CHARS = 220;

export type DiagnosticsEvidenceTarget =
  | 'latest_completed_request'
  | 'latest_request'
  | 'current_request'
  | 'recent_window'
  | 'request_id';

export interface DiagnosticsEvidenceInput {
  target?: DiagnosticsEvidenceTarget;
  requestId?: string;
  channel?: string;
  userId?: string;
  traceLimit?: number;
  auditLimit?: number;
  includeAudit?: boolean;
}

export interface DiagnosticsEvidenceDependencies {
  intentRoutingTrace?: Pick<IntentRoutingTraceLog, 'getStatus' | 'listRecent'>;
  auditLog?: {
    query(filter: AuditFilter): AuditEvent[];
  };
}

export interface DiagnosticsToolCallEvidence {
  toolName: string;
  stage: string;
  status?: string;
}

export interface DiagnosticsGuardianEventEvidence {
  type: string;
  severity: string;
  controller?: string;
  reason?: string;
}

export interface DiagnosticsEvidence {
  target: DiagnosticsEvidenceTarget;
  traceEnabled: boolean;
  traceFilePath?: string;
  requestIds: string[];
  entries: IntentRoutingTraceEntry[];
  entriesAnalyzed: number;
  auditEventsAnalyzed: number;
  stages: Record<string, number>;
  latestUserRequest?: string;
  latestAssistantResponse?: string;
  blockers: string[];
  toolCalls: DiagnosticsToolCallEvidence[];
  guardianEvents: DiagnosticsGuardianEventEvidence[];
}

interface TraceGroup {
  requestId: string;
  latestTimestamp: number;
  entries: IntentRoutingTraceEntry[];
}

export function clampDiagnosticsNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(max, Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(max, parsed));
    }
  }
  return fallback;
}

export function cleanDiagnosticsText(value: unknown): string {
  return typeof value === 'string'
    ? redactSensitiveText(value).replace(/\s+/g, ' ').trim()
    : '';
}

export function previewDiagnosticsText(value: unknown, maxChars = PREVIEW_CHARS): string {
  const cleaned = cleanDiagnosticsText(value);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}...`;
}

export function asDiagnosticsRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stageCount(entries: IntentRoutingTraceEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
  }
  return counts;
}

function pickLatestContentPreview(entries: IntentRoutingTraceEntry[], stage?: IntentRoutingTraceStage): string | undefined {
  const filtered = stage ? entries.filter((entry) => entry.stage === stage) : entries;
  const match = filtered
    .filter((entry) => cleanDiagnosticsText(entry.contentPreview))
    .sort((left, right) => right.timestamp - left.timestamp)[0];
  return match ? previewDiagnosticsText(match.contentPreview) : undefined;
}

function extractAssistantResponse(entries: IntentRoutingTraceEntry[]): string | undefined {
  for (const entry of [...entries].sort((left, right) => right.timestamp - left.timestamp)) {
    if (entry.stage !== 'dispatch_response') continue;
    const details = asDiagnosticsRecord(entry.details);
    const responsePreview = previewDiagnosticsText(details?.responsePreview ?? details?.contentPreview ?? details?.message);
    if (responsePreview) return responsePreview;
    const contentPreview = previewDiagnosticsText(entry.contentPreview);
    if (contentPreview) return contentPreview;
  }
  return undefined;
}

function groupEntries(entries: IntentRoutingTraceEntry[]): TraceGroup[] {
  const byRequest = new Map<string, IntentRoutingTraceEntry[]>();
  for (const entry of entries) {
    const id = cleanDiagnosticsText(entry.requestId);
    if (!id) continue;
    const bucket = byRequest.get(id) ?? [];
    bucket.push(entry);
    byRequest.set(id, bucket);
  }
  return [...byRequest.entries()]
    .map(([requestId, groupEntriesForRequest]) => ({
      requestId,
      entries: groupEntriesForRequest.sort((left, right) => left.timestamp - right.timestamp),
      latestTimestamp: Math.max(...groupEntriesForRequest.map((entry) => entry.timestamp)),
    }))
    .sort((left, right) => right.latestTimestamp - left.latestTimestamp);
}

function selectTraceEntries(
  entries: IntentRoutingTraceEntry[],
  input: DiagnosticsEvidenceInput,
  currentRequestId?: string,
): { target: DiagnosticsEvidenceTarget; selected: IntentRoutingTraceEntry[] } {
  const requestedTarget = input.target ?? (input.requestId ? 'request_id' : 'latest_completed_request');
  const explicitRequestId = cleanDiagnosticsText(input.requestId);
  if (requestedTarget === 'request_id') {
    return {
      target: 'request_id',
      selected: explicitRequestId ? entries.filter((entry) => entry.requestId === explicitRequestId) : [],
    };
  }
  if (requestedTarget === 'current_request') {
    const targetId = explicitRequestId || cleanDiagnosticsText(currentRequestId);
    return {
      target: 'current_request',
      selected: targetId ? entries.filter((entry) => entry.requestId === targetId) : [],
    };
  }
  if (requestedTarget === 'recent_window') {
    return { target: 'recent_window', selected: entries };
  }

  const groups = groupEntries(entries);
  const current = cleanDiagnosticsText(currentRequestId);
  if (requestedTarget === 'latest_request') {
    const latest = groups.find((group) => group.requestId !== current);
    return {
      target: 'latest_request',
      selected: latest?.entries ?? entries.filter((entry) => cleanDiagnosticsText(entry.requestId) !== current).slice(-20),
    };
  }

  const completed = groups.find((group) => (
    group.requestId !== current
    && group.entries.some((entry) => entry.stage === 'dispatch_response')
  )) ?? groups.find((group) => group.requestId !== current);
  return {
    target: 'latest_completed_request',
    selected: completed?.entries ?? [],
  };
}

function extractBlockers(entries: IntentRoutingTraceEntry[]): string[] {
  const blockers: string[] = [];
  for (const entry of entries) {
    if (
      entry.stage !== 'clarification_requested'
      && entry.stage !== 'delegated_worker_failed'
      && entry.stage !== 'delegated_job_wait_expired'
      && entry.stage !== 'direct_reasoning_failed'
      && entry.stage !== 'gateway_classification_failed'
    ) {
      continue;
    }
    const details = asDiagnosticsRecord(entry.details);
    const reason = previewDiagnosticsText(details?.reason ?? details?.summary ?? details?.prompt ?? details?.message ?? entry.contentPreview);
    blockers.push(reason || entry.stage);
  }
  return [...new Set(blockers)].slice(0, 8);
}

function extractToolCalls(entries: IntentRoutingTraceEntry[]): DiagnosticsToolCallEvidence[] {
  const calls: DiagnosticsToolCallEvidence[] = [];
  for (const entry of entries) {
    if (
      entry.stage !== 'direct_tool_call_started'
      && entry.stage !== 'direct_tool_call_completed'
      && entry.stage !== 'delegated_tool_call_started'
      && entry.stage !== 'delegated_tool_call_completed'
      && entry.stage !== 'direct_reasoning_tool_call'
    ) {
      continue;
    }
    const details = asDiagnosticsRecord(entry.details);
    const toolName = previewDiagnosticsText(details?.toolName ?? details?.name ?? entry.contentPreview, 100);
    if (!toolName) continue;
    const status = previewDiagnosticsText(details?.status ?? details?.resultStatus ?? details?.success, 80);
    calls.push({
      toolName,
      stage: entry.stage,
      ...(status ? { status } : {}),
    });
  }
  return calls.slice(0, 20);
}

function summarizeGuardianEvents(events: AuditEvent[]): DiagnosticsGuardianEventEvidence[] {
  return events
    .filter((event) => (
      event.type === 'action_denied'
      || event.type === 'action_allowed'
      || event.type === 'output_blocked'
      || event.type === 'output_redacted'
      || event.type === 'rate_limited'
      || event.type === 'agent_error'
      || event.type === 'broker_action'
      || event.type === 'tool.executed'
    ))
    .slice(-20)
    .reverse()
    .map((event) => {
      const details = asDiagnosticsRecord(redactSensitiveValue(event.details));
      const reason = previewDiagnosticsText(details?.reason ?? details?.message ?? details?.error, 180);
      return {
        type: event.type,
        severity: event.severity,
        ...(event.controller ? { controller: event.controller } : {}),
        ...(reason ? { reason } : {}),
      };
    });
}

export function formatDiagnosticsTraceLine(entry: IntentRoutingTraceEntry): string {
  const details = asDiagnosticsRecord(entry.details);
  const fragments = [
    new Date(entry.timestamp).toISOString(),
    entry.stage,
    entry.requestId ? `requestId=${entry.requestId}` : '',
    entry.agentId ? `agent=${entry.agentId}` : '',
    entry.channel ? `channel=${entry.channel}` : '',
    previewDiagnosticsText(details?.route ?? details?.operation ?? details?.reason ?? details?.summary ?? details?.prompt ?? entry.contentPreview, 160),
  ].filter(Boolean);
  return fragments.join(' | ');
}

export async function collectDiagnosticsEvidence(
  input: DiagnosticsEvidenceInput,
  deps: DiagnosticsEvidenceDependencies,
  currentRequestId?: string,
): Promise<DiagnosticsEvidence> {
  const traceLimit = clampDiagnosticsNumber(input.traceLimit, DEFAULT_TRACE_LIMIT, MAX_TRACE_LIMIT);
  const auditLimit = clampDiagnosticsNumber(input.auditLimit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
  const traceStatus = deps.intentRoutingTrace?.getStatus();
  const traceOptions: IntentRoutingTraceListOptions = {
    limit: traceLimit,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
  };
  const recentEntries = deps.intentRoutingTrace
    ? await deps.intentRoutingTrace.listRecent(traceOptions)
    : [];
  const { target, selected } = selectTraceEntries(recentEntries, input, currentRequestId);
  const entries = selected.sort((left, right) => left.timestamp - right.timestamp);
  const requestIds = [...new Set(entries.map((entry) => cleanDiagnosticsText(entry.requestId)).filter(Boolean))];
  const earliestTimestamp = entries.length > 0 ? entries[0].timestamp : undefined;
  const auditEvents = input.includeAudit
    ? deps.auditLog?.query({
      limit: auditLimit,
      ...(earliestTimestamp ? { after: Math.max(0, earliestTimestamp - 60_000) } : {}),
    }) ?? []
    : [];
  const latestUserRequest = pickLatestContentPreview(entries, 'incoming_dispatch') ?? pickLatestContentPreview(entries);
  const latestAssistantResponse = extractAssistantResponse(entries);
  const blockers = extractBlockers(entries);
  const toolCalls = extractToolCalls(entries);
  const guardianEvents = summarizeGuardianEvents(auditEvents);

  return {
    target,
    traceEnabled: traceStatus?.enabled ?? false,
    ...(traceStatus?.filePath ? { traceFilePath: traceStatus.filePath } : {}),
    requestIds,
    entries,
    entriesAnalyzed: entries.length,
    auditEventsAnalyzed: auditEvents.length,
    stages: stageCount(entries),
    ...(latestUserRequest ? { latestUserRequest } : {}),
    ...(latestAssistantResponse ? { latestAssistantResponse } : {}),
    blockers,
    toolCalls,
    guardianEvents,
  };
}
