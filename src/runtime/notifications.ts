import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventType, AuditLog, AuditSeverity } from '../guardian/audit-log.js';
import type { EventBus } from '../queue/event-bus.js';
import { createLogger } from '../util/logging.js';
import type { AssistantNotificationsConfig } from '../config/types.js';
import { redactSensitiveText, redactSensitiveValue } from '../util/crypto-guardrails.js';

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
  config?: AssistantNotificationsConfig;
  getConfig?: () => AssistantNotificationsConfig;
  auditLog: AuditLog;
  eventBus: EventBus;
  senders?: NotificationSenders;
  now?: () => number;
}

export class NotificationService {
  private readonly config?: AssistantNotificationsConfig;
  private readonly getConfig?: () => AssistantNotificationsConfig;
  private readonly auditLog: AuditLog;
  private readonly eventBus: EventBus;
  private readonly senders: NotificationSenders;
  private readonly now: () => number;
  private readonly recentByKey = new Map<string, number>();
  private unsubscribeAudit?: () => void;

  constructor(options: NotificationServiceOptions) {
    this.config = options.config;
    this.getConfig = options.getConfig;
    this.auditLog = options.auditLog;
    this.eventBus = options.eventBus;
    this.senders = options.senders ?? {};
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.unsubscribeAudit = this.auditLog.addListener((event) => {
      void this.handleAuditEvent(event);
    });
  }

  stop(): void {
    this.unsubscribeAudit?.();
    this.unsubscribeAudit = undefined;
  }

  private async handleAuditEvent(event: AuditEvent): Promise<void> {
    const config = this.getActiveConfig();
    if (!config.enabled) return;
    if (!this.shouldNotify(config, event)) return;

    const notification = this.buildNotification(event);
    if (!notification) return;
    if (!this.shouldEmit(config, notification)) return;

    const destinations = resolveNotificationDestinations(config);

    await this.eventBus.emit({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: notification,
      timestamp: notification.timestamp,
    }).catch(() => {});

    const text = formatNotificationText(notification);
    const deliveries: Array<Promise<void>> = [];

    if (destinations.cli && this.senders.sendCli) {
      deliveries.push(Promise.resolve(this.senders.sendCli(text)));
    }
    if (destinations.telegram && this.senders.sendTelegram) {
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

  private shouldNotify(config: AssistantNotificationsConfig, event: AuditEvent): boolean {
    if (event.type === 'automation_finding') {
      const disposition = event.details.automationDisposition;
      if (!isRecord(disposition) || disposition.notify !== true) {
        return false;
      }
    }
    if (!config.auditEventTypes.includes(event.type)) return false;
    if (SEVERITY_WEIGHT[event.severity] < SEVERITY_WEIGHT[config.minSeverity]) return false;

    const detailType = extractDetailType(event.details);
    if (detailType && config.suppressedDetailTypes.includes(detailType)) {
      return false;
    }

    return true;
  }

  private shouldEmit(config: AssistantNotificationsConfig, notification: SecurityNotification): boolean {
    const lastSent = this.recentByKey.get(notification.dedupeKey);
    const now = this.now();
    this.pruneRecent(config, now);
    if (lastSent !== undefined && config.cooldownMs > 0 && (now - lastSent) < config.cooldownMs) {
      return false;
    }
    this.recentByKey.set(notification.dedupeKey, now);
    return true;
  }

  private pruneRecent(config: AssistantNotificationsConfig, now: number): void {
    const retentionMs = Math.max(config.cooldownMs, 60_000);
    for (const [key, timestamp] of this.recentByKey.entries()) {
      if ((now - timestamp) > retentionMs) {
        this.recentByKey.delete(key);
      }
    }
  }

  private buildNotification(event: AuditEvent): SecurityNotification | null {
    const description = redactSensitiveText(extractNotificationDescription(event));
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
      details: redactNotificationDetails(event.details),
    };
  }

  private getActiveConfig(): AssistantNotificationsConfig {
    return this.getConfig?.() ?? this.config ?? {
      enabled: true,
      minSeverity: 'warn',
      auditEventTypes: [],
      suppressedDetailTypes: [],
      cooldownMs: 60_000,
      deliveryMode: 'selected',
      destinations: {
        web: false,
        cli: false,
        telegram: false,
      },
    };
  }
}

export function resolveNotificationDestinations(
  config: AssistantNotificationsConfig,
): AssistantNotificationsConfig['destinations'] {
  if (config.deliveryMode === 'all') {
    return {
      web: true,
      cli: true,
      telegram: true,
    };
  }
  return config.destinations;
}

export function notificationDestinationEnabled(
  config: AssistantNotificationsConfig,
  destination: keyof AssistantNotificationsConfig['destinations'],
): boolean {
  return resolveNotificationDestinations(config)[destination] === true;
}

function extractDetailType(details: Record<string, unknown>): string | null {
  const keys = ['triggerDetailType', 'matchedAction', 'alertType', 'anomalyType', 'type', 'reason', 'actionType'];
  for (const key of keys) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function summarizeTitle(event: AuditEvent): string {
  switch (event.type) {
    case 'anomaly_detected':
      return 'Security anomaly detected';
    case 'host_alert':
      return 'Host monitoring alert';
    case 'gateway_alert':
      return 'Gateway firewall alert';
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
    case 'auth_failure':
      return 'Authentication failure requires attention';
    case 'automation_finding':
      return extractAutomationTitle(event.details) || `Automation finding: ${extractAutomationName(event.details)}`;
    default:
      return `Security event: ${event.type}`;
  }
}

function extractNotificationDescription(event: AuditEvent): string {
  if (event.type === 'automation_finding' && isSecurityTriageFinding(event.details)) {
    return summarizeSecurityTriageFinding(event.details);
  }
  return compactNotificationText(extractDescription(event.details));
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

function extractAutomationName(details: Record<string, unknown>): string {
  const name = details.automationName;
  if (typeof name === 'string' && name.trim()) return name.trim();
  const automationId = details.automationId;
  if (typeof automationId === 'string' && automationId.trim()) return automationId.trim();
  return 'automation';
}

function extractAutomationTitle(details: Record<string, unknown>): string {
  const title = details.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return '';
}

function isSecurityTriageFinding(details: Record<string, unknown>): boolean {
  return details.source === 'security_triage';
}

function summarizeSecurityTriageFinding(details: Record<string, unknown>): string {
  const triggerDetailType = typeof details.triggerDetailType === 'string' && details.triggerDetailType.trim()
    ? details.triggerDetailType.trim()
    : 'security signal';
  const triggerDescription = typeof details.triggerDescription === 'string' && details.triggerDescription.trim()
    ? compactNotificationText(details.triggerDescription)
    : '';
  if (triggerDescription) {
    return `Triage completed for ${triggerDetailType}: ${triggerDescription}`;
  }
  return `Triage completed for ${triggerDetailType}. Review Security Log for the full assessment.`;
}

function compactNotificationText(text: string): string {
  const normalized = redactSensitiveText(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 240) {
    return normalized || 'No additional detail provided.';
  }
  return `${normalized.slice(0, 237).trimEnd()}...`;
}

function redactNotificationDetails(details: Record<string, unknown>): Record<string, unknown> {
  const keyRedacted = redactSensitiveValue(details);
  const valueRedacted = redactNotificationStrings(keyRedacted);
  return isRecord(valueRedacted) ? valueRedacted : {};
}

function redactNotificationStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNotificationStrings(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactNotificationStrings(child);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
