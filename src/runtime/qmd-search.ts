/**
 * QMD hybrid search service.
 *
 * Wraps the QMD CLI (https://github.com/tobi/qmd) to provide BM25 + vector + LLM
 * re-ranked search over user-defined document collections. Each configured source
 * maps to a QMD collection. All operations use subprocess invocations — no long-running
 * server process to manage.
 */

import type { QMDConfig, QMDSourceConfig } from '../config/types.js';
import { sandboxedExec, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// ─── Types ─────────────────────────────────────────────

export type QMDSearchMode = 'search' | 'vsearch' | 'query';

export interface QMDSearchOptions {
  query: string;
  mode?: QMDSearchMode;
  collection?: string;
  limit?: number;
  includeBody?: boolean;
}

export interface QMDSearchResult {
  score: number;
  filepath: string;
  title: string;
  context: string;
  hash: string;
  docid: string;
  collectionName: string;
  body?: string;
}

export interface QMDSearchResponse {
  results: QMDSearchResult[];
  query: string;
  mode: QMDSearchMode;
  collection?: string;
  totalResults: number;
  durationMs: number;
}

export interface QMDCollectionInfo {
  name: string;
  documentCount?: number;
  path?: string;
}

export interface QMDStatusResponse {
  installed: boolean;
  version?: string;
  collections: QMDCollectionInfo[];
  configuredSources: Array<{ id: string; name: string; type: string; path: string; enabled: boolean }>;
}

// ─── Service ───────────────────────────────────────────

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB
const VALID_MODES: QMDSearchMode[] = ['search', 'vsearch', 'query'];

export class QMDSearchService {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly defaultMode: QMDSearchMode;
  private readonly maxResults: number;
  private sources: QMDSourceConfig[];
  private readonly sandboxConfig: SandboxConfig;

  /** Cached install check result (null = not checked yet). */
  private installCache: { installed: boolean; version?: string } | null = null;

  constructor(config: QMDConfig, sandboxConfig?: SandboxConfig) {
    this.binary = config.binaryPath ?? resolveBundledQmdBinary() ?? 'qmd';
    this.timeoutMs = config.queryTimeoutMs ?? 30_000;
    this.defaultMode = config.defaultMode ?? 'query';
    this.maxResults = config.maxResults ?? 20;
    this.sources = [...config.sources];
    this.sandboxConfig = sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
  }

  // ── Install detection ──────────────────────────────

  /** Check if QMD binary is available. Caches result after first call. */
  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    if (this.installCache) return this.installCache;
    try {
      const { stdout } = await this.execArgs(['--version']);
      const version = stdout.trim() || undefined;
      this.installCache = { installed: true, version };
    } catch {
      this.installCache = { installed: false };
    }
    return this.installCache;
  }

  /** Clear install cache (useful after PATH changes). */
  clearInstallCache(): void {
    this.installCache = null;
  }

  // ── Search ─────────────────────────────────────────

  /** Run a QMD search across indexed collections. */
  async search(options: QMDSearchOptions): Promise<QMDSearchResponse> {
    await this.ensureInstalled();

    const mode = options.mode && VALID_MODES.includes(options.mode) ? options.mode : this.defaultMode;
    const limit = Math.min(Math.max(options.limit ?? this.maxResults, 1), 100);
    const query = options.query.trim();
    if (!query) throw new Error('Search query is required.');

    const args: string[] = [mode, JSON.stringify(query), '--json', '--limit', String(limit)];
    if (options.collection) {
      args.push('--collection', options.collection);
    }

    const start = Date.now();
    const { stdout } = await this.execArgs(args);
    const durationMs = Date.now() - start;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`QMD returned invalid JSON: ${stdout.slice(0, 200)}`);
    }

    const rawResults = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).results ?? [];
    const results: QMDSearchResult[] = (rawResults as Record<string, unknown>[]).map((r) => ({
      score: Number(r.score ?? 0),
      filepath: String(r.filepath ?? r.file ?? ''),
      title: String(r.title ?? ''),
      context: String(r.context ?? r.snippet ?? ''),
      hash: String(r.hash ?? ''),
      docid: String(r.docid ?? r.id ?? ''),
      collectionName: String(r.collection_name ?? r.collection ?? options.collection ?? ''),
      ...(options.includeBody && r.body ? { body: String(r.body) } : {}),
    }));

    return {
      results,
      query,
      mode,
      collection: options.collection,
      totalResults: results.length,
      durationMs,
    };
  }

  // ── Status ─────────────────────────────────────────

  /** Get QMD install status and collection info. */
  async status(): Promise<QMDStatusResponse> {
    const install = await this.checkInstalled();
    const configuredSources = this.sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      path: s.path,
      enabled: s.enabled,
    }));

    if (!install.installed) {
      return { installed: false, collections: [], configuredSources };
    }

    let collections: QMDCollectionInfo[] = [];
    try {
      const { stdout } = await this.execArgs(['collections', '--json']);
      const parsed = JSON.parse(stdout);
      const raw = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).collections ?? [];
      collections = (raw as Record<string, unknown>[]).map((c) => ({
        name: String(c.name ?? ''),
        documentCount: c.document_count != null ? Number(c.document_count) : undefined,
        path: c.path ? String(c.path) : undefined,
      }));
    } catch {
      // Collections listing failed — non-fatal
    }

    return {
      installed: true,
      version: install.version,
      collections,
      configuredSources,
    };
  }

  // ── Source CRUD ─────────────────────────────────────

  /** Get all configured sources. */
  getSources(): QMDSourceConfig[] {
    return [...this.sources];
  }

  /** Add a new document source. */
  addSource(source: QMDSourceConfig): void {
    if (this.sources.some((s) => s.id === source.id)) {
      throw new Error(`Source with id '${source.id}' already exists.`);
    }
    this.sources.push({ ...source });
  }

  /** Remove a source by id. */
  removeSource(id: string): boolean {
    const idx = this.sources.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.sources.splice(idx, 1);
    return true;
  }

  /** Toggle a source enabled/disabled. */
  toggleSource(id: string, enabled: boolean): boolean {
    const source = this.sources.find((s) => s.id === id);
    if (!source) return false;
    source.enabled = enabled;
    return true;
  }

  // ── Collection sync ────────────────────────────────

  /** Register configured sources as QMD collections. */
  async syncSources(): Promise<{ synced: string[]; errors: Array<{ id: string; error: string }> }> {
    await this.ensureInstalled();

    const synced: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const source of this.sources) {
      if (!source.enabled) continue;
      try {
        const args = this.buildCollectionAddArgs(source);
        await this.execArgs(args);
        synced.push(source.id);
      } catch (err) {
        errors.push({ id: source.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { synced, errors };
  }

  /** Build CLI args for `qmd collection add` based on source type. */
  private buildCollectionAddArgs(source: QMDSourceConfig): string[] {
    const args = ['collection', 'add', source.id, source.path];

    // Add globs for directory/git sources
    if ((source.type === 'directory' || source.type === 'git') && source.globs?.length) {
      for (const glob of source.globs) {
        args.push('--glob', glob);
      }
    }

    // Add branch for git sources
    if (source.type === 'git' && source.branch) {
      args.push('--branch', source.branch);
    }

    return args;
  }

  // ── Reindex ────────────────────────────────────────

  /** Trigger vector embedding reindex for one or all collections. */
  async reindex(collectionId?: string): Promise<{ success: boolean; message: string }> {
    await this.ensureInstalled();

    const args = ['embed'];
    if (collectionId) {
      args.push('--collection', collectionId);
    }

    try {
      await this.execArgs(args, this.timeoutMs * 3);
      return { success: true, message: collectionId ? `Reindexed collection '${collectionId}'.` : 'Reindexed all collections.' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Helpers ────────────────────────────────────────

  private async ensureInstalled(): Promise<void> {
    const { installed } = await this.checkInstalled();
    if (!installed) {
      throw new Error(
        'QMD is not available. Install app dependencies to get bundled QMD (@tobilu/qmd), or set assistant.tools.qmd.binaryPath to a valid qmd binary.',
      );
    }
  }

  private async execArgs(args: string[], timeout?: number): Promise<{ stdout: string; stderr: string }> {
    const command = [this.binary, ...args].map(shellQuote).join(' ');
    return this.exec(command, timeout);
  }

  private async exec(command: string, timeout?: number): Promise<{ stdout: string; stderr: string }> {
    return sandboxedExec(command, this.sandboxConfig, {
      profile: 'read-only',
      timeout: timeout ?? this.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  }
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    if (value === '') return '""';
    if (/^[a-zA-Z0-9_\\\-/.:=@]+$/.test(value)) return value;
    // cmd.exe quoting
    return `"${value.replace(/"/g, '""')}"`;
  }

  if (value === '') return "''";
  if (/^[a-zA-Z0-9_\-/.:=@]+$/.test(value)) return value;
  // POSIX shell quoting
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveBundledQmdBinary(): string | undefined {
  const exeName = process.platform === 'win32' ? 'qmd.cmd' : 'qmd';
  const require = createRequire(import.meta.url);

  try {
    const pkgPath = require.resolve('@tobilu/qmd/package.json');
    const pkgDir = dirname(pkgPath);
    const binShim = join(pkgDir, '..', '..', '.bin', exeName);
    if (existsSync(binShim)) {
      return binShim;
    }
    const packageBin = join(pkgDir, 'qmd');
    if (existsSync(packageBin)) {
      return packageBin;
    }
  } catch {
    // optional dependency is not installed
  }

  return undefined;
}
