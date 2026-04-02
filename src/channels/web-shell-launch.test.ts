import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

async function loadModule() {
  return import('./web-shell-launch.js');
}

describe('web shell launch helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it('returns the expected shell options for Windows', async () => {
    const { getShellOptionsForPlatform } = await loadModule();

    expect(getShellOptionsForPlatform('win32').map((option) => option.id)).toEqual([
      'powershell',
      'cmd',
      'git-bash',
      'wsl-login',
      'wsl',
    ]);
  });

  it('defaults to bash on Linux-like platforms', async () => {
    const { getDefaultShellForPlatform } = await loadModule();

    expect(getDefaultShellForPlatform('linux')).toBe('bash');
  });

  it('builds a Windows WSL launch with a translated cwd', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    execFileSyncMock.mockReturnValue('C:\\Windows\\System32\\wsl.exe\n');
    const { getPtyShellLaunch } = await loadModule();

    expect(getPtyShellLaunch('wsl', 'win32', 'C:\\Users\\alex\\Repo')).toEqual({
      file: 'C:\\Windows\\System32\\wsl.exe',
      args: ['--', 'bash', '-lc', "cd '/mnt/c/Users/alex/Repo' && exec bash --noprofile --norc -i"],
      env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
      cwd: null,
    });
  });

  it('prefers Git Bash on Windows for bash terminals and seeds the env', async () => {
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    vi.stubEnv('Path', 'C:\\Windows\\System32');
    existsSyncMock.mockImplementation((candidate: string) => typeof candidate === 'string' && candidate.length > 0);
    execFileSyncMock.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe\n');
    const { getPtyShellLaunch } = await loadModule();

    const launch = getPtyShellLaunch('bash', 'win32', 'C:\\repo');

    expect(launch.file).toMatch(/C:\\Program Files[\\/]Git[\\/]bin[\\/]bash\.exe$/);
    expect(launch.args).toEqual(['--noprofile', '--norc', '-i']);
    expect(launch.cwd).toBe('C:\\repo');
    expect(launch.env.PATH.split(';')).toContain('C:\\Program Files\\Git\\cmd');
    expect(launch.env.PATH.split(';')).toContain('C:\\Windows\\System32');
    expect(launch.env.MSYSTEM).toBe('MINGW64');
    expect(launch.env.PS1).toBe('\\w$ ');
  });

  it('fails closed when WSL is requested on Windows but cannot be resolved', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('where failed');
    });
    const { getPtyShellLaunch } = await loadModule();

    expect(() => getPtyShellLaunch('wsl', 'win32', 'C:\\repo')).toThrow(
      'WSL was not found. Install Windows Subsystem for Linux or use PowerShell.',
    );
  });
});
