import { Daytona } from '@daytona/sdk';
import path from 'node:path';

import type { DaytonaRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';
import type { RemoteExecutionLeaseMode } from '../../runtime/remote-execution/types.js';

const DEFAULT_API_URL = 'https://app.daytona.io/api';
const DEFAULT_LANGUAGE = 'typescript';
const DEFAULT_TIMEOUT_MS = 300_000;

export interface DaytonaSandboxSession {
  sandboxId: string;
  workspaceRoot: string;
  state?: string;
  refreshData(): Promise<void>;
  createFolder(path: string, mode?: string): Promise<void>;
  uploadFiles(files: Array<{ path: string; content: string | Uint8Array }>, timeoutSec?: number): Promise<void>;
  setFileMode(path: string, mode: number): Promise<void>;
  waitUntilStarted(timeoutSec?: number): Promise<void>;
  start(timeoutSec?: number): Promise<void>;
  stop(timeoutSec?: number, force?: boolean): Promise<void>;
  refreshActivity(): Promise<void>;
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
  leaseMode?: RemoteExecutionLeaseMode;
}

export interface DaytonaSandboxGetInput {
  target: DaytonaRemoteExecutionResolvedTarget;
  sandboxId: string;
  timeoutMs?: number;
  remoteWorkspaceRootHint?: string;
}

export interface DaytonaSandboxClientOptions {
  sandboxFactory?: (input: DaytonaSandboxCreateInput) => Promise<DaytonaSandboxSession>;
  sandboxLookup?: (input: DaytonaSandboxGetInput) => Promise<DaytonaSandboxSession>;
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

function isForbiddenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(forbidden|permission|403|unauthorized|401|scope|scoped)\b/i.test(message);
}

function isSnapshotResourcesConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot specify sandbox resources when using a snapshot/i.test(message);
}

function normalizeWorkspaceRootHint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\\/g, '/') : undefined;
}

function isSandboxToolboxReady(state: string | undefined): boolean {
  const normalized = state?.trim().toLowerCase();
  if (!normalized) return true;
  return /\b(started|running|ready|starting)\b/.test(normalized);
}

