/**
 * OS-level process sandbox.
 *
 * Provides sandboxed exec/spawn wrappers using bubblewrap (bwrap) on Linux
 * with graceful fallback to ulimit + env hardening when bwrap is unavailable.
 */

import { exec as execCb, execFile as execFileCb, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createLogger } from '../util/logging.js';
import type { SandboxConfig, SandboxExecOptions, SandboxSpawnOptions, SandboxCapabilities, SandboxHealth } from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import { buildBwrapArgs, buildUlimitPrefix, buildHardenedEnv, resolveProfile } from './profiles.js';

export type { SandboxConfig, SandboxExecOptions, SandboxSpawnOptions, SandboxCapabilities, SandboxHealth } from './types.js';
export type { SandboxProfile, SandboxResourceLimits, SandboxAvailability, SandboxEnforcementMode } from './types.js';
export { DEFAULT_SANDBOX_CONFIG, DEFAULT_RESOURCE_LIMITS } from './types.js';
export { buildBwrapArgs, buildUlimitPrefix, buildHardenedEnv, PROTECTED_PATHS } from './profiles.js';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const log = createLogger('sandbox');
const WINDOWS_APP_PACKAGE_SIDS = ['*S-1-15-2-1', '*S-1-15-2-2'] as const;

type WindowsAppContainerAccess = 'read' | 'write';

export interface WindowsAppContainerAccessPath {
  path: string;
  access: WindowsAppContainerAccess;
}

const grantedWindowsAppContainerPaths = new Map<string, WindowsAppContainerAccess>();

// ─── Capability Detection ─────────────────────────────────────

let cachedCapabilities: SandboxCapabilities | null = null;

/**
 * Detect available sandbox capabilities (bwrap, ulimit).
 * Result is cached after first call.
 */
