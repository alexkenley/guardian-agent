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

export type DiagnosticsIssueTarget =
  | 'latest_completed_request'
  | 'current_request'
  | 'recent_window'
  | 'request_id';

export interface DiagnosticsIssueDraftInput {
  target?: DiagnosticsIssueTarget;
  requestId?: string;
  problem?: string;
  channel?: string;
  userId?: string;
  traceLimit?: number;
  auditLimit?: number;
}

export interface DiagnosticsIssueDraftDependencies {
  intentRoutingTrace?: Pick<IntentRoutingTraceLog, 'getStatus' | 'listRecent'>;
  auditLog?: {
    query(filter: AuditFilter): AuditEvent[];
  };
}

export interface DiagnosticsIssueDraft {
  title: string;
  body: string;
  labels: string[];
  severity: 'low' | 'medium' | 'high';
  suspectedSubsystems: string[];
  expectedBehavior: string;
  actualBehavior: string;
  privacyNote: string;
}

export interface DiagnosticsIssueDraftResult {
  draft: DiagnosticsIssueDraft;
  evidence: {
    target: DiagnosticsIssueTarget;
    traceEnabled: boolean;
    traceFilePath?: string;
    requestIds: string[];
    entriesAnalyzed: number;
    auditEventsAnalyzed: number;
    stages: Record<string, number>;
    latestUserRequest?: string;
    latestAssistantResponse?: string;
    blockers: string[];
    toolCalls: Array<{ toolName: string; stage: string; status?: string }>;
    guardianEvents: Array<{
      type: string;
      severity: string;
      controller?: string;
      reason?: string;
    }>;
  };
  nextStep: string;
}

interface TraceGroup {
  requestId: string;
  latestTimestamp: number;
  entries: IntentRoutingTraceEntry[];
}

function clampNumber(value: unknown, fallback: number, max: number): number {
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

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? redactSensitiveText(value).replace(/\s+/g, ' ').trim()
    : '';
}

function preview(value: unknown, maxChars = PREVIEW_CHARS): string {
  const cleaned = cleanText(value);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
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

function groupEntries(entries: IntentRoutingTraceEntry[]): TraceGroup[] {
  const byRequest = new Map<string, IntentRoutingTraceEntry[]>();
  for (const entry of entries) {
    const id = cleanText(entry.requestId);
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
  input: DiagnosticsIssueDraftInput,
  currentRequestId?: string,
): { target: DiagnosticsIssueTarget; selected: IntentRoutingTraceEntry[] } {
  const requestedTarget = input.target ?? (input.requestId ? 'request_id' : 'latest_completed_request');
  const explicitRequestId = cleanText(input.requestId);
  if (requestedTarget === 'request_id') {
    return {
      target: 'request_id',
      selected: explicitRequestId ? entries.filter((entry) => entry.requestId === explicitRequestId) : [],
    };
  }
  if (requestedTarget === 'current_request') {
    const targetId = explicitRequestId || cleanText(currentRequestId);
    return {
      target: 'current_request',
      selected: targetId ? entries.filter((entry) => entry.requestId === targetId) : [],
    };
  }
  if (requestedTarget === 'recent_window') {
    return { target: 'recent_window', selected: entries };
  }

  const groups = groupEntries(entries);
  const current = cleanText(currentRequestId);
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
    const details = asRecord(entry.details);
    const reason = preview(details?.reason ?? details?.summary ?? details?.message ?? entry.contentPreview);
    blockers.push(reason || entry.stage);
  }
  return [...new Set(blockers)].slice(0, 8);
}

function extractToolCalls(entries: IntentRoutingTraceEntry[]): Array<{ toolName: string; stage: string; status?: string }> {
  const calls: Array<{ toolName: string; stage: string; status?: string }> = [];
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
    const details = asRecord(entry.details);
    const toolName = preview(details?.toolName ?? details?.name ?? entry.contentPreview, 100);
    if (!toolName) continue;
    const status = preview(details?.status ?? details?.resultStatus ?? details?.success, 80);
    calls.push({
      toolName,
      stage: entry.stage,
      ...(status ? { status } : {}),
    });
  }
  return calls.slice(0, 20);
}

function summarizeGuardianEvents(events: AuditEvent[]): DiagnosticsIssueDraftResult['evidence']['guardianEvents'] {
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
      const details = asRecord(redactSensitiveValue(event.details));
      const reason = preview(details?.reason ?? details?.message ?? details?.error, 180);
      return {
        type: event.type,
        severity: event.severity,
        ...(event.controller ? { controller: event.controller } : {}),
        ...(reason ? { reason } : {}),
      };
    });
}

