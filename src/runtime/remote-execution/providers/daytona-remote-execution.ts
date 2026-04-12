import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { DaytonaSandboxClient } from '../../../tools/cloud/daytona-sandbox-client.js';
import type {
  DaytonaRemoteExecutionResolvedTarget,
  RemoteExecutionArtifact,
  RemoteExecutionPreparedRequest,
  RemoteExecutionProvider,
  RemoteExecutionRunResult,
} from '../types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const DEFAULT_ARTIFACT_MAX_BYTES = 500_000;

export interface DaytonaRemoteExecutionProviderOptions {
  client?: DaytonaSandboxClient;
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

function mapToSessionPath(sessionWorkspaceRoot: string, remotePath: string): string {
  const normalized = normalizeRemoteRelativePath(remotePath);
  if (normalized === REMOTE_WORKSPACE_ROOT) {
    return sessionWorkspaceRoot;
  }
  if (normalized.startsWith(`${REMOTE_WORKSPACE_ROOT}/`)) {
    return path.posix.join(sessionWorkspaceRoot, normalized.slice(REMOTE_WORKSPACE_ROOT.length + 1));
  }
  if (normalized.startsWith('/')) {
    return normalized;
  }
  return path.posix.join(sessionWorkspaceRoot, normalized);
}

function resolveArtifactPath(sessionWorkspaceRoot: string, actualCwd: string, artifactPath: string): string {
  if (path.posix.isAbsolute(artifactPath)) {
    return artifactPath.startsWith(REMOTE_WORKSPACE_ROOT)
      ? mapToSessionPath(sessionWorkspaceRoot, artifactPath)
      : artifactPath;
  }
  return path.posix.join(actualCwd, normalizeRemoteRelativePath(artifactPath));
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

function buildCommandString(request: RemoteExecutionPreparedRequest): string {
  if (request.command.execMode === 'shell_fallback') {
    return request.command.requestedCommand;
  }
  return [request.command.entryCommand, ...request.command.args].map(quoteShellArg).join(' ');
}

function assertDaytonaTarget(target: RemoteExecutionPreparedRequest['target']): DaytonaRemoteExecutionResolvedTarget {
  if (target.backendKind !== 'daytona_sandbox') {
    throw new Error(`Daytona provider cannot execute backend '${target.backendKind}'.`);
  }
  return target;
}

export class DaytonaRemoteExecutionProvider implements RemoteExecutionProvider {
  readonly backendKind = 'daytona_sandbox' as const;
  private readonly client: DaytonaSandboxClient;

  constructor(options: DaytonaRemoteExecutionProviderOptions = {}) {
    this.client = options.client ?? new DaytonaSandboxClient();
  }

  async run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult> {
    const target = assertDaytonaTarget(request.target);
    const startedAt = Date.now();
    const requestedRemoteCwd = toRemoteCwd(request.workspaceRoot, request.cwd);
    const stagedBytes = request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0);
    let sandboxId: string | undefined;
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    let status: RemoteExecutionRunResult['status'] = 'failed';
    let artifactFiles: RemoteExecutionArtifact[] = [];
    let session: Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>> | undefined;

    try {
      session = await this.client.createSandbox({
        target,
        timeoutMs: request.timeoutMs,
        vcpus: request.vcpus,
        runtime: request.runtime,
      });
      sandboxId = session.sandboxId;

      const actualRemoteCwd = mapToSessionPath(session.workspaceRoot, requestedRemoteCwd);
      const stagedFiles = request.stagedFiles.map((file) => ({
        ...file,
        actualPath: mapToSessionPath(session!.workspaceRoot, file.remotePath),
      }));

      await this.client.ensureDirectories(
        session,
        stagedFiles.map((file) => file.actualPath),
      );
      await session.uploadFiles(
        stagedFiles.map((file) => ({
          path: file.actualPath,
          content: file.content,
        })),
      );
      for (const file of stagedFiles) {
        if (typeof file.mode === 'number') {
          await session.setFileMode(file.actualPath, file.mode);
        }
      }

      const runId = `guardian-${randomUUID()}`;
      const stdoutPath = path.posix.join(session.workspaceRoot, `.${runId}.stdout`);
      const stderrPath = path.posix.join(session.workspaceRoot, `.${runId}.stderr`);
      const exitCodePath = path.posix.join(session.workspaceRoot, `.${runId}.exit`);
      const commandString = buildCommandString(request);
      const wrappedCommand = [
        'set +e',
        `${commandString} >${quoteShellArg(stdoutPath)} 2>${quoteShellArg(stderrPath)}`,
        `code=$?`,
        `printf '%s' "$code" >${quoteShellArg(exitCodePath)}`,
        'exit 0',
      ].join('; ');

      const timeoutSec = Math.max(1, Math.ceil((request.timeoutMs ?? target.defaultTimeoutMs ?? 300_000) / 1000));
      const execution = await session.executeCommand(
        wrappedCommand,
        actualRemoteCwd,
        buildRemoteEnv(request.env),
        timeoutSec,
      );

      stdout = (await session.readFileToBuffer(stdoutPath, timeoutSec))?.toString('utf8') ?? '';
      stderr = (await session.readFileToBuffer(stderrPath, timeoutSec))?.toString('utf8') ?? '';
      const rawExit = (await session.readFileToBuffer(exitCodePath, timeoutSec))?.toString('utf8').trim();
      exitCode = rawExit && /^\d+$/.test(rawExit) ? Number.parseInt(rawExit, 10) : execution.exitCode;
      status = exitCode === 0 ? 'succeeded' : 'failed';

      const artifactPaths = Array.isArray(request.artifactPaths) ? request.artifactPaths : [];
      artifactFiles = [];
      for (const artifactPath of artifactPaths) {
        const trimmed = artifactPath.trim();
        if (!trimmed) continue;
        const buffer = await session.readFileToBuffer(
          resolveArtifactPath(session.workspaceRoot, actualRemoteCwd, trimmed),
          timeoutSec,
        );
        if (!buffer) continue;
        artifactFiles.push(encodeArtifact(trimmed, buffer, DEFAULT_ARTIFACT_MAX_BYTES));
      }
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      status = isTimeoutLikeError(stderr) ? 'timed_out' : 'failed';
    } finally {
      if (session) {
        await session.destroy().catch(() => undefined);
      }
    }

    const completedAt = Date.now();
    return {
      targetId: target.id,
      backendKind: target.backendKind,
      profileId: target.profileId,
      profileName: target.profileName,
      requestedCommand: request.command.requestedCommand,
      status,
      sandboxId,
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
}
