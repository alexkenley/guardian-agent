import { randomUUID } from 'node:crypto';
import { BaseAgent } from '../agent/agent.js';
import type { AgentContext } from '../agent/types.js';
import type { AuditLog, AuditSeverity } from '../guardian/audit-log.js';
import type { AgentEvent } from '../queue/event-bus.js';
import type { SecurityActivityLogService } from './security-activity-log.js';
import {
  isExpectedGuardrailSecurityDetailType,
  isLowConfidenceSecurityDetailType,
} from './security-signal-taxonomy.js';

export const SECURITY_TRIAGE_AGENT_ID = 'security-triage';
export const SECURITY_TRIAGE_DISPATCHER_AGENT_ID = 'security-triage-dispatcher';
export const DEFAULT_SECURITY_TRIAGE_SYSTEM_PROMPT = [
  'You are the dedicated Security Triage Agent.',
  'Investigate security events using built-in defensive tools and security skills.',
  'Prefer read-only evidence gathering first: security_alert_search, security_posture_status, security_containment_status, assistant_security_summary, assistant_security_findings, intel_summary, intel_findings, host_monitor_status, host_monitor_check, gateway_firewall_status, gateway_firewall_check, windows_defender_status, windows_defender_refresh, net_threat_summary, net_threat_check, and net_anomaly_check.',
  'Do not acknowledge, resolve, suppress, or mutate security state unless a human explicitly asks.',
  'Your job is to distinguish real incidents from benign noise, corroborate signals across sources, and recommend the right operating mode and next action.',
].join(' ');

const RELEVANT_SECURITY_ALERT_EVENT_TYPES = new Set([
  'action_denied',
  'secret_detected',
  'anomaly_detected',
  'host_alert',
  'gateway_alert',
  'auth_failure',
  'agent_error',
]);

const DEFAULT_TRIAGE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_EVENT_PAYLOAD_CHARS = 4_000;

export interface SecurityEventTriageAgentOptions {
  targetAgentId: string;
  primaryUserId: string;
  auditLog: AuditLog;
  activityLog?: SecurityActivityLogService;
  now?: () => number;
  channel?: string;
  cooldownMs?: number;
  allowedCapabilities?: string[];
}

interface SecurityEventTriageCandidate {
  dedupeKey: string;
  detailType: string;
  description: string;
  severity: AuditSeverity;
  sourceLabel: string;
}

interface SecurityEventTriageDecision extends SecurityEventTriageCandidate {
  disposition: 'triage' | 'skip';
  skipReason?: 'low_confidence' | 'low_severity' | 'informational';
}

export class SecurityEventTriageAgent extends BaseAgent {
  private readonly targetAgentId: string;
  private readonly primaryUserId: string;
  private readonly auditLog: AuditLog;
  private readonly activityLog?: SecurityActivityLogService;
  private readonly now: () => number;
  private readonly channel: string;
  private readonly cooldownMs: number;
  private readonly allowedCapabilities: string[];
  private readonly recentByKey = new Map<string, number>();

  constructor(options: SecurityEventTriageAgentOptions) {
    super(SECURITY_TRIAGE_DISPATCHER_AGENT_ID, 'Security Triage Dispatcher', { handleEvents: true });
    this.targetAgentId = options.targetAgentId;
    this.primaryUserId = options.primaryUserId;
    this.auditLog = options.auditLog;
    this.activityLog = options.activityLog;
    this.now = options.now ?? Date.now;
    this.channel = options.channel?.trim() || 'scheduled';
    this.cooldownMs = Math.max(10_000, options.cooldownMs ?? DEFAULT_TRIAGE_COOLDOWN_MS);
    this.allowedCapabilities = options.allowedCapabilities?.length
      ? [...options.allowedCapabilities]
      : ['execute_commands', 'network_access'];
  }

