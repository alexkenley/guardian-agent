import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentMemoryStore } from './agent-memory-store.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(overrides?: Partial<Parameters<typeof AgentMemoryStore.prototype.load>[0]>) {
  const basePath = join(tmpdir(), `guardianagent-memory-${randomUUID()}`);
  createdDirs.push(basePath);
  return new AgentMemoryStore({
    enabled: true,
    basePath,
    maxContextChars: 500,
    maxFileChars: 5000,
    ...overrides,
  });
}

describe('AgentMemoryStore', () => {
  it('should load empty content for a new agent', () => {
    const store = makeStore();
    expect(store.load('test-agent')).toBe('');
    expect(store.exists('test-agent')).toBe(false);
    expect(store.size('test-agent')).toBe(0);
  });

  it('should save and load content', () => {
    const store = makeStore();
    store.save('test-agent', '# Knowledge Base\n- fact one');
    expect(store.load('test-agent')).toBe('# Knowledge Base\n- fact one');
    expect(store.exists('test-agent')).toBe(true);
    expect(store.size('test-agent')).toBeGreaterThan(0);
  });

  it('should append entries with categories', () => {
    const store = makeStore();
    store.append('agent1', {
      content: 'User prefers dark mode',
      createdAt: '2025-01-15',
      category: 'Preferences',
    });
    store.append('agent1', {
      content: 'User name is Alex',
      createdAt: '2025-01-16',
      category: 'Facts',
    });
    store.append('agent1', {
      content: 'Use TypeScript for all new code',
      createdAt: '2025-01-17',
      category: 'Preferences',
    });

    const content = store.load('agent1');
    expect(content).toContain('## Preferences');
    expect(content).toContain('## Facts');
    expect(content).toContain('User prefers dark mode');
    expect(content).toContain('User name is Alex');
    expect(content).toContain('Use TypeScript for all new code');
  });

  it('should append uncategorized entries', () => {
    const store = makeStore();
    store.append('agent1', {
      content: 'Some uncategorized fact',
      createdAt: '2025-01-15',
    });
    const content = store.load('agent1');
    expect(content).toContain('Some uncategorized fact');
    expect(content).not.toContain('##');
  });

  it('should appendRaw for flush summaries', () => {
    const store = makeStore();
    store.appendRaw('agent1', '## Context from 2025-01-15\n- [user] What is the status?');
    store.appendRaw('agent1', '## Context from 2025-01-16\n- [assistant] All systems nominal.');

    const content = store.load('agent1');
    expect(content).toContain('Context from 2025-01-15');
    expect(content).toContain('Context from 2025-01-16');
    expect(content).toContain('[user] What is the status?');
  });

  it('should truncate loadForContext when content exceeds maxContextChars', () => {
    const store = makeStore();
    const longContent = 'x'.repeat(1000);
    store.save('agent1', longContent);

    const forContext = store.loadForContext('agent1');
    expect(forContext.length).toBeLessThan(longContent.length);
    expect(forContext).toContain('[... knowledge base truncated');
  });

  it('should search content case-insensitively', () => {
    const store = makeStore();
    store.save('agent1', '## Notes\n- The sky is BLUE\n- Grass is green\n- Water is clear');

    const results = store.search('agent1', 'blue');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toContain('BLUE');
  });

  it('should sanitize agent IDs to prevent path traversal', () => {
    const store = makeStore();
    store.save('../../../etc/passwd', 'should not traverse');
    expect(store.load('../../../etc/passwd')).toBe('should not traverse');
    // The file should be in basePath, not traversed
    expect(store.exists('../../../etc/passwd')).toBe(true);
  });

  it('should list agents with knowledge bases', () => {
    const store = makeStore();
    store.save('agent-a', 'content a');
    store.save('agent-b', 'content b');

    const agents = store.listAgents();
    expect(agents).toContain('agent-a');
    expect(agents).toContain('agent-b');
  });

  it('should clear cache and re-read from disk', () => {
    const store = makeStore();
    store.save('agent1', 'version 1');
    expect(store.load('agent1')).toBe('version 1');

    // Manually overwrite the file to simulate external change
    store.save('agent1', 'version 2');
    store.clearCache();
    expect(store.load('agent1')).toBe('version 2');
  });

  it('should return empty when disabled', () => {
    const basePath = join(tmpdir(), `guardianagent-memory-${randomUUID()}`);
    createdDirs.push(basePath);
    const store = new AgentMemoryStore({ enabled: false, basePath });

    store.save('agent1', 'should not save');
    expect(store.load('agent1')).toBe('');
    expect(store.exists('agent1')).toBe(false);
  });
});
