import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QMDSearchService } from './qmd-search.js';
import type { QMDConfig, QMDSourceConfig } from '../config/types.js';

// Mock child_process.exec (preserve other exports like execFile for sandbox/index.ts)
const mockExec = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (...args: unknown[]) => mockExec(...args),
  };
});

function makeConfig(overrides?: Partial<QMDConfig>): QMDConfig {
  return {
    enabled: true,
    sources: [],
    ...overrides,
  };
}

function makeSource(overrides?: Partial<QMDSourceConfig>): QMDSourceConfig {
  return {
    id: 'notes',
    name: 'My Notes',
    type: 'directory',
    path: '/home/user/notes',
    globs: ['**/*.md'],
    enabled: true,
    ...overrides,
  };
}

/** Simulate exec returning stdout. */
function mockExecSuccess(stdout: string, stderr = '') {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (typeof cb === 'function') {
      cb(null, { stdout, stderr });
    }
    // promisify wraps with callback, but the real behavior goes through the callback
  });
  // Since we use promisify(exec), we need to handle callback style
  mockExec.mockImplementation((cmd: string, opts: unknown) => {
    // Return value that promisify expects — exec with callback
    const child = {
      stdout: null,
      stderr: null,
      on: vi.fn(),
      removeListener: vi.fn(),
      kill: vi.fn(),
    };
    // promisify of exec — it actually returns a ChildProcess and calls the callback
    // Let's just mock it to return a promise-like
    return undefined; // will be handled by the callback
  });
}

/**
 * Helper: mock exec to resolve with given stdout via the callback pattern.
 * node:child_process.exec uses (cmd, opts, callback) and promisify converts it.
 */
function setupExecMock(results: Map<string, { stdout: string; stderr?: string }> | string) {
  mockExec.mockImplementation((cmd: string, opts: unknown, callback?: Function) => {
    const cb = typeof opts === 'function' ? opts : callback;
    let result: { stdout: string; stderr: string };

    if (typeof results === 'string') {
      result = { stdout: results, stderr: '' };
    } else {
      // Find matching key
      const key = [...results.keys()].find((k) => cmd.includes(k));
      if (key) {
        const r = results.get(key)!;
        result = { stdout: r.stdout, stderr: r.stderr ?? '' };
      } else {
        if (cb) cb(new Error(`Command not found: ${cmd}`));
        return;
      }
    }

    if (cb) cb(null, result);
  });
}

function setupExecError(error: Error | string) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    if (cb) cb(typeof error === 'string' ? new Error(error) : error);
  });
}

