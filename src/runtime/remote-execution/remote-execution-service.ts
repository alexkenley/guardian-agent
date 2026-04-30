import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import path from 'node:path';

import {
  classifyRemoteExecutionDiagnosticCause,
  type RemoteExecutionTargetHealthSummary,
} from './policy.js';
import type {
  RemoteExecutionLease,
  RemoteExecutionLeaseAcquireRequest,
  RemoteExecutionLeaseCreateRequest,
  RemoteExecutionLeaseInspectionResult,
  RemoteExecutionLeaseMode,
  RemoteExecutionPreparedRequest,
  RemoteExecutionProvider,
  RemoteExecutionProviderLease,
  RemoteExecutionResolvedTarget,
  RemoteExecutionRunRequest,
  RemoteExecutionRunResult,
  RemoteExecutionServiceLike,
  RemoteExecutionStagedFile,
} from './types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const DEFAULT_MAX_STAGED_FILES = 10_000;
const DEFAULT_MAX_STAGED_BYTES = 100 * 1024 * 1024;
const DEFAULT_LEASE_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_PROBE_TTL_MS = 60_000;
const ALWAYS_EXCLUDED_NAMES = new Set(['.git']);
const DEFAULT_EXCLUDED_NAMES = new Set([
  '.guardianagent',
  '.next',
  '.turbo',
  '.yarn',
  '.worktrees',
  '.codex',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

export interface RemoteExecutionServiceOptions {
  providers: RemoteExecutionProvider[];
  defaultMaxFiles?: number;
  defaultMaxBytes?: number;
  leaseIdleTtlMs?: number;
  probeTtlMs?: number;
  now?: () => number;
}

interface PreparedWorkspace {
  workspaceRoot: string;
  cwd: string;
  stagedFiles: RemoteExecutionStagedFile[];
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toRemoteWorkspacePath(localPath: string, workspaceRoot: string): string {
  const relativePath = normalizeRemotePath(relative(workspaceRoot, localPath));
  return relativePath
    ? path.posix.join(REMOTE_WORKSPACE_ROOT, relativePath)
    : REMOTE_WORKSPACE_ROOT;
}

function isExcludedName(name: string, applyDefaultExcludes: boolean): boolean {
  if (ALWAYS_EXCLUDED_NAMES.has(name)) return true;
  return applyDefaultExcludes && DEFAULT_EXCLUDED_NAMES.has(name);
}

function sanitizeExecutableMode(mode: number): number | undefined {
  const normalized = mode & 0o777;
  return (normalized & 0o111) !== 0 ? normalized : undefined;
}

function inferExecutableMode(mode: number, content: Buffer): number | undefined {
  const sanitized = sanitizeExecutableMode(mode);
  if (sanitized !== undefined) {
    return sanitized;
  }
  const firstLine = content.subarray(0, Math.min(content.length, 256)).toString('utf8');
  if (firstLine.startsWith('#!')) {
    return 0o755;
  }
  return undefined;
}

function buildLeaseKey(targetId: string, workspaceRoot: string, codeSessionId: string): string {
  return `${targetId}::${workspaceRoot}::${codeSessionId}`;
}

function normalizeLeaseMode(value: RemoteExecutionLeaseMode | undefined): RemoteExecutionLeaseMode {
  return value === 'managed' ? 'managed' : 'ephemeral';
}

function extractLeaseStateLabel(state: unknown): string | undefined {
  if (typeof state === 'string') {
    const trimmed = state.trim();
    return trimmed || undefined;
  }
  if (!state || typeof state !== 'object') {
    return undefined;
  }
  const record = state as { state?: unknown; status?: unknown };
  for (const candidate of [record.state, record.status]) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function isStoppedLeaseState(state: unknown): boolean {
  const label = extractLeaseStateLabel(state);
  return !!label && /\b(stopped|stopping)\b/i.test(label);
}

function toHealthSummary(input: {
  state: RemoteExecutionTargetHealthSummary['state'];
  reason: string;
  checkedAt: number;
  durationMs?: number;
  leaseId?: string;
  sandboxId?: string;
}): RemoteExecutionTargetHealthSummary {
  return {
    state: input.state,
    reason: input.reason,
    checkedAt: input.checkedAt,
    durationMs: input.durationMs,
    leaseId: input.leaseId,
    sandboxId: input.sandboxId,
    cause: classifyRemoteExecutionDiagnosticCause(input.reason),
  };
}

export class RemoteExecutionTargetUnavailableError extends Error {
  readonly targetId: string;
  readonly profileId: string;
  readonly backendKind: RemoteExecutionPreparedRequest['target']['backendKind'];

  constructor(message: string, input: {
    targetId: string;
    profileId: string;
    backendKind: RemoteExecutionPreparedRequest['target']['backendKind'];
  }) {
    super(message);
    this.name = 'RemoteExecutionTargetUnavailableError';
    this.targetId = input.targetId;
    this.profileId = input.profileId;
    this.backendKind = input.backendKind;
  }
}

export class RemoteExecutionService implements RemoteExecutionServiceLike {
  private readonly providers = new Map<RemoteExecutionProvider['backendKind'], RemoteExecutionProvider>();
  private readonly targetHealth = new Map<string, RemoteExecutionTargetHealthSummary>();
  private readonly targetsById = new Map<string, RemoteExecutionResolvedTarget>();
  private readonly leasesByKey = new Map<string, RemoteExecutionProviderLease>();
  private readonly defaultMaxFiles: number;
  private readonly defaultMaxBytes: number;
  private readonly leaseIdleTtlMs: number;
  private readonly probeTtlMs: number;
  private readonly now: () => number;

  constructor(options: RemoteExecutionServiceOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.backendKind, provider);
    }
    this.defaultMaxFiles = Math.max(50, options.defaultMaxFiles ?? DEFAULT_MAX_STAGED_FILES);
    this.defaultMaxBytes = Math.max(1_000_000, options.defaultMaxBytes ?? DEFAULT_MAX_STAGED_BYTES);
    this.leaseIdleTtlMs = Math.max(60_000, options.leaseIdleTtlMs ?? DEFAULT_LEASE_IDLE_TTL_MS);
    this.probeTtlMs = Math.max(5_000, options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  getKnownTargetHealth(): Record<string, RemoteExecutionTargetHealthSummary> {
    const snapshot: Record<string, RemoteExecutionTargetHealthSummary> = {};
    for (const [targetId, summary] of this.targetHealth.entries()) {
      snapshot[targetId] = { ...summary };
    }
    for (const lease of this.leasesByKey.values()) {
      snapshot[lease.targetId] = toHealthSummary({
        state: 'healthy',
        reason: lease.codeSessionId
          ? `Active leased sandbox is attached to code session '${lease.codeSessionId}'.`
          : 'Active leased sandbox is available.',
        checkedAt: lease.lastUsedAt,
        leaseId: lease.id,
        sandboxId: lease.sandboxId,
      });
    }
    return snapshot;
  }

  listActiveLeases(): RemoteExecutionLease[] {
    return [...this.leasesByKey.values()].map((lease) => ({
      id: lease.id,
      targetId: lease.targetId,
      backendKind: lease.backendKind,
      profileId: lease.profileId,
      profileName: lease.profileName,
      sandboxId: lease.sandboxId,
      localWorkspaceRoot: lease.localWorkspaceRoot,
      remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
      codeSessionId: lease.codeSessionId,
      acquiredAt: lease.acquiredAt,
      lastUsedAt: lease.lastUsedAt,
      expiresAt: lease.expiresAt,
      runtime: lease.runtime,
      vcpus: lease.vcpus,
      trackedRemotePaths: [...lease.trackedRemotePaths],
      leaseMode: lease.leaseMode,
      state: lease.state,
    }));
  }

  async acquireLease(request: RemoteExecutionLeaseAcquireRequest): Promise<RemoteExecutionLease> {
    await this.releaseExpiredLeases();
    this.rememberTarget(request.target);

    const provider = this.providers.get(request.target.backendKind);
    if (!provider) {
      throw new RemoteExecutionTargetUnavailableError(
        `No remote execution provider is registered for backend '${request.target.backendKind}'.`,
        {
          targetId: request.target.id,
          profileId: request.target.profileId,
          backendKind: request.target.backendKind,
        },
      );
    }

    const workspaceRoot = resolve(request.localWorkspaceRoot);
    const normalizedCodeSessionId = request.codeSessionId?.trim() || undefined;
    const leaseKey = normalizedCodeSessionId
      ? buildLeaseKey(request.target.id, workspaceRoot, normalizedCodeSessionId)
      : null;
    const requestedLeaseMode = normalizeLeaseMode(request.existingLease?.leaseMode ?? request.leaseMode);

    let lease = leaseKey ? this.leasesByKey.get(leaseKey) : undefined;
    if (lease && !this.isLeaseCreateCompatible(lease, request, workspaceRoot)) {
      await this.releaseLease(provider, lease, leaseKey);
      lease = undefined;
    }
    const existingLease = request.existingLease && this.isLeaseCreateCompatible(request.existingLease, request, workspaceRoot)
      ? request.existingLease
      : undefined;

    if (!lease && !existingLease) {
      await this.ensureTargetHealthy(provider, request.target);
    }

    if (!lease) {
      lease = existingLease
        ? await this.resumeLease(request.target, existingLease, {
          ...request,
          localWorkspaceRoot: workspaceRoot,
          codeSessionId: normalizedCodeSessionId,
          leaseMode: requestedLeaseMode,
        })
        : await this.createLease(provider, {
          ...request,
          localWorkspaceRoot: workspaceRoot,
          codeSessionId: normalizedCodeSessionId,
          leaseMode: requestedLeaseMode,
        });
      if (leaseKey) {
        this.leasesByKey.set(leaseKey, lease);
      }
    } else {
      lease.leaseMode = requestedLeaseMode;
      this.updateLeaseTimestamps(lease, requestedLeaseMode);
      this.targetHealth.set(request.target.id, toHealthSummary({
        state: 'healthy',
        reason: 'Remote sandbox lease reused successfully.',
        checkedAt: lease.lastUsedAt,
        leaseId: lease.id,
        sandboxId: lease.sandboxId,
      }));
    }

    return {
      ...lease,
      trackedRemotePaths: [...lease.trackedRemotePaths],
    };
  }

  async disposeLease(request: {
    target: RemoteExecutionRunRequest['target'];
    lease: RemoteExecutionLease;
  }): Promise<void> {
    this.rememberTarget(request.target);
    const provider = this.providers.get(request.target.backendKind);
    if (!provider) return;
    const leaseKey = this.findLeaseKey(request.lease.id);
    const activeLease = leaseKey ? this.leasesByKey.get(leaseKey) : undefined;
    const lease = activeLease
      ?? await this.resumeLease(request.target, request.lease, {
        target: request.target,
        localWorkspaceRoot: request.lease.localWorkspaceRoot,
        codeSessionId: request.lease.codeSessionId,
        timeoutMs: undefined,
        vcpus: request.lease.vcpus,
        runtime: request.lease.runtime,
        leaseMode: request.lease.leaseMode,
      }).catch(() => undefined);
    if (!lease) return;
    await this.releaseLease(provider, lease, leaseKey ?? null);
  }

  async inspectLease(request: {
    target: RemoteExecutionRunRequest['target'];
    lease: RemoteExecutionLease;
  }): Promise<RemoteExecutionLeaseInspectionResult> {
    this.rememberTarget(request.target);
    const provider = this.providers.get(request.target.backendKind);
    if (!provider) {
      return {
        targetId: request.target.id,
        backendKind: request.target.backendKind,
        profileId: request.target.profileId,
        profileName: request.target.profileName,
        healthState: 'unreachable',
        reason: `No remote execution provider is registered for backend '${request.target.backendKind}'.`,
        checkedAt: this.now(),
        durationMs: 0,
        sandboxId: request.lease.sandboxId,
        remoteWorkspaceRoot: request.lease.remoteWorkspaceRoot,
      };
    }
    return provider.inspectLease(request.target, request.lease);
  }

  async runBoundedJob(request: RemoteExecutionRunRequest): Promise<RemoteExecutionRunResult> {
    await this.releaseExpiredLeases();
    this.rememberTarget(request.target);

    const provider = this.providers.get(request.target.backendKind);
    if (!provider) {
      throw new RemoteExecutionTargetUnavailableError(
        `No remote execution provider is registered for backend '${request.target.backendKind}'.`,
        {
          targetId: request.target.id,
          profileId: request.target.profileId,
          backendKind: request.target.backendKind,
        },
      );
    }

    const prepared = await this.prepareRequest(request);
    const normalizedCodeSessionId = request.codeSessionId?.trim() || undefined;
    const leaseKey = normalizedCodeSessionId
      ? buildLeaseKey(request.target.id, prepared.workspaceRoot, normalizedCodeSessionId)
      : null;
    const requestedLeaseMode = normalizeLeaseMode(request.preferredLease?.leaseMode ?? request.leaseMode);
    const leaseCreateRequest: RemoteExecutionLeaseCreateRequest = {
      target: request.target,
      localWorkspaceRoot: prepared.workspaceRoot,
      codeSessionId: normalizedCodeSessionId,
      timeoutMs: request.timeoutMs,
      vcpus: request.vcpus,
      runtime: request.runtime,
      leaseMode: requestedLeaseMode,
    };
    const preferredLease = request.preferredLease && this.isLeaseCompatible(
      request.preferredLease,
      request,
      prepared.workspaceRoot,
    )
      ? request.preferredLease
      : undefined;

    let lease = leaseKey ? this.leasesByKey.get(leaseKey) : undefined;
    let leaseReused = false;

    if (lease && !this.isLeaseCompatible(lease, request, prepared.workspaceRoot)) {
      await this.releaseLease(provider, lease, leaseKey);
      lease = undefined;
    }

    if (!lease && !preferredLease) {
      await this.ensureTargetHealthy(provider, request.target);
    }

    const preferredLeaseStateHint = preferredLease && lease && preferredLease.id === lease.id
      ? preferredLease
      : undefined;
    if (lease && (isStoppedLeaseState(lease.state) || isStoppedLeaseState(preferredLeaseStateHint?.state))) {
      const leaseToResume = preferredLeaseStateHint ?? lease;
      try {
        lease = await this.resumeLease(request.target, leaseToResume, leaseCreateRequest);
        leaseReused = true;
        if (leaseKey) {
          this.leasesByKey.set(leaseKey, lease);
        }
      } catch (error) {
        if (normalizeLeaseMode(leaseToResume.leaseMode) === 'managed') {
          throw error;
        }
        if (leaseKey) {
          this.leasesByKey.delete(leaseKey);
        }
        lease = undefined;
      }
    }

    if (!lease) {
      if (preferredLease) {
        try {
          lease = await this.resumeLease(request.target, preferredLease, leaseCreateRequest);
          leaseReused = true;
        } catch (error) {
          if (normalizeLeaseMode(preferredLease.leaseMode) === 'managed') {
            throw error;
          }
        }
        if (lease && leaseKey) {
          this.leasesByKey.set(leaseKey, lease);
        }
      }
      if (!lease) {
        lease = await this.createLease(provider, leaseCreateRequest);
        if (leaseKey) {
          this.leasesByKey.set(leaseKey, lease);
        }
      }
    } else {
      leaseReused = true;
    }

    const startedLease = { ...lease };
    try {
      this.updateLeaseTimestamps(lease, lease.leaseMode);
      const result = await provider.runWithLease(lease, prepared);
      this.updateLeaseTimestamps(lease, lease.leaseMode);
      this.targetHealth.set(request.target.id, toHealthSummary({
        state: 'healthy',
        reason: leaseReused
          ? 'Remote sandbox lease reused successfully.'
          : 'Remote sandbox lease created successfully.',
        checkedAt: lease.lastUsedAt,
        leaseId: lease.id,
        sandboxId: lease.sandboxId,
      }));
      return {
        ...result,
        healthState: 'healthy',
        healthReason: leaseReused
          ? 'Remote sandbox lease reused successfully.'
          : 'Remote sandbox lease created successfully.',
        routingReason: request.target.routingReason,
        leaseId: lease.id,
        leaseScope: normalizedCodeSessionId ? 'code_session' : 'ephemeral',
        leaseReused,
        leaseMode: lease.leaseMode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = this.now();
      this.targetHealth.set(request.target.id, toHealthSummary({
        state: 'unreachable',
        reason: message,
        checkedAt: failedAt,
        leaseId: startedLease.id,
        sandboxId: startedLease.sandboxId,
      }));
      throw new RemoteExecutionTargetUnavailableError(
        `Remote execution target '${request.target.profileName}' is not reachable.\n\n${message}`,
        {
          targetId: request.target.id,
          profileId: request.target.profileId,
          backendKind: request.target.backendKind,
        },
      );
    } finally {
      if (!leaseKey && lease) {
        await this.releaseLease(provider, lease, null);
      }
    }
  }

  private async ensureTargetHealthy(
    provider: RemoteExecutionProvider,
    target: RemoteExecutionRunRequest['target'],
  ): Promise<void> {
    const activeLease = [...this.leasesByKey.values()].find((lease) => lease.targetId === target.id);
    if (activeLease) {
      this.targetHealth.set(target.id, toHealthSummary({
        state: 'healthy',
        reason: activeLease.codeSessionId
          ? `Active leased sandbox is attached to code session '${activeLease.codeSessionId}'.`
          : 'Active leased sandbox is available.',
        checkedAt: activeLease.lastUsedAt,
        leaseId: activeLease.id,
        sandboxId: activeLease.sandboxId,
      }));
      return;
    }

    const cached = this.targetHealth.get(target.id);
    const now = this.now();
    if (cached && (now - cached.checkedAt) < this.probeTtlMs) {
      if (cached.state === 'healthy') return;
      throw new RemoteExecutionTargetUnavailableError(
        `Remote execution target '${target.profileName}' is not reachable.\n\n${cached.reason}`,
        {
          targetId: target.id,
          profileId: target.profileId,
          backendKind: target.backendKind,
        },
      );
    }

    const probe = await provider.probe(target);
    this.targetHealth.set(target.id, toHealthSummary({
      state: probe.healthState,
      reason: probe.reason,
      checkedAt: probe.checkedAt,
      durationMs: probe.durationMs,
      sandboxId: probe.sandboxId,
    }));
    if (probe.healthState !== 'healthy') {
      throw new RemoteExecutionTargetUnavailableError(
        `Remote execution target '${target.profileName}' is not reachable.\n\n${probe.reason}`,
        {
          targetId: target.id,
          profileId: target.profileId,
          backendKind: target.backendKind,
        },
      );
    }
  }

  private async createLease(
    provider: RemoteExecutionProvider,
    request: RemoteExecutionLeaseCreateRequest,
  ): Promise<RemoteExecutionProviderLease> {
    const lease = await provider.createLease(request);
    const now = this.now();
    lease.localWorkspaceRoot = request.localWorkspaceRoot;
    lease.codeSessionId = request.codeSessionId;
    lease.lastUsedAt = now;
    lease.expiresAt = now + this.leaseIdleTtlMs;
    lease.runtime = request.runtime;
    lease.vcpus = request.vcpus;
    lease.leaseMode = normalizeLeaseMode(request.leaseMode);
    lease.trackedRemotePaths = Array.isArray(lease.trackedRemotePaths)
      ? [...lease.trackedRemotePaths]
      : [];
    this.updateLeaseTimestamps(lease, lease.leaseMode);
    this.targetHealth.set(request.target.id, toHealthSummary({
      state: 'healthy',
      reason: 'Remote sandbox lease created successfully.',
      checkedAt: now,
      leaseId: lease.id,
      sandboxId: lease.sandboxId,
    }));
    return lease;
  }

  async resumeLease(
    target: RemoteExecutionRunRequest['target'],
    existingLease: RemoteExecutionLease,
    request?: RemoteExecutionLeaseCreateRequest,
  ): Promise<RemoteExecutionProviderLease> {
    this.rememberTarget(target);
    const provider = this.providers.get(target.backendKind);
    if (!provider) {
      throw new Error(`Remote execution provider '${target.backendKind}' is not available.`);
    }
    const lease = await provider.resumeLease(target, existingLease);
    if (request) {
      lease.localWorkspaceRoot = request.localWorkspaceRoot;
      lease.codeSessionId = request.codeSessionId;
      lease.runtime = request.runtime ?? existingLease.runtime;
      lease.vcpus = request.vcpus ?? existingLease.vcpus;
      lease.leaseMode = normalizeLeaseMode(request.leaseMode ?? existingLease.leaseMode);
    }
    lease.trackedRemotePaths = Array.isArray(existingLease.trackedRemotePaths)
      ? [...existingLease.trackedRemotePaths]
      : [];
    this.updateLeaseTimestamps(lease, lease.leaseMode);
    this.targetHealth.set(target.id, toHealthSummary({
      state: 'healthy',
      reason: 'Remote sandbox lease reused successfully.',
      checkedAt: lease.lastUsedAt,
      leaseId: lease.id,
      sandboxId: lease.sandboxId,
    }));
    return lease;
  }

  private isLeaseCompatible(
    lease: Pick<RemoteExecutionLease, 'targetId' | 'localWorkspaceRoot' | 'runtime' | 'vcpus'>,
    request: Pick<RemoteExecutionRunRequest, 'target' | 'runtime' | 'vcpus'>,
    workspaceRoot: string,
  ): boolean {
    if (lease.targetId !== request.target.id) return false;
    if (lease.localWorkspaceRoot !== workspaceRoot) return false;
    if ((lease.runtime ?? '') !== (request.runtime ?? '')) return false;
    if ((lease.vcpus ?? null) !== (request.vcpus ?? null)) return false;
    return true;
  }

  private isLeaseCreateCompatible(
    lease: Pick<RemoteExecutionLease, 'targetId' | 'localWorkspaceRoot' | 'runtime' | 'vcpus'>,
    request: RemoteExecutionLeaseCreateRequest,
    workspaceRoot: string,
  ): boolean {
    if (lease.targetId !== request.target.id) return false;
    if (lease.localWorkspaceRoot !== workspaceRoot) return false;
    if ((lease.runtime ?? '') !== (request.runtime ?? '')) return false;
    if ((lease.vcpus ?? null) !== (request.vcpus ?? null)) return false;
    return true;
  }

  async stopLease(request: { target: RemoteExecutionResolvedTarget; lease: RemoteExecutionLease }): Promise<void> {
    this.rememberTarget(request.target);
    const provider = this.providers.get(request.target.backendKind);
    if (!provider?.stopLease) return;
    const leaseKey = this.findLeaseKey(request.lease.id);
    const internalLease = leaseKey ? this.leasesByKey.get(leaseKey) : undefined;
    const lease = internalLease ?? request.lease;
    await provider.stopLease(request.target, lease);
    lease.state = 'stopped';
    if (leaseKey) {
      this.leasesByKey.delete(leaseKey);
    }
    this.refreshTargetHealthAfterLeaseRelease(lease, 'Remote sandbox lease stopped.');
  }

  async stopAllManagedLeases(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const lease of this.leasesByKey.values()) {
      if (lease.leaseMode === 'managed') {
        const target = this.targetsById.get(lease.targetId);
        const provider = this.providers.get(lease.backendKind);
        if (target && provider?.stopLease && lease.state !== 'stopped') {
          promises.push(
            provider.stopLease(target, lease).then(() => {
              lease.state = 'stopped';
              const leaseKey = this.findLeaseKey(lease.id);
              if (leaseKey) {
                this.leasesByKey.delete(leaseKey);
              }
              this.refreshTargetHealthAfterLeaseRelease(lease, 'Remote sandbox lease stopped.');
            }).catch(() => undefined)
          );
        }
      }
    }
    await Promise.all(promises);
  }

  private updateLeaseTimestamps(lease: RemoteExecutionProviderLease, mode: RemoteExecutionLeaseMode): void {
    const now = this.now();
    lease.lastUsedAt = now;
    lease.expiresAt = mode === 'managed'
      ? Number.MAX_SAFE_INTEGER
      : now + this.leaseIdleTtlMs;
  }

  private async releaseExpiredLeases(): Promise<void> {
    const now = this.now();
    for (const [leaseKey, lease] of this.leasesByKey.entries()) {
      const provider = this.providers.get(lease.backendKind);
      if (!provider) {
        this.leasesByKey.delete(leaseKey);
        continue;
      }

      if (lease.leaseMode === 'managed') {
        const target = this.targetsById.get(lease.targetId);
        if (target && provider.stopLease && (now - lease.lastUsedAt > this.leaseIdleTtlMs)) {
          if (lease.state !== 'stopped') {
            await provider.stopLease(target, lease).catch(() => undefined);
            lease.state = 'stopped';
            this.leasesByKey.delete(leaseKey);
          }
        }
        continue;
      }

      if (lease.expiresAt > now) continue;
      await this.releaseLease(provider, lease, leaseKey);
    }
  }

  private async releaseLease(
    provider: RemoteExecutionProvider,
    lease: RemoteExecutionProviderLease,
    leaseKey: string | null,
  ): Promise<void> {
    if (leaseKey) {
      this.leasesByKey.delete(leaseKey);
    }
    await provider.releaseLease(lease).catch(() => undefined);
    this.refreshTargetHealthAfterLeaseRelease(lease, 'Remote sandbox lease released.');
  }

  private refreshTargetHealthAfterLeaseRelease(lease: RemoteExecutionProviderLease, reason: string): void {
    const activeLease = [...this.leasesByKey.values()].find((candidate) => candidate.targetId === lease.targetId);
    if (activeLease) {
      this.targetHealth.set(activeLease.targetId, toHealthSummary({
        state: 'healthy',
        reason: activeLease.codeSessionId
          ? `Active leased sandbox is attached to code session '${activeLease.codeSessionId}'.`
          : 'Active leased sandbox is available.',
        checkedAt: activeLease.lastUsedAt,
        leaseId: activeLease.id,
        sandboxId: activeLease.sandboxId,
      }));
      return;
    }

    const current = this.targetHealth.get(lease.targetId);
    if (!current || (current.leaseId !== lease.id && current.sandboxId !== lease.sandboxId)) {
      return;
    }
    this.targetHealth.set(lease.targetId, toHealthSummary({
      state: current.state,
      reason,
      checkedAt: this.now(),
      durationMs: current.durationMs,
    }));
  }

  private findLeaseKey(leaseId: string): string | null {
    for (const [leaseKey, lease] of this.leasesByKey.entries()) {
      if (lease.id === leaseId) return leaseKey;
    }
    return null;
  }

  private rememberTarget(target: RemoteExecutionResolvedTarget): void {
    this.targetsById.set(target.id, target);
  }

  private async prepareRequest(request: RemoteExecutionRunRequest): Promise<RemoteExecutionPreparedRequest> {
    const workspace = await this.prepareWorkspace(request.workspace);
    return {
      ...request,
      workspaceRoot: workspace.workspaceRoot,
      cwd: workspace.cwd,
      stagedFiles: workspace.stagedFiles,
    };
  }

  private async prepareWorkspace(input: RemoteExecutionRunRequest['workspace']): Promise<PreparedWorkspace> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const cwd = resolve(input.cwd);
    if (!isPathInsideRoot(cwd, workspaceRoot)) {
      throw new Error(`Remote execution cwd '${cwd}' is outside workspace root '${workspaceRoot}'.`);
    }
    if (input.stageWorkspace === false) {
      return {
        workspaceRoot,
        cwd,
        stagedFiles: [],
      };
    }

    const explicitIncludes = Array.isArray(input.includePaths)
      ? input.includePaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const maxFiles = Math.max(1, input.maxFiles ?? this.defaultMaxFiles);
    const maxBytes = Math.max(1_024, input.maxBytes ?? this.defaultMaxBytes);
    const stagedByRemotePath = new Map<string, RemoteExecutionStagedFile>();
    let stagedBytes = 0;

    const stageFile = async (filePath: string): Promise<void> => {
      const absolutePath = resolve(filePath);
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        throw new Error(`Remote execution path '${absolutePath}' is outside workspace root '${workspaceRoot}'.`);
      }
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        return;
      }
      if (stats.isDirectory()) {
        return;
      }
      if (!stats.isFile()) {
        return;
      }
      const remotePath = toRemoteWorkspacePath(absolutePath, workspaceRoot);
      if (stagedByRemotePath.has(remotePath)) {
        return;
      }
      const content = await readFile(absolutePath);
      const nextBytes = stagedBytes + content.length;
      if (stagedByRemotePath.size + 1 > maxFiles) {
        throw new Error(
          `Remote execution staging exceeded the ${maxFiles}-file limit. Narrow the run with includePaths.`,
        );
      }
      if (nextBytes > maxBytes) {
        throw new Error(
          `Remote execution staging exceeded the ${(maxBytes / (1024 * 1024)).toFixed(1)} MB limit. Narrow the run with includePaths.`,
        );
      }
      stagedBytes = nextBytes;
      stagedByRemotePath.set(remotePath, {
        localPath: absolutePath,
        remotePath,
        content,
        mode: inferExecutableMode(stats.mode, content),
      });
    };

    const walk = async (targetPath: string, applyDefaultExcludes: boolean): Promise<void> => {
      const absolutePath = resolve(targetPath);
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        throw new Error(`Remote execution path '${absolutePath}' is outside workspace root '${workspaceRoot}'.`);
      }
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        return;
      }
      if (stats.isFile()) {
        await stageFile(absolutePath);
        return;
      }
      if (!stats.isDirectory()) {
        return;
      }
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (isExcludedName(entry.name, applyDefaultExcludes)) {
          continue;
        }
        await walk(resolve(absolutePath, entry.name), applyDefaultExcludes);
      }
    };

    if (explicitIncludes.length > 0) {
      for (const includePath of explicitIncludes) {
        const absolutePath = resolve(cwd, includePath);
        if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
          throw new Error(`Remote execution includePath '${includePath}' escapes workspace root '${workspaceRoot}'.`);
        }
        const topLevelName = basename(absolutePath);
        if (ALWAYS_EXCLUDED_NAMES.has(topLevelName)) {
          continue;
        }
        await walk(absolutePath, false);
      }
    } else {
      await walk(workspaceRoot, true);
    }

    return {
      workspaceRoot,
      cwd,
      stagedFiles: [...stagedByRemotePath.values()],
    };
  }
}
