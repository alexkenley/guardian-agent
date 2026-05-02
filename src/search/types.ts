/**
 * Search pipeline types.
 */

// ─── Search Modes ─────────────────────────────────────────

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

// ─── Source Configuration ─────────────────────────────────

export type SearchSourceType = 'directory' | 'git' | 'url' | 'file';

export interface SearchSourceConfig {
  id: string;
  name: string;
  type: SearchSourceType;
  path: string;
  globs?: string[];
  branch?: string;
  enabled: boolean;
  description?: string;
}

// ─── Search Options & Results ─────────────────────────────

export interface SearchOptions {
  query: string;
  mode?: SearchMode;
  collection?: string;
  limit?: number;
  includeBody?: boolean;
  rerank?: boolean;
}

export interface SearchResult {
  score: number;
  filepath: string;
  title: string;
  context: string;
  snippet: string;
  documentId: string;
  collectionName: string;
  chunkId: string;
  body?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  mode: SearchMode;
  collection?: string;
  totalResults: number;
  durationMs: number;
}

export interface SearchDocumentListOptions {
  collection?: string;
  extension?: string;
  limit?: number;
}

export interface SearchDocumentListEntry {
  id: string;
  sourceId: string;
  filepath: string;
  title: string | null;
  mimeType: string | null;
  sizeBytes: number;
  updatedAt: number;
}

export interface SearchDocumentListResponse {
  documents: SearchDocumentListEntry[];
  collection?: string;
  extension?: string;
  totalResults: number;
}

// ─── Document & Chunk Records ─────────────────────────────

export interface DocumentRecord {
  id: string;
  sourceId: string;
  filepath: string;
  title: string | null;
  contentHash: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  parentChunkId: string | null;
  content: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  chunkType: 'parent' | 'child';
}

// ─── Collection / Status Info ─────────────────────────────

export interface CollectionInfo {
  id: string;
  name: string;
  documentCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  lastIndexedAt: number | null;
}

export interface SearchStatusResponse {
  available: boolean;
  mode: SearchMode;
  collections: CollectionInfo[];
  configuredSources: Array<{ id: string; name: string; type: SearchSourceType; path: string; enabled: boolean }>;
  vectorSearchAvailable: boolean;
}

// ─── Embedding Types ──────────────────────────────────────

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ─── Config ───────────────────────────────────────────────

export interface SearchConfig {
  enabled: boolean;
  sqlitePath?: string;
  defaultMode?: SearchMode;
  maxResults?: number;
  sources: SearchSourceConfig[];
  embedding?: {
    provider?: 'ollama' | 'openai';
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    batchSize?: number;
    dimensions?: number;
  };
  chunking?: {
    parentTokens?: number;
    childTokens?: number;
    overlapTokens?: number;
  };
  reranker?: {
    enabled: boolean;
    provider?: 'cohere' | 'llm';
    model?: string;
    apiKey?: string;
    topN?: number;
  };
}
