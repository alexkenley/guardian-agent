/**
 * Centralized SSRF protection — blocks requests to private/internal addresses.
 *
 * Replaces fragmented isPrivateHost() copies that were previously in executor.ts.
 * Covers:
 *   - RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x)
 *   - Loopback (127.x, ::1, localhost)
 *   - Link-local (169.254.x, fe80::)
 *   - Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 *   - Unique local IPv6 (fc00::/7)
 *   - IPv4-mapped IPv6 (::ffff:private)
 *   - Decimal/hex/octal IP obfuscation
 *   - Optional DNS pre-resolution
 */

import * as dns from 'node:dns/promises';
import type { AdmissionController, AdmissionResult, AgentAction, AdmissionPhase } from './guardian.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('ssrf');

// ─── Configuration ────────────────────────────────────────────

export interface SsrfConfig {
  /** Enable SSRF protection. Default: true. */
  enabled: boolean;
  /** Allow private/internal network addresses. Default: false. */
  allowPrivateNetworks?: boolean;
  /** Block cloud metadata endpoints (169.254.169.254, etc). Default: true. */
  blockCloudMetadata?: boolean;
  /** Hostnames/IPs always allowed regardless of SSRF checks. */
  allowlist?: string[];
  /** Pre-resolve DNS before checking IP. Default: false. */
  resolveBeforeFetch?: boolean;
}

export const DEFAULT_SSRF_CONFIG: SsrfConfig = {
  enabled: true,
  allowPrivateNetworks: false,
  blockCloudMetadata: true,
  allowlist: [],
  resolveBeforeFetch: false,
};

export interface SsrfCheckResult {
  safe: boolean;
  reason?: 'private_ip' | 'loopback' | 'cloud_metadata' | 'link_local' | 'ipv4_mapped' | 'obfuscated_ip';
  resolvedIp?: string;
}

// ─── Cloud Metadata Endpoints ─────────────────────────────────

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',         // AWS, GCP, Azure, etc.
  'metadata.google.internal', // GCP alias
  'metadata.goog',           // GCP short alias
  'fd00:ec2::254',           // AWS IPv6
]);

// ─── IP Range Checks ──────────────────────────────────────────

/** Parse a potentially obfuscated IP to a numeric value (IPv4). Returns null if not an IP. */
function parseIpToNumber(host: string): number | null {
  // Standard dotted decimal: 127.0.0.1
  const dotted = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    return (a << 24) | (b << 16) | (c << 8) | d;
  }

  // Single decimal number: 2130706433 = 127.0.0.1
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xFFFFFFFF) return n;
  }

  // Hex: 0x7f000001 = 127.0.0.1
  if (/^0x[0-9a-fA-F]+$/.test(host)) {
    const n = parseInt(host, 16);
    if (n >= 0 && n <= 0xFFFFFFFF) return n;
  }

  // Octal: 0177.0.0.1
  if (/^0\d+$/.test(host)) {
    const n = parseInt(host, 8);
    if (n >= 0 && n <= 0xFFFFFFFF) return n;
  }

  return null;
}

/** Check if an IPv4 numeric value falls in a private range. */
function isPrivateIpNumber(ip: number): { private: boolean; reason?: SsrfCheckResult['reason'] } {
  // 127.0.0.0/8 — Loopback
  if ((ip >>> 24) === 127) return { private: true, reason: 'loopback' };
  // 10.0.0.0/8
  if ((ip >>> 24) === 10) return { private: true, reason: 'private_ip' };
  // 172.16.0.0/12
  if ((ip >>> 20) === (172 << 4 | 1)) return { private: true, reason: 'private_ip' };
  // 192.168.0.0/16
  if ((ip >>> 16) === (192 << 8 | 168)) return { private: true, reason: 'private_ip' };
  // 169.254.0.0/16 — Link-local
  if ((ip >>> 16) === (169 << 8 | 254)) return { private: true, reason: 'link_local' };
  // 0.0.0.0/8 — Current network
  if ((ip >>> 24) === 0) return { private: true, reason: 'private_ip' };
  return { private: false };
}

/** Extract IPv4 from IPv4-mapped IPv6 address (::ffff:x.x.x.x or ::ffff:hex). */
function extractMappedIpv4(host: string): string | null {
  const lower = host.toLowerCase();
  // ::ffff:10.0.0.1 or [::ffff:10.0.0.1]
  const match = lower.match(/^(?:\[)?::ffff:(\d+\.\d+\.\d+\.\d+)(?:\])?$/);
  if (match) return match[1];
  // ::ffff:0a00:0001 (hex form)
  const hexMatch = lower.match(/^(?:\[)?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?:\])?$/);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Comprehensive check if a hostname/IP is a private/internal address.
 * Replaces the duplicate isPrivateHost() functions.
 */
export function isPrivateAddress(hostname: string): boolean {
  const result = checkPrivateAddress(hostname);
  return result.private;
}

