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
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
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

  it('marks timeout-like command failures as timed_out and still destroys the sandbox', async () => {
    const session: DaytonaSandboxSession = {
      sandboxId: 'daytona_456',
      workspaceRoot: '/home/daytona/guardian-workspace',
      createFolder: vi.fn(async () => undefined),
      uploadFiles: vi.fn(async () => undefined),
      setFileMode: vi.fn(async () => undefined),
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
});
