import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentMemoryStore } from './agent-memory-store.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(maxContextChars = 180) {
  const basePath = join(tmpdir(), `guardianagent-memory-context-${randomUUID()}`);
  createdDirs.push(basePath);
  return new AgentMemoryStore({
    enabled: true,
    basePath,
    readOnly: false,
    maxContextChars,
    maxFileChars: 5000,
  });
}

describe('AgentMemoryStore context packing', () => {
  it('derives a short summary for long entries when one is not provided', () => {
    const store = makeStore();
    const stored = store.append('agent1', {
      content: 'The parser refactor should stay split into scanner, token stream, and error recovery layers so the importer can share the same AST contract without inheriting the legacy fallback path. '.repeat(3),
      createdAt: '2026-03-20',
      category: 'Decisions',
    });

    expect(stored.summary).toBeTruthy();
    expect(stored.summary!.length).toBeLessThanOrEqual(200);
  });

  it('packs prompt context entry-by-entry instead of slicing through a long memory', () => {
    const store = makeStore(170);
    store.append('agent1', {
      content: 'User prefers concise status updates.',
      createdAt: '2026-03-19',
      category: 'Preferences',
    });
    store.append('agent1', {
      content: 'The importer overhaul includes a long implementation note with parser checkpoints, schema migration reminders, retry edge cases, release sequencing, and verification details that should not be cut off mid-sentence when prompt context is trimmed.'.repeat(2),
      summary: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
      createdAt: '2026-03-20',
      category: 'Project Notes',
    });

    const context = store.loadForContext('agent1');

    expect(context.length).toBeLessThanOrEqual(170);
    expect(context).toContain('Importer overhaul note covering checkpoints, migration, retries, and verification.');
    expect(context).not.toContain('should not be cut off mid-sentence');
    expect(context).not.toContain('[... knowledge base truncated');
  });

  it('keeps explicit memories ahead of newer context-flush artifacts in prompt context', () => {
    const store = makeStore(220);
    store.append('agent1', {
      content: 'User prefers concise status updates.',
      createdAt: '2026-03-20',
      category: 'Preferences',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: 'Detailed dropped transcript line about a browser automation approval flow that should stay out of prompt context unless explicitly recalled.'.repeat(2),
      summary: 'Browser automation approval flow context flush.',
      createdAt: '2026-03-21',
      category: 'Context Flushes',
      sourceType: 'system',
      tags: ['context_flush'],
    });
    store.append('agent1', {
      content: 'Detailed dropped transcript line about a workspace-switch blocker that should be summarized, not injected in full.'.repeat(2),
      summary: 'Workspace-switch blocker context flush.',
      createdAt: '2026-03-22',
      category: 'Context Flushes',
      sourceType: 'system',
      tags: ['context_flush'],
    });

    const context = store.loadForContext('agent1');

    expect(context).toContain('User prefers concise status updates.');
    expect(context).toContain('Workspace-switch blocker context flush.');
    expect(context).not.toContain('should be summarized, not injected in full');
  });

  it('selects relevant older memories when a context query is provided', () => {
    const store = makeStore(220);
    store.append('agent1', {
      content: 'Current weather note for a short-lived discussion.',
      createdAt: '2026-03-22',
      category: 'General',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: 'The importer overhaul must keep parser checkpoints, schema migration handling, retry safety, and verification coverage aligned.',
      summary: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
      createdAt: '2026-03-20',
      category: 'Project Notes',
      sourceType: 'user',
    });

    const context = store.loadForContext('agent1', {
      query: 'importer overhaul verification checkpoints',
    });

    expect(context).toContain('The importer overhaul must keep parser checkpoints, schema migration handling, retry safety, and verification coverage aligned.');
    expect(context).not.toContain('Current weather note');
  });

  it('reports which memory entries were selected for prompt context', () => {
    const store = makeStore(220);
    store.append('agent1', {
      content: 'Current weather note for a short-lived discussion.',
      createdAt: '2026-03-22',
      category: 'General',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: 'The importer overhaul must keep parser checkpoints, schema migration handling, retry safety, and verification coverage aligned.',
      summary: 'Importer overhaul note covering checkpoints, migration, retries, and verification.',
      createdAt: '2026-03-20',
      category: 'Project Notes',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: 'Detailed dropped transcript line about a workspace-switch blocker that should be summarized, not injected in full.'.repeat(2),
      summary: 'Workspace-switch blocker context flush.',
      createdAt: '2026-03-21',
      category: 'Context Flushes',
      sourceType: 'system',
      tags: ['context_flush'],
    });

    const result = store.loadForContextWithSelection('agent1', {
      query: 'importer overhaul verification checkpoints',
    });

    expect(result.content).toContain('The importer overhaul must keep parser checkpoints, schema migration handling, retry safety, and verification coverage aligned.');
    expect(result.queryPreview).toBe('importer overhaul verification checkpoints');
    expect(result.selectedEntries[0]).toMatchObject({
      category: 'Project Notes',
      renderMode: 'full',
      isContextFlush: false,
    });
    expect(result.selectedEntries[0]?.preview).toContain('Importer overhaul note covering checkpoints');
    expect(result.selectedEntries[0]?.matchReasons?.length).toBeGreaterThan(0);
    expect(result.omittedEntries).toBeGreaterThanOrEqual(1);
    expect(result.selectedEntries.some((entry) => entry.preview.includes('Current weather note'))).toBe(false);
  });

  it('supports a tighter per-load maxChars override for bounded prompt packing', () => {
    const store = makeStore(400);
    store.append('agent1', {
      content: 'User prefers concise status updates.',
      createdAt: '2026-03-20',
      category: 'Preferences',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: 'Importer overhaul note with parser checkpoints, migration reminders, retry handling, and verification follow-up.',
      summary: 'Importer overhaul note.',
      createdAt: '2026-03-21',
      category: 'Project Notes',
      sourceType: 'user',
    });

    const result = store.loadForContextWithSelection('agent1', {
      query: 'importer overhaul',
      maxChars: 90,
    });

    expect(result.content.length).toBeLessThanOrEqual(90);
    expect(result.content).toContain('Importer overhaul note.');
    expect(result.content).not.toContain('verification follow-up');
  });

  it('supports structured context queries with blocker and route signals', () => {
    const store = makeStore(260);
    store.append('agent1', {
      content: 'General note about a completed weather check.',
      createdAt: '2026-03-22',
      category: 'General',
      sourceType: 'user',
    });
    store.append('agent1', {
      content: '## Context Flush\ndate: 2026-03-21\nobjective:\nCreate the browser automation and save the artifact.\nactiveBlocker:\nkind: clarification | route: automation | operation: create | prompt: Which output path should I use?',
      summary: 'Browser automation clarification blocker.',
      createdAt: '2026-03-21',
      category: 'Context Flushes',
      sourceType: 'system',
      tags: ['context_flush', 'continuity', 'clarification', 'automation', 'create'],
    });

    const result = store.loadForContextWithSelection('agent1', {
      query: {
        text: 'Save the browser automation artifact',
        focusTexts: ['Which output path should I use?'],
        tags: ['clarification', 'automation', 'create'],
        categoryHints: ['Context Flushes'],
      },
    });

    expect(result.content).toContain('Which output path should I use?');
    expect(result.selectedEntries[0]).toMatchObject({
      category: 'Context Flushes',
      isContextFlush: true,
    });
    expect(result.selectedEntries[0]?.matchReasons).toEqual(expect.arrayContaining([
      'focus content',
      'tag clarification',
    ]));
    expect(result.queryPreview).toContain('save the browser automation artifact');
  });

  it('prefers operator-curated pages over equally matching derived artifacts', () => {
    const store = makeStore(260);
    store.append('agent1', {
      content: 'Release notes preference: keep release notes terse and decision-focused.',
      summary: 'Release notes preference.',
      createdAt: '2026-04-03',
      category: 'Operator Wiki',
      sourceType: 'operator',
      artifact: {
        title: 'Release notes style',
        sourceClass: 'operator_curated',
        kind: 'wiki_page',
      },
    });
    store.append('agent1', {
      content: 'Release notes preference derived from earlier context flush.',
      summary: 'Release notes preference.',
      createdAt: '2026-04-04',
      category: 'Context Flushes',
      sourceType: 'system',
      tags: ['context_flush'],
    });

    const result = store.loadForContextWithSelection('agent1', {
      query: 'release notes preference',
    });

    expect(result.selectedEntries[0]).toMatchObject({
      sourceClass: 'operator_curated',
      isContextFlush: false,
    });
    expect(result.selectedEntries[0]?.preview).toContain('Release notes style');
  });

  it('caps the winning set before prompt packing when many active entries exist', () => {
    const store = makeStore(2000);
    for (let index = 0; index < 40; index += 1) {
      store.append('agent1', {
        content: `Importer verification note ${index} covering checkpoints and follow-up details.`,
        summary: `Importer verification note ${index}.`,
        createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        category: index % 2 === 0 ? 'Project Notes' : 'Context Flushes',
        sourceType: index % 2 === 0 ? 'user' : 'system',
        ...(index % 2 === 1 ? { tags: ['context_flush', 'verification'] } : {}),
      });
    }

    const result = store.loadForContextWithSelection('agent1', {
      query: 'importer verification checkpoints',
      maxChars: 800,
    });

    expect(result.candidateEntries).toBe(40);
    expect(result.selectedEntries.length).toBeLessThanOrEqual(24);
    expect(result.omittedEntries).toBeGreaterThan(0);
  });
});
