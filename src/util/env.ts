import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the base directory for GuardianAgent state and config.
 * Supports isolated profiles via the GUARDIAN_PROFILE environment variable.
 */
export function getGuardianBaseDir(): string {
  const profile = process.env.GUARDIAN_PROFILE;
  if (profile && profile.trim()) {
    // Only allow alphanumeric, dash, and underscore for profile names
    const safeProfile = profile.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (safeProfile) {
      return join(homedir(), '.guardianagent', 'profiles', safeProfile);
    }
  }
  return join(homedir(), '.guardianagent');
}
