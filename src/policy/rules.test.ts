import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicyFiles, loadSingleFile } from './rules.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'policy-rules-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePolicyFile(dir: string, filename: string, content: unknown): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

// ── loadSingleFile ───────────────────────────────────────────────

describe('loadSingleFile', () => {
  it('loads a valid policy file', () => {
    const path = writePolicyFile(tmpDir, 'test.json', {
      schemaVersion: 1,
      rules: [
        {
          id: 'r1',
          family: 'tool',
          enabled: true,
          priority: 100,
          match: { action: 'tool:fs_read' },
          decision: { kind: 'allow', reason: 'test' },
        },
      ],
    });
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.rules[0].id).toBe('r1');
  });

  it('rejects missing schemaVersion', () => {
    const path = writePolicyFile(tmpDir, 'no-version.json', {
      rules: [],
    });
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(0);
    expect(result.errors[0]).toContain('missing schemaVersion');
  });

  it('rejects newer schemaVersion', () => {
    const path = writePolicyFile(tmpDir, 'future.json', {
      schemaVersion: 999,
      rules: [],
    });
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(0);
    expect(result.errors[0]).toContain('newer than supported');
  });

  it('rejects non-array rules', () => {
    const path = writePolicyFile(tmpDir, 'bad-rules.json', {
      schemaVersion: 1,
      rules: 'not-an-array',
    });
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(0);
    expect(result.errors[0]).toContain("'rules' must be an array");
  });

  it('skips non-object rules', () => {
    const path = writePolicyFile(tmpDir, 'mixed.json', {
      schemaVersion: 1,
      rules: [
        { id: 'valid', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'ok' } },
        null,
        'string-rule',
        42,
      ],
    });
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(1);
    expect(result.errors).toHaveLength(3);
  });

  it('handles invalid JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{ not valid json }');
    const result = loadSingleFile(path);
    expect(result.rules).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles missing file', () => {
    const result = loadSingleFile(join(tmpDir, 'nonexistent.json'));
    expect(result.rules).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── loadPolicyFiles ──────────────────────────────────────────────

describe('loadPolicyFiles', () => {
  it('loads files from directory', () => {
    writePolicyFile(tmpDir, 'a.json', {
      schemaVersion: 1,
      rules: [{ id: 'r1', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'a' } }],
    });
    writePolicyFile(tmpDir, 'b.json', {
      schemaVersion: 1,
      rules: [{ id: 'r2', family: 'tool', enabled: true, priority: 200, match: {}, decision: { kind: 'deny', reason: 'b' } }],
    });

    const result = loadPolicyFiles(tmpDir);
    expect(result.rules).toHaveLength(2);
    expect(result.fileCount).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('recurses one level into subdirectories', () => {
    const subDir = join(tmpDir, 'sub');
    mkdirSync(subDir);
    writePolicyFile(subDir, 'nested.json', {
      schemaVersion: 1,
      rules: [{ id: 'nested', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'nested' } }],
    });

    const result = loadPolicyFiles(tmpDir);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe('nested');
  });

  it('ignores non-JSON files', () => {
    writeFileSync(join(tmpDir, 'readme.txt'), 'not a policy');
    writeFileSync(join(tmpDir, 'config.yaml'), 'also not');
    writePolicyFile(tmpDir, 'real.json', {
      schemaVersion: 1,
      rules: [{ id: 'r1', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'ok' } }],
    });

    const result = loadPolicyFiles(tmpDir);
    expect(result.fileCount).toBe(1);
  });

  it('returns error for nonexistent path', () => {
    const result = loadPolicyFiles(join(tmpDir, 'nope'));
    expect(result.errors[0]).toContain('does not exist');
    expect(result.fileCount).toBe(0);
  });

  it('returns empty for empty directory', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir);
    const result = loadPolicyFiles(emptyDir);
    expect(result.rules).toHaveLength(0);
    expect(result.fileCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
