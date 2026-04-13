import type { PlaybookRunRecord } from './connectors.js';
import type { CodingBackendProgressEvent } from './coding-backend-service.js';
import type {
  CodeSessionPendingApproval,
  CodeSessionRecentJob,
  CodeSessionRecord,
  CodeSessionVerificationEntry,
} from './code-sessions.js';
import type { AssistantDispatchTrace, WorkflowTraceNode } from './orchestrator.js';
import type { OrchestrationRunEvent } from './run-events.js';
import type { ScheduledTaskHistoryEntry } from './scheduled-tasks.js';
import { runDetailMatchesContextFilters } from './trace-context-filters.js';

export type DashboardRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'verification_pending'
  | 'blocked'
  | 'interrupted'
  | 'completed'
  | 'failed';

export type DashboardRunKind =
  | 'assistant_dispatch'
  | 'automation_run'
  | 'code_session'
  | 'scheduled_task';

export type DashboardRunTimelineItemType =
  | 'run_queued'
  | 'run_started'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'handoff_started'
  | 'handoff_completed'
  | 'verification_pending'
  | 'verification_completed'
  | 'note'
  | 'run_completed'
  | 'run_failed';

export interface DashboardRunTimelineItem {
  id: string;
  runId: string;
  timestamp: number;
  type: DashboardRunTimelineItemType;
  status: 'info' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'warning';
  source: 'orchestrator' | 'workflow' | 'code_session' | 'system';
  title: string;
  detail?: string;
  nodeId?: string;
  toolName?: string;
  approvalId?: string;
  verificationKind?: 'test' | 'lint' | 'build' | 'manual';
  contextAssembly?: DashboardRunTimelineContextAssembly;
}

export interface DashboardRunTimelineContextMemoryEntry {
  scope?: 'global' | 'coding_session';
  category: string;
  createdAt: string;
  preview: string;
  renderMode: 'full' | 'summary';
  queryScore: number;
  isContextFlush: boolean;
  matchReasons?: string[];
}

export interface DashboardRunTimelineContextSectionFootprint {
  section: string;
  chars: number;
  included: boolean;
  mode?: string;
  itemCount?: number;
}

export interface DashboardRunTimelinePreservedExecutionState {
  objective?: string;
  blockerSummary?: string;
  activeExecutionRefs?: string[];
  maintainedSummarySource?: string;
}

export interface DashboardRunTimelineSkillArtifactReference {
  skillId: string;
  scope: 'global' | 'coding_session';
  slug: string;
  title: string;
  sourceClass: string;
}

export interface DashboardRunTimelineContextAssembly {
  summary?: string;
  detail?: string;
  memoryScope?: 'global' | 'coding_session' | 'none';
  knowledgeBaseLoaded?: boolean;
  codingMemoryLoaded?: boolean;
  codingMemoryChars?: number;
  knowledgeBaseQueryPreview?: string;
  continuityKey?: string;
  activeExecutionRefs?: string[];
  linkedSurfaceCount?: number;
  skillInstructionSkillIds?: string[];
  skillResourceSkillIds?: string[];
  skillResourcePaths?: string[];
  skillPromptCacheHitCount?: number;
  skillPromptCacheHits?: string[];
  skillPromptLoadReasons?: string[];
  skillArtifactReferences?: DashboardRunTimelineSkillArtifactReference[];
  selectedMemoryEntryCount?: number;
  omittedMemoryEntryCount?: number;
  selectedMemoryEntries?: DashboardRunTimelineContextMemoryEntry[];
  contextCompactionApplied?: boolean;
  contextCharsBeforeCompaction?: number;
  contextCharsAfterCompaction?: number;
  contextCompactionStages?: string[];
  compactedSummaryPreview?: string;
  sectionFootprints?: DashboardRunTimelineContextSectionFootprint[];
  preservedExecutionState?: DashboardRunTimelinePreservedExecutionState;
}

export interface DashboardRunSummary {
  runId: string;
  parentRunId?: string;
  groupId: string;
  kind: DashboardRunKind;
  status: DashboardRunStatus;
  title: string;
  subtitle?: string;
  agentId?: string | null;
  channel?: string;
  sessionId?: string;
  codeSessionId?: string;
  requestType?: string;
  startedAt: number;
  completedAt?: number;
  lastUpdatedAt: number;
  durationMs?: number;
  pendingApprovalCount: number;
  verificationPendingCount: number;
  error?: string;
  tags: string[];
}

export interface DashboardRunDetail {
  summary: DashboardRunSummary;
  items: DashboardRunTimelineItem[];
}

export interface DashboardRunListResponse {
  runs: DashboardRunDetail[];
}

export interface DashboardCodeSessionTimelineResponse {
  codeSessionId: string;
  runs: DashboardRunDetail[];
}

export type RunTimelineListener = (detail: DashboardRunDetail) => void;

export interface RunTimelineListFilters {
  limit?: number;
  status?: DashboardRunStatus;
  kind?: DashboardRunKind;
  channel?: string;
  agentId?: string;
  codeSessionId?: string;
  continuityKey?: string;
  activeExecutionRef?: string;
}

export interface RunTimelineStoreOptions {
  maxRuns?: number;
  maxItemsPerRun?: number;
  completedRetentionMs?: number;
  now?: () => number;
}

interface RunTimelineRecord {
  baseStatus: DashboardRunStatus;
  detail: DashboardRunDetail;
  signature: string;
}

interface PendingApprovalState {
  approvalId: string;
  runId: string;
  toolName: string;
  createdAt: number;
}

const DEFAULT_MAX_RUNS = 200;
const DEFAULT_MAX_ITEMS_PER_RUN = 300;
const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

export class RunTimelineStore {
  private readonly runs = new Map<string, RunTimelineRecord>();
  private readonly listeners = new Set<RunTimelineListener>();
  private readonly sessionPendingApprovals = new Map<string, Map<string, PendingApprovalState>>();
  private readonly maxRuns: number;
  private readonly maxItemsPerRun: number;
  private readonly completedRetentionMs: number;
  private readonly now: () => number;

