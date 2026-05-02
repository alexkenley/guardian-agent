/**
 * Document store — SQLite schema, document/chunk CRUD, source persistence.
 *
 * Uses node:sqlite (DatabaseSync) for schema creation and data management.
 * FTS5 index is created via triggers (same pattern as conversation.ts).
 * Embeddings stored as BLOBs in a regular table (no native extensions needed).
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { SQLiteDatabase } from '../runtime/sqlite-driver.js';
import type {
  SearchSourceConfig,
  DocumentRecord,
  ChunkRecord,
  CollectionInfo,
  SearchDocumentListEntry,
  SearchDocumentListOptions,
} from './types.js';

export class DocumentStore {
  constructor(private readonly db: SQLiteDatabase) {
    this.initSchema();
  }

  // ─── Schema ─────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        globs TEXT,
        branch TEXT,
        enabled INTEGER DEFAULT 1,
        description TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES search_sources(id),
        filepath TEXT NOT NULL,
        title TEXT,
        content_hash TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_documents_source
        ON documents(source_id);
      CREATE INDEX IF NOT EXISTS idx_documents_hash
        ON documents(source_id, filepath, content_hash);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        parent_chunk_id TEXT,
        content TEXT NOT NULL,
        start_offset INTEGER,
        end_offset INTEGER,
        token_count INTEGER,
        chunk_type TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_document
        ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_parent
        ON chunks(parent_chunk_id);

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL
      );
    `);

    // FTS5 virtual table (content-sync mode, same pattern as conversation.ts)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_fts_insert
      AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_fts_delete
      AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    `);

    // Check and rebuild FTS if needed (same pattern as conversation.ts)
    const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get() as { count: number } | undefined;
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number } | undefined;
    if ((ftsCount?.count ?? 0) === 0 && (chunkCount?.count ?? 0) > 0) {
      this.db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')`);
    }
  }

  // ─── Source CRUD ────────────────────────────────────────

  getSources(): SearchSourceConfig[] {
    const rows = this.db.prepare('SELECT * FROM search_sources ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      type: r.type as SearchSourceConfig['type'],
      path: r.path as string,
      globs: r.globs ? JSON.parse(r.globs as string) : undefined,
      branch: typeof r.branch === 'string' ? r.branch : undefined,
      enabled: (r.enabled as number) === 1,
      description: typeof r.description === 'string' ? r.description : undefined,
    }));
  }

  getSource(id: string): SearchSourceConfig | null {
    const row = this.db.prepare('SELECT * FROM search_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as SearchSourceConfig['type'],
      path: row.path as string,
      globs: row.globs ? JSON.parse(row.globs as string) : undefined,
      branch: typeof row.branch === 'string' ? row.branch : undefined,
      enabled: (row.enabled as number) === 1,
      description: typeof row.description === 'string' ? row.description : undefined,
    };
  }

  addSource(source: SearchSourceConfig): void {
    const existing = this.db.prepare('SELECT id FROM search_sources WHERE id = ?').get(source.id);
    if (existing) throw new Error(`Source '${source.id}' already exists`);

    const now = Date.now();
    this.db.prepare(`
      INSERT INTO search_sources (id, name, type, path, globs, branch, enabled, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id, source.name, source.type, source.path,
      source.globs ? JSON.stringify(source.globs) : null,
      source.branch ?? null,
      source.enabled ? 1 : 0,
      source.description ?? null,
      now, now,
    );
  }

  updateSource(source: SearchSourceConfig): boolean {
    const existing = this.db.prepare('SELECT id FROM search_sources WHERE id = ?').get(source.id);
    if (!existing) return false;

    this.db.prepare(`
      UPDATE search_sources
      SET name = ?, type = ?, path = ?, globs = ?, branch = ?, enabled = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(
      source.name,
      source.type,
      source.path,
      source.globs ? JSON.stringify(source.globs) : null,
      source.branch ?? null,
      source.enabled ? 1 : 0,
      source.description ?? null,
      Date.now(),
      source.id,
    );
    return true;
  }

  removeSource(id: string): boolean {
    const existing = this.db.prepare('SELECT id FROM search_sources WHERE id = ?').get(id);
    if (!existing) return false;

    // Delete all documents and their chunks for this source first
    const docs = this.db.prepare('SELECT id FROM documents WHERE source_id = ?').all(id) as Array<{ id: string }>;
    for (const doc of docs) {
      this.deleteDocument(doc.id);
    }
    this.db.prepare('DELETE FROM search_sources WHERE id = ?').run(id);
    return true;
  }

  toggleSource(id: string, enabled: boolean): boolean {
    const existing = this.db.prepare('SELECT id FROM search_sources WHERE id = ?').get(id);
    if (!existing) return false;
    this.db.prepare('UPDATE search_sources SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return true;
  }

  // ─── Document CRUD ──────────────────────────────────────

  getDocument(id: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapDocumentRow(row);
  }

  getDocumentByPath(sourceId: string, filepath: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE source_id = ? AND filepath = ?')
      .get(sourceId, filepath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapDocumentRow(row);
  }

  getDocumentsBySource(sourceId: string): DocumentRecord[] {
    const rows = this.db.prepare('SELECT * FROM documents WHERE source_id = ?').all(sourceId) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapDocumentRow(r));
  }

  listDocuments(options: SearchDocumentListOptions = {}): SearchDocumentListEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const extension = normalizeExtension(options.extension);
    const extensionLike = extension ? `%${extension}` : undefined;
    const rows = options.collection && extensionLike
      ? this.db.prepare('SELECT * FROM documents WHERE source_id = ? AND lower(filepath) LIKE ? ORDER BY filepath LIMIT ?').all(options.collection, extensionLike, limit) as Array<Record<string, unknown>>
      : options.collection
        ? this.db.prepare('SELECT * FROM documents WHERE source_id = ? ORDER BY filepath LIMIT ?').all(options.collection, limit) as Array<Record<string, unknown>>
        : extensionLike
          ? this.db.prepare('SELECT * FROM documents WHERE lower(filepath) LIKE ? ORDER BY source_id, filepath LIMIT ?').all(extensionLike, limit) as Array<Record<string, unknown>>
          : this.db.prepare('SELECT * FROM documents ORDER BY source_id, filepath LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows
      .map(r => this.mapDocumentRow(r))
      .map((doc) => ({
        id: doc.id,
        sourceId: doc.sourceId,
        filepath: doc.filepath,
        title: doc.title,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        updatedAt: doc.updatedAt,
      }));
  }

  upsertDocument(sourceId: string, filepath: string, title: string | null, contentHash: string, mimeType: string | null, sizeBytes: number): DocumentRecord {
    const existing = this.getDocumentByPath(sourceId, filepath);
    const now = Date.now();

    if (existing) {
      if (existing.contentHash === contentHash) {
        return existing; // No change
      }
      // Content changed — update document and delete old chunks
      this.db.prepare('UPDATE documents SET title = ?, content_hash = ?, mime_type = ?, size_bytes = ?, updated_at = ? WHERE id = ?')
        .run(title, contentHash, mimeType, sizeBytes, now, existing.id);
      this.deleteChunksForDocument(existing.id);
      return { ...existing, title, contentHash, mimeType, sizeBytes, updatedAt: now };
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO documents (id, source_id, filepath, title, content_hash, mime_type, size_bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, filepath, title, contentHash, mimeType, sizeBytes, now, now);

    return { id, sourceId, filepath, title, contentHash, mimeType, sizeBytes, createdAt: now, updatedAt: now };
  }

  deleteDocument(id: string): void {
    this.deleteChunksForDocument(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }

  /** Remove documents from a source that are no longer on disk. */
  removeStaleDocuments(sourceId: string, currentPaths: Set<string>): string[] {
    const docs = this.getDocumentsBySource(sourceId);
    const removed: string[] = [];
    for (const doc of docs) {
      if (!currentPaths.has(doc.filepath)) {
        this.deleteDocument(doc.id);
        removed.push(doc.filepath);
      }
    }
    return removed;
  }

  // ─── Chunk CRUD ─────────────────────────────────────────

  insertChunk(documentId: string, parentChunkId: string | null, content: string, startOffset: number, endOffset: number, tokenCount: number, chunkType: 'parent' | 'child'): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO chunks (id, document_id, parent_chunk_id, content, start_offset, end_offset, token_count, chunk_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, documentId, parentChunkId, content, startOffset, endOffset, tokenCount, chunkType);
    return id;
  }

  getChunk(id: string): ChunkRecord | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapChunkRow(row);
  }

  getChunksForDocument(documentId: string): ChunkRecord[] {
    const rows = this.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY start_offset').all(documentId) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapChunkRow(r));
  }

  private deleteChunksForDocument(documentId: string): void {
    // Delete embeddings first (foreign key)
    this.db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId);
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
  }

  // ─── Embedding Storage ──────────────────────────────────

  setEmbedding(chunkId: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding, dimensions) VALUES (?, ?, ?)
    `).run(chunkId, buf, embedding.length);
  }

  getEmbedding(chunkId: string): Float32Array | null {
    const row = this.db.prepare('SELECT embedding, dimensions FROM chunk_embeddings WHERE chunk_id = ?')
      .get(chunkId) as { embedding: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
  }

  /** Get all embeddings for chunks belonging to a source (or all sources). */
  getEmbeddingsForSearch(sourceId?: string): Array<{ chunkId: string; embedding: Float32Array }> {
    let sql = `
      SELECT ce.chunk_id, ce.embedding, ce.dimensions
      FROM chunk_embeddings ce
      JOIN chunks c ON c.id = ce.chunk_id
      JOIN documents d ON d.id = c.document_id
    `;
    const params: unknown[] = [];
    if (sourceId) {
      sql += ' WHERE d.source_id = ?';
      params.push(sourceId);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; embedding: Buffer; dimensions: number }>;
    return rows.map(r => ({
      chunkId: r.chunk_id,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.dimensions),
    }));
  }

  getEmbeddedChunkCount(sourceId?: string): number {
    if (sourceId) {
      const row = this.db.prepare(`
        SELECT COUNT(*) as count FROM chunk_embeddings ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = ?
      `).get(sourceId) as { count: number };
      return row.count;
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get() as { count: number };
    return row.count;
  }

  // ─── Collection Info ────────────────────────────────────

  getCollectionInfo(sourceId: string): CollectionInfo | null {
    const source = this.getSource(sourceId);
    if (!source) return null;

    const docCount = this.db.prepare('SELECT COUNT(*) as count FROM documents WHERE source_id = ?')
      .get(sourceId) as { count: number };
    const chunkCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.source_id = ?
    `).get(sourceId) as { count: number };
    const embeddedCount = this.getEmbeddedChunkCount(sourceId);
    const lastDoc = this.db.prepare('SELECT MAX(updated_at) as latest FROM documents WHERE source_id = ?')
      .get(sourceId) as { latest: number | null };

    return {
      id: source.id,
      name: source.name,
      documentCount: docCount.count,
      chunkCount: chunkCount.count,
      embeddedChunkCount: embeddedCount,
      lastIndexedAt: lastDoc.latest,
    };
  }

  getAllCollectionInfo(): CollectionInfo[] {
    const sources = this.getSources();
    return sources.map(s => this.getCollectionInfo(s.id)!).filter(Boolean);
  }

  // ─── Utilities ──────────────────────────────────────────

  /** Compute SHA-256 hash of content for change detection. */
  static contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  close(): void {
    this.db.close();
  }

  private mapDocumentRow(row: Record<string, unknown>): DocumentRecord {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      filepath: row.filepath as string,
      title: row.title as string | null,
      contentHash: row.content_hash as string,
      mimeType: row.mime_type as string | null,
      sizeBytes: row.size_bytes as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private mapChunkRow(row: Record<string, unknown>): ChunkRecord {
    return {
      id: row.id as string,
      documentId: row.document_id as string,
      parentChunkId: row.parent_chunk_id as string | null,
      content: row.content as string,
      startOffset: row.start_offset as number,
      endOffset: row.end_offset as number,
      tokenCount: row.token_count as number,
      chunkType: row.chunk_type as 'parent' | 'child',
    };
  }
}

function normalizeExtension(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}