  async onEvent(event: AgentEvent, ctx: AgentContext): Promise<void> {
    const decision = classifySecurityEvent(event);
    if (!decision) return;

    const now = this.now();
    this.pruneRecent(now);
    const lastSeen = this.recentByKey.get(decision.dedupeKey);
    if (decision.disposition === 'skip') {
      if (lastSeen !== undefined && (now - lastSeen) < this.cooldownMs) {
        return;
      }
      this.recentByKey.set(decision.dedupeKey, now);
      this.recordActivity({
        timestamp: now,
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'skipped',
        severity: 'info',
        title: decision.skipReason === 'informational'
          ? `Observed ${decision.detailType} without action`
          : `Received ${decision.detailType} without triage`,
        summary: decision.skipReason === 'informational'
          ? decision.description
          : `Observed ${decision.sourceLabel} event and left it in monitor-only review.`,
        triggerEventType: event.type,
        triggerDetailType: decision.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: decision.dedupeKey,
        details: {
          reason: decision.skipReason ?? 'low_confidence',
          description: decision.description,
          sourceLabel: decision.sourceLabel,
        },
      });
      return;
    }

    const candidate = decision;
    if (lastSeen !== undefined && (now - lastSeen) < this.cooldownMs) {
      this.recordActivity({
        timestamp: now,
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'skipped',
        severity: 'info',
        title: `Skipped repeated ${candidate.detailType}`,
        summary: `Ignored ${candidate.sourceLabel} event inside cooldown window.`,
        triggerEventType: event.type,
        triggerDetailType: candidate.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: candidate.dedupeKey,
        details: {
          reason: 'cooldown',
          cooldownMs: this.cooldownMs,
          sourceLabel: candidate.sourceLabel,
        },
      });
      return;
    }
    this.recentByKey.set(candidate.dedupeKey, now);

    if (!ctx.dispatch) {
      this.recordActivity({
        timestamp: now,
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'failed',
        severity: 'warn',
        title: `Security triage unavailable for ${candidate.detailType}`,
        summary: 'Runtime dispatch is unavailable for security triage.',
        triggerEventType: event.type,
        triggerDetailType: candidate.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: candidate.dedupeKey,
      });
      this.auditLog.record({
        type: 'agent_error',
        severity: 'warn',
        agentId: this.id,
        channel: this.channel,
        controller: 'SecurityTriageAgent',
        details: {
          reason: 'Runtime dispatch is unavailable for security triage.',
          sourceEventType: event.type,
          triggerDetailType: candidate.detailType,
          dedupeKey: candidate.dedupeKey,
        },
      });
      return;
    }

    try {
      this.recordActivity({
        timestamp: now,
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'started',
        severity: candidate.severity,
        title: `Investigating ${candidate.detailType}`,
        summary: candidate.description,
        triggerEventType: event.type,
        triggerDetailType: candidate.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: candidate.dedupeKey,
        details: {
          sourceLabel: candidate.sourceLabel,
        },
      });

      const response = await ctx.dispatch(
        this.targetAgentId,
        {
          id: randomUUID(),
          userId: this.primaryUserId,
          principalId: this.primaryUserId,
          principalRole: 'owner',
          channel: this.channel,
          content: buildSecurityTriagePrompt(event, candidate),
          metadata: {
            securityEvent: {
              type: event.type,
              sourceAgentId: event.sourceAgentId,
              detailType: candidate.detailType,
              dedupeKey: candidate.dedupeKey,
              severity: candidate.severity,
            },
          },
          timestamp: now,
        },
        {
          handoff: {
            id: `security-triage:${candidate.dedupeKey}:${now}`,
            sourceAgentId: this.id,
            targetAgentId: this.targetAgentId,
            allowedCapabilities: [...this.allowedCapabilities],
            contextMode: 'user_only',
            preserveTaint: false,
            requireApproval: false,
          },
        },
      );

      const content = response.content.trim() || `Security triage completed for ${candidate.detailType}.`;
      this.recordActivity({
        timestamp: this.now(),
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'completed',
        severity: candidate.severity,
        title: `Completed triage for ${candidate.detailType}`,
        summary: content,
        triggerEventType: event.type,
        triggerDetailType: candidate.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: candidate.dedupeKey,
      });
      this.auditLog.record({
        type: 'automation_finding',
        severity: candidate.severity,
        agentId: this.id,
        userId: this.primaryUserId,
        channel: this.channel,
        controller: 'SecurityTriageAgent',
        details: {
          source: 'security_triage',
          automationId: this.targetAgentId,
          automationName: 'Security Triage Agent',
          title: `Security triage: ${candidate.detailType}`,
          description: content,
          triggerEventType: event.type,
          triggerSourceAgentId: event.sourceAgentId,
          triggerDetailType: candidate.detailType,
          triggerDescription: candidate.description,
          dedupeKey: candidate.dedupeKey,
          triageAgentId: this.targetAgentId,
          automationDisposition: {
            notify: false,
            sendToSecurity: true,
          },
        },
      });

      await ctx.emit({
        type: 'security:triage:completed',
        targetAgentId: '*',
        payload: {
          triageAgentId: this.targetAgentId,
          dedupeKey: candidate.dedupeKey,
          triggerEventType: event.type,
          triggerSourceAgentId: event.sourceAgentId,
          triggerDetailType: candidate.detailType,
          triggerDescription: candidate.description,
          severity: candidate.severity,
          summary: content,
        },
      });
    } catch (err) {
      this.recordActivity({
        timestamp: this.now(),
        agentId: this.id,
        targetAgentId: this.targetAgentId,
        status: 'failed',
        severity: 'warn',
        title: `Security triage failed for ${candidate.detailType}`,
        summary: err instanceof Error ? err.message : String(err),
        triggerEventType: event.type,
        triggerDetailType: candidate.detailType,
        triggerSourceAgentId: event.sourceAgentId,
        dedupeKey: candidate.dedupeKey,
      });
      this.auditLog.record({
        type: 'agent_error',
        severity: 'warn',
        agentId: this.id,
        userId: this.primaryUserId,
        channel: this.channel,
        controller: 'SecurityTriageAgent',
        details: {
          reason: err instanceof Error ? err.message : String(err),
          sourceEventType: event.type,
          triggerDetailType: candidate.detailType,
          dedupeKey: candidate.dedupeKey,
        },
      });
    }
  }

