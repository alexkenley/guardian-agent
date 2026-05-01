import { describe, expect, it } from 'vitest';
import { redactLogValue } from './log-redaction.js';

describe('redactLogValue', () => {
  it('redacts secret-shaped strings, sensitive keys, and error stacks', () => {
    const err = new Error('failed with token=sk-test-log-secret-value');
    err.stack = [
      'Error: failed with token=sk-test-log-secret-value',
      '    at Authorization: Bearer log-secret-token-123456',
      '    at apiKey=AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    Object.assign(err, {
      apiKey: 'sk-test-log-object-secret',
      nested: {
        token: 'xoxb-123456789012-123456789012-logsecret',
        note: 'credential=super-secret-value',
      },
    });

    const redacted = redactLogValue({
      err,
      message: 'Bearer another-log-secret-token-123456',
      authorization: 'Bearer raw-log-secret-token-123456',
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('sk-test-log-secret-value');
    expect(serialized).not.toContain('log-secret-token-123456');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('sk-test-log-object-secret');
    expect(serialized).not.toContain('xoxb-123456789012-123456789012-logsecret');
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('another-log-secret-token-123456');
    expect(serialized).not.toContain('raw-log-secret-token-123456');
    expect(serialized).toContain('[REDACTED]');
  });
});
