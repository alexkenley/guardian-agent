import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeSessionStore } from './code-sessions.js';

const testDirs: string[] = [];

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = join(tmpdir(), `guardianagent-code-session-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(root, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodeSessionStore', () => {
  it('creates sessions with a workspace profile', () => {
    const workspaceRoot = createWorkspace('node-app', {
      'README.md': '# Test App\n\nA sample React app.',
      'package.json': JSON.stringify({
        name: 'test-app',
        description: 'A sample React app.',
        dependencies: {
          react: '^18.0.0',
          next: '^14.0.0',
        },
      }),
      'src/index.tsx': 'export const app = true;\n',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(workspaceRoot, '.guardianagent', 'code-sessions.sqlite'),
    });

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Test Session',
      workspaceRoot,
    });

    expect(session.workState.workspaceProfile?.repoName).toBe('test-app');
    expect(session.workState.workspaceProfile?.stack).toContain('React');
    expect(session.workState.workspaceProfile?.summary).toContain('test-app');
    expect(session.workState.workspaceProfile?.inspectedFiles).toContain('README.md');
  });

  it('refreshes the workspace profile when the session root changes', () => {
    const firstRoot = createWorkspace('first', {
      'package.json': JSON.stringify({ name: 'first-app' }),
    });
    const secondRoot = createWorkspace('second', {
      'pyproject.toml': '[project]\nname = "second-app"\ndescription = "Python app"\n',
      'README.md': '# Second App\n\nPython automation worker.\n',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(firstRoot, '.guardianagent', 'code-sessions.sqlite'),
    });

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Workspace Switch',
      workspaceRoot: firstRoot,
    });
    const updated = store.updateSession({
      sessionId: session.id,
      ownerUserId: 'owner',
      workspaceRoot: secondRoot,
    });

    expect(updated?.workState.workspaceProfile?.repoName).toBe('second-app');
    expect(updated?.workState.workspaceProfile?.stack).toContain('Python');
    expect(updated?.resolvedRoot).toBe(secondRoot);
  });

  it('normalizes Windows and WSL-style workspace roots to the current host format', () => {
    const seedRoot = createWorkspace('normalize-host-path', {
      'package.json': JSON.stringify({ name: 'normalize-host-path' }),
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(seedRoot, '.guardianagent', 'code-sessions.sqlite'),
    });
    const rawWorkspaceRoot = process.platform === 'win32'
      ? '/mnt/s/Development/TestApp'
      : 'S:\\Development\\TestApp';
    const expectedResolvedRoot = process.platform === 'win32'
      ? 'S:\\Development\\TestApp'
      : '/mnt/s/Development/TestApp';

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Normalize Host Path',
      workspaceRoot: rawWorkspaceRoot,
    });

    expect(session.resolvedRoot).toBe(expectedResolvedRoot);
  });

  it('derives a workspace profile for older sessions that do not have one persisted', () => {
    const workspaceRoot = createWorkspace('legacy', {
      'README.md': '# Legacy App\n\nA small service.\n',
      'package.json': JSON.stringify({ name: 'legacy-app', dependencies: { express: '^4.0.0' } }),
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(workspaceRoot, '.guardianagent', 'code-sessions.sqlite'),
    });

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Legacy Session',
      workspaceRoot,
    });
    store.updateSession({
      sessionId: session.id,
      ownerUserId: 'owner',
      workState: {
        workspaceProfile: null,
      },
    });

    const hydrated = store.getSession(session.id, 'owner');
    expect(hydrated?.workState.workspaceProfile?.repoName).toBe('legacy-app');
    expect(hydrated?.workState.workspaceProfile?.summary).toContain('legacy-app');
  });

  it('reconciles stale persisted roots and out-of-workspace UI paths on read', () => {
    const workspaceRoot = createWorkspace('reconcile', {
      'README.md': '# Reconcile App\n\nA small service.\n',
      'package.json': JSON.stringify({ name: 'reconcile-app', dependencies: { react: '^18.0.0' } }),
    });
    const outsideRoot = createWorkspace('outside', {
      'ghost.txt': 'outside',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(workspaceRoot, '.guardianagent', 'code-sessions.sqlite'),
    });

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Reconcile Session',
      workspaceRoot,
    });

    (store as unknown as { memory: { sessions: Map<string, unknown> } }).memory.sessions.set(session.id, {
      ...session,
      resolvedRoot: '/stale/root',
      uiState: {
        ...session.uiState,
        currentDirectory: outsideRoot,
        selectedFilePath: join(outsideRoot, 'ghost.txt'),
        expandedDirs: [workspaceRoot, outsideRoot],
      },
      workState: {
        ...session.workState,
        workspaceProfile: null,
      },
    });

    const hydrated = store.getSession(session.id, 'owner');
    expect(hydrated?.resolvedRoot).toBe(workspaceRoot);
    expect(hydrated?.uiState.currentDirectory).toBeNull();
    expect(hydrated?.uiState.selectedFilePath).toBeNull();
    expect(hydrated?.uiState.expandedDirs).toEqual([workspaceRoot]);
    expect(hydrated?.workState.workspaceProfile?.repoName).toBe('reconcile-app');
  });

  it('clears workspace-scoped state when the session root changes', () => {
    const firstRoot = createWorkspace('first-state', {
      'package.json': JSON.stringify({ name: 'first-state-app' }),
      'src/first.ts': 'export const first = true;\n',
    });
    const secondRoot = createWorkspace('second-state', {
      'package.json': JSON.stringify({ name: 'second-state-app' }),
      'src/second.ts': 'export const second = true;\n',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(firstRoot, '.guardianagent', 'code-sessions.sqlite'),
    });

    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Workspace Reset',
      workspaceRoot: firstRoot,
    });

    const primed = store.updateSession({
      sessionId: session.id,
      ownerUserId: 'owner',
      uiState: {
        currentDirectory: firstRoot,
        selectedFilePath: join(firstRoot, 'src', 'first.ts'),
        expandedDirs: [firstRoot],
      },
      workState: {
        focusSummary: 'Old repo focus',
        planSummary: 'Old repo plan',
        compactedSummary: 'Old repo compacted summary',
        workspaceMap: {
          workspaceRoot: firstRoot,
          indexedFileCount: 2,
          totalDiscoveredFiles: 2,
          truncated: false,
          notableFiles: ['package.json', 'src/first.ts'],
          directories: [{ path: 'src', fileCount: 1, sampleFiles: ['src/first.ts'] }],
          files: [{
            path: 'src/first.ts',
            category: 'source',
            extension: '.ts',
            size: 24,
            summary: 'export const first = true;',
            symbols: ['first'],
            imports: [],
            keywords: ['first'],
          }],
          lastIndexedAt: Date.now(),
        },
        workingSet: {
          query: 'Old repo overview',
          retrievedAt: Date.now(),
          rationale: 'Prepared 2 repo files.',
          files: [{
            path: 'src/first.ts',
            category: 'source',
            score: 8,
            reason: 'repo bootstrap',
            summary: 'export const first = true;',
            symbols: ['first'],
          }],
          snippets: [{
            path: 'src/first.ts',
            excerpt: 'export const first = true;',
          }],
        },
        activeSkills: ['coding-workspace'],
        pendingApprovals: [{ id: 'approval-1', toolName: 'code_edit', argsPreview: '...' }],
        recentJobs: [{ id: 'job-1', toolName: 'code_edit', status: 'succeeded' }],
        changedFiles: ['src/first.ts'],
        verification: [{
          id: 'verify-1',
          kind: 'test',
          status: 'pass',
          summary: 'Tests passed',
          timestamp: Date.now(),
        }],
      },
    });
    expect(primed?.workState.focusSummary).toBe('Old repo focus');

    const updated = store.updateSession({
      sessionId: session.id,
      ownerUserId: 'owner',
      workspaceRoot: secondRoot,
    });

    expect(updated?.resolvedRoot).toBe(secondRoot);
    expect(updated?.uiState.currentDirectory).toBeNull();
    expect(updated?.uiState.selectedFilePath).toBeNull();
    expect(updated?.workState.focusSummary).toBe('');
    expect(updated?.workState.planSummary).toBe('');
    expect(updated?.workState.compactedSummary).toBe('');
    expect(updated?.workState.workspaceMap).toBeNull();
    expect(updated?.workState.workingSet).toBeNull();
    expect(updated?.workState.activeSkills).toEqual([]);
    expect(updated?.workState.pendingApprovals).toEqual([]);
    expect(updated?.workState.recentJobs).toEqual([]);
    expect(updated?.workState.changedFiles).toEqual([]);
    expect(updated?.workState.verification).toEqual([]);
    expect(updated?.workState.workspaceProfile?.repoName).toBe('second-state-app');
  });
});
