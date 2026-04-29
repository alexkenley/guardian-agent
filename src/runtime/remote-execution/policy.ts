import type { AssistantCloudConfig } from '../../config/types.js';
import type { CodeSessionWorkflowType } from '../coding-workflows.js';
import type { RemoteExecutionWorkspaceContext } from './types.js';

export type RemoteExecutionBackendKind = 'vercel_sandbox' | 'daytona_sandbox';
export type RemoteExecutionCapabilityState = 'disabled' | 'incomplete' | 'ready';
export type RemoteExecutionNetworkMode = 'deny_all' | 'allow_all' | 'domain_allowlist' | 'cidr_allowlist';
export type RemoteExecutionHealthState = 'unknown' | 'healthy' | 'unreachable';

export interface RemoteExecutionTargetHealthSummary {
  state: RemoteExecutionHealthState;
  reason: string;
  checkedAt: number;
  durationMs?: number;
  leaseId?: string;
  sandboxId?: string;
}

export interface RemoteExecutionTargetDescriptor {
  id: string;
  profileId: string;
  profileName: string;
  providerFamily: 'vercel' | 'daytona';
  backendKind: RemoteExecutionBackendKind;
  capabilityState: RemoteExecutionCapabilityState;
  reason: string;
  projectId?: string;
  teamId?: string;
  target?: string;
  language?: string;
  defaultTimeoutMs?: number;
  defaultVcpus?: number;
  networkMode: RemoteExecutionNetworkMode;
  allowedDomains: string[];
  allowedCidrs: string[];
  snapshotConfigured?: boolean;
  snapshotLabel?: string;
  healthState?: RemoteExecutionHealthState;
  healthReason?: string;
  healthCheckedAt?: number;
  healthDurationMs?: number;
  activeLeaseId?: string;
  activeSandboxId?: string;
  routingReason?: string;
}

export interface RemoteExecutionTargetDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: 'default_target_missing' | 'default_target_not_ready' | 'target_unreachable' | 'no_ready_targets';
  targetId?: string;
  profileName?: string;
  message: string;
}

export interface WorkflowIsolationRecommendation {
  level: 'none' | 'available' | 'recommended';
  backendKind?: RemoteExecutionBackendKind;
  profileId?: string;
  profileName?: string;
  reason?: string;
  candidateOperations: string[];
  networkMode?: RemoteExecutionNetworkMode;
  allowedDomains?: string[];
  allowedCidrs?: string[];
}

export function prioritizeReadyRemoteExecutionTargets(
  targets: RemoteExecutionTargetDescriptor[],
  preferredTargetIds: Array<string | null | undefined> = [],
  commandString?: string,
  workspaceContext?: RemoteExecutionWorkspaceContext,
): RemoteExecutionTargetDescriptor[] {
  const readyTargets = targets.filter((entry) => isRemoteExecutionTargetReady(entry));
  if (readyTargets.length === 0) {
    return [];
  }

  let orderedPreferredIds = preferredTargetIds
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value) && value !== 'automatic');

  if (commandString) {
    const isBurst = /^(npm|pnpm|yarn|bun|pip) (install|add|remove|ci)/.test(commandString)
      || /^(npm|pnpm|yarn|bun) run (lint|test|format)/.test(commandString)
      || /^(pytest|jest|vitest|eslint|prettier)/.test(commandString);
    const isStateful = /^(npm|pnpm|yarn|bun) run (build|dev|start)/.test(commandString)
      || /^(tsc|webpack|vite|rollup|next build)/.test(commandString);
      
    const hasVercel = readyTargets.some((t) => t.backendKind === 'vercel_sandbox');
    const hasDaytona = readyTargets.some((t) => t.backendKind === 'daytona_sandbox');
    
    if (hasVercel && hasDaytona) {
       // Heuristic: If workspace requires build-essential capabilities or native dependencies, veto Vercel.
       // Vercel sandboxes are typically lean and lack build tools for compilation (C++, Rust, Go, Python native).
       const needsBuildEnv = workspaceContext?.requiredCapabilityTier === 'build_essential' 
          || workspaceContext?.requiredCapabilityTier === 'full_os_persistence'
          || workspaceContext?.hasNativeDependencies;

       if (needsBuildEnv) {
          const bestDaytona = readyTargets.find((t) => t.backendKind === 'daytona_sandbox');
          if (bestDaytona) {
            bestDaytona.routingReason = 'build_environment_required';
            orderedPreferredIds = [bestDaytona.id, ...orderedPreferredIds.filter((id) => id !== bestDaytona.id)];
          }
       } else if (isBurst) {
          const bestVercel = readyTargets.find((t) => t.backendKind === 'vercel_sandbox');
          if (bestVercel) {
            bestVercel.routingReason = 'burst_task_optimization';
            orderedPreferredIds = [bestVercel.id, ...orderedPreferredIds.filter((id) => id !== bestVercel.id)];
          }
       } else if (isStateful) {
          const bestDaytona = readyTargets.find((t) => t.backendKind === 'daytona_sandbox');
          if (bestDaytona) {
            bestDaytona.routingReason = 'stateful_task_optimization';
            orderedPreferredIds = [bestDaytona.id, ...orderedPreferredIds.filter((id) => id !== bestDaytona.id)];
          }
       }
    }
  }

  if (orderedPreferredIds.length === 0) {
    return sortSnapshotBackedTargets(readyTargets);
  }

  const seen = new Set<string>();
  const prioritized: RemoteExecutionTargetDescriptor[] = [];
  for (const preferredId of orderedPreferredIds) {
    const match = readyTargets.find((entry) => entry.id === preferredId);
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    prioritized.push(match);
  }

  for (const entry of readyTargets) {
    if (seen.has(entry.id)) continue;
    prioritized.push(entry);
  }

  return [
    ...prioritized.filter((entry) => orderedPreferredIds.includes(entry.id)),
    ...sortSnapshotBackedTargets(prioritized.filter((entry) => !orderedPreferredIds.includes(entry.id))),
  ];
}

