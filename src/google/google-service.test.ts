import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleService } from './google-service.js';
import type { GoogleAuth } from './google-auth.js';

function mockAuth(overrides?: Partial<GoogleAuth>): GoogleAuth {
  return {
    isAuthenticated: () => true,
    getAccessToken: async () => 'mock-access-token',
    getTokenExpiry: () => Date.now() + 3600_000,
    startAuth: async () => ({ authUrl: 'https://accounts.google.com/...', state: 'test' }),
    waitForCallback: async () => {},
    handleCallback: async () => {},
    disconnect: async () => {},
    loadStoredTokens: async () => {},
    ...overrides,
  } as GoogleAuth;
}

describe('GoogleService', () => {
  it('constructs with default services', () => {
    const svc = new GoogleService(mockAuth());
    expect(svc.isServiceEnabled('gmail')).toBe(true);
    expect(svc.isServiceEnabled('calendar')).toBe(true);
    expect(svc.isServiceEnabled('drive')).toBe(true);
    expect(svc.getEnabledServices()).toContain('gmail');
  });

  it('constructs with custom services', () => {
    const svc = new GoogleService(mockAuth(), { services: ['gmail', 'sheets'] });
    expect(svc.isServiceEnabled('gmail')).toBe(true);
    expect(svc.isServiceEnabled('sheets')).toBe(true);
    expect(svc.isServiceEnabled('drive')).toBe(false);
  });

  it('rejects disabled service', async () => {
    const svc = new GoogleService(mockAuth(), { services: ['gmail'] });
    const result = await svc.execute({
      service: 'drive',
      resource: 'files',
      method: 'list',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not enabled');
  });

  it('rejects unsupported service', async () => {
    const svc = new GoogleService(mockAuth(), { services: ['unknown'] });
    const result = await svc.execute({
      service: 'unknown',
      resource: 'things',
      method: 'list',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported service');
  });

  it('isAuthenticated delegates to auth', () => {
    const svc = new GoogleService(mockAuth({ isAuthenticated: () => false }));
    expect(svc.isAuthenticated()).toBe(false);
  });

  it('schema returns discovery API data on success', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrl = url;
      return Promise.resolve({
      ok: true,
      json: async () => ({ kind: 'discovery#restDescription', name: 'gmail' }),
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      const result = await svc.schema('gmail');
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).name).toBe('gmail');
      expect(requestedUrl).toBe('https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('schema returns error for unknown service', async () => {
    const svc = new GoogleService(mockAuth());
    const result = await svc.schema('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown service');
  });

  it('schema returns error for empty path', async () => {
    const svc = new GoogleService(mockAuth());
    const result = await svc.schema('');
    expect(result.success).toBe(false);
    expect(result.error).toContain('schemaPath must start');
  });

  it('builds correct Gmail list URL with userId path param', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"messages":[]}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: { userId: 'me', maxResults: 10 },
      });

      // userId should be interpolated: /gmail/v1/users/me/messages
      expect(capturedUrl).toContain('/gmail/v1/users/me/messages');
      expect(capturedUrl).toContain('maxResults=10');
      expect(capturedUrl).not.toContain('userId=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds correct Calendar events URL with implicit calendars parent', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"items":[]}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      // LLM sends resource="events" (not "calendars events") with calendarId in params.
      await svc.execute({
        service: 'calendar',
        resource: 'events',
        method: 'list',
        params: { calendarId: 'primary' },
      });

      // calendarId should be interpolated with implicit parent: /v3/calendars/primary/events
      expect(capturedUrl).toContain('/calendar/v3/calendars/primary/events');
      expect(capturedUrl).not.toContain('calendarId=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds correct Drive files URL without path params', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"files":[]}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'drive',
        resource: 'files',
        method: 'list',
        params: { q: 'name contains "report"' },
      });

      expect(capturedUrl).toContain('/drive/v3/files');
      expect(capturedUrl).toContain('q=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds correct Gmail get URL with userId and messageId', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"id":"msg123"}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'gmail',
        resource: 'users messages',
        method: 'get',
        params: { userId: 'me', messageId: 'msg123', format: 'full' },
      });

      // /gmail/v1/users/me/messages/msg123?format=full
      expect(capturedUrl).toContain('/gmail/v1/users/me/messages/msg123');
      expect(capturedUrl).toContain('format=full');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts generic id as an alias for Gmail messageId path params', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"id":"msg123"}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'gmail',
        resource: 'users messages',
        method: 'get',
        params: { userId: 'me', id: 'msg123', format: 'metadata' },
      });

      expect(capturedUrl).toContain('/gmail/v1/users/me/messages/msg123');
      expect(capturedUrl).toContain('format=metadata');
      expect(capturedUrl).not.toContain('id=msg123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('repeats Gmail metadataHeaders query params instead of collapsing them into one value', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"id":"msg123","payload":{"headers":[]}}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'gmail',
        resource: 'users messages',
        method: 'get',
        params: {
          userId: 'me',
          messageId: 'msg123',
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        },
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds correct custom method URL for Gmail send', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"id":"msg123"}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'gmail',
        resource: 'users messages',
        method: 'send',
        params: { userId: 'me' },
        json: { raw: 'abc' },
      });

      // /gmail/v1/users/me/messages/send
      expect(capturedUrl).toContain('/gmail/v1/users/me/messages/send');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds correct custom method URL for Drive copy', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        text: async () => '{"id":"file-copy"}',
      });
    }) as unknown as typeof fetch;

    try {
      const svc = new GoogleService(mockAuth());
      await svc.execute({
        service: 'drive',
        resource: 'files',
        method: 'copy',
        params: { fileId: 'file123' },
      });

      // /drive/v3/files/file123/copy
      expect(capturedUrl).toContain('/drive/v3/files/file123/copy');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
