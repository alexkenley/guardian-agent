import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { URL } from 'node:url';

import type { VercelRemoteExecutionResolvedTarget } from '../../runtime/remote-execution/types.js';

const DEFAULT_RUNTIME = 'node24';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_VCPUS = 2;
const SUPPORTED_API_BASE_URL = 'https://api.vercel.com/';

export interface VercelSandboxSession {
  sandboxId: string;
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
}

export interface VercelSandboxCreateInput {
  target: VercelRemoteExecutionResolvedTarget;
  timeoutMs?: number;
  vcpus?: number;
  runtime?: string;
}

export interface VercelSandboxClientOptions {
  sandboxFactory?: (input: VercelSandboxCreateInput) => Promise<VercelSandboxSession>;
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
  };
}

export class VercelSandboxClient {
  private readonly sandboxFactory: (input: VercelSandboxCreateInput) => Promise<VercelSandboxSession>;

  constructor(options: VercelSandboxClientOptions = {}) {
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
  }

  async createSandbox(input: VercelSandboxCreateInput): Promise<VercelSandboxSession> {
    return this.sandboxFactory(input);
  }

  async ensureDirectories(session: VercelSandboxSession, filePaths: string[]): Promise<void> {
    const directories = new Set<string>();
    for (const filePath of filePaths) {
      const segments = filePath.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments.slice(0, -1)) {
        current = `${current}/${segment}`;
        directories.add(current);
      }
    }
    const ordered = [...directories].sort((left, right) => left.split('/').length - right.split('/').length);
    for (const directory of ordered) {
      await session.mkDir(directory);
    }
  }
}