function sortSnapshotBackedTargets(
  targets: RemoteExecutionTargetDescriptor[],
): RemoteExecutionTargetDescriptor[] {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => {
      const snapshotDelta = Number(Boolean(right.target.snapshotConfigured)) - Number(Boolean(left.target.snapshotConfigured));
      if (snapshotDelta !== 0) return snapshotDelta;
      return left.index - right.index;
    })
    .map((entry) => entry.target);
}

function normalizeAllowedDomains(input: string[] | undefined): string[] {
  return (input ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function inferNetworkMode(input: {
  allowNetwork?: boolean;
  allowedDomains?: string[];
  allowedCidrs?: string[];
} | undefined): RemoteExecutionNetworkMode {
  if (input?.allowNetwork === false) return 'deny_all';
  if ((input?.allowedDomains?.length ?? 0) > 0) return 'domain_allowlist';
  if ((input?.allowedCidrs?.length ?? 0) > 0) return 'cidr_allowlist';
  return 'allow_all';
}

export function listRemoteExecutionTargets(
  cloud: AssistantCloudConfig | null | undefined,
  options: {
    healthByTargetId?: Record<string, RemoteExecutionTargetHealthSummary | undefined>;
  } = {},
): RemoteExecutionTargetDescriptor[] {
  const vercelTargets = (cloud?.vercelProfiles ?? []).map((profile) => {
    const allowedDomains = normalizeAllowedDomains(profile.sandbox?.allowedDomains);
    const networkMode = inferNetworkMode({
      allowNetwork: profile.sandbox?.allowNetwork,
      allowedDomains,
    });
    const sandboxEnabled = profile.sandbox?.enabled === true;
    const hasToken = !!profile.apiToken?.trim() || !!profile.credentialRef?.trim();
    const hasTeamId = !!profile.teamId?.trim();
    const hasProjectId = !!profile.sandbox?.projectId?.trim();
    const capabilityState: RemoteExecutionCapabilityState = !sandboxEnabled
      ? 'disabled'
      : !hasToken
        ? 'incomplete'
        : !hasTeamId
          ? 'incomplete'
          : !hasProjectId
            ? 'incomplete'
            : 'ready';
    const reason = capabilityState === 'ready'
      ? 'Ready for bounded remote sandbox execution.'
      : !sandboxEnabled
        ? 'Sandbox capability is disabled for this Vercel profile.'
        : !hasToken
          ? 'Sandbox capability needs a resolved Vercel token or credential ref.'
          : !hasTeamId
            ? 'Sandbox capability needs a Vercel teamId for access-token authentication.'
            : 'Sandbox capability needs a Vercel sandbox projectId.';
    const id = `vercel:${profile.id}`;
    const health = options.healthByTargetId?.[id];
    const baseSnapshotId = profile.sandbox?.baseSnapshotId?.trim() || undefined;
    return {
      id,
      profileId: profile.id,
      profileName: profile.name,
      providerFamily: 'vercel' as const,
      backendKind: 'vercel_sandbox' as const,
      capabilityState,
      reason,
      projectId: profile.sandbox?.projectId?.trim() || undefined,
      teamId: profile.teamId?.trim() || undefined,
      defaultTimeoutMs: typeof profile.sandbox?.defaultTimeoutMs === 'number' ? profile.sandbox.defaultTimeoutMs : undefined,
      defaultVcpus: typeof profile.sandbox?.defaultVcpus === 'number' ? profile.sandbox.defaultVcpus : undefined,
      networkMode,
      allowedDomains,
      allowedCidrs: [],
      snapshotConfigured: !!baseSnapshotId,
      snapshotLabel: baseSnapshotId,
      healthState: health?.state,
      healthReason: health?.reason,
      healthCheckedAt: health?.checkedAt,
      healthDurationMs: health?.durationMs,
      activeLeaseId: health?.leaseId,
      activeSandboxId: health?.sandboxId,
    };
  });
  const daytonaTargets = (cloud?.daytonaProfiles ?? []).map((profile) => {
    const allowedCidrs = (profile.allowedCidrs ?? [])
      .map((cidr) => cidr.trim())
      .filter(Boolean);
    const networkMode = inferNetworkMode({
      allowNetwork: profile.allowNetwork,
      allowedCidrs,
    });
    const sandboxEnabled = profile.enabled === true;
    const hasToken = !!profile.apiKey?.trim() || !!profile.credentialRef?.trim();
    const capabilityState: RemoteExecutionCapabilityState = !sandboxEnabled
      ? 'disabled'
      : !hasToken
        ? 'incomplete'
        : 'ready';
    const reason = capabilityState === 'ready'
      ? 'Ready for bounded remote sandbox execution.'
      : !sandboxEnabled
        ? 'Sandbox capability is disabled for this Daytona profile.'
        : 'Sandbox capability needs a resolved Daytona API key or credential ref.';
    const id = `daytona:${profile.id}`;
    const health = options.healthByTargetId?.[id];
    const snapshot = profile.snapshot?.trim() || undefined;
    return {
      id,
      profileId: profile.id,
      profileName: profile.name,
      providerFamily: 'daytona' as const,
      backendKind: 'daytona_sandbox' as const,
      capabilityState,
      reason,
      target: profile.target?.trim() || undefined,
      language: profile.language?.trim() || undefined,
      defaultTimeoutMs: typeof profile.defaultTimeoutMs === 'number' ? profile.defaultTimeoutMs : undefined,
      defaultVcpus: typeof profile.defaultVcpus === 'number' ? profile.defaultVcpus : undefined,
      networkMode,
      allowedDomains: [],
      allowedCidrs,
      snapshotConfigured: !!snapshot,
      snapshotLabel: snapshot,
      healthState: health?.state,
      healthReason: health?.reason,
      healthCheckedAt: health?.checkedAt,
      healthDurationMs: health?.durationMs,
      activeLeaseId: health?.leaseId,
      activeSandboxId: health?.sandboxId,
    };
  });
  return [...vercelTargets, ...daytonaTargets];
}

export function isRemoteExecutionTargetReady(target: Pick<RemoteExecutionTargetDescriptor, 'capabilityState' | 'healthState'>): boolean {
  return target.capabilityState === 'ready' && target.healthState !== 'unreachable';
}

export function buildRemoteExecutionTargetDiagnostics(
  targets: RemoteExecutionTargetDescriptor[],
  defaultTargetId?: string | null,
): RemoteExecutionTargetDiagnostic[] {
  const diagnostics: RemoteExecutionTargetDiagnostic[] = [];
  const trimmedDefaultTargetId = defaultTargetId?.trim();
  const configuredDefaultTargetId = trimmedDefaultTargetId && trimmedDefaultTargetId !== 'automatic'
    ? trimmedDefaultTargetId
    : '';
  const defaultTarget = configuredDefaultTargetId
    ? targets.find((entry) => entry.id === configuredDefaultTargetId)
    : null;

  if (configuredDefaultTargetId && !defaultTarget) {
    diagnostics.push({
      severity: 'warning',
      code: 'default_target_missing',
      targetId: configuredDefaultTargetId,
      message: `Configured default remote sandbox target '${configuredDefaultTargetId}' does not match any current Vercel or Daytona profile.`,
    });
  } else if (defaultTarget && !isRemoteExecutionTargetReady(defaultTarget)) {
    const reason = defaultTarget.healthState === 'unreachable'
      ? defaultTarget.healthReason || 'The last target health check marked it unreachable.'
      : defaultTarget.reason;
    diagnostics.push({
      severity: 'warning',
      code: 'default_target_not_ready',
      targetId: defaultTarget.id,
      profileName: defaultTarget.profileName,
      message: `Configured default remote sandbox target '${defaultTarget.profileName}' is not ready: ${reason}`,
    });
  }

  for (const target of targets) {
    if (target.healthState !== 'unreachable') continue;
    diagnostics.push({
      severity: 'warning',
      code: 'target_unreachable',
      targetId: target.id,
      profileName: target.profileName,
      message: `Remote sandbox target '${target.profileName}' is currently unreachable: ${target.healthReason || 'last health check failed'}`,
    });
  }

  if (targets.length > 0 && !targets.some((entry) => isRemoteExecutionTargetReady(entry))) {
    diagnostics.push({
      severity: 'warning',
      code: 'no_ready_targets',
      message: 'No ready remote sandbox targets are available for this coding workspace.',
    });
  }

  return diagnostics;
}

function workflowIsolationOperations(type: CodeSessionWorkflowType): string[] {
  switch (type) {
    case 'implementation':
      return ['dependency install', 'build', 'targeted test verification'];
    case 'bug_fix':
      return ['failing-command reproduction', 'targeted test verification', 'build verification'];
    case 'code_review':
      return ['bounded repo scan', 'detached verification command'];
    case 'refactor':
      return ['build', 'targeted test verification'];
    case 'test_repair':
      return ['failing test reruns', 'targeted test verification'];
    case 'dependency_review':
      return ['dependency install', 'build', 'test'];
    case 'spec_to_plan':
      return [];
    default:
      return [];
  }
}

export function recommendWorkflowIsolation(
  workflowType: CodeSessionWorkflowType,
  options: {
    targets?: RemoteExecutionTargetDescriptor[];
    workspaceTrustState?: string | null;
    defaultRemoteExecutionTargetId?: string;
  } = {},
): WorkflowIsolationRecommendation {
  const candidateOperations = workflowIsolationOperations(workflowType);
  if (candidateOperations.length === 0) {
    return {
      level: 'none',
      candidateOperations,
      reason: 'This workflow ends at planning, so remote execution is not needed.',
    };
  }

  const readyTargets = prioritizeReadyRemoteExecutionTargets(
    options.targets ?? [],
    [options.defaultRemoteExecutionTargetId],
  );
  const target = readyTargets[0];

  if (!target) {
    return {
      level: 'none',
      candidateOperations,
      reason: 'No ready remote sandbox target is configured for this workspace.',
    };
  }

  const trustState = typeof options.workspaceTrustState === 'string'
    ? options.workspaceTrustState.trim().toLowerCase()
    : '';
  const recommended = trustState === 'caution'
    || trustState === 'blocked'
    || workflowType === 'dependency_review';
  const reason = trustState === 'caution' || trustState === 'blocked'
    ? 'Workspace trust is not fully cleared, so bounded execution and verification should stay off the host when possible.'
    : workflowType === 'dependency_review'
      ? 'Dependency installs and upgrade verification are the cleanest first use for remote isolation.'
      : workflowType === 'bug_fix' || workflowType === 'test_repair'
        ? 'Keep local edits local, but use the sandbox for reproduction and verification when repo scripts may be semi-trusted.'
        : 'Keep normal editing local and reserve the sandbox for bounded verification or higher-risk execution.';

  return {
    level: recommended ? 'recommended' : 'available',
    backendKind: target.backendKind,
    profileId: target.profileId,
    profileName: target.profileName,
    reason,
    candidateOperations,
    networkMode: target.networkMode,
    allowedDomains: (target.allowedDomains?.length ?? 0) > 0 ? [...target.allowedDomains] : undefined,
    allowedCidrs: (target.allowedCidrs?.length ?? 0) > 0 ? [...target.allowedCidrs] : undefined,
  };
}