function inferSuspectedSubsystems(entries: IntentRoutingTraceEntry[], guardianEvents: DiagnosticsIssueDraftResult['evidence']['guardianEvents']): string[] {
  const stages = new Set(entries.map((entry) => entry.stage));
  const subsystems = new Set<string>();
  if (stages.has('gateway_classification_failed') || stages.has('clarification_requested')) {
    subsystems.add('intent-gateway');
  }
  if ([...stages].some((stage) => stage.startsWith('delegated_'))) {
    subsystems.add('delegated-orchestration');
  }
  if ([...stages].some((stage) => stage.includes('tool_call'))) {
    subsystems.add('tool-execution');
  }
  if (stages.has('approval_decision_resolved') || stages.has('approval_continuation_resolved')) {
    subsystems.add('approvals-continuity');
  }
  if (guardianEvents.some((event) => event.type === 'action_denied' || event.type === 'output_blocked')) {
    subsystems.add('guardian-security');
  }
  if (stages.has('dispatch_response')) {
    subsystems.add('channel-response');
  }
  return [...subsystems].slice(0, 6);
}

function inferSeverity(entries: IntentRoutingTraceEntry[], blockers: string[], guardianEvents: DiagnosticsIssueDraftResult['evidence']['guardianEvents']): 'low' | 'medium' | 'high' {
  const stages = new Set(entries.map((entry) => entry.stage));
  if (
    stages.has('delegated_worker_failed')
    || stages.has('direct_reasoning_failed')
    || guardianEvents.some((event) => event.severity === 'critical')
  ) {
    return 'high';
  }
  if (blockers.length > 0 || stages.has('clarification_requested') || stages.has('delegated_job_wait_expired')) {
    return 'medium';
  }
  return 'low';
}

function buildIssueTitle(input: DiagnosticsIssueDraftInput, latestUserRequest?: string, blockers: string[] = []): string {
  const problem = preview(input.problem, 90);
  if (problem) return `[Diagnostics] ${problem}`;
  if (blockers.length > 0) return `[Diagnostics] ${preview(blockers[0], 90) || 'Assistant request failed or stalled'}`;
  if (latestUserRequest) return `[Diagnostics] Unexpected response for: ${preview(latestUserRequest, 70)}`;
  return '[Diagnostics] Assistant request needs investigation';
}

function formatTraceLine(entry: IntentRoutingTraceEntry): string {
  const details = asRecord(entry.details);
  const fragments = [
    `- ${new Date(entry.timestamp).toISOString()} ${entry.stage}`,
    entry.requestId ? `requestId=${entry.requestId}` : '',
    entry.agentId ? `agent=${entry.agentId}` : '',
    entry.channel ? `channel=${entry.channel}` : '',
    preview(details?.route ?? details?.operation ?? details?.summary ?? entry.contentPreview, 160),
  ].filter(Boolean);
  return fragments.join(' | ');
}

function buildBody(input: {
  draftInput: DiagnosticsIssueDraftInput;
  entries: IntentRoutingTraceEntry[];
  guardianEvents: DiagnosticsIssueDraftResult['evidence']['guardianEvents'];
  suspectedSubsystems: string[];
  latestUserRequest?: string;
  latestAssistantResponse?: string;
  blockers: string[];
  toolCalls: Array<{ toolName: string; stage: string; status?: string }>;
  requestIds: string[];
  traceFilePath?: string;
}): string {
  const problem = preview(input.draftInput.problem, 500) || '(not supplied)';
  const expected = 'Guardian should preserve user intent across turns, use the correct shared orchestration path, and ask a concrete clarification only when required information is genuinely missing.';
  const actual = input.blockers.length > 0
    ? input.blockers.join('; ')
    : (input.latestAssistantResponse || 'No clear failure summary was available from the selected trace window.');
  const traceLines = input.entries
    .slice(-20)
    .map(formatTraceLine)
    .join('\n') || '- No routing trace entries were available for the selected target.';
  const toolLines = input.toolCalls.length > 0
    ? input.toolCalls.map((call) => `- ${call.toolName} (${call.stage}${call.status ? `, ${call.status}` : ''})`).join('\n')
    : '- No tool calls were observed in the selected trace entries.';
  const guardianLines = input.guardianEvents.length > 0
    ? input.guardianEvents.map((event) => `- ${event.type} (${event.severity}${event.controller ? `, ${event.controller}` : ''})${event.reason ? `: ${event.reason}` : ''}`).join('\n')
    : '- No relevant Guardian/audit events were available in the selected audit window.';

  return [
    '## Problem Report',
    '',
    `User-provided problem: ${problem}`,
    '',
    '## Expected Behavior',
    '',
    expected,
    '',
    '## Actual Behavior',
    '',
    actual,
    '',
    '## Reproduction Context',
    '',
    `- Latest user request: ${input.latestUserRequest ?? '(unknown)'}`,
    `- Latest assistant response: ${input.latestAssistantResponse ?? '(unknown)'}`,
    `- Request ids: ${input.requestIds.length > 0 ? input.requestIds.join(', ') : '(none)'}`,
    `- Suspected subsystem(s): ${input.suspectedSubsystems.length > 0 ? input.suspectedSubsystems.join(', ') : 'unknown'}`,
    '',
    '## Tool Evidence',
    '',
    toolLines,
    '',
    '## Guardian / Audit Evidence',
    '',
    guardianLines,
    '',
    '## Routing Trace Evidence',
    '',
    traceLines,
    '',
    '## Privacy Note',
    '',
    `This draft uses redacted routing trace and audit summaries. Review before opening a public issue.${input.traceFilePath ? ` Trace source: ${input.traceFilePath}` : ''}`,
  ].join('\n');
}

