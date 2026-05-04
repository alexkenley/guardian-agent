import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubOAuthService } from './github-oauth-service.js';

describe('GitHubOAuthService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a clear setup state when OAuth credentials are missing', async () => {
    const service = new GitHubOAuthService({
      enabled: true,
      mode: 'oauth',
      defaultOwner: 'example-org',
      defaultRepo: 'example-repo',
    });

    const status = await service.status();

    expect(status.authenticated).toBe(false);
    expect(status.repositoryAccessible).toBe(false);
    expect(status.message).toContain('connect GitHub');
  });

  it('does not invent a default repository when none is configured', async () => {
    const service = new GitHubOAuthService({
      enabled: true,
      mode: 'oauth',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
    });

    const status = await service.status();

    expect(status.authenticated).toBe(false);
    expect(status.repositoryAccessible).toBe(false);
    expect(status.defaultRepository).toBeUndefined();
    expect(status.repositoryConfigured).toBe(false);
    expect(status.message).toContain('connect your GitHub account');
  });

  it('allows an authenticated account without a configured repository target', async () => {
    const service = new GitHubOAuthService({
      enabled: true,
      mode: 'oauth',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
    });
    (service as unknown as { tokens: { access_token: string; obtained_at: number } }).tokens = {
      access_token: 'token',
      obtained_at: Date.now(),
    };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await service.status();

    expect(status.authenticated).toBe(true);
    expect(status.repositoryAccessible).toBe(false);
    expect(status.repositoryConfigured).toBe(false);
    expect(status.defaultRepository).toBeUndefined();
    expect(status.message).toContain('GitHub is connected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
  });

  it('starts a browser OAuth flow with a localhost callback', async () => {
    const service = new GitHubOAuthService({
      enabled: true,
      mode: 'oauth',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      defaultOwner: 'example-org',
      defaultRepo: 'example-repo',
      oauthCallbackPort: 19134,
      scopes: ['repo', 'read:user'],
    });

    const result = await service.startAuth();

    try {
      expect(result.success).toBe(true);
      expect(result.authUrl).toContain('https://github.com/login/oauth/authorize?');
      expect(result.authUrl).toContain('client_id=github-client-id');
      expect(result.authUrl).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A19134%2Fcallback');
      expect(result.authUrl).toContain('scope=repo+read%3Auser');
      expect(result.state).toHaveLength(32);
      expect(service.hasPendingAuth()).toBe(true);
    } finally {
      service.cancelPendingAuth('test cleanup');
    }
  });
});
