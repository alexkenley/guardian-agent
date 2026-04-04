import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentMemoryStore } from './agent-memory-store.js';
import { MemoryMutationService } from './memory-mutation-service.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const basePath = join(tmpdir(), `guardianagent-memory-mutation-${randomUUID()}`);
  createdDirs.push(basePath);
  return new AgentMemoryStore({
    enabled: true,
    basePath,
    readOnly: false,
    maxContextChars: 500,
    maxFileChars: 5000,
    maxEntryChars: 4000,
  });
}

describe('MemoryMutationService', () => {
  it('suppresses exact duplicate assistant-save writes', () => {
    const store = makeStore();
    const service = new MemoryMutationService({
      now: () => Date.parse('2026-04-10T00:00:00.000Z'),
    });

    const first = service.persist({
      target: {
        scope: 'global',
        scopeId: 'agent-1',
        store,
        auditAgentId: 'agent-1',
      },
      intent: 'assistant_save',
      actor: 'tester',
      entry: {
        content: 'User prefers dark mode.',
        summary: 'Dark mode preference.',
        createdAt: '2026-04-10',
        category: 'Preferences',
        sourceType: 'user',
        trustLevel: 'trusted',
        status: 'active',
      },
    });

    const second = service.persist({
      target: {
        scope: 'global',
        scopeId: 'agent-1',
        store,
        auditAgentId: 'agent-1',
      },
      intent: 'assistant_save',
      actor: 'tester',
      entry: {
        content: 'User prefers dark mode.',
        summary: 'Dark mode preference.',
        createdAt: '2026-04-10',
        category: 'Preferences',
        sourceType: 'user',
        trustLevel: 'trusted',
        status: 'active',
      },
    });

    expect(first.action).toBe('created');
    expect(second.action).toBe('noop');
    expect(second.reason).toBe('exact_duplicate');
    expect(store.getEntries('agent-1')).toHaveLength(1);
  });

  it('upserts curated wiki pages by slug instead of appending duplicates', () => {
    const store = makeStore();
    const service = new MemoryMutationService({
      now: () => Date.parse('2026-04-10T00:00:00.000Z'),
    });

    const created = service.persist({
      target: {
        scope: 'global',
        scopeId: 'agent-1',
        store,
        auditAgentId: 'agent-1',
      },
      intent: 'operator_curate',
      actor: 'operator',
      entry: {
        content: 'Initial release guidance.',
        summary: 'Release notes guidance.',
        createdAt: '2026-04-10',
        category: 'Operator Wiki',
        sourceType: 'operator',
        trustLevel: 'trusted',
        status: 'active',
        artifact: {
          sourceClass: 'operator_curated',
          kind: 'wiki_page',
          title: 'Release Notes Style',
          slug: 'release-notes-style',
        },
      },
    });

    const updated = service.persist({
      target: {
        scope: 'global',
        scopeId: 'agent-1',
        store,
        auditAgentId: 'agent-1',
      },
      intent: 'operator_curate',
      actor: 'operator',
      entry: {
        content: 'Keep release notes terse and decision-focused.',
        summary: 'Updated release notes guidance.',
        createdAt: '2026-04-11',
        category: 'Operator Wiki',
        sourceType: 'operator',
        trustLevel: 'trusted',
        status: 'active',
        artifact: {
          sourceClass: 'operator_curated',
          kind: 'wiki_page',
          title: 'Release Notes Style',
          slug: 'release-notes-style',
        },
      },
    });

    expect(created.action).toBe('created');
    expect(updated.action).toBe('updated');
    expect(updated.reason).toBe('canonical_match');
    expect(updated.entry.id).toBe(created.entry.id);
    expect(store.getEntries('agent-1')).toHaveLength(1);
    expect(store.getEntries('agent-1')[0]?.content).toContain('decision-focused');
  });

  it('archives stale and duplicate system-managed memory during hygiene', () => {
    const store = makeStore();
    const service = new MemoryMutationService({
      now: () => Date.parse('2026-04-10T00:00:00.000Z'),
    });

    store.append('agent-1', {
      content: '## Context Flush\nobjective:\nOld flush entry',
      summary: 'Old flush entry.',
      createdAt: '2026-01-01',
      category: 'Context Flushes',
      sourceType: 'system',
      trustLevel: 'trusted',
      status: 'active',
      tags: ['context_flush'],
      artifact: {
        sourceClass: 'derived',
        kind: 'memory_entry',
        memoryClass: 'collection',
        staleAfterDays: 30,
        nextReviewAt: '2026-02-01T00:00:00.000Z',
      },
    });
    const duplicateA = store.append('agent-1', {
      content: '## Context Flush\nobjective:\nDuplicate flush entry',
      summary: 'Duplicate flush entry.',
      createdAt: '2026-04-08',
      category: 'Context Flushes',
      sourceType: 'system',
      trustLevel: 'trusted',
      status: 'active',
      tags: ['context_flush'],
      artifact: {
        sourceClass: 'derived',
        kind: 'memory_entry',
        memoryClass: 'collection',
        staleAfterDays: 30,
      },
    });
    const duplicateB = store.append('agent-1', {
      content: '## Context Flush\nobjective:\nDuplicate flush entry',
      summary: 'Duplicate flush entry.',
      createdAt: '2026-04-09',
      category: 'Context Flushes',
      sourceType: 'system',
      trustLevel: 'trusted',
      status: 'active',
      tags: ['context_flush'],
      artifact: {
        sourceClass: 'derived',
        kind: 'memory_entry',
        memoryClass: 'collection',
        staleAfterDays: 30,
      },
    });

    const result = service.persist({
      target: {
        scope: 'global',
        scopeId: 'agent-1',
        store,
        auditAgentId: 'agent-1',
      },
      intent: 'context_flush',
      actor: 'memory-flush',
      entry: {
        content: '## Context Flush\nobjective:\nFresh flush entry',
        summary: 'Fresh flush entry.',
        createdAt: '2026-04-10',
        category: 'Context Flushes',
        sourceType: 'system',
        trustLevel: 'trusted',
        status: 'active',
        tags: ['context_flush'],
      },
    });

    expect(result.action).toBe('created');
    expect(result.maintenance).toMatchObject({
      archivedExactDuplicates: 1,
      archivedStaleSystemEntries: 1,
      changed: true,
    });
    expect(store.findEntry('agent-1', duplicateA.id)?.status).toBe('archived');
    expect(store.findEntry('agent-1', duplicateB.id)?.status).toBe('active');
    expect(store.searchEntries('agent-1', 'Old flush entry', { includeInactive: true })[0]?.status).toBe('archived');
  });
});
