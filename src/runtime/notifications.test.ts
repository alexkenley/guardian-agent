import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../guardian/audit-log.js';
import { NotificationService, formatNotificationText } from './notifications.js';
import type { AssistantNotificationsConfig } from '../config/types.js';
import type { EventBus } from '../queue/event-bus.js';

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeConfig(overrides?: Partial<AssistantNotificationsConfig>): AssistantNotificationsConfig {
  return {
    enabled: true,
    minSeverity: 'warn',
    auditEventTypes: ['anomaly_detected', 'action_denied', 'secret_detected'],
    cooldownMs: 60_000,
    destinations: {
      web: true,
      cli: true,
      telegram: true,
    },
    ...overrides,
  };
}

describe('NotificationService', () => {
  it('emits normalized security alerts and delivers to sinks', async () => {
    const auditLog = new AuditLog();
    const eventBus = { emit: vi.fn().mockResolvedValue(true) } as unknown as EventBus;
    const sendCli = vi.fn().mockResolvedValue(undefined);
    const sendTelegram = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationService({
      config: makeConfig(),
      auditLog,
      eventBus,
      senders: { sendCli, sendTelegram },
    });

    service.start();
    auditLog.record({
      type: 'anomaly_detected',
      severity: 'critical',
      agentId: 'sentinel',
      details: { description: 'Potential exfiltration pattern detected' },
    });
    await flushAsyncWork();

    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: expect.objectContaining({
        severity: 'critical',
        sourceEventType: 'anomaly_detected',
        agentId: 'sentinel',
        description: 'Potential exfiltration pattern detected',
      }),
    }));
    expect(sendCli).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate notifications during cooldown', async () => {
    const auditLog = new AuditLog();
    const eventBus = { emit: vi.fn().mockResolvedValue(true) } as unknown as EventBus;
    const sendCli = vi.fn().mockResolvedValue(undefined);
    let now = 1_000;
    const service = new NotificationService({
      config: makeConfig({ cooldownMs: 10_000 }),
      auditLog,
      eventBus,
      senders: { sendCli },
      now: () => now,
    });

    service.start();
    auditLog.record({
      type: 'action_denied',
      severity: 'warn',
      agentId: 'assistant-tools',
      details: { reason: 'Blocked by policy.' },
    });
    await flushAsyncWork();

    now += 1_000;
    auditLog.record({
      type: 'action_denied',
      severity: 'warn',
      agentId: 'assistant-tools',
      details: { reason: 'Blocked by policy.' },
    });
    await flushAsyncWork();

    expect(sendCli).toHaveBeenCalledTimes(1);
  });

  it('ignores events below configured severity', async () => {
    const auditLog = new AuditLog();
    const eventBus = { emit: vi.fn().mockResolvedValue(true) } as unknown as EventBus;
    const sendCli = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationService({
      config: makeConfig({ minSeverity: 'critical' }),
      auditLog,
      eventBus,
      senders: { sendCli },
    });

    service.start();
    auditLog.record({
      type: 'secret_detected',
      severity: 'warn',
      agentId: 'guardian',
      details: { reason: 'Credential-like token found' },
    });
    await flushAsyncWork();

    expect(vi.mocked(eventBus.emit)).not.toHaveBeenCalled();
    expect(sendCli).not.toHaveBeenCalled();
  });

  it('formats readable notification text', () => {
    const text = formatNotificationText({
      id: 'n1',
      timestamp: 0,
      severity: 'warn',
      source: 'audit',
      sourceEventType: 'action_denied',
      agentId: 'assistant-tools',
      title: 'Dangerous action blocked',
      description: 'Blocked by policy.',
      dedupeKey: 'k1',
      details: {},
    });

    expect(text).toContain('GuardianAgent WARN');
    expect(text).toContain('Dangerous action blocked');
    expect(text).toContain('Blocked by policy.');
  });
});
