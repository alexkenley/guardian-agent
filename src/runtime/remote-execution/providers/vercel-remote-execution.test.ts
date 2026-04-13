import { describe, expect, it, vi } from 'vitest';

import type { VercelSandboxSession } from '../../../tools/cloud/vercel-sandbox-client.js';
import { VercelSandboxClient } from '../../../tools/cloud/vercel-sandbox-client.js';
import { VercelRemoteExecutionProvider } from './vercel-remote-execution.js';
import type {
  RemoteExecutionPreparedRequest,
  VercelRemoteExecutionResolvedTarget,
} from '../types.js';

const TARGET: VercelRemoteExecutionResolvedTarget = {
  id: 'vercel:main',
  profileId: 'vercel-main',
  profileName: 'Main Vercel',
  backendKind: 'vercel_sandbox',
  token: 'vercel-token',
  teamId: 'team_123',
  projectId: 'prj_123',
  apiBaseUrl: 'https://api.vercel.com/',
  networkMode: 'domain_allowlist',
  allowedDomains: ['registry.npmjs.org'],
  allowedCidrs: [],
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

describe('VercelRemoteExecutionProvider', () => {
  it('writes staged files, runs the command, and reads artifacts back', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_123',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'tests passed',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => Buffer.from('<testsuite />')),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const client = new VercelSandboxClient({
      sandboxFactory: vi.fn(async () => session),
    });
    const ensureDirectories = vi.spyOn(client, 'ensureDirectories');
    const provider = new VercelRemoteExecutionProvider({ client });

    const result = await provider.run(buildRequest());

    expect(result.status).toBe('succeeded');
    expect(result.profileId).toBe('vercel-main');
    expect(session.writeFiles).toHaveBeenCalledWith([
      { path: '/vercel/sandbox/package.json', content: Buffer.from('{"name":"demo"}') },
    ]);
    expect(session.runCommand).toHaveBeenCalledWith({
      cmd: 'npm',
      args: ['test'],
      cwd: '/vercel/sandbox',
      env: {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
    });
    expect(result.artifactFiles).toMatchObject([
      {
        path: 'reports/junit.xml',
        encoding: 'utf8',
        content: '<testsuite />',
      },
    ]);
    expect(ensureDirectories).toHaveBeenCalled();
    expect(session.stop).toHaveBeenCalledWith(true);
  });

  it('uses shell fallback when requested and still stops the sandbox on timeout-like failures', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_456',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => {
        throw new Error('Command timed out while waiting for completion.');
      }),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const provider = new VercelRemoteExecutionProvider({
      client: new VercelSandboxClient({
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

    expect(session.runCommand).toHaveBeenCalledWith({
      cmd: 'bash',
      args: ['-lc', 'echo hi'],
      cwd: '/vercel/sandbox',
      env: {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
    });
    expect(result.status).toBe('timed_out');
    expect(result.stderr).toContain('timed out');
    expect(session.stop).toHaveBeenCalledWith(true);
  });

  it('creates the remote cwd even when no workspace files are staged', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_789',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: '/vercel/sandbox',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const client = new VercelSandboxClient({
      sandboxFactory: vi.fn(async () => session),
    });
    const ensureDirectories = vi.spyOn(client, 'ensureDirectories');
    const provider = new VercelRemoteExecutionProvider({ client });

    const result = await provider.run(buildRequest({
      command: {
        requestedCommand: 'pwd',
        entryCommand: 'pwd',
        args: [],
        execMode: 'direct_exec',
      },
      stagedFiles: [],
      artifactPaths: [],
    }));

    expect(result.status).toBe('succeeded');
    expect(ensureDirectories).toHaveBeenCalledWith(session, ['/vercel/sandbox/.guardian-cwd']);
    expect(session.writeFiles).toHaveBeenCalledWith([]);
    expect(session.runCommand).toHaveBeenCalledWith({
      cmd: 'pwd',
      args: [],
      cwd: '/vercel/sandbox',
      env: {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
    });
  });

  it('surfaces Vercel API error details and request scope when sandbox creation fails', async () => {
    const apiError = Object.assign(
      new Error('Status code 400 is not ok'),
      {
        response: new Response(JSON.stringify({
          error: {
            code: 'bad_request',
            message: 'Invalid projectId for sandbox creation.',
          },
        }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        }),
        json: {
          error: {
            code: 'bad_request',
            message: 'Invalid projectId for sandbox creation.',
          },
        },
        text: '{"error":{"code":"bad_request","message":"Invalid projectId for sandbox creation."}}',
      },
    );
    const provider = new VercelRemoteExecutionProvider({
      client: new VercelSandboxClient({
        sandboxFactory: vi.fn(async () => {
          throw apiError;
        }),
      }),
    });

    const result = await provider.run(buildRequest());

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('Status code 400 is not ok');
    expect(result.stderr).toContain('HTTP 400 Bad Request');
    expect(result.stderr).toContain('code=bad_request');
    expect(result.stderr).toContain('Invalid projectId for sandbox creation.');
    expect(result.stderr).toContain('teamId=team_123');
    expect(result.stderr).toContain('projectId=prj_123');
  });

  it('reuses a lease and removes stale tracked files before restaging', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_reused',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'tests passed',
          stderr: '',
        }),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const client = new VercelSandboxClient({
      sandboxFactory: vi.fn(async () => session),
    });
    const provider = new VercelRemoteExecutionProvider({ client });
    const lease = await provider.createLease({
      target: TARGET,
      localWorkspaceRoot: '/tmp/workspace',
    });
    lease.trackedRemotePaths = ['/workspace/removed.txt'];

    const result = await provider.runWithLease(lease, buildRequest({
      artifactPaths: [],
    }));

    expect(result.status).toBe('succeeded');
    expect(session.runCommand).toHaveBeenNthCalledWith(1, {
      cmd: 'bash',
      args: ['-lc', "rm -f -- '/vercel/sandbox/removed.txt'"],
    });
    expect(session.runCommand).toHaveBeenNthCalledWith(2, {
      cmd: 'npm',
      args: ['test'],
      cwd: '/vercel/sandbox',
      env: {
        CI: 'true',
        GUARDIAN_REMOTE_SANDBOX: '1',
        FOO: 'bar',
      },
    });
    expect(lease.trackedRemotePaths).toEqual(['/workspace/package.json']);
    await provider.releaseLease(lease);
    expect(session.stop).toHaveBeenCalledWith(true);
  });

  it('probes sandbox readiness with a real command', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_probe',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: '/vercel/sandbox\n',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const provider = new VercelRemoteExecutionProvider({
      client: new VercelSandboxClient({
        sandboxFactory: vi.fn(async () => session),
      }),
    });

    const result = await provider.probe(TARGET);

    expect(result.healthState).toBe('healthy');
    expect(result.reason).toContain('probe succeeded');
    expect(session.runCommand).toHaveBeenCalledWith({
      cmd: 'pwd',
      args: [],
    });
    expect(session.stop).toHaveBeenCalledWith(true);
  });

  it('inspects an existing lease without extending or executing it', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_existing',
      status: 'expired',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const provider = new VercelRemoteExecutionProvider({
      client: new VercelSandboxClient({
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
      remoteWorkspaceRoot: '/vercel/sandbox',
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
    });

    expect(result.healthState).toBe('unreachable');
    expect(result.reason).toContain('no longer reusable');
    expect(result.remoteWorkspaceRoot).toBe('/vercel/sandbox');
    expect(session.runCommand).not.toHaveBeenCalled();
    expect(session.extendTimeout).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
  });

  it('reconnects to an existing sandbox lease and extends its timeout', async () => {
    const session: VercelSandboxSession = {
      sandboxId: 'sandbox_existing',
      status: 'running',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      extendTimeout: vi.fn(async () => undefined),
    };
    const client = new VercelSandboxClient({
      sandboxLookup: vi.fn(async () => session),
    });
    const provider = new VercelRemoteExecutionProvider({ client });

    const lease = await provider.resumeLease(TARGET, {
      id: 'lease_123',
      targetId: TARGET.id,
      backendKind: TARGET.backendKind,
      profileId: TARGET.profileId,
      profileName: TARGET.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: '/tmp/workspace',
      remoteWorkspaceRoot: '/vercel/sandbox',
      acquiredAt: 1,
      lastUsedAt: 1,
      expiresAt: 1,
      trackedRemotePaths: ['/workspace/package.json'],
      leaseMode: 'managed',
    });

    expect(lease.sandboxId).toBe('sandbox_existing');
    expect(lease.leaseMode).toBe('managed');
    expect(session.extendTimeout).toHaveBeenCalled();
  });
});