async function createDaytonaSandbox(
  client: Daytona,
  params: Record<string, unknown>,
  timeoutSec: number,
) {
  try {
    return await client.create(params as never, { timeout: timeoutSec });
  } catch (error) {
    if (isForbiddenError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Daytona sandbox creation failed (permissions/auth). Ensure your API key is valid and has the necessary permissions. Details: ${message}`);
    }
    throw error;
  }
}

function buildWrappedDaytonaSandbox(
  sandbox: Awaited<ReturnType<Daytona['create']>>,
  client: Daytona,
  timeoutSec: number,
  workspaceRoot: string,
): DaytonaSandboxSession {
  const session: DaytonaSandboxSession = {
    sandboxId: sandbox.id,
    workspaceRoot,
    state: sandbox.state,
    refreshData: async () => {
      if (typeof sandbox.refreshData === 'function') {
        await sandbox.refreshData();
      }
      session.state = sandbox.state;
    },
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
    waitUntilStarted: async (waitTimeoutSec = timeoutSec) => {
      if (typeof sandbox.waitUntilStarted === 'function') {
        await sandbox.waitUntilStarted(waitTimeoutSec);
      }
      if (typeof sandbox.refreshData === 'function') {
        await sandbox.refreshData().catch(() => undefined);
      }
      session.state = sandbox.state;
    },
    start: async (startTimeoutSec = timeoutSec) => {
      await sandbox.start(startTimeoutSec);
      if (typeof sandbox.refreshData === 'function') {
        await sandbox.refreshData().catch(() => undefined);
      }
      session.state = sandbox.state;
    },
    stop: async (stopTimeoutSec = timeoutSec, force = false) => {
      if (typeof sandbox.stop === 'function') {
        await sandbox.stop(stopTimeoutSec, force);
        if (typeof sandbox.refreshData === 'function') {
          await sandbox.refreshData().catch(() => undefined);
        }
        session.state = sandbox.state;
      }
    },
    refreshActivity: async () => {
      await sandbox.refreshActivity();
      session.state = sandbox.state;
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
  return session;
}

async function resolveDaytonaWorkspaceRoot(input: {
  sandbox: Awaited<ReturnType<Daytona['create']>>;
  remoteWorkspaceRootHint?: string;
}): Promise<string> {
  const hintedRoot = normalizeWorkspaceRootHint(input.remoteWorkspaceRootHint);
  if (!isSandboxToolboxReady(input.sandbox.state)) {
    return hintedRoot ?? '/tmp/guardian-workspace';
  }
  try {
    const baseWorkDir = await input.sandbox.getWorkDir() ?? await input.sandbox.getUserHomeDir() ?? '/tmp';
    return path.posix.join(baseWorkDir.replace(/\\/g, '/'), 'guardian-workspace');
  } catch (error) {
    if (hintedRoot) {
      return hintedRoot;
    }
    throw error;
  }
}

async function defaultSandboxFactory(input: DaytonaSandboxCreateInput): Promise<DaytonaSandboxSession> {
  const client = new Daytona({
    apiKey: input.target.apiKey,
    apiUrl: input.target.apiUrl ?? DEFAULT_API_URL,
    target: input.target.target,
  });

  const timeoutMs = Math.max(5_000, input.timeoutMs ?? input.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutSec = toTimeoutSec(timeoutMs);
  const requestedCpu = input.vcpus ?? input.target.defaultVcpus;
  const leaseMode = input.leaseMode ?? 'ephemeral';
  const baseCreateParams = {
    language: input.runtime ?? input.target.language ?? DEFAULT_LANGUAGE,
    snapshot: input.target.snapshot,
    ephemeral: leaseMode !== 'managed',
    autoStopInterval: leaseMode === 'managed' ? 0 : undefined,
    autoDeleteInterval: leaseMode === 'managed' ? -1 : undefined,
    networkBlockAll: input.target.networkMode === 'deny_all',
    networkAllowList: input.target.networkMode === 'cidr_allowlist' && input.target.allowedCidrs.length > 0
      ? input.target.allowedCidrs.join(',')
      : undefined,
  };
  const createParamsWithResources = typeof requestedCpu === 'number' && Number.isFinite(requestedCpu)
    ? {
        ...baseCreateParams,
        // The SDK runtime accepts `resources` here even though the snapshot overload omits it in the d.ts.
        resources: { cpu: Math.max(1, requestedCpu) },
      }
    : baseCreateParams;

  let sandbox;
  try {
    sandbox = await createDaytonaSandbox(client, createParamsWithResources, timeoutSec);
  } catch (error) {
    if (createParamsWithResources !== baseCreateParams && isSnapshotResourcesConflictError(error)) {
      sandbox = await createDaytonaSandbox(client, baseCreateParams, timeoutSec);
    } else {
      throw error;
    }
  }
  const baseWorkDir = await sandbox.getWorkDir() ?? await sandbox.getUserHomeDir() ?? '/tmp';
  const workspaceRoot = path.posix.join(baseWorkDir.replace(/\\/g, '/'), 'guardian-workspace');

  try {
    await sandbox.fs.createFolder(workspaceRoot, '755');
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }

  return buildWrappedDaytonaSandbox(sandbox, client, timeoutSec, workspaceRoot);
}

async function defaultSandboxLookup(input: DaytonaSandboxGetInput): Promise<DaytonaSandboxSession> {
  const client = new Daytona({
    apiKey: input.target.apiKey,
    apiUrl: input.target.apiUrl ?? DEFAULT_API_URL,
    target: input.target.target,
  });
  const timeoutMs = Math.max(5_000, input.timeoutMs ?? input.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutSec = toTimeoutSec(timeoutMs);
  const sandbox = await client.get(input.sandboxId);
  if (typeof sandbox.refreshData === 'function') {
    await sandbox.refreshData().catch(() => undefined);
  }
  const workspaceRoot = await resolveDaytonaWorkspaceRoot({
    sandbox,
    remoteWorkspaceRootHint: input.remoteWorkspaceRootHint,
  });
  return buildWrappedDaytonaSandbox(sandbox, client, timeoutSec, workspaceRoot);
}

export class DaytonaSandboxClient {
  private readonly sandboxFactory: (input: DaytonaSandboxCreateInput) => Promise<DaytonaSandboxSession>;
  private readonly sandboxLookup: (input: DaytonaSandboxGetInput) => Promise<DaytonaSandboxSession>;

  constructor(options: DaytonaSandboxClientOptions = {}) {
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
    this.sandboxLookup = options.sandboxLookup ?? defaultSandboxLookup;
  }

  async createSandbox(input: DaytonaSandboxCreateInput): Promise<DaytonaSandboxSession> {
    return this.sandboxFactory(input);
  }

  async getSandbox(input: DaytonaSandboxGetInput): Promise<DaytonaSandboxSession> {
    return this.sandboxLookup(input);
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
      try {
        await session.createFolder(directory, '755');
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }
  }
}
