/**
 * Per-agent persistent knowledge base with trust-aware metadata.
 *
 * Active reviewed content remains readable as markdown for operator auditability.
 * Trust, provenance, TTL, and quarantine state live in a sidecar JSON index.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type MemorySourceType = 'user' | 'local_tool' | 'remote_tool' | 'system' | 'operator';
export type MemoryTrustLevel = 'trusted' | 'untrusted' | 'reviewed';
export type MemoryStatus = 'active' | 'quarantined' | 'expired' | 'rejected';

/** Configuration for the agent knowledge base. */
export interface AgentMemoryStoreConfig {
  enabled: boolean;
  basePath?: string;
  maxContextChars: number;
  maxFileChars: number;
}

export const DEFAULT_MEMORY_STORE_CONFIG: AgentMemoryStoreConfig = {
  enabled: true,
  maxContextChars: 4000,
  maxFileChars: 20000,
};

export interface MemoryProvenance {
  toolName?: string;
  domain?: string;
  sessionId?: string;
  requestId?: string;
  taintReasons?: string[];
}

/** A single memory entry with metadata. */
export interface MemoryEntry {
  content: string;
  createdAt: string;
  category?: string;
  sourceType?: MemorySourceType;
  trustLevel?: MemoryTrustLevel;
  status?: MemoryStatus;
  createdByPrincipal?: string;
  expiresAt?: string;
  tags?: string[];
  provenance?: MemoryProvenance;
}

export interface StoredMemoryEntry extends MemoryEntry {
  id: string;
  contentHash: string;
}

interface MemoryIndexFile {
  version: 1;
  entries: StoredMemoryEntry[];
}

const EMPTY_INDEX: MemoryIndexFile = { version: 1, entries: [] };

export class AgentMemoryStore {
  private readonly basePath: string;
  private readonly config: AgentMemoryStoreConfig;
  private readonly cache = new Map<string, string>();
  private readonly indexCache = new Map<string, MemoryIndexFile>();

  constructor(config: Partial<AgentMemoryStoreConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_STORE_CONFIG, ...config };
    this.basePath = this.config.basePath ?? join(homedir(), '.guardianagent', 'memory');

    if (this.config.enabled) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private safeAgentId(agentId: string): string {
    return agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /** Resolve the markdown path for an agent's knowledge base. */
  private filePath(agentId: string): string {
    return join(this.basePath, `${this.safeAgentId(agentId)}.md`);
  }

  /** Resolve the sidecar index path for an agent's knowledge base metadata. */
  private indexPath(agentId: string): string {
    return join(this.basePath, `${this.safeAgentId(agentId)}.index.json`);
  }

  private computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private readIndex(agentId: string): MemoryIndexFile {
    const cached = this.indexCache.get(agentId);
    if (cached) {
      return this.applyExpiry(agentId, cached);
    }

    const path = this.indexPath(agentId);
    if (!existsSync(path)) {
      this.indexCache.set(agentId, { ...EMPTY_INDEX, entries: [] });
      return { ...EMPTY_INDEX, entries: [] };
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MemoryIndexFile>;
      const file: MemoryIndexFile = {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
      this.indexCache.set(agentId, file);
      return this.applyExpiry(agentId, file);
    } catch {
      const empty = { ...EMPTY_INDEX, entries: [] };
      this.indexCache.set(agentId, empty);
      return empty;
    }
  }

  private writeIndex(agentId: string, index: MemoryIndexFile): void {
    const path = this.indexPath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(index, null, 2), 'utf-8');
    this.indexCache.set(agentId, index);
  }

  private applyExpiry(agentId: string, index: MemoryIndexFile): MemoryIndexFile {
    let changed = false;
    const now = Date.now();
    const nextEntries = index.entries.map((entry) => {
      if (entry.status === 'active' && entry.expiresAt) {
        const expiresAt = Date.parse(entry.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= now) {
          changed = true;
          return { ...entry, status: 'expired' as const };
        }
      }
      return entry;
    });

    if (!changed) {
      return index;
    }

    const next = { ...index, entries: nextEntries };
    this.writeIndex(agentId, next);
    this.rebuildMarkdown(agentId, next);
    return next;
  }

  private rebuildMarkdown(agentId: string, index?: MemoryIndexFile): void {
    const effectiveIndex = index ?? this.readIndex(agentId);
    const lines: string[] = [];
    const grouped = new Map<string, StoredMemoryEntry[]>();

    for (const entry of effectiveIndex.entries) {
      if (entry.status !== 'active') continue;
      const heading = entry.category?.trim() || 'General';
      const list = grouped.get(heading) ?? [];
      list.push(entry);
      grouped.set(heading, list);
    }

    for (const [heading, entries] of grouped.entries()) {
      if (lines.length > 0) lines.push('');
      lines.push(`## ${heading}`);
      for (const entry of entries) {
        const trust = entry.trustLevel && entry.trustLevel !== 'trusted'
          ? ` [${entry.trustLevel}]`
          : '';
        lines.push(`- ${entry.content}${trust} _(${entry.createdAt})_`);
      }
    }

    const content = lines.join('\n');
    const path = this.filePath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    this.cache.set(agentId, content);
  }

  load(agentId: string): string {
    if (!this.config.enabled) return '';

    const cached = this.cache.get(agentId);
    if (cached !== undefined) return cached;

    const path = this.filePath(agentId);
    if (!existsSync(path)) {
      this.cache.set(agentId, '');
      return '';
    }

    try {
      const content = readFileSync(path, 'utf-8');
      this.cache.set(agentId, content);
      return content;
    } catch {
      return '';
    }
  }

  loadForContext(agentId: string): string {
    const full = this.load(agentId);
    if (!full) return '';

    if (full.length <= this.config.maxContextChars) return full;
    return full.slice(0, this.config.maxContextChars) + '\n\n[... knowledge base truncated — use memory_search to find specific facts]';
  }

  save(agentId: string, content: string): void {
    if (!this.config.enabled) return;

    const path = this.filePath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    this.cache.set(agentId, content);
  }

  append(agentId: string, entry: MemoryEntry): StoredMemoryEntry {
    if (!this.config.enabled) {
      return {
        id: randomUUID(),
        contentHash: this.computeContentHash(entry.content),
        content: entry.content,
        createdAt: entry.createdAt,
        category: entry.category,
      };
    }

    const index = this.readIndex(agentId);
    const stored: StoredMemoryEntry = {
      id: randomUUID(),
      content: entry.content,
      createdAt: entry.createdAt,
      category: entry.category,
      sourceType: entry.sourceType ?? 'user',
      trustLevel: entry.trustLevel ?? 'trusted',
      status: entry.status ?? 'active',
      createdByPrincipal: entry.createdByPrincipal,
      expiresAt: entry.expiresAt,
      tags: entry.tags ? [...entry.tags] : undefined,
      provenance: entry.provenance ? { ...entry.provenance } : undefined,
      contentHash: this.computeContentHash(entry.content),
    };

    index.entries.unshift(stored);
    this.writeIndex(agentId, index);

    if (stored.status === 'active') {
      this.rebuildMarkdown(agentId, index);
    }

    return stored;
  }

  appendRaw(agentId: string, text: string): void {
    const createdAt = new Date().toISOString().slice(0, 10);
    this.append(agentId, {
      content: text,
      createdAt,
      category: 'General',
      sourceType: 'system',
      trustLevel: 'trusted',
      status: 'active',
    });
  }

  getEntries(agentId: string, includeInactive = false): StoredMemoryEntry[] {
    const index = this.readIndex(agentId);
    return includeInactive
      ? [...index.entries]
      : index.entries.filter((entry) => entry.status === 'active');
  }

  findEntry(agentId: string, entryId: string): StoredMemoryEntry | undefined {
    return this.readIndex(agentId).entries.find((entry) => entry.id === entryId);
  }

  isEntryActive(agentId: string, entryId: string): boolean {
    return this.findEntry(agentId, entryId)?.status === 'active';
  }

  searchEntries(
    agentId: string,
    query: string,
    options?: { includeInactive?: boolean; limit?: number },
  ): StoredMemoryEntry[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));
    const entries = this.getEntries(agentId, options?.includeInactive);

