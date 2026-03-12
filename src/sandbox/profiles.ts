/**
 * Sandbox profile builders.
 *
 * Constructs bwrap CLI arguments, ulimit prefixes, and hardened environment
 * variables for OS-level process isolation.
 */

import type { SandboxProfile, SandboxResourceLimits, SandboxConfig } from './types.js';

/** Paths that must stay read-only even when their parent is writable. */
export const PROTECTED_PATHS = [
  '.git',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
] as const;

/** Environment variables stripped from child processes. */
const DANGEROUS_ENV_VARS = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYLIB',
  'RUBYOPT',
  'PERL5LIB',
  'PERL5OPT',
  'BROWSER',
  'COLORTERM',
] as const;

/**
 * Build bwrap CLI arguments for a given sandbox profile.
 *
 * @param profile - Sandbox profile to apply
 * @param workspacePath - Absolute path to workspace root
 * @param opts - Additional configuration
 * @returns Array of bwrap arguments (empty for full-access)
 */
export function buildBwrapArgs(
  profile: SandboxProfile,
  workspacePath: string,
  opts: {
    networkAccess?: boolean;
    additionalWritePaths?: string[];
    additionalReadPaths?: string[];
  } = {},
): string[] {
  if (profile === 'full-access') {
    return [];
  }

  const args: string[] = [];

  if (profile === 'agent-worker') {
    // Agent Worker: strictest isolation. Only essentials, writable ephemeral workspace.
    args.push('--ro-bind', '/usr', '/usr');
    args.push('--ro-bind', '/lib', '/lib');
    args.push('--ro-bind-try', '/lib64', '/lib64');
    args.push('--ro-bind', '/bin', '/bin');
    args.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf');
    args.push('--ro-bind-try', '/etc/ssl', '/etc/ssl');
    args.push('--symlink', 'usr/lib', '/lib64'); // Fallback symlink if no real /lib64
    
    args.push('--proc', '/proc');
    args.push('--dev', '/dev');
    args.push('--tmpfs', '/tmp');
    
    // Bind workspace to the ephemeral path
    args.push('--bind', workspacePath, workspacePath);
    args.push('--setenv', 'HOME', workspacePath);
    args.push('--setenv', 'TMPDIR', `${workspacePath}/tmp`);
    
    // Process & IPC isolation
    args.push('--unshare-pid');
    args.push('--unshare-ipc');
    args.push('--die-with-parent');
    args.push('--new-session');

    // Network is required for LLM API calls, egress restricted by app-level proxy or routing
    if (opts.networkAccess) {
      args.push('--share-net');
    } else {
      args.push('--unshare-net');
    }
    
    return args;
  }

  // Base filesystem: read-only bind of root
  args.push('--ro-bind', '/', '/');

  // Proc, dev, tmp
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--tmpfs', '/tmp');

  // Process isolation
  args.push('--unshare-pid');
  args.push('--die-with-parent');
  args.push('--new-session');

  // Network isolation (unless explicitly allowed)
  if (!opts.networkAccess) {
    args.push('--unshare-net');
  }

  // Workspace write access
  if (profile === 'workspace-write') {
    args.push('--bind', workspacePath, workspacePath);

    // Override protected paths within workspace to read-only
    for (const protectedPath of PROTECTED_PATHS) {
      const fullPath = `${workspacePath}/${protectedPath}`;
      args.push('--ro-bind-try', fullPath, fullPath);
    }
  }

  // Additional writable paths
  if (opts.additionalWritePaths) {
    for (const p of opts.additionalWritePaths) {
      if (p) args.push('--bind', p, p);
    }
  }

  // Additional read-only paths
  if (opts.additionalReadPaths) {
    for (const p of opts.additionalReadPaths) {
      if (p) args.push('--ro-bind-try', p, p);
    }
  }

  return args;
}

/**
 * Build a ulimit prefix string for resource limiting.
 *
 * Returns an empty string if all limits are zero (unlimited).
 */
export function buildUlimitPrefix(limits: SandboxResourceLimits): string {
  const parts: string[] = [];

  if (limits.maxMemoryMb > 0) {
    // ulimit -v uses kilobytes
    parts.push(`ulimit -v ${limits.maxMemoryMb * 1024}`);
  }
  if (limits.maxCpuSeconds > 0) {
    parts.push(`ulimit -t ${limits.maxCpuSeconds}`);
  }
  if (limits.maxFileSizeKb > 0) {
    parts.push(`ulimit -f ${limits.maxFileSizeKb}`);
  }
  if (limits.maxProcesses > 0) {
    parts.push(`ulimit -u ${limits.maxProcesses}`);
  }

  if (parts.length === 0) return '';
  return parts.join(' && ') + ' && ';
}

/**
 * Build a hardened environment by stripping dangerous variables.
 *
 * Returns a new env object with dangerous vars removed and PATH preserved.
 */
export function buildHardenedEnv(baseEnv?: Record<string, string | undefined>): Record<string, string> {
  const env = { ...(baseEnv ?? process.env) } as Record<string, string>;
  const stripped = new Set<string>(DANGEROUS_ENV_VARS);

  for (const key of stripped) {
    delete env[key];
  }

  return env;
}

/**
 * Resolve effective sandbox options by merging config defaults with per-invocation overrides.
 */
export function resolveProfile(
  config: SandboxConfig,
  overrides?: { profile?: SandboxProfile; networkAccess?: boolean },
): { profile: SandboxProfile; networkAccess: boolean } {
  return {
    profile: overrides?.profile ?? config.mode,
    networkAccess: overrides?.networkAccess ?? config.networkAccess,
  };
}