  constructor(options: RunTimelineStoreOptions = {}) {
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxItemsPerRun = options.maxItemsPerRun ?? DEFAULT_MAX_ITEMS_PER_RUN;
    this.completedRetentionMs = options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: RunTimelineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listRuns(filters: RunTimelineListFilters = {}): DashboardRunDetail[] {
    return this.sortedRuns()
      .filter((detail) => {
        if (filters.status && detail.summary.status !== filters.status) return false;
        if (filters.kind && detail.summary.kind !== filters.kind) return false;
        if (filters.channel && detail.summary.channel !== filters.channel) return false;
        if (filters.agentId && detail.summary.agentId !== filters.agentId) return false;
        if (filters.codeSessionId && detail.summary.codeSessionId !== filters.codeSessionId) return false;
        if (!runDetailMatchesContextFilters(detail, filters)) return false;
        return true;
      })
      .slice(0, Math.max(1, filters.limit ?? 20))
      .map(cloneDetail);
  }

  getRun(runId: string): DashboardRunDetail | null {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return null;
    const record = this.runs.get(normalizedRunId);
    return record ? cloneDetail(record.detail) : null;
  }

  listRunsForCodeSession(codeSessionId: string, limit = 20): DashboardRunDetail[] {
    return this.listRuns({ codeSessionId, limit });
  }

  ingestAssistantTrace(trace: AssistantDispatchTrace): void {
    const items = buildAssistantTraceItems(trace);
    this.commitRun(trace.runId, {
      baseStatus: mapAssistantTraceStatus(trace.status),
      summary: {
        parentRunId: trace.parentRunId,
        groupId: trace.groupId,
        kind: 'assistant_dispatch',
        title: summarizeRunTitle(trace.requestType, trace.messagePreview),
        subtitle: sanitizePreview(trace.responsePreview),
        agentId: trace.agentId,
        channel: trace.channel,
        sessionId: trace.sessionId,
        requestType: trace.requestType,
        startedAt: trace.startedAt ?? trace.queuedAt,
        completedAt: trace.completedAt,
        error: nonEmptyText(trace.error),
        tags: [trace.channel, trace.requestType],
      },
      items,
    });
  }

  ingestCodeSession(session: CodeSessionRecord): void {
    const approvals = Array.isArray(session.workState.pendingApprovals)
      ? session.workState.pendingApprovals
      : [];
    const jobs = Array.isArray(session.workState.recentJobs)
      ? session.workState.recentJobs
      : [];
    const verification = Array.isArray(session.workState.verification)
      ? session.workState.verification
      : [];

    const touchedRunIds = new Set<string>();
    const pendingCounts = new Map<string, number>();
    const verificationPendingCounts = new Map<string, number>();
    const currentPending = new Map<string, PendingApprovalState>();

    for (const approval of approvals) {
      const runId = resolveRunId(session.id, approval.requestId);
      touchedRunIds.add(runId);
      pendingCounts.set(runId, (pendingCounts.get(runId) ?? 0) + 1);
      currentPending.set(approval.id, {
        approvalId: approval.id,
        runId,
        toolName: approval.toolName,
        createdAt: approval.createdAt ?? session.updatedAt,
      });

      const existing = this.runs.get(runId);
      this.commitRun(runId, {
        ...(shouldUseCodeSessionBaseStatus(existing) ? { baseStatus: deriveCodeSessionBaseStatus(runId, approvals, jobs, verification, session) } : {}),
        summary: buildCodeSessionSummaryPatch(session, existing?.detail.summary),
        items: [buildPendingApprovalItem(runId, approval, session.updatedAt)],
      });
    }

    const previousPending = this.sessionPendingApprovals.get(session.id) ?? new Map<string, PendingApprovalState>();
    for (const [approvalId, previous] of previousPending.entries()) {
      if (currentPending.has(approvalId)) continue;
      touchedRunIds.add(previous.runId);
      const relatedJob = jobs.find((job) => job.approvalId === approvalId);
      this.commitRun(previous.runId, {
        summary: buildCodeSessionSummaryPatch(session, this.runs.get(previous.runId)?.detail.summary),
        items: [buildApprovalResolvedItem(previous.runId, approvalId, previous.toolName, relatedJob, session.updatedAt)],
      });
    }
    this.sessionPendingApprovals.set(session.id, currentPending);

    for (const job of jobs) {
      const runId = resolveRunId(session.id, job.requestId);
      const existing = this.runs.get(runId);
      touchedRunIds.add(runId);
      this.commitRun(runId, {
        ...(shouldUseCodeSessionBaseStatus(existing) ? { baseStatus: deriveCodeSessionBaseStatus(runId, approvals, jobs, verification, session) } : {}),
        summary: buildCodeSessionSummaryPatch(session, existing?.detail.summary),
        items: buildJobItems(runId, job, session.updatedAt),
      });
    }

    for (const entry of verification) {
      const runId = resolveRunId(session.id, entry.requestId);
      const existing = this.runs.get(runId);
      touchedRunIds.add(runId);
      if (entry.status === 'not_run') {
        verificationPendingCounts.set(runId, (verificationPendingCounts.get(runId) ?? 0) + 1);
      }
      this.commitRun(runId, {
        ...(shouldUseCodeSessionBaseStatus(existing) ? { baseStatus: deriveCodeSessionBaseStatus(runId, approvals, jobs, verification, session) } : {}),
        summary: buildCodeSessionSummaryPatch(session, existing?.detail.summary),
        items: [buildVerificationItem(runId, entry)],
      });
    }

    for (const runId of touchedRunIds) {
      const existing = this.runs.get(runId);
      this.commitRun(runId, {
        ...(shouldUseCodeSessionBaseStatus(existing) ? { baseStatus: deriveCodeSessionBaseStatus(runId, approvals, jobs, verification, session) } : {}),
        summary: {
          ...buildCodeSessionSummaryPatch(session, existing?.detail.summary),
          pendingApprovalCount: pendingCounts.get(runId) ?? 0,
          verificationPendingCount: verificationPendingCounts.get(runId) ?? 0,
        },
      });
    }
  }

  ingestCodingBackendProgress(event: CodingBackendProgressEvent): void {
    const runId = nonEmptyText(event.runId) ?? resolveRunId(event.codeSessionId, event.requestId);
    const existing = this.runs.get(runId);
    const shouldSetBaseStatus = shouldUseCodeSessionBaseStatus(existing);
    const summary = existing?.detail.summary;

    this.commitRun(runId, {
      ...(shouldSetBaseStatus
        ? { baseStatus: mapCodingBackendProgressStatus(event.kind) }
        : {}),
      summary: {
        codeSessionId: event.codeSessionId,
        groupId: summary?.groupId ?? `code-session:${event.codeSessionId}`,
        kind: summary?.kind ?? 'code_session',
        title: summary?.title ?? `Coding backend: ${event.backendName}`,
        subtitle: summary?.subtitle ?? truncateText(event.task, 160),
        startedAt: summary?.startedAt ?? event.timestamp,
        tags: ['coding-backend', event.backendId],
      },
      items: [buildCodingBackendProgressItem(runId, event)],
    });
  }

  syncPlaybookRuns(runs: PlaybookRunRecord[]): void {
    for (const run of Array.isArray(runs) ? runs : []) {
      this.commitRun(run.runId, {
        baseStatus: mapPlaybookStatus(run.status),
        summary: {
          groupId: run.playbookId,
          kind: 'automation_run',
          title: `Automation: ${run.playbookName}`,
          subtitle: nonEmptyText(run.message),
          agentId: run.requestedBy ?? undefined,
          channel: run.origin,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: run.durationMs,
          tags: ['automation', run.origin, run.playbookId],
        },
        items: buildWorkflowEventItems(run.runId, run.events, 'workflow'),
      });
    }
  }

  syncScheduledTaskHistory(entries: ScheduledTaskHistoryEntry[]): void {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const runId = nonEmptyText(entry.runId) ?? `scheduled:${entry.taskId}:${entry.timestamp}`;
      const startedAt = Math.max(0, entry.timestamp - Math.max(0, entry.durationMs || 0));
      const completedAt = entry.status === 'pending_approval' ? undefined : entry.timestamp;
      this.commitRun(runId, {
        baseStatus: mapScheduledTaskStatus(entry.status),
        summary: {
          groupId: entry.taskId,
          kind: 'scheduled_task',
          title: `Scheduled: ${entry.taskName}`,
          subtitle: nonEmptyText(entry.message),
          channel: 'scheduled',
          startedAt,
          completedAt,
          durationMs: entry.durationMs,
          tags: ['scheduled', entry.taskType, entry.target],
        },
        items: buildWorkflowEventItems(runId, entry.events ?? [], 'workflow'),
      });
    }
  }

