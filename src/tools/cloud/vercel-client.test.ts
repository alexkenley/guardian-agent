import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { VercelClient } from './vercel-client.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

describe('vercel-client', () => {
  it('adds bearer auth and scope query params', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer vercel-secret');
      expect(req.url).toBe('/v10/projects?limit=5&teamId=team_123');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ projects: [{ id: 'prj_1', name: 'app' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new VercelClient({
      id: 'vercel-main',
      name: 'Vercel Main',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiToken: 'vercel-secret',
      teamId: 'team_123',
    });

    const result = await client.listProjects({ limit: 5 });
    expect(result).toEqual({ projects: [{ id: 'prj_1', name: 'app' }] });
  });

  it('sends JSON payloads for mutating requests', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v10/projects?slug=team-slug');
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        expect(JSON.parse(raw)).toEqual({ name: 'app' });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'prj_1', name: 'app' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new VercelClient({
      id: 'vercel-main',
      name: 'Vercel Main',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiToken: 'vercel-secret',
      slug: 'team-slug',
    });

    const result = await client.createProject({ name: 'app' });
    expect(result).toEqual({ id: 'prj_1', name: 'app' });
  });

  it('maps Vercel API errors into useful messages', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        error: {
          code: 'forbidden',
          message: 'Access denied',
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new VercelClient({
      id: 'vercel-main',
      name: 'Vercel Main',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiToken: 'vercel-secret',
    });

    await expect(client.listProjects()).rejects.toThrow('Request failed with 403: forbidden: Access denied');
  });
});
