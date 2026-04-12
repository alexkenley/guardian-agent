import type {
  RemoteExecutionBackendKind,
  RemoteExecutionNetworkMode,
} from './policy.js';

export type RemoteExecutionRunStatus = 'succeeded' | 'failed' | 'timed_out';
export type RemoteExecutionCommandMode = 'direct_exec' | 'shell_fallback';

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
}

export interface RemoteExecutionProvider {
  readonly backendKind: RemoteExecutionBackendKind;
  run(request: RemoteExecutionPreparedRequest): Promise<RemoteExecutionRunResult>;
}

export interface RemoteExecutionServiceLike {
  runBoundedJob(request: RemoteExecutionRunRequest): Promise<RemoteExecutionRunResult>;
}
