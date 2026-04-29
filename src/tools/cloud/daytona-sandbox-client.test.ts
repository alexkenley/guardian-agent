import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaytonaRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const {
  createMock,
  getMock,
  disposeMock,
  getWorkDirMock,
  getUserHomeDirMock,
  createFolderMock,
  uploadFilesMock,
  setFilePermissionsMock,
  executeCommandMock,
  downloadFileMock,
  deleteMock,
  startMock,
  refreshDataMock,
  waitUntilStartedMock,
  DaytonaCtor,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
  disposeMock: vi.fn(async () => undefined),
  getWorkDirMock: vi.fn(async () => '/home/daytona'),
  getUserHomeDirMock: vi.fn(async () => '/home/daytona'),
  createFolderMock: vi.fn(async () => undefined),
  uploadFilesMock: vi.fn(async () => undefined),
  setFilePermissionsMock: vi.fn(async () => undefined),
  executeCommandMock: vi.fn(async () => ({ exitCode: 0, result: '' })),
  downloadFileMock: vi.fn(async () => null),
  deleteMock: vi.fn(async () => undefined),
  startMock: vi.fn(async function (this: { state?: string }) {
    this.state = 'started';
  }),
  refreshDataMock: vi.fn(async function (this: { state?: string; __refreshedState?: string }) {
    if (typeof this.__refreshedState === 'string') {
      this.state = this.__refreshedState;
    }
  }),
  waitUntilStartedMock: vi.fn(async function (this: { state?: string }) {
    this.state = 'started';
  }),
  DaytonaCtor: class {
    create = createMock;
    get = getMock;
    [Symbol.asyncDispose] = disposeMock;
  },
}));

vi.mock('@daytona/sdk', () => ({
  Daytona: DaytonaCtor,
}));

import { DaytonaSandboxClient } from './daytona-sandbox-client.js';

const TARGET: DaytonaRemoteExecutionResolvedTarget = {
  id: 'daytona:main',
  profileId: 'daytona-main',
  profileName: 'Daytona Main',
  backendKind: 'daytona_sandbox',
  apiKey: 'daytona-key',
  apiUrl: 'https://app.daytona.io/api',
  language: 'typescript',
  networkMode: 'allow_all',
  allowedDomains: [],
  allowedCidrs: [],
};

function createSandboxRecord(state = 'started') {
  return {
    id: 'sandbox_123',
    state,
    __refreshedState: undefined as string | undefined,
    getWorkDir: getWorkDirMock,
    getUserHomeDir: getUserHomeDirMock,
    refreshData: refreshDataMock,
    fs: {
      createFolder: createFolderMock,
      uploadFiles: uploadFilesMock,
      setFilePermissions: setFilePermissionsMock,
      downloadFile: downloadFileMock,
    },
    process: {
      executeCommand: executeCommandMock,
    },
    waitUntilStarted: waitUntilStartedMock,
    start: startMock,
    delete: deleteMock,
  };
}

describe('DaytonaSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    getMock.mockReset();
    disposeMock.mockClear();
    getWorkDirMock.mockClear();
    getUserHomeDirMock.mockClear();
    createFolderMock.mockClear();
    uploadFilesMock.mockClear();
    setFilePermissionsMock.mockClear();
    executeCommandMock.mockClear();
    downloadFileMock.mockClear();
    deleteMock.mockClear();
    startMock.mockClear();
    refreshDataMock.mockClear();
    waitUntilStartedMock.mockClear();
  });

  it('retries sandbox creation without resources when Daytona rejects snapshot-backed resources', async () => {
    createMock
      .mockRejectedValueOnce(new Error('Cannot specify Sandbox resources when using a snapshot'))
      .mockResolvedValueOnce(createSandboxRecord());

    const client = new DaytonaSandboxClient();
    const session = await client.createSandbox({
      target: {
        ...TARGET,
        defaultVcpus: 4,
        snapshot: 'snapshot-main',
      },
      timeoutMs: 30_000,
    });

    expect(session.sandboxId).toBe('sandbox_123');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      language: 'typescript',
      snapshot: 'snapshot-main',
      resources: { cpu: 4 },
    }), { timeout: 30 });
    expect(createMock).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      resources: expect.anything(),
    }), { timeout: 30 });
  });

  it('uses Daytona defaults when no explicit cpu override is configured', async () => {
    createMock.mockResolvedValueOnce(createSandboxRecord());

    const client = new DaytonaSandboxClient();
    await client.createSandbox({
      target: TARGET,
      timeoutMs: 15_000,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(expect.not.objectContaining({
      resources: expect.anything(),
    }), { timeout: 15 });
  });

  it('fails closed when asked to use an unsupported domain allowlist', async () => {
    const client = new DaytonaSandboxClient();

    await expect(client.createSandbox({
      target: {
        ...TARGET,
        networkMode: 'domain_allowlist',
        allowedDomains: ['example.com'],
      },
      timeoutMs: 15_000,
    })).rejects.toThrow(/does not support domain network allowlists/i);

    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses the persisted workspace root hint for stopped sandboxes without querying toolbox metadata', async () => {
    getMock.mockResolvedValueOnce(createSandboxRecord('stopped'));

    const client = new DaytonaSandboxClient();
    const session = await client.getSandbox({
      target: TARGET,
      sandboxId: 'sandbox_123',
      remoteWorkspaceRootHint: '/home/daytona/guardian-workspace',
    });

    expect(session.workspaceRoot).toBe('/home/daytona/guardian-workspace');
    expect(getWorkDirMock).not.toHaveBeenCalled();
    expect(getUserHomeDirMock).not.toHaveBeenCalled();
  });

  it('refreshes the wrapped session state after start', async () => {
    const sandbox = createSandboxRecord('stopped');
    startMock.mockImplementationOnce(async function (this: { state?: string; __refreshedState?: string }) {
      this.state = 'starting';
      this.__refreshedState = 'started';
    });
    getMock.mockResolvedValueOnce(sandbox);

    const client = new DaytonaSandboxClient();
    const session = await client.getSandbox({
      target: TARGET,
      sandboxId: 'sandbox_123',
      remoteWorkspaceRootHint: '/home/daytona/guardian-workspace',
    });

    expect(session.state).toBe('stopped');
    await session.start(30);
    expect(session.state).toBe('started');
    expect(startMock).toHaveBeenCalledWith(30);
    expect(refreshDataMock).toHaveBeenCalled();
  });

  it('ignores already-existing nested directories during staging', async () => {
    const client = new DaytonaSandboxClient();
    const session = {
      sandboxId: 'sandbox_123',
      workspaceRoot: '/home/daytona/guardian-workspace',
      refreshData: vi.fn(async () => undefined),
      createFolder: vi.fn(async (directory: string) => {
        if (directory === '/home') {
          throw new Error('already exists');
        }
      }),
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

    await expect(client.ensureDirectories(session, [
      '/home/daytona/guardian-workspace/src/index.ts',
    ])).resolves.toBeUndefined();

    expect(session.createFolder).toHaveBeenCalledWith('/home', '755');
    expect(session.createFolder).toHaveBeenCalledWith('/home/daytona', '755');
    expect(session.createFolder).toHaveBeenCalledWith('/home/daytona/guardian-workspace', '755');
    expect(session.createFolder).toHaveBeenCalledWith('/home/daytona/guardian-workspace/src', '755');
  });
});
