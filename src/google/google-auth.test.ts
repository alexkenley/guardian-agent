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
});