  private commitRun(
    runId: string,
    input: {
      summary?: Partial<DashboardRunSummary>;
      baseStatus?: DashboardRunStatus;
      items?: DashboardRunTimelineItem[];
    },
  ): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const existing = this.runs.get(normalizedRunId);
    const nextSummary = {
      ...(existing?.detail.summary ?? defaultSummary(normalizedRunId)),
      ...(input.summary ?? {}),
    };
    nextSummary.tags = mergeTags(existing?.detail.summary.tags ?? [], input.summary?.tags ?? []);

    const itemMap = new Map<string, DashboardRunTimelineItem>();
    for (const item of existing?.detail.items ?? []) {
      itemMap.set(item.id, item);
    }
    for (const item of input.items ?? []) {
      itemMap.set(item.id, item);
    }
    let items = [...itemMap.values()]
      .filter((item) => Number.isFinite(item.timestamp) && item.timestamp > 0)
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    if (items.length > this.maxItemsPerRun) {
      items = items.slice(items.length - this.maxItemsPerRun);
    }

    const baseStatus = input.baseStatus ?? existing?.baseStatus ?? 'queued';
    const startedAt = nextSummary.startedAt > 0
      ? nextSummary.startedAt
      : (items[0]?.timestamp ?? this.now());
    const lastUpdatedAt = Math.max(
      nextSummary.completedAt ?? 0,
      nextSummary.lastUpdatedAt ?? 0,
      items[items.length - 1]?.timestamp ?? 0,
      startedAt,
    );
    const completedAt = nextSummary.completedAt
      ?? inferCompletedAt(baseStatus, lastUpdatedAt);
    const durationMs = completedAt && startedAt
      ? Math.max(0, completedAt - startedAt)
      : nextSummary.durationMs;

    const detail: DashboardRunDetail = {
      summary: {
        ...nextSummary,
        runId: normalizedRunId,
        groupId: nonEmptyText(nextSummary.groupId) ?? normalizedRunId,
        title: nonEmptyText(nextSummary.title) ?? normalizedRunId,
        status: overlayStatus(
          baseStatus,
          nextSummary.pendingApprovalCount ?? 0,
          nextSummary.verificationPendingCount ?? 0,
        ),
        startedAt,
        completedAt,
        lastUpdatedAt,
        durationMs,
      },
      items,
    };

    const signature = JSON.stringify(detail);
    if (existing && existing.signature === signature) {
      return;
    }

    this.runs.set(normalizedRunId, { baseStatus, detail, signature });
    this.prune();
    for (const listener of this.listeners) {
      listener(cloneDetail(detail));
    }
  }

  private prune(): void {
    const now = this.now();
    const sorted = [...this.runs.entries()]
      .sort((left, right) => right[1].detail.summary.lastUpdatedAt - left[1].detail.summary.lastUpdatedAt);

    for (const [runId, record] of sorted) {
      const terminal = record.detail.summary.status === 'completed'
        || record.detail.summary.status === 'failed'
        || record.detail.summary.status === 'blocked'
        || record.detail.summary.status === 'interrupted';
      if (!terminal) continue;
      if (now - record.detail.summary.lastUpdatedAt > this.completedRetentionMs) {
        this.runs.delete(runId);
      }
    }

    const limited = [...this.runs.entries()]
      .sort((left, right) => right[1].detail.summary.lastUpdatedAt - left[1].detail.summary.lastUpdatedAt);
    for (const [runId] of limited.slice(this.maxRuns)) {
      this.runs.delete(runId);
    }
  }

  private sortedRuns(): DashboardRunDetail[] {
    return [...this.runs.values()]
      .map((record) => record.detail)
      .sort((left, right) => right.summary.lastUpdatedAt - left.summary.lastUpdatedAt);
  }
}

function defaultSummary(runId: string): DashboardRunSummary {
  const now = Date.now();
  return {
    runId,
    groupId: runId,
    kind: 'assistant_dispatch',
    status: 'queued',
    title: runId,
    startedAt: now,
    lastUpdatedAt: now,
    pendingApprovalCount: 0,
    verificationPendingCount: 0,
    tags: [],
  };
}

function cloneDetail(detail: DashboardRunDetail): DashboardRunDetail {
  return {
    summary: {
      ...detail.summary,
      tags: [...detail.summary.tags],
    },
    items: detail.items.map((item) => ({
      ...item,
      ...(item.contextAssembly
        ? {
            contextAssembly: {
              ...item.contextAssembly,
              ...(item.contextAssembly.selectedMemoryEntries
                ? {
                    selectedMemoryEntries: item.contextAssembly.selectedMemoryEntries.map((entry) => ({ ...entry })),
                  }
                : {}),
            },
          }
        : {}),
    })),
  };
}

