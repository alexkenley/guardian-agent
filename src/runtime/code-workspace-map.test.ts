import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectCodeWorkspaceSync } from './code-workspace-profile.js';
import {
  buildCodeWorkspaceMapSync,
  buildCodeWorkspaceWorkingSetSync,
} from './code-workspace-map.js';

const testDirs: string[] = [];

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = join(tmpdir(), `guardianagent-workspace-map-${name}-${randomUUID()}`);
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

describe('code-workspace-map', () => {
  it('indexes a bounded repo map with notable files and directories', () => {
    const workspaceRoot = createWorkspace('accomplish', {
      'README.md': '# Accomplish\n\nAccomplish is a habit planning dashboard for tracking routines and weekly goals.\n',
      'package.json': JSON.stringify({
        name: 'accomplish-app',
        description: 'Habit planning dashboard',
        dependencies: {
          react: '^18.0.0',
          'react-router-dom': '^6.0.0',
          vite: '^5.0.0',
        },
      }, null, 2),
      'src/main.tsx': 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n',
      'src/App.tsx': 'export function App() { return <main>Track habits, routines, and weekly goals.</main>; }\n',
      'src/routes/Dashboard.tsx': 'export const Dashboard = () => <section>Habit streaks and daily check-ins</section>;\n',
      'tests/app.test.tsx': 'it("renders", () => {});\n',
    });

    const workspaceMap = buildCodeWorkspaceMapSync(workspaceRoot, 123);

    expect(workspaceMap.indexedFileCount).toBeGreaterThanOrEqual(5);
    expect(workspaceMap.totalDiscoveredFiles).toBeGreaterThanOrEqual(workspaceMap.indexedFileCount);
    expect(workspaceMap.notableFiles).toContain('README.md');
    expect(workspaceMap.notableFiles).toContain('package.json');
    expect(workspaceMap.notableFiles).toContain('src/App.tsx');
    expect(workspaceMap.directories.some((entry) => entry.path === 'src')).toBe(true);
  });

  it('prepares a working set that includes repo bootstrap files and source evidence', () => {
    const workspaceRoot = createWorkspace('accomplish-working-set', {
      'README.md': '# Accomplish\n\nAccomplish is a habit planning dashboard for tracking routines and weekly goals.\n',
      'package.json': JSON.stringify({
        name: 'accomplish-app',
        description: 'Habit planning dashboard',
        dependencies: {
          react: '^18.0.0',
          'react-router-dom': '^6.0.0',
          vite: '^5.0.0',
        },
      }, null, 2),
      'src/main.tsx': 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n',
      'src/App.tsx': 'export function App() { return <main>Track habits, routines, and weekly goals.</main>; }\n',
      'src/routes/Dashboard.tsx': 'export const Dashboard = () => <section>Habit streaks and daily check-ins</section>;\n',
    });

    const workspaceProfile = inspectCodeWorkspaceSync(workspaceRoot, 123);
    const workspaceMap = buildCodeWorkspaceMapSync(workspaceRoot, 123);
    const workingSet = buildCodeWorkspaceWorkingSetSync({
      workspaceRoot,
      workspaceMap,
      workspaceProfile,
      query: 'Give me an overview of this repo and tell me what sort of application it is.',
      selectedFilePath: join(workspaceRoot, 'src', 'App.tsx'),
      now: 456,
    });

    expect(workingSet.files.some((entry) => entry.path === 'README.md')).toBe(true);
    expect(workingSet.files.some((entry) => entry.path === 'package.json')).toBe(true);
    expect(workingSet.files.some((entry) => entry.path === 'src/App.tsx')).toBe(true);
    expect(workingSet.snippets.some((entry) => /habit|weekly goals/i.test(entry.excerpt))).toBe(true);
    expect(workingSet.files.length).toBeLessThanOrEqual(6);
    expect(workingSet.snippets.length).toBeLessThanOrEqual(4);
    expect(workingSet.snippets.every((entry) => entry.excerpt.length <= 900)).toBe(true);
  });

  it('keeps the previous working set alive for vague follow-up questions', () => {
    const workspaceRoot = createWorkspace('accomplish-follow-up', {
      'README.md': '# Accomplish\n\nAccomplish is a habit planning dashboard for tracking routines and weekly goals.\n',
      'package.json': JSON.stringify({
        name: 'accomplish-app',
        description: 'Habit planning dashboard',
        dependencies: {
          react: '^18.0.0',
          vite: '^5.0.0',
        },
      }, null, 2),
      'src/App.tsx': 'export function App() { return <main>Track habits, routines, and weekly goals.</main>; }\n',
    });

    const workspaceProfile = inspectCodeWorkspaceSync(workspaceRoot, 123);
    const workspaceMap = buildCodeWorkspaceMapSync(workspaceRoot, 123);
    const initialWorkingSet = buildCodeWorkspaceWorkingSetSync({
      workspaceRoot,
      workspaceMap,
      workspaceProfile,
      query: 'Give me a brief overview of this repo.',
      now: 456,
    });
    const followUpWorkingSet = buildCodeWorkspaceWorkingSetSync({
      workspaceRoot,
      workspaceMap,
      workspaceProfile,
      query: 'Yeah but what type of application is it?',
      previousWorkingSet: initialWorkingSet,
      now: 789,
    });

    expect(followUpWorkingSet.files.some((entry) => entry.path === 'README.md')).toBe(true);
    expect(followUpWorkingSet.files.some((entry) => entry.path === 'src/App.tsx')).toBe(true);
  });
});
