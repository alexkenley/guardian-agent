import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteExecutionService } from './remote-execution-service.js';
import type {
  RemoteExecutionPreparedRequest,
  VercelRemoteExecutionResolvedTarget,
} from './types.js';

const testDirs: string[] = [];

function createRoot(): string {
  const root = join(tmpdir(), `guardian-remote-exec-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  return root;
}

const TARGET: VercelRemoteExecutionResolvedTarget = {
  id: 'vercel:main',
  profileId: 'vercel-main',
  profileName: 'Main Vercel',
  backendKind: 'vercel_sandbox',
  token: 'vercel-token',
  teamId: 'team_123',
  projectId: 'prj_123',
  apiBaseUrl: 'https://api.vercel.com/',
  networkMode: 'deny_all',
  allowedDomains: [],
};

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('RemoteExecutionService', () => {
  it('stages the workspace snapshot and excludes heavy default directories', async () => {
    const root = createRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(root, 'scripts', 'run.sh'), 0o755);
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, '.git', 'config'), '[core]\n');

    let captured: RemoteExecutionPreparedRequest | null = null;
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        run: vi.fn(async (request) => {
          captured = request;
          return {
            targetId: request.target.id,
            backendKind: request.target.backendKind,
            profileId: request.target.profileId,
            profileName: request.target.profileName,
            requestedCommand: request.command.requestedCommand,
            status: 'succeeded',
            stdout: 'ok',
            stderr: '',
            durationMs: 10,
            startedAt: 1,
            completedAt: 11,
            networkMode: request.target.networkMode,
            allowedDomains: [...request.target.allowedDomains],
            stagedFiles: request.stagedFiles.length,
            stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
            workspaceRoot: request.workspaceRoot,
            cwd: request.cwd,
            artifactFiles: [],
          };
        }),
      }],
    });

    await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'npm test',
        entryCommand: 'npm',
        args: ['test'],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
    });

    expect(captured).not.toBeNull();
    const remotePaths = captured!.stagedFiles.map((file) => file.remotePath).sort();
    expect(remotePaths).toContain('/workspace/package.json');
    expect(remotePaths).toContain('/workspace/src/index.ts');
    expect(remotePaths).toContain('/workspace/scripts/run.sh');
    expect(remotePaths.some((path) => path.includes('node_modules'))).toBe(false);
    expect(remotePaths.some((path) => path.includes('/.git/'))).toBe(false);
    const scriptEntry = captured!.stagedFiles.find((file) => file.remotePath === '/workspace/scripts/run.sh');
    expect(scriptEntry?.mode).toBe(0o755);
  });

  it('supports explicit includePaths relative to cwd and rejects escapes', async () => {
    const root = createRoot();
    mkdirSync(join(root, 'repo', 'src'), { recursive: true });
    mkdirSync(join(root, 'repo', 'test'), { recursive: true });
    writeFileSync(join(root, 'repo', 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'repo', 'test', 'index.test.ts'), 'expect(1).toBe(1);\n');

    let captured: RemoteExecutionPreparedRequest | null = null;
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        run: vi.fn(async (request) => {
          captured = request;
          return {
            targetId: request.target.id,
            backendKind: request.target.backendKind,
            profileId: request.target.profileId,
            profileName: request.target.profileName,
            requestedCommand: request.command.requestedCommand,
            status: 'succeeded',
            stdout: '',
            stderr: '',
            durationMs: 5,
            startedAt: 1,
            completedAt: 6,
            networkMode: request.target.networkMode,
            allowedDomains: [...request.target.allowedDomains],
            stagedFiles: request.stagedFiles.length,
            stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
            workspaceRoot: request.workspaceRoot,
            cwd: request.cwd,
            artifactFiles: [],
          };
        }),
      }],
    });

    await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'npm test',
        entryCommand: 'npm',
        args: ['test'],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: join(root, 'repo'),
        cwd: join(root, 'repo'),
        includePaths: ['src'],
      },
    });

    expect(captured?.stagedFiles.map((file) => file.remotePath)).toEqual(['/workspace/src/index.ts']);

    await expect(service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'npm test',
        entryCommand: 'npm',
        args: ['test'],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: join(root, 'repo'),
        cwd: join(root, 'repo'),
        includePaths: ['../outside'],
      },
    })).rejects.toThrow(/includePath/i);
  });
});
