import { describe, it, expect } from 'vitest';
import { AuditLog } from '../guardian/audit-log.js';
import {
  deriveAutomationFindings,
  normalizeAutomationOutputHandling,
  promoteAutomationFindings,
} from './automation-output.js';

describe('automation output routing', () => {
  it('normalizes missing output handling to safe defaults', () => {
    expect(normalizeAutomationOutputHandling(undefined)).toEqual({
      notify: 'off',
      sendToSecurity: 'off',
      persistArtifacts: 'run_history_plus_memory',
    });
  });

  it('derives warning findings from failed steps', () => {
    const findings = deriveAutomationFindings({
      status: 'failed',
      message: 'Workflow failed',
      steps: [
        {
          stepId: 'step-1',
          toolName: 'cf_dns_list',
          status: 'failed',
          message: 'Critical DNS drift detected',
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'critical',
      stepId: 'step-1',
      title: 'Automation step failed: cf_dns_list',
    });
  });

  it('records audit events only for routed findings', () => {
    const auditLog = new AuditLog();
    const promoted = promoteAutomationFindings(auditLog, {
      automationId: 'cloud-drift',
      automationName: 'Cloud Drift Check',
      runId: 'run-1',
      status: 'failed',
      message: 'Detected suspicious drift',
      steps: [
        {
          stepId: 'step-1',
          toolName: 'cf_dns_list',
          status: 'failed',
          message: 'Suspicious DNS drift detected',
        },
      ],
      outputHandling: {
        notify: 'warn_critical',
        sendToSecurity: 'warn_critical',
        persistArtifacts: 'run_history_only',
      },
      runLink: '#/automations?runId=run-1',
    });

    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      notify: true,
      sendToSecurity: true,
      runLink: '#/automations?runId=run-1',
    });

    const events = auditLog.query({ type: 'automation_finding' });
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({
      automationId: 'cloud-drift',
      automationName: 'Cloud Drift Check',
      runId: 'run-1',
      automationDisposition: {
        notify: true,
        sendToSecurity: true,
      },
    });
  });
});
