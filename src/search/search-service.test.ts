import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SearchService } from './search-service.js';
import { hasSQLiteDriver } from '../runtime/sqlite-driver.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { SearchConfig } from './types.js';

const describeSQLite = hasSQLiteDriver() ? describe : describe.skip;

function makeConfig(tmpDir: string, overrides?: Partial<SearchConfig>): SearchConfig {
  return {
    enabled: true,
    sqlitePath: join(tmpDir, 'search.sqlite'),
    defaultMode: 'keyword',
    maxResults: 20,
    sources: [],
    ...overrides,
  };
}

describeSQLite('SearchService', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `search-service-test-${Date.now()}`);
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Lifecycle ──────────────────────────────────────────

  it('initializes when enabled and SQLite available', () => {
    const svc = new SearchService(makeConfig(tmpDir));
    expect(svc.isAvailable()).toBe(true);
    svc.close();
  });

  it('reports unavailable when disabled', () => {
    const svc = new SearchService(makeConfig(tmpDir, { enabled: false }));
    expect(svc.isAvailable()).toBe(false);
  });

  it('returns empty search results when unavailable', async () => {
    const svc = new SearchService(makeConfig(tmpDir, { enabled: false }));
    const result = await svc.search({ query: 'test' });
    expect(result.results).toHaveLength(0);
    expect(result.totalResults).toBe(0);
  });

  // ─── Source CRUD ────────────────────────────────────────

  it('adds sources from config on init', () => {
    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [
        { id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true },
      ],
    }));
    expect(svc.getSources()).toHaveLength(1);
    expect(svc.getSources()[0].id).toBe('docs');
    svc.close();
  });

  it('updates existing persisted source configuration on init', () => {
    const dbPath = join(tmpDir, 'search.sqlite');
    const svc = new SearchService(makeConfig(tmpDir, {
      sqlitePath: dbPath,
      sources: [
        { id: 'docs', name: 'Docs', type: 'directory', path: contentDir, globs: ['**/*.md'], enabled: true },
      ],
    }));
    svc.close();

    const nextDir = join(tmpDir, 'next-content');
    mkdirSync(nextDir, { recursive: true });
    const reloaded = new SearchService(makeConfig(tmpDir, {
      sqlitePath: dbPath,
      sources: [
        { id: 'docs', name: 'Docs Updated', type: 'directory', path: nextDir, globs: ['**/*.txt'], enabled: false },
      ],
    }));

    expect(reloaded.getSources()[0]).toMatchObject({
      id: 'docs',
      name: 'Docs Updated',
      path: nextDir,
      globs: ['**/*.txt'],
      enabled: false,
    });
    reloaded.close();
  });

  it('removes persisted sources that are no longer in config on init', () => {
    const dbPath = join(tmpDir, 'search.sqlite');
    const svc = new SearchService(makeConfig(tmpDir, {
      sqlitePath: dbPath,
      sources: [
        { id: 'keep', name: 'Keep', type: 'directory', path: contentDir, enabled: true },
        { id: 'drop', name: 'Drop', type: 'directory', path: contentDir, enabled: true },
      ],
    }));
    svc.close();

    const reloaded = new SearchService(makeConfig(tmpDir, {
      sqlitePath: dbPath,
      sources: [
        { id: 'keep', name: 'Keep', type: 'directory', path: contentDir, enabled: true },
      ],
    }));

    expect(reloaded.getSources().map((source) => source.id)).toEqual(['keep']);
    reloaded.close();
  });

  it('adds and removes sources at runtime', () => {
    const svc = new SearchService(makeConfig(tmpDir));
    svc.addSource({ id: 'rt', name: 'Runtime', type: 'file', path: '/f.txt', enabled: true });
    expect(svc.getSources()).toHaveLength(1);

    svc.removeSource('rt');
    expect(svc.getSources()).toHaveLength(0);
    svc.close();
  });

  it('toggles source enabled state', () => {
    const svc = new SearchService(makeConfig(tmpDir));
    svc.addSource({ id: 'tg', name: 'Toggle', type: 'file', path: '/f', enabled: true });
    expect(svc.toggleSource('tg', false)).toBe(true);
    expect(svc.getSources()[0].enabled).toBe(false);
    svc.close();
  });

  // ─── Indexing ───────────────────────────────────────────

  it('indexes a directory source', async () => {
    writeFileSync(join(contentDir, 'readme.md'), '# Guide\n\nWelcome to the guide.');
    writeFileSync(join(contentDir, 'notes.txt'), 'Important notes about deployment.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true }],
    }));

    const result = await svc.indexSource('docs');
    expect(result.indexed).toBe(2);
    expect(result.errors).toHaveLength(0);
    svc.close();
  });

  it('matches globstar globs against root-level files', async () => {
    const nestedDir = join(contentDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(contentDir, 'readme.md'), '# Root Guide\n\nRoot markdown content.');
    writeFileSync(join(nestedDir, 'guide.md'), '# Nested Guide\n\nNested markdown content.');
    writeFileSync(join(contentDir, 'notes.txt'), 'Plain text content.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, globs: ['**/*.md'], enabled: true }],
    }));

    const result = await svc.indexSource('docs');
    expect(result.indexed).toBe(2);
    expect(result.errors).toHaveLength(0);
    svc.close();
  });

  it('skips unchanged files on re-index', async () => {
    writeFileSync(join(contentDir, 'stable.txt'), 'Stable content.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true }],
    }));

    const first = await svc.indexSource('docs');
    expect(first.indexed).toBe(1);

    const second = await svc.indexSource('docs');
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
    svc.close();
  });

  it('indexes a single file source', async () => {
    const filePath = join(contentDir, 'single.md');
    writeFileSync(filePath, '# Single File\n\nThis is the content of a single file.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'single', name: 'Single', type: 'file', path: filePath, enabled: true }],
    }));

    const result = await svc.indexSource('single');
    expect(result.indexed).toBe(1);
    svc.close();
  });

  it('throws for disabled source indexing', async () => {
    const svc = new SearchService(makeConfig(tmpDir));
    svc.addSource({ id: 'off', name: 'Off', type: 'file', path: '/f', enabled: false });
    await expect(svc.indexSource('off')).rejects.toThrow('disabled');
    svc.close();
  });

  it('throws for nonexistent source', async () => {
    const svc = new SearchService(makeConfig(tmpDir));
    await expect(svc.indexSource('nope')).rejects.toThrow('not found');
    svc.close();
  });

  // ─── Search ─────────────────────────────────────────────

  it('performs keyword search over indexed content', async () => {
    writeFileSync(join(contentDir, 'search1.txt'), 'The quick brown fox jumps over the lazy dog.');
    writeFileSync(join(contentDir, 'search2.txt'), 'A slow red car stops at the light.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true }],
    }));

    await svc.indexSource('docs');

    const result = await svc.search({ query: 'quick fox', mode: 'keyword' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].snippet).toContain('fox');
    expect(result.mode).toBe('keyword');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    svc.close();
  });

  it('respects search limit', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(contentDir, `doc${i}.txt`), `Document about testing topic number ${i}.`);
    }

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true }],
    }));
    await svc.indexSource('docs');

    const result = await svc.search({ query: 'testing', mode: 'keyword', limit: 3 });
    expect(result.results.length).toBeLessThanOrEqual(3);
    svc.close();
  });

  it('filters search by collection', async () => {
    const dir2 = join(tmpDir, 'content2');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(contentDir, 'a.txt'), 'Alpha bravo charlie.');
    writeFileSync(join(dir2, 'b.txt'), 'Alpha delta echo.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [
        { id: 'src-a', name: 'A', type: 'directory', path: contentDir, enabled: true },
        { id: 'src-b', name: 'B', type: 'directory', path: dir2, enabled: true },
      ],
    }));

    await svc.indexSource('src-a');
    await svc.indexSource('src-b');

    const all = await svc.search({ query: 'alpha', mode: 'keyword' });
    // Each document produces parent + child chunks, so results include both
    expect(all.results.length).toBeGreaterThanOrEqual(2);

    const filtered = await svc.search({ query: 'alpha', mode: 'keyword', collection: 'src-a' });
    expect(filtered.results.length).toBeGreaterThanOrEqual(1);
    expect(filtered.results.some(r => r.snippet.includes('bravo'))).toBe(true);
    svc.close();
  });

  it('lists indexed documents by extension', async () => {
    writeFileSync(join(contentDir, 'report.json'), '{"name":"report"}');
    writeFileSync(join(contentDir, 'notes.txt'), 'notes');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'docs', name: 'Docs', type: 'directory', path: contentDir, enabled: true }],
    }));

    await svc.indexSource('docs');
    const listed = svc.listDocuments({ collection: 'docs', extension: 'json' });
    expect(listed.documents.map((doc) => doc.filepath)).toEqual([join(contentDir, 'report.json')]);
    expect(listed.totalResults).toBe(1);
    svc.close();
  });

  // ─── Status ─────────────────────────────────────────────

  it('returns status with collection info', async () => {
    writeFileSync(join(contentDir, 'status.txt'), 'Status test content.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'st', name: 'Status', type: 'directory', path: contentDir, enabled: true }],
    }));
    await svc.indexSource('st');

    const status = svc.status();
    expect(status.available).toBe(true);
    expect(status.collections.length).toBe(1);
    expect(status.collections[0].documentCount).toBe(1);
    expect(status.configuredSources.length).toBe(1);
    svc.close();
  });

  it('returns unavailable status when disabled', () => {
    const svc = new SearchService(makeConfig(tmpDir, { enabled: false }));
    const status = svc.status();
    expect(status.available).toBe(false);
  });

  // ─── Reindex ────────────────────────────────────────────

  it('reindex returns success message', async () => {
    writeFileSync(join(contentDir, 'ri.txt'), 'Reindex test.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'ri', name: 'RI', type: 'directory', path: contentDir, enabled: true }],
    }));

    const result = await svc.reindex('ri');
    expect(result.success).toBe(true);
    expect(result.message).toContain('ri');
    svc.close();
  });

  it('reindex all sources', async () => {
    writeFileSync(join(contentDir, 'all.txt'), 'Index all test.');

    const svc = new SearchService(makeConfig(tmpDir, {
      sources: [{ id: 'all', name: 'All', type: 'directory', path: contentDir, enabled: true }],
    }));

    const result = await svc.reindex();
    expect(result.success).toBe(true);
    svc.close();
  });
});
