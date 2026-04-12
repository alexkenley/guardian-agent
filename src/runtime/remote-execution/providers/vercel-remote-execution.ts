import path from 'node:path';

import { VercelSandboxClient } from '../../../tools/cloud/vercel-sandbox-client.js';
import type {
  RemoteExecutionArtifact,
  RemoteExecutionPreparedRequest,
  RemoteExecutionProvider,
  VercelRemoteExecutionResolvedTarget,
  RemoteExecutionRunResult,
} from '../types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const DEFAULT_ARTIFACT_MAX_BYTES = 500_000;

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

export class VercelRemoteExecutionProvider implements RemoteExecutionProvider {
  readonly backendKind = 'vercel_sandbox' as const;
  private readonly client: VercelSandboxClient;

  constructor(options: VercelRemoteExecutionProviderOptions = {}) {
    this.client = options.client ?? new VercelSandboxClient();
  }

  async run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult> {
    const target = assertVercelTarget(request.target);
    const startedAt = Date.now();
    const remoteCwd = toRemoteCwd(request.workspaceRoot, request.cwd);
    const stagedBytes = request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0);
    let sandboxId: string | undefined;
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    let status: RemoteExecutionRunResult['status'] = 'failed';
    let artifactFiles: RemoteExecutionArtifact[] = [];
    let session: Awaited<ReturnType<VercelSandboxClient['createSandbox']>> | undefined;

    try {
      session = await this.client.createSandbox({
        target,
        timeoutMs: request.timeoutMs,
        vcpus: request.vcpus,
        runtime: request.runtime,
      });
      sandboxId = session.sandboxId;
      await this.client.ensureDirectories(
        session,
        request.stagedFiles.map((file) => file.remotePath),
      );
      await session.writeFiles(request.stagedFiles.map((file) => ({
        path: file.remotePath,
        content: file.content,
        ...(typeof file.mode === 'number' ? { mode: file.mode } : {}),
      })));

      const command = request.command.execMode === 'shell_fallback'
        ? {
            cmd: 'bash',
            args: ['-lc', request.command.requestedCommand],
            cwd: remoteCwd,
            env: buildRemoteEnv(request.env),
          }
        : {
            cmd: request.command.entryCommand,
            args: request.command.args,
            cwd: remoteCwd,
            env: buildRemoteEnv(request.env),
          };

      const result = await session.runCommand(command);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      status = result.exitCode === 0 ? 'succeeded' : 'failed';

      const artifactPaths = Array.isArray(request.artifactPaths) ? request.artifactPaths : [];
      artifactFiles = [];
      for (const artifactPath of artifactPaths) {
        const trimmed = artifactPath.trim();
        if (!trimmed) continue;
        const buffer = await session.readFileToBuffer({ path: trimmed, cwd: remoteCwd });
        if (!buffer) continue;
        artifactFiles.push(encodeArtifact(trimmed, buffer, DEFAULT_ARTIFACT_MAX_BYTES));
      }
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      status = isTimeoutLikeError(stderr) ? 'timed_out' : 'failed';
    } finally {
      if (session) {
        await session.stop(true).catch(() => undefined);
      }
    }

    const completedAt = Date.now();
    return {
      targetId: request.target.id,
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
