/**
 * Banner parsing/fingerprinting helpers.
 */

import type { ServiceInfo } from './network-intelligence.js';

export interface BannerFingerprint {
  port: number;
  service: string;
  banner: string;
  version?: string;
  software?: string;
  os?: string;
}

export function inferServiceFromPort(port: number): string {
  switch (port) {
    case 21: return 'FTP';
    case 22: return 'SSH';
    case 25: return 'SMTP';
    case 53: return 'DNS';
    case 80: return 'HTTP';
    case 110: return 'POP3';
    case 143: return 'IMAP';
    case 443: return 'HTTPS';
    case 445: return 'SMB';
    case 554: return 'RTSP';
    case 631: return 'IPP';
    case 3306: return 'MySQL';
    case 5432: return 'PostgreSQL';
    case 8080: return 'HTTP-Alt';
    case 8443: return 'HTTPS-Alt';
    default: return 'Unknown';
  }
}

export function parseBanner(port: number, banner: string): BannerFingerprint {
  const clean = banner.replace(/\0/g, '').trim();
  const service = inferServiceFromPort(port);
  const out: BannerFingerprint = { port, service, banner: clean };

  const sshMatch = clean.match(/SSH-\d+\.\d+-([^\s]+)/i);
  if (sshMatch) {
    out.service = 'SSH';
    out.version = sshMatch[1];
    out.software = 'OpenSSH';
    const osMatch = clean.match(/(Ubuntu|Debian|CentOS|Alpine|FreeBSD|OpenBSD)[^\s]*/i);
    if (osMatch) out.os = osMatch[1];
    return out;
  }

  const serverHeaderMatch = clean.match(/Server:\s*([A-Za-z0-9._-]+)\/([0-9][^ \r\n]*)/i);
  if (serverHeaderMatch) {
    out.service = port === 443 || port === 8443 ? 'HTTPS' : 'HTTP';
    out.software = serverHeaderMatch[1];
    out.version = serverHeaderMatch[2];
    return out;
  }

  const tokenVersionMatch = clean.match(/([A-Za-z][A-Za-z0-9._-]+)\/([0-9][^ \r\n]*)/);
  if (tokenVersionMatch) {
    out.software = tokenVersionMatch[1];
    out.version = tokenVersionMatch[2];
    return out;
  }

  const postgresMatch = clean.match(/PostgreSQL\s+([0-9][^ \r\n]*)/i);
  if (postgresMatch) {
    out.service = 'PostgreSQL';
    out.version = postgresMatch[1];
    return out;
  }

  return out;
}

export function mergeFingerprintsIntoServices(
  services: ServiceInfo[],
  fingerprints: BannerFingerprint[],
): ServiceInfo[] {
  const byPort = new Map<number, BannerFingerprint>(fingerprints.map((fp) => [fp.port, fp]));
  return services.map((service) => {
    const fp = byPort.get(service.port);
    if (!fp) return service;
    return {
      ...service,
      service: fp.service || service.service,
      version: fp.version ?? service.version,
    };
  });
}