  private pruneRecent(now: number): void {
    for (const [key, timestamp] of this.recentByKey.entries()) {
      if ((now - timestamp) > this.cooldownMs) {
        this.recentByKey.delete(key);
      }
    }
  }

  private recordActivity(entry: Parameters<SecurityActivityLogService['record']>[0]): void {
    this.activityLog?.record(entry);
  }
}

function classifySecurityEvent(event: AgentEvent): SecurityEventTriageDecision | null {
  if (event.type === 'security:network:threat') {
    const payload = asRecord(event.payload);
    const detailType = asString(payload.type) || 'network_threat';
    const severity = toAuditSeverity(payload.severity);
    if (severity === 'info') return null;
    return {
      dedupeKey: `${event.type}:${detailType}`,
      detailType,
      description: asString(payload.description) || `Network threat detected: ${detailType}`,
      severity,
      sourceLabel: 'network',
      disposition: 'triage',
    };
  }

  if (event.type === 'host:monitor:check') {
    return classifyInteractiveMonitorCheck(event, 'host');
  }

  if (event.type === 'gateway:monitor:check') {
    return classifyInteractiveMonitorCheck(event, 'gateway');
  }

  if (event.type === 'security:host:alert') {
    return classifyDirectAlertEvent(event, 'host');
  }

  if (event.type === 'security:gateway:alert') {
    return classifyDirectAlertEvent(event, 'gateway');
  }

  if (event.type === 'security:native:provider') {
    const payload = asRecord(event.payload);
    const alert = asRecord(payload.alert);
    const detailType = asString(alert.type) || 'native_provider_alert';
    const severity = toAuditSeverity(alert.severity);
    if (severity === 'info') {
      return {
        dedupeKey: buildDedupeKey(event.type, asString(alert.dedupeKey), detailType),
        detailType,
        description: asString(alert.description) || `Native security provider alert: ${detailType}`,
        severity,
        sourceLabel: 'native',
        disposition: 'skip',
        skipReason: 'low_severity',
      };
    }
    if (isLowConfidenceSecurityDetailType(detailType)) {
      return {
        dedupeKey: buildDedupeKey(event.type, asString(alert.dedupeKey), detailType),
        detailType,
        description: asString(alert.description) || `Native security provider alert: ${detailType}`,
        severity,
        sourceLabel: 'native',
        disposition: 'skip',
        skipReason: 'low_confidence',
      };
    }
    return {
      dedupeKey: buildDedupeKey(event.type, asString(alert.dedupeKey), detailType),
      detailType,
      description: asString(alert.description) || `Native security provider alert: ${detailType}`,
      severity,
      sourceLabel: 'native',
      disposition: 'triage',
    };
  }

  if (event.type === 'security:alert') {
    const payload = asRecord(event.payload);
    const sourceEventType = asString(payload.sourceEventType);
    if (!RELEVANT_SECURITY_ALERT_EVENT_TYPES.has(sourceEventType)) {
      return null;
    }
    const details = asRecord(payload.details);
    if (isSecurityTriageSelfNotification(sourceEventType, payload, details)) {
      return null;
    }
    if (sourceEventType === 'host_alert' || sourceEventType === 'gateway_alert') {
      return null;
    }
    const detailType = extractDetailType(payload) || sourceEventType;
    const severity = toAuditSeverity(payload.severity);
    if (severity === 'info') return null;
    if (isLowConfidenceSecurityDetailType(detailType) || isExpectedGuardrailDenial(sourceEventType, detailType, details)) {
      return {
        dedupeKey: buildDedupeKey(event.type, asString(payload.dedupeKey), `${sourceEventType}:${detailType}`),
        detailType,
        description: asString(payload.description) || `Security notification: ${detailType}`,
        severity,
        sourceLabel: 'notification',
        disposition: 'skip',
        skipReason: 'low_confidence',
      };
    }
    return {
      dedupeKey: buildDedupeKey(event.type, asString(payload.dedupeKey), `${sourceEventType}:${detailType}`),
      detailType,
      description: asString(payload.description) || `Security notification: ${detailType}`,
      severity,
      sourceLabel: 'notification',
      disposition: 'triage',
    };
  }

  return null;
}

