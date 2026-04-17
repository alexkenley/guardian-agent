import { describe, expect, it } from 'vitest';

import {
  inferAutomationControlOperation,
  inferAutomationOutputOperation,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './automation.js';

describe('automation intent entity resolver', () => {
  it('ignores injected skill catalogs when checking automation control intent', () => {
    const content = 'Investigate this security event as the dedicated Security Triage Agent. Relevant skills when useful: host-firewall-defense, native-av-management, security-mode-escalation, security-alert-hygiene, security-response-automation, browser-session-defense.';
    expect(isExplicitAutomationControlRequest(content)).toBe(false);
    expect(isExplicitAutomationOutputRequest(content)).toBe(false);
  });

  it('still detects explicit automation control requests after removing injected skill hints', () => {
    const content = 'Disable the Harbor launch automation. Relevant skills when useful: security-response-automation.';
    expect(isExplicitAutomationControlRequest(content)).toBe(true);
    expect(inferAutomationControlOperation(content)).toBe('toggle');
  });

  it('still detects explicit automation output analysis requests after removing injected skill hints', () => {
    const content = 'Summarize the automation run output for Harbor launch. Relevant skills when useful: security-response-automation.';
    expect(isExplicitAutomationOutputRequest(content)).toBe(true);
    expect(inferAutomationOutputOperation(content)).toBe('inspect');
  });

  it('ignores repository file references that happen to include automation terms', () => {
    const content = 'Inspect src/runtime/intent/unstructured-recovery.ts, src/runtime/intent/entity-resolvers/automation.ts, and src/worker/worker-session.ts for any path where quarantined content could still leak into later planning. Write tmp/round2-security-review.md with findings ordered by severity.';
    expect(isExplicitAutomationControlRequest(content)).toBe(false);
    expect(isExplicitAutomationOutputRequest(content)).toBe(false);
  });
});