function shouldUseCodeSessionBaseStatus(record: RunTimelineRecord | undefined): boolean {
  return !record || record.detail.summary.kind === 'code_session';
}

function summarizeRunTitle(requestType: string, preview?: string): string {
  return sanitizePreview(preview) ?? `Assistant ${requestType || 'message'}`;
}

function resolveRunId(codeSessionId: string, requestId?: string): string {
  const normalizedRequestId = nonEmptyText(requestId);
  if (normalizedRequestId) return normalizedRequestId;
  return `code-session:${codeSessionId}:unscoped`;
}

function buildCodeSessionSummaryPatch(
  session: CodeSessionRecord,
  existing?: DashboardRunSummary,
): Partial<DashboardRunSummary> {
  return {
    ...(existing ? {} : {
      groupId: session.id,
      kind: 'code_session' as const,
      title: `Code session: ${session.title}`,
    }),
    sessionId: session.id,
    codeSessionId: session.id,
    tags: ['code'],
  };
}

function buildPendingApprovalItem(
  runId: string,
  approval: CodeSessionPendingApproval,
  fallbackTimestamp: number,
): DashboardRunTimelineItem {
  return {
    id: `approval:${approval.id}`,
    runId,
    timestamp: approval.createdAt ?? fallbackTimestamp,
    type: 'approval_requested',
    status: 'blocked',
    source: 'code_session',
    title: `Approval requested: ${humanizeToolName(approval.toolName)}`,
    detail: nonEmptyText(approval.argsPreview),
    toolName: approval.toolName,
    approvalId: approval.id,
  };
}

function buildApprovalResolvedItem(
  runId: string,
  approvalId: string,
  toolName: string,
  relatedJob: CodeSessionRecentJob | undefined,
  fallbackTimestamp: number,
): DashboardRunTimelineItem {
  const denied = relatedJob?.status === 'denied';
  return {
    id: `approval:${approvalId}:resolved`,
    runId,
    timestamp: relatedJob?.completedAt ?? fallbackTimestamp,
    type: 'approval_resolved',
    status: denied ? 'failed' : 'succeeded',
    source: 'code_session',
    title: denied
      ? `Approval denied: ${humanizeToolName(toolName)}`
      : `Approval cleared: ${humanizeToolName(toolName)}`,
    detail: denied
      ? nonEmptyText(relatedJob?.error) ?? 'The pending action was denied.'
      : 'The pending action was cleared and execution continued.',
    toolName,
    approvalId,
  };
}

function buildJobItems(runId: string, job: CodeSessionRecentJob, fallbackTimestamp: number): DashboardRunTimelineItem[] {
  const remoteDetail = job.remoteExecution?.profileName
    ? `Remote sandbox: ${job.remoteExecution.profileName}${job.remoteExecution.leaseReused ? ' (lease reused)' : ''}.`
    : null;
  const argsDetail = nonEmptyText(job.argsPreview);
  const items: DashboardRunTimelineItem[] = [{
    id: `job:${job.id}:started`,
    runId,
    timestamp: job.startedAt ?? job.createdAt ?? fallbackTimestamp,
    type: 'tool_call_started',
    status: job.status === 'running' ? 'running' : 'info',
    source: 'code_session',
    title: `Tool started: ${humanizeToolName(job.toolName)}`,
    detail: [argsDetail, remoteDetail].filter(Boolean).join('\n') || undefined,
    toolName: job.toolName,
  }];

  if ((job.status === 'pending_approval' || job.status === 'denied') && job.approvalId) {
    items.push({
      id: `approval:${job.approvalId}`,
      runId,
      timestamp: job.createdAt ?? fallbackTimestamp,
      type: 'approval_requested',
      status: job.status === 'denied' ? 'failed' : 'blocked',
      source: 'code_session',
      title: `Approval requested: ${humanizeToolName(job.toolName)}`,
      detail: nonEmptyText(job.argsPreview),
      toolName: job.toolName,
      approvalId: job.approvalId,
    });
  }

  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'denied') {
    items.push({
      id: `job:${job.id}:completed`,
      runId,
      timestamp: job.completedAt ?? job.createdAt ?? fallbackTimestamp,
      type: 'tool_call_completed',
      status: mapJobItemStatus(job.status),
      source: 'code_session',
      title: buildJobCompletionTitle(job),
      detail: [nonEmptyText(job.error) ?? nonEmptyText(job.resultPreview), remoteDetail].filter(Boolean).join('\n') || undefined,
      toolName: job.toolName,
    });
  }

  return items;
}

function buildVerificationItem(runId: string, entry: CodeSessionVerificationEntry): DashboardRunTimelineItem {
  const pending = entry.status === 'not_run';
  return {
    id: `verification:${entry.id}`,
    runId,
    timestamp: entry.timestamp,
    type: pending ? 'verification_pending' : 'verification_completed',
    status: pending
      ? 'warning'
      : entry.status === 'fail'
        ? 'failed'
        : entry.status === 'warn'
          ? 'warning'
          : 'succeeded',
    source: 'code_session',
    title: pending
      ? `Verification pending: ${humanizeVerificationKind(entry.kind)}`
      : `Verification ${entry.status}: ${humanizeVerificationKind(entry.kind)}`,
    detail: nonEmptyText(entry.summary),
    verificationKind: entry.kind,
  };
}

function buildCodingBackendProgressItem(runId: string, event: CodingBackendProgressEvent): DashboardRunTimelineItem {
  switch (event.kind) {
    case 'started':
      return {
        id: event.id,
        runId,
        timestamp: event.timestamp,
        type: 'tool_call_started',
        status: 'running',
        source: 'code_session',
        title: `Delegated to ${event.backendName}`,
        detail: nonEmptyText(event.detail),
        toolName: 'coding_backend_run',
      };
    case 'progress':
      return {
        id: event.id,
        runId,
        timestamp: event.timestamp,
        type: 'note',
        status: 'running',
        source: 'code_session',
        title: `${event.backendName} is working`,
        detail: nonEmptyText(event.detail),
        toolName: 'coding_backend_run',
      };
    case 'completed':
      return {
        id: event.id,
        runId,
        timestamp: event.timestamp,
        type: 'tool_call_completed',
        status: 'succeeded',
        source: 'code_session',
        title: `${event.backendName} completed`,
        detail: nonEmptyText(event.detail),
        toolName: 'coding_backend_run',
      };
    case 'timed_out':
      return {
        id: event.id,
        runId,
        timestamp: event.timestamp,
        type: 'tool_call_completed',
        status: 'failed',
        source: 'code_session',
        title: `${event.backendName} timed out`,
        detail: nonEmptyText(event.detail),
        toolName: 'coding_backend_run',
      };
    case 'failed':
    default:
      return {
        id: event.id,
        runId,
        timestamp: event.timestamp,
        type: 'tool_call_completed',
        status: 'failed',
        source: 'code_session',
        title: `${event.backendName} failed`,
        detail: nonEmptyText(event.detail),
        toolName: 'coding_backend_run',
      };
  }
}

