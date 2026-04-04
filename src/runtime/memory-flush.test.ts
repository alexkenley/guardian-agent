import { describe, expect, it } from 'vitest';
import {
  buildMemoryFlushEntry,
  buildMemoryFlushMaintenanceMetadata,
  describeMemoryFlushDeduplicatedDetail,
  describeMemoryFlushFailureDetail,
  describeMemoryFlushMaintenanceDetail,
  describeMemoryFlushSkipDetail,
  inferMemoryFlushScope,
} from './memory-flush.js';

const sampleFlush = {
  sessionId: 'session-1',
  droppedMessages: [
    { role: 'user' as const, content: 'Create a browser automation that captures the page title and H1.', timestamp: 1 },
    { role: 'assistant' as const, content: 'I can do that once you confirm the target output path.', timestamp: 2 },
  ],
  totalDroppedCount: 2,
  newlyDroppedCount: 2,
};

const sampleCodeSession = {
  codeSessionId: 'code-1',
  title: 'Repo Fix',
  focusSummary: 'Fix the parser regression safely.',
  planSummary: 'Check tokenizer, parser, and regression tests.',
  compactedSummary: 'Compacted repo context.',
  pendingApprovalCount: 1,
};

const sampleContinuity = {
  continuityKey: 'continuity-1',
  focusSummary: 'Continue the browser automation authoring flow.',
  lastActionableRequest: 'Create the browser automation and save the artifact.',
};

const samplePendingAction = {
  blockerKind: 'clarification',
  prompt: 'Which output path should I use?',
  route: 'automation',
  operation: 'create',
};

describe('memory flush helpers', () => {
  it('builds maintenance metadata for global and code-session flushes', () => {
    expect(buildMemoryFlushMaintenanceMetadata({
      key: { agentId: 'assistant', userId: 'user-1', channel: 'web' },
      flush: sampleFlush,
      continuity: sampleContinuity,
      pendingAction: samplePendingAction,
      codeSession: null,
    })).toEqual({
      maintenance: {
        kind: 'memory_hygiene',
        maintenanceType: 'context_flush',
        artifact: 'memory_entry',
        bounded: true,
        scope: 'global',
        sessionId: 'session-1',
        totalDroppedCount: 2,
        newlyDroppedCount: 2,
        continuityKey: 'continuity-1',
        route: 'automation',
      },
    });

    expect(buildMemoryFlushMaintenanceMetadata({
      key: { agentId: 'assistant', userId: 'code-session:code-1', channel: 'code-session' },
      flush: sampleFlush,
      continuity: sampleContinuity,
      pendingAction: null,
      codeSession: sampleCodeSession,
    }).maintenance.scope).toBe('code_session');
  });

  it('describes success, skip, and failure detail strings', () => {
    expect(describeMemoryFlushMaintenanceDetail({
      scope: 'global',
      newlyDroppedCount: 2,
      summary: 'Context flush for browser automation 2 captured lines',
    })).toContain('Context flush persisted to global memory');
    expect(describeMemoryFlushDeduplicatedDetail({
      scope: 'global',
      newlyDroppedCount: 2,
    })).toContain('Context flush deduplicated for global memory');
    expect(describeMemoryFlushSkipDetail({
      scope: 'code_session',
      reason: 'read_only',
      codeSessionId: 'code-1',
      newlyDroppedCount: 2,
    })).toContain('Context flush skipped for code session code-1: store is read-only');
    expect(describeMemoryFlushFailureDetail({
      scope: 'global',
      newlyDroppedCount: 2,
    })).toContain('Context flush failed for global memory');
  });

  it('infers the maintenance scope from code-session context', () => {
    expect(inferMemoryFlushScope(null)).toBe('global');
    expect(inferMemoryFlushScope(sampleCodeSession)).toBe('code_session');
  });
});

describe('buildMemoryFlushEntry', () => {
  it('builds a structured flush record that preserves objective and blocker context', () => {
    const entry = buildMemoryFlushEntry({
      key: { agentId: 'assistant', userId: 'user-1', channel: 'web' },
      flush: sampleFlush,
      createdAt: '2026-03-30',
      maxEntryChars: 900,
      continuity: {
        continuityKey: 'continuity-1',
        focusSummary: 'Continue the browser automation authoring flow.',
        lastActionableRequest: 'Create the browser automation and save the artifact.',
      },
      pendingAction: {
        blockerKind: 'clarification',
        prompt: 'Which output path should I use?',
        route: 'automation',
        operation: 'create',
      },
    });

    expect(entry).toBeTruthy();
    expect(entry?.category).toBe('Context Flushes');
    expect(entry?.summary).toContain('Context flush for');
    expect(entry?.content).toContain('objective:');
    expect(entry?.content).toContain('activeBlocker:');
    expect(entry?.content).toContain('Which output path should I use?');
    expect(entry?.content).toContain('transcript:');
    expect(entry?.tags).toContain('context_flush');
    expect(entry?.tags).toContain('clarification');
    expect(entry?.tags).toContain('automation');
    expect(entry?.tags).toContain('create');
  });

  it('respects the entry budget and still keeps the structured summary', () => {
    const entry = buildMemoryFlushEntry({
      key: { agentId: 'assistant', userId: 'user-1', channel: 'code-session' },
      flush: {
        sessionId: 'session-2',
        droppedMessages: [
          { role: 'user', content: 'Investigate the parser regression and keep track of the current goal, the blocker, and the verification plan.'.repeat(3), timestamp: 1 },
          { role: 'assistant', content: 'I am reviewing the codebase and building a verification plan with the current blocker in mind.'.repeat(2), timestamp: 2 },
        ],
        totalDroppedCount: 2,
        newlyDroppedCount: 2,
      },
      createdAt: '2026-03-30',
      maxEntryChars: 280,
      codeSession: {
        codeSessionId: 'code-1',
        title: 'Parser Repair',
        focusSummary: 'Fix the parser regression safely.',
        planSummary: 'Check tokenizer, parser, and regression tests.',
      },
    });

    expect(entry).toBeTruthy();
    expect(entry!.content.length).toBeLessThanOrEqual(280);
    expect(entry!.content).toContain('## Context Flush');
    expect(entry!.content).toContain('codeSessionId: code-1');
    expect(entry!.summary).toContain('captured lines');
  });
});
