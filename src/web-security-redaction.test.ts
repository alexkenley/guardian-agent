import { describe, expect, it } from 'vitest';

describe('Security page redaction helpers', () => {
  function installSecurityPageDomStubs(): void {
    globalThis.HTMLButtonElement = class HTMLButtonElement {} as never;
    globalThis.document = {
      querySelectorAll: () => [],
      createElement: () => ({ textContent: '', innerHTML: '' }),
      body: { appendChild: () => undefined },
      querySelector: () => null,
    } as never;
  }

  it('redacts secret-like keys and token-shaped strings before raw security JSON rendering', async () => {
    installSecurityPageDomStubs();

    const { redactSecurityJsonForDisplay } = await import('../web/public/js/pages/security.js');

    const redacted = redactSecurityJsonForDisplay({
      evidence: {
        apiKey: 'sk-live-secret-value-12345',
        nested: {
          authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
          note: 'token=plain-secret-token-value path=C:\\Users\\kenle\\.guardianagent',
        },
        resources: [
          'file:C:\\Users\\kenle\\.guardianagent\\config.yaml',
          'ghp_abcdefghijklmnopqrstuvwxyz',
        ],
      },
    });

    expect(redacted.evidence.apiKey).toBe('[REDACTED]');
    expect(redacted.evidence.nested.authorization).toBe('[REDACTED]');
    expect(redacted.evidence.nested.note).toContain('token=[REDACTED]');
    expect(redacted.evidence.resources[0]).toContain('.guardianagent');
    expect(redacted.evidence.resources[1]).toBe('ghp_[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('sk-live-secret-value');
    expect(JSON.stringify(redacted)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('explains whether Security activity entries ran AI triage', async () => {
    installSecurityPageDomStubs();

    const { formatSecurityActivityStatusForDisplay } = await import('../web/public/js/pages/security.js');

    expect(formatSecurityActivityStatusForDisplay({ status: 'completed' })).toBe('AI triage completed');
    expect(formatSecurityActivityStatusForDisplay({
      status: 'skipped',
      details: { reason: 'low_confidence' },
    })).toBe('No AI triage (low-confidence signal)');
    expect(formatSecurityActivityStatusForDisplay({
      status: 'skipped',
      details: { reason: 'cooldown' },
    })).toBe('No AI triage (cooldown window)');
  });
});
