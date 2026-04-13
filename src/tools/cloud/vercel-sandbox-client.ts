import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { URL } from 'node:url';

import type { VercelRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const DEFAULT_RUNTIME = 'node24';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_VCPUS = 2;
const SUPPORTED_API_BASE_URL = 'https://api.vercel.com/';
const VERCEL_DIRECTORY_PREFIXES = new Set(['/vercel', '/vercel/sandbox']);

export interface VercelSandboxSession {
  sandboxId: string;
  status?: string;
  mkDir(path: string): Promise<void>;
  writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void>;
  runCommand(input: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFileToBuffer(input: { path: string; cwd?: string }): Promise<Buffer | null>;
  stop(blocking?: boolean): Promise<void>;
  extendTimeout(durationMs: number): Promise<void>;
}

export interface VercelSandboxCreateInput {
  target: VercelRemoteExecutionResolvedTarget;
  timeoutMs?: number;
  vcpus?: number;
  runtime?: string;
}

export interface VercelSandboxGetInput {
  target: VercelRemoteExecutionResolvedTarget;
  sandboxId: string;
}

export interface VercelSandboxClientOptions {
  sandboxFactory?: (input: VercelSandboxCreateInput) => Promise<VercelSandboxSession>;
  sandboxLookup?: (input: VercelSandboxGetInput) => Promise<VercelSandboxSession>;
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(already exists|file exists|exist[s]?)\b/i.test(message);
}

function buildNetworkPolicy(target: VercelRemoteExecutionResolvedTarget): NetworkPolicy {
  if (target.networkMode === 'deny_all') return 'deny-all';
  if (target.networkMode === 'domain_allowlist') {
    return { allow: [...target.allowedDomains] };
  }
  return 'allow-all';
}

function assertSupportedApiBaseUrl(apiBaseUrl: string | undefined): void {
  if (!apiBaseUrl?.trim()) return;
  const normalized = new URL(apiBaseUrl).toString();
  if (normalized !== SUPPORTED_API_BASE_URL) {
    throw new Error(
      `Vercel sandbox execution currently supports only '${SUPPORTED_API_BASE_URL}' as the API base URL.`,
    );
  }
}

async function defaultSandboxFactory(input: VercelSandboxCreateInput): Promise<VercelSandboxSession> {
  assertSupportedApiBaseUrl(input.target.apiBaseUrl);
  const sandbox = await Sandbox.create({
    token: input.target.token,
    teamId: input.target.teamId,
    projectId: input.target.projectId,
    timeout: Math.max(5_000, input.timeoutMs ?? input.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    resources: { vcpus: Math.max(1, input.vcpus ?? input.target.defaultVcpus ?? DEFAULT_VCPUS) },
    runtime: input.runtime ?? DEFAULT_RUNTIME,
    networkPolicy: buildNetworkPolicy(input.target),
  });
  return {
    sandboxId: sandbox.sandboxId,
    status: sandbox.status,
    mkDir: async (path) => {
      await sandbox.mkDir(path);
    },
    writeFiles: async (files) => {
      await sandbox.writeFiles(files);
    },
    runCommand: async (command) => {
      const result = await sandbox.runCommand({
        cmd: command.cmd,
        args: command.args,
        cwd: command.cwd,
        env: command.env,
      });
      return {
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    },
    readFileToBuffer: async (file) => sandbox.readFileToBuffer(file),
    stop: async (blocking) => {
      await sandbox.stop({ blocking });
    },
    extendTimeout: async (durationMs) => {
      await sandbox.extendTimeout(durationMs);
    },
  };
}

async function defaultSandboxLookup(input: VercelSandboxGetInput): Promise<VercelSandboxSession> {
  assertSupportedApiBaseUrl(input.target.apiBaseUrl);
  const sandbox = await Sandbox.get({
    sandboxId: input.sandboxId,
    token: input.target.token,
    teamId: input.target.teamId,
    projectId: input.target.projectId,
  });
  return {
    sandboxId: sandbox.sandboxId,
    status: sandbox.status,
    mkDir: async (path) => {
      await sandbox.mkDir(path);
    },
    writeFiles: async (files) => {
      await sandbox.writeFiles(files);
    },
    runCommand: async (command) => {
      const result = await sandbox.runCommand({
        cmd: command.cmd,
        args: command.args,
        cwd: command.cwd,
        env: command.env,
      });
      return {
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    },
    readFileToBuffer: async (file) => sandbox.readFileToBuffer(file),
    stop: async (blocking) => {
      await sandbox.stop({ blocking });
    },
    extendTimeout: async (durationMs) => {
      await sandbox.extendTimeout(durationMs);
    },
  };
}

export class VercelSandboxClient {
  private readonly sandboxFactory: (input: VercelSandboxCreateInput) => Promise<VercelSandboxSession>;
  private readonly sandboxLookup: (input: VercelSandboxGetInput) => Promise<VercelSandboxSession>;

  constructor(options: VercelSandboxClientOptions = {}) {
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
    this.sandboxLookup = options.sandboxLookup ?? defaultSandboxLookup;
  }

  async createSandbox(input: VercelSandboxCreateInput): Promise<VercelSandboxSession> {
    return this.sandboxFactory(input);
  }

  async getSandbox(input: VercelSandboxGetInput): Promise<VercelSandboxSession> {
    return this.sandboxLookup(input);
  }

  async ensureDirectories(session: VercelSandboxSession, filePaths: string[]): Promise<void> {
    const directories = new Set<string>();
    for (const filePath of filePaths) {
      const segments = filePath.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments.slice(0, -1)) {
        current = `${current}/${segment}`;
        if (!VERCEL_DIRECTORY_PREFIXES.has(current)) {
          directories.add(current);
        }
      }
    }
    const ordered = [...directories].sort((left, right) => left.split('/').length - right.split('/').length);
    for (const directory of ordered) {
      try {
        await session.mkDir(directory);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }
  }
}
