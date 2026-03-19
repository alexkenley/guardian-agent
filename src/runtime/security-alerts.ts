import type { NetworkAlert, NetworkBaselineService, NetworkAnomalySeverity } from './network-baseline.js';
import type { HostMonitoringService, HostMonitorAlert } from './host-monitor.js';
import type { GatewayFirewallMonitoringService, GatewayMonitorAlert } from './gateway-monitor.js';
import type { WindowsDefenderProvider, WindowsDefenderAlert } from './windows-defender-provider.js';
import type { SecurityAlertLifecycle, SecurityAlertStateResult } from './security-alert-lifecycle.js';

export type SecurityAlertSource = 'host' | 'network' | 'gateway' | 'native';
export type SecurityAlertSeverity = NetworkAnomalySeverity;

export interface UnifiedSecurityAlert extends SecurityAlertLifecycle {
  id: string;
  source: SecurityAlertSource;
  type: string;
  severity: SecurityAlertSeverity;
  timestamp: number;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
  subject: string;
}

export interface UnifiedSecurityAlertAcknowledgeResult {
  success: boolean;
  source?: SecurityAlertSource;
  message: string;
}

export interface UnifiedSecurityAlertStateResult extends SecurityAlertStateResult {
  source?: SecurityAlertSource;
}

export const SECURITY_ALERT_SOURCES: readonly SecurityAlertSource[] = ['host', 'network', 'gateway', 'native'];
export const SECURITY_ALERT_SEVERITIES: readonly SecurityAlertSeverity[] = ['low', 'medium', 'high', 'critical'];

export function isSecurityAlertSource(value: string): value is SecurityAlertSource {
  return SECURITY_ALERT_SOURCES.includes(value as SecurityAlertSource);
}

export function isSecurityAlertSeverity(value: string): value is SecurityAlertSeverity {
  return SECURITY_ALERT_SEVERITIES.includes(value as SecurityAlertSeverity);
}

export function normalizeSecurityAlertSeverity(value: unknown): SecurityAlertSeverity | undefined {
  const severity = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return severity && isSecurityAlertSeverity(severity) ? severity : undefined;
}

export function normalizeSecurityAlertSources(source: unknown, sources: unknown): SecurityAlertSource[] {
  const rawValues = [
    typeof source === 'string' ? source : '',
    ...(Array.isArray(sources) ? sources : []).filter((item): item is string => typeof item === 'string'),
  ];
  return [...new Set(rawValues
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is SecurityAlertSource => isSecurityAlertSource(value)))];
}

export function collectUnifiedSecurityAlerts(input: {
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
  includeAcknowledged: boolean;
  includeInactive?: boolean;
}): UnifiedSecurityAlert[] {
  const alerts: UnifiedSecurityAlert[] = [];
  if (input.hostMonitor) {
    alerts.push(...input.hostMonitor.listAlerts({
      includeAcknowledged: input.includeAcknowledged,
      includeInactive: input.includeInactive,
      limit: 500,
    }).map(toUnifiedHostAlert));
  }
  if (input.networkBaseline) {
    alerts.push(...input.networkBaseline.listAlerts({
      includeAcknowledged: input.includeAcknowledged,
      includeInactive: input.includeInactive,
      limit: 500,
    }).map(toUnifiedNetworkAlert));
  }
  if (input.gatewayMonitor) {
    alerts.push(...input.gatewayMonitor.listAlerts({
      includeAcknowledged: input.includeAcknowledged,
      includeInactive: input.includeInactive,
      limit: 500,
    }).map(toUnifiedGatewayAlert));
  }
  if (input.windowsDefender) {
    alerts.push(...input.windowsDefender.listAlerts({
      includeAcknowledged: input.includeAcknowledged,
      includeInactive: input.includeInactive,
      limit: 500,
    }).map(toUnifiedNativeAlert));
  }
  return alerts;
}

export function availableSecurityAlertSources(options: {
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
}): SecurityAlertSource[] {
  const sources: SecurityAlertSource[] = [];
  if (options.hostMonitor) sources.push('host');
  if (options.networkBaseline) sources.push('network');
  if (options.gatewayMonitor) sources.push('gateway');
  if (options.windowsDefender) sources.push('native');
  return sources;
}

export function acknowledgeUnifiedSecurityAlert(input: {
  alertId: string;
  source?: SecurityAlertSource;
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
}): UnifiedSecurityAlertAcknowledgeResult {
  return updateUnifiedSecurityAlertState(input, 'acknowledge');
}

export function resolveUnifiedSecurityAlert(input: {
  alertId: string;
  reason?: string;
  source?: SecurityAlertSource;
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
}): UnifiedSecurityAlertStateResult {
  return updateUnifiedSecurityAlertState(input, 'resolve');
}

export function suppressUnifiedSecurityAlert(input: {
  alertId: string;
  suppressedUntil: number;
  reason?: string;
  source?: SecurityAlertSource;
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
}): UnifiedSecurityAlertStateResult {
  return updateUnifiedSecurityAlertState(input, 'suppress');
}

