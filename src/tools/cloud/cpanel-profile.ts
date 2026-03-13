import { isIP } from 'node:net';

export interface CpanelConnectionInput {
  host: string;
  port?: number;
  ssl?: boolean;
}

interface NormalizedCpanelHostInput {
  host: string;
  port?: number;
  ssl?: boolean;
}

export function normalizeCpanelConnectionConfig<T extends CpanelConnectionInput>(config: T): T {
  const normalized = normalizeCpanelHostInput(config.host);
  return {
    ...config,
    host: normalized.host,
    port: config.port ?? normalized.port,
    ssl: config.ssl ?? normalized.ssl,
  };
}

export function normalizeCpanelHostInput(raw: string): NormalizedCpanelHostInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('host is required');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return normalizeUrlHost(trimmed);
  }

  const stripped = trimmed.replace(/\/+$/, '');
  if (!stripped) {
    throw new Error('host is required');
  }
  if (/[/?#]/.test(stripped)) {
    throw new Error('host must be a hostname, host:port, or http(s) URL without a path.');
  }

  const normalized = parseHostAndPort(stripped);
  assertValidHost(normalized.host);
  return normalized;
}

function normalizeUrlHost(raw: string): NormalizedCpanelHostInput {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('host must be a hostname, host:port, or http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('host URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('host URL must not include embedded credentials.');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('host URL must not include a path, query, or fragment.');
  }

  const host = normalizeHost(parsed.hostname);
  assertValidHost(host);
  return {
    host,
    port: parsed.port ? parsePort(parsed.port) : undefined,
    ssl: parsed.protocol === 'https:',
  };
}

function parseHostAndPort(raw: string): NormalizedCpanelHostInput {
  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) {
      throw new Error('host must use [ipv6]:port format when specifying a port for IPv6.');
    }
    return {
      host: normalizeHost(match[1]),
      port: match[2] ? parsePort(match[2]) : undefined,
    };
  }

  const colonCount = raw.split(':').length - 1;
  if (colonCount === 1) {
    const idx = raw.lastIndexOf(':');
    const hostPart = raw.slice(0, idx);
    const portPart = raw.slice(idx + 1);
    if (/^\d+$/.test(portPart)) {
      return {
        host: normalizeHost(hostPart),
        port: parsePort(portPart),
      };
    }
  }

  return { host: normalizeHost(raw) };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be between 1 and 65535.');
  }
  return port;
}

function assertValidHost(host: string): void {
  if (!host || host.length > 253) {
    throw new Error('host must be a valid hostname or IP address.');
  }
  if (isIP(host)) {
    return;
  }

  const labels = host.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('host must be a valid hostname or IP address.');
  }
}
