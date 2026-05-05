import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteExecutionService } from './remote-execution-service.js';
import type {
  RemoteExecutionPreparedRequest,
  RemoteExecutionProviderLease,
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
  allowedCidrs: [],
};

function createLease(localWorkspaceRoot: string, overrides: Partial<RemoteExecutionProviderLease> = {}): RemoteExecutionProviderLease {
  return {
    id: randomUUID(),
    targetId: TARGET.id,
    backendKind: TARGET.backendKind,
    profileId: TARGET.profileId,
    profileName: TARGET.profileName,
    sandboxId: 'sandbox_123',
    localWorkspaceRoot,
    remoteWorkspaceRoot: '/vercel/sandbox',
    acquiredAt: 1,
    lastUsedAt: 1,
    expiresAt: 1,
    trackedRemotePaths: [],
    leaseMode: 'ephemeral',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('RemoteExecutionService', () => {
  it('refreshes cached target health with provider probe results', async () => {
    let now = 1_000;
    const probe = vi.fn(async () => ({
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      healthState: 'unreachable' as const,
      reason: 'Vercel sandbox returned HTTP 502.',
      checkedAt: now,
      durationMs: 25,
      sandboxId: 'sandbox_probe',
    }));
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe,
        inspectLease: vi.fn(),
        createLease: vi.fn(),
        resumeLease: vi.fn(),
        runWithLease: vi.fn(),
        releaseLease: vi.fn(),
        run: vi.fn(),
      }],
      probeTtlMs: 10_000,
      now: () => now,
    });

    const first = await service.refreshTargetHealth([TARGET]);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(first[TARGET.id]).toMatchObject({
      state: 'unreachable',
      reason: 'Vercel sandbox returned HTTP 502.',
      cause: 'external_service_unreachable',
      sandboxId: 'sandbox_probe',
    });

    now += 5_000;
    await service.refreshTargetHealth([TARGET]);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('stages the workspace snapshot and excludes heavy default directories', async () => {
    const root = createRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, 'AppData', 'Roaming'), { recursive: true });
    mkdirSync(join(root, 'Microsoft', 'Windows', 'PowerShell'), { recursive: true });
    mkdirSync(join(root, 'src', 'Microsoft'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'src', 'Microsoft', 'legit.ts'), 'export const vendor = "Microsoft";\n');
    writeFileSync(join(root, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(root, 'scripts', 'run.sh'), 0o755);
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'AppData', 'Roaming', 'cache.txt'), 'profile cache\n');
    writeFileSync(join(root, 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache'), 'profile cache\n');
    writeFileSync(join(root, '.git', 'config'), '[core]\n');

    let captured: RemoteExecutionPreparedRequest | null = null;
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => createLease(request.localWorkspaceRoot)),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(async (_lease, request) => {
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
            allowedCidrs: [...request.target.allowedCidrs],
            stagedFiles: request.stagedFiles.length,
            stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
            workspaceRoot: request.workspaceRoot,
            cwd: request.cwd,
            artifactFiles: [],
          };
        }),
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
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
    expect(remotePaths).toContain('/workspace/src/Microsoft/legit.ts');
    expect(remotePaths).toContain('/workspace/scripts/run.sh');
    expect(remotePaths.some((filePath) => filePath.includes('node_modules'))).toBe(false);
    expect(remotePaths.some((filePath) => filePath.includes('/AppData/'))).toBe(false);
    expect(remotePaths.some((filePath) => filePath.includes('/Microsoft/Windows/'))).toBe(false);
    expect(remotePaths.some((filePath) => filePath.includes('/.git/'))).toBe(false);
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
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => createLease(request.localWorkspaceRoot)),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(async (_lease, request) => {
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
            allowedCidrs: [...request.target.allowedCidrs],
            stagedFiles: request.stagedFiles.length,
            stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
            workspaceRoot: request.workspaceRoot,
            cwd: request.cwd,
            artifactFiles: [],
          };
        }),
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
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

  it('stops a persisted managed lease through the provider using the resolved target', async () => {
    const root = createRoot();
    const providerStopLease = vi.fn(async () => undefined);
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => createLease(request.localWorkspaceRoot)),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(),
        releaseLease: vi.fn(async () => undefined),
        stopLease: providerStopLease,
        run: vi.fn(),
      }],
    });
    const lease = createLease(root, { leaseMode: 'managed' });

    await service.stopLease({
      target: TARGET,
      lease,
    });

    expect(providerStopLease).toHaveBeenCalledWith(TARGET, lease);
    expect(lease.state).toBe('stopped');
  });

  it('supports remote commands that do not need a workspace snapshot', async () => {
    const root = createRoot();
    mkdirSync(join(root, 'node_modules', 'huge-package'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'huge-package', 'index.js'), 'x'.repeat(26 * 1024 * 1024));

    let captured: RemoteExecutionPreparedRequest | null = null;
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy',
          reason: 'ok',
          checkedAt: 1,
          durationMs: 1,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => createLease(request.localWorkspaceRoot)),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(async (_lease, request) => {
          captured = request;
          return {
            targetId: request.target.id,
            backendKind: request.target.backendKind,
            profileId: request.target.profileId,
            profileName: request.target.profileName,
            requestedCommand: request.command.requestedCommand,
            status: 'succeeded',
            stdout: '/workspace\n',
            stderr: '',
            durationMs: 5,
            startedAt: 1,
            completedAt: 6,
            networkMode: request.target.networkMode,
            allowedDomains: [...request.target.allowedDomains],
            allowedCidrs: [...request.target.allowedCidrs],
            stagedFiles: request.stagedFiles.length,
            stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
            workspaceRoot: request.workspaceRoot,
            cwd: request.cwd,
            artifactFiles: [],
          };
        }),
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
      }],
    });

    await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
        stageWorkspace: false,
      },
    });

    expect(captured).not.toBeNull();
    expect(captured?.stagedFiles).toEqual([]);
    expect(captured?.cwd).toBe(root);
    expect(captured?.workspaceRoot).toBe(root);
  });

  it('reuses the same sandbox lease for repeated jobs in one code session', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 1_000;
    const probe = vi.fn(async () => ({
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      healthState: 'healthy' as const,
      reason: 'ok',
      checkedAt: now,
      durationMs: 5,
    }));
    const createLeaseSpy = vi.fn(async (request) => createLease(request.localWorkspaceRoot));
    const runWithLeaseSpy = vi.fn(async (lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest) => ({
      targetId: request.target.id,
      backendKind: request.target.backendKind,
      profileId: request.target.profileId,
      profileName: request.target.profileName,
      requestedCommand: request.command.requestedCommand,
      status: 'succeeded' as const,
      sandboxId: lease.sandboxId,
      stdout: 'ok',
      stderr: '',
      durationMs: 5,
      startedAt: now,
      completedAt: now + 5,
      networkMode: request.target.networkMode,
      allowedDomains: [...request.target.allowedDomains],
      allowedCidrs: [...request.target.allowedCidrs],
      stagedFiles: request.stagedFiles.length,
      stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
      artifactFiles: [],
    }));
    const releaseLeaseSpy = vi.fn(async () => undefined);
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe,
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: createLeaseSpy,
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: runWithLeaseSpy,
        releaseLease: releaseLeaseSpy,
        run: vi.fn(),
      }],
      now: () => now,
    });

    const first = await service.runBoundedJob({
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
      codeSessionId: 'code-session-1',
    });

    now += 1_000;

    const second = await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'npm run build',
        entryCommand: 'npm',
        args: ['run', 'build'],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
      codeSessionId: 'code-session-1',
    });

    expect(first.leaseId).toBeTruthy();
    expect(second.leaseId).toBe(first.leaseId);
    expect(first.leaseReused).toBe(false);
    expect(second.leaseReused).toBe(true);
    expect(createLeaseSpy).toHaveBeenCalledTimes(1);
    expect(runWithLeaseSpy).toHaveBeenCalledTimes(2);
    expect(releaseLeaseSpy).not.toHaveBeenCalled();
    expect(service.listActiveLeases()).toHaveLength(1);
    expect(service.getKnownTargetHealth()[TARGET.id]).toMatchObject({
      state: 'healthy',
      leaseId: first.leaseId,
      sandboxId: 'sandbox_123',
    });
  });

  it('keeps managed leases active until explicitly disposed', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 10_000;
    const createLeaseSpy = vi.fn(async (request) => createLease(request.localWorkspaceRoot, {
      leaseMode: request.leaseMode ?? 'ephemeral',
    }));
    const releaseLeaseSpy = vi.fn(async () => undefined);
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: createLeaseSpy,
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, {
          ...lease,
          leaseMode: 'managed',
        })),
        runWithLease: vi.fn(async (lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest) => ({
          targetId: request.target.id,
          backendKind: request.target.backendKind,
          profileId: request.target.profileId,
          profileName: request.target.profileName,
          requestedCommand: request.command.requestedCommand,
          status: 'succeeded' as const,
          sandboxId: lease.sandboxId,
          stdout: 'ok',
          stderr: '',
          durationMs: 5,
          startedAt: now,
          completedAt: now + 5,
          networkMode: request.target.networkMode,
          allowedDomains: [...request.target.allowedDomains],
          allowedCidrs: [...request.target.allowedCidrs],
          stagedFiles: request.stagedFiles.length,
          stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
          workspaceRoot: request.workspaceRoot,
          cwd: request.cwd,
          artifactFiles: [],
        })),
        releaseLease: releaseLeaseSpy,
        run: vi.fn(),
      }],
      now: () => now,
      leaseIdleTtlMs: 60_000,
    });

    const first = await service.runBoundedJob({
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
      codeSessionId: 'code-session-managed',
      leaseMode: 'managed',
    });

    now += 5 * 60_000;

    const second = await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'npm run build',
        entryCommand: 'npm',
        args: ['run', 'build'],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
      codeSessionId: 'code-session-managed',
      leaseMode: 'managed',
    });

    expect(first.leaseMode).toBe('managed');
    expect(second.leaseId).toBe(first.leaseId);
    expect(second.leaseReused).toBe(true);
    expect(releaseLeaseSpy).not.toHaveBeenCalled();

    await service.disposeLease?.({
      target: TARGET,
      lease: service.listActiveLeases()[0],
    });

    expect(releaseLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it('clears released managed lease identifiers from target health', async () => {
    const root = createRoot();
    let now = 20_000;
    const releaseLeaseSpy = vi.fn(async () => undefined);
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => createLease(request.localWorkspaceRoot, {
          id: 'managed-lease-to-release',
          sandboxId: 'sandbox-to-release',
          leaseMode: request.leaseMode ?? 'ephemeral',
        })),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(),
        releaseLease: releaseLeaseSpy,
        run: vi.fn(),
      }],
      now: () => now,
    });

    const lease = await service.acquireLease({
      target: TARGET,
      localWorkspaceRoot: root,
      codeSessionId: 'code-session-release',
      leaseMode: 'managed',
    });

    expect(service.getKnownTargetHealth()[TARGET.id]).toMatchObject({
      state: 'healthy',
      leaseId: lease.id,
      sandboxId: lease.sandboxId,
    });

    now += 1_000;
    await service.disposeLease({
      target: TARGET,
      lease,
    });

    expect(releaseLeaseSpy).toHaveBeenCalledTimes(1);
    expect(service.getKnownTargetHealth()[TARGET.id]).toMatchObject({
      state: 'healthy',
      reason: 'Remote sandbox lease released.',
    });
    expect(service.getKnownTargetHealth()[TARGET.id]?.leaseId).toBeUndefined();
    expect(service.getKnownTargetHealth()[TARGET.id]?.sandboxId).toBeUndefined();
  });

  it('keeps target health attached to a remaining active lease after releasing another lease', async () => {
    const root = createRoot();
    let now = 30_000;
    let leaseIndex = 0;
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: vi.fn(async (request) => {
          leaseIndex += 1;
          return createLease(request.localWorkspaceRoot, {
            id: `managed-lease-${leaseIndex}`,
            sandboxId: `sandbox-${leaseIndex}`,
            leaseMode: request.leaseMode ?? 'ephemeral',
          });
        }),
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(),
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
      }],
      now: () => now,
    });

    const firstLease = await service.acquireLease({
      target: TARGET,
      localWorkspaceRoot: root,
      codeSessionId: 'code-session-one',
      leaseMode: 'managed',
    });
    now += 1_000;
    const secondLease = await service.acquireLease({
      target: TARGET,
      localWorkspaceRoot: root,
      codeSessionId: 'code-session-two',
      leaseMode: 'managed',
    });

    await service.disposeLease({
      target: TARGET,
      lease: firstLease,
    });

    expect(service.getKnownTargetHealth()[TARGET.id]).toMatchObject({
      state: 'healthy',
      leaseId: secondLease.id,
      sandboxId: secondLease.sandboxId,
    });
  });

  it('resumes a stopped cached managed lease before the next code-session run', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 3_000;
    const createLeaseSpy = vi.fn(async (request) => createLease(request.localWorkspaceRoot, {
      id: 'managed-stopped-lease',
      leaseMode: 'managed',
      state: 'stopped',
    }));
    const resumeLeaseSpy = vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, {
      ...lease,
      leaseMode: 'managed',
      state: 'running',
    }));
    const runWithLeaseSpy = vi.fn(async (lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest) => ({
      targetId: request.target.id,
      backendKind: request.target.backendKind,
      profileId: request.target.profileId,
      profileName: request.target.profileName,
      requestedCommand: request.command.requestedCommand,
      status: 'succeeded' as const,
      sandboxId: lease.sandboxId,
      stdout: '/workspace',
      stderr: '',
      durationMs: 5,
      startedAt: now,
      completedAt: now + 5,
      networkMode: request.target.networkMode,
      allowedDomains: [...request.target.allowedDomains],
      allowedCidrs: [...request.target.allowedCidrs],
      stagedFiles: request.stagedFiles.length,
      stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
      artifactFiles: [],
    }));
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: true,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
          state: typeof lease.state === 'string' ? lease.state : 'stopped',
        })),
        createLease: createLeaseSpy,
        resumeLease: resumeLeaseSpy,
        runWithLease: runWithLeaseSpy,
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
      }],
      now: () => now,
    });

    await service.acquireLease({
      target: TARGET,
      localWorkspaceRoot: root,
      codeSessionId: 'code-session-stopped',
      leaseMode: 'managed',
    });

    const result = await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
      codeSessionId: 'code-session-stopped',
      leaseMode: 'managed',
    });

    expect(createLeaseSpy).toHaveBeenCalledTimes(1);
    expect(resumeLeaseSpy).toHaveBeenCalledTimes(1);
    expect(runWithLeaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'managed-stopped-lease',
        leaseMode: 'managed',
        state: 'running',
      }),
      expect.any(Object),
    );
    expect(result.leaseId).toBe('managed-stopped-lease');
    expect(result.leaseReused).toBe(true);
  });

  it('resumes a preferred stopped managed lease before probing or creating a replacement sandbox', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 3_500;
    const probe = vi.fn(async () => ({
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      healthState: 'healthy' as const,
      reason: 'ok',
      checkedAt: now,
      durationMs: 5,
    }));
    const createLeaseSpy = vi.fn(async () => {
      throw new Error('Should not create a replacement lease when a preferred managed lease is reusable.');
    });
    const resumeLeaseSpy = vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, {
      ...lease,
      id: 'preferred-managed-lease',
      leaseMode: 'managed',
      state: 'running',
    }));
    const runWithLeaseSpy = vi.fn(async (lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest) => ({
      targetId: request.target.id,
      backendKind: request.target.backendKind,
      profileId: request.target.profileId,
      profileName: request.target.profileName,
      requestedCommand: request.command.requestedCommand,
      status: 'succeeded' as const,
      sandboxId: lease.sandboxId,
      stdout: '/workspace',
      stderr: '',
      durationMs: 5,
      startedAt: now,
      completedAt: now + 5,
      networkMode: request.target.networkMode,
      allowedDomains: [...request.target.allowedDomains],
      allowedCidrs: [...request.target.allowedCidrs],
      stagedFiles: request.stagedFiles.length,
      stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
      artifactFiles: [],
    }));
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: true,
        },
        probe,
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
          state: typeof lease.state === 'string' ? lease.state : 'stopped',
        })),
        createLease: createLeaseSpy,
        resumeLease: resumeLeaseSpy,
        runWithLease: runWithLeaseSpy,
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
      }],
      now: () => now,
    });
    const preferredLease = createLease(root, {
      id: 'preferred-managed-lease',
      leaseMode: 'managed',
      state: 'stopped',
    });

    const result = await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
      preferredLease,
      codeSessionId: 'code-session-preferred',
      leaseMode: 'managed',
    });

    expect(probe).not.toHaveBeenCalled();
    expect(createLeaseSpy).not.toHaveBeenCalled();
    expect(resumeLeaseSpy).toHaveBeenCalledTimes(1);
    expect(runWithLeaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'preferred-managed-lease',
        leaseMode: 'managed',
        state: 'running',
      }),
      expect.any(Object),
    );
    expect(result.leaseId).toBe('preferred-managed-lease');
    expect(result.leaseReused).toBe(true);
  });

  it('does not create a replacement lease when a stopped managed lease cannot be resumed', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 4_000;
    const createLeaseSpy = vi.fn(async (request) => createLease(request.localWorkspaceRoot, {
      id: 'managed-stopped-lease',
      leaseMode: 'managed',
      state: 'stopped',
    }));
    const resumeLeaseSpy = vi.fn(async () => {
      throw new Error('Managed sandbox cannot be restarted.');
    });
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe: vi.fn(async () => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
        })),
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
          state: typeof lease.state === 'string' ? lease.state : 'stopped',
        })),
        createLease: createLeaseSpy,
        resumeLease: resumeLeaseSpy,
        runWithLease: vi.fn(),
        releaseLease: vi.fn(async () => undefined),
        run: vi.fn(),
      }],
      now: () => now,
    });

    await service.acquireLease({
      target: TARGET,
      localWorkspaceRoot: root,
      codeSessionId: 'code-session-stopped',
      leaseMode: 'managed',
    });

    await expect(service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
      },
      codeSessionId: 'code-session-stopped',
      leaseMode: 'managed',
    })).rejects.toThrow('Managed sandbox cannot be restarted.');

    expect(createLeaseSpy).toHaveBeenCalledTimes(1);
    expect(resumeLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it('caches successful probe results for repeated ephemeral jobs', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
    let now = 2_000;
    const probe = vi.fn(async () => ({
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      healthState: 'healthy' as const,
      reason: 'ok',
      checkedAt: now,
      durationMs: 5,
    }));
    const createLeaseSpy = vi.fn(async (request) => createLease(request.localWorkspaceRoot));
    const releaseLeaseSpy = vi.fn(async () => undefined);
    const service = new RemoteExecutionService({
      providers: [{
        backendKind: 'vercel_sandbox',
        capabilities: {
          reconnectExisting: true,
          restartStoppedSandbox: false,
        },
        probe,
        inspectLease: vi.fn(async (_target, lease) => ({
          targetId: TARGET.id,
          backendKind: TARGET.backendKind,
          profileId: TARGET.profileId,
          profileName: TARGET.profileName,
          healthState: 'healthy' as const,
          reason: 'ok',
          checkedAt: now,
          durationMs: 5,
          sandboxId: lease.sandboxId,
          remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
        })),
        createLease: createLeaseSpy,
        resumeLease: vi.fn(async (_target, lease) => createLease(lease.localWorkspaceRoot, lease)),
        runWithLease: vi.fn(async (lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest) => ({
          targetId: request.target.id,
          backendKind: request.target.backendKind,
          profileId: request.target.profileId,
          profileName: request.target.profileName,
          requestedCommand: request.command.requestedCommand,
          status: 'succeeded' as const,
          sandboxId: lease.sandboxId,
          stdout: 'ok',
          stderr: '',
          durationMs: 5,
          startedAt: now,
          completedAt: now + 5,
          networkMode: request.target.networkMode,
          allowedDomains: [...request.target.allowedDomains],
          allowedCidrs: [...request.target.allowedCidrs],
          stagedFiles: request.stagedFiles.length,
          stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
          workspaceRoot: request.workspaceRoot,
          cwd: request.cwd,
          artifactFiles: [],
        })),
        releaseLease: releaseLeaseSpy,
        run: vi.fn(),
      }],
      now: () => now,
      probeTtlMs: 60_000,
    });

    await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
        stageWorkspace: false,
      },
    });

    now += 5_000;

    await service.runBoundedJob({
      target: TARGET,
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      workspace: {
        workspaceRoot: root,
        cwd: root,
        stageWorkspace: false,
      },
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(createLeaseSpy).toHaveBeenCalledTimes(2);
    expect(releaseLeaseSpy).toHaveBeenCalledTimes(2);
  });
});
