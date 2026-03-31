/**
 * Assistant background job tracker.
 *
 * Tracks high-level jobs (intel scans, config apply, scheduled maintenance)
 * so operators can inspect what is running and what recently failed.
 */

export type AssistantJobStatus = 'running' | 'succeeded' | 'failed';
export type AssistantJobSource = 'manual' | 'scheduled' | 'system';
export type DelegatedWorkerRunClass = 'in_invocation' | 'short_lived' | 'long_running' | 'automation_owned';
export type DelegatedWorkerReportingMode = 'inline_response' | 'held_for_approval' | 'status_only' | 'held_for_operator';
export type DelegatedWorkerOperatorFollowUpState = 'pending' | 'kept_held' | 'replayed' | 'dismissed';
export type DelegatedWorkerOperatorAction = 'replay' | 'keep_held' | 'dismiss';

export interface AssistantJobRecord {
  id: string;
  type: string;
  source: AssistantJobSource;
  status: AssistantJobStatus;
  startedAt: number;
  updatedAt?: number;
  completedAt?: number;
  durationMs?: number;
  detail?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  display?: AssistantJobDisplay;
}

export interface AssistantJobSummary {
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
}

export interface AssistantJobState {
  summary: AssistantJobSummary;
  jobs: AssistantJobRecord[];
}

export interface DelegatedWorkerHandoff {
  summary: string;
  unresolvedBlockerKind?: string;
  approvalCount?: number;
  nextAction?: string;
  runClass?: DelegatedWorkerRunClass;
  reportingMode?: DelegatedWorkerReportingMode;
  operatorState?: DelegatedWorkerOperatorFollowUpState;
}

export interface DelegatedWorkerMetadata {
  kind: 'brokered_worker';
  lifecycle?: 'running' | 'completed' | 'blocked' | 'failed';
  originChannel?: string;
  continuityKey?: string;
  codeSessionId?: string;
  runClass?: DelegatedWorkerRunClass;
  handoff?: DelegatedWorkerHandoff;
}

export interface AssistantJobDisplayFollowUp {
  reportingMode: DelegatedWorkerReportingMode;
  label: string;
  needsOperatorAction: boolean;
  blockerKind?: string;
  approvalCount?: number;
  nextAction?: string;
  operatorState?: DelegatedWorkerOperatorFollowUpState;
  actions?: DelegatedWorkerOperatorAction[];
}

export interface AssistantJobDisplay {
  originSummary: string;
  outcomeSummary: string;
  followUp?: AssistantJobDisplayFollowUp;
}

export interface AssistantJobInput {
  type: string;
  source?: AssistantJobSource;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantJobUpdate {
  detail?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantJobTrackerOptions {
  maxJobs?: number;
  now?: () => number;
}

const DEFAULT_MAX_JOBS = 400;

let nextJobId = 1;
function createJobId(now: number): string {
  return `job-${now}-${nextJobId++}`;
}

export class AssistantJobTracker {
  private readonly maxJobs: number;
  private readonly now: () => number;
  private readonly jobs: AssistantJobRecord[] = [];

  constructor(options: AssistantJobTrackerOptions = {}) {
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.now = options.now ?? Date.now;
  }

  async run<T>(input: AssistantJobInput, handler: () => Promise<T>): Promise<T> {
    const job = this.start(input);

    try {
      const result = await handler();
      this.succeed(job.id);
      return result;
    } catch (err) {
      this.fail(job.id, err);
      throw err;
    }
  }

  start(input: AssistantJobInput): AssistantJobRecord {
    const startedAt = this.now();
    const job: AssistantJobRecord = {
      id: createJobId(startedAt),
      type: input.type,
      source: input.source ?? 'system',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      detail: input.detail,
      metadata: input.metadata,
    };
    this.jobs.unshift(job);
    this.enforceMax();
    return { ...job };
  }

  update(jobId: string, patch: AssistantJobUpdate): AssistantJobRecord | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    if (patch.detail !== undefined) job.detail = patch.detail;
    if (patch.error !== undefined) job.error = patch.error;
    if (patch.metadata !== undefined) {
      job.metadata = {
        ...(job.metadata ?? {}),
        ...patch.metadata,
      };
    }
    job.updatedAt = this.now();
    return { ...job };
  }

  getJob(jobId: string): AssistantJobRecord | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    return job ? { ...job } : null;
  }

