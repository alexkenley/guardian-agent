import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { DaytonaSandboxClient } from '../../../tools/cloud/daytona-sandbox-client.js';
import type {
  DaytonaRemoteExecutionResolvedTarget,
  RemoteExecutionArtifact,
  RemoteExecutionLease,
  RemoteExecutionLeaseInspectionResult,
  RemoteExecutionLeaseCreateRequest,
  RemoteExecutionPreparedRequest,
  RemoteExecutionProbeResult,
  RemoteExecutionProvider,
  RemoteExecutionProviderLease,
  RemoteExecutionRunResult,
} from '../types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const DEFAULT_ARTIFACT_MAX_BYTES = 500_000;
const DELETE_PATH_CHUNK_SIZE = 100;
const DAYTONA_EXECUTION_READINESS_COMMAND = 'pwd';
const DAYTONA_EXECUTION_READINESS_MAX_ATTEMPTS = 3;
const DAYTONA_EXECUTION_READINESS_RETRY_DELAY_MS = 750;

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

function isPathInsideRemoteRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function resolveArtifactPath(sessionWorkspaceRoot: string, actualCwd: string, artifactPath: string): string {
  const normalized = normalizeRemoteRelativePath(artifactPath);
  if (path.posix.isAbsolute(normalized)) {
    if (isPathInsideRemoteRoot(normalized, REMOTE_WORKSPACE_ROOT)) {
      return mapToSessionPath(sessionWorkspaceRoot, normalized);
    }
    if (isPathInsideRemoteRoot(normalized, sessionWorkspaceRoot)) {
      return normalized;
    }
    throw new Error(
      `Remote artifact path '${artifactPath}' must be relative or inside ${REMOTE_WORKSPACE_ROOT}.`,
    );
  }
  return path.posix.join(actualCwd, normalized);
}

function buildRemoteEnv(env: Record<string, string> | undefined): Record<string, string> {
  return {
    ...(env ?? {}),
    CI: 'true',
    GUARDIAN_REMOTE_SANDBOX: '1',
  };
}

function isTimeoutLikeError(error: string): boolean {
  return /\b(timeout|timed out|abort|aborted)\b/i.test(error);
}

