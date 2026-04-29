import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VercelRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const {
  createMock,
  getMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    create: createMock,
    get: getMock,
  },
}));

import { VercelSandboxClient } from './vercel-sandbox-client.js';

const TARGET: VercelRemoteExecutionResolvedTarget = {
  id: 'vercel:main',
  profileId: 'vercel-main',
  profileName: 'Vercel Main',
  backendKind: 'vercel_sandbox',
  teamId: 'team_123',
  projectId: 'prj_123',
  token: 'vercel-token',
  apiBaseUrl: 'https://api.vercel.com/',
  networkMode: 'allow_all',
  allowedDomains: [],
};

function createSandboxRecord() {
  return {
    sandboxId: 'sandbox_123',
    status: 'running',
    mkDir: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => '',
      stderr: async () => '',
    })),
    readFileToBuffer: vi.fn(async () => null),
    stop: vi.fn(async () => undefined),
    extendTimeout: vi.fn(async () => undefined),
  };
}

describe('VercelSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    getMock.mockReset();
  });

  it('creates snapshot-backed sandboxes without passing a runtime override', async () => {
    createMock.mockResolvedValueOnce(createSandboxRecord());

    const client = new VercelSandboxClient();
    const session = await client.createSandbox({
      target: {
        ...TARGET,
        baseSnapshotId: 'snap_123',
      },
      timeoutMs: 60_000,
      runtime: 'node24',
    });

    expect(session.sandboxId).toBe('sandbox_123');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      token: 'vercel-token',
      teamId: 'team_123',
      projectId: 'prj_123',
      source: {
        type: 'snapshot',
        snapshotId: 'snap_123',
      },
      timeout: 60_000,
      resources: { vcpus: 2 },
      networkPolicy: 'allow-all',
    });
  });

  it('creates fresh sandboxes with the configured runtime when no snapshot is configured', async () => {
    createMock.mockResolvedValueOnce(createSandboxRecord());

    const client = new VercelSandboxClient();
    await client.createSandbox({
      target: TARGET,
      timeoutMs: 45_000,
      runtime: 'node22',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      token: 'vercel-token',
      teamId: 'team_123',
      projectId: 'prj_123',
      timeout: 45_000,
      resources: { vcpus: 2 },
      runtime: 'node22',
      networkPolicy: 'allow-all',
    });
  });

  it('updates the wrapped status after a sandbox is stopped', async () => {
    createMock.mockResolvedValueOnce(createSandboxRecord());

    const client = new VercelSandboxClient();
    const session = await client.createSandbox({
      target: TARGET,
      timeoutMs: 45_000,
    });

    expect(session.status).toBe('running');
    await session.stop(true);
    expect(session.status).toBe('stopped');
  });

  it('returns null when an optional artifact is missing', async () => {
    const sandbox = {
      ...createSandboxRecord(),
      readFileToBuffer: vi.fn(async () => {
        throw new Error('404 not found');
      }),
    };
    createMock.mockResolvedValueOnce(sandbox);

    const client = new VercelSandboxClient();
    const session = await client.createSandbox({
      target: TARGET,
      timeoutMs: 45_000,
    });

    await expect(session.readFileToBuffer({ path: '/vercel/sandbox/reports/junit.xml' })).resolves.toBeNull();
  });

  it('propagates non-missing artifact read failures', async () => {
    const sandbox = {
      ...createSandboxRecord(),
      readFileToBuffer: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    createMock.mockResolvedValueOnce(sandbox);

    const client = new VercelSandboxClient();
    const session = await client.createSandbox({
      target: TARGET,
      timeoutMs: 45_000,
    });

    await expect(session.readFileToBuffer({ path: '/vercel/sandbox/reports/junit.xml' }))
      .rejects.toThrow('permission denied');
  });

  it('skips known Vercel base directories when ensuring nested paths', async () => {
    const client = new VercelSandboxClient();
    const session = {
      sandboxId: 'sandbox_123',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };

    await client.ensureDirectories(session, [
      '/vercel/sandbox/src/index.ts',
      '/vercel/sandbox/scripts/run.sh',
    ]);

    expect(session.mkDir).toHaveBeenCalledTimes(2);
    expect(session.mkDir).toHaveBeenNthCalledWith(1, '/vercel/sandbox/src');
    expect(session.mkDir).toHaveBeenNthCalledWith(2, '/vercel/sandbox/scripts');
  });

  it('ignores already-existing nested directories', async () => {
    const client = new VercelSandboxClient();
    const session = {
      sandboxId: 'sandbox_456',
      mkDir: vi.fn(async (directory: string) => {
        if (directory === '/vercel/sandbox/src') {
          throw new Error('File exists');
        }
      }),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };

    await expect(client.ensureDirectories(session, [
      '/vercel/sandbox/src/nested/index.ts',
    ])).resolves.toBeUndefined();

    expect(session.mkDir).toHaveBeenCalledTimes(2);
    expect(session.mkDir).toHaveBeenNthCalledWith(1, '/vercel/sandbox/src');
    expect(session.mkDir).toHaveBeenNthCalledWith(2, '/vercel/sandbox/src/nested');
  });
});
