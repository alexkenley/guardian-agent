import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspaceDependencyLedger,
  captureJsDependencySnapshot,
  detectJsDependencyMutationIntent,
  diffJsDependencySnapshots,
} from './workspace-dependency-ledger.js';

const testDirs: string[] = [];

function createWorkspaceRoot(): string {
  const root = join(tmpdir(), `guardianagent-dependency-ledger-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace dependency ledger', () => {
  it('detects local package-manager dependency mutations and ignores global installs', () => {
    expect(detectJsDependencyMutationIntent({
      command: 'npm',
      args: ['install', 'pdf-parse'],
    })).toEqual({
      manager: 'npm',
      subcommand: 'install',
      requestedPackages: ['pdf-parse'],
    });

    expect(detectJsDependencyMutationIntent({
      command: 'npm',
      args: ['install', '-g', 'pdf-parse'],
    })).toBeNull();
  });

  it('records manifest changes and surfaces active prompt lines', () => {
    const root = createWorkspaceRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'ledger-fixture',
      version: '1.0.0',
    }, null, 2));

    const before = captureJsDependencySnapshot(root, root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'ledger-fixture',
      version: '1.0.0',
      dependencies: {
        'pdf-parse': '^1.1.1',
      },
      devDependencies: {
        vitest: '^3.0.0',
      },
    }, null, 2));

    const after = captureJsDependencySnapshot(root, root);
    const diff = diffJsDependencySnapshots(before, after);
    expect(after).not.toBeNull();
    expect(diff).not.toBeNull();
    if (!after || !diff) {
      throw new Error('Expected a dependency change to be captured.');
    }

    const ledger = new WorkspaceDependencyLedger(root);
    ledger.recordMutation({
      intent: {
        manager: 'npm',
        subcommand: 'install',
        requestedPackages: ['pdf-parse', 'vitest'],
      },
      command: 'npm install pdf-parse vitest --save-dev',
      cwd: root,
      before,
      after,
      diff,
      now: () => Date.parse('2026-03-19T00:00:00.000Z'),
    });

    const prompt = ledger.buildPromptLines().join('\n');
    expect(prompt).toContain('Workspace dependency awareness:');
    expect(prompt).toContain('2026-03-19 npm install in .:');
    expect(prompt).toContain('pdf-parse@^1.1.1');
    expect(prompt).toContain('vitest@^3.0.0 [devDependencies]');
    expect(prompt).toContain('files package.json');
  });
});
