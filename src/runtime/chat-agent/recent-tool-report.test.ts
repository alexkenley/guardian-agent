import { describe, expect, it } from 'vitest';

import type { UserMessage } from '../../agent/types.js';
import type { ResolvedCodeSessionContext } from '../code-sessions.js';
import type { ToolJobRecord } from '../../tools/types.js';
import {
  listScopedRecentToolReportJobs,
  normalizeToolReportRequestId,
  selectMostRecentToolReportJobs,
  tryDirectRecentToolReport,
} from './recent-tool-report.js';

function message(content = 'show recent tool results'): UserMessage {
  return {
    id: 'msg-1',
    userId: 'owner',
    channel: 'web',
    content,
    timestamp: 1,
  };
}

function job(input: Partial<ToolJobRecord> & Pick<ToolJobRecord, 'id'>): ToolJobRecord {
  return {
    toolName: 'fs_read',
    risk: 'low',
    origin: 'assistant',
    argsPreview: '',
    status: 'completed',
    createdAt: 1,
    requiresApproval: false,
    ...input,
  };
}

describe('recent tool report helpers', () => {
  it('scopes recent jobs to the attached code session when present', () => {
    const sessionContext = {
      session: {
        id: 'session-1',
      },
    } as ResolvedCodeSessionContext;
    const tools = {
      isEnabled: () => true,
      listJobs: () => [job({ id: 'global-job', userId: 'owner', channel: 'web' })],
      listJobsForCodeSession: () => [job({ id: 'session-job', codeSessionId: 'session-1' })],
    };

    expect(listScopedRecentToolReportJobs(tools, message(), sessionContext).map((entry) => entry.id))
      .toEqual(['session-job']);
  });

  it('groups the latest request-scoped jobs for reporting', () => {
    const jobs = [
      job({ id: 'latest-a', requestId: 'req-latest' }),
      job({ id: 'latest-b', requestId: 'req-latest' }),
      job({ id: 'older', requestId: 'req-older' }),
    ];

    expect(selectMostRecentToolReportJobs(jobs).map((entry) => entry.id))
      .toEqual(['latest-a', 'latest-b']);
  });

  it('uses leading unscoped jobs when the latest jobs have no request id', () => {
    const jobs = [
      job({ id: 'unscoped-a' }),
      job({ id: 'unscoped-b' }),
      job({ id: 'scoped', requestId: 'req-1' }),
    ];

    expect(selectMostRecentToolReportJobs(jobs).map((entry) => entry.id))
      .toEqual(['unscoped-a', 'unscoped-b']);
    expect(normalizeToolReportRequestId('  req-1  ')).toBe('req-1');
    expect(normalizeToolReportRequestId('   ')).toBeNull();
  });

  it('formats a report only for explicit tool-report queries', () => {
    const tools = {
      isEnabled: () => true,
      listJobs: () => [job({
        id: 'job-1',
        userId: 'owner',
        channel: 'web',
        toolName: 'fs_read',
        argsPreview: 'README.md',
        argsRedacted: { path: 'README.md' },
        resultPreview: 'ok',
        completedAt: Date.now(),
      })],
      listJobsForCodeSession: () => [],
    };

    expect(tryDirectRecentToolReport({ tools, message: message('hello') })).toBeNull();
    expect(tryDirectRecentToolReport({ tools, message: message('what tools did you use?') }))
      .toContain('fs_read');
  });
});