function buildAssistantTraceItems(trace: AssistantDispatchTrace): DashboardRunTimelineItem[] {
  const items: DashboardRunTimelineItem[] = [{
    id: `trace:${trace.requestId}:queued`,
    runId: trace.runId,
    timestamp: trace.queuedAt,
    type: 'run_queued',
    status: 'info',
    source: 'orchestrator',
    title: `Queued ${trace.requestType}`,
    detail: sanitizePreview(trace.messagePreview),
  }];

  if (trace.startedAt) {
    items.push({
      id: `trace:${trace.requestId}:started`,
      runId: trace.runId,
      timestamp: trace.startedAt,
      type: 'run_started',
      status: 'running',
      source: 'orchestrator',
      title: `Started ${trace.requestType}`,
      detail: sanitizePreview(trace.messagePreview),
    });
  }

  for (const step of trace.steps) {
    const mapped = mapAssistantTraceStep(step.name, step.status);
    if (!mapped) continue;
    items.push({
      id: `step:${trace.requestId}:${step.name}`,
      runId: trace.runId,
      timestamp: step.completedAt ?? step.startedAt,
      type: 'note',
      status: mapped.status,
      source: 'orchestrator',
      title: mapped.title,
      ...(mapped.detail ? { detail: mapped.detail } : {}),
    });
  }

  for (const node of trace.nodes) {
    items.push(...buildTraceNodeItems(trace.runId, node));
  }

  if (trace.completedAt && trace.status === 'succeeded') {
    items.push({
      id: `trace:${trace.requestId}:completed`,
      runId: trace.runId,
      timestamp: trace.completedAt,
      type: 'run_completed',
      status: 'succeeded',
      source: 'orchestrator',
      title: 'Run completed',
      detail: sanitizePreview(trace.responsePreview),
    });
  }

  if (trace.completedAt && trace.status === 'failed') {
    items.push({
      id: `trace:${trace.requestId}:failed`,
      runId: trace.runId,
      timestamp: trace.completedAt,
      type: 'run_failed',
      status: 'failed',
      source: 'orchestrator',
      title: 'Run failed',
      detail: nonEmptyText(trace.error),
    });
  }

  return items;
}

function mapAssistantTraceStep(
  stepName: string,
  stepStatus: AssistantDispatchTrace['steps'][number]['status'],
): { title: string; status: DashboardRunTimelineItem['status']; detail?: string } | null {
  const normalized = nonEmptyText(stepName);
  if (!normalized || normalized === 'queue_wait' || normalized === 'handler') {
    return null;
  }

  const status = stepStatus === 'failed'
    ? 'failed'
    : stepStatus === 'running'
      ? 'running'
      : 'info';

  switch (normalized) {
    case 'message_built':
      return { title: 'Prepared request', status };
    case 'runtime_dispatch_message':
      return { title: 'Agent is working', status };
    case 'runtime_dispatch_fallback':
      return { title: 'Retrying with fallback', status };
    case 'quick_action_prompt_built':
      return { title: 'Prepared quick action', status };
    default:
      return {
        title: humanizeTraceStepName(normalized),
        status,
      };
  }
}

function humanizeTraceStepName(stepName: string): string {
  return stepName
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part, index) => index === 0
      ? part.charAt(0).toUpperCase() + part.slice(1)
      : part)
    .join(' ');
}

function buildTraceNodeItems(runId: string, node: WorkflowTraceNode): DashboardRunTimelineItem[] {
  const contextAssembly = extractContextAssembly(node);
  if (node.kind === 'handoff') {
    return [{
      id: `node:${node.id}:${node.status === 'running' ? 'handoff_started' : 'handoff_completed'}`,
      runId,
      timestamp: node.completedAt ?? node.startedAt,
      type: node.status === 'running' ? 'handoff_started' : 'handoff_completed',
      status: node.status === 'failed'
        ? 'failed'
        : node.status === 'blocked'
          ? 'blocked'
          : node.status === 'running'
            ? 'running'
            : 'succeeded',
      source: 'orchestrator',
      title: node.status === 'failed'
        ? `Handoff failed: ${node.name}`
        : node.status === 'blocked'
          ? `Handoff blocked: ${node.name}`
          : node.status === 'running'
            ? `Handoff: ${node.name}`
            : `Handoff completed: ${node.name}`,
      detail: extractNodeDetail(node),
      nodeId: node.id,
      ...(contextAssembly ? { contextAssembly } : {}),
    }];
  }
  if (node.kind === 'tool_call') {
    const items: DashboardRunTimelineItem[] = [{
      id: `node:${node.id}:started`,
      runId,
      timestamp: node.startedAt,
      type: 'tool_call_started',
      status: node.status === 'running' ? 'running' : 'info',
      source: 'orchestrator',
      title: `Tool started: ${humanizeToolName(node.name)}`,
      detail: extractNodeDetail(node),
      nodeId: node.id,
      toolName: node.name,
      ...(contextAssembly ? { contextAssembly } : {}),
    }];
    if (node.completedAt) {
      items.push({
        id: `node:${node.id}:completed`,
        runId,
        timestamp: node.completedAt,
        type: 'tool_call_completed',
        status: mapNodeStatus(node.status),
        source: 'orchestrator',
        title: buildNodeCompletionTitle(node),
        detail: extractNodeDetail(node),
        nodeId: node.id,
        toolName: node.name,
        ...(contextAssembly ? { contextAssembly } : {}),
      });
    }
    return items;
  }

  const mapped = mapTraceNodeKind(node.kind);
  return [{
    id: `node:${node.id}:${mapped.type}`,
    runId,
    timestamp: node.completedAt ?? node.startedAt,
    type: mapped.type,
    status: mapped.status,
    source: 'orchestrator',
    title: mapped.title(node.name),
    detail: extractNodeDetail(node),
    nodeId: node.id,
    ...(contextAssembly ? { contextAssembly } : {}),
  }];
}

