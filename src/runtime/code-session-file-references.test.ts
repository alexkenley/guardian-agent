import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCodeSessionFileReferencesForPrompt,
  resolveCodeSessionFileReferences,
  sanitizeCodeSessionFileReferences,
} from './code-session-file-references.js';

const testDirs: string[] = [];

function createWorkspace(name: string, files: Record<string, string | Buffer>): string {
  const root = join(tmpdir(), `guardianagent-code-refs-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(root, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('code-session-file-references', () => {
  it('sanitizes and deduplicates file references', () => {
    expect(sanitizeCodeSessionFileReferences([
      { path: ' docs/specs/CODING-WORKSPACE-SPEC.md ' },
      '@docs/specs/CODING-WORKSPACE-SPEC.md',
      'src/index.ts',
      { path: '' },
      42,
    ])).toEqual([
      { path: 'docs/specs/CODING-WORKSPACE-SPEC.md' },
      { path: 'src/index.ts' },
    ]);
  });

  it('resolves in-workspace text files and skips unsafe or binary references', () => {
    const workspaceRoot = createWorkspace('resolve', {
      'docs/spec.md': '# Spec\n\nUse @ references to inject tagged files.\n',
      'src/app.ts': 'export const app = "guardian";\n',
      'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    });

    const references = resolveCodeSessionFileReferences(workspaceRoot, [
      { path: 'docs/spec.md' },
      { path: 'src/app.ts' },
      { path: '../outside.txt' },
      { path: 'assets/logo.png' },
    ]);

    expect(references.map((entry) => entry.path)).toEqual(['docs/spec.md', 'src/app.ts']);
    expect(references[0]?.content).toContain('Use @ references');
    expect(references[1]?.content).toContain('guardian');
  });

  it('formats tagged files into a prompt section', () => {
    const prompt = formatCodeSessionFileReferencesForPrompt([
      { path: 'docs/spec.md', content: '# Spec', truncated: false },
      { path: 'src/app.ts', content: 'export const app = 1;', truncated: true },
    ]);

    expect(prompt).toContain('<tagged-file-context>');
    expect(prompt).toContain('FILE docs/spec.md');
    expect(prompt).toContain('FILE src/app.ts (truncated)');
    expect(prompt).toContain('user explicitly tagged these workspace files');
  });
});