function classifyDirectAlertEvent(
  event: AgentEvent,
  sourceLabel: 'host' | 'gateway',
): SecurityEventTriageDecision | null {
  const payload = asRecord(event.payload);
  const alert = asRecord(payload.alert);
  const detailType = asString(alert.type) || `${sourceLabel}_alert`;
  const severity = toAuditSeverity(alert.severity);
  const description = asString(alert.description) || `${sourceLabel} security alert: ${detailType}`;
  const dedupeKey = buildDedupeKey(event.type, asString(alert.dedupeKey), detailType);

  if (severity === 'info') {
    return {
      dedupeKey,
      detailType,
      description,
      severity,
      sourceLabel,
      disposition: 'skip',
      skipReason: 'low_severity',
    };
  }

  if (isLowConfidenceSecurityDetailType(detailType)) {
    return {
      dedupeKey,
      detailType,
      description,
      severity,
      sourceLabel,
      disposition: 'skip',
      skipReason: 'low_confidence',
    };
  }

  return {
    dedupeKey,
    detailType,
    description,
    severity,
    sourceLabel,
    disposition: 'triage',
  };
}

function classifyInteractiveMonitorCheck(
  event: AgentEvent,
  sourceLabel: 'host' | 'gateway',
): SecurityEventTriageDecision | null {
  const payload = asRecord(event.payload);
  const source = asString(payload.source);
  if (!isInteractiveSecurityCheckSource(source)) {
    return null;
  }

  const snapshot = asRecord(payload.snapshot);
  const processCount = asNumber(snapshot.processCount);
  const suspiciousProcesses = asArray(snapshot.suspiciousProcesses).length;
  const externalDestinations = asNumber(snapshot.knownExternalDestinationCount);
  const listeningPorts = asNumber(snapshot.listeningPortCount);
  const gatewayCount = asNumber(payload.gatewayCount);

  const summary = sourceLabel === 'host'
    ? `Observed host monitor check (${source}) with ${formatCount(processCount, 'process')}, ${formatCount(externalDestinations, 'external destination')}, and ${formatCount(listeningPorts, 'listening port')}; no agentic action taken.`
    : `Observed gateway monitor check (${source}) with ${formatCount(gatewayCount, 'gateway')} in scope; no agentic action taken.`;

  return {
    dedupeKey: `${event.type}:${event.timestamp}`,
    detailType: sourceLabel === 'host' ? 'host_monitor_check' : 'gateway_monitor_check',
    description: suspiciousProcesses > 0
      ? `${summary} ${formatCount(suspiciousProcesses, 'suspicious process')} reported in the snapshot.`
      : summary,
    severity: 'info',
    sourceLabel,
    disposition: 'skip',
    skipReason: 'informational',
  };
}

