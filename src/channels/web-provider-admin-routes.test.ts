import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handleWebProviderAdminRoutes } from './web-provider-admin-routes.js';
import type { DashboardCallbacks } from './web-types.js';

function makeRequest(method: string, body = ''): any {
  const req = Readable.from(body ? [body] : []);
  return Object.assign(req, { method });
}

function makeResponse(): any {
  const response: {
    statusCode?: number;
    body?: string;
    headersSent: boolean;
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  } = {
    headersSent: false,
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return response;
}

async function runProviderRoute(pathname: string, method: string, dashboard: Partial<DashboardCallbacks>) {
  const req = makeRequest(method);
  const res = makeResponse();
  const handled = await handleWebProviderAdminRoutes({
    req,
    res,
    url: new URL(`http://localhost${pathname}`),
    maxBodyBytes: 1024,
    dashboard: dashboard as DashboardCallbacks,
    requirePrivilegedTicket: () => true,
    maybeEmitUIInvalidation: () => undefined,
  });
  return {
    handled,
    statusCode: res.statusCode,
    body: JSON.parse(res.body ?? '{}') as Record<string, unknown>,
  };
}

describe('handleWebProviderAdminRoutes Google auth compatibility', () => {
  it('maps legacy gws status to native Google OAuth status when available', async () => {
    const result = await runProviderRoute('/api/gws/status', 'GET', {
      onGoogleStatus: async () => ({
        authenticated: true,
        authPending: false,
        tokenExpiry: 123,
        tokenExpired: false,
        services: ['gmail', 'calendar'],
        mode: 'native',
      }),
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      installed: true,
      authenticated: true,
      authMethod: 'native_oauth',
      services: ['gmail', 'calendar'],
      mode: 'native',
      legacyEndpoint: true,
    });
  });

  it('rejects legacy gws CLI reauth and points callers at native Google OAuth', async () => {
    const result = await runProviderRoute('/api/gws/reauth', 'POST', {});

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(410);
    expect(result.body.success).toBe(false);
    expect(String(result.body.message)).toContain('native Google OAuth');
    expect(String(result.body.nextAction)).toContain('Connect Google');
  });
});
