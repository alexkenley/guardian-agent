import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { VercelSandboxClient } from '../../../tools/cloud/vercel-sandbox-client.js';
import type {
  RemoteExecutionArtifact,
  RemoteExecutionLease,
  RemoteExecutionLeaseInspectionResult,
  RemoteExecutionLeaseCreateRequest,
  RemoteExecutionPreparedRequest,
  RemoteExecutionProbeResult,
  RemoteExecutionProvider,
  RemoteExecutionProviderLease,
  VercelRemoteExecutionResolvedTarget,
  RemoteExecutionRunResult,
} from '../types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const VERCEL_WRITABLE_WORKSPACE_ROOT = '/vercel/sandbox';
const DEFAULT_ARTIFACT_MAX_BYTES = 500_000;
const MAX_VERCEL_ERROR_TEXT_CHARS = 800;
const DELETE_PATH_CHUNK_SIZE = 100;

export interface VercelRemoteExecutionProviderOptions {
  client?: VercelSandboxClient;
}

function assertVercelTarget(target: RemoteExecutionPreparedRequest['target']): VercelRemoteExecutionResolvedTarget {
  if (target.backendKind !== 'vercel_sandbox') {
    throw new Error(`Vercel provider cannot execute backend '${target.backendKind}'.`);
  }
  return target;
}

function normalizeRemoteRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function toRemoteCwd(workspaceRoot: string, cwd: string): string {
  const relativeCwd = normalizeRemoteRelativePath(path.relative(workspaceRoot, cwd));
  return relativeCwd
    ? path.posix.join(REMOTE_WORKSPACE_ROOT, relativeCwd)
    : REMOTE_WORKSPACE_ROOT;
}

