import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as win32Path } from 'node:path';

export interface ShellOptionDescriptor {
  id: string;
  label: string;
  detail: string;
}

export interface PtyShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
}

export function getShellOptionsForPlatform(platform: NodeJS.Platform): ShellOptionDescriptor[] {
  switch (platform) {
    case 'win32':
      return [
        { id: 'powershell', label: 'PowerShell (Windows)', detail: 'powershell.exe' },
        { id: 'cmd', label: 'Command Prompt (cmd.exe)', detail: 'cmd.exe' },
        { id: 'git-bash', label: 'Git Bash', detail: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        { id: 'wsl-login', label: 'WSL Ubuntu', detail: 'wsl.exe (default shell/profile)' },
        { id: 'wsl', label: 'WSL Bash (Clean)', detail: 'wsl.exe -- bash --noprofile --norc' },
      ];
    case 'darwin':
      return [
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
    default:
      return [
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
  }
}

export function getDefaultShellForPlatform(platform: NodeJS.Platform): string {
  return getShellOptionsForPlatform(platform)[0]?.id || 'bash';
}

function tryResolveWindowsExecutable(command: string, fallbackPaths: string[] = []): string | null {
  for (const candidate of fallbackPaths) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  try {
    const output = execFileSync('where', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  } catch {
    // Fall back to known paths or the raw command name.
  }

  return null;
}

function resolveWindowsExecutable(command: string, fallbackPaths: string[] = []): string {
  return tryResolveWindowsExecutable(command, fallbackPaths) || fallbackPaths[0] || command;
}

function listWindowsExecutableCandidates(command: string): string[] {
  try {
    const output = execFileSync('where', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inferWindowsGitRoot(executablePath: string): string {
  const normalized = executablePath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    return win32Path.dirname(win32Path.dirname(win32Path.dirname(normalized)));
  }
  if (lower.endsWith('\\bin\\bash.exe')) {
    return win32Path.dirname(win32Path.dirname(normalized));
  }
  if (lower.endsWith('\\git-bash.exe')) {
    return win32Path.dirname(normalized);
  }
  return win32Path.dirname(win32Path.dirname(normalized));
}

function buildWindowsGitBashEnv(executablePath: string): Record<string, string> {
  const gitRoot = inferWindowsGitRoot(executablePath);
  const existingPath = process.env.Path || process.env.PATH || '';
  const pathEntries = [
    win32Path.join(gitRoot, 'cmd'),
    win32Path.join(gitRoot, 'usr', 'bin'),
    win32Path.join(gitRoot, 'bin'),
    win32Path.join(gitRoot, 'mingw64', 'bin'),
  ].filter((entry) => entry && existsSync(entry));
  const mergedPath = Array.from(new Set([
    ...pathEntries,
    ...existingPath.split(';').map((entry) => entry.trim()).filter(Boolean),
  ])).join(';');
  return {
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    PS1: '\\w$ ',
    MSYSTEM: 'MINGW64',
    CHERE_INVOKING: '1',
    PATH: mergedPath,
    Path: mergedPath,
  };
}

function toWslPath(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '/';
  if (normalized.startsWith('/')) {
    return normalized.replace(/\\/g, '/');
  }
  const driveMatch = normalized.replace(/\//g, '\\').match(/^([A-Za-z]):\\(.*)$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
  }
  return normalized.replace(/\\/g, '/');
}

function shellQuotePosix(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function resolveWindowsGitBashExecutable(): string {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const preferred = [
    win32Path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    win32Path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    win32Path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    win32Path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
  ];
  const gitBash = preferred.find((candidate) => candidate && existsSync(candidate))
    || listWindowsExecutableCandidates('bash.exe')
      .find((candidate) => candidate.toLowerCase().includes('\\git\\') && candidate.toLowerCase().endsWith('bash.exe'));
  if (gitBash) return gitBash;
  throw new Error('Git Bash was not found. Install Git for Windows or use PowerShell/WSL.');
}

export function getPtyShellLaunch(shellType: string, platform: NodeJS.Platform, requestedCwd?: string): PtyShellLaunch {
  switch (shellType) {
    case 'powershell':
      return {
        file: platform === 'win32' ? resolveWindowsExecutable('powershell.exe', ['powershell.exe']) : 'pwsh',
        args: ['-NoLogo', '-NoProfile'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: requestedCwd,
      };
    case 'cmd':
      return {
        file: platform === 'win32' ? resolveWindowsExecutable('cmd.exe', ['cmd.exe']) : 'cmd.exe',
        args: [],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: requestedCwd,
      };
    case 'wsl-login':
    case 'wsl': {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const wslExe = platform === 'win32'
        ? tryResolveWindowsExecutable('wsl.exe', [win32Path.join(systemRoot, 'System32', 'wsl.exe')])
        : 'wsl';
      if (platform === 'win32' && !wslExe) {
        throw new Error('WSL was not found. Install Windows Subsystem for Linux or use PowerShell.');
      }
      if (shellType === 'wsl-login') {
        return {
          file: wslExe || 'wsl',
          args: platform === 'win32'
            ? (requestedCwd ? ['--cd', toWslPath(requestedCwd)] : [])
            : [],
          env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
          cwd: platform === 'win32' ? null : requestedCwd,
        };
      }
      const wslBootstrap = requestedCwd
        ? `cd ${shellQuotePosix(toWslPath(requestedCwd))} && exec bash --noprofile --norc -i`
        : 'exec bash --noprofile --norc -i';
      return {
        file: wslExe || 'wsl',
        args: platform === 'win32' ? ['--', 'bash', '-lc', wslBootstrap] : [],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: platform === 'win32' ? null : requestedCwd,
      };
    }
    case 'git-bash': {
      const gitBash = platform === 'win32' ? resolveWindowsGitBashExecutable() : 'bash';
      return {
        file: gitBash,
        args: ['--noprofile', '--norc', '-i'],
        env: platform === 'win32'
          ? buildWindowsGitBashEnv(gitBash)
          : { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '\\w$ ' },
        cwd: requestedCwd,
      };
    }
    case 'zsh':
      return {
        file: 'zsh',
        args: ['-f', '-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '%~ %# ' },
        cwd: requestedCwd,
      };
    case 'sh':
      return {
        file: 'sh',
        args: ['-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '$ ' },
        cwd: requestedCwd,
      };
    case 'bash':
    default:
      if (platform === 'win32') {
        const gitBash = resolveWindowsGitBashExecutable();
        return {
          file: gitBash,
          args: ['--noprofile', '--norc', '-i'],
          env: buildWindowsGitBashEnv(gitBash),
          cwd: requestedCwd,
        };
      }
      return {
        file: 'bash',
        args: ['--noprofile', '--norc', '-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '\\w$ ' },
        cwd: requestedCwd,
      };
  }
}
