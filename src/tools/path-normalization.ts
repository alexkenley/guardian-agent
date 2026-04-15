import { isAbsolute, resolve } from 'node:path';

export function normalizePathForHost(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return trimmed;

  // Linux/WSL runtime: accept Windows drive-letter paths (C:\...) from UI/chat.
  if (process.platform !== 'win32') {
    const driveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
    return trimmed.replace(/\\/g, '/');
  }

  // Native Windows runtime: accept WSL /mnt/<drive>/... paths.
  const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return trimmed.replace(/\//g, '\\');
}

export function canonicalizePolicyPathValue(inputPath: string, baseRoot: string): string {
  const normalized = normalizePathForHost(inputPath);
  if (!normalized) return normalized;
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(baseRoot, normalized);
}
