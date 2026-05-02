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

const DEFAULT_REDACTED_VALUE = '[REDACTED]';

export function normalizeSensitiveKeyName(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeSensitiveKeyName(key));
}

export function redactSensitiveText(value: string, replacement = DEFAULT_REDACTED_VALUE): string {
  return value
    .replace(
      /\b(Authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      (_match, prefix: string) => `${prefix}Bearer ${replacement}`,
    )
    .replace(
      /\b(authorization)\s*[:=]\s*(?!Bearer\s+\[REDACTED\])["']?[^"',;\s)}\]]{4,}/gi,
      (_match, key: string) => `${key}=${replacement}`,
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|client[_-]?secret|credential|password|refresh[_-]?token|secret|token)\s*[:=]\s*["']?(?!\[REDACTED\])[^"',;\s)}\]]{4,}/gi,
      (_match, key: string) => `${key}=${replacement}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => `Bearer ${replacement}`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => replacement)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, () => replacement)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, () => replacement)
    .replace(/\bsecret[-_][A-Za-z0-9._-]{5,}\b/gi, () => replacement)
    .replace(/\bslack[-_]?token[-_][A-Za-z0-9._-]{5,}\b/gi, () => replacement)
    .replace(/\b(?:sk|rk|xox[baprs]|gh[pousr]|glpat|github_pat|hf)[-_][A-Za-z0-9._-]{12,}\b/g, () => replacement);
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
