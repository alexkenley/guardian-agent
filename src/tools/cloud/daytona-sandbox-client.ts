import { Daytona } from '@daytona/sdk';
import path from 'node:path';

import type { DaytonaRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const DEFAULT_API_URL = 'https://app.daytona.io/api';
const DEFAULT_LANGUAGE = 'typescript';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_VCPUS = 2;

export interface DaytonaSandboxSession {
  sandboxId: string;
  workspaceRoot: string;
  createFolder(path: string, mode?: string): Promise<void>;
  uploadFiles(files: Array<{ path: string; content: string | Uint8Array }>, timeoutSec?: number): Promise<void>;
  setFileMode(path: string, mode: number): Promise<void>;
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSec?: number,
  ): Promise<{ exitCode: number; result: string }>;
  readFileToBuffer(path: string, timeoutSec?: number): Promise<Buffer | null>;
  destroy(timeoutSec?: number): Promise<void>;
}

export interface DaytonaSandboxCreateInput {
  target: DaytonaRemoteExecutionResolvedTarget;
  timeoutMs?: number;
  vcpus?: number;
  runtime?: string;
}

export interface DaytonaSandboxClientOptions {
  sandboxFactory?: (input: DaytonaSandboxCreateInput) => Promise<DaytonaSandboxSession>;
}

function toTimeoutSec(timeoutMs: number | undefined): number {
  return Math.max(1, Math.ceil((timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000));
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(already exists|file exists|exist[s]?)\b/i.test(message);
}

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(not found|no such file|404)\b/i.test(message);
}

async function defaultSandboxFactory(input: DaytonaSandboxCreateInput): Promise<DaytonaSandboxSession> {
  const client = new Daytona({
    apiKey: input.target.apiKey,
    apiUrl: input.target.apiUrl ?? DEFAULT_API_URL,
    target: input.target.target,
  });

  const timeoutMs = Math.max(5_000, input.timeoutMs ?? input.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutSec = toTimeoutSec(timeoutMs);
  const cpu = Math.max(1, input.vcpus ?? input.target.defaultVcpus ?? DEFAULT_VCPUS);
  const createParams = {
    language: input.runtime ?? input.target.language ?? DEFAULT_LANGUAGE,
    ephemeral: true,
    networkBlockAll: input.target.networkMode === 'deny_all',
    networkAllowList: input.target.networkMode === 'cidr_allowlist' && input.target.allowedCidrs.length > 0
      ? input.target.allowedCidrs.join(',')
      : undefined,
    // The SDK runtime accepts `resources` here even though the snapshot overload omits it in the d.ts.
    resources: { cpu },
  };

  const sandbox = await client.create(createParams as never, { timeout: timeoutSec });
  const baseWorkDir = await sandbox.getWorkDir() ?? await sandbox.getUserHomeDir() ?? '/tmp';
  const workspaceRoot = path.posix.join(baseWorkDir.replace(/\\/g, '/'), 'guardian-workspace');

  try {
    await sandbox.fs.createFolder(workspaceRoot, '755');
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }

  return {
    sandboxId: sandbox.id,
    workspaceRoot,
    createFolder: async (folderPath, mode = '755') => {
      try {
        await sandbox.fs.createFolder(folderPath, mode);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    },
    uploadFiles: async (files, uploadTimeoutSec = timeoutSec) => {
      await sandbox.fs.uploadFiles(
        files.map((file) => ({
          source: typeof file.content === 'string' ? Buffer.from(file.content) : Buffer.from(file.content),
          destination: file.path,
        })),
        uploadTimeoutSec,
      );
    },
    setFileMode: async (filePath, mode) => {
      await sandbox.fs.setFilePermissions(filePath, { mode: (mode & 0o777).toString(8) });
    },
    executeCommand: async (command, cwd, env, commandTimeoutSec = timeoutSec) => {
      const result = await sandbox.process.executeCommand(command, cwd, env, commandTimeoutSec);
      return {
        exitCode: result.exitCode,
        result: result.result,
      };
    },
    readFileToBuffer: async (filePath, downloadTimeoutSec = timeoutSec) => {
      try {
        return await sandbox.fs.downloadFile(filePath, downloadTimeoutSec);
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
    destroy: async (deleteTimeoutSec = timeoutSec) => {
      try {
        await sandbox.delete(deleteTimeoutSec);
      } finally {
        await client[Symbol.asyncDispose]?.().catch(() => undefined);
      }
    },
  };
}

export class DaytonaSandboxClient {
  private readonly sandboxFactory: (input: DaytonaSandboxCreateInput) => Promise<DaytonaSandboxSession>;

  constructor(options: DaytonaSandboxClientOptions = {}) {
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
  }

  async createSandbox(input: DaytonaSandboxCreateInput): Promise<DaytonaSandboxSession> {
    return this.sandboxFactory(input);
  }

  async ensureDirectories(session: DaytonaSandboxSession, filePaths: string[]): Promise<void> {
    const directories = new Set<string>();
    for (const filePath of filePaths) {
      const segments = filePath.split('/').filter(Boolean);
      let current = filePath.startsWith('/') ? '' : '.';
      for (const segment of segments.slice(0, -1)) {
        current = current === '.'
          ? segment
          : `${current}/${segment}`;
        directories.add(current.startsWith('/') || current === '.' ? current : `/${current}`);
      }
    }
    const ordered = [...directories].sort((left, right) => left.split('/').length - right.split('/').length);
    for (const directory of ordered) {
      await session.createFolder(directory, '755');
    }
  }
}
