import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CapabilityCandidateStore } from './capability-candidate-store.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(nowRef: { current: number }): CapabilityCandidateStore {
  const basePath = join(tmpdir(), `guardianagent-capability-candidates-${randomUUID()}`);
  createdDirs.push(basePath);
  return new CapabilityCandidateStore({
    basePath,
    now: () => nowRef.current,
  });
}

describe('CapabilityCandidateStore', () => {
  it('stores quarantined candidates and deduplicates active proposals', () => {
    const nowRef = { current: Date.parse('2026-04-10T12:00:00.000Z') };
    const store = makeStore(nowRef);

    const first = store.upsert({
      kind: 'workflow',
      title: 'Curate repeated repo setup',
      summary: 'Repeated context suggests a reusable workflow.',
      purpose: 'Keep repeated operational knowledge out of loose memory.',
      source: 'learning_review',
      dedupeKey: 'learning_review:workflow:repo-setup',
      tags: ['memory', 'workflow'],
      evidence: [
        {
          type: 'memory_entry',
          title: 'Context flush: repo setup',
          entryId: 'mem-1',
        },
      ],
    });
    nowRef.current += 1000;
    const second = store.upsert({
      kind: 'workflow',
      title: 'Curate repeated repo setup',
      summary: 'Repeated context suggests a reusable workflow.',
      purpose: 'Keep repeated operational knowledge out of loose memory.',
      source: 'learning_review',
      dedupeKey: 'learning_review:workflow:repo-setup',
      tags: ['curation'],
      evidence: [
        {
          type: 'memory_entry',
          title: 'Context flush: repo setup',
          entryId: 'mem-2',
        },
      ],
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(store.summary()).toMatchObject({
      total: 1,
      active: 1,
      quarantined: 1,
    });
    expect(store.list({ status: 'active' })[0]?.evidence.map((entry) => entry.entryId)).toEqual(['mem-1', 'mem-2']);
  });

  it('applies review decisions and expires stale active candidates', () => {
    const nowRef = { current: Date.parse('2026-04-10T12:00:00.000Z') };
    const store = makeStore(nowRef);
    const created = store.upsert({
      kind: 'memory_update',
      title: 'Review quarantined memory',
      summary: 'Quarantined memory needs operator review.',
      purpose: 'Keep memory useful and safe.',
      source: 'learning_review',
      dedupeKey: 'learning_review:memory:quarantine',
      expiresAt: store.buildExpiry(1),
    });

    const approved = store.applyAction({
      candidateId: created.candidate.id,
      action: 'approve',
      actor: 'tester',
      reason: 'Looks useful.',
    });
    nowRef.current += 3 * 24 * 60 * 60 * 1000;
    const expiry = store.expireStale(1);

    expect(approved.candidate.status).toBe('approved');
    expect(expiry.expiredCandidates).toBe(1);
    expect(store.list({ status: 'expired' })[0]?.id).toBe(created.candidate.id);
  });
});
