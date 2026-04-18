import { describe, expect, it } from 'vitest';
import {
  ContinuityThreadStore,
  formatContinuityThreadForPrompt,
  summarizeContinuityThreadForGateway,
  toContinuityThreadClientMetadata,
  type ContinuityThreadScope,
} from './continuity-threads.js';

function createScope(): ContinuityThreadScope {
  return {
    assistantId: 'shared-tier',
    userId: 'owner',
  };
}

function createStore(nowMs = 1_710_000_000_000): ContinuityThreadStore {
  return new ContinuityThreadStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-continuity-threads.test.sqlite',
    retentionDays: 30,
    now: () => nowMs,
  });
}

describe('ContinuityThreadStore', () => {
  it('touches surfaces and stores bounded continuity state', () => {
    const store = createStore();
    const scope = createScope();
    store.upsert(scope, {
      touchSurface: { channel: 'web', surfaceId: 'chat-main' },
      focusSummary: 'Follow-up on the current email task.',
      lastActionableRequest: 'Check my email and summarize the latest unread message.',
      activeExecutionRefs: [{ kind: 'code_session', id: 'session-1', label: 'Guardian Agent workspace' }],
      continuationState: {
        kind: 'paged_list',
        payload: { offset: 0, limit: 20, total: 45 },
      },
    });

    const record = store.get(scope);

    expect(record).not.toBeNull();
    expect(record?.linkedSurfaces).toEqual([
      {
        channel: 'web',
        surfaceId: 'chat-main',
        active: true,
        lastSeenAt: 1_710_000_000_000,
      },
    ]);
    expect(record?.focusSummary).toBe('Follow-up on the current email task.');
    expect(record?.activeExecutionRefs).toEqual([
      { kind: 'code_session', id: 'session-1', label: 'Guardian Agent workspace' },
    ]);
    expect(record?.continuationState).toEqual({
      kind: 'paged_list',
      payload: { offset: 0, limit: 20, total: 45 },
    });
  });

  it('merges linked surfaces for the same continuity thread', () => {
    const nowMs = 1_710_000_000_000;
    const store = createStore(nowMs);
    const scope = createScope();
    store.upsert(scope, {
      touchSurface: { channel: 'web', surfaceId: 'chat-main' },
      focusSummary: 'Original focus.',
    }, nowMs);
    store.upsert(scope, {
      touchSurface: { channel: 'telegram', surfaceId: 'thread-42' },
    }, nowMs + 5_000);

    const record = store.get(scope, nowMs + 5_000);

    expect(record?.linkedSurfaces).toEqual([
      {
        channel: 'telegram',
        surfaceId: 'thread-42',
        active: true,
        lastSeenAt: nowMs + 5_000,
      },
      {
        channel: 'web',
        surfaceId: 'chat-main',
        active: true,
        lastSeenAt: nowMs,
      },
    ]);
    expect(record?.focusSummary).toBe('Original focus.');
  });

  it('summarizes continuity for gateway, clients, and prompt assembly', () => {
    const store = createStore();
    const scope = createScope();
    const record = store.upsert(scope, {
      touchSurface: { channel: 'cli', surfaceId: 'owner' },
      focusSummary: 'Continue the coding task in the current workspace.',
      lastActionableRequest: 'Use Codex to create the smoke test file.',
      activeExecutionRefs: [{ kind: 'code_session', id: 'session-1', label: 'Test Tactical Game App' }],
      continuationState: {
        kind: 'retry_after_failure',
        payload: { source: 'sandbox_prerequisite' },
      },
    });

    expect(summarizeContinuityThreadForGateway(record)).toMatchObject({
      continuityKey: record.continuityKey,
      linkedSurfaceCount: 1,
      focusSummary: 'Continue the coding task in the current workspace.',
      lastActionableRequest: 'Use Codex to create the smoke test file.',
      continuationStateKind: 'retry_after_failure',
    });
    expect(toContinuityThreadClientMetadata(record)).toMatchObject({
      continuityKey: record.continuityKey,
      focusSummary: 'Continue the coding task in the current workspace.',
      continuationStateKind: 'retry_after_failure',
    });
    expect(formatContinuityThreadForPrompt(record)).toContain('<continuity-context>');
    expect(formatContinuityThreadForPrompt(record)).toContain('lastActionableRequest:');
  });

  it('filters placeholder execution labels and summaries from stored continuity state', () => {
    const store = createStore();
    const scope = createScope();
    const record = store.upsert(scope, {
      touchSurface: { channel: 'web', surfaceId: 'chat-main' },
      focusSummary: 'Intent gateway response was not structured.',
      safeSummary: 'No direct route for this coding harness turn.',
      activeExecutionRefs: [{ kind: 'execution', id: 'exec-1', label: 'No classification summary provided.' }],
    });

    expect(record?.focusSummary).toBeUndefined();
    expect(record?.safeSummary).toBeUndefined();
    expect(record?.activeExecutionRefs).toEqual([
      { kind: 'execution', id: 'exec-1' },
    ]);
    expect(toContinuityThreadClientMetadata(record)).not.toHaveProperty('focusSummary');
  });
});
