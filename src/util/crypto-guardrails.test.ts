import { describe, expect, it } from 'vitest';
import {
  hashObjectSha256Hex,
  hashRedactedObject,
  isSensitiveKeyName,
  redactSensitiveText,
  redactSensitiveValue,
  stableStringify,
  timingSafeEqualString,
} from './crypto-guardrails.js';

describe('crypto-guardrails', () => {
  it('detects sensitive key variants', () => {
    expect(isSensitiveKeyName('apiKey')).toBe(true);
    expect(isSensitiveKeyName('api_key')).toBe(true);
    expect(isSensitiveKeyName('api-key')).toBe(true);
    expect(isSensitiveKeyName('projectId')).toBe(false);
  });

  it('redacts nested sensitive keys', () => {
    const redacted = redactSensitiveValue({
      token: 'secret-token',
      nested: {
        access_token: 'another-secret',
        keep: 'value',
      },
      arr: [{ password: 'hidden' }],
    }) as Record<string, unknown>;

    expect(redacted['token']).toBe('[REDACTED]');
    expect((redacted['nested'] as Record<string, unknown>)['access_token']).toBe('[REDACTED]');
    expect((redacted['nested'] as Record<string, unknown>)['keep']).toBe('value');
    expect(((redacted['arr'] as Array<Record<string, unknown>>)[0])['password']).toBe('[REDACTED]');
  });

  it('produces stable hashes regardless of key order', () => {
    const a = { b: 1, a: { y: 2, x: 3 } };
    const b = { a: { x: 3, y: 2 }, b: 1 };
    expect(hashObjectSha256Hex(a)).toBe(hashObjectSha256Hex(b));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('normalizes secret values in redacted hashes', () => {
    const a = hashRedactedObject({ token: 'abc', q: 'same' });
    const b = hashRedactedObject({ token: 'different', q: 'same' });
    expect(a.hash).toBe(b.hash);
  });

  it('compares tokens using timing-safe equality helper', () => {
    expect(timingSafeEqualString('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqualString('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqualString('abc123', 'abc1234')).toBe(false);
  });

  it('redacts generated secret token labels in text', () => {
    expect(redactSensitiveText('stack trace detail: secret-token-123456')).toBe('stack trace detail: [REDACTED]');
  });
});