    return entries
      .filter((entry) => {
        const category = entry.category?.toLowerCase() ?? '';
        const tags = Array.isArray(entry.tags) ? entry.tags.join(' ').toLowerCase() : '';
        return entry.content.toLowerCase().includes(normalizedQuery)
          || category.includes(normalizedQuery)
          || tags.includes(normalizedQuery);
      })
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  search(agentId: string, query: string, options?: { includeInactive?: boolean }): string[] {
    const matchedEntries = this.searchEntries(agentId, query, options);
    if (options?.includeInactive) {
      return matchedEntries.map((entry) => {
        const category = entry.category?.trim() || 'General';
        return `## ${category}\n- [${entry.status}] ${entry.content} _(${entry.createdAt})_`;
      });
    }

    const content = this.load(agentId);
    if (!content) return [];

    const lines = content.split('\n');
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query.trim().toLowerCase())) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 1);
        matches.push(lines.slice(start, end + 1).join('\n'));
      }
    }
    return matches;
  }

  exists(agentId: string): boolean {
    if (!this.config.enabled) return false;
    return existsSync(this.filePath(agentId)) || this.readIndex(agentId).entries.length > 0;
  }

  size(agentId: string): number {
    return this.load(agentId).length;
  }

  clearCache(): void {
    this.cache.clear();
    this.indexCache.clear();
  }

  delete(agentId: string): boolean {
    if (!this.config.enabled) return false;

    try {
      const { unlinkSync } = require('node:fs') as typeof import('node:fs');
      const markdownPath = this.filePath(agentId);
      const indexPath = this.indexPath(agentId);
      if (existsSync(markdownPath)) unlinkSync(markdownPath);
      if (existsSync(indexPath)) unlinkSync(indexPath);
      this.cache.delete(agentId);
      this.indexCache.delete(agentId);
      return true;
    } catch {
      return false;
    }
  }

  listAgents(): string[] {
    if (!this.config.enabled) return [];

    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const files = readdirSync(this.basePath) as string[];
      const ids = new Set<string>();
      for (const file of files) {
        if (file.endsWith('.md')) ids.add(file.replace(/\.md$/, ''));
        if (file.endsWith('.index.json')) ids.add(file.replace(/\.index\.json$/, ''));
      }
      return [...ids];
    } catch {
      return [];
    }
  }
}