function updateUnifiedSecurityAlertState(input: {
  alertId: string;
  source?: SecurityAlertSource;
  reason?: string;
  suppressedUntil?: number;
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
}, action: 'acknowledge' | 'resolve' | 'suppress'): UnifiedSecurityAlertStateResult {
  const candidates: Array<{
    source: SecurityAlertSource;
    service?: {
      acknowledgeAlert?: (alertId: string) => SecurityAlertStateResult;
      resolveAlert?: (alertId: string, reason?: string) => SecurityAlertStateResult;
      suppressAlert?: (alertId: string, until: number, reason?: string) => SecurityAlertStateResult;
    };
  }> = input.source
    ? [{
      source: input.source,
      service: input.source === 'host'
        ? input.hostMonitor
        : input.source === 'network'
          ? input.networkBaseline
          : input.source === 'gateway'
            ? input.gatewayMonitor
            : input.windowsDefender,
    }]
    : [
      { source: 'host', service: input.hostMonitor },
      { source: 'network', service: input.networkBaseline },
      { source: 'gateway', service: input.gatewayMonitor },
      { source: 'native', service: input.windowsDefender },
    ];

  let unavailableCount = 0;
  for (const candidate of candidates) {
    if (!candidate.service) {
      unavailableCount += 1;
      continue;
    }
    const result = action === 'acknowledge'
      ? candidate.service.acknowledgeAlert?.(input.alertId)
      : action === 'resolve'
        ? candidate.service.resolveAlert?.(input.alertId, input.reason)
        : candidate.service.suppressAlert?.(input.alertId, input.suppressedUntil ?? 0, input.reason);
    if (!result) {
      unavailableCount += 1;
      continue;
    }
    if (result.success) {
      return {
        success: true,
        source: candidate.source,
        message: result.message,
      };
    }
    if (!/not found/i.test(result.message)) {
      return {
        success: false,
        source: candidate.source,
        message: result.message,
      };
    }
  }

  if (unavailableCount === candidates.length) {
    return {
      success: false,
      message: 'No security alert sources are available.',
    };
  }
  return {
    success: false,
    message: `Alert '${input.alertId}' not found in available security sources.`,
  };
}

export function matchesSecurityAlertQuery(alert: UnifiedSecurityAlert, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    alert.source,
    alert.type,
    alert.severity,
    alert.status,
    alert.subject,
    alert.description,
    JSON.stringify(alert.evidence ?? {}),
  ].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function toUnifiedHostAlert(alert: HostMonitorAlert): UnifiedSecurityAlert {
  return {
    id: alert.id,
    source: 'host',
    type: alert.type,
    severity: alert.severity,
    timestamp: alert.timestamp,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrenceCount: alert.occurrenceCount,
    description: alert.description,
    dedupeKey: alert.dedupeKey,
    evidence: alert.evidence,
    subject: inferSubjectFromEvidence(alert.evidence),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function toUnifiedNetworkAlert(alert: NetworkAlert): UnifiedSecurityAlert {
  return {
    id: alert.id,
    source: 'network',
    type: alert.type,
    severity: alert.severity,
    timestamp: alert.timestamp,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrenceCount: alert.occurrenceCount,
    description: alert.description,
    dedupeKey: alert.dedupeKey,
    evidence: alert.evidence,
    subject: alert.ip || alert.mac || inferSubjectFromEvidence(alert.evidence),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function toUnifiedGatewayAlert(alert: GatewayMonitorAlert): UnifiedSecurityAlert {
  return {
    id: alert.id,
    source: 'gateway',
    type: alert.type,
    severity: alert.severity,
    timestamp: alert.timestamp,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrenceCount: alert.occurrenceCount,
    description: alert.description,
    dedupeKey: alert.dedupeKey,
    evidence: alert.evidence,
    subject: alert.targetName || alert.targetId || inferSubjectFromEvidence(alert.evidence),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function toUnifiedNativeAlert(alert: WindowsDefenderAlert): UnifiedSecurityAlert {
  return {
    id: alert.id,
    source: 'native',
    type: alert.type,
    severity: alert.severity,
    timestamp: alert.timestamp,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrenceCount: alert.occurrenceCount,
    description: alert.description,
    dedupeKey: alert.dedupeKey,
    evidence: alert.evidence,
    subject: inferNativeSubject(alert),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function inferNativeSubject(alert: WindowsDefenderAlert): string {
  const threatName = typeof alert.evidence?.threatName === 'string' ? alert.evidence.threatName.trim() : '';
  if (threatName) return threatName;
  const resources = Array.isArray(alert.evidence?.resources) ? alert.evidence.resources : [];
  const firstResource = resources.find((item) => typeof item === 'string' && item.trim());
  if (typeof firstResource === 'string') return firstResource.trim();
  return 'Windows Defender';
}

function inferSubjectFromEvidence(evidence: Record<string, unknown>): string {
  const scalarKeys = [
    'path',
    'name',
    'remoteAddress',
    'entry',
    'targetName',
    'targetId',
    'ip',
    'mac',
    'vendor',
    'hostname',
  ];
  for (const key of scalarKeys) {
    const value = evidence[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (typeof evidence.port === 'number' && Number.isFinite(evidence.port)) {
    return `port ${evidence.port}`;
  }
  if (Array.isArray(evidence.macs) && evidence.macs.length > 0) {
    return String(evidence.macs[0]);
  }
  if (Array.isArray(evidence.portForwards) && evidence.portForwards.length > 0) {
    return String(evidence.portForwards[0]);
  }
  if (typeof evidence.summary === 'string' && evidence.summary.trim()) {
    return evidence.summary.trim();
  }
  return '-';
}
