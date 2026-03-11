import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AzureClient } from './azure-client.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

describe('azure-client', () => {
  it('uses a configured bearer token for ARM requests', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer azure-secret');
      expect(req.url).toBe('/subscriptions/sub-123?api-version=2022-12-01');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ subscriptionId: 'sub-123', displayName: 'Primary' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new AzureClient({
      id: 'azure-main',
      name: 'Azure Main',
      subscriptionId: 'sub-123',
      accessToken: 'azure-secret',
      endpoints: {
        management: `http://127.0.0.1:${address.port}`,
      },
    });

    const result = await client.getSubscription();
    expect(result).toEqual({ subscriptionId: 'sub-123', displayName: 'Primary' });
  });

  it('exchanges service principal credentials for tokens', async () => {
    let tokenRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === '/oauth2/v2.0/token') {
        tokenRequests += 1;
        expect(req.method).toBe('POST');
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const params = new URLSearchParams(raw);
          expect(params.get('grant_type')).toBe('client_credentials');
          expect(params.get('client_id')).toBe('azure-client-id');
          expect(params.get('client_secret')).toBe('azure-client-secret');
          expect(params.get('scope')).toBe('https://management.azure.com/.default');
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }));
        });
        return;
      }

      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer oauth-token');
      expect(req.url).toBe('/subscriptions/sub-123/resourcegroups?api-version=2021-04-01');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: [{ name: 'rg-main' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new AzureClient({
      id: 'azure-main',
      name: 'Azure Main',
      subscriptionId: 'sub-123',
      tenantId: 'tenant-123',
      clientId: 'azure-client-id',
      clientSecret: 'azure-client-secret',
      endpoints: {
        oauth2Token: `http://127.0.0.1:${address.port}/oauth2/v2.0/token`,
        management: `http://127.0.0.1:${address.port}`,
      },
    });

    const result = await client.listResourceGroups();
    expect(result).toEqual({ value: [{ name: 'rg-main' }] });
    expect(tokenRequests).toBe(1);
  });

  it('parses blob container listings from XML', async () => {
    const server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer azure-secret');
      expect(req.url).toBe('/?comp=list');
      res.setHeader('content-type', 'application/xml');
      res.end([
        '<?xml version="1.0" encoding="utf-8"?>',
        '<EnumerationResults>',
        '<Containers>',
        '<Container><Name>container-a</Name></Container>',
        '<Container><Name>container-b</Name></Container>',
        '</Containers>',
        '</EnumerationResults>',
      ].join(''));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new AzureClient({
      id: 'azure-main',
      name: 'Azure Main',
      subscriptionId: 'sub-123',
      accessToken: 'azure-secret',
      blobBaseUrl: `http://127.0.0.1:${address.port}`,
    });

    const result = await client.listBlobContainers('storageacct');
    expect(result.containers).toEqual(['container-a', 'container-b']);
  });
});
