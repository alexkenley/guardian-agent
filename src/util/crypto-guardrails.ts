/**
 * Cryptographic guardrail helpers used across security-sensitive paths.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'token',
  'password',
  'secret',
  'credentials',
  'authorization',
  'bearer',
  'jwt',
  'privatekey',
  'clientsecret',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'sessionid',
  'creditcard',
  'cvv',
  'accountnumber',
  'routingnumber',
  'awsaccesskeyid',
  'awssecretaccesskey',
  'githubtoken',
  'email',
  'phone',
  'ssn',
]);

export function normalizeSensitiveKeyName(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeSensitiveKeyName(key));
}

export function redactSensitiveValue(value: unknown, replacement = '[REDACTED]'): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, replacement));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKeyName(key)) {
        out[key] = replacement;
      } else {
        out[key] = redactSensitiveValue(child, replacement);
      }
    }
    return out;
  }

  return value;
}

export function timingSafeEqualString(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function stableStringify(value: unknown): string {
  const canonical = canonicalizeForJson(value);
  const result = JSON.stringify(canonical);
  return result ?? 'null';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashObjectSha256Hex(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function hashRedactedObject(
  value: unknown,
  replacement = '[REDACTED]',
): { hash: string; redacted: unknown; canonical: string } {
  const redacted = redactSensitiveValue(value, replacement);
  const canonical = stableStringify(redacted);
  return {
    hash: sha256Hex(canonical),
    redacted,
    canonical,
  };
}

function canonicalizeForJson(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonical = canonicalizeForJson(item);
      return canonical === undefined ? null : canonical;
    });
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalizeForJson(child)] as const)
      .filter(([, child]) => child !== undefined);
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      out[key] = child;
    }
    return out;
  }

  return value;
}