function mapToSandboxPath(remotePath: string): string {
  const normalized = normalizeRemoteRelativePath(remotePath);
  if (normalized === REMOTE_WORKSPACE_ROOT) {
    return VERCEL_WRITABLE_WORKSPACE_ROOT;
  }
  if (normalized.startsWith(`${REMOTE_WORKSPACE_ROOT}/`)) {
    return path.posix.join(VERCEL_WRITABLE_WORKSPACE_ROOT, normalized.slice(REMOTE_WORKSPACE_ROOT.length + 1));
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  return path.posix.join(VERCEL_WRITABLE_WORKSPACE_ROOT, normalized);
}

function resolveArtifactPath(actualRemoteCwd: string, artifactPath: string): string {
  const normalized = normalizeRemoteRelativePath(artifactPath);
  if (path.posix.isAbsolute(normalized)) {
    return normalized.startsWith(REMOTE_WORKSPACE_ROOT)
      ? mapToSandboxPath(normalized)
      : normalized;
  }
  return path.posix.join(actualRemoteCwd, normalized);
}

function buildCwdSentinelPath(actualRemoteCwd: string): string {
  return path.posix.join(actualRemoteCwd, '.guardian-cwd');
}

function buildRemoteEnv(env: Record<string, string> | undefined): Record<string, string> {
  return {
    CI: 'true',
    GUARDIAN_REMOTE_SANDBOX: '1',
    ...(env ?? {}),
  };
}

function isTimeoutLikeError(error: string): boolean {
  return /\b(timeout|timed out|abort|aborted)\b/i.test(error);
}

function truncateDiagnostic(value: string, maxChars: number = MAX_VERCEL_ERROR_TEXT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function collectVercelApiErrorDetails(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const details: string[] = [];
  const code = typeof record.code === 'string' && record.code.trim()
    ? record.code.trim()
    : '';
  const message = typeof record.message === 'string' && record.message.trim()
    ? record.message.trim()
    : typeof record.error === 'string' && record.error.trim()
      ? record.error.trim()
      : '';
  if (code) details.push(`code=${code}`);
  if (message) details.push(message);
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    details.push(...collectVercelApiErrorDetails(record.error));
  }
  if (Array.isArray(record.issues)) {
    for (const issue of record.issues) {
      if (typeof issue === 'string' && issue.trim()) {
        details.push(issue.trim());
        continue;
      }
      if (issue && typeof issue === 'object') {
        details.push(...collectVercelApiErrorDetails(issue));
      }
    }
  }
  return [...new Set(details.filter(Boolean))];
}

function formatVercelExecutionError(
  error: unknown,
  target: VercelRemoteExecutionResolvedTarget,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const details: string[] = [];
  const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const response = errorRecord?.response && typeof errorRecord.response === 'object'
    ? errorRecord.response as { status?: unknown; statusText?: unknown }
    : null;
  const status = typeof response?.status === 'number' ? response.status : null;
  const statusText = typeof response?.statusText === 'string' && response.statusText.trim()
    ? response.statusText.trim()
    : '';
  if (status !== null) {
    details.push(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
  }
  const apiDetails = collectVercelApiErrorDetails(errorRecord?.json);
  if (apiDetails.length > 0) {
    details.push(...apiDetails);
  } else if (typeof errorRecord?.text === 'string' && errorRecord.text.trim()) {
    details.push(truncateDiagnostic(errorRecord.text));
  }
  details.push(
    `teamId=${target.teamId}`,
    `projectId=${target.projectId}`,
    `networkMode=${target.networkMode}`,
  );
  const uniqueDetails = [...new Set(details.filter(Boolean))];
  return uniqueDetails.length > 0
    ? `${message}\n${uniqueDetails.map((entry) => `- ${truncateDiagnostic(entry)}`).join('\n')}`
    : message;
}

function isReusableVercelSandboxStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return true;
  return !/\b(stopped|stopping|expired|delet(?:ed|ing)|terminat(?:ed|ing)|failed|error|dead)\b/.test(normalized);
}

function encodeArtifact(pathValue: string, buffer: Buffer, maxBytes: number): RemoteExecutionArtifact {
  const truncated = buffer.length > maxBytes;
  const output = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const utf8 = output.toString('utf8');
  const encoding = Buffer.from(utf8, 'utf8').equals(output) ? 'utf8' as const : 'base64' as const;
  return {
    path: pathValue,
    encoding,
    content: encoding === 'utf8' ? utf8 : output.toString('base64'),
    sizeBytes: buffer.length,
    truncated,
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function assertVercelLease(lease: RemoteExecutionProviderLease) {
  const session = lease.state;
  if (!session) {
    throw new Error(`Vercel lease '${lease.id}' does not have an active sandbox session.`);
  }
  return session as Awaited<ReturnType<VercelSandboxClient['createSandbox']>>;
}

export class VercelRemoteExecutionProvider implements RemoteExecutionProvider {
  readonly backendKind = 'vercel_sandbox' as const;
  readonly capabilities = {
    reconnectExisting: true,
    restartStoppedSandbox: false,
  } as const;
  private readonly client: VercelSandboxClient;

  constructor(options: VercelRemoteExecutionProviderOptions = {}) {
    this.client = options.client ?? new VercelSandboxClient();
  }

  async probe(targetInput: RemoteExecutionPreparedRequest['target']): Promise<RemoteExecutionProbeResult> {
    const target = assertVercelTarget(targetInput);
    const startedAt = Date.now();
    let session: Awaited<ReturnType<VercelSandboxClient['createSandbox']>> | undefined;
    try {
      session = await this.client.createSandbox({
        target,
        timeoutMs: Math.min(target.defaultTimeoutMs ?? 30_000, 30_000),
      });
      const result = await session.runCommand({
        cmd: 'pwd',
        args: [],
      });
      const checkedAt = Date.now();
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: result.exitCode === 0 ? 'healthy' : 'unreachable',
        reason: result.exitCode === 0
          ? 'Vercel sandbox probe succeeded.'
          : truncateDiagnostic(result.stderr || result.stdout || 'Vercel sandbox probe failed.'),
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: session.sandboxId,
      };
    } catch (error) {
      const checkedAt = Date.now();
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: 'unreachable',
        reason: formatVercelExecutionError(error, target),
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: session?.sandboxId,
      };
    } finally {
      if (session) {
        await session.stop(true).catch(() => undefined);
      }
    }
  }

  async inspectLease(
    targetInput: RemoteExecutionPreparedRequest['target'],
    existingLease: RemoteExecutionLease,
  ): Promise<RemoteExecutionLeaseInspectionResult> {
    const target = assertVercelTarget(targetInput);
    const startedAt = Date.now();
    try {
      const session = await this.client.getSandbox({
        target,
        sandboxId: existingLease.sandboxId,
      });
      const checkedAt = Date.now();
      const reusable = isReusableVercelSandboxStatus(session.status);
      const quotedStatus = session.status?.trim()
        ? ` (status: ${session.status.trim()})`
        : '';
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: reusable ? 'healthy' : 'unreachable',
        reason: reusable
          ? `Managed Vercel sandbox is reachable${quotedStatus}.`
          : `Managed Vercel sandbox is no longer reusable${quotedStatus}.`,
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: session.sandboxId,
        remoteWorkspaceRoot: VERCEL_WRITABLE_WORKSPACE_ROOT,
      };
    } catch (error) {
      const checkedAt = Date.now();
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: 'unreachable',
        reason: formatVercelExecutionError(error, target),
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: existingLease.sandboxId,
        remoteWorkspaceRoot: existingLease.remoteWorkspaceRoot,
      };
    }
  }

  async createLease(request: RemoteExecutionLeaseCreateRequest): Promise<RemoteExecutionProviderLease> {
    const target = assertVercelTarget(request.target);
    const session = await this.client.createSandbox({
      target,
      timeoutMs: request.timeoutMs,
      vcpus: request.vcpus,
      runtime: request.runtime,
    });
    const acquiredAt = Date.now();
    return {
      id: randomUUID(),
      targetId: target.id,
      backendKind: target.backendKind,
      profileId: target.profileId,
      profileName: target.profileName,
      sandboxId: session.sandboxId,
      localWorkspaceRoot: request.localWorkspaceRoot,
      remoteWorkspaceRoot: VERCEL_WRITABLE_WORKSPACE_ROOT,
      codeSessionId: request.codeSessionId,
      acquiredAt,
      lastUsedAt: acquiredAt,
      expiresAt: acquiredAt,
      runtime: request.runtime,
      vcpus: request.vcpus,
      trackedRemotePaths: [],
      leaseMode: request.leaseMode ?? 'ephemeral',
      state: session,
    };
  }

  async resumeLease(
    targetInput: RemoteExecutionPreparedRequest['target'],
    existingLease: RemoteExecutionLease,
  ): Promise<RemoteExecutionProviderLease> {
    const target = assertVercelTarget(targetInput);
    const session = await this.client.getSandbox({
      target,
      sandboxId: existingLease.sandboxId,
    });
    const extensionMs = Math.max(5_000, target.defaultTimeoutMs ?? 300_000);
    await session.extendTimeout(extensionMs).catch(() => undefined);
    const acquiredAt = Date.now();
    return {
      ...existingLease,
      acquiredAt,
      lastUsedAt: acquiredAt,
      expiresAt: acquiredAt,
      trackedRemotePaths: Array.isArray(existingLease.trackedRemotePaths)
        ? [...existingLease.trackedRemotePaths]
        : [],
      leaseMode: existingLease.leaseMode,
      state: session,
    };
  }

  async runWithLease(
    lease: RemoteExecutionProviderLease,
    request: RemoteExecutionPreparedRequest,
  ): Promise<RemoteExecutionRunResult> {
    const target = assertVercelTarget(request.target);
    const session = assertVercelLease(lease);
    const startedAt = Date.now();
    const remoteCwd = toRemoteCwd(request.workspaceRoot, request.cwd);
    const actualRemoteCwd = mapToSandboxPath(remoteCwd);
    const stagedBytes = request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0);
    const currentRemotePaths = request.stagedFiles.map((file) => file.remotePath);
    const currentRemotePathSet = new Set(currentRemotePaths);
    const removedRemotePaths = lease.trackedRemotePaths.filter((filePath) => !currentRemotePathSet.has(filePath));
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    let status: RemoteExecutionRunResult['status'] = 'failed';
    let artifactFiles: RemoteExecutionArtifact[] = [];

    try {
      await session.extendTimeout(Math.max(5_000, request.timeoutMs ?? target.defaultTimeoutMs ?? 300_000))
        .catch(() => undefined);
      if (removedRemotePaths.length > 0) {
        request.onProgress?.(`Removing ${removedRemotePaths.length} stale files from remote sandbox...`);
        await this.deleteTrackedFiles(
          session,
          removedRemotePaths.map((filePath) => mapToSandboxPath(filePath)),
        );
      }

      const stagedFiles = request.stagedFiles.map((file) => ({
        ...file,
        actualPath: mapToSandboxPath(file.remotePath),
      }));

      request.onProgress?.(`Staging ${stagedFiles.length} files to remote sandbox...`);
      await this.client.ensureDirectories(
        session,
        [
          ...stagedFiles.map((file) => file.actualPath),
          buildCwdSentinelPath(actualRemoteCwd),
        ],
      );
      await session.writeFiles(stagedFiles.map((file) => ({
        path: file.actualPath,
        content: file.content,
        ...(typeof file.mode === 'number' ? { mode: file.mode } : {}),
      })));

      const command = request.command.execMode === 'shell_fallback'
        ? {
            cmd: 'bash',
            args: ['-lc', request.command.requestedCommand],
            cwd: actualRemoteCwd,
            env: buildRemoteEnv(request.env),
          }
        : {
            cmd: request.command.entryCommand,
            args: request.command.args,
            cwd: actualRemoteCwd,
            env: buildRemoteEnv(request.env),
          };

      request.onProgress?.(`Executing remote command: ${request.command.requestedCommand}`);
      const result = await session.runCommand(command);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      status = result.exitCode === 0 ? 'succeeded' : 'failed';

      const artifactPaths = Array.isArray(request.artifactPaths) ? request.artifactPaths : [];
      artifactFiles = [];
      if (artifactPaths.length > 0) {
        request.onProgress?.(`Downloading ${artifactPaths.length} artifacts from remote sandbox...`);
      }
      for (const artifactPath of artifactPaths) {
        const trimmed = artifactPath.trim();
        if (!trimmed) continue;
        const buffer = await session.readFileToBuffer({
          path: resolveArtifactPath(actualRemoteCwd, trimmed),
          cwd: actualRemoteCwd,
        });
        if (!buffer) continue;
        artifactFiles.push(encodeArtifact(trimmed, buffer, DEFAULT_ARTIFACT_MAX_BYTES));
      }
      lease.trackedRemotePaths = [...currentRemotePaths];
    } catch (error) {
      stderr = formatVercelExecutionError(error, target);
      status = isTimeoutLikeError(stderr) ? 'timed_out' : 'failed';
    }

    const completedAt = Date.now();
    return {
      targetId: request.target.id,
      backendKind: target.backendKind,
      profileId: target.profileId,
      profileName: target.profileName,
      requestedCommand: request.command.requestedCommand,
      status,
      sandboxId: session.sandboxId,
      exitCode,
      stdout,
      stderr,
      durationMs: completedAt - startedAt,
      startedAt,
      completedAt,
      networkMode: target.networkMode,
      allowedDomains: [...(target.allowedDomains ?? [])],
      allowedCidrs: [...(target.allowedCidrs ?? [])],
      stagedFiles: request.stagedFiles.length,
      stagedBytes,
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
      artifactFiles,
    };
  }

  async releaseLease(lease: RemoteExecutionProviderLease): Promise<void> {
    const session = assertVercelLease(lease);
    await session.stop(true);
  }

  async run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult> {
    const target = assertVercelTarget(request.target);
    const startedAt = Date.now();
    let lease: RemoteExecutionProviderLease | undefined;
    try {
      lease = await this.createLease({
        target,
        localWorkspaceRoot: request.workspaceRoot,
        codeSessionId: request.codeSessionId,
        timeoutMs: request.timeoutMs,
        vcpus: request.vcpus,
        runtime: request.runtime,
      });
      const result = await this.runWithLease(lease, request);
      return {
        ...result,
        leaseId: lease.id,
        leaseScope: request.codeSessionId ? 'code_session' : 'ephemeral',
        leaseReused: false,
      };
    } catch (error) {
      const completedAt = Date.now();
      const stderr = formatVercelExecutionError(error, target);
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        requestedCommand: request.command.requestedCommand,
        status: isTimeoutLikeError(stderr) ? 'timed_out' : 'failed',
        sandboxId: lease?.sandboxId,
        stdout: '',
        stderr,
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
        networkMode: target.networkMode,
        allowedDomains: [...(target.allowedDomains ?? [])],
        allowedCidrs: [...(target.allowedCidrs ?? [])],
        stagedFiles: request.stagedFiles.length,
        stagedBytes: request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0),
        workspaceRoot: request.workspaceRoot,
        cwd: request.cwd,
        artifactFiles: [],
      };
    } finally {
      if (lease) {
        await this.releaseLease(lease).catch(() => undefined);
      }
    }
  }

  private async deleteTrackedFiles(
    session: Awaited<ReturnType<VercelSandboxClient['createSandbox']>>,
    filePaths: string[],
  ): Promise<void> {
    for (const chunk of chunkItems(filePaths, DELETE_PATH_CHUNK_SIZE)) {
      await session.runCommand({
        cmd: 'bash',
        args: ['-lc', `rm -f -- ${chunk.map(quoteShellArg).join(' ')}`],
      });
    }
  }
}
