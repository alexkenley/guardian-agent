/**
 * Per-agent persistent knowledge base with trust-aware metadata.
 *
 * Active reviewed content remains readable as markdown for operator auditability.
 * Trust, provenance, TTL, and quarantine state live in a sidecar JSON index.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ControlPlaneIntegrity } from '../guardian/control-plane-integrity.js';
import { detectInjection, stripInvisibleChars } from '../guardian/input-sanitizer.js';
import { mkdirSecureSync, writeSecureFileSync } from '../util/secure-fs.js';

export type MemorySourceType = 'user' | 'local_tool' | 'remote_tool' | 'system' | 'operator';
export type MemoryTrustLevel = 'trusted' | 'untrusted' | 'reviewed';
export type MemoryStatus = 'active' | 'quarantined' | 'expired' | 'rejected' | 'archived';
export type MemoryArtifactClass = 'canonical' | 'operator_curated' | 'derived' | 'linked_output';
export type MemoryArtifactKind =
  | 'memory_entry'
  | 'wiki_page'
  | 'topic_index'
  | 'decision_index'
  | 'automation_index'
  | 'review_queue'
  | 'lint_report'
  | 'session_summary'
  | 'linked_output';

export interface MemoryArtifactMetadata {
  sourceClass?: MemoryArtifactClass;
  kind?: MemoryArtifactKind;
  title?: string;
  slug?: string;
  retrievalHints?: string[];
  refreshable?: boolean;
  lastBuiltAt?: string;
  sourceEntryIds?: string[];
  updatedAt?: string;
  updatedByPrincipal?: string;
  changeReason?: string;
  archivedAt?: string;
}

/** Configuration for the agent knowledge base. */
export interface AgentMemoryStoreConfig {
  enabled: boolean;
  basePath?: string;
  readOnly: boolean;
  maxContextChars: number;
  maxFileChars: number;
  maxEntryChars: number;
  maxEntriesPerScope: number;
  maxEmbeddingCacheBytes: number;
  integrity?: ControlPlaneIntegrity;
  onSecurityEvent?: (event: {
    severity: 'info' | 'warn' | 'critical';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

export const DEFAULT_MEMORY_STORE_CONFIG: AgentMemoryStoreConfig = {
  enabled: true,
  readOnly: false,
  maxContextChars: 4000,
  maxFileChars: 20000,
  maxEntryChars: 2000,
  maxEntriesPerScope: 500,
  maxEmbeddingCacheBytes: 50_000_000,
  integrity: undefined,
  onSecurityEvent: undefined,
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
  summary?: string;
  createdAt: string;
  category?: string;
  sourceType?: MemorySourceType;
  trustLevel?: MemoryTrustLevel;
  status?: MemoryStatus;
  createdByPrincipal?: string;
  expiresAt?: string;
  tags?: string[];
  provenance?: MemoryProvenance;
  artifact?: MemoryArtifactMetadata;
}

export interface StoredMemoryEntry extends MemoryEntry {
  id: string;
  contentHash: string;
}

export interface MemoryContextSelectionEntry {
  id: string;
  category: string;
  createdAt: string;
  preview: string;
  renderMode: 'full' | 'summary';
  queryScore: number;
  sourceClass: MemoryArtifactClass;
  sourceType?: MemorySourceType;
  trustLevel?: MemoryTrustLevel;
  isContextFlush: boolean;
  matchReasons?: string[];
}

export interface MemoryContextLoadResult {
  content: string;
  candidateEntries: number;
  selectedEntries: MemoryContextSelectionEntry[];
  omittedEntries: number;
  queryPreview?: string;
}

export interface MemoryContextQuery {
  text?: string;
  focusTexts?: string[];
  tags?: string[];
  identifiers?: string[];
  categoryHints?: string[];
}

export interface MemoryContextLoadOptions {
  query?: string | MemoryContextQuery;
  maxChars?: number;
}

export function classifyMemoryEntrySource(
  entry: Pick<MemoryEntry, 'sourceType' | 'category' | 'tags' | 'artifact'>,
): MemoryArtifactClass {
  if (entry.artifact?.sourceClass) return entry.artifact.sourceClass;
  if (entry.sourceType === 'operator' || entry.category === 'Operator Wiki') return 'operator_curated';
  if (entry.tags?.includes('automation_output_reference')) return 'linked_output';
  if (entry.sourceType === 'system' || entry.tags?.includes(MEMORY_CONTEXT_FLUSH_TAG)) return 'derived';
  return 'canonical';
}

interface MemoryIndexFile {
  version: 1 | 2;
  entries: StoredMemoryEntry[];
}

interface NormalizedMemoryContextQuery {
  preview: string;
  fullText?: string;
  focusTexts: string[];
  tags: string[];
  identifiers: string[];
  categoryHints: string[];
  terms: string[];
}

const EMPTY_INDEX: MemoryIndexFile = { version: 2, entries: [] };
const MEMORY_CONTEXT_BLOCK_THRESHOLD = 3;
const MEMORY_SUMMARY_MAX_CHARS = 200;
const MEMORY_CONTEXT_FLUSH_TAG = 'context_flush';
const MAX_CONTEXT_CANDIDATES = 18;
const MAX_QUERY_CONTEXT_CANDIDATES = 24;

function memorySourceClassPriority(sourceClass: MemoryArtifactClass): number {
  switch (sourceClass) {
    case 'operator_curated':
      return 3;
    case 'canonical':
      return 2;
    case 'linked_output':
      return 1;
    default:
      return 0;
  }
}

export class AgentMemoryStore {
  private basePath: string;
  private config: AgentMemoryStoreConfig;
  private readonly cache = new Map<string, string>();
  private readonly indexCache = new Map<string, MemoryIndexFile>();

  constructor(config: Partial<AgentMemoryStoreConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_STORE_CONFIG, ...config };
    this.basePath = this.config.basePath ?? join(homedir(), '.guardianagent', 'memory');

    if (this.config.enabled) {
      mkdirSecureSync(this.basePath);
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

  private normalizeInlineText(value: string): string {
    return stripInvisibleChars(value).replace(/\s+/g, ' ').trim();
  }

  private truncateInlineText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    const candidate = value.slice(0, maxChars + 1);
    const breakIndex = candidate.lastIndexOf(' ');
    const cutIndex = breakIndex >= Math.floor(maxChars * 0.6) ? breakIndex : maxChars;
    return `${candidate.slice(0, cutIndex).trim().replace(/[,:;\-]+$/, '')}...`;
  }

  private normalizeSignalList(values: readonly unknown[] | undefined): string[] {
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
      const cleaned = this.normalizeInlineText(String(value ?? '')).toLowerCase();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      normalized.push(cleaned);
    }
    return normalized;
  }

  private extractQueryTerms(values: string[]): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const value of values) {
      for (const term of value.split(/[^a-z0-9]+/).filter((candidate) => candidate.length >= 2)) {
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
      }
    }
    return terms;
  }