function buildWorkflowEventItems(
  runId: string,
  events: OrchestrationRunEvent[],
  source: 'workflow' | 'system',
): DashboardRunTimelineItem[] {
  const items: DashboardRunTimelineItem[] = [];
  for (const event of Array.isArray(events) ? events : []) {
    const item = mapWorkflowEventToItem(runId, event, source);
    if (item) items.push(item);
  }
  return items;
}

function mapWorkflowEventToItem(
  runId: string,
  event: OrchestrationRunEvent,
  source: 'workflow' | 'system',
): DashboardRunTimelineItem | null {
  const shared = {
    id: `event:${event.id}`,
    runId,
    timestamp: event.timestamp,
    source,
    detail: nonEmptyText(event.message),
    nodeId: event.nodeId,
  } as const;

  switch (event.type) {
    case 'run_created':
      return { ...shared, type: 'run_started', status: 'running', title: 'Run started' };
    case 'node_started':
      return { ...shared, type: 'note', status: 'info', title: `Step started${event.nodeId ? `: ${event.nodeId}` : ''}` };
    case 'node_completed':
      return { ...shared, type: 'note', status: 'succeeded', title: `Step completed${event.nodeId ? `: ${event.nodeId}` : ''}` };
    case 'approval_requested':
      return { ...shared, type: 'approval_requested', status: 'blocked', title: 'Approval requested' };
    case 'approval_denied':
      return { ...shared, type: 'approval_resolved', status: 'failed', title: 'Approval denied' };
    case 'run_interrupted':
      return { ...shared, type: 'note', status: 'warning', title: 'Run interrupted' };
    case 'run_resumed':
      return { ...shared, type: 'note', status: 'running', title: 'Run resumed' };
    case 'handoff_started':
      return { ...shared, type: 'handoff_started', status: 'running', title: 'Handoff started' };
    case 'handoff_completed':
      return { ...shared, type: 'handoff_completed', status: 'succeeded', title: 'Handoff completed' };
    case 'verification_pending':
      return { ...shared, type: 'verification_pending', status: 'warning', title: 'Verification pending' };
    case 'verification_completed':
      return { ...shared, type: 'verification_completed', status: 'succeeded', title: 'Verification completed' };
    case 'run_completed':
      return { ...shared, type: 'run_completed', status: 'succeeded', title: 'Run completed' };
    case 'run_failed':
      return { ...shared, type: 'run_failed', status: 'failed', title: 'Run failed' };
    default:
      return null;
  }
}

function sanitizePreview(value: unknown): string | undefined {
  const normalized = nonEmptyText(typeof value === 'string' ? value : undefined);
  if (!normalized) return undefined;
  return normalized.replace(/^\[Context:\s*User is currently viewing the [^\]]+\]\s*/i, '') || undefined;
}

function inferCompletedAt(baseStatus: DashboardRunStatus, lastUpdatedAt: number): number | undefined {
  if (baseStatus === 'completed' || baseStatus === 'failed' || baseStatus === 'blocked' || baseStatus === 'interrupted') {
    return lastUpdatedAt;
  }
  return undefined;
}

function overlayStatus(
  baseStatus: DashboardRunStatus,
  pendingApprovalCount: number,
  verificationPendingCount: number,
): DashboardRunStatus {
  if (pendingApprovalCount > 0) return 'awaiting_approval';
  if (verificationPendingCount > 0) return 'verification_pending';
  return baseStatus;
}

function mapAssistantTraceStatus(status: AssistantDispatchTrace['status']): DashboardRunStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'succeeded':
    default:
      return 'completed';
  }
}

function mapPlaybookStatus(status: 'succeeded' | 'failed' | 'awaiting_approval'): DashboardRunStatus {
  switch (status) {
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'failed':
      return 'failed';
    case 'succeeded':
    default:
      return 'completed';
  }
}

function mapScheduledTaskStatus(status: 'succeeded' | 'failed' | 'pending_approval'): DashboardRunStatus {
  switch (status) {
    case 'pending_approval':
      return 'awaiting_approval';
    case 'failed':
      return 'failed';
    case 'succeeded':
    default:
      return 'completed';
  }
}

function mapCodingBackendProgressStatus(kind: CodingBackendProgressEvent['kind']): DashboardRunStatus {
  switch (kind) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'started':
    case 'progress':
    default:
      return 'running';
  }
}

function deriveCodeSessionBaseStatus(
  runId: string,
  approvals: CodeSessionPendingApproval[],
  jobs: CodeSessionRecentJob[],
  verification: CodeSessionVerificationEntry[],
  session: CodeSessionRecord,
): DashboardRunStatus {
  const runJobs = jobs.filter((job) => resolveRunId(session.id, job.requestId) === runId);
  const runVerification = verification.filter((entry) => resolveRunId(session.id, entry.requestId) === runId);
  const runApprovals = approvals.filter((approval) => resolveRunId(session.id, approval.requestId) === runId);

  if (runApprovals.length > 0) return 'running';
  if (runJobs.some((job) => job.status === 'denied')) return 'blocked';
  if (runJobs.some((job) => job.status === 'failed')) return 'failed';
  if (runJobs.some((job) => job.status === 'running' || job.status === 'pending_approval')) return 'running';
  if (runVerification.some((entry) => entry.status === 'fail')) return 'failed';
  if (runVerification.some((entry) => entry.status === 'not_run')) return 'running';
  if (runJobs.length > 0 || runVerification.length > 0) return 'completed';
  return 'queued';
}

function mapJobItemStatus(status: string): DashboardRunTimelineItem['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'denied') return 'blocked';
  if (status === 'failed') return 'failed';
  return 'running';
}

function buildJobCompletionTitle(job: CodeSessionRecentJob): string {
  if (job.status === 'succeeded') return `Tool completed: ${humanizeToolName(job.toolName)}`;
  if (job.status === 'denied') return `Tool denied: ${humanizeToolName(job.toolName)}`;
  return `Tool failed: ${humanizeToolName(job.toolName)}`;
}

function mapNodeStatus(status: WorkflowTraceNode['status']): DashboardRunTimelineItem['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  return 'running';
}

