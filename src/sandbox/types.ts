/**
 * OS-level process isolation types.
 *
 * Defines sandbox profiles, resource limits, and configuration for
 * bwrap-based (bubblewrap) process isolation on Linux, with graceful
 * fallback to ulimit + env hardening on other platforms.
 */

/** Sandbox profile determines how much filesystem access the child process gets. */
export type SandboxProfile = 'read-only' | 'workspace-write' | 'full-access';

/** Resource limits enforced via ulimit on the child process. */
export interface SandboxResourceLimits {
  /** Max virtual memory in MB (ulimit -v). 0 = unlimited. */
  maxMemoryMb: number;
  /** Max CPU time in seconds (ulimit -t). 0 = unlimited. */
  maxCpuSeconds: number;
  /** Max file size in KB (ulimit -f). 0 = unlimited. */
  maxFileSizeKb: number;
  /** Max number of processes (ulimit -u). 0 = unlimited. */
  maxProcesses: number;
}

/** Top-level sandbox configuration stored in config.yaml. */
export interface SandboxConfig {
  /** Enable OS-level process isolation. When false, all commands run unsandboxed. */
  enabled: boolean;
  /** Default sandbox profile for tool executions. */
  mode: SandboxProfile;
  /** Allow network access in sandboxed processes. */
  networkAccess: boolean;
  /** Additional writable paths beyond workspace root. */
  additionalWritePaths: string[];
  /** Additional read-only bind paths. */
  additionalReadPaths: string[];
  /** Resource limits for child processes. */
  resourceLimits: SandboxResourceLimits;
}

/** Per-invocation options for sandboxedExec. */
export interface SandboxExecOptions {
  /** Override the default profile for this invocation. */
  profile?: SandboxProfile;
  /** Override network access for this invocation. */
  networkAccess?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Max output buffer size in bytes. */
  maxBuffer?: number;
  /** Environment variables to pass through. */
  env?: Record<string, string>;
}

/** Per-invocation options for sandboxedSpawn. */
export interface SandboxSpawnOptions {
  /** Override the default profile for this invocation. */
  profile?: SandboxProfile;
  /** Override network access for this invocation. */
  networkAccess?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables to pass through. */
  env?: Record<string, string>;
  /** stdio configuration for the spawned process. */
  stdio?: import('node:child_process').StdioOptions;
}

/** Result of sandbox capability detection. */
export interface SandboxCapabilities {
  /** Whether bubblewrap (bwrap) is available. */
  bwrapAvailable: boolean;
  /** bwrap version string if available. */
  bwrapVersion?: string;
  /** Whether ulimit is available (always true on POSIX). */
  ulimitAvailable: boolean;
}

/** Default resource limits. */
export const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
  maxMemoryMb: 512,
  maxCpuSeconds: 60,
  maxFileSizeKb: 10_240, // 10 MB
  maxProcesses: 0, // 0 = unlimited (ulimit -u not set); bwrap provides PID namespace isolation instead
};

/** Default sandbox configuration. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  mode: 'workspace-write',
  networkAccess: false,
  additionalWritePaths: [],
  additionalReadPaths: [],
  resourceLimits: { ...DEFAULT_RESOURCE_LIMITS },
};
