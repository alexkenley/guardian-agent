import { describe, expect, it, vi } from 'vitest';

import type { DaytonaSandboxSession } from '../../../tools/cloud/daytona-sandbox-client.js';
import { DaytonaSandboxClient } from '../../../tools/cloud/daytona-sandbox-client.js';
import { DaytonaRemoteExecutionProvider } from './daytona-remote-execution.js';
import type {
  DaytonaRemoteExecutionResolvedTarget,
  RemoteExecutionPreparedRequest,
} from '../types.js';

const TARGET: DaytonaRemoteExecutionResolvedTarget = {
  id: 'daytona:main',
  profileId: 'daytona-main',
  profileName: 'Main Daytona',
  backendKind: 'daytona_sandbox',
  apiKey: 'daytona-key',
  apiUrl: 'https://app.daytona.io/api',
  target: 'us',
  language: 'typescript',
  networkMode: 'cidr_allowlist',
  allowedDomains: [],
  allowedCidrs: ['10.0.0.0/8'],
};

function buildRequest(
  overrides: Partial<RemoteExecutionPreparedRequest> = {},
): RemoteExecutionPreparedRequest {
  return {
    target: TARGET,
    command: {
      requestedCommand: 'npm test',
      entryCommand: 'npm',
      args: ['test'],
      execMode: 'direct_exec',
    },
    workspaceRoot: '/tmp/workspace',
    cwd: '/tmp/workspace',
    stagedFiles: [{
      localPath: '/tmp/workspace/package.json',
      remotePath: '/workspace/package.json',
      content: Buffer.from('{"name":"demo"}'),
    }],
    artifactPaths: ['reports/junit.xml'],
    timeoutMs: 120_000,
    vcpus: 2,
    env: { FOO: 'bar' },
    ...overrides,
  };
}

