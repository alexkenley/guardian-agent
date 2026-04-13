import type {
  RemoteExecutionBackendKind,
  RemoteExecutionHealthState,
  RemoteExecutionNetworkMode,
  RemoteExecutionTargetHealthSummary,
} from './policy.js';

export type RemoteExecutionRunStatus = 'succeeded' | 'failed' | 'timed_out';
export type RemoteExecutionCommandMode = 'direct_exec' | 'shell_fallback';
export type RemoteExecutionLeaseScope = 'ephemeral' | 'code_session';
export type RemoteExecutionLeaseMode = 'ephemeral' | 'managed';

export interface RemoteExecutionResolvedTargetBase {
  id: string;
  profileId: string;
  profileName: string;
  backendKind: RemoteExecutionBackendKind;
  networkMode: RemoteExecutionNetworkMode;
  allowedDomains: string[];
  allowedCidrs: string[];
  defaultTimeoutMs?: number;
  defaultVcpus?: number;
}

export interface VercelRemoteExecutionResolvedTarget extends RemoteExecutionResolvedTargetBase {
  backendKind: 'vercel_sandbox';
  token: string;
  teamId: string;
  projectId: string;
  apiBaseUrl?: string;
}

export interface DaytonaRemoteExecutionResolvedTarget extends RemoteExecutionResolvedTargetBase {
  backendKind: 'daytona_sandbox';
  apiKey: string;
  apiUrl?: string;
  target?: string;
  language?: string;
}

export type RemoteExecutionResolvedTarget =
  | VercelRemoteExecutionResolvedTarget
  | DaytonaRemoteExecutionResolvedTarget;

export interface RemoteExecutionCommandSpec {
  requestedCommand: string;
  entryCommand: string;
  args: string[];
  execMode: RemoteExecutionCommandMode;
}

export interface RemoteExecutionWorkspaceSpec {
  workspaceRoot: string;
  cwd: string;
  stageWorkspace?: boolean;
  includePaths?: string[];
  maxFiles?: number;
  maxBytes?: number;
}

export interface RemoteExecutionRunRequest {
  target: RemoteExecutionResolvedTarget;
  command: RemoteExecutionCommandSpec;
  workspace: RemoteExecutionWorkspaceSpec;
  artifactPaths?: string[];
  timeoutMs?: number;
  vcpus?: number;
  runtime?: string;
  env?: Record<string, string>;
  onProgress?: (message: string) => void;
  codeSessionId?: string;
  requestId?: string;
  preferredLease?: RemoteExecutionLease;
  leaseMode?: RemoteExecutionLeaseMode;
}

export interface RemoteExecutionStagedFile {
  localPath: string;
  remotePath: string;
  content: Buffer;
  mode?: number;
}

export interface RemoteExecutionPreparedRequest
  extends Omit<RemoteExecutionRunRequest, 'workspace'> {
  workspaceRoot: string;
  cwd: string;
  stagedFiles: RemoteExecutionStagedFile[];
}

export interface RemoteExecutionArtifact {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface RemoteExecutionProbeResult {
  targetId: string;
  backendKind: RemoteExecutionBackendKind;
  profileId: string;
  profileName: string;
  healthState: RemoteExecutionHealthState;
  reason: string;
  checkedAt: number;
  durationMs: number;
  sandboxId?: string;
}

export interface RemoteExecutionLeaseInspectionResult {
  targetId: string;
  backendKind: RemoteExecutionBackendKind;
  profileId: string;
  profileName: string;
  healthState: RemoteExecutionHealthState;
  reason: string;
  checkedAt: number;
  durationMs: number;
  sandboxId?: string;
  remoteWorkspaceRoot?: string;
}

export interface RemoteExecutionLease {
  id: string;
  targetId: string;
  backendKind: RemoteExecutionBackendKind;
  profileId: string;
  profileName: string;
  sandboxId: string;
  localWorkspaceRoot: string;
  remoteWorkspaceRoot: string;
  codeSessionId?: string;
  acquiredAt: number;
  lastUsedAt: number;
  expiresAt: number;
  runtime?: string;
  vcpus?: number;
  trackedRemotePaths: string[];
  leaseMode: RemoteExecutionLeaseMode;
}

export interface RemoteExecutionProviderLease extends RemoteExecutionLease {
  state?: unknown;
}

export interface RemoteExecutionLeaseCreateRequest {
  target: RemoteExecutionResolvedTarget;
  localWorkspaceRoot: string;
  codeSessionId?: string;
  timeoutMs?: number;
  vcpus?: number;
  runtime?: string;
  leaseMode?: RemoteExecutionLeaseMode;
}

export interface RemoteExecutionLeaseAcquireRequest extends RemoteExecutionLeaseCreateRequest {
  existingLease?: RemoteExecutionLease;
}

export interface RemoteExecutionRunResult {
  targetId: string;
  backendKind: RemoteExecutionBackendKind;
  profileId: string;
  profileName: string;
  requestedCommand: string;
  status: RemoteExecutionRunStatus;
  sandboxId?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: number;
  completedAt: number;
  networkMode: RemoteExecutionNetworkMode;
  allowedDomains: string[];
  allowedCidrs: string[];
  stagedFiles: number;
  stagedBytes: number;
  workspaceRoot: string;
  cwd: string;
  artifactFiles: RemoteExecutionArtifact[];
  onProgress?: (message: string) => void;
  healthState?: RemoteExecutionHealthState;
  healthReason?: string;
  leaseId?: string;
  leaseScope?: RemoteExecutionLeaseScope;
  leaseReused?: boolean;
  leaseMode?: RemoteExecutionLeaseMode;
}

export interface RemoteExecutionProviderCapabilities {
  reconnectExisting: boolean;
  restartStoppedSandbox: boolean;
}

export interface RemoteExecutionProvider {
  readonly backendKind: RemoteExecutionBackendKind;
  readonly capabilities: RemoteExecutionProviderCapabilities;
  probe(target: RemoteExecutionResolvedTarget): Promise<RemoteExecutionProbeResult>;
  inspectLease(
    target: RemoteExecutionResolvedTarget,
    lease: RemoteExecutionLease,
  ): Promise<RemoteExecutionLeaseInspectionResult>;
  createLease(request: RemoteExecutionLeaseCreateRequest): Promise<RemoteExecutionProviderLease>;
  resumeLease(target: RemoteExecutionResolvedTarget, lease: RemoteExecutionLease): Promise<RemoteExecutionProviderLease>;
  runWithLease(lease: RemoteExecutionProviderLease, request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult>;
  releaseLease(lease: RemoteExecutionProviderLease): Promise<void>;
  run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult>;
}

export interface RemoteExecutionServiceLike {
  runBoundedJob(request: RemoteExecutionRunRequest): Promise<RemoteExecutionRunResult>;
  acquireLease?(request: RemoteExecutionLeaseAcquireRequest): Promise<RemoteExecutionLease>;
  disposeLease?(request: { target: RemoteExecutionResolvedTarget; lease: RemoteExecutionLease }): Promise<void>;
  inspectLease?(request: {
    target: RemoteExecutionResolvedTarget;
    lease: RemoteExecutionLease;
  }): Promise<RemoteExecutionLeaseInspectionResult>;
  getKnownTargetHealth?(): Record<string, RemoteExecutionTargetHealthSummary>;
  listActiveLeases?(): RemoteExecutionLease[];
}