  private normalizeContextQueryInput(options?: MemoryContextLoadOptions): NormalizedMemoryContextQuery | null {
    const rawQuery = options?.query;
    if (typeof rawQuery === 'string') {
      const fullText = this.normalizeInlineText(rawQuery).toLowerCase();
      if (!fullText) return null;
      return {
        preview: this.truncateInlineText(fullText, 120),
        fullText,
        focusTexts: [],
        tags: [],
        identifiers: [],
        categoryHints: [],
        terms: this.extractQueryTerms([fullText]),
      };
    }
    if (!rawQuery || typeof rawQuery !== 'object') {
      return null;
    }

    const fullText = this.normalizeInlineText(rawQuery.text ?? '').toLowerCase();
    const focusTexts = this.normalizeSignalList(rawQuery.focusTexts);
    const tags = this.normalizeSignalList(rawQuery.tags);
    const identifiers = this.normalizeSignalList(rawQuery.identifiers);
    const categoryHints = this.normalizeSignalList(rawQuery.categoryHints);

    const previewParts = [
      ...(fullText ? [fullText] : []),
      ...focusTexts.slice(0, 2),
      ...tags.slice(0, 2).map((tag) => `tag:${tag}`),
      ...identifiers.slice(0, 2).map((identifier) => `id:${identifier}`),
    ];
    const preview = this.truncateInlineText(previewParts.join(' | '), 120);
    const terms = this.extractQueryTerms([
      ...(fullText ? [fullText] : []),
      ...focusTexts,
      ...tags,
      ...identifiers,
      ...categoryHints,
    ]);

    if (!preview && terms.length === 0) {
      return null;
    }

    return {
      preview,
      ...(fullText ? { fullText } : {}),
      focusTexts,
      tags,
      identifiers,
      categoryHints,
      terms,
    };
  }

  private normalizeSummary(summary: string | undefined, content: string): string | undefined {
    const provided = this.normalizeInlineText(summary ?? '');
    if (provided) {
      return this.truncateInlineText(provided, MEMORY_SUMMARY_MAX_CHARS);
    }

    const normalizedContent = this.normalizeInlineText(content);
    if (!normalizedContent || normalizedContent.length <= MEMORY_SUMMARY_MAX_CHARS + 40) {
      return undefined;
    }

    const firstSentenceMatch = normalizedContent.match(/^(.{1,200}?[.!?])(?:\s|$)/);
    const candidate = firstSentenceMatch?.[1] ?? normalizedContent;
    return this.truncateInlineText(candidate, MEMORY_SUMMARY_MAX_CHARS);
  }