function buildDedupeKey(eventType: string, explicitKey: string, fallbackDetail: string): string {
  return explicitKey ? `${eventType}:${explicitKey}` : `${eventType}:${fallbackDetail}`;
}

function buildSecurityTriagePrompt(event: AgentEvent, candidate: SecurityEventTriageCandidate): string {
  const payloadJson = safeJson(event.payload, MAX_EVENT_PAYLOAD_CHARS);
  const recommendedEvidenceTools = candidate.detailType.startsWith('assistant_security_')
    ? 'Start with assistant_security_summary and assistant_security_findings to confirm the latest scan posture and open findings.'
    : candidate.detailType.startsWith('intel_')
      ? 'Start with intel_summary and intel_findings to confirm the latest threat-intel posture and queue.'
      : 'Start with the most relevant read-only security tools for this signal before widening the investigation.';
  return [
    'Investigate this security event as the dedicated Security Triage Agent.',
    'Relevant skills when useful: host-firewall-defense, native-av-management, security-mode-escalation, security-alert-hygiene, security-response-automation, browser-session-defense.',
    'Use read-only security tools first. Do not acknowledge, resolve, suppress, run scans, or perform other mutating actions unless a human explicitly asks.',
    recommendedEvidenceTools,
    'Your goals are to decide whether this is likely benign noise, a real defensive issue, or an active incident; gather corroborating evidence; and recommend the right operating mode and next step.',
    '',
    `Trigger source: ${candidate.sourceLabel}`,
    `Trigger event type: ${event.type}`,
    `Trigger detail type: ${candidate.detailType}`,
    `Trigger description: ${candidate.description}`,
    '',
    'Trigger payload:',
    payloadJson,
    '',
    'Return a concise triage with:',
    '1. Assessment',
    '2. Corroborating evidence',
    '3. Recommended operating mode',
    '4. Immediate next action',
  ].join('\n');
}

function extractDetailType(payload: Record<string, unknown>): string {
  const direct = asRecord(payload.details);
  return asString(direct.triggerDetailType)
    || asString(direct.alertType)
    || asString(direct.anomalyType)
    || asString(direct.type)
    || asString(direct.matchedAction)
    || normalizeDetailType(asString(direct.reason))
    || asString(direct.actionType)
    || '';
}

function normalizeDetailType(value: string): string {
  return /^[a-z0-9_:-]+$/i.test(value) ? value : '';
}

function isExpectedGuardrailDenial(
  sourceEventType: string,
  detailType: string,
  details: Record<string, unknown>,
): boolean {
  if (sourceEventType !== 'action_denied') return false;
  const source = asString(details.source);
  const matchedAction = asString(details.matchedAction);
  if (source === 'containment_service') {
    return true;
  }
  return isExpectedGuardrailSecurityDetailType(detailType) || isExpectedGuardrailSecurityDetailType(matchedAction);
}

function isSecurityTriageSelfNotification(
  sourceEventType: string,
  payload: Record<string, unknown>,
  details: Record<string, unknown>,
): boolean {
  if (sourceEventType !== 'agent_error' && sourceEventType !== 'agent_stalled') {
    return false;
  }
  const agentId = asString(payload.agentId);
  if (isSecurityTriageAgentId(agentId)) {
    return true;
  }
  const triageAgentId = asString(details.triageAgentId);
  return isSecurityTriageAgentId(triageAgentId);
}

function isSecurityTriageAgentId(agentId: string): boolean {
  return agentId === SECURITY_TRIAGE_AGENT_ID || agentId === SECURITY_TRIAGE_DISPATCHER_AGENT_ID;
}

function toAuditSeverity(value: unknown): AuditSeverity {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'high' || normalized === 'medium' || normalized === 'warn' || normalized === 'warning') return 'warn';
  return 'info';
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? 'null';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 24))}\n... [truncated]`;
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function isInteractiveSecurityCheckSource(source: string): boolean {
  return source.startsWith('web:') || source.startsWith('tool:');
}
