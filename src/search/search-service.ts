/**
 * SearchService — native TypeScript document search pipeline.
 *
 * Manages the full search pipeline: document indexing, chunking,
 * embedding, and hybrid search (BM25 + vector + optional re-ranking).
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { openSQLiteDatabase, hasSQLiteDriver } from '../runtime/sqlite-driver.js';
import type { SQLiteDatabase } from '../runtime/sqlite-driver.js';
import { DocumentStore } from './document-store.js';
import { FTSStore } from './fts-store.js';
import { VectorStore } from './vector-store.js';
import { HybridSearch } from './hybrid-search.js';
import { createEmbeddingProvider } from './embedding-provider.js';
import { createReranker } from './reranker.js';
import { parseDocument } from './document-parser.js';
import { chunkText } from './chunker.js';
import type {
  SearchConfig, SearchOptions, SearchResponse,
  SearchSourceConfig, SearchStatusResponse, SearchMode, EmbeddingProvider,
  SearchDocumentListOptions, SearchDocumentListResponse,
} from './types.js';

export class SearchService {
  private db: SQLiteDatabase | null = null;
  private store: DocumentStore | null = null;
  private fts: FTSStore | null = null;
  private vector: VectorStore | null = null;
  private hybrid: HybridSearch | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private readonly config: SearchConfig;
  private available = false;

  constructor(config: SearchConfig) {
    this.config = config;

    if (!config.enabled) return;
    if (!hasSQLiteDriver()) return;

    const dbPath = config.sqlitePath ?? join(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.guardianagent', 'search-index.sqlite',
    );

    this.db = openSQLiteDatabase(dbPath, { enableForeignKeyConstraints: true });
    if (!this.db) return;

    this.store = new DocumentStore(this.db);
    this.fts = new FTSStore(this.db);
    this.vector = new VectorStore(this.store);
    this.hybrid = new HybridSearch(this.fts, this.vector, this.store);
    this.embeddingProvider = createEmbeddingProvider(config.embedding);
    this.available = true;

    // Sync persisted sources with config
    this.syncConfigSources();
  }

  /** Sync config sources into the database (add new, update changed existing, remove stale). */
  private syncConfigSources(): void {
    if (!this.store) return;
    const existingSources = new Map(this.store.getSources().map(s => [s.id, s]));
    const configuredIds = new Set(this.config.sources.map(s => s.id));
    for (const source of this.config.sources) {
      const existing = existingSources.get(source.id);
      if (!existing) {
        this.store.addSource(source);
      } else if (!sameSearchSource(existing, source)) {
        this.store.updateSource(source);
      }
    }
    for (const existing of existingSources.values()) {
      if (!configuredIds.has(existing.id)) {
        this.store.removeSource(existing.id);
      }
    }
  }

  // ─── Search ─────────────────────────────────────────────

  async search(options: SearchOptions): Promise<SearchResponse> {
    if (!this.available || !this.hybrid) {
      return {
        results: [], query: options.query,
        mode: options.mode ?? this.config.defaultMode ?? 'hybrid',
        totalResults: 0, durationMs: 0,
      };
    }

    const start = Date.now();
    const mode: SearchMode = options.mode ?? this.config.defaultMode ?? 'hybrid';
    const limit = Math.min(Math.max(options.limit ?? this.config.maxResults ?? 20, 1), 100);

    let results = await this.hybrid.search({
      query: options.query,
      mode,
      sourceId: options.collection,
      limit,
      embeddingProvider: this.embeddingProvider,
    });

    // Optional re-ranking
    const reranker = createReranker(this.config.reranker);
    if (reranker && options.rerank !== false) {
      const topN = this.config.reranker?.topN ?? 10;
      results = await reranker.rerank(options.query, results, topN);
    }

    // Optionally strip body
    if (!options.includeBody) {
      results = results.map(r => ({ ...r, body: undefined }));
    }

    return {
      results,
      query: options.query,
      mode,
      collection: options.collection,
      totalResults: results.length,
      durationMs: Date.now() - start,
    };
  }

  listDocuments(options: SearchDocumentListOptions = {}): SearchDocumentListResponse {
    if (!this.available || !this.store) {
      return {
        documents: [],
        collection: options.collection,
        extension: options.extension,
        totalResults: 0,
      };
    }
    const documents = this.store.listDocuments(options);
    return {
      documents,
      collection: options.collection,
      extension: options.extension,
      totalResults: documents.length,
    };
  }

  // ─── Status ─────────────────────────────────────────────

  status(): SearchStatusResponse {
    if (!this.available || !this.store) {
      return {
        available: false,
        mode: this.config.defaultMode ?? 'hybrid',
        collections: [],
        configuredSources: this.config.sources.map(s => ({
          id: s.id, name: s.name, type: s.type, path: s.path, enabled: s.enabled,
        })),
        vectorSearchAvailable: false,
      };
    }

    return {
      available: true,
      mode: this.config.defaultMode ?? 'hybrid',
      collections: this.store.getAllCollectionInfo(),
      configuredSources: this.store.getSources().map(s => ({
        id: s.id, name: s.name, type: s.type, path: s.path, enabled: s.enabled,
      })),
      vectorSearchAvailable: this.embeddingProvider !== null,
    };
  }

  // ─── Source CRUD ────────────────────────────────────────

  getSources(): SearchSourceConfig[] {
    return this.store?.getSources() ?? [];
  }

  addSource(source: SearchSourceConfig): void {
    if (!this.store) throw new Error('Search service not available');
    this.store.addSource(source);
  }

  removeSource(id: string): boolean {
    return this.store?.removeSource(id) ?? false;
  }

  toggleSource(id: string, enabled: boolean): boolean {
    return this.store?.toggleSource(id, enabled) ?? false;
  }

  // ─── Indexing ───────────────────────────────────────────

  /**
   * Index documents from all enabled sources (or a specific source).
   *
   * Scans files, parses content, chunks text, inserts into DB.
   * Content hashing detects unchanged files to skip re-indexing.
   */
  async indexSource(sourceId: string): Promise<{ indexed: number; skipped: number; errors: Array<{ path: string; error: string }> }> {
    if (!this.store) throw new Error('Search service not available');

    const source = this.store.getSource(sourceId);
    if (!source) throw new Error(`Source '${sourceId}' not found`);
    if (!source.enabled) throw new Error(`Source '${sourceId}' is disabled`);

    const chunkingConfig = {
      parentTokens: this.config.chunking?.parentTokens ?? 768,
      childTokens: this.config.chunking?.childTokens ?? 192,
      overlapTokens: this.config.chunking?.overlapTokens ?? 48,
    };

    const result = { indexed: 0, skipped: 0, errors: [] as Array<{ path: string; error: string }> };

    if (source.type === 'directory') {
      const files = await this.discoverFiles(source.path, source.globs);
      const currentPaths = new Set(files);

      // Remove stale documents
      this.store.removeStaleDocuments(sourceId, currentPaths);

      for (const filepath of files) {
        try {
          const fileStat = await stat(filepath);
          const contentHash = await this.fileHash(filepath);

          // Check if document already exists with same hash
          const existing = this.store.getDocumentByPath(sourceId, filepath);
          if (existing && existing.contentHash === contentHash) {
            result.skipped++;
            continue;
          }

          const parsed = await parseDocument(filepath);
          const doc = this.store.upsertDocument(
            sourceId, filepath, parsed.title, contentHash,
            parsed.mimeType, fileStat.size,
          );

          // Chunk and insert
          const parents = chunkText(parsed.text, chunkingConfig);
          for (const parent of parents) {
            const parentId = this.store.insertChunk(
              doc.id, null, parent.content,
              parent.startOffset, parent.endOffset,
              parent.tokenCount, 'parent',
            );
            if (parent.children) {
              for (const child of parent.children) {
                this.store.insertChunk(
                  doc.id, parentId, child.content,
                  child.startOffset, child.endOffset,
                  child.tokenCount, 'child',
                );
              }
            }
          }

          result.indexed++;
        } catch (err) {
          result.errors.push({
            path: filepath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (source.type === 'file') {
      try {
        const filepath = source.path;
        const fileStat = await stat(filepath);
        const contentHash = await this.fileHash(filepath);

        const existing = this.store.getDocumentByPath(sourceId, filepath);
        if (existing && existing.contentHash === contentHash) {
          result.skipped++;
        } else {
          const parsed = await parseDocument(filepath);
          const doc = this.store.upsertDocument(
            sourceId, filepath, parsed.title, contentHash,
            parsed.mimeType, fileStat.size,
          );

          const parents = chunkText(parsed.text, chunkingConfig);
          for (const parent of parents) {
            const parentId = this.store.insertChunk(
              doc.id, null, parent.content,
              parent.startOffset, parent.endOffset,
              parent.tokenCount, 'parent',
            );
            if (parent.children) {
              for (const child of parent.children) {
                this.store.insertChunk(
                  doc.id, parentId, child.content,
                  child.startOffset, child.endOffset,
                  child.tokenCount, 'child',
                );
              }
            }
          }
          result.indexed++;
        }
      } catch (err) {
        result.errors.push({
          path: source.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // url and git source types would need additional implementation
    // (fetch URL content, clone/pull git repo) — left as future extension

    return result;
  }

  /**
   * Index all enabled sources.
   */
  async indexAll(): Promise<{ synced: string[]; errors: Array<{ id: string; error: string }> }> {
    if (!this.store) return { synced: [], errors: [] };

    const sources = this.store.getSources().filter(s => s.enabled);
    const synced: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const source of sources) {
      try {
        await this.indexSource(source.id);
        synced.push(source.id);
      } catch (err) {
        errors.push({ id: source.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { synced, errors };
  }

  /**
   * Generate embeddings for all un-embedded chunks (or a specific source).
   */
  async embedChunks(sourceId?: string): Promise<{ embedded: number; errors: number }> {
    if (!this.store || !this.embeddingProvider) {
      return { embedded: 0, errors: 0 };
    }

    // Find child chunks without embeddings
    let sql = `
      SELECT c.id, c.content
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id
      WHERE ce.chunk_id IS NULL AND c.chunk_type = 'child'
    `;
    const params: unknown[] = [];
    if (sourceId) {
      sql += ' AND d.source_id = ?';
      params.push(sourceId);
    }

    const rows = this.db!.prepare(sql).all(...params) as Array<{ id: string; content: string }>;
    if (rows.length === 0) return { embedded: 0, errors: 0 };

    const batchSize = this.config.embedding?.batchSize ?? 32;
    let embedded = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        const embeddings = await this.embeddingProvider.embed(batch.map(r => r.content));
        for (let j = 0; j < batch.length; j++) {
          this.store.setEmbedding(batch[j].id, embeddings[j]);
          embedded++;
        }
      } catch {
        errors += batch.length;
      }
    }

    return { embedded, errors };
  }

  /**
   * Full reindex: index documents + generate embeddings.
   */
  async reindex(sourceId?: string): Promise<{ success: boolean; message: string }> {
    try {
      if (sourceId) {
        const indexResult = await this.indexSource(sourceId);
        const embedResult = await this.embedChunks(sourceId);
        return {
          success: true,
          message: `Source '${sourceId}': ${indexResult.indexed} indexed, ${indexResult.skipped} skipped, ${embedResult.embedded} embedded.`,
        };
      }

      const indexResult = await this.indexAll();
      const embedResult = await this.embedChunks();
      return {
        success: true,
        message: `${indexResult.synced.length} sources indexed, ${embedResult.embedded} chunks embedded.`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── File Discovery ─────────────────────────────────────

  /** Recursively discover files in a directory, filtered by globs. */
  private async discoverFiles(dirPath: string, globs?: string[]): Promise<string[]> {
    const files: string[] = [];
    await this.walkDir(dirPath, files);

    if (!globs || globs.length === 0) return files;

    // Simple glob matching (supports * and **)
    return files.filter(f => {
      const rel = relative(dirPath, f);
      return globs.some(g => matchGlob(rel, g));
    });
  }

  private async walkDir(dir: string, files: string[], depth: number = 0): Promise<void> {
    if (depth > 20) return; // Safety cap

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden dirs and common non-content dirs
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
          await this.walkDir(fullPath, files, depth + 1);
        } else if (entry.isFile()) {
          // Skip hidden files and very large files
          if (entry.name.startsWith('.')) continue;
          files.push(fullPath);
        }
      }
    } catch {
      // Permission denied or other error — skip directory
    }
  }

  /** Compute SHA-256 hash of a file for change detection. */
  private async fileHash(filepath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filepath);
    return createHash('sha256').update(content).digest('hex');
  }

  // ─── Lifecycle ──────────────────────────────────────────

  isAvailable(): boolean {
    return this.available;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.available = false;
  }
}

// ─── Glob Matching ────────────────────────────────────────

/** Simple glob matcher supporting * (one segment) and ** (zero or more segments). */
function matchGlob(path: string, glob: string): boolean {
  const pathSegments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const globSegments = glob.replace(/\\/g, '/').split('/').filter(Boolean);
  const memo = new Map<string, boolean>();

  const matches = (pathIndex: number, globIndex: number): boolean => {
    const key = `${pathIndex}:${globIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (globIndex === globSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (globSegments[globIndex] === '**') {
      result = matches(pathIndex, globIndex + 1)
        || (pathIndex < pathSegments.length && matches(pathIndex + 1, globIndex));
    } else {
      result = pathIndex < pathSegments.length
        && matchGlobSegment(pathSegments[pathIndex], globSegments[globIndex])
        && matches(pathIndex + 1, globIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return matches(0, 0);
}

function matchGlobSegment(value: string, glob: string): boolean {
  const regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`).test(value);
}

function sameSearchSource(left: SearchSourceConfig, right: SearchSourceConfig): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.path === right.path
    && JSON.stringify(left.globs ?? []) === JSON.stringify(right.globs ?? [])
    && (left.branch ?? '') === (right.branch ?? '')
    && left.enabled === right.enabled
    && (left.description ?? '') === (right.description ?? '');
}
