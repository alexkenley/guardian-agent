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
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'tests passed',
        stderr: '',
      })),
      readFileToBuffer: vi.fn(async () => Buffer.from('<testsuite />')),
      stop: vi.fn(async () => undefined),
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
      { path: '/workspace/package.json', content: Buffer.from('{"name":"demo"}') },
    ]);
    expect(session.runCommand).toHaveBeenCalledWith({
      cmd: 'npm',
      args: ['test'],
      cwd: '/workspace',
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
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => {
        throw new Error('Command timed out while waiting for completion.');
      }),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
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
      cwd: '/workspace',
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
});