  succeed(jobId: string, patch?: AssistantJobUpdate): AssistantJobRecord | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    if (patch) this.update(jobId, patch);
    const completedAt = this.now();
    job.status = 'succeeded';
    job.completedAt = completedAt;
    job.updatedAt = completedAt;
    job.durationMs = Math.max(0, completedAt - job.startedAt);
    return { ...job };
  }

  fail(jobId: string, error: unknown, patch?: AssistantJobUpdate): AssistantJobRecord | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    if (patch) this.update(jobId, patch);
    const completedAt = this.now();
    job.status = 'failed';
    job.completedAt = completedAt;
    job.updatedAt = completedAt;
    job.durationMs = Math.max(0, completedAt - job.startedAt);
    job.error = error instanceof Error ? error.message : String(error);
    return { ...job };
  }

  getState(limit = 50): AssistantJobState {
    const jobs = this.jobs.slice(0, Math.max(1, limit));
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    let lastStartedAt: number | undefined;
    let lastCompletedAt: number | undefined;

    for (const job of this.jobs) {
      if (!lastStartedAt || job.startedAt > lastStartedAt) {
        lastStartedAt = job.startedAt;
      }
      if (job.completedAt && (!lastCompletedAt || job.completedAt > lastCompletedAt)) {
        lastCompletedAt = job.completedAt;
      }

      if (job.status === 'running') running += 1;
      else if (job.status === 'succeeded') succeeded += 1;
      else failed += 1;
    }

    return {
      summary: {
        total: this.jobs.length,
        running,
        succeeded,
        failed,
        lastStartedAt,
        lastCompletedAt,
      },
      jobs,
    };
  }

  private enforceMax(): void {
    if (this.jobs.length <= this.maxJobs) return;
    this.jobs.splice(this.maxJobs);
  }
}