export async function detectCapabilities(config: SandboxConfig = DEFAULT_SANDBOX_CONFIG): Promise<SandboxCapabilities> {
  if (cachedCapabilities) {
    const needsWindowsHelperProbe = process.platform === 'win32'
      && config.windowsHelper?.enabled
      && !cachedCapabilities.windowsHelperAvailable;
    if (!needsWindowsHelperProbe) {
      return cachedCapabilities;
    }
  }

  const caps: SandboxCapabilities = {
    bwrapAvailable: false,
    ulimitAvailable: process.platform !== 'win32',
    windowsHelperAvailable: false,
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

  if (process.platform === 'win32' && config.windowsHelper?.enabled) {
    const helperCommand = resolveWindowsHelperCommand(config);
    const helperArgs = [...(config.windowsHelper.args ?? []), '--version'];
    try {
      const { stdout } = await execFileAsync(helperCommand, helperArgs, {
        timeout: config.windowsHelper.timeoutMs ?? 5_000,
      });
      const version = stdout.trim();
      caps.windowsHelperAvailable = true;
      caps.windowsHelperVersion = version;
      log.info({ version, helperCommand }, 'Windows sandbox helper available');
    } catch {
      log.info({ helperCommand }, 'Windows sandbox helper not available');
    }
  }

  cachedCapabilities = caps;
  return caps;
}

/** Clear the cached capability detection result (for testing). */
export function clearCapabilityCache(): void {
  cachedCapabilities = null;
  grantedWindowsAppContainerPaths.clear();
}

export async function detectSandboxHealth(
  config: SandboxConfig = DEFAULT_SANDBOX_CONFIG,
  capabilities?: SandboxCapabilities,
): Promise<SandboxHealth> {
  const enforcementMode = config.enforcementMode ?? 'permissive';
  if (!config.enabled) {
    return {
      enabled: false,
      platform: process.platform,
      availability: 'unavailable',
      backend: 'none',
      enforcementMode,
      reasons: ['Sandbox is disabled in configuration.'],
    };
  }

  const caps = capabilities ?? await detectCapabilities(config);
  const reasons: string[] = [];

  if (process.platform === 'linux') {
    if (caps.bwrapAvailable) {
      return {
        enabled: true,
        platform: process.platform,
        availability: 'strong',
        backend: 'bubblewrap',
        enforcementMode,
        reasons,
      };
    }
    reasons.push('bubblewrap (bwrap) is not available on this Linux host.');
    return {
      enabled: true,
      platform: process.platform,
      availability: caps.ulimitAvailable ? 'degraded' : 'unavailable',
      backend: caps.ulimitAvailable ? 'ulimit' : 'env',
      enforcementMode,
      reasons,
    };
  }

  if (process.platform === 'darwin') {
    reasons.push('No native macOS sandbox helper is configured; only process limits and env hardening are available.');
    return {
      enabled: true,
      platform: process.platform,
      availability: caps.ulimitAvailable ? 'degraded' : 'unavailable',
      backend: caps.ulimitAvailable ? 'ulimit' : 'env',
      enforcementMode,
      reasons,
    };
  }

  if (process.platform === 'win32') {
    if (config.windowsHelper?.enabled && caps.windowsHelperAvailable) {
      return {
        enabled: true,
        platform: process.platform,
        availability: 'strong',
        backend: 'windows-helper',
        enforcementMode,
        reasons,
      };
    }
    reasons.push(config.windowsHelper?.enabled
      ? 'Configured Windows sandbox helper was not detected; strict mode will disable risky subprocess-backed tools.'
      : 'No native Windows sandbox helper is enabled; strict mode will disable risky subprocess-backed tools.');
    return {
      enabled: true,
      platform: process.platform,
      availability: 'unavailable',
      backend: 'env',
      enforcementMode,
      reasons,
    };
  }

  reasons.push(`No strong sandbox backend is defined for platform '${process.platform}'.`);
  return {
    enabled: true,
    platform: process.platform,
    availability: caps.ulimitAvailable ? 'degraded' : 'unavailable',
    backend: caps.ulimitAvailable ? 'ulimit' : 'env',
    enforcementMode,
    reasons,
  };
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

  const caps = await detectCapabilities(config);
  const hardenedEnv = buildHardenedEnv(
    options.env ? { ...process.env, ...options.env } as Record<string, string> : undefined,
  );

  if (process.platform === 'win32' && config.windowsHelper?.enabled && caps.windowsHelperAvailable) {
    const helperCommand = resolveWindowsHelperCommand(config);
    await ensureWindowsAppContainerPathAccess(config, options, profile);
    const helperArgs = buildWindowsHelperExecArgs(command, config, options, profile, networkAccess);
    log.debug({ profile, networkAccess, command: helperCommand }, 'sandboxed exec (windows-helper)');
    return execFileAsync(helperCommand, helperArgs, {
      cwd: options.cwd,
      timeout: options.timeout ?? config.windowsHelper.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: hardenedEnv,
    });
  }

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
      ...(process.platform === 'win32' ? { shell: true } : {}),
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
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
  }

  const caps = await detectCapabilities(config);

  if (process.platform === 'win32' && config.windowsHelper?.enabled && caps.windowsHelperAvailable) {
    const helperCommand = resolveWindowsHelperCommand(config);
    await ensureWindowsAppContainerPathAccess(config, options, profile);
    const helperArgs = buildWindowsHelperSpawnArgs(command, args, config, options, profile, networkAccess);
    log.debug({ profile, networkAccess, command: helperCommand }, 'sandboxed spawn (windows-helper)');
    return spawn(helperCommand, helperArgs, {
      cwd: options.cwd,
      stdio: options.stdio,
      env: hardenedEnv,
    });
  }

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
    // On Windows, .cmd/.bat shims (e.g. npm global bins) require shell: true
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
}

// ─── Helpers ──────────────────────────────────────────────────

