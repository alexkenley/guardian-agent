import { describe, expect, it } from 'vitest';
import {
  assistantTraceMatchesContextFilters,
  extractTraceContextFiltersFromTrace,
  intentRoutingTraceEntryMatchesContextFilters,
  runDetailMatchesContextFilters,
} from './trace-context-filters.js';

describe('trace context filters', () => {
  it('extracts continuity and active execution refs from assembled-context trace nodes', () => {
    const contexts = extractTraceContextFiltersFromTrace({
      nodes: [
        {
          id: 'compile-1',
          kind: 'compile',
          name: 'Assembled context',
          status: 'succeeded',
          metadata: {
            continuityKey: 'continuity-1',
            activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
          },
        },
      ],
    });

    expect(contexts).toEqual([{
      continuityKey: 'continuity-1',
      activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
    }]);
  });

  it('matches assistant traces by continuity key and active execution ref', () => {
    const trace = {
      nodes: [
        {
          id: 'compile-1',
          kind: 'compile',
          name: 'Assembled context',
          status: 'succeeded',
          metadata: {
            continuityKey: 'continuity-1',
            activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
          },
        },
      ],
    };

    expect(assistantTraceMatchesContextFilters(trace, { continuityKey: 'continuity-1' })).toBe(true);
    expect(assistantTraceMatchesContextFilters(trace, { activeExecutionRef: 'repo fix' })).toBe(true);
    expect(assistantTraceMatchesContextFilters(trace, {
      continuityKey: 'continuity-1',
      activeExecutionRef: 'approval-1',
    })).toBe(true);
    expect(assistantTraceMatchesContextFilters(trace, { continuityKey: 'continuity-2' })).toBe(false);
  });

  it('matches run details by structured context assembly metadata', () => {
    const detail = {
      summary: {
        runId: 'run-1',
        groupId: 'group-1',
        kind: 'assistant_dispatch',
        status: 'completed',
        title: 'Run 1',
        startedAt: 1,
        lastUpdatedAt: 2,
        pendingApprovalCount: 0,
        verificationPendingCount: 0,
        tags: [],
      },
      items: [
        {
          id: 'item-1',
          runId: 'run-1',
          timestamp: 2,
          type: 'note',
          status: 'info',
          source: 'system',
          title: 'Assembled context',
          contextAssembly: {
            continuityKey: 'continuity-1',
            activeExecutionRefs: ['code_session:Repo Fix'],
          },
        },
      ],
    };

    expect(runDetailMatchesContextFilters(detail, { continuityKey: 'continuity-1' })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, { activeExecutionRef: 'repo' })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, { activeExecutionRef: 'missing' })).toBe(false);
  });

  it('matches run details by summary identity plus item context metadata', () => {
    const detail = {
      summary: {
        runId: 'run-1',
        groupId: 'group-1',
        kind: 'assistant_dispatch',
        status: 'completed',
        title: 'Run 1',
        startedAt: 1,
        lastUpdatedAt: 2,
        pendingApprovalCount: 0,
        verificationPendingCount: 0,
        tags: [],
        executionId: 'execution-123',
        rootExecutionId: 'root-456',
        codeSessionId: 'code-session-789',
      },
      items: [
        {
          id: 'item-1',
          runId: 'run-1',
          timestamp: 2,
          type: 'note',
          status: 'info',
          source: 'system',
          title: 'Assembled context',
          contextAssembly: {
            continuityKey: 'continuity-1',
            activeExecutionRefs: ['pending_action:approval-1'],
          },
        },
      ],
    };

    expect(runDetailMatchesContextFilters(detail, { codeSessionId: 'session-789' })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, {
      continuityKey: 'continuity-1',
      codeSessionId: 'session-789',
    })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, { executionId: 'execution-123' })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, { rootExecutionId: 'root-456' })).toBe(true);
    expect(runDetailMatchesContextFilters(detail, {
      continuityKey: 'continuity-1',
      codeSessionId: 'missing',
    })).toBe(false);
  });

  it('matches intent routing trace entries by continuity key and active execution ref', () => {
    const entry = {
      details: {
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix', 'pending_action:approval-1'],
        executionId: 'execution-123',
        taskExecutionId: 'task-456',
        pendingActionId: 'approval-1',
        codeSessionId: 'code-session-789',
      },
    };

    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { continuityKey: 'continuity-1' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { activeExecutionRef: 'repo fix' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { activeExecutionRef: 'approval-1' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { executionId: 'execution-123' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { taskExecutionId: 'task-456' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { pendingActionId: 'approval-1' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { codeSessionId: 'session-789' })).toBe(true);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { continuityKey: 'continuity-other' })).toBe(false);
    expect(intentRoutingTraceEntryMatchesContextFilters(entry, { executionId: 'execution-other' })).toBe(false);
  });
});
