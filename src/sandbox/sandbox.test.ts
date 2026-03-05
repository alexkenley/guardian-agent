/**
 * Tests for OS-level process sandbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildBwrapArgs,
  buildUlimitPrefix,
  buildHardenedEnv,
  PROTECTED_PATHS,
} from './profiles.js';
import type { SandboxConfig, SandboxResourceLimits } from './types.js';
import { DEFAULT_SANDBOX_CONFIG, DEFAULT_RESOURCE_LIMITS } from './types.js';

// ─── Profile Builder Tests ───────────────────────────────────

describe('buildBwrapArgs', () => {
  const workspace = '/home/user/project';

  it('returns empty array for full-access profile', () => {
    const args = buildBwrapArgs('full-access', workspace);
    expect(args).toEqual([]);
  });

  it('builds read-only profile with namespace isolation', () => {
    const args = buildBwrapArgs('read-only', workspace);
    expect(args).toContain('--ro-bind');
    expect(args).toContain('--proc');
    expect(args).toContain('--dev');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
    // Should NOT have writable workspace bind
    expect(args).not.toContain('--bind');
  });

  it('builds workspace-write profile with writable workspace', () => {
    const args = buildBwrapArgs('workspace-write', workspace);
    expect(args).toContain('--bind');
    // Should bind workspace as writable
    const bindIdx = args.indexOf('--bind');
    expect(args[bindIdx + 1]).toBe(workspace);
    expect(args[bindIdx + 2]).toBe(workspace);
  });

  it('marks protected paths as read-only in workspace-write mode', () => {
    const args = buildBwrapArgs('workspace-write', workspace);
    // Protected paths should have --ro-bind-try overrides
    const roBindTryIndices: number[] = [];
    args.forEach((arg, i) => {
      if (arg === '--ro-bind-try') roBindTryIndices.push(i);
    });
    expect(roBindTryIndices.length).toBeGreaterThanOrEqual(PROTECTED_PATHS.length);
  });

  it('isolates network by default', () => {
    const args = buildBwrapArgs('read-only', workspace);
    expect(args).toContain('--unshare-net');
  });

  it('allows network when option is set', () => {
    const args = buildBwrapArgs('read-only', workspace, { networkAccess: true });
    expect(args).not.toContain('--unshare-net');
  });

  it('adds additional write paths', () => {
    const args = buildBwrapArgs('read-only', workspace, {
      additionalWritePaths: ['/tmp/extra', '/var/data'],
    });
    // Should have --bind for each additional writable path
    let bindCount = 0;
    args.forEach((arg, i) => {
      if (arg === '--bind' && args[i + 1] === '/tmp/extra') bindCount++;
      if (arg === '--bind' && args[i + 1] === '/var/data') bindCount++;
    });
    expect(bindCount).toBe(2);
  });

  it('adds additional read-only paths', () => {
    const args = buildBwrapArgs('read-only', workspace, {
      additionalReadPaths: ['/usr/share/fonts'],
    });
    const hasReadPath = args.some((arg, i) =>
      arg === '--ro-bind-try' && args[i + 1] === '/usr/share/fonts');
    expect(hasReadPath).toBe(true);
  });

  it('skips empty additional paths', () => {
    const args = buildBwrapArgs('read-only', workspace, {
      additionalWritePaths: ['', '/valid/path'],
      additionalReadPaths: [''],
    });
    const bindPaths = args.filter((_, i) => args[i - 1] === '--bind');
    expect(bindPaths).not.toContain('');
  });
});

// ─── Ulimit Tests ────────────────────────────────────────────

describe('buildUlimitPrefix', () => {
  it('builds ulimit string with all limits set', () => {
    const prefix = buildUlimitPrefix(DEFAULT_RESOURCE_LIMITS);
    expect(prefix).toContain('ulimit -v');
    expect(prefix).toContain('ulimit -t 60');
    expect(prefix).toContain('ulimit -f 10240');
    expect(prefix).not.toContain('ulimit -u'); // maxProcesses=0 means unlimited
    expect(prefix.endsWith(' && ')).toBe(true);
  });

  it('converts memory MB to KB for ulimit -v', () => {
    const prefix = buildUlimitPrefix({ ...DEFAULT_RESOURCE_LIMITS, maxMemoryMb: 256 });
    expect(prefix).toContain('ulimit -v 262144');
  });

  it('returns empty string when all limits are zero', () => {
    const prefix = buildUlimitPrefix({
      maxMemoryMb: 0,
      maxCpuSeconds: 0,
      maxFileSizeKb: 0,
      maxProcesses: 0,
    });
    expect(prefix).toBe('');
  });

  it('handles partial limits (only some set)', () => {
    const prefix = buildUlimitPrefix({
      maxMemoryMb: 512,
      maxCpuSeconds: 0,
      maxFileSizeKb: 0,
      maxProcesses: 0,
    });
    expect(prefix).toContain('ulimit -v');
    expect(prefix).not.toContain('ulimit -t');
    expect(prefix).not.toContain('ulimit -f');
    expect(prefix).not.toContain('ulimit -u');
  });
});

// ─── Environment Hardening Tests ─────────────────────────────

describe('buildHardenedEnv', () => {
  it('strips LD_PRELOAD from environment', () => {
    const env = buildHardenedEnv({
      PATH: '/usr/bin',
      LD_PRELOAD: '/evil/lib.so',
      HOME: '/home/user',
    });
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
  });

  it('strips LD_LIBRARY_PATH from environment', () => {
    const env = buildHardenedEnv({
      LD_LIBRARY_PATH: '/evil/lib',
      PATH: '/usr/bin',
    });
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it('strips DYLD_INSERT_LIBRARIES (macOS)', () => {
    const env = buildHardenedEnv({
      DYLD_INSERT_LIBRARIES: '/evil/lib.dylib',
      PATH: '/usr/bin',
    });
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('strips NODE_OPTIONS', () => {
    const env = buildHardenedEnv({
      NODE_OPTIONS: '--require /evil/hook.js',
      PATH: '/usr/bin',
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('strips ELECTRON_RUN_AS_NODE', () => {
    const env = buildHardenedEnv({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/bin',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('preserves safe environment variables', () => {
    const env = buildHardenedEnv({
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    });
    expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('uses process.env when no base env provided', () => {
    const env = buildHardenedEnv();
    // Should have PATH from process.env
    expect(env.PATH).toBeDefined();
    // Should not have dangerous vars
    expect(env.LD_PRELOAD).toBeUndefined();
  });
});

// ─── Default Config Tests ────────────────────────────────────

describe('DEFAULT_SANDBOX_CONFIG', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_SANDBOX_CONFIG.enabled).toBe(true);
    expect(DEFAULT_SANDBOX_CONFIG.mode).toBe('workspace-write');
    expect(DEFAULT_SANDBOX_CONFIG.networkAccess).toBe(false);
    expect(DEFAULT_SANDBOX_CONFIG.additionalWritePaths).toEqual([]);
    expect(DEFAULT_SANDBOX_CONFIG.additionalReadPaths).toEqual([]);
  });

  it('has reasonable resource limits', () => {
    const limits = DEFAULT_SANDBOX_CONFIG.resourceLimits;
    expect(limits.maxMemoryMb).toBe(512);
    expect(limits.maxCpuSeconds).toBe(60);
    expect(limits.maxFileSizeKb).toBe(10_240);
    expect(limits.maxProcesses).toBe(0);
  });
});

describe('PROTECTED_PATHS', () => {
  it('includes .git and .env', () => {
    expect(PROTECTED_PATHS).toContain('.git');
    expect(PROTECTED_PATHS).toContain('.env');
  });
});

// ─── Sandbox Module Tests ────────────────────────────────────

describe('sandbox module', () => {
  let mockExecAsync: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Dynamic import to allow mocking
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detectCapabilities returns cached result on second call', async () => {
    const sandbox = await import('./index.js');
    sandbox.clearCapabilityCache();

    // First call - detect
    const caps1 = await sandbox.detectCapabilities();
    // Second call - cached
    const caps2 = await sandbox.detectCapabilities();
    expect(caps1).toBe(caps2); // Same object reference = cached

    sandbox.clearCapabilityCache();
  });

  it('clearCapabilityCache resets the cache', async () => {
    const sandbox = await import('./index.js');
    sandbox.clearCapabilityCache();

    const caps1 = await sandbox.detectCapabilities();
    sandbox.clearCapabilityCache();
    const caps2 = await sandbox.detectCapabilities();

    // After clearing, should be a new object
    expect(caps1).not.toBe(caps2);
    sandbox.clearCapabilityCache();
  });

  it('sandboxedExec bypasses sandbox when disabled', async () => {
    const sandbox = await import('./index.js');
    sandbox.clearCapabilityCache();

    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      enabled: false,
    };

    // This should run `echo hello` directly (no bwrap/ulimit)
    const result = await sandbox.sandboxedExec('echo hello', config);
    expect(result.stdout.trim()).toBe('hello');

    sandbox.clearCapabilityCache();
  });

  it('sandboxedExec applies env hardening for full-access profile', async () => {
    const sandbox = await import('./index.js');
    sandbox.clearCapabilityCache();

    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      mode: 'full-access',
    };

    // Should still run (env hardening is transparent)
    const result = await sandbox.sandboxedExec('echo hardened', config);
    expect(result.stdout.trim()).toBe('hardened');

    sandbox.clearCapabilityCache();
  });

  it('sandboxedExec runs commands with timeout', async () => {
    const sandbox = await import('./index.js');
    sandbox.clearCapabilityCache();

    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      enabled: false,
    };

    const result = await sandbox.sandboxedExec('echo fast', config, { timeout: 5000 });
    expect(result.stdout.trim()).toBe('fast');

    sandbox.clearCapabilityCache();
  });
});

// ─── resolveProfile Tests ────────────────────────────────────

describe('resolveProfile', () => {
  // Import resolveProfile
  it('uses config defaults when no overrides', async () => {
    const { resolveProfile } = await import('./profiles.js');
    const result = resolveProfile(DEFAULT_SANDBOX_CONFIG);
    expect(result.profile).toBe('workspace-write');
    expect(result.networkAccess).toBe(false);
  });

  it('applies profile override', async () => {
    const { resolveProfile } = await import('./profiles.js');
    const result = resolveProfile(DEFAULT_SANDBOX_CONFIG, { profile: 'read-only' });
    expect(result.profile).toBe('read-only');
    expect(result.networkAccess).toBe(false);
  });

  it('applies network override', async () => {
    const { resolveProfile } = await import('./profiles.js');
    const result = resolveProfile(DEFAULT_SANDBOX_CONFIG, { networkAccess: true });
    expect(result.profile).toBe('workspace-write');
    expect(result.networkAccess).toBe(true);
  });

  it('applies both overrides', async () => {
    const { resolveProfile } = await import('./profiles.js');
    const result = resolveProfile(DEFAULT_SANDBOX_CONFIG, {
      profile: 'full-access',
      networkAccess: true,
    });
    expect(result.profile).toBe('full-access');
    expect(result.networkAccess).toBe(true);
  });
});