function buildNodeCompletionTitle(node: WorkflowTraceNode): string {
  if (node.status === 'blocked') return `Tool blocked: ${humanizeToolName(node.name)}`;
  if (node.status === 'failed') return `Tool failed: ${humanizeToolName(node.name)}`;
  return `Tool completed: ${humanizeToolName(node.name)}`;
}

function extractNodeDetail(node: WorkflowTraceNode): string | undefined {
  const metadata = isRecord(node.metadata) ? node.metadata : null;
  const explicitDetail = metadata && typeof metadata.detail === 'string' ? metadata.detail : null;
  const summary = metadata && typeof metadata.summary === 'string' ? metadata.summary : null;
  const result = metadata && isRecord(metadata.result) ? metadata.result : null;
  const error = result && typeof result.error === 'string' ? result.error : null;
  const message = result && typeof result.message === 'string' ? result.message : null;
  return truncateText(nonEmptyText(explicitDetail) ?? nonEmptyText(summary) ?? nonEmptyText(error) ?? nonEmptyText(message), 220);
}

function extractContextAssembly(node: WorkflowTraceNode): DashboardRunTimelineContextAssembly | undefined {
  const metadata = isRecord(node.metadata) ? node.metadata : null;
  if (!metadata) return undefined;
  const memoryScope = metadata.memoryScope === 'global' || metadata.memoryScope === 'coding_session' || metadata.memoryScope === 'none'
    ? metadata.memoryScope
    : undefined;
  const selectedMemoryEntries = Array.isArray(metadata.selectedMemoryEntries)
    ? metadata.selectedMemoryEntries
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const scope = entry.scope === 'global' || entry.scope === 'coding_session'
          ? entry.scope
          : undefined;
        const category = nonEmptyText(typeof entry.category === 'string' ? entry.category : undefined);
        const createdAt = nonEmptyText(typeof entry.createdAt === 'string' ? entry.createdAt : undefined);
        const preview = nonEmptyText(typeof entry.preview === 'string' ? entry.preview : undefined);
        const renderMode = entry.renderMode === 'full' || entry.renderMode === 'summary'
          ? entry.renderMode
          : null;
        const queryScore = typeof entry.queryScore === 'number' && Number.isFinite(entry.queryScore)
          ? entry.queryScore
          : 0;
        if (!category || !createdAt || !preview || !renderMode) return null;
        return {
          ...(scope ? { scope } : {}),
          category,
          createdAt,
          preview,
          renderMode,
          queryScore,
          isContextFlush: entry.isContextFlush === true,
          ...(Array.isArray(entry.matchReasons)
            ? {
                matchReasons: entry.matchReasons
                  .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                  .slice(0, 3),
              }
            : {}),
        };
      })
      .filter((entry): entry is DashboardRunTimelineContextMemoryEntry => !!entry)
    : [];
  const selectedMemoryEntryCount = typeof metadata.selectedMemoryEntryCount === 'number' && Number.isFinite(metadata.selectedMemoryEntryCount)
    ? metadata.selectedMemoryEntryCount
    : undefined;
  const omittedMemoryEntryCount = typeof metadata.omittedMemoryEntryCount === 'number' && Number.isFinite(metadata.omittedMemoryEntryCount)
    ? metadata.omittedMemoryEntryCount
    : undefined;
  const sectionFootprints = Array.isArray(metadata.sectionFootprints)
    ? metadata.sectionFootprints
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const section = nonEmptyText(typeof entry.section === 'string' ? entry.section : undefined);
        const chars = typeof entry.chars === 'number' && Number.isFinite(entry.chars) ? entry.chars : null;
        const included = entry.included === true || entry.included === false ? entry.included : null;
        const mode = nonEmptyText(typeof entry.mode === 'string' ? entry.mode : undefined);
        const itemCount = typeof entry.itemCount === 'number' && Number.isFinite(entry.itemCount) ? entry.itemCount : undefined;
        if (!section || chars === null || included === null) return null;
        return {
          section,
          chars,
          included,
          ...(mode ? { mode } : {}),
          ...(typeof itemCount === 'number' ? { itemCount } : {}),
        };
      })
      .filter((entry): entry is NonNullable<DashboardRunTimelineContextAssembly['sectionFootprints']>[number] => !!entry)
    : [];
  const preservedExecutionState = isRecord(metadata.preservedExecutionState)
    ? {
        ...(nonEmptyText(typeof metadata.preservedExecutionState.objective === 'string' ? metadata.preservedExecutionState.objective : undefined)
          ? { objective: nonEmptyText(typeof metadata.preservedExecutionState.objective === 'string' ? metadata.preservedExecutionState.objective : undefined) }
          : {}),
        ...(nonEmptyText(typeof metadata.preservedExecutionState.blockerSummary === 'string' ? metadata.preservedExecutionState.blockerSummary : undefined)
          ? { blockerSummary: nonEmptyText(typeof metadata.preservedExecutionState.blockerSummary === 'string' ? metadata.preservedExecutionState.blockerSummary : undefined) }
          : {}),
        ...(Array.isArray(metadata.preservedExecutionState.activeExecutionRefs)
          ? {
              activeExecutionRefs: metadata.preservedExecutionState.activeExecutionRefs
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim()),
            }
          : {}),
        ...(nonEmptyText(typeof metadata.preservedExecutionState.maintainedSummarySource === 'string' ? metadata.preservedExecutionState.maintainedSummarySource : undefined)
          ? { maintainedSummarySource: nonEmptyText(typeof metadata.preservedExecutionState.maintainedSummarySource === 'string' ? metadata.preservedExecutionState.maintainedSummarySource : undefined) }
          : {}),
      }
    : undefined;
  const skillInstructionSkillIds = Array.isArray(metadata.skillInstructionSkillIds)
    ? metadata.skillInstructionSkillIds
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const skillResourceSkillIds = Array.isArray(metadata.skillResourceSkillIds)
    ? metadata.skillResourceSkillIds
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const skillResourcePaths = Array.isArray(metadata.skillResourcePaths)
    ? metadata.skillResourcePaths
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const skillPromptCacheHits = Array.isArray(metadata.skillPromptCacheHits)
    ? metadata.skillPromptCacheHits
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const skillPromptLoadReasons = Array.isArray(metadata.skillPromptLoadReasons)
    ? metadata.skillPromptLoadReasons
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const skillArtifactReferences = Array.isArray(metadata.skillArtifactReferences)
    ? metadata.skillArtifactReferences
        .filter((entry): entry is DashboardRunTimelineSkillArtifactReference => {
          return !!entry
            && typeof entry === 'object'
            && typeof (entry as Record<string, unknown>).skillId === 'string'
            && typeof (entry as Record<string, unknown>).slug === 'string'
            && typeof (entry as Record<string, unknown>).title === 'string'
            && (((entry as Record<string, unknown>).scope === 'global') || ((entry as Record<string, unknown>).scope === 'coding_session'))
            && typeof (entry as Record<string, unknown>).sourceClass === 'string';
        })
        .map((entry) => ({
          skillId: entry.skillId.trim(),
          scope: entry.scope,
          slug: entry.slug.trim(),
          title: entry.title.trim(),
          sourceClass: entry.sourceClass.trim(),
        }))
    : [];
  const contextAssembly: DashboardRunTimelineContextAssembly = {
    ...(nonEmptyText(typeof metadata.summary === 'string' ? metadata.summary : undefined) ? { summary: nonEmptyText(typeof metadata.summary === 'string' ? metadata.summary : undefined) } : {}),
    ...(nonEmptyText(typeof metadata.detail === 'string' ? metadata.detail : undefined) ? { detail: nonEmptyText(typeof metadata.detail === 'string' ? metadata.detail : undefined) } : {}),
    ...(memoryScope ? { memoryScope } : {}),
    ...(typeof metadata.knowledgeBaseLoaded === 'boolean' ? { knowledgeBaseLoaded: metadata.knowledgeBaseLoaded } : {}),
    ...(typeof metadata.codingMemoryLoaded === 'boolean' ? { codingMemoryLoaded: metadata.codingMemoryLoaded } : {}),
    ...(typeof metadata.codingMemoryChars === 'number' && Number.isFinite(metadata.codingMemoryChars)
      ? { codingMemoryChars: metadata.codingMemoryChars }
      : {}),
    ...(nonEmptyText(typeof metadata.knowledgeBaseQueryPreview === 'string' ? metadata.knowledgeBaseQueryPreview : undefined)
      ? { knowledgeBaseQueryPreview: nonEmptyText(typeof metadata.knowledgeBaseQueryPreview === 'string' ? metadata.knowledgeBaseQueryPreview : undefined) }
      : {}),
    ...(nonEmptyText(typeof metadata.continuityKey === 'string' ? metadata.continuityKey : undefined)
      ? { continuityKey: nonEmptyText(typeof metadata.continuityKey === 'string' ? metadata.continuityKey : undefined) }
      : {}),
    ...(Array.isArray(metadata.activeExecutionRefs)
      ? {
          activeExecutionRefs: metadata.activeExecutionRefs
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim()),
        }
      : {}),
    ...(typeof metadata.linkedSurfaceCount === 'number' && Number.isFinite(metadata.linkedSurfaceCount)
      ? { linkedSurfaceCount: metadata.linkedSurfaceCount }
      : {}),
    ...(skillInstructionSkillIds.length > 0 ? { skillInstructionSkillIds } : {}),
    ...(skillResourceSkillIds.length > 0 ? { skillResourceSkillIds } : {}),
    ...(skillResourcePaths.length > 0 ? { skillResourcePaths } : {}),
    ...(typeof metadata.skillPromptCacheHitCount === 'number' && Number.isFinite(metadata.skillPromptCacheHitCount)
      ? { skillPromptCacheHitCount: metadata.skillPromptCacheHitCount }
      : {}),
    ...(skillPromptCacheHits.length > 0 ? { skillPromptCacheHits } : {}),
    ...(skillPromptLoadReasons.length > 0 ? { skillPromptLoadReasons } : {}),
    ...(skillArtifactReferences.length > 0 ? { skillArtifactReferences } : {}),
    ...(typeof selectedMemoryEntryCount === 'number' ? { selectedMemoryEntryCount } : {}),
    ...(typeof omittedMemoryEntryCount === 'number' ? { omittedMemoryEntryCount } : {}),
    ...(selectedMemoryEntries.length > 0 ? { selectedMemoryEntries } : {}),
    ...(metadata.contextCompactionApplied === true ? { contextCompactionApplied: true } : {}),
    ...(typeof metadata.contextCharsBeforeCompaction === 'number' && Number.isFinite(metadata.contextCharsBeforeCompaction)
      ? { contextCharsBeforeCompaction: metadata.contextCharsBeforeCompaction }
      : {}),
    ...(typeof metadata.contextCharsAfterCompaction === 'number' && Number.isFinite(metadata.contextCharsAfterCompaction)
      ? { contextCharsAfterCompaction: metadata.contextCharsAfterCompaction }
      : {}),
    ...(Array.isArray(metadata.contextCompactionStages)
      ? {
          contextCompactionStages: metadata.contextCompactionStages
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim()),
        }
      : {}),
    ...(nonEmptyText(typeof metadata.compactedSummaryPreview === 'string' ? metadata.compactedSummaryPreview : undefined)
      ? { compactedSummaryPreview: nonEmptyText(typeof metadata.compactedSummaryPreview === 'string' ? metadata.compactedSummaryPreview : undefined) }
      : {}),
    ...(sectionFootprints.length > 0 ? { sectionFootprints } : {}),
    ...(preservedExecutionState && Object.keys(preservedExecutionState).length > 0 ? { preservedExecutionState } : {}),
  };
  return Object.keys(contextAssembly).length > 0 ? contextAssembly : undefined;
}

function mapTraceNodeKind(kind: WorkflowTraceNode['kind']): {
  type: DashboardRunTimelineItemType;
  status: DashboardRunTimelineItem['status'];
  title: (name: string) => string;
} {
  switch (kind) {
    case 'handoff':
      return { type: 'handoff_started', status: 'running', title: (name) => `Handoff: ${name}` };
    case 'approval':
      return { type: 'approval_requested', status: 'blocked', title: (name) => `Approval: ${name}` };
    case 'verification':
      return { type: 'verification_pending', status: 'warning', title: (name) => `Verification: ${name}` };
    default:
      return { type: 'note', status: 'info', title: (name) => name };
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

function humanizeVerificationKind(kind: CodeSessionVerificationEntry['kind']): string {
  switch (kind) {
    case 'lint':
      return 'Lint';
    case 'build':
      return 'Build';
    case 'test':
      return 'Tests';
    default:
      return 'Verification';
  }
}

function nonEmptyText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function mergeTags(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value): value is string => !!nonEmptyText(value)))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