  private normalizeArtifactMetadata(metadata: MemoryArtifactMetadata | undefined): MemoryArtifactMetadata | undefined {
    if (!metadata || typeof metadata !== 'object') {
      return undefined;
    }

    const normalized: MemoryArtifactMetadata = {};
    if (metadata.sourceClass) normalized.sourceClass = metadata.sourceClass;
    if (metadata.kind) normalized.kind = metadata.kind;

    const title = this.normalizeInlineText(metadata.title ?? '');
    if (title) normalized.title = this.truncateInlineText(title, 120);

    const slug = stripInvisibleChars(metadata.slug?.trim() ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) normalized.slug = slug;

    const retrievalHints = this.normalizeSignalList(metadata.retrievalHints);
    if (retrievalHints.length > 0) normalized.retrievalHints = retrievalHints;

    const sourceEntryIds = Array.isArray(metadata.sourceEntryIds)
      ? [...new Set(metadata.sourceEntryIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [];
    if (sourceEntryIds.length > 0) normalized.sourceEntryIds = sourceEntryIds;

    if (typeof metadata.refreshable === 'boolean') normalized.refreshable = metadata.refreshable;

    const lastBuiltAt = metadata.lastBuiltAt?.trim();
    if (lastBuiltAt) normalized.lastBuiltAt = lastBuiltAt;

    const updatedAt = metadata.updatedAt?.trim();
    if (updatedAt) normalized.updatedAt = updatedAt;

    const updatedByPrincipal = this.normalizeInlineText(metadata.updatedByPrincipal ?? '');
    if (updatedByPrincipal) normalized.updatedByPrincipal = this.truncateInlineText(updatedByPrincipal, 80);

    const changeReason = this.normalizeInlineText(metadata.changeReason ?? '');
    if (changeReason) normalized.changeReason = this.truncateInlineText(changeReason, 220);

    const archivedAt = metadata.archivedAt?.trim();
    if (archivedAt) normalized.archivedAt = archivedAt;

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private mergeArtifactMetadata(
    existing: MemoryArtifactMetadata | undefined,
    patch: MemoryArtifactMetadata | undefined,
  ): MemoryArtifactMetadata | undefined {
    if (!patch) {
      return existing ? this.normalizeArtifactMetadata(existing) : undefined;
    }

    return this.normalizeArtifactMetadata({
      ...(existing ?? {}),
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    });
  }

  private renderEntryTextWithTitle(entry: Pick<MemoryEntry, 'artifact'>, text: string): string {
    const title = this.normalizeInlineText(entry.artifact?.title ?? '');
    if (!title) {
      return text;
    }
    const normalizedText = this.normalizeInlineText(text).toLowerCase();
    if (normalizedText.startsWith(title.toLowerCase())) {
      return text;
    }
    return `${title}: ${text}`;
  }

  private emitSecurityEvent(event: {
    severity: 'info' | 'warn' | 'critical';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }): void {
    this.config.onSecurityEvent?.(event);
  }

  private assertWritable(): void {
    if (this.config.readOnly) {
      throw new Error('Persistent memory is read-only.');
    }
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

    if (this.config.integrity) {
      const verification = this.config.integrity.verifyFileSync(path, {
        adoptUntracked: true,
        updatedBy: 'memory_index_load',
      });
      if (!verification.ok) {
        this.indexCache.delete(agentId);
        this.cache.delete(agentId);
        this.emitSecurityEvent({
          severity: 'critical',
          code: 'memory_index_integrity_violation',
          message: verification.message,
          details: {
            agentId,
            path,
            integrityCode: verification.code,
          },
        });
        return { ...EMPTY_INDEX, entries: [] };
      }
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MemoryIndexFile>;
      const file: MemoryIndexFile = {
        version: parsed.version === 1 ? 1 : 2,
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
    writeSecureFileSync(path, JSON.stringify(index, null, 2));
    this.config.integrity?.signFileSync(path, 'memory_index_write');
    this.indexCache.set(agentId, index);
  }

  private applyExpiry(agentId: string, index: MemoryIndexFile): MemoryIndexFile {
    if (this.config.readOnly) {
      return index;
    }

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

  private renderMarkdown(
    agentId: string,
    index: MemoryIndexFile,
    options?: { sanitizeForPrompt?: boolean },
  ): string {
    const sanitizeForPrompt = options?.sanitizeForPrompt === true;
    const lines: string[] = [];
    const grouped = new Map<string, string[]>();

    for (const entry of index.entries) {
      if (entry.status !== 'active') continue;

      const renderedContent = sanitizeForPrompt
        ? this.sanitizeEntryForPrompt(agentId, entry)
        : entry.content;
      if (!renderedContent) continue;
      const titledContent = this.renderEntryTextWithTitle(entry, renderedContent);

      const heading = sanitizeForPrompt
        ? this.sanitizeHeadingForPrompt(entry.category)
        : entry.category?.trim() || 'General';
      const list = grouped.get(heading) ?? [];
      const trust = entry.trustLevel && entry.trustLevel !== 'trusted'
        ? ` [${entry.trustLevel}]`
        : '';
      list.push(`- ${titledContent}${trust} _(${entry.createdAt})_`);
      grouped.set(heading, list);
    }

    for (const [heading, entries] of grouped.entries()) {
      if (lines.length > 0) lines.push('');
      lines.push(`## ${heading}`);
      lines.push(...entries);
    }

    return lines.join('\n');
  }

  private rebuildMarkdown(agentId: string, index?: MemoryIndexFile): void {
    const effectiveIndex = index ?? this.readIndex(agentId);
    const content = this.renderMarkdown(agentId, effectiveIndex);
    const path = this.filePath(agentId);
    writeSecureFileSync(path, content);
    this.cache.set(agentId, content);
  }

  private enforceFileBudget(agentId: string, index: MemoryIndexFile): MemoryIndexFile {
    const renderLength = (candidate: MemoryIndexFile): number => this.renderMarkdown(agentId, candidate).length;
    if (renderLength(index) <= this.config.maxFileChars) {
      return index;
    }

    const nextEntries = index.entries.map((entry) => ({ ...entry }));
    let compacted = 0;
    for (let i = nextEntries.length - 1; i > 0 && renderLength({ ...index, entries: nextEntries }) > this.config.maxFileChars; i--) {
      if (nextEntries[i]?.status !== 'active') continue;
      nextEntries[i] = { ...nextEntries[i]!, status: 'expired' };
      compacted++;
    }

    const nextIndex: MemoryIndexFile = { ...index, entries: nextEntries };
    if (renderLength(nextIndex) > this.config.maxFileChars) {
      throw new Error(`Persistent memory exceeds maxFileChars (${this.config.maxFileChars}).`);
    }

    if (compacted > 0) {
      this.emitSecurityEvent({
        severity: 'info',
        code: 'memory_file_budget_compacted',
        message: `Compacted older active entries to respect maxFileChars (${this.config.maxFileChars}).`,
        details: {
          agentId,
          compactedEntries: compacted,
          maxFileChars: this.config.maxFileChars,
        },
      });
    }

    return nextIndex;
  }

  private enforceEntryCountBudget(agentId: string, index: MemoryIndexFile): MemoryIndexFile {
    if (index.entries.length <= this.config.maxEntriesPerScope) {
      return index;
    }

    const activeEntries = index.entries.filter((entry) => entry.status === 'active');
    if (activeEntries.length > this.config.maxEntriesPerScope) {
      throw new Error(`Persistent memory exceeds maxEntriesPerScope (${this.config.maxEntriesPerScope}).`);
    }

    const retainedIds = new Set<string>(activeEntries.map((entry) => entry.id));
    let remainingInactiveBudget = this.config.maxEntriesPerScope - activeEntries.length;
    let droppedInactive = 0;

    for (const entry of index.entries) {
      if (entry.status === 'active') continue;
      if (remainingInactiveBudget > 0) {
        retainedIds.add(entry.id);
        remainingInactiveBudget -= 1;
      } else {
        droppedInactive += 1;
      }
    }

    if (droppedInactive < 1) {
      return index;
    }

    this.emitSecurityEvent({
      severity: 'info',
      code: 'memory_entry_budget_pruned_inactive',
      message: `Pruned older inactive entries to respect maxEntriesPerScope (${this.config.maxEntriesPerScope}).`,
      details: {
        agentId,
        droppedEntries: droppedInactive,
        maxEntriesPerScope: this.config.maxEntriesPerScope,
      },
    });

    return {
      ...index,
      entries: index.entries.filter((entry) => retainedIds.has(entry.id)),
    };
  }

  load(agentId: string): string {
    if (!this.config.enabled) return '';

    const indexFileExists = existsSync(this.indexPath(agentId));
    if (indexFileExists) {
      const rendered = this.renderMarkdown(agentId, this.readIndex(agentId), { sanitizeForPrompt: true });
      this.cache.set(agentId, rendered);
      return rendered;
    }

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

  loadForContext(agentId: string, options?: MemoryContextLoadOptions): string {
    const indexPath = this.indexPath(agentId);
    const maxChars = this.resolveContextLimit(options);
    const full = existsSync(indexPath)
      ? this.renderContextMarkdownResult(agentId, this.readIndex(agentId), options).content
      : this.load(agentId);
    if (!full) return '';

    if (full.length <= maxChars) return full;
    return full.slice(0, maxChars) + '\n\n[... knowledge base truncated — use memory_search to find specific facts]';
  }

  loadForContextWithSelection(agentId: string, options?: MemoryContextLoadOptions): MemoryContextLoadResult {
    const query = this.normalizeContextQueryInput(options);
    const indexPath = this.indexPath(agentId);
    if (!existsSync(indexPath)) {
      return {
        content: this.loadForContext(agentId, options),
        candidateEntries: 0,
        selectedEntries: [],
        omittedEntries: 0,
        ...(query?.preview ? { queryPreview: query.preview } : {}),
      };
    }
    return this.renderContextMarkdownResult(agentId, this.readIndex(agentId), options);
  }

  save(agentId: string, content: string): void {
    if (!this.config.enabled) return;
    this.assertWritable();

    const path = this.filePath(agentId);
    if (content.length > this.config.maxFileChars) {
      throw new Error(`Persistent memory exceeds maxFileChars (${this.config.maxFileChars}).`);
    }
    writeSecureFileSync(path, content);
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
    this.assertWritable();

    if (entry.content.length > this.config.maxEntryChars) {
      throw new Error(`Persistent memory entry exceeds maxEntryChars (${this.config.maxEntryChars}).`);
    }

    const index = this.readIndex(agentId);
    const stored: StoredMemoryEntry = {
      id: randomUUID(),
      content: entry.content,
      summary: this.normalizeSummary(entry.summary, entry.content),
      createdAt: entry.createdAt,
      category: entry.category,
      sourceType: entry.sourceType ?? 'user',
      trustLevel: entry.trustLevel ?? 'trusted',
      status: entry.status ?? 'active',
      createdByPrincipal: entry.createdByPrincipal,
      expiresAt: entry.expiresAt,
      tags: entry.tags ? [...entry.tags] : undefined,
      provenance: entry.provenance ? { ...entry.provenance } : undefined,
      artifact: this.normalizeArtifactMetadata(entry.artifact),
      contentHash: this.computeContentHash(entry.content),
    };

    const nextIndex = this.enforceFileBudget(
      agentId,
      this.enforceEntryCountBudget(agentId, {
        ...index,
        entries: [stored, ...index.entries],
      }),
    );
    this.writeIndex(agentId, nextIndex);
    this.rebuildMarkdown(agentId, nextIndex);

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

  updateEntry(agentId: string, entryId: string, updates: Partial<MemoryEntry>): StoredMemoryEntry {
    if (!this.config.enabled) {
      throw new Error('Persistent memory is not enabled.');
    }
    this.assertWritable();

    const index = this.readIndex(agentId);
    const entryIndex = index.entries.findIndex((entry) => entry.id === entryId);
    if (entryIndex < 0) {
      throw new Error(`Memory entry '${entryId}' was not found.`);
    }

    const current = index.entries[entryIndex]!;
    const nextContent = updates.content ?? current.content;
    if (nextContent.length > this.config.maxEntryChars) {
      throw new Error(`Persistent memory entry exceeds maxEntryChars (${this.config.maxEntryChars}).`);
    }

    const nextEntry: StoredMemoryEntry = {
      ...current,
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      ...(updates.category !== undefined ? { category: updates.category } : {}),
      ...(updates.sourceType !== undefined ? { sourceType: updates.sourceType } : {}),
      ...(updates.trustLevel !== undefined ? { trustLevel: updates.trustLevel } : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.createdByPrincipal !== undefined ? { createdByPrincipal: updates.createdByPrincipal } : {}),
      ...(updates.expiresAt !== undefined ? { expiresAt: updates.expiresAt } : {}),
      ...(updates.tags !== undefined ? { tags: [...updates.tags] } : {}),
      ...(updates.provenance !== undefined ? { provenance: { ...updates.provenance } } : {}),
      summary: updates.summary !== undefined || updates.content !== undefined
        ? this.normalizeSummary(updates.summary ?? current.summary, nextContent)
        : current.summary,
      artifact: this.mergeArtifactMetadata(current.artifact, updates.artifact),
      contentHash: this.computeContentHash(nextContent),
    };

    const nextEntries = [...index.entries];
    nextEntries[entryIndex] = nextEntry;
    const nextIndex = this.enforceFileBudget(
      agentId,
      this.enforceEntryCountBudget(agentId, {
        ...index,
        entries: nextEntries,
      }),
    );
    this.writeIndex(agentId, nextIndex);
    this.rebuildMarkdown(agentId, nextIndex);
    return nextIndex.entries[entryIndex] ?? nextEntry;
  }

  archiveEntry(agentId: string, entryId: string, options?: {
    archivedAt?: string;
    archivedByPrincipal?: string;
    reason?: string;
  }): StoredMemoryEntry {
    const archivedAt = options?.archivedAt?.trim() || new Date().toISOString();
    return this.updateEntry(agentId, entryId, {
      status: 'archived',
      artifact: {
        archivedAt,
        updatedAt: archivedAt,
        updatedByPrincipal: options?.archivedByPrincipal,
        changeReason: options?.reason,
      },
    });
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
        const summary = entry.summary?.toLowerCase() ?? '';
        const title = entry.artifact?.title?.toLowerCase() ?? '';
        const retrievalHints = Array.isArray(entry.artifact?.retrievalHints)
          ? entry.artifact.retrievalHints.join(' ').toLowerCase()
          : '';
        return entry.content.toLowerCase().includes(normalizedQuery)
          || summary.includes(normalizedQuery)
          || category.includes(normalizedQuery)
          || tags.includes(normalizedQuery)
          || title.includes(normalizedQuery)
          || retrievalHints.includes(normalizedQuery);
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
    if (existsSync(this.indexPath(agentId))) {
      return this.readIndex(agentId).entries.length > 0;
    }
    return existsSync(this.filePath(agentId));
  }

  size(agentId: string): number {
    return this.load(agentId).length;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isReadOnly(): boolean {
    return this.config.readOnly;
  }

  getMaxContextChars(): number {
    return this.config.maxContextChars;
  }

  updateConfig(next: Partial<AgentMemoryStoreConfig>): void {
    const merged = { ...this.config, ...next };
    const nextBasePath = merged.basePath ?? join(homedir(), '.guardianagent', 'memory');
    const basePathChanged = nextBasePath !== this.basePath;
    this.config = merged;
    this.basePath = nextBasePath;

    if (this.config.enabled) {
      mkdirSecureSync(this.basePath);
    }

    if (basePathChanged) {
      this.clearCache();
    }
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
      this.config.integrity?.removeFileSync(indexPath, 'memory_index_delete');
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

  private sanitizeHeadingForPrompt(category?: string): string {
    const cleaned = stripInvisibleChars(category?.trim() || 'General').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'General';
    const detection = detectInjection(cleaned);
    return detection.score >= MEMORY_CONTEXT_BLOCK_THRESHOLD ? 'General' : cleaned;
  }

  private renderContextMarkdownResult(
    agentId: string,
    index: MemoryIndexFile,
    options?: MemoryContextLoadOptions,
  ): MemoryContextLoadResult {
    const query = this.normalizeContextQueryInput(options);
    const maxChars = this.resolveContextLimit(options);
    const grouped = new Map<string, Array<{
      entry: StoredMemoryEntry;
      heading: string;
      fullLine: string;
      summaryLine?: string;
      preferSummary: boolean;
      preview: string;
      queryScore: number;
      matchReasons: string[];
    }>>();
    const contextEntries = this.getContextEntries(index, query);
    const entries = this.prepareContextEntries(agentId, contextEntries.entries);

    let output = '';
    let omittedEntries = Math.max(0, contextEntries.candidateEntries - entries.length);
    const selectedEntries: MemoryContextSelectionEntry[] = [];

    for (const prepared of entries) {
      const list = grouped.get(prepared.heading) ?? [];
      list.push(prepared);
      grouped.set(prepared.heading, list);
    }

    for (const [heading, groupedEntries] of grouped.entries()) {
      let headingRendered = false;
      for (const entry of groupedEntries) {
        const prefix = headingRendered
          ? ''
          : `${output ? '\n\n' : ''}## ${heading}\n`;
        const fullChunk = `${prefix}${entry.fullLine}`;
        const summaryChunk = entry.summaryLine ? `${prefix}${entry.summaryLine}` : null;
        const preferSummary = entry.preferSummary;
        if (preferSummary && summaryChunk && output.length + summaryChunk.length <= maxChars) {
          output += summaryChunk;
          headingRendered = true;
          selectedEntries.push(this.buildContextSelectionEntry(entry, 'summary'));
          continue;
        }
        if (output.length + fullChunk.length <= maxChars) {
          output += fullChunk;
          headingRendered = true;
          selectedEntries.push(this.buildContextSelectionEntry(entry, 'full'));
          continue;
        }
        if (summaryChunk && output.length + summaryChunk.length <= maxChars) {
          output += summaryChunk;
          headingRendered = true;
          selectedEntries.push(this.buildContextSelectionEntry(entry, 'summary'));
          continue;
        }
        omittedEntries += 1;
      }
    }

    if (omittedEntries > 0) {
      const note = `${output ? '\n\n' : ''}[... ${omittedEntries} additional memory entr${omittedEntries === 1 ? 'y' : 'ies'} omitted — use memory_recall for full details]`;
      if (output.length + note.length <= maxChars) {
        output += note;
      }
    }

    return {
      content: output,
      candidateEntries: contextEntries.candidateEntries,
      selectedEntries,
      omittedEntries,
      ...(query?.preview ? { queryPreview: query.preview } : {}),
    };
  }

  private resolveContextLimit(options?: MemoryContextLoadOptions): number {
    const requested = options?.maxChars;
    if (typeof requested === 'number' && Number.isFinite(requested)) {
      return Math.max(1, Math.floor(requested));
    }
    return this.config.maxContextChars;
  }

  private prepareContextEntries(
    agentId: string,
    entries: Array<{
      entry: StoredMemoryEntry;
      queryScore: number;
      matchReasons: string[];
      isContextFlush: boolean;
    }>,
  ): Array<{
    entry: StoredMemoryEntry;
    heading: string;
    fullLine: string;
    summaryLine?: string;
    preferSummary: boolean;
    preview: string;
    queryScore: number;
    matchReasons: string[];
  }> {
    const prepared: Array<{
      entry: StoredMemoryEntry;
      heading: string;
      fullLine: string;
      summaryLine?: string;
      preferSummary: boolean;
      preview: string;
      queryScore: number;
      matchReasons: string[];
    }> = [];

    for (const ranked of entries) {
      const { entry } = ranked;
      const renderedContent = this.sanitizeEntryForPrompt(agentId, entry);
      if (!renderedContent) continue;

      const heading = this.sanitizeHeadingForPrompt(entry.category);
      const suffix = `${entry.trustLevel && entry.trustLevel !== 'trusted' ? ` [${entry.trustLevel}]` : ''} _(${entry.createdAt})_`;
      const titledContent = this.renderEntryTextWithTitle(entry, renderedContent);
      const fullLine = `- ${titledContent}${suffix}`;
      const renderedSummary = this.sanitizeSummaryForPrompt(agentId, entry);
      const titledSummary = renderedSummary
        ? this.renderEntryTextWithTitle(entry, renderedSummary)
        : undefined;
      const summaryLine = titledSummary && titledSummary !== titledContent
        ? `- ${titledSummary}${suffix}`
        : undefined;
      const preferSummary = ranked.isContextFlush
        && !ranked.matchReasons.some((reason) =>
          reason.startsWith('focus ')
          || reason.startsWith('tag ')
          || reason.startsWith('id ')
          || reason.startsWith('provenance '));
      prepared.push({
        entry,
        heading,
        fullLine,
        summaryLine,
        preferSummary,
        preview: this.truncateInlineText(titledSummary ?? titledContent, 96),
        queryScore: ranked.queryScore,
        matchReasons: ranked.matchReasons,
      });
    }

    return prepared;
  }

  private buildContextSelectionEntry(
    prepared: {
      entry: StoredMemoryEntry;
      heading: string;
      preview: string;
      queryScore: number;
      matchReasons: string[];
    },
    renderMode: 'full' | 'summary',
  ): MemoryContextSelectionEntry {
    return {
      id: prepared.entry.id,
      category: prepared.heading,
      createdAt: prepared.entry.createdAt,
      preview: prepared.preview,
      renderMode,
      queryScore: prepared.queryScore,
      sourceClass: classifyMemoryEntrySource(prepared.entry),
      sourceType: prepared.entry.sourceType,
      trustLevel: prepared.entry.trustLevel,
      isContextFlush: prepared.entry.tags?.includes(MEMORY_CONTEXT_FLUSH_TAG) ?? false,
      ...(prepared.matchReasons.length > 0 ? { matchReasons: prepared.matchReasons.slice(0, 3) } : {}),
    };
  }

  private sanitizeSummaryForPrompt(agentId: string, entry: StoredMemoryEntry): string | null {
    const rawSummary = entry.summary?.trim();
    if (!rawSummary) {
      return null;
    }
    const cleaned = this.normalizeInlineText(rawSummary);
    if (!cleaned) {
      return null;
    }
    const detection = detectInjection(cleaned);
    if (detection.score >= MEMORY_CONTEXT_BLOCK_THRESHOLD) {
      this.emitSecurityEvent({
        severity: 'warn',
        code: 'memory_context_summary_blocked',
        message: 'Blocked suspicious memory summary from prompt context.',
        details: {
          agentId,
          entryId: entry.id,
          category: entry.category,
          score: detection.score,
          signals: detection.signals,
        },
      });
      return null;
    }
    return cleaned;
  }

  private sanitizeEntryForPrompt(agentId: string, entry: StoredMemoryEntry): string | null {
    const cleaned = stripInvisibleChars(entry.content).trim();
    if (!cleaned) return null;
    const detection = detectInjection(cleaned);
    if (detection.score >= MEMORY_CONTEXT_BLOCK_THRESHOLD) {
      this.emitSecurityEvent({
        severity: 'warn',
        code: 'memory_context_entry_blocked',
        message: 'Blocked suspicious memory entry from prompt context.',
        details: {
          agentId,
          entryId: entry.id,
          category: entry.category,
          score: detection.score,
          signals: detection.signals,
        },
      });
      return null;
    }
    return cleaned;
  }

  private getContextEntries(index: MemoryIndexFile, query: NormalizedMemoryContextQuery | null): {
    entries: Array<{
      entry: StoredMemoryEntry;
      queryScore: number;
      matchReasons: string[];
      isContextFlush: boolean;
    }>;
    candidateEntries: number;
  } {
    const ranked = index.entries
      .filter((entry) => entry.status === 'active')
      .map((entry) => {
        const match = this.scoreContextEntry(entry, query);
        return {
          entry,
          queryScore: match.score,
          matchReasons: match.reasons,
          isContextFlush: entry.tags?.includes(MEMORY_CONTEXT_FLUSH_TAG) ?? false,
        };
      })
      .sort((left, right) => {
        if (left.queryScore !== right.queryScore) {
          return right.queryScore - left.queryScore;
        }
        if (left.isContextFlush !== right.isContextFlush) {
          return left.isContextFlush ? 1 : -1;
        }
        const sourcePriorityDelta = memorySourceClassPriority(classifyMemoryEntrySource(right.entry))
          - memorySourceClassPriority(classifyMemoryEntrySource(left.entry));
        if (sourcePriorityDelta !== 0) {
          return sourcePriorityDelta;
        }
        const createdAtDelta = right.entry.createdAt.localeCompare(left.entry.createdAt);
        if (createdAtDelta !== 0) return createdAtDelta;
        return right.entry.id.localeCompare(left.entry.id);
      });
    const candidateEntries = ranked.length;
    const limit = query ? MAX_QUERY_CONTEXT_CANDIDATES : MAX_CONTEXT_CANDIDATES;
    return {
      entries: ranked.slice(0, limit),
      candidateEntries,
    };
  }

  private scoreContextEntry(
    entry: StoredMemoryEntry,
    query: NormalizedMemoryContextQuery | null,
  ): { score: number; reasons: string[] } {
    if (!query) return { score: 0, reasons: [] };

    const content = entry.content.toLowerCase();
    const summary = entry.summary?.toLowerCase() ?? '';
    const category = `${entry.category?.toLowerCase() ?? ''}\n${entry.artifact?.title?.toLowerCase() ?? ''}`.trim();
    const entryTags = this.normalizeSignalList(entry.tags);
    const retrievalHints = this.normalizeSignalList(entry.artifact?.retrievalHints);
    const tags = [...entryTags, ...retrievalHints].join(' ');
    const provenanceIdentifiers = this.normalizeSignalList([
      entry.provenance?.sessionId,
      entry.provenance?.requestId,
      entry.provenance?.toolName,
      entry.provenance?.domain,
    ]);

    let score = 0;
    const reasons: string[] = [];
    const pushReason = (reason: string) => {
      if (!reason || reasons.includes(reason) || reasons.length >= 3) return;
      reasons.push(reason);
    };
    const addPhraseScore = (label: string, phrase: string, weights: {
      summary: number;
      content: number;
      category?: number;
      tags?: number;
    }) => {
      if (!phrase) return;
      if (summary.includes(phrase)) {
        score += weights.summary;
        pushReason(`${label} summary`);
      }
      if (content.includes(phrase)) {
        score += weights.content;
        pushReason(`${label} content`);
      }
      if (weights.category && category.includes(phrase)) {
        score += weights.category;
        pushReason(`${label} category`);
      }
      if (weights.tags && tags.includes(phrase)) {
        score += weights.tags;
        pushReason(`${label} tag`);
      }
    };

    if (query.fullText) {
      addPhraseScore('query', query.fullText, {
        summary: 220,
        content: 180,
        category: 120,
        tags: 90,
      });
      if (summary.startsWith(query.fullText)) {
        score += 40;
        pushReason('query summary prefix');
      }
      if (content.startsWith(query.fullText)) {
        score += 25;
        pushReason('query content prefix');
      }
    }

    for (const focusText of query.focusTexts) {
      addPhraseScore('focus', focusText, {
        summary: 120,
        content: 90,
        category: 55,
      });
    }

    for (const tag of query.tags) {
      if (entryTags.includes(tag)) {
        score += 150;
        pushReason(`tag ${tag}`);
      } else if (tags.includes(tag)) {
        score += 60;
        pushReason(`tag text ${tag}`);
      }
    }

    for (const hint of query.categoryHints) {
      if (category.includes(hint)) {
        score += 130;
        pushReason(`category ${hint}`);
      }
    }

    for (const identifier of query.identifiers) {
      if (provenanceIdentifiers.includes(identifier)) {
        score += 180;
        pushReason(`provenance ${this.truncateInlineText(identifier, 24)}`);
      } else {
        if (summary.includes(identifier)) {
          score += 120;
          pushReason(`id ${this.truncateInlineText(identifier, 24)}`);
        }
        if (content.includes(identifier)) {
          score += 100;
          pushReason(`id ${this.truncateInlineText(identifier, 24)}`);
        }
        if (tags.includes(identifier)) {
          score += 90;
          pushReason(`id tag ${this.truncateInlineText(identifier, 24)}`);
        }
      }
    }

    let matchedSummaryTerms = 0;
    let matchedContentTerms = 0;
    let matchedCategoryTerms = 0;
    let matchedTagTerms = 0;
    let matchedProvenanceTerms = 0;
    for (const term of query.terms) {
      if (summary.includes(term)) {
        score += 24;
        matchedSummaryTerms += 1;
      }
      if (content.includes(term)) {
        score += 18;
        matchedContentTerms += 1;
      }
      if (category.includes(term)) {
        score += 10;
        matchedCategoryTerms += 1;
      }
      if (tags.includes(term)) {
        score += 8;
        matchedTagTerms += 1;
      }
      if (provenanceIdentifiers.some((value) => value.includes(term))) {
        score += 12;
        matchedProvenanceTerms += 1;
      }
    }

    if (matchedSummaryTerms > 0) pushReason(`summary terms ${matchedSummaryTerms}`);
    if (matchedContentTerms > 0) pushReason(`content terms ${matchedContentTerms}`);
    if (matchedCategoryTerms > 0) pushReason(`category terms ${matchedCategoryTerms}`);
    if (matchedTagTerms > 0) pushReason(`tag terms ${matchedTagTerms}`);
    if (matchedProvenanceTerms > 0) pushReason(`provenance terms ${matchedProvenanceTerms}`);

    const isContextFlush = entry.tags?.includes(MEMORY_CONTEXT_FLUSH_TAG) ?? false;
    const exactSignalMatched = query.tags.some((tag) => entryTags.includes(tag))
      || query.identifiers.some((identifier) => provenanceIdentifiers.includes(identifier) || content.includes(identifier) || summary.includes(identifier));
    if (isContextFlush && score > 0 && !exactSignalMatched) {
      score = Math.max(0, score - 18);
    }

    switch (classifyMemoryEntrySource(entry)) {
      case 'operator_curated':
        score += 60;
        break;
      case 'canonical':
        score += 8;
        break;
      case 'linked_output':
        if (!exactSignalMatched) {
          score = Math.max(0, score - 18);
        }
        break;
      case 'derived':
        score = Math.max(0, score - (isContextFlush ? 24 : 12));
        break;
    }

    return { score, reasons };
  }
}
