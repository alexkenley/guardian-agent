import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventType, AuditLog, AuditSeverity } from '../guardian/audit-log.js';
import type { EventBus } from '../queue/event-bus.js';
import { createLogger } from '../util/logging.js';
import type { AssistantNotificationsConfig } from '../config/types.js';

const log = createLogger('notifications');

const SEVERITY_WEIGHT: Record<AuditSeverity, number> = {
  info: 1,
  warn: 2,
  critical: 3,
};

export interface SecurityNotification {
  id: string;
  timestamp: number;
  severity: AuditSeverity;
  source: 'audit';
  sourceEventType: AuditEventType;
  agentId: string;
  title: string;
  description: string;
  dedupeKey: string;
  details: Record<string, unknown>;
}

interface NotificationSenders {
  sendCli?: (text: string) => Promise<void> | void;
  sendTelegram?: (text: string) => Promise<void> | void;
}

export interface NotificationServiceOptions {
  config: AssistantNotificationsConfig;
  auditLog: AuditLog;
  eventBus: EventBus;
  senders?: NotificationSenders;
  now?: () => number;
}

export class NotificationService {
  private readonly config: AssistantNotificationsConfig;
  private readonly auditLog: AuditLog;
  private readonly eventBus: EventBus;
  private readonly senders: NotificationSenders;
  private readonly now: () => number;
  private readonly recentByKey = new Map<string, number>();
  private unsubscribeAudit?: () => void;

  constructor(options: NotificationServiceOptions) {
    this.config = options.config;
    this.auditLog = options.auditLog;
    this.eventBus = options.eventBus;
    this.senders = options.senders ?? {};
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.config.enabled) return;
    this.unsubscribeAudit = this.auditLog.addListener((event) => {
      void this.handleAuditEvent(event);
    });
  }

  stop(): void {
    this.unsubscribeAudit?.();
    this.unsubscribeAudit = undefined;
  }

  private async handleAuditEvent(event: AuditEvent): Promise<void> {
    if (!this.shouldNotify(event)) return;

    const notification = this.buildNotification(event);
    if (!notification) return;
    if (!this.shouldEmit(notification)) return;

    if (this.config.destinations.web) {
      await this.eventBus.emit({
        type: 'security:alert',
        sourceAgentId: 'notification-service',
        targetAgentId: '*',
        payload: notification,
        timestamp: notification.timestamp,
      }).catch(() => {});
    }

    const text = formatNotificationText(notification);
    const deliveries: Array<Promise<void>> = [];

    if (this.config.destinations.cli && this.senders.sendCli) {
      deliveries.push(Promise.resolve(this.senders.sendCli(text)));
    }
    if (this.config.destinations.telegram && this.senders.sendTelegram) {
      deliveries.push(Promise.resolve(this.senders.sendTelegram(text)));
    }

    if (deliveries.length > 0) {
      try {
        await Promise.all(deliveries);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Notification delivery failed');
      }
    }
  }

  private shouldNotify(event: AuditEvent): boolean {
    if (!this.config.auditEventTypes.includes(event.type)) return false;
    return SEVERITY_WEIGHT[event.severity] >= SEVERITY_WEIGHT[this.config.minSeverity];
  }

  private shouldEmit(notification: SecurityNotification): boolean {
    const lastSent = this.recentByKey.get(notification.dedupeKey);
    const now = this.now();
    this.pruneRecent(now);
    if (lastSent !== undefined && this.config.cooldownMs > 0 && (now - lastSent) < this.config.cooldownMs) {
      return false;
    }
    this.recentByKey.set(notification.dedupeKey, now);
    return true;
  }

  private pruneRecent(now: number): void {
    const retentionMs = Math.max(this.config.cooldownMs, 60_000);
    for (const [key, timestamp] of this.recentByKey.entries()) {
      if ((now - timestamp) > retentionMs) {
        this.recentByKey.delete(key);
      }
    }
  }

  private buildNotification(event: AuditEvent): SecurityNotification | null {
    const description = extractDescription(event.details);
    const dedupeKey = [
      event.type,
      event.agentId,
      event.controller ?? '',
      description,
    ].join('|');

    return {
      id: randomUUID(),
      timestamp: event.timestamp,
      severity: event.severity,
      source: 'audit',
      sourceEventType: event.type,
      agentId: event.agentId,
      title: summarizeTitle(event),
      description,
      dedupeKey,
      details: { ...event.details },
    };
  }
}

function summarizeTitle(event: AuditEvent): string {
  switch (event.type) {
    case 'anomaly_detected':
      return 'Security anomaly detected';
    case 'host_alert':
      return 'Host monitoring alert';
    case 'secret_detected':
      return 'Sensitive data exposure risk detected';
    case 'action_denied':
      return 'Dangerous action blocked';
    case 'policy_changed':
    case 'policy_mode_changed':
    case 'policy_shadow_mismatch':
      return 'Security policy change detected';
    case 'agent_error':
      return 'Agent error requires attention';
    case 'agent_stalled':
      return 'Agent stalled';
    default:
      return `Security event: ${event.type}`;
  }
}

function extractDescription(details: Record<string, unknown>): string {
  const description = details.description;
  if (typeof description === 'string' && description.trim()) return description.trim();
  const reason = details.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  const error = details.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const actionType = details.actionType;
  if (typeof actionType === 'string' && actionType.trim()) {
    return `Action type: ${actionType.trim()}`;
  }
  return 'No additional detail provided.';
}

export function formatNotificationText(notification: SecurityNotification): string {
  const lines = [
    `[GuardianAgent ${notification.severity.toUpperCase()}] ${notification.title}`,
    notification.description,
    `Agent: ${notification.agentId}`,
    `Event: ${notification.sourceEventType}`,
    `Time: ${new Date(notification.timestamp).toLocaleString()}`,
  ];
  return lines.join('\n');
}