describe('QMDSearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkInstalled', () => {
    it('detects installed QMD', async () => {
      setupExecMock('qmd version 0.5.0');
      const svc = new QMDSearchService(makeConfig());
      const result = await svc.checkInstalled();
      expect(result.installed).toBe(true);
      expect(result.version).toBe('qmd version 0.5.0');
    });

    it('detects missing QMD', async () => {
      setupExecError('command not found: qmd');
      const svc = new QMDSearchService(makeConfig());
      const result = await svc.checkInstalled();
      expect(result.installed).toBe(false);
      expect(result.version).toBeUndefined();
    });

    it('caches install check result', async () => {
      setupExecMock('0.5.0');
      const svc = new QMDSearchService(makeConfig());
      await svc.checkInstalled();
      await svc.checkInstalled();
      // Only called once due to caching
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('clearInstallCache resets cache', async () => {
      setupExecMock('0.5.0');
      const svc = new QMDSearchService(makeConfig());
      await svc.checkInstalled();
      svc.clearInstallCache();
      await svc.checkInstalled();
      expect(mockExec).toHaveBeenCalledTimes(2);
    });
  });

  describe('search', () => {
    it('runs search with default mode', async () => {
      const searchResults = [
        { score: 0.95, filepath: '/notes/a.md', title: 'Note A', context: 'snippet', hash: 'abc', docid: '1', collection_name: 'notes' },
      ];
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['query', { stdout: JSON.stringify(searchResults) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.search({ query: 'test query' });

      expect(result.mode).toBe('query');
      expect(result.totalResults).toBe(1);
      expect(result.results[0].filepath).toBe('/notes/a.md');
      expect(result.results[0].score).toBe(0.95);
    });

    it('uses specified mode and collection', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['vsearch', { stdout: JSON.stringify([]) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.search({ query: 'test', mode: 'vsearch', collection: 'docs' });

      expect(result.mode).toBe('vsearch');
      expect(result.collection).toBe('docs');
      // Verify collection flag was passed
      const searchCall = mockExec.mock.calls.find((c: unknown[]) => String(c[0]).includes('vsearch'));
      expect(searchCall).toBeTruthy();
      expect(String(searchCall![0])).toContain('--collection');
      expect(String(searchCall![0])).toContain('docs');
    });

    it('clamps limit to valid range', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['query', { stdout: JSON.stringify([]) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({ maxResults: 20 }));
      await svc.search({ query: 'test', limit: 500 });

      const searchCall = mockExec.mock.calls.find((c: unknown[]) => String(c[0]).includes('query'));
      expect(String(searchCall![0])).toContain('--limit 100');
    });

    it('rejects empty query', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      await expect(svc.search({ query: '  ' })).rejects.toThrow('Search query is required');
    });

    it('throws when QMD not installed', async () => {
      setupExecError('not found');
      const svc = new QMDSearchService(makeConfig());
      await expect(svc.search({ query: 'test' })).rejects.toThrow('QMD is not available');
    });

    it('throws on invalid JSON output', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['query', { stdout: 'not json' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      await expect(svc.search({ query: 'test' })).rejects.toThrow('invalid JSON');
    });

    it('handles results wrapped in object with results key', async () => {
      const wrapped = { results: [{ score: 0.8, filepath: '/a.md', title: 'A', context: 'ctx', hash: 'h', docid: 'd', collection_name: 'c' }], total: 1 };
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['query', { stdout: JSON.stringify(wrapped) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.search({ query: 'test' });
      expect(result.totalResults).toBe(1);
    });
  });

  describe('status', () => {
    it('returns not-installed status', async () => {
      setupExecError('not found');
      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      const st = await svc.status();

      expect(st.installed).toBe(false);
      expect(st.collections).toEqual([]);
      expect(st.configuredSources).toHaveLength(1);
      expect(st.configuredSources[0].id).toBe('notes');
    });

    it('returns installed status with collections', async () => {
      const collections = [{ name: 'notes', document_count: 42, path: '/data/notes' }];
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['collections', { stdout: JSON.stringify(collections) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      const st = await svc.status();

      expect(st.installed).toBe(true);
      expect(st.version).toBe('0.5.0');
      expect(st.collections).toHaveLength(1);
      expect(st.collections[0].documentCount).toBe(42);
    });
  });

  describe('source CRUD', () => {
    it('getSources returns copy of sources', () => {
      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      const sources = svc.getSources();
      expect(sources).toHaveLength(1);
      sources.push(makeSource({ id: 'other' }));
      expect(svc.getSources()).toHaveLength(1);
    });

    it('addSource adds a new source', () => {
      const svc = new QMDSearchService(makeConfig());
      svc.addSource(makeSource());
      expect(svc.getSources()).toHaveLength(1);
    });

    it('addSource rejects duplicate id', () => {
      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      expect(() => svc.addSource(makeSource())).toThrow("already exists");
    });

    it('removeSource removes by id', () => {
      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      expect(svc.removeSource('notes')).toBe(true);
      expect(svc.getSources()).toHaveLength(0);
    });

    it('removeSource returns false for missing id', () => {
      const svc = new QMDSearchService(makeConfig());
      expect(svc.removeSource('nope')).toBe(false);
    });

    it('toggleSource changes enabled state', () => {
      const svc = new QMDSearchService(makeConfig({ sources: [makeSource()] }));
      svc.toggleSource('notes', false);
      expect(svc.getSources()[0].enabled).toBe(false);
    });

    it('toggleSource returns false for missing id', () => {
      const svc = new QMDSearchService(makeConfig());
      expect(svc.toggleSource('nope', true)).toBe(false);
    });
  });

  describe('syncSources', () => {
    it('syncs enabled sources', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['collection add', { stdout: 'ok' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({
        sources: [
          makeSource(),
          makeSource({ id: 'disabled', name: 'Disabled', enabled: false }),
        ],
      }));

      const result = await svc.syncSources();
      expect(result.synced).toEqual(['notes']);
      expect(result.errors).toHaveLength(0);

      // Should only call collection add for the enabled source
      const addCalls = mockExec.mock.calls.filter((c: unknown[]) => String(c[0]).includes('collection add'));
      expect(addCalls).toHaveLength(1);
      expect(String(addCalls[0][0])).toContain('notes');
    });

    it('passes globs for directory sources', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['collection add', { stdout: 'ok' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({
        sources: [makeSource({ globs: ['**/*.md', '**/*.txt'] })],
      }));

      await svc.syncSources();
      const addCall = mockExec.mock.calls.find((c: unknown[]) => String(c[0]).includes('collection add'));
      expect(String(addCall![0])).toContain('--glob');
      expect(String(addCall![0])).toContain('**/*.md');
    });

    it('passes branch for git sources', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['collection add', { stdout: 'ok' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({
        sources: [makeSource({ id: 'repo', type: 'git', path: 'https://github.com/org/repo', branch: 'main' })],
      }));

      await svc.syncSources();
      const addCall = mockExec.mock.calls.find((c: unknown[]) => String(c[0]).includes('collection add'));
      expect(String(addCall![0])).toContain('--branch');
      expect(String(addCall![0])).toContain('main');
    });

    it('collects errors for failing sources', async () => {
      let callCount = 0;
      mockExec.mockImplementation((cmd: string, opts: unknown, callback?: Function) => {
        const cb = typeof opts === 'function' ? opts : callback;
        if (String(cmd).includes('--version')) {
          cb?.(null, { stdout: '0.5.0', stderr: '' });
        } else if (String(cmd).includes('collection add')) {
          callCount++;
          if (callCount === 1) {
            cb?.(null, { stdout: 'ok', stderr: '' });
          } else {
            cb?.(new Error('permission denied'));
          }
        }
      });

      const svc = new QMDSearchService(makeConfig({
        sources: [
          makeSource({ id: 'ok-src' }),
          makeSource({ id: 'bad-src', path: '/root/secret' }),
        ],
      }));

      const result = await svc.syncSources();
      expect(result.synced).toEqual(['ok-src']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].id).toBe('bad-src');
    });
  });

  describe('reindex', () => {
    it('reindexes all collections', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['embed', { stdout: 'done' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.reindex();
      expect(result.success).toBe(true);
      expect(result.message).toContain('all collections');
    });

    it('reindexes specific collection', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['embed', { stdout: 'done' }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.reindex('notes');
      expect(result.success).toBe(true);

      const embedCall = mockExec.mock.calls.find((c: unknown[]) => String(c[0]).includes('embed'));
      expect(String(embedCall![0])).toContain('--collection');
      expect(String(embedCall![0])).toContain('notes');
    });

    it('returns failure on error', async () => {
      let called = false;
      mockExec.mockImplementation((cmd: string, opts: unknown, callback?: Function) => {
        const cb = typeof opts === 'function' ? opts : callback;
        if (String(cmd).includes('--version')) {
          cb?.(null, { stdout: '0.5.0', stderr: '' });
        } else {
          cb?.(new Error('embedding model not available'));
        }
      });

      const svc = new QMDSearchService(makeConfig());
      const result = await svc.reindex();
      expect(result.success).toBe(false);
      expect(result.message).toContain('embedding model');
    });
  });

  describe('config', () => {
    it('uses custom binary path', async () => {
      setupExecMock('0.5.0');
      const svc = new QMDSearchService(makeConfig({ binaryPath: '/usr/local/bin/qmd' }));
      await svc.checkInstalled();

      expect(mockExec.mock.calls[0][0]).toContain('/usr/local/bin/qmd');
    });

    it('uses default mode from config', async () => {
      const responses = new Map([
        ['--version', { stdout: '0.5.0' }],
        ['search', { stdout: JSON.stringify([]) }],
      ]);
      setupExecMock(responses);

      const svc = new QMDSearchService(makeConfig({ defaultMode: 'search' }));
      const result = await svc.search({ query: 'test' });
      expect(result.mode).toBe('search');
    });
  });
});
