import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GoogleAuth', () => {
  it('exports GoogleAuth class', async () => {
    const mod = await import('./google-auth.js');
    expect(mod.GoogleAuth).toBeDefined();
    expect(typeof mod.GoogleAuth).toBe('function');
  });

  it('constructs with config', async () => {
    const { GoogleAuth } = await import('./google-auth.js');
    const auth = new GoogleAuth({
      credentialsPath: '/tmp/test-credentials.json',
      callbackPort: 19999,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getTokenExpiry()).toBeUndefined();
  });

  it('getAccessToken throws when no tokens are loaded', async () => {
    const { GoogleAuth } = await import('./google-auth.js');
    const auth = new GoogleAuth({
      credentialsPath: '/tmp/nonexistent.json',
      callbackPort: 19999,
      scopes: [],
    });
    // isAuthenticated is false before any tokens are loaded.
    expect(auth.isAuthenticated()).toBe(false);
    // Stub loadStoredTokens to simulate no stored tokens (avoids reading real secrets file).
    vi.spyOn(auth, 'loadStoredTokens').mockResolvedValue();
    await expect(auth.getAccessToken()).rejects.toThrow(/Not authenticated/);
  });

  it('cancels a pending OAuth flow and clears the callback server state', async () => {
    const { GoogleAuth } = await import('./google-auth.js');
    const auth = new GoogleAuth({
      credentialsPath: '/tmp/test-credentials.json',
      callbackPort: 19999,
      scopes: [],
    });
    const server = { close: vi.fn() };
    const reject = vi.fn();
    const timeoutHandle = setTimeout(() => {}, 10_000);
    (auth as any).pending = {
      codeVerifier: 'verifier',
      state: 'state',
      server,
      resolve: vi.fn(),
      reject,
      timeoutHandle,
    };

    auth.cancelPendingAuth('User closed the popup.');

    expect(server.close).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'User closed the popup.' }));
    expect(auth.hasPendingAuth()).toBe(false);
  });

  it('cancels an earlier pending flow before starting a new one', async () => {
    const { GoogleAuth } = await import('./google-auth.js');
    const auth = new GoogleAuth({
      credentialsPath: '/tmp/test-credentials.json',
      callbackPort: 19999,
      scopes: ['scope-a'],
    });
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
    vi.spyOn(auth as any, 'loadClientCredentials').mockResolvedValue({
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
    const startServerSpy = vi.spyOn(auth as any, 'startCallbackServer').mockResolvedValue(undefined);

    const result = await auth.startAuth();

    expect(server.close).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Starting a new OAuth flow.' }));
    expect(startServerSpy).toHaveBeenCalledOnce();
    expect(result.authUrl).toContain('accounts.google.com');
  });
});
