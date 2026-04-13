import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaytonaRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const {
  createMock,
  disposeMock,
  getWorkDirMock,
  getUserHomeDirMock,
  createFolderMock,
  uploadFilesMock,
  setFilePermissionsMock,
  executeCommandMock,
  downloadFileMock,
  deleteMock,
  DaytonaCtor,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  disposeMock: vi.fn(async () => undefined),
  getWorkDirMock: vi.fn(async () => '/home/daytona'),
  getUserHomeDirMock: vi.fn(async () => '/home/daytona'),
  createFolderMock: vi.fn(async () => undefined),
  uploadFilesMock: vi.fn(async () => undefined),
  setFilePermissionsMock: vi.fn(async () => undefined),
  executeCommandMock: vi.fn(async () => ({ exitCode: 0, result: '' })),
  downloadFileMock: vi.fn(async () => null),
  deleteMock: vi.fn(async () => undefined),
  DaytonaCtor: class {
    create = createMock;
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

function createSandboxRecord() {
  return {
    id: 'sandbox_123',
    getWorkDir: getWorkDirMock,
    getUserHomeDir: getUserHomeDirMock,
    fs: {
      createFolder: createFolderMock,
      uploadFiles: uploadFilesMock,
      setFilePermissions: setFilePermissionsMock,
      downloadFile: downloadFileMock,
    },
    process: {
      executeCommand: executeCommandMock,
    },
    delete: deleteMock,
  };
}

describe('DaytonaSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    disposeMock.mockClear();
    getWorkDirMock.mockClear();
    getUserHomeDirMock.mockClear();
    createFolderMock.mockClear();
    uploadFilesMock.mockClear();
    setFilePermissionsMock.mockClear();
    executeCommandMock.mockClear();
    downloadFileMock.mockClear();
    deleteMock.mockClear();
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
      },
      timeoutMs: 30_000,
    });

    expect(session.sandboxId).toBe('sandbox_123');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      language: 'typescript',
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
});
