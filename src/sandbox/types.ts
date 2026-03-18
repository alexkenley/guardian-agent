/**
 * OS-level process isolation types.
 *
 * Defines sandbox profiles, resource limits, and configuration for
 * bwrap-based (bubblewrap) process isolation on Linux, with graceful
 * fallback to ulimit + env hardening on other platforms.
 */

/** Sandbox profile determines how much filesystem access the child process gets. */
export type SandboxProfile = 'read-only' | 'workspace-write' | 'full-access' | 'agent-worker';
export type SandboxEnforcementMode = 'permissive' | 'strict';
export type SandboxAvailability = 'strong' | 'degraded' | 'unavailable';

export interface WindowsSandboxHelperConfig {
  /** Enable the native Windows sandbox helper backend when available. */
  enabled: boolean;
  /** Helper command path or name. */
  command?: string;
  /** Extra fixed arguments passed before subcommands. */
  args?: string[];
  /** Timeout for helper health checks in milliseconds. */
  timeoutMs?: number;
}

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
  /** Whether risky tools may run on degraded sandbox backends. */
  enforcementMode?: SandboxEnforcementMode;
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
  /** Optional native Windows sandbox helper configuration. */
  windowsHelper?: WindowsSandboxHelperConfig;
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
  /** On Windows, force shell wrapping for .cmd/.bat shims unless explicitly disabled. */
  windowsShell?: boolean;
}

/** Result of sandbox capability detection. */
export interface SandboxCapabilities {
  /** Whether bubblewrap (bwrap) is available. */
  bwrapAvailable: boolean;
  /** bwrap version string if available. */
  bwrapVersion?: string;
  /** Whether ulimit is available (always true on POSIX). */
  ulimitAvailable: boolean;
  /** Whether the configured native Windows helper is available. */
  windowsHelperAvailable?: boolean;
  /** Windows helper version string if available. */
  windowsHelperVersion?: string;
}

export interface SandboxHealth {
  enabled: boolean;
  platform: NodeJS.Platform;
  availability: SandboxAvailability;
  backend: 'bubblewrap' | 'windows-helper' | 'ulimit' | 'env' | 'none';
  enforcementMode: SandboxEnforcementMode;
  reasons: string[];
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
  enforcementMode: 'permissive',
  mode: 'workspace-write',
  networkAccess: false,
  additionalWritePaths: [],
  additionalReadPaths: [],
  resourceLimits: { ...DEFAULT_RESOURCE_LIMITS },
  windowsHelper: {
    enabled: false,
    args: [],
    timeoutMs: 5_000,
  },
};