export function buildAssistantJobDisplay(job: Pick<AssistantJobRecord, 'detail' | 'error' | 'metadata' | 'source'>): AssistantJobDisplay {
  const delegated = readDelegatedWorkerMetadata(job.metadata);
  if (!delegated) {
    return {
      originSummary: job.source || '-',
      outcomeSummary: job.detail || job.error || '-',
    };
  }

  const originParts = [
    typeof delegated.originChannel === 'string' ? delegated.originChannel : '',
    typeof delegated.codeSessionId === 'string' ? `code ${delegated.codeSessionId}` : '',
    typeof delegated.continuityKey === 'string' ? `continuity ${delegated.continuityKey}` : '',
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  const followUp = buildDelegatedWorkerFollowUp(delegated.handoff);

  return {
    originSummary: originParts.join(' • ') || job.source || '-',
    outcomeSummary: delegated.handoff?.summary || job.detail || job.error || '-',
    ...(followUp ? { followUp } : {}),
  };
}

export function readDelegatedWorkerMetadata(metadata: Record<string, unknown> | undefined): DelegatedWorkerMetadata | null {
  const delegated = metadata?.delegation;
  if (!isRecord(delegated) || delegated.kind !== 'brokered_worker') {
    return null;
  }
  let handoff: DelegatedWorkerHandoff | undefined;
  if (isRecord(delegated.handoff)) {
    handoff = {
      summary: typeof delegated.handoff.summary === 'string'
        ? delegated.handoff.summary
        : 'Delegated worker completed.',
      ...(typeof delegated.handoff.unresolvedBlockerKind === 'string'
        ? { unresolvedBlockerKind: delegated.handoff.unresolvedBlockerKind }
        : {}),
      ...(typeof delegated.handoff.approvalCount === 'number'
        ? { approvalCount: delegated.handoff.approvalCount }
        : {}),
      ...(typeof delegated.handoff.nextAction === 'string'
        ? { nextAction: delegated.handoff.nextAction }
        : {}),
      ...((delegated.handoff.runClass === 'in_invocation'
        || delegated.handoff.runClass === 'short_lived'
        || delegated.handoff.runClass === 'long_running'
        || delegated.handoff.runClass === 'automation_owned')
        ? { runClass: delegated.handoff.runClass }
        : {}),
      ...((delegated.handoff.reportingMode === 'inline_response'
        || delegated.handoff.reportingMode === 'held_for_approval'
        || delegated.handoff.reportingMode === 'status_only')
        ? { reportingMode: delegated.handoff.reportingMode }
        : {}),
      ...((delegated.handoff.reportingMode === 'held_for_operator')
        ? { reportingMode: delegated.handoff.reportingMode }
        : {}),
      ...((delegated.handoff.operatorState === 'pending'
        || delegated.handoff.operatorState === 'kept_held'
        || delegated.handoff.operatorState === 'replayed'
        || delegated.handoff.operatorState === 'dismissed')
        ? { operatorState: delegated.handoff.operatorState }
        : {}),
    };
  }

  return {
    kind: 'brokered_worker',
    ...(typeof delegated.lifecycle === 'string'
      && ['running', 'completed', 'blocked', 'failed'].includes(delegated.lifecycle)
      ? { lifecycle: delegated.lifecycle as DelegatedWorkerMetadata['lifecycle'] }
      : {}),
    ...(typeof delegated.originChannel === 'string' ? { originChannel: delegated.originChannel } : {}),
    ...(typeof delegated.continuityKey === 'string' ? { continuityKey: delegated.continuityKey } : {}),
    ...(typeof delegated.codeSessionId === 'string' ? { codeSessionId: delegated.codeSessionId } : {}),
    ...((delegated.runClass === 'in_invocation'
      || delegated.runClass === 'short_lived'
      || delegated.runClass === 'long_running'
      || delegated.runClass === 'automation_owned')
      ? { runClass: delegated.runClass as DelegatedWorkerRunClass }
      : {}),
    ...(handoff ? { handoff } : {}),
  };
}

function buildDelegatedWorkerFollowUp(
  handoff: DelegatedWorkerHandoff | undefined,
): AssistantJobDisplayFollowUp | undefined {
  if (!handoff?.reportingMode) return undefined;

  if (handoff.reportingMode === 'held_for_approval') {
    const approvalCount = handoff.approvalCount && handoff.approvalCount > 0
      ? handoff.approvalCount
      : undefined;
    return {
      reportingMode: handoff.reportingMode,
      label: approvalCount && approvalCount > 1 ? `${approvalCount} approvals pending` : 'Approval pending',
      needsOperatorAction: true,
      ...(typeof handoff.unresolvedBlockerKind === 'string' ? { blockerKind: handoff.unresolvedBlockerKind } : {}),
      ...(approvalCount ? { approvalCount } : {}),
      ...(typeof handoff.nextAction === 'string' ? { nextAction: handoff.nextAction } : {}),
    };
  }

  if (handoff.reportingMode === 'status_only') {
    const label = handoff.unresolvedBlockerKind === 'clarification'
      ? 'Clarification required'
      : handoff.unresolvedBlockerKind === 'workspace_switch'
        ? 'Workspace switch required'
        : 'Status only';
    return {
      reportingMode: handoff.reportingMode,
      label,
      needsOperatorAction: true,
      ...(typeof handoff.unresolvedBlockerKind === 'string' ? { blockerKind: handoff.unresolvedBlockerKind } : {}),
      ...(typeof handoff.approvalCount === 'number' ? { approvalCount: handoff.approvalCount } : {}),
      ...(typeof handoff.nextAction === 'string' ? { nextAction: handoff.nextAction } : {}),
    };
  }

  if (handoff.reportingMode === 'held_for_operator') {
    const operatorState = handoff.operatorState ?? 'pending';
    if (operatorState === 'dismissed') {
      return {
        reportingMode: handoff.reportingMode,
        label: 'Dismissed',
        needsOperatorAction: false,
        operatorState,
      };
    }
    if (operatorState === 'replayed') {
      return {
        reportingMode: handoff.reportingMode,
        label: 'Replayed to operator',
        needsOperatorAction: true,
        operatorState,
        actions: ['replay', 'dismiss'],
        ...(typeof handoff.nextAction === 'string' ? { nextAction: handoff.nextAction } : {}),
      };
    }
    return {
      reportingMode: handoff.reportingMode,
      label: 'Held for operator review',
      needsOperatorAction: true,
      operatorState,
      actions: ['replay', 'keep_held', 'dismiss'],
      ...(typeof handoff.nextAction === 'string' ? { nextAction: handoff.nextAction } : {}),
    };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeAssistantJobStates(states: AssistantJobState[], limit = 50): AssistantJobState {
  const mergedJobs = states
    .flatMap((state) => state.jobs)
    .slice()
    .sort((left, right) => {
      const leftTime = left.startedAt || 0;
      const rightTime = right.startedAt || 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return right.id.localeCompare(left.id);
    });

  let running = 0;
  let succeeded = 0;
  let failed = 0;
  let lastStartedAt: number | undefined;
  let lastCompletedAt: number | undefined;

  for (const job of mergedJobs) {
    if (!lastStartedAt || job.startedAt > lastStartedAt) {
      lastStartedAt = job.startedAt;
    }
    if (job.completedAt && (!lastCompletedAt || job.completedAt > lastCompletedAt)) {
      lastCompletedAt = job.completedAt;
    }
    if (job.status === 'running') running += 1;
    else if (job.status === 'succeeded') succeeded += 1;
    else failed += 1;
  }

  return {
    summary: {
      total: mergedJobs.length,
      running,
      succeeded,
      failed,
      lastStartedAt,
      lastCompletedAt,
    },
    jobs: mergedJobs.slice(0, Math.max(1, limit)),
  };
}

export function selectOperatorRelevantAssistantJobs(
  jobs: AssistantJobRecord[],
  limit = 12,
): AssistantJobRecord[] {
  const cappedLimit = Math.max(1, limit);
  if (jobs.length <= cappedLimit) {
    return jobs.slice(0, cappedLimit);
  }

  const relevant = jobs.filter((job) => !isRoutineDelegatedWorkerJob(job));
  if (relevant.length === 0) {
    return jobs.slice(0, cappedLimit);
  }

  const selectedIds = new Set<string>();
  const ordered: AssistantJobRecord[] = [];
  for (const job of relevant) {
    if (selectedIds.has(job.id)) continue;
    ordered.push(job);
    selectedIds.add(job.id);
    if (ordered.length >= cappedLimit) {
      return ordered;
    }
  }
  for (const job of jobs) {
    if (selectedIds.has(job.id)) continue;
    ordered.push(job);
    selectedIds.add(job.id);
    if (ordered.length >= cappedLimit) {
      break;
    }
  }
  return ordered;
}

function isRoutineDelegatedWorkerJob(job: AssistantJobRecord): boolean {
  if (job.type !== 'delegated_worker') return false;
  if (job.status !== 'succeeded') return false;
  if (job.source !== 'system' && job.source !== 'scheduled') return false;

  const delegated = readDelegatedWorkerMetadata(job.metadata);
  if (!delegated?.handoff) return false;
  if (delegated.handoff.unresolvedBlockerKind) return false;
  if (delegated.handoff.approvalCount && delegated.handoff.approvalCount > 0) return false;
  if (delegated.handoff.reportingMode === 'held_for_approval'
    || delegated.handoff.reportingMode === 'status_only'
    || delegated.handoff.reportingMode === 'held_for_operator') {
    return false;
  }
  return true;
}