/** Detailed private address check with reason. */
export function checkPrivateAddress(hostname: string): { private: boolean; reason?: SsrfCheckResult['reason'] } {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip [] from IPv6

  // Loopback
  if (h === 'localhost' || h === '::1') return { private: true, reason: 'loopback' };
  if (h.endsWith('.localhost')) return { private: true, reason: 'loopback' };

  // Cloud metadata
  if (CLOUD_METADATA_HOSTS.has(h)) return { private: true, reason: 'cloud_metadata' };

  // IPv4-mapped IPv6
  const mappedIpv4 = extractMappedIpv4(h);
  if (mappedIpv4) {
    const ipNum = parseIpToNumber(mappedIpv4);
    if (ipNum !== null) {
      const check = isPrivateIpNumber(ipNum);
      if (check.private) return { private: true, reason: 'ipv4_mapped' };
    }
  }

  // IPv6 private ranges
  if (h.startsWith('fc') || h.startsWith('fd')) return { private: true, reason: 'private_ip' };
  if (h.startsWith('fe80')) return { private: true, reason: 'link_local' };

  // Standard IPv4 regex checks (fast path for common cases)
  if (/^127\./.test(h)) return { private: true, reason: 'loopback' };
  if (/^10\./.test(h)) return { private: true, reason: 'private_ip' };
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return { private: true, reason: 'private_ip' };
  if (/^192\.168\./.test(h)) return { private: true, reason: 'private_ip' };
  if (/^169\.254\./.test(h)) return { private: true, reason: 'link_local' };
  if (/^0\./.test(h)) return { private: true, reason: 'private_ip' };

  // Obfuscated IP (decimal, hex, octal)
  const ipNum = parseIpToNumber(h);
  if (ipNum !== null) {
    const check = isPrivateIpNumber(ipNum);
    if (check.private) return { private: true, reason: 'obfuscated_ip' };
  }

  return { private: false };
}

/**
 * Full URL validation for SSRF, including cloud metadata, obfuscation,
 * and optional DNS pre-resolution.
 */
export async function validateUrlForSsrf(
  url: string | URL,
  config: SsrfConfig = DEFAULT_SSRF_CONFIG,
): Promise<SsrfCheckResult> {
  if (!config.enabled) return { safe: true };

  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return { safe: false, reason: 'private_ip' }; // invalid URL treated as unsafe
  }

  const hostname = parsed.hostname;

  // Allowlist check
  if (config.allowlist?.includes(hostname)) return { safe: true };

  // Cloud metadata check
  if (config.blockCloudMetadata !== false && CLOUD_METADATA_HOSTS.has(hostname.toLowerCase())) {
    return { safe: false, reason: 'cloud_metadata' };
  }

  // Skip private IP checks if allowed
  if (config.allowPrivateNetworks) return { safe: true };

  // Static check on hostname
  const staticCheck = checkPrivateAddress(hostname);
  if (staticCheck.private) {
    return { safe: false, reason: staticCheck.reason };
  }

  // Optional DNS resolution
  if (config.resolveBeforeFetch) {
    try {
      const { address } = await dns.lookup(hostname);
      const dnsCheck = checkPrivateAddress(address);
      if (dnsCheck.private) {
        return { safe: false, reason: dnsCheck.reason, resolvedIp: address };
      }
      return { safe: true, resolvedIp: address };
    } catch {
      // DNS resolution failed — allow through (tool will fail with connection error)
      return { safe: true };
    }
  }

  return { safe: true };
}

// ─── Guardian Admission Controller ────────────────────────────

/** Action types that involve outbound HTTP requests. */
const HTTP_ACTION_TYPES = new Set([
  'http_request',
  'browser_navigate',
]);

/**
 * SSRF admission controller — validates URLs in agent actions before execution.
 * Integrates into the Guardian admission pipeline as a validating controller.
 */
export class SsrfController implements AdmissionController {
  readonly name = 'SsrfController';
  readonly phase: AdmissionPhase = 'validating';
  private config: SsrfConfig;

  constructor(config?: Partial<SsrfConfig>) {
    this.config = { ...DEFAULT_SSRF_CONFIG, ...config };
  }

  check(action: AgentAction): AdmissionResult | null {
    if (!this.config.enabled) return null;
    if (!HTTP_ACTION_TYPES.has(action.type)) return null;

    const url = action.params.url as string | undefined;
    if (!url) return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null; // let the tool handle invalid URLs
    }

    const hostname = parsed.hostname.toLowerCase();

    // Allowlist
    if (this.config.allowlist?.includes(hostname)) return null;

    // Cloud metadata
    if (this.config.blockCloudMetadata !== false && CLOUD_METADATA_HOSTS.has(hostname)) {
      return {
        allowed: false,
        reason: `Blocked: ${hostname} is a cloud metadata endpoint (SSRF protection)`,
        controller: this.name,
      };
    }

    // Private networks
    if (!this.config.allowPrivateNetworks) {
      const check = checkPrivateAddress(hostname);
      if (check.private) {
        return {
          allowed: false,
          reason: `Blocked: ${hostname} is a ${check.reason ?? 'private'} address (SSRF protection)`,
          controller: this.name,
        };
      }
    }

    return null; // pass through
  }

  /** Update config at runtime. */
  updateConfig(config: Partial<SsrfConfig>): void {
    this.config = { ...this.config, ...config };
    log.info({ config: this.config }, 'SSRF controller config updated');
  }
}
