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

  it('redacts OAuth and JWT-shaped tokens from visible security summary text', async () => {
    installSecurityPageDomStubs();

    const { redactSecurityTextForDisplay } = await import('../web/public/js/pages/security.js');
    const text = [
      'Google refresh failed with ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz0123456789',
      'Provider returned eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345',
    ].join(' ');

    const redacted = redactSecurityTextForDisplay(text);

    expect(redacted).toContain('ya29.[REDACTED]');
    expect(redacted).toContain('jwt_[REDACTED]');
    expect(redacted).not.toContain('a0AfH6SMBabcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
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

  it('summarizes audit-chain verification state for Security Log', async () => {
    installSecurityPageDomStubs();

    const { formatAuditChainStatusForDisplay } = await import('../web/public/js/pages/security.js');

    expect(formatAuditChainStatusForDisplay({ valid: true, totalEntries: 2 })).toBe('Audit chain verified (2 entries)');
    expect(formatAuditChainStatusForDisplay({ valid: false, brokenAt: 7 })).toBe('Audit chain verification failed at entry 7');
    expect(formatAuditChainStatusForDisplay({ available: false })).toBe('Audit chain verification unavailable');
  });

  it('selects structured related audit events for alert detail panes', async () => {
    installSecurityPageDomStubs();

    const { selectRelatedAuditEventsForAlert } = await import('../web/public/js/pages/security.js');
    const alert = {
      type: 'new_external_destination',
      source: 'host',
      subject: 'workstation-1',
      dedupeKey: 'host:new_external_destination:203.0.113.10',
      firstSeenAt: 10_000,
      lastSeenAt: 12_000,
    };
    const relatedByDedupe = {
      id: 'audit-1',
      timestamp: 11_000,
      type: 'host_alert',
      agentId: 'host-monitor',
      details: {
        dedupeKey: 'host:new_external_destination:203.0.113.10',
        triggerDetailType: 'new_external_destination',
        source: 'host',
      },
    };
    const relatedBySubject = {
      id: 'audit-2',
      timestamp: 11_500,
      type: 'action_denied',
      agentId: 'guardian',
      details: {
        source: 'host',
        subject: 'workstation-1',
      },
    };
    const unrelated = {
      id: 'audit-3',
      timestamp: 3_600_000,
      type: 'host_alert',
      agentId: 'host-monitor',
      details: {
        dedupeKey: 'host:new_external_destination:198.51.100.4',
        triggerDetailType: 'new_external_destination',
      },
    };

    expect(selectRelatedAuditEventsForAlert(alert, [unrelated, relatedBySubject, relatedByDedupe])).toEqual([
      relatedByDedupe,
      relatedBySubject,
    ]);
  });
});