export async function buildDiagnosticsIssueDraft(
  input: DiagnosticsIssueDraftInput,
  deps: DiagnosticsIssueDraftDependencies,
  currentRequestId?: string,
): Promise<DiagnosticsIssueDraftResult> {
  const traceLimit = clampNumber(input.traceLimit, DEFAULT_TRACE_LIMIT, MAX_TRACE_LIMIT);
  const auditLimit = clampNumber(input.auditLimit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
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
  const requestIds = [...new Set(entries.map((entry) => cleanText(entry.requestId)).filter(Boolean))];
  const earliestTimestamp = entries.length > 0 ? entries[0].timestamp : undefined;
  const auditEvents = deps.auditLog?.query({
    limit: auditLimit,
    ...(earliestTimestamp ? { after: Math.max(0, earliestTimestamp - 60_000) } : {}),
  }) ?? [];
  const guardianEvents = summarizeGuardianEvents(auditEvents);
  const latestUserRequest = pickLatestContentPreview(entries, 'incoming_dispatch') ?? pickLatestContentPreview(entries);
  const latestAssistantResponse = extractAssistantResponse(entries);
  const blockers = extractBlockers(entries);
  const toolCalls = extractToolCalls(entries);
  const suspectedSubsystems = inferSuspectedSubsystems(entries, guardianEvents);
  const severity = inferSeverity(entries, blockers, guardianEvents);
  const title = buildIssueTitle(input, latestUserRequest, blockers);
  const expectedBehavior = 'Guardian should preserve intent and shared orchestration state, gather evidence with approved read-only tools where appropriate, and ask only concrete clarifying questions when required.';
  const actualBehavior = blockers.length > 0
    ? blockers.join('; ')
    : (latestAssistantResponse ?? 'No selected trace entries showed a clear final assistant response.');
  const draft: DiagnosticsIssueDraft = {
    title,
    body: buildBody({
      draftInput: input,
      entries,
      guardianEvents,
      suspectedSubsystems,
      latestUserRequest,
      latestAssistantResponse,
      blockers,
      toolCalls,
      requestIds,
      traceFilePath: traceStatus?.filePath,
    }),
    labels: ['diagnostics', 'user-reported', ...suspectedSubsystems.map((subsystem) => `area:${subsystem}`)],
    severity,
    suspectedSubsystems,
    expectedBehavior,
    actualBehavior,
    privacyNote: 'Review this redacted draft before approving any GitHub issue creation. No external post has been made.',
  };

  return {
    draft,
    evidence: {
      target,
      traceEnabled: traceStatus?.enabled ?? false,
      ...(traceStatus?.filePath ? { traceFilePath: traceStatus.filePath } : {}),
      requestIds,
      entriesAnalyzed: entries.length,
      auditEventsAnalyzed: auditEvents.length,
      stages: stageCount(entries),
      ...(latestUserRequest ? { latestUserRequest } : {}),
      ...(latestAssistantResponse ? { latestAssistantResponse } : {}),
      blockers,
      toolCalls,
      guardianEvents,
    },
    nextStep: 'Show this draft to the user. Only create a GitHub issue after the user explicitly approves the external post.',
  };
}
