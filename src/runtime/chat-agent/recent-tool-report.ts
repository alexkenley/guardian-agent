import type { UserMessage } from '../../agent/types.js';
import type { ResolvedCodeSessionContext } from '../code-sessions.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ToolJobRecord } from '../../tools/types.js';
import {
  formatToolReport,
  isToolReportQuery,
} from '../../util/tool-report.js';

type RecentToolReportTools = Pick<
  ToolExecutor,
  'isEnabled' | 'listJobs' | 'listJobsForCodeSession'
>;

export interface TryDirectRecentToolReportInput {
  tools?: RecentToolReportTools | null;
  message: UserMessage;
  resolvedCodeSession?: ResolvedCodeSessionContext | null;
}

export function tryDirectRecentToolReport(input: TryDirectRecentToolReportInput): string | null {
  if (!input.tools?.isEnabled()) return null;
  if (!isToolReportQuery(input.message.content)) return null;

  const jobs = selectMostRecentToolReportJobs(
    listScopedRecentToolReportJobs(input.tools, input.message, input.resolvedCodeSession),
  );

  const report = formatToolReport(jobs);
  return report || null;
}

export function listScopedRecentToolReportJobs(
  tools: RecentToolReportTools | undefined | null,
  message: UserMessage,
  resolvedCodeSession?: ResolvedCodeSessionContext | null,
): ToolJobRecord[] {
  const codeSessionId = resolvedCodeSession?.session.id?.trim();
  if (codeSessionId) {
    return tools?.listJobsForCodeSession(codeSessionId, 50) ?? [];
  }
  return (tools?.listJobs(50) ?? [])
    .filter((job) => job.userId === message.userId && job.channel === message.channel);
}

export function selectMostRecentToolReportJobs(jobs: ToolJobRecord[]): ToolJobRecord[] {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }
  const latestRequestId = normalizeToolReportRequestId(jobs[0]?.requestId);
  if (latestRequestId) {
    const requestScopedJobs = jobs.filter((job) =>
      normalizeToolReportRequestId(job.requestId) === latestRequestId);
    if (requestScopedJobs.length > 0) {
      return requestScopedJobs;
    }
  }
  const leadingUnscopedJobs: ToolJobRecord[] = [];
  for (const job of jobs) {
    if (normalizeToolReportRequestId(job.requestId)) {
      break;
    }
    leadingUnscopedJobs.push(job);
  }
  return leadingUnscopedJobs.length > 0 ? leadingUnscopedJobs : jobs;
}

export function normalizeToolReportRequestId(requestId: string | undefined): string | null {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  return normalized.length > 0 ? normalized : null;
}
