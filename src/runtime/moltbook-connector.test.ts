import { describe, it, expect } from 'vitest';
import { MoltbookConnector } from './moltbook-connector.js';

describe('MoltbookConnector', () => {
  it('returns mock findings in mock mode', async () => {
    const connector = new MoltbookConnector({
      enabled: true,
      mode: 'mock',
      searchPath: '/api/v1/posts/search',
      requestTimeoutMs: 1000,
      maxPostsPerQuery: 10,
      maxResponseBytes: 64_000,
      allowedHosts: ['moltbook.com'],
      allowActiveResponse: false,
    });

    const findings = await connector.scan(['guardian']);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].labels).toContain('hostile_site');
    expect(connector.allowsActivePublishing()).toBe(false);
  });

  it('blocks requests to non-allowlisted hosts in api mode', async () => {
    const events: string[] = [];
    const connector = new MoltbookConnector({
      enabled: true,
      mode: 'api',
      baseUrl: 'https://evil.example.com',
      searchPath: '/api/v1/posts/search',
      requestTimeoutMs: 1000,
      maxPostsPerQuery: 10,
      maxResponseBytes: 64_000,
      allowedHosts: ['moltbook.com'],
      allowActiveResponse: false,
      onSecurityEvent: (event) => events.push(event.code),
    });

    const findings = await connector.scan(['guardian']);
    expect(findings).toEqual([]);
    expect(events).toContain('host_blocked');
  });

  it('blocks insecure non-local http baseUrl', async () => {
    const events: string[] = [];
    const connector = new MoltbookConnector({
      enabled: true,
      mode: 'api',
      baseUrl: 'http://moltbook.com',
      searchPath: '/api/v1/posts/search',
      requestTimeoutMs: 1000,
      maxPostsPerQuery: 10,
      maxResponseBytes: 64_000,
      allowedHosts: ['moltbook.com'],
      allowActiveResponse: false,
      onSecurityEvent: (event) => events.push(event.code),
    });

    const findings = await connector.scan(['guardian']);
    expect(findings).toEqual([]);
    expect(events).toContain('insecure_scheme_blocked');
  });
});
