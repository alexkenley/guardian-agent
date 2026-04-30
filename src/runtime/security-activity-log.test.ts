import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecurityActivityLogService,
  isSecurityActivityStatus,
} from './security-activity-log.js';

function makePersistPath(): string {
  return join(tmpdir(), `guardianagent-security-activity-${randomUUID()}.json`);
}

describe('SecurityActivityLogService', () => {
  it('records entries, exposes filtered lists, and persists them', async () => {
    const persistPath = makePersistPath();
    const log = new SecurityActivityLogService({ persistPath, now: () => 1_000 });

    log.record({
      agentId: 'security-triage-dispatcher',
      targetAgentId: 'security-triage',
      status: 'started',
      severity: 'warn',
      title: 'Investigating beaconing',
      summary: 'Beaconing detected to external host.',
      triggerEventType: 'security:network:threat',
      triggerDetailType: 'beaconing',
      dedupeKey: 'security:network:threat:beaconing',
    });
    log.record({
      agentId: 'security-triage-dispatcher',
      targetAgentId: 'security-triage',
      status: 'completed',
      severity: 'warn',
      title: 'Completed triage for beaconing',
      summary: 'Likely benign telemetry sync. Stay in monitor.',
      triggerEventType: 'security:network:threat',
      triggerDetailType: 'beaconing',
      dedupeKey: 'security:network:threat:beaconing',
    });

    await log.persist();

    const all = log.list();
    expect(all.totalMatches).toBe(2);
    expect(all.byStatus.started).toBe(1);
    expect(all.byStatus.completed).toBe(1);
    expect(all.entries[0]?.status).toBe('completed');

    const filtered = log.list({ status: 'completed', agentId: 'security-triage' });
    expect(filtered.totalMatches).toBe(1);
    expect(filtered.entries[0]?.summary).toContain('Stay in monitor');

    const reloaded = new SecurityActivityLogService({ persistPath });
    await reloaded.load();
    const persisted = reloaded.list();
    expect(persisted.totalMatches).toBe(2);
    expect(persisted.entries[0]?.title).toBe('Completed triage for beaconing');

    rmSync(persistPath, { force: true });
  });

  it('validates activity status strings', () => {
    expect(isSecurityActivityStatus('started')).toBe(true);
    expect(isSecurityActivityStatus('completed')).toBe(true);
    expect(isSecurityActivityStatus('bogus')).toBe(false);
  });

  it('groups low-confidence skipped signals for operator-facing activity lists', () => {
    let now = 1_000;
    const log = new SecurityActivityLogService({
      persistPath: makePersistPath(),
      now: () => now,
    });

    log.record({
      agentId: 'security-triage-dispatcher',
      targetAgentId: 'assistant-security',
      status: 'skipped',
      severity: 'info',
      title: 'Received expected guardrail denial without triage',
      summary: 'Observed notification event and left it in monitor-only review.',
      triggerEventType: 'security:alert',
      triggerDetailType: 'expected_guardrail_denial',
      triggerSourceAgentId: 'notification-service',
      dedupeKey: 'security:alert:expected_guardrail_denial',
      details: {
        reason: 'low_confidence',
        sourceLabel: 'notification',
      },
    });
    now += 1_000;
    log.record({
      agentId: 'security-triage-dispatcher',
      targetAgentId: 'assistant-security',
      status: 'skipped',
      severity: 'info',
      title: 'Received expected guardrail denial without triage',
      summary: 'Observed notification event and left it in monitor-only review again.',
      triggerEventType: 'security:alert',
      triggerDetailType: 'expected_guardrail_denial',
      triggerSourceAgentId: 'notification-service',
      dedupeKey: 'security:alert:expected_guardrail_denial',
      details: {
        reason: 'low_confidence',
        sourceLabel: 'notification',
      },
    });
    now += 1_000;
    log.record({
      agentId: 'security-triage-dispatcher',
      targetAgentId: 'assistant-security',
      status: 'completed',
      severity: 'warn',
      title: 'Completed triage for beaconing',
      summary: 'Likely benign telemetry sync. Stay in monitor.',
      triggerEventType: 'security:network:threat',
      triggerDetailType: 'beaconing',
      dedupeKey: 'security:network:threat:beaconing',
    });

    const grouped = log.list({ groupLowConfidence: true });

    expect(grouped.totalMatches).toBe(3);
    expect(grouped.entries).toHaveLength(1);
    expect(grouped.entries[0]?.status).toBe('completed');
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]).toEqual(expect.objectContaining({
      count: 2,
      reason: 'low_confidence',
      triggerDetailType: 'expected_guardrail_denial',
      latestSummary: 'Observed notification event and left it in monitor-only review again.',
    }));
  });
});
