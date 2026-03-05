/**
 * OS-level process sandbox.
 *
 * Provides sandboxed exec/spawn wrappers using bubblewrap (bwrap) on Linux
 * with graceful fallback to ulimit + env hardening when bwrap is unavailable.
 */

import { exec as execCb, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../util/logging.js';
import type { SandboxConfig, SandboxExecOptions, SandboxSpawnOptions, SandboxCapabilities } from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import { buildBwrapArgs, buildUlimitPrefix, buildHardenedEnv, resolveProfile } from './profiles.js';

export type { SandboxConfig, SandboxExecOptions, SandboxSpawnOptions, SandboxCapabilities } from './types.js';
export type { SandboxProfile, SandboxResourceLimits } from './types.js';
export { DEFAULT_SANDBOX_CONFIG, DEFAULT_RESOURCE_LIMITS } from './types.js';
export { buildBwrapArgs, buildUlimitPrefix, buildHardenedEnv, PROTECTED_PATHS, PROTECTED_EXTENSIONS } from './profiles.js';

const execAsync = promisify(execCb);
const log = createLogger('sandbox');

// ─── Capability Detection ─────────────────────────────────────

let cachedCapabilities: SandboxCapabilities | null = null;

/**
 * Detect available sandbox capabilities (bwrap, ulimit).
 * Result is cached after first call.
 */
export async function detectCapabilities(): Promise<SandboxCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;

  const caps: SandboxCapabilities = {
    bwrapAvailable: false,
    ulimitAvailable: process.platform !== 'win32',
  };

  try {
    const { stdout } = await execAsync('bwrap --version', { timeout: 5_000 });
    const version = stdout.trim();
    caps.bwrapAvailable = true;
    caps.bwrapVersion = version;
    log.info({ version }, 'bubblewrap (bwrap) available');
  } catch {
    log.info('bubblewrap (bwrap) not available — using ulimit + env hardening fallback');
  }

  cachedCapabilities = caps;
  return caps;
}

/** Clear the cached capability detection result (for testing). */
export function clearCapabilityCache(): void {
  cachedCapabilities = null;
}

// ─── Sandboxed Exec ───────────────────────────────────────────

/**
 * Execute a shell command with OS-level sandboxing.
 *
 * When bwrap is available: wraps the command in a bwrap namespace.
 * When bwrap is unavailable: applies ulimit + env hardening.
 * When config.enabled is false: runs the command as-is.
 */
export async function sandboxedExec(
  command: string,
  config: SandboxConfig = DEFAULT_SANDBOX_CONFIG,
  options: SandboxExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  // Bypass sandbox entirely if disabled
  if (!config.enabled) {
    return execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
  }

  const { profile, networkAccess } = resolveProfile(config, options);

  // Full-access profile: only apply env hardening
  if (profile === 'full-access') {
    const env = buildHardenedEnv(options.env ? { ...process.env, ...options.env } as Record<string, string> : undefined);
    return execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env,
    });
  }

  const caps = await detectCapabilities();
  const hardenedEnv = buildHardenedEnv(
    options.env ? { ...process.env, ...options.env } as Record<string, string> : undefined,
  );

  if (caps.bwrapAvailable) {
    // Build bwrap command
    const workspacePath = options.cwd ?? process.cwd();
    const bwrapArgs = buildBwrapArgs(profile, workspacePath, {
      networkAccess,
      additionalWritePaths: config.additionalWritePaths,
      additionalReadPaths: config.additionalReadPaths,
    });

    const bwrapCmd = `bwrap ${bwrapArgs.map(shellEscape).join(' ')} -- /bin/sh -c ${shellEscape(command)}`;

    log.debug({ profile, networkAccess, command: command.slice(0, 80) }, 'sandboxed exec (bwrap)');

    return execAsync(bwrapCmd, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: hardenedEnv,
    });
  }

  // Fallback: ulimit prefix + env hardening
  const ulimitPrefix = caps.ulimitAvailable ? buildUlimitPrefix(config.resourceLimits) : '';
  const wrappedCmd = ulimitPrefix ? `${ulimitPrefix}${command}` : command;

  log.debug({ profile, networkAccess, hasUlimit: !!ulimitPrefix, command: command.slice(0, 80) }, 'sandboxed exec (fallback)');

  return execAsync(wrappedCmd, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: hardenedEnv,
  });
}

// ─── Sandboxed Spawn ──────────────────────────────────────────

/**
 * Spawn a long-lived child process with OS-level sandboxing.
 *
 * Used for MCP servers, browser automation, and other long-running processes.
 */
export async function sandboxedSpawn(
  command: string,
  args: string[],
  config: SandboxConfig = DEFAULT_SANDBOX_CONFIG,
  options: SandboxSpawnOptions = {},
): Promise<ChildProcess> {
  // Bypass sandbox entirely if disabled
  if (!config.enabled) {
    return spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
  }

  const { profile, networkAccess } = resolveProfile(config, options);
  const hardenedEnv = buildHardenedEnv(
    options.env ? { ...process.env, ...options.env } as Record<string, string> : undefined,
  );

  // Full-access profile: only apply env hardening
  if (profile === 'full-access') {
    return spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio,
      env: hardenedEnv,
    });
  }

  const caps = await detectCapabilities();

  if (caps.bwrapAvailable) {
    const workspacePath = options.cwd ?? process.cwd();
    const bwrapArgs = buildBwrapArgs(profile, workspacePath, {
      networkAccess,
      additionalWritePaths: config.additionalWritePaths,
      additionalReadPaths: config.additionalReadPaths,
    });

    log.debug({ profile, networkAccess, command }, 'sandboxed spawn (bwrap)');

    return spawn('bwrap', [...bwrapArgs, '--', command, ...args], {
      cwd: options.cwd,
      stdio: options.stdio,
      env: hardenedEnv,
    });
  }

  // Fallback: apply ulimit on POSIX via shell wrapper, plus env hardening
  const ulimitPrefix = caps.ulimitAvailable ? buildUlimitPrefix(config.resourceLimits) : '';
  if (ulimitPrefix) {
    const wrappedCmd = `${ulimitPrefix}exec ${shellEscape(command)} ${args.map(shellEscape).join(' ')}`.trim();
    log.debug({ profile, networkAccess, hasUlimit: true, command }, 'sandboxed spawn (fallback-shell)');
    return spawn('/bin/sh', ['-c', wrappedCmd], {
      cwd: options.cwd,
      stdio: options.stdio,
      env: hardenedEnv,
    });
  }

  // Final fallback (e.g. Windows): env hardening only
  log.debug({ profile, networkAccess, hasUlimit: false, command }, 'sandboxed spawn (fallback)');

  return spawn(command, args, {
    cwd: options.cwd,
    stdio: options.stdio,
    env: hardenedEnv,
  });
}

// ─── Helpers ──────────────────────────────────────────────────

/** Shell-escape a string for safe use in command arguments. */
function shellEscape(s: string): string {
  if (s === '') return "''";
  if (/^[a-zA-Z0-9_\-/.=:@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
