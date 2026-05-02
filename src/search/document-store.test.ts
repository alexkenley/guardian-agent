import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DocumentStore } from './document-store.js';
import { hasSQLiteDriver, openSQLiteDatabase } from '../runtime/sqlite-driver.js';
import type { SQLiteDatabase } from '../runtime/sqlite-driver.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

// Skip if SQLite not available
const describeSQLite = hasSQLiteDriver() ? describe : describe.skip;

describeSQLite('DocumentStore', () => {
  let db: SQLiteDatabase;
  let store: DocumentStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `search-store-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = openSQLiteDatabase(join(tmpDir, 'test.sqlite'), { enableForeignKeyConstraints: true })!;
    store = new DocumentStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Source CRUD ────────────────────────────────────────

  it('adds and retrieves sources', () => {
    store.addSource({ id: 'docs', name: 'Docs', type: 'directory', path: '/docs', enabled: true });
    const sources = store.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe('docs');
    expect(sources[0].name).toBe('Docs');
    expect(sources[0].type).toBe('directory');
    expect(sources[0].enabled).toBe(true);
  });

  it('rejects duplicate source id', () => {
    store.addSource({ id: 'docs', name: 'Docs', type: 'directory', path: '/docs', enabled: true });
    expect(() => store.addSource({ id: 'docs', name: 'Docs 2', type: 'file', path: '/x', enabled: true }))
      .toThrow("Source 'docs' already exists");
  });

  it('gets a single source by id', () => {
    store.addSource({ id: 'src', name: 'Source', type: 'file', path: '/f.txt', enabled: true });
    expect(store.getSource('src')?.name).toBe('Source');
    expect(store.getSource('nonexistent')).toBeNull();
  });

  it('updates source configuration by id', () => {
    store.addSource({ id: 'src', name: 'Source', type: 'directory', path: '/old', globs: ['**/*.md'], enabled: true });

    expect(store.updateSource({
      id: 'src',
      name: 'Source Updated',
      type: 'directory',
      path: '/new',
      globs: ['**/*.txt'],
      enabled: false,
      description: 'Updated source',
    })).toBe(true);

    expect(store.getSource('src')).toEqual({
      id: 'src',
      name: 'Source Updated',
      type: 'directory',
      path: '/new',
      globs: ['**/*.txt'],
      branch: undefined,
      enabled: false,
      description: 'Updated source',
    });
    expect(store.updateSource({ id: 'missing', name: 'Missing', type: 'file', path: '/missing', enabled: true })).toBe(false);
  });

  it('removes sources and their documents', () => {
    store.addSource({ id: 'rm-test', name: 'RM', type: 'directory', path: '/rm', enabled: true });
    const doc = store.upsertDocument('rm-test', '/rm/file.txt', 'Title', 'hash1', 'text/plain', 100);
    store.insertChunk(doc.id, null, 'chunk content', 0, 13, 2, 'parent');

    expect(store.removeSource('rm-test')).toBe(true);
    expect(store.getSource('rm-test')).toBeNull();
  });

  it('returns false when removing a missing source', () => {
    expect(store.removeSource('missing')).toBe(false);
  });

  it('toggles source enabled state', () => {
    store.addSource({ id: 'tog', name: 'Toggle', type: 'file', path: '/f', enabled: true });
    expect(store.toggleSource('tog', false)).toBe(true);
    expect(store.getSource('tog')?.enabled).toBe(false);
    expect(store.toggleSource('tog', true)).toBe(true);
    expect(store.getSource('tog')?.enabled).toBe(true);
    expect(store.toggleSource('nonexistent', true)).toBe(false);
  });

  it('stores globs and branch', () => {
    store.addSource({ id: 'git1', name: 'Git', type: 'git', path: 'https://github.com/test/repo', enabled: true, globs: ['*.md', '*.txt'], branch: 'main' });
    const source = store.getSource('git1')!;
    expect(source.globs).toEqual(['*.md', '*.txt']);
    expect(source.branch).toBe('main');
  });

  // ─── Document CRUD ──────────────────────────────────────

  it('upserts and retrieves documents', () => {
    store.addSource({ id: 's1', name: 'S1', type: 'directory', path: '/s1', enabled: true });
    const doc = store.upsertDocument('s1', '/s1/file.md', 'Title', 'hash123', 'text/markdown', 500);
    expect(doc.id).toBeDefined();
    expect(doc.filepath).toBe('/s1/file.md');
    expect(doc.title).toBe('Title');

    const fetched = store.getDocument(doc.id);
    expect(fetched?.contentHash).toBe('hash123');
  });

  it('skips upsert when content hash unchanged', () => {
    store.addSource({ id: 's2', name: 'S2', type: 'directory', path: '/s2', enabled: true });
    const doc1 = store.upsertDocument('s2', '/s2/file.md', 'Title', 'samehash', 'text/markdown', 500);
    const doc2 = store.upsertDocument('s2', '/s2/file.md', 'Title 2', 'samehash', 'text/markdown', 500);
    expect(doc2.id).toBe(doc1.id);
    expect(doc2.title).toBe('Title'); // Not updated since hash matches
  });

  it('updates document when content hash changes', () => {
    store.addSource({ id: 's3', name: 'S3', type: 'directory', path: '/s3', enabled: true });
    const doc1 = store.upsertDocument('s3', '/s3/file.md', 'Title', 'hash1', 'text/markdown', 500);
    store.insertChunk(doc1.id, null, 'old content', 0, 11, 2, 'parent');

    const doc2 = store.upsertDocument('s3', '/s3/file.md', 'New Title', 'hash2', 'text/markdown', 600);
    expect(doc2.id).toBe(doc1.id);
    expect(doc2.title).toBe('New Title');

    // Old chunks should be deleted
    expect(store.getChunksForDocument(doc1.id)).toHaveLength(0);
  });

  it('removes stale documents', () => {
    store.addSource({ id: 's4', name: 'S4', type: 'directory', path: '/s4', enabled: true });
    store.upsertDocument('s4', '/s4/keep.md', null, 'h1', null, 100);
    store.upsertDocument('s4', '/s4/remove.md', null, 'h2', null, 100);

    const removed = store.removeStaleDocuments('s4', new Set(['/s4/keep.md']));
    expect(removed).toEqual(['/s4/remove.md']);
    expect(store.getDocumentsBySource('s4')).toHaveLength(1);
  });

  it('lists indexed documents by source and extension', () => {
    store.addSource({ id: 'list-a', name: 'List A', type: 'directory', path: '/list-a', enabled: true });
    store.addSource({ id: 'list-b', name: 'List B', type: 'directory', path: '/list-b', enabled: true });
    store.upsertDocument('list-a', '/list-a/a.json', 'A', 'h1', 'application/json', 10);
    store.upsertDocument('list-a', '/list-a/b.txt', 'B', 'h2', 'text/plain', 20);
    store.upsertDocument('list-b', '/list-b/c.json', 'C', 'h3', 'application/json', 30);

    const docs = store.listDocuments({ collection: 'list-a', extension: 'json' });
    expect(docs.map((doc) => doc.filepath)).toEqual(['/list-a/a.json']);
    expect(store.listDocuments({ extension: '.json' }).map((doc) => doc.filepath)).toEqual([
      '/list-a/a.json',
      '/list-b/c.json',
    ]);
  });

  // ─── Chunk CRUD ─────────────────────────────────────────

  it('inserts and retrieves chunks', () => {
    store.addSource({ id: 'cs', name: 'CS', type: 'file', path: '/f', enabled: true });
    const doc = store.upsertDocument('cs', '/f', null, 'h', null, 100);

    const parentId = store.insertChunk(doc.id, null, 'parent content', 0, 14, 2, 'parent');
    const childId = store.insertChunk(doc.id, parentId, 'child content', 0, 13, 2, 'child');

    const parent = store.getChunk(parentId)!;
    expect(parent.chunkType).toBe('parent');
    expect(parent.parentChunkId).toBeNull();

    const child = store.getChunk(childId)!;
    expect(child.chunkType).toBe('child');
    expect(child.parentChunkId).toBe(parentId);
  });

  it('retrieves chunks for a document', () => {
    store.addSource({ id: 'cd', name: 'CD', type: 'file', path: '/f', enabled: true });
    const doc = store.upsertDocument('cd', '/f', null, 'h', null, 100);

    store.insertChunk(doc.id, null, 'chunk 1', 0, 7, 1, 'parent');
    store.insertChunk(doc.id, null, 'chunk 2', 8, 15, 1, 'parent');

    expect(store.getChunksForDocument(doc.id)).toHaveLength(2);
  });

  // ─── Embedding Storage ──────────────────────────────────

  it('stores and retrieves embeddings', () => {
    store.addSource({ id: 'em', name: 'EM', type: 'file', path: '/f', enabled: true });
    const doc = store.upsertDocument('em', '/f', null, 'h', null, 100);
    const chunkId = store.insertChunk(doc.id, null, 'test', 0, 4, 1, 'child');

    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    store.setEmbedding(chunkId, embedding);

    const retrieved = store.getEmbedding(chunkId)!;
    expect(retrieved).toHaveLength(4);
    expect(Math.abs(retrieved[0] - 0.1)).toBeLessThan(0.001);
    expect(Math.abs(retrieved[3] - 0.4)).toBeLessThan(0.001);
  });

  it('returns null for missing embedding', () => {
    expect(store.getEmbedding('nonexistent')).toBeNull();
  });

  it('counts embedded chunks', () => {
    store.addSource({ id: 'ec', name: 'EC', type: 'file', path: '/f', enabled: true });
    const doc = store.upsertDocument('ec', '/f', null, 'h', null, 100);
    const c1 = store.insertChunk(doc.id, null, 'a', 0, 1, 1, 'child');
    const c2 = store.insertChunk(doc.id, null, 'b', 1, 2, 1, 'child');
    store.insertChunk(doc.id, null, 'c', 2, 3, 1, 'child'); // no embedding

    store.setEmbedding(c1, new Float32Array([1, 2]));
    store.setEmbedding(c2, new Float32Array([3, 4]));

    expect(store.getEmbeddedChunkCount()).toBe(2);
    expect(store.getEmbeddedChunkCount('ec')).toBe(2);
  });

  // ─── Collection Info ────────────────────────────────────

  it('returns collection info', () => {
    store.addSource({ id: 'ci', name: 'Collection Info', type: 'directory', path: '/ci', enabled: true });
    const doc = store.upsertDocument('ci', '/ci/f.txt', 'Title', 'h', 'text/plain', 100);
    store.insertChunk(doc.id, null, 'chunk', 0, 5, 1, 'parent');

    const info = store.getCollectionInfo('ci')!;
    expect(info.id).toBe('ci');
    expect(info.name).toBe('Collection Info');
    expect(info.documentCount).toBe(1);
    expect(info.chunkCount).toBe(1);
    expect(info.embeddedChunkCount).toBe(0);
  });

  // ─── Content Hash ───────────────────────────────────────

  it('produces consistent content hashes', () => {
    const h1 = DocumentStore.contentHash('hello world');
    const h2 = DocumentStore.contentHash('hello world');
    const h3 = DocumentStore.contentHash('different');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});