/** Shell-escape a string for safe use in command arguments. */
function shellEscape(s: string): string {
  if (s === '') return "''";
  if (/^[a-zA-Z0-9_\-/.=:@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildWindowsHelperExecArgs(
  command: string,
  config: SandboxConfig,
  options: SandboxExecOptions,
  profile: string,
  networkAccess: boolean,
): string[] {
  const args = [...(config.windowsHelper?.args ?? []), 'exec'];
  args.push('--profile', profile, '--network', networkAccess ? 'on' : 'off');
  if (options.cwd) args.push('--cwd', options.cwd);
  for (const entry of buildWindowsAppContainerAccessPlan(config, options, profile)) {
    args.push(entry.access === 'write' ? '--write-path' : '--read-path', entry.path);
  }
  args.push('--shell-command', command);
  return args;
}

export function buildWindowsHelperSpawnArgs(
  command: string,
  commandArgs: string[],
  config: SandboxConfig,
  options: SandboxSpawnOptions,
  profile: string,
  networkAccess: boolean,
): string[] {
  const args = [...(config.windowsHelper?.args ?? []), 'spawn'];
  args.push('--profile', profile, '--network', networkAccess ? 'on' : 'off');
  if (options.cwd) args.push('--cwd', options.cwd);
  for (const entry of buildWindowsAppContainerAccessPlan(config, options, profile)) {
    args.push(entry.access === 'write' ? '--write-path' : '--read-path', entry.path);
  }
  args.push('--', command, ...commandArgs);
  return args;
}

export function buildWindowsAppContainerAccessPlan(
  config: SandboxConfig,
  options: Pick<SandboxExecOptions, 'cwd'> | Pick<SandboxSpawnOptions, 'cwd'>,
  profile: string,
): WindowsAppContainerAccessPath[] {
  const accessByPath = new Map<string, WindowsAppContainerAccess>();
  const addPath = (pathValue: string | undefined, access: WindowsAppContainerAccess): void => {
    const trimmed = pathValue?.trim();
    if (!trimmed) return;
    const resolvedPath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
    const existing = accessByPath.get(resolvedPath);
    accessByPath.set(
      resolvedPath,
      existing === 'write' || access === 'write' ? 'write' : 'read',
    );
  };

  if (options.cwd) {
    addPath(options.cwd, profile === 'read-only' ? 'read' : 'write');
  }
  for (const pathValue of config.additionalReadPaths) {
    addPath(pathValue, 'read');
  }
  for (const pathValue of config.additionalWritePaths) {
    addPath(pathValue, 'write');
  }

  return [...accessByPath.entries()].map(([path, access]) => ({ path, access }));
}

async function ensureWindowsAppContainerPathAccess(
  config: SandboxConfig,
  options: Pick<SandboxExecOptions, 'cwd'> | Pick<SandboxSpawnOptions, 'cwd'>,
  profile: string,
): Promise<void> {
  const accessPlan = buildWindowsAppContainerAccessPlan(config, options, profile);
  for (const entry of accessPlan) {
    await grantWindowsAppContainerAccess(entry.path, entry.access, config.windowsHelper?.timeoutMs ?? 5_000);
  }
}

async function grantWindowsAppContainerAccess(
  pathValue: string,
  access: WindowsAppContainerAccess,
  timeoutMs: number,
): Promise<void> {
  const resolvedPath = isAbsolute(pathValue) ? pathValue : resolve(pathValue);
  const cacheKey = resolvedPath.toLowerCase();
  const existingAccess = grantedWindowsAppContainerPaths.get(cacheKey);
  if (existingAccess === 'write' || existingAccess === access) {
    return;
  }
  if (!existsSync(resolvedPath)) {
    return;
  }

  let inheritance = '';
  try {
    if (statSync(resolvedPath).isDirectory()) {
      inheritance = '(OI)(CI)';
    }
  } catch {
    // Best effort only; icacls can still grant access without inheritance flags.
  }

  const permission = `${inheritance}${access === 'write' ? 'M' : 'RX'}`;
  const args = [resolvedPath];
  for (const sid of WINDOWS_APP_PACKAGE_SIDS) {
    args.push('/grant', `${sid}:${permission}`);
  }
  args.push('/c');

  try {
    await execFileAsync('icacls.exe', args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    grantedWindowsAppContainerPaths.set(cacheKey, access);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to grant AppContainer ${access} access to '${resolvedPath}': ${message}`);
  }
}

function resolveWindowsHelperCommand(config: SandboxConfig): string {
  const configured = config.windowsHelper?.command?.trim();
  if (configured) {
    if (isAbsolute(configured)) return configured;
    const fromCwd = resolve(configured);
    if (existsSync(fromCwd)) return fromCwd;
    const fromExecDir = resolve(dirname(process.execPath), configured);
    if (existsSync(fromExecDir)) return fromExecDir;
    return configured;
  }

  const execDirCandidate = join(dirname(process.execPath), 'bin', 'guardian-sandbox-win.exe');
  if (existsSync(execDirCandidate)) return execDirCandidate;
  const cwdCandidate = resolve('bin', 'guardian-sandbox-win.exe');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return 'guardian-sandbox-win';
}
