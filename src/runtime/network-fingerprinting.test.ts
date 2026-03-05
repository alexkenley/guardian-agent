import { describe, expect, it } from 'vitest';
import { inferServiceFromPort, parseBanner } from './network-fingerprinting.js';

describe('network-fingerprinting', () => {
  it('maps known ports to services', () => {
    expect(inferServiceFromPort(22)).toBe('SSH');
    expect(inferServiceFromPort(443)).toBe('HTTPS');
    expect(inferServiceFromPort(65535)).toBe('Unknown');
  });

  it('parses SSH banner versions', () => {
    const fp = parseBanner(22, 'SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6');
    expect(fp.service).toBe('SSH');
    expect(fp.version).toContain('OpenSSH_8.9p1');
  });

  it('parses HTTP server header versions', () => {
    const fp = parseBanner(80, 'HTTP/1.1 200 OK\r\nServer: Apache/2.4.52\r\n');
    expect(fp.service).toBe('HTTP');
    expect(fp.software).toBe('Apache');
    expect(fp.version).toBe('2.4.52');
  });
});