describe('DaytonaRemoteExecutionProvider', () => {
  it('uploads staged files, runs the command, and reads artifacts back', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_123',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '',
      })),
      readFileToBuffer: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.stdout')) return Buffer.from('tests passed');
        if (filePath.endsWith('.stderr')) return Buffer.from('');
        if (filePath.endsWith('.exit')) return Buffer.from('0');
        if (filePath.endsWith('reports/junit.xml')) return Buffer.from('<testsuite />');
        return null;
      }),
      destroy: vi.fn(async () => undefined),
    };
    const client = new DaytonaSandboxClient({
      sandboxFactory: vi.fn(async () => session),
    });
    const ensureDirectories = vi.spyOn(client, 'ensureDirectories');
    const provider = new DaytonaRemoteExecutionProvider({ client });

    const result = await provider.run(buildRequest());

    expect(result.status).toBe('succeeded');
    expect(result.profileId).toBe('daytona-main');
    expect(session.uploadFiles).toHaveBeenCalledWith([
      { path: '/home/daytona/guardian-workspace/package.json', content: Buffer.from('{"name":"demo"}') },
    ]);
    expect(session.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining(`'npm' 'test' >`),
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
      120,
    );
    expect(result.artifactFiles).toMatchObject([
      {
        path: 'reports/junit.xml',
        encoding: 'utf8',
        content: '<testsuite />',
      },
    ]);
    expect(ensureDirectories).toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalled();
  });

  it('does not let request env override sandbox guardrail variables', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_env',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '',
      })),
      readFileToBuffer: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.stdout')) return Buffer.from('ok');
        if (filePath.endsWith('.stderr')) return Buffer.from('');
        if (filePath.endsWith('.exit')) return Buffer.from('0');
        return null;
      }),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });

    const result = await provider.run(buildRequest({
      artifactPaths: [],
      env: {
        CI: 'false',
        GUARDIAN_REMOTE_SANDBOX: '0',
        FOO: 'bar',
      },
    }));

    expect(result.status).toBe('succeeded');
    expect(session.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining(`'npm' 'test' >`),
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
      120,
    );
  });

  it('rejects artifact paths outside the remote workspace namespace', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_artifacts',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '',
      })),
      readFileToBuffer: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.stdout')) return Buffer.from('ok');
        if (filePath.endsWith('.stderr')) return Buffer.from('');
        if (filePath.endsWith('.exit')) return Buffer.from('0');
        if (filePath === '/etc/passwd') return Buffer.from('secret');
        return null;
      }),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });

    const result = await provider.run(buildRequest({
      artifactPaths: ['/etc/passwd'],
    }));

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('must be relative or inside /workspace');
    expect(session.readFileToBuffer).not.toHaveBeenCalledWith('/etc/passwd', 120);
    expect(session.destroy).toHaveBeenCalled();
  });

  it('marks timeout-like command failures as timed_out and still destroys the sandbox', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_456',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => {
        throw new Error('Command timed out while waiting for completion.');
      }),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });

    const result = await provider.run(buildRequest({
      command: {
        requestedCommand: 'echo hi',
        entryCommand: 'echo',
        args: ['hi'],
        execMode: 'shell_fallback',
      },
      artifactPaths: [],
    }));

    expect(session.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining('echo hi'),
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
      120,
    );
    expect(result.status).toBe('timed_out');
    expect(result.stderr).toContain('timed out');
    expect(session.destroy).toHaveBeenCalled();
  });

  it('reuses a lease and removes stale tracked files before restaging', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_reused',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          result: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          result: '',
        }),
      readFileToBuffer: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.stdout')) return Buffer.from('tests passed');
        if (filePath.endsWith('.stderr')) return Buffer.from('');
        if (filePath.endsWith('.exit')) return Buffer.from('0');
        return null;
      }),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });
    const lease = await provider.createLease({
      target: TARGET,
      localWorkspaceRoot: '/tmp/workspace',
    });
    lease.trackedRemotePaths = ['/workspace/removed.txt'];

    const result = await provider.runWithLease(lease, buildRequest({
      artifactPaths: [],
    }));

    expect(result.status).toBe('succeeded');
    expect(session.executeCommand).toHaveBeenNthCalledWith(
      1,
      "rm -f -- '/home/daytona/guardian-workspace/removed.txt'",
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
      },
      120,
    );
    expect(session.executeCommand).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`'npm' 'test' >`),
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
      120,
    );
    expect(lease.trackedRemotePaths).toEqual(['/workspace/package.json']);
    await provider.releaseLease(lease);
    expect(session.destroy).toHaveBeenCalled();
  });

  it('probes sandbox readiness with a real command', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_probe',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '/home/daytona/guardian-workspace\n',
      })),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });

    const result = await provider.probe(TARGET);

    expect(result.healthState).toBe('healthy');
    expect(result.reason).toContain('probe succeeded');
    expect(session.executeCommand).toHaveBeenCalledWith(
      'pwd',
      '/home/daytona/guardian-workspace',
      {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
      },
      10,
    );
    expect(session.destroy).toHaveBeenCalled();
  });

  it('treats stopped managed Daytona sandboxes as restartable during inspection', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_existing',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'stopped',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '',
      })),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxLookup: vi.fn(async () => session),
      }),
    });

    const result = await provider.inspectLease(TARGET, {
      id: 'lease_existing',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: session.workspaceRoot,
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
    });

    expect(result.healthState).toBe('healthy');
    expect(result.reason).toContain('restartable');
    expect(result.remoteWorkspaceRoot).toBe('/home/daytona/guardian-workspace');
    expect(result.state).toBe('stopped');
    expect(session.start).not.toHaveBeenCalled();
    expect(session.executeCommand).not.toHaveBeenCalled();
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it('requires a provider-confirmed running state before a stopped lease is considered resumed', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_resume',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: undefined,
      refreshData: vi.fn(async function (this: DaytonaSandboxSession) {
        if (this.state === undefined) {
          this.state = 'stopped';
          return;
        }
        if (this.state === 'starting') {
          this.state = 'started';
        }
      }),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async function (this: DaytonaSandboxSession) {
        this.state = 'started';
      }),
      start: vi.fn(async function (this: DaytonaSandboxSession) {
        this.state = 'starting';
      }),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: '' })),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxLookup: vi.fn(async () => session),
      }),
    });

    const lease = await provider.resumeLease(TARGET, {
      id: 'lease_existing',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: session.workspaceRoot,
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
      state: 'stopped',
    });

    expect(session.start).toHaveBeenCalledWith(60);
    expect(session.refreshData).toHaveBeenCalled();
    expect(lease.state).toBe(session);
    expect(session.state).toBe('started');
  });

  it('marks a running managed sandbox unreachable when toolbox execution is not ready during inspection', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_inspect_502',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => {
        throw new Error('Request failed with status code 502');
      }),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxLookup: vi.fn(async () => session),
      }),
    });

    const result = await provider.inspectLease(TARGET, {
      id: 'lease_existing',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: session.workspaceRoot,
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
      state: 'started',
    });

    expect(result.healthState).toBe('unreachable');
    expect(result.reason).toContain('toolbox command endpoint');
    expect(result.reason).toContain('502');
  });

  it('fails resume when Daytona reports started but command execution is still unavailable', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_resume_502',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => {
        throw new Error('Request failed with status code 502');
      }),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxLookup: vi.fn(async () => session),
      }),
    });

    await expect(provider.resumeLease(TARGET, {
      id: 'lease_existing',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: session.workspaceRoot,
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
      state: 'started',
    })).rejects.toThrow(/toolbox command endpoint/);
  });

  it('throws transport errors from remote command execution instead of converting them into ordinary command failure', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_run_502',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => {
        throw new Error('Request failed with status code 502');
      }),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });
    const lease = await provider.createLease({
      target: TARGET,
      localWorkspaceRoot: '/tmp/workspace',
      leaseMode: 'managed',
    });

    await expect(provider.runWithLease(lease, buildRequest({
      artifactPaths: [],
    }))).rejects.toThrow(/toolbox command endpoint/);
  });

  it('stops a managed lease by looking up the sandbox when only persisted lease data is available', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_stop_lookup',
      workspaceRoot: '/home/daytona/guardian-workspace',
      state: 'started',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
      waitUntilStarted: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      refreshActivity: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: '' })),
      readFileToBuffer: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const provider = new DaytonaRemoteExecutionProvider({
      client: new DaytonaSandboxClient({
        sandboxLookup: vi.fn(async () => session),
      }),
    });

    await provider.stopLease(TARGET, {
      id: 'lease_existing',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: session.workspaceRoot,
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
    });

    expect(session.stop).toHaveBeenCalledWith(60);
  });
});
