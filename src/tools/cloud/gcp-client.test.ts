import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GcpClient } from './gcp-client.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

describe('gcp-client', () => {
  it('uses a configured bearer token for JSON API requests', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer gcp-secret');
      expect(req.url).toBe('/dns/v1/projects/guardian-prod/managedZones?maxResults=5');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ managedZones: [{ name: 'primary-zone' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new GcpClient({
      id: 'gcp-main',
      name: 'GCP Main',
      projectId: 'guardian-prod',
      accessToken: 'gcp-secret',
      endpoints: {
        dns: `http://127.0.0.1:${address.port}`,
      },
    });

    const result = await client.listDnsZones({ maxResults: 5 });
    expect(result).toEqual({ managedZones: [{ name: 'primary-zone' }] });
  });

  it('exchanges service-account JWTs for access tokens', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === '/token') {
        tokenRequests += 1;
        expect(req.method).toBe('POST');
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const params = new URLSearchParams(raw);
          expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
          const assertion = params.get('assertion') ?? '';
          expect(assertion.split('.')).toHaveLength(3);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ access_token: 'exchanged-token', expires_in: 3600 }));
        });
        return;
      }

      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer exchanged-token');
      expect(req.url).toBe('/v1/projects/guardian-prod');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ projectId: 'guardian-prod', lifecycleState: 'ACTIVE' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new GcpClient({
      id: 'gcp-main',
      name: 'GCP Main',
      projectId: 'guardian-prod',
      serviceAccountJson: JSON.stringify({
        client_email: 'guardian@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        token_uri: `http://127.0.0.1:${address.port}/token`,
      }),
      endpoints: {
        oauth2Token: `http://127.0.0.1:${address.port}/token`,
        cloudResourceManager: `http://127.0.0.1:${address.port}`,
      },
    });

    const result = await client.getProject();
    expect(result).toEqual({ projectId: 'guardian-prod', lifecycleState: 'ACTIVE' });
    expect(tokenRequests).toBe(1);
  });

  it('uploads Cloud Storage object bodies as raw text', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer gcp-secret');
      expect(req.headers['content-type']).toBe('text/plain');
      expect(req.url).toBe('/upload/storage/v1/b/app-bucket/o?uploadType=media&name=notes.txt');
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        expect(raw).toBe('hello cloud');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: 'notes.txt', bucket: 'app-bucket' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new GcpClient({
      id: 'gcp-main',
      name: 'GCP Main',
      projectId: 'guardian-prod',
      accessToken: 'gcp-secret',
      endpoints: {
        storage: `http://127.0.0.1:${address.port}`,
      },
    });

    const result = await client.putStorageObjectText('app-bucket', 'notes.txt', 'hello cloud', 'text/plain');
    expect(result).toEqual({ name: 'notes.txt', bucket: 'app-bucket' });
  });
});