function isDaytonaExecutionProxyError(error: string): boolean {
  return /\b(50[234]|bad gateway|gateway timeout|service unavailable|econn(?:reset|refused)|proxy|toolbox|upstream|fetch failed|socket hang up)\b/i.test(error);
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

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function assertDaytonaTarget(target: RemoteExecutionPreparedRequest['target']): DaytonaRemoteExecutionResolvedTarget {
  if (target.backendKind !== 'daytona_sandbox') {
    throw new Error(`Daytona provider cannot execute backend '${target.backendKind}'.`);
  }
  return target;
}

function assertDaytonaLease(lease: RemoteExecutionProviderLease) {
  const session = lease.state;
  if (!session) {
    throw new Error(`Daytona lease '${lease.id}' does not have an active sandbox session.`);
  }
  return session as Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>>;
}

function extractDaytonaSandboxState(state: unknown): string | undefined {
  if (typeof state === 'string') {
    const trimmed = state.trim();
    return trimmed || undefined;
  }
  if (state && typeof state === 'object') {
    const nested = (state as { state?: unknown }).state;
    if (typeof nested === 'string') {
      const trimmed = nested.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
}

function isDaytonaRunningState(state: string | undefined): boolean {
  return !!state && /\b(started|running|ready)\b/i.test(state);
}

function isDaytonaStartingState(state: string | undefined): boolean {
  return !!state && /\b(starting)\b/i.test(state);
}

function isDaytonaStoppedState(state: string | undefined): boolean {
  return !!state && /\b(stopped|stopping)\b/i.test(state);
}

function buildDaytonaExecutionUnavailableError(input: {
  sandboxId: string;
  state?: string;
  action: string;
  reason: string;
}): Error {
  const normalizedState = input.state?.trim() || 'unknown';
  return new Error(
    `Daytona sandbox '${input.sandboxId}' reported lifecycle state '${normalizedState}' but ${input.action} could not reach the toolbox command endpoint. ${input.reason}`,
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyDaytonaLeaseState(state: string | undefined): {
  healthState: RemoteExecutionLeaseInspectionResult['healthState'];
  reason: string;
} {
  const normalized = state?.trim().toLowerCase();
  if (!normalized) {
    return {
      healthState: 'unknown',
      reason: 'Managed Daytona sandbox did not report a lifecycle state.',
    };
  }
  if (/\b(started|running|ready|starting)\b/.test(normalized)) {
    return {
      healthState: 'healthy',
      reason: `Managed Daytona sandbox is reachable (state: ${state?.trim()}).`,
    };
  }
  if (/\b(stopped|stopping)\b/.test(normalized)) {
    return {
      healthState: 'healthy',
      reason: `Managed Daytona sandbox is stopped but restartable (state: ${state?.trim()}).`,
    };
  }
  return {
    healthState: 'unreachable',
    reason: `Managed Daytona sandbox is no longer reusable (state: ${state?.trim()}).`,
  };
}

export class DaytonaRemoteExecutionProvider implements RemoteExecutionProvider {
  readonly backendKind = 'daytona_sandbox' as const;
  readonly capabilities = {
    reconnectExisting: true,
    restartStoppedSandbox: true,
  } as const;
  private readonly client: DaytonaSandboxClient;

  constructor(options: DaytonaRemoteExecutionProviderOptions = {}) {
    this.client = options.client ?? new DaytonaSandboxClient();
  }

  async probe(targetInput: RemoteExecutionPreparedRequest['target']): Promise<RemoteExecutionProbeResult> {
    const target = assertDaytonaTarget(targetInput);
    const startedAt = Date.now();
    let session: Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>> | undefined;
    try {
      session = await this.client.createSandbox({
        target,
        timeoutMs: Math.min(target.defaultTimeoutMs ?? 30_000, 30_000),
      });
      const timeoutSec = Math.max(1, Math.ceil(Math.min(target.defaultTimeoutMs ?? 30_000, 30_000) / 1000));
      await this.ensureExecutionReady(session, {
        timeoutSec,
        action: 'readiness probe',
      });
      const checkedAt = Date.now();
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: 'healthy',
        reason: 'Daytona sandbox probe succeeded.',
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
        reason: error instanceof Error ? error.message : String(error),
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: session?.sandboxId,
      };
    } finally {
      if (session) {
        await session.destroy().catch(() => undefined);
      }
    }
  }

  async inspectLease(
    targetInput: RemoteExecutionPreparedRequest['target'],
    existingLease: RemoteExecutionLease,
  ): Promise<RemoteExecutionLeaseInspectionResult> {
    const target = assertDaytonaTarget(targetInput);
    const startedAt = Date.now();
    try {
      const session = await this.client.getSandbox({
        target,
        sandboxId: existingLease.sandboxId,
        timeoutMs: target.defaultTimeoutMs,
        remoteWorkspaceRootHint: existingLease.remoteWorkspaceRoot,
      });
      const checkedAt = Date.now();
      const classification = classifyDaytonaLeaseState(session.state);
      let healthState = classification.healthState;
      let reason = classification.reason;
      if (healthState === 'healthy' && isDaytonaRunningState(session.state)) {
        const timeoutSec = Math.max(1, Math.ceil((target.defaultTimeoutMs ?? 60_000) / 1000));
        try {
          await this.ensureExecutionReady(session, {
            timeoutSec,
            action: 'lease inspection',
            lifecycleStateHint: session.state,
          });
          reason = `Managed Daytona sandbox is execution-ready (state: ${session.state?.trim() ?? 'unknown'}).`;
        } catch (error) {
          healthState = 'unreachable';
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState,
        reason,
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: session.sandboxId,
        remoteWorkspaceRoot: session.workspaceRoot,
        state: session.state,
      };
    } catch (error) {
      const checkedAt = Date.now();
      return {
        targetId: target.id,
        backendKind: target.backendKind,
        profileId: target.profileId,
        profileName: target.profileName,
        healthState: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
        checkedAt,
        durationMs: checkedAt - startedAt,
        sandboxId: existingLease.sandboxId,
        remoteWorkspaceRoot: existingLease.remoteWorkspaceRoot,
        state: extractDaytonaSandboxState(existingLease.state),
      };
    }
  }

  async createLease(request: RemoteExecutionLeaseCreateRequest): Promise<RemoteExecutionProviderLease> {
    const target = assertDaytonaTarget(request.target);
    const session = await this.client.createSandbox({
      target,
      timeoutMs: request.timeoutMs,
      vcpus: request.vcpus,
      runtime: request.runtime,
      leaseMode: request.leaseMode,
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
      remoteWorkspaceRoot: session.workspaceRoot,
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
    const target = assertDaytonaTarget(targetInput);
    const session = await this.client.getSandbox({
      target,
      sandboxId: existingLease.sandboxId,
      timeoutMs: target.defaultTimeoutMs,
      remoteWorkspaceRootHint: existingLease.remoteWorkspaceRoot,
    });
    await session.refreshData().catch(() => undefined);
    let lifecycleState = extractDaytonaSandboxState(session.state)
      ?? extractDaytonaSandboxState(existingLease.state);
    const timeoutSec = Math.max(1, Math.ceil((target.defaultTimeoutMs ?? 60_000) / 1000));
    if (!lifecycleState) {
      throw new Error(`Daytona sandbox '${existingLease.sandboxId}' did not report a lifecycle state.`);
    }
    if (isDaytonaStartingState(lifecycleState)) {
      await session.waitUntilStarted(timeoutSec);
      await session.refreshData().catch(() => undefined);
      lifecycleState = extractDaytonaSandboxState(session.state) ?? lifecycleState;
    } else if (isDaytonaStoppedState(lifecycleState)) {
      await session.start(timeoutSec);
      await session.refreshData().catch(() => undefined);
      lifecycleState = extractDaytonaSandboxState(session.state) ?? lifecycleState;
    } else if (!isDaytonaRunningState(lifecycleState)) {
      throw new Error(
        `Daytona sandbox '${existingLease.sandboxId}' is not reusable from state '${lifecycleState}'.`,
      );
    }
    if (!isDaytonaRunningState(lifecycleState)) {
      throw new Error(
        `Daytona sandbox '${existingLease.sandboxId}' did not reach a running state after resume (state: ${lifecycleState}).`,
      );
    }
    await this.ensureExecutionReady(session, {
      timeoutSec,
      action: 'sandbox resume',
      lifecycleStateHint: lifecycleState,
    });
    const acquiredAt = Date.now();
    return {
      ...existingLease,
      localWorkspaceRoot: existingLease.localWorkspaceRoot,
      remoteWorkspaceRoot: session.workspaceRoot,
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
    const target = assertDaytonaTarget(request.target);
    const session = assertDaytonaLease(lease);
    const startedAt = Date.now();
    const requestedRemoteCwd = toRemoteCwd(request.workspaceRoot, request.cwd);
    const stagedBytes = request.stagedFiles.reduce((sum, file) => sum + file.content.length, 0);
    const currentRemotePaths = request.stagedFiles.map((file) => file.remotePath);
    const currentRemotePathSet = new Set(currentRemotePaths);
    const removedRemotePaths = lease.trackedRemotePaths.filter((filePath) => !currentRemotePathSet.has(filePath));
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    let status: RemoteExecutionRunResult['status'] = 'failed';
    let artifactFiles: RemoteExecutionArtifact[] = [];
    await session.refreshActivity().catch(() => undefined);
    const actualRemoteCwd = mapToSessionPath(session.workspaceRoot, requestedRemoteCwd);
    const timeoutSec = Math.max(1, Math.ceil((request.timeoutMs ?? target.defaultTimeoutMs ?? 300_000) / 1000));

    if (removedRemotePaths.length > 0) {
      request.onProgress?.(`Removing ${removedRemotePaths.length} stale files from remote sandbox...`);
      await this.deleteTrackedFiles(
        session,
        removedRemotePaths.map((filePath) => mapToSessionPath(session.workspaceRoot, filePath)),
        timeoutSec,
      );
    }

    const stagedFiles = request.stagedFiles.map((file) => ({
      ...file,
      actualPath: mapToSessionPath(session.workspaceRoot, file.remotePath),
    }));

    request.onProgress?.(`Staging ${stagedFiles.length} files to remote sandbox...`);
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
      'code=$?',
      `printf '%s' "$code" >${quoteShellArg(exitCodePath)}`,
      'exit 0',
    ].join('; ');

    try {
      request.onProgress?.(`Executing remote command: ${request.command.requestedCommand}`);
      const execution = await session.executeCommand(
        wrappedCommand,
        actualRemoteCwd,
        buildRemoteEnv(request.env),
        timeoutSec,
      );

      request.onProgress?.('Reading command output...');
      stdout = (await session.readFileToBuffer(stdoutPath, timeoutSec))?.toString('utf8') ?? '';
      stderr = (await session.readFileToBuffer(stderrPath, timeoutSec))?.toString('utf8') ?? '';
      const rawExit = (await session.readFileToBuffer(exitCodePath, timeoutSec))?.toString('utf8').trim();
      exitCode = rawExit && /^\d+$/.test(rawExit) ? Number.parseInt(rawExit, 10) : execution.exitCode;
      status = exitCode === 0 ? 'succeeded' : 'failed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTimeoutLikeError(message)) {
        stderr = message;
        status = 'timed_out';
      } else {
        throw buildDaytonaExecutionUnavailableError({
          sandboxId: session.sandboxId,
          state: extractDaytonaSandboxState(session.state),
          action: `executing '${request.command.requestedCommand}'`,
          reason: message,
        });
      }
    }

    const artifactPaths = Array.isArray(request.artifactPaths) ? request.artifactPaths : [];
    artifactFiles = [];
    if (artifactPaths.length > 0) {
      request.onProgress?.(`Downloading ${artifactPaths.length} artifacts from remote sandbox...`);
    }
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
    lease.trackedRemotePaths = [...currentRemotePaths];

    const completedAt = Date.now();
    return {
      targetId: target.id,
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
    const session = assertDaytonaLease(lease);
    await session.destroy();
  }

  async stopLease(
    targetInput: RemoteExecutionPreparedRequest['target'],
    lease: RemoteExecutionLease | RemoteExecutionProviderLease,
  ): Promise<void> {
    const target = assertDaytonaTarget(targetInput);
    const session = lease.state && typeof lease.state === 'object'
      ? lease.state as Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>>
      : await this.client.getSandbox({
        target,
        sandboxId: lease.sandboxId,
        timeoutMs: target.defaultTimeoutMs,
        remoteWorkspaceRootHint: lease.remoteWorkspaceRoot,
      });
    const state = extractDaytonaSandboxState(session.state);
    if (!state || /\b(started|running|ready|starting)\b/i.test(state)) {
      await session.stop(Math.max(1, Math.ceil((target.defaultTimeoutMs ?? 60_000) / 1000)));
    }
  }

  async run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult> {
    const target = assertDaytonaTarget(request.target);
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
      const stderr = error instanceof Error ? error.message : String(error);
      const completedAt = Date.now();
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
    session: Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>>,
    filePaths: string[],
    timeoutSec: number,
  ): Promise<void> {
    for (const chunk of chunkItems(filePaths, DELETE_PATH_CHUNK_SIZE)) {
      await session.executeCommand(
        `rm -f -- ${chunk.map(quoteShellArg).join(' ')}`,
        session.workspaceRoot,
        buildRemoteEnv(undefined),
        timeoutSec,
      );
    }
  }

  private async ensureExecutionReady(
    session: Awaited<ReturnType<DaytonaSandboxClient['createSandbox']>>,
    input: {
      timeoutSec: number;
      action: string;
      lifecycleStateHint?: string;
    },
  ): Promise<void> {
    let lastReason = 'Unknown Daytona execution readiness failure.';
    for (let attempt = 1; attempt <= DAYTONA_EXECUTION_READINESS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await session.executeCommand(
          DAYTONA_EXECUTION_READINESS_COMMAND,
          session.workspaceRoot,
          buildRemoteEnv(undefined),
          Math.max(1, Math.min(input.timeoutSec, 10)),
        );
        if (result.exitCode === 0) {
          return;
        }
        lastReason = result.result?.trim()
          || `Readiness probe exited with code ${result.exitCode}.`;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }

      await session.refreshData().catch(() => undefined);
      const lifecycleState = extractDaytonaSandboxState(session.state) ?? input.lifecycleStateHint;
      if (attempt >= DAYTONA_EXECUTION_READINESS_MAX_ATTEMPTS) {
        throw buildDaytonaExecutionUnavailableError({
          sandboxId: session.sandboxId,
          state: lifecycleState,
          action: input.action,
          reason: lastReason,
        });
      }
      if (isDaytonaStartingState(lifecycleState)) {
        try {
          await session.waitUntilStarted(Math.max(1, Math.min(input.timeoutSec, 15)));
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);
        }
        await session.refreshData().catch(() => undefined);
      }
      if (!isDaytonaExecutionProxyError(lastReason) && !isDaytonaStartingState(lifecycleState)) {
        throw buildDaytonaExecutionUnavailableError({
          sandboxId: session.sandboxId,
          state: lifecycleState,
          action: input.action,
          reason: lastReason,
        });
      }
      await delay(DAYTONA_EXECUTION_READINESS_RETRY_DELAY_MS);
    }
  }
}
