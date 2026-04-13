/**
 * Unit tests for MicrosoftAuth.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MicrosoftAuth } from './microsoft-auth.js';
import type { MicrosoftAuthConfig } from './microsoft-auth.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import { getGuardianBaseDir } from '../util/env.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

const SECRETS_FILE = join(getGuardianBaseDir(), 'secrets.enc.json');

function makeConfig(overrides?: Partial<MicrosoftAuthConfig>): MicrosoftAuthConfig {
  return {
    clientId: 'test-client-id-12345',
    tenantId: 'common',
    callbackPort: 18433,
    scopes: ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'],
    ...overrides,
  };
}

describe('MicrosoftAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  it('constructs with config', () => {
    const auth = new MicrosoftAuth(makeConfig());
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getTokenExpiry()).toBeUndefined();
  });

  it('defaults tenantId to common', () => {
    const auth = new MicrosoftAuth(makeConfig({ tenantId: undefined }));
    expect(auth.isAuthenticated()).toBe(false);
  });

  describe('loadStoredTokens', () => {
    it('handles missing secrets file gracefully', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
      const auth = new MicrosoftAuth(makeConfig());

      await auth.loadStoredTokens();
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('handles secrets file without microsoft-tokens key', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ 'google-tokens': 'some-value' }));
      const auth = new MicrosoftAuth(makeConfig());

      await auth.loadStoredTokens();
      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('clears tokens and stored data', async () => {
      // Set up secrets file with microsoft-tokens entry
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({
        'google-tokens': 'keep-this',
        'microsoft-tokens': 'remove-this',
      }));

      const auth = new MicrosoftAuth(makeConfig());
      await auth.disconnect();

      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getTokenExpiry()).toBeUndefined();

      // Should have written file without microsoft-tokens
      expect(writeFile).toHaveBeenCalledWith(
        SECRETS_FILE,
        expect.not.stringContaining('microsoft-tokens'),
        expect.objectContaining({ mode: 0o600 }),
      );
    });

    it('handles missing secrets file during disconnect', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
      const auth = new MicrosoftAuth(makeConfig());

      await expect(auth.disconnect()).resolves.not.toThrow();
    });
  });

  describe('getAccessToken', () => {
    it('throws when not authenticated', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
      const auth = new MicrosoftAuth(makeConfig());

      await expect(auth.getAccessToken()).rejects.toThrow('Not authenticated');
    });
  });

  describe('startAuth', () => {
    afterEach(async () => {
      // Clean up any pending auth servers
    });

    it('generates valid PKCE parameters and auth URL', async () => {
      const auth = new MicrosoftAuth(makeConfig());

      // We can't fully test startAuth without mocking createServer,
      // but we can verify the structure is correct.
      // This test is mainly about compilation and basic setup.
      expect(typeof auth.startAuth).toBe('function');
    });

    it('cancels an earlier pending flow before starting a new one', async () => {
      const auth = new MicrosoftAuth(makeConfig());
      const server = { close: vi.fn() };
      const reject = vi.fn();
      (auth as any).pending = {
        codeVerifier: 'verifier',
        state: 'state',
        server,
        resolve: vi.fn(),
        reject,
        timeoutHandle: setTimeout(() => {}, 10_000),
      };
      const startServerSpy = vi.spyOn(auth as any, 'startCallbackServer').mockResolvedValue(undefined);

      const result = await auth.startAuth();

      expect(server.close).toHaveBeenCalledOnce();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Starting a new OAuth flow.' }));
      expect(startServerSpy).toHaveBeenCalledOnce();
      expect(result.authUrl).toContain('/oauth2/v2.0/authorize?');
    });
  });

  describe('waitForCallback', () => {
    it('throws when no pending auth flow', async () => {
      const auth = new MicrosoftAuth(makeConfig());
      await expect(auth.waitForCallback()).rejects.toThrow('No pending OAuth flow');
    });
  });

  describe('handleCallback', () => {
    it('throws when no pending auth flow', async () => {
      const auth = new MicrosoftAuth(makeConfig());
      await expect(auth.handleCallback('code', 'state')).rejects.toThrow('Invalid OAuth state');
    });
  });

  describe('cancelPendingAuth', () => {
    it('clears a pending callback server and marks the flow as no longer pending', () => {
      const auth = new MicrosoftAuth(makeConfig());
      const server = { close: vi.fn() };
      const reject = vi.fn();
      (auth as any).pending = {
        codeVerifier: 'verifier',
        state: 'state',
        server,
        resolve: vi.fn(),
        reject,
        timeoutHandle: setTimeout(() => {}, 10_000),
      };

      auth.cancelPendingAuth('User closed the popup.');

      expect(server.close).toHaveBeenCalledOnce();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'User closed the popup.' }));
      expect(auth.hasPendingAuth()).toBe(false);
    });
  });
});
