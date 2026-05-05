import type {
  IntentRoutingTraceEntry,
  IntentRoutingTraceLog,
} from '../intent-routing-trace.js';
import { redactSensitiveText } from '../../util/crypto-guardrails.js';

const DEFAULT_TRACE_LIMIT = 80;
const MAX_TRACE_LIMIT = 200;
const PREVIEW_CHARS = 220;

export interface DiagnosticsTraceInspectInput {
  requestId?: string;
  traceLimit?: number;
}

export interface DiagnosticsTraceInspectDependencies {
  intentRoutingTrace?: Pick<IntentRoutingTraceLog, 'getStatus' | 'listRecent'>;
}

export interface DiagnosticsTraceInspectResult {
  traceEnabled: boolean;
  traceFilePath?: string;
  entriesAnalyzed: number;
  requestIds: string[];
  latestRequestId?: string;
  latestUserRequest?: string;
  latestAssistantResponse?: string;
  stages: Record<string, number>;
  blockers: string[];
  timeline: string[];
  summary: string;
}

function clampTraceLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_TRACE_LIMIT, Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_TRACE_LIMIT, parsed));
    }
  }
  return DEFAULT_TRACE_LIMIT;
}

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? redactSensitiveText(value).replace(/\s+/g, ' ').trim()
    : '';
}

function preview(value: unknown, maxChars = PREVIEW_CHARS): string {
  const cleaned = cleanText(value);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestIdFor(entry: IntentRoutingTraceEntry): string {
  return cleanText(entry.requestId);
}

function pickLatestContentPreview(entries: IntentRoutingTraceEntry[], stage?: string): string | undefined {
  const filtered = stage ? entries.filter((entry) => entry.stage === stage) : entries;
  const match = filtered
    .filter((entry) => cleanText(entry.contentPreview))
    .sort((left, right) => right.timestamp - left.timestamp)[0];
  return match ? preview(match.contentPreview) : undefined;
}

function extractAssistantResponse(entries: IntentRoutingTraceEntry[]): string | undefined {
  for (const entry of [...entries].sort((left, right) => right.timestamp - left.timestamp)) {
    if (entry.stage !== 'dispatch_response') continue;
    const details = asRecord(entry.details);
    const responsePreview = preview(details?.responsePreview ?? details?.contentPreview ?? details?.message);
    if (responsePreview) return responsePreview;
    const contentPreview = preview(entry.contentPreview);
    if (contentPreview) return contentPreview;
  }
  return undefined;
}

function stageCount(entries: IntentRoutingTraceEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
  }
  return counts;
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
    const details = asRecord(entry.details);
    const reason = preview(details?.reason ?? details?.summary ?? details?.prompt ?? details?.message ?? entry.contentPreview);
    blockers.push(reason || entry.stage);
  }
  return [...new Set(blockers)].slice(0, 8);
}

function selectEntries(
  entries: IntentRoutingTraceEntry[],
  input: DiagnosticsTraceInspectInput,
  currentRequestId?: string,
): IntentRoutingTraceEntry[] {
  const explicitRequestId = cleanText(input.requestId);
  if (explicitRequestId) {
    return entries.filter((entry) => requestIdFor(entry) === explicitRequestId);
  }
  const current = cleanText(currentRequestId);
  const byRequest = new Map<string, IntentRoutingTraceEntry[]>();
  for (const entry of entries) {
    const id = requestIdFor(entry);
    if (!id || id === current) continue;
    const bucket = byRequest.get(id) ?? [];
    bucket.push(entry);
    byRequest.set(id, bucket);
  }
  const groups = [...byRequest.entries()]
    .map(([requestId, groupEntries]) => ({
      requestId,
      entries: groupEntries.sort((left, right) => left.timestamp - right.timestamp),
      latestTimestamp: Math.max(...groupEntries.map((entry) => entry.timestamp)),
    }))
    .sort((left, right) => right.latestTimestamp - left.latestTimestamp);
  return groups[0]?.entries ?? entries.filter((entry) => requestIdFor(entry) !== current).slice(-20);
}

function formatTraceLine(entry: IntentRoutingTraceEntry): string {
  const details = asRecord(entry.details);
  const fragments = [
    new Date(entry.timestamp).toISOString(),
    entry.stage,
    entry.requestId ? `requestId=${entry.requestId}` : '',
    entry.agentId ? `agent=${entry.agentId}` : '',
    entry.channel ? `channel=${entry.channel}` : '',
    preview(details?.route ?? details?.operation ?? details?.reason ?? details?.summary ?? details?.prompt ?? entry.contentPreview, 160),
  ].filter(Boolean);
  return fragments.join(' | ');
}

function summarize(entries: IntentRoutingTraceEntry[], blockers: string[]): string {
  const stages = new Set(entries.map((entry) => entry.stage));
  if (blockers.length > 0) {
    return `The trace shows a blocking path: ${blockers[0]}`;
  }
  if (stages.has('delegated_worker_started') && !stages.has('dispatch_response')) {
    return 'The trace shows delegated work started, but no final dispatch response in the selected window.';
  }
  if (stages.has('dispatch_response')) {
    return 'The trace includes a completed dispatch response for the selected request.';
  }
  if (entries.length > 0) {
    return 'The trace is readable and contains routing evidence for the selected request window.';
  }
  return 'No routing trace entries matched the selected request window.';
}

export async function inspectDiagnosticsTrace(
  input: DiagnosticsTraceInspectInput,
  dependencies: DiagnosticsTraceInspectDependencies,
  currentRequestId?: string,
): Promise<DiagnosticsTraceInspectResult> {
  const status = dependencies.intentRoutingTrace?.getStatus();
  if (!dependencies.intentRoutingTrace || status?.enabled === false) {
    return {
      traceEnabled: false,
      entriesAnalyzed: 0,
      requestIds: [],
      stages: {},
      blockers: [],
      timeline: [],
      summary: 'Routing trace inspection is not available in this runtime.',
    };
  }

  const entries = await dependencies.intentRoutingTrace.listRecent({
    limit: clampTraceLimit(input.traceLimit),
  });
  const selected = selectEntries(entries, input, currentRequestId);
  const requestIds = [...new Set(selected.map(requestIdFor).filter(Boolean))];
  const blockers = extractBlockers(selected);
  return {
    traceEnabled: true,
    ...(status?.filePath ? { traceFilePath: status.filePath } : {}),
    entriesAnalyzed: selected.length,
    requestIds,
    ...(requestIds[0] ? { latestRequestId: requestIds[0] } : {}),
    ...(pickLatestContentPreview(selected, 'incoming_dispatch') ? { latestUserRequest: pickLatestContentPreview(selected, 'incoming_dispatch') } : {}),
    ...(extractAssistantResponse(selected) ? { latestAssistantResponse: extractAssistantResponse(selected) } : {}),
    stages: stageCount(selected),
    blockers,
    timeline: selected.slice(-20).map(formatTraceLine),
    summary: summarize(selected, blockers),
  };
}
