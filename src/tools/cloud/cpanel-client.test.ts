import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { CpanelClient, unwrapUapiResponse, unwrapWhmResponse } from './cpanel-client.js';
import { normalizeCpanelConnectionConfig } from './cpanel-profile.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

describe('cpanel-client', () => {
  it('unwraps successful UAPI responses', () => {
    const result = unwrapUapiResponse({
      result: {
        status: 1,
        data: { ok: true },
        warnings: ['best effort'],
      },
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.warnings).toEqual(['best effort']);
  });

  it('throws on failed WHM responses', () => {
    expect(() => unwrapWhmResponse({
      metadata: {
        result: 0,
        reason: 'denied',
      },
    })).toThrow('denied');
  });

  it('normalizes full endpoint input into host, port, and ssl', () => {
    expect(normalizeCpanelConnectionConfig({
      host: 'https://vmres13.web-servers.com.au/',
    })).toEqual({
      host: 'vmres13.web-servers.com.au',
      port: undefined,
      ssl: true,
    });

    expect(normalizeCpanelConnectionConfig({
      host: 'vmres13.web-servers.com.au:2087/',
    })).toEqual({
      host: 'vmres13.web-servers.com.au',
      port: 2087,
      ssl: undefined,
    });
  });

  it('builds WHM requests with auth and query params', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('whm root:secret');
      expect(req.url).toBe('/json-api/version?api.version=1');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        metadata: { result: 1 },
        data: { version: '124.0.1' },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new CpanelClient({
      id: 'whm-test',
      name: 'WHM Test',
      type: 'whm',
      host: '127.0.0.1',
      port: address.port,
      username: 'root',
      apiToken: 'secret',
      ssl: false,
    });

    const result = await client.whm('version');
    expect(result.data).toEqual({ version: '124.0.1' });
  });

  it('bridges WHM calls into UAPI account actions', async () => {
    const server = createServer((req, res) => {
      expect(req.url).toContain('/json-api/cpanel?');
      expect(req.url).toContain('cpanel_jsonapi_user=alice');
      expect(req.url).toContain('cpanel_jsonapi_module=DomainInfo');
      expect(req.url).toContain('cpanel_jsonapi_func=list_domains');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        metadata: { result: 1 },
        data: {
          result: {
            status: 1,
            data: {
              addon_domains: ['example.com'],
            },
          },
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new CpanelClient({
      id: 'whm-test',
      name: 'WHM Test',
      type: 'whm',
      host: '127.0.0.1',
      port: address.port,
      username: 'root',
      apiToken: 'secret',
      ssl: false,
    });

    const result = await client.whmCpanel('alice', 'DomainInfo', 'list_domains');
    expect(result.data).toEqual({
      addon_domains: ['example.com'],
    });
  });
});
