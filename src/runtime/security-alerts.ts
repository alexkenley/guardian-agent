import type { NetworkAlert, NetworkBaselineService, NetworkAnomalySeverity } from './network-baseline.js';
import type { HostMonitoringService, HostMonitorAlert } from './host-monitor.js';
import type { GatewayFirewallMonitoringService, GatewayMonitorAlert } from './gateway-monitor.js';
import type { WindowsDefenderProvider, WindowsDefenderAlert } from './windows-defender-provider.js';
import {
  isSecurityAlertVisible,
  type SecurityAlertLifecycle,
  type SecurityAlertStateResult,
} from './security-alert-lifecycle.js';
import {
  isAiSecurityFindingPromotedToSecurityLog,
  type AiSecurityFinding,
  type AiSecurityService,
} from './ai-security.js';
import type { PackageInstallTrustAlert, PackageInstallTrustService } from './package-install-trust-service.js';

export type SecurityAlertSource = 'host' | 'network' | 'gateway' | 'native' | 'assistant' | 'install';
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
  confidence: number;
  recommendedAction: string;
}

export interface UnifiedSecurityAlertAcknowledgeResult {
  success: boolean;
  source?: SecurityAlertSource;
  message: string;
}

export interface UnifiedSecurityAlertStateResult extends SecurityAlertStateResult {
  source?: SecurityAlertSource;
}

export type AssistantSecurityAlertVisibility = 'all' | 'promoted_only';

export const SECURITY_ALERT_SOURCES: readonly SecurityAlertSource[] = ['host', 'network', 'gateway', 'native', 'assistant', 'install'];
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
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
  includeAcknowledged: boolean;
  includeInactive?: boolean;
  assistantVisibility?: AssistantSecurityAlertVisibility;
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
  if (input.assistantSecurity) {
    const now = Date.now();
    alerts.push(...input.assistantSecurity
      .listFindings(500)
      .filter((finding) => input.assistantVisibility !== 'promoted_only' || isAiSecurityFindingPromotedToSecurityLog(finding))
      .map(toUnifiedAssistantAlert)
      .filter((alert) => isSecurityAlertVisible(alert, now, {
        includeAcknowledged: input.includeAcknowledged,
        includeInactive: input.includeInactive,
      })));
  }
  if (input.packageInstallTrust) {
    alerts.push(...input.packageInstallTrust.listAlerts({
      includeAcknowledged: input.includeAcknowledged,
      includeInactive: input.includeInactive,
      limit: 500,
    }).map(toUnifiedInstallAlert));
  }
  return alerts;
}

export function availableSecurityAlertSources(options: {
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
}): SecurityAlertSource[] {
  const sources: SecurityAlertSource[] = [];
  if (options.hostMonitor) sources.push('host');
  if (options.networkBaseline) sources.push('network');
  if (options.gatewayMonitor) sources.push('gateway');
  if (options.windowsDefender) sources.push('native');
  if (options.assistantSecurity) sources.push('assistant');
  if (options.packageInstallTrust) sources.push('install');
  return sources;
}

export function acknowledgeUnifiedSecurityAlert(input: {
  alertId: string;
  source?: SecurityAlertSource;
  hostMonitor?: HostMonitoringService;
  networkBaseline?: NetworkBaselineService;
  gatewayMonitor?: GatewayFirewallMonitoringService;
  windowsDefender?: WindowsDefenderProvider;
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
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
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
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
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
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
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
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
            : input.source === 'native'
              ? input.windowsDefender
              : input.source === 'assistant'
                ? createAssistantSecurityAlertAdapter(input.assistantSecurity)
                : input.packageInstallTrust,
    }]
    : [
      { source: 'host', service: input.hostMonitor },
      { source: 'network', service: input.networkBaseline },
      { source: 'gateway', service: input.gatewayMonitor },
      { source: 'native', service: input.windowsDefender },
      { source: 'assistant', service: createAssistantSecurityAlertAdapter(input.assistantSecurity) },
      { source: 'install', service: input.packageInstallTrust },
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
    confidence: inferSecurityAlertConfidence(alert.severity, alert.evidence),
    recommendedAction: recommendSecurityAlertAction({
      source: 'host',
      type: alert.type,
      severity: alert.severity,
    }),
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
    confidence: inferSecurityAlertConfidence(alert.severity, alert.evidence),
    recommendedAction: recommendSecurityAlertAction({
      source: 'network',
      type: alert.type,
      severity: alert.severity,
    }),
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
    confidence: inferSecurityAlertConfidence(alert.severity, alert.evidence),
    recommendedAction: recommendSecurityAlertAction({
      source: 'gateway',
      type: alert.type,
      severity: alert.severity,
    }),
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
    confidence: inferSecurityAlertConfidence(alert.severity, alert.evidence),
    recommendedAction: recommendSecurityAlertAction({
      source: 'native',
      type: alert.type,
      severity: alert.severity,
    }),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function toUnifiedAssistantAlert(finding: AiSecurityFinding): UnifiedSecurityAlert {
  const lifecycle = mapAssistantFindingStatus(finding.status);
  return {
    id: finding.id,
    source: 'assistant',
    type: `assistant_security_${finding.category}`,
    severity: finding.severity,
    timestamp: finding.lastSeenAt,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    occurrenceCount: finding.occurrenceCount,
    description: `${finding.title}: ${finding.summary}`,
    dedupeKey: finding.dedupeKey,
    evidence: {
      findingId: finding.id,
      targetId: finding.targetId,
      targetLabel: finding.targetLabel,
      category: finding.category,
      confidence: finding.confidence,
      alertSemantics: finding.alertSemantics,
      evidence: finding.evidence,
    },
    subject: finding.targetLabel,
    confidence: normalizeSecurityAlertConfidence(finding.confidence, finding.severity),
    recommendedAction: recommendSecurityAlertAction({
      source: 'assistant',
      type: `assistant_security_${finding.category}`,
      severity: finding.severity,
    }),
    acknowledged: lifecycle.acknowledged,
    status: lifecycle.status,
    lastStateChangedAt: finding.lastSeenAt,
    suppressedUntil: lifecycle.suppressedUntil,
    suppressionReason: lifecycle.suppressionReason,
    resolvedAt: lifecycle.resolvedAt,
    resolutionReason: lifecycle.resolutionReason,
  };
}

function toUnifiedInstallAlert(alert: PackageInstallTrustAlert): UnifiedSecurityAlert {
  return {
    id: alert.id,
    source: 'install',
    type: alert.type,
    severity: alert.severity,
    timestamp: alert.timestamp,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrenceCount: alert.occurrenceCount,
    description: alert.description,
    dedupeKey: alert.dedupeKey,
    evidence: alert.evidence,
    subject: alert.subject,
    confidence: inferSecurityAlertConfidence(alert.severity, alert.evidence),
    recommendedAction: recommendSecurityAlertAction({
      source: 'install',
      type: alert.type,
      severity: alert.severity,
    }),
    acknowledged: alert.acknowledged,
    status: alert.status,
    lastStateChangedAt: alert.lastStateChangedAt,
    suppressedUntil: alert.suppressedUntil,
    suppressionReason: alert.suppressionReason,
    resolvedAt: alert.resolvedAt,
    resolutionReason: alert.resolutionReason,
  };
}

function createAssistantSecurityAlertAdapter(service?: AiSecurityService): {
  acknowledgeAlert?: (alertId: string) => SecurityAlertStateResult;
  resolveAlert?: (alertId: string, reason?: string) => SecurityAlertStateResult;
  suppressAlert?: (alertId: string, until: number, reason?: string) => SecurityAlertStateResult;
} | undefined {
  if (!service) return undefined;
  return {
    acknowledgeAlert: (alertId: string) => service.updateFindingStatus(alertId, 'triaged'),
    resolveAlert: (alertId: string) => service.updateFindingStatus(alertId, 'resolved'),
    suppressAlert: (alertId: string) => service.updateFindingStatus(alertId, 'suppressed'),
  };
}

function mapAssistantFindingStatus(status: AiSecurityFinding['status']): SecurityAlertLifecycle {
  if (status === 'triaged') {
    return {
      acknowledged: true,
      status: 'acknowledged',
      lastStateChangedAt: 0,
    };
  }
  if (status === 'resolved') {
    return {
      acknowledged: false,
      status: 'resolved',
      lastStateChangedAt: 0,
      resolvedAt: 0,
    };
  }
  if (status === 'suppressed') {
    return {
      acknowledged: false,
      status: 'suppressed',
      lastStateChangedAt: 0,
    };
  }
  return {
    acknowledged: false,
    status: 'active',
    lastStateChangedAt: 0,
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

function inferSecurityAlertConfidence(severity: SecurityAlertSeverity, evidence: Record<string, unknown>): number {
  const explicitConfidence = evidence['confidence'];
  return normalizeSecurityAlertConfidence(
    typeof explicitConfidence === 'number' ? explicitConfidence : undefined,
    severity,
  );
}

function normalizeSecurityAlertConfidence(confidence: number | undefined, severity: SecurityAlertSeverity): number {
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
  }
  switch (severity) {
    case 'critical': return 0.95;
    case 'high': return 0.85;
    case 'medium': return 0.65;
    default: return 0.45;
  }
}

function recommendSecurityAlertAction(alert: {
  source: SecurityAlertSource;
  type: string;
  severity: SecurityAlertSeverity;
}): string {
  switch (alert.type) {
    case 'defender_threat_detected':
      return 'Confirm Defender remediation status, inspect affected resources, and keep the alert active until containment or cleanup is verified.';
    case 'defender_realtime_protection_disabled':
    case 'defender_antivirus_disabled':
    case 'defender_firewall_profile_disabled':
    case 'firewall_disabled':
    case 'gateway_firewall_disabled':
      return 'Restore the disabled protection boundary or document the approved maintenance reason before resolving the alert.';
    case 'defender_signatures_stale':
    case 'defender_status_unavailable':
      return 'Refresh native security-provider status and restore detection visibility before lowering attention.';
    case 'suspicious_process':
    case 'persistence_change':
      return 'Inspect process, signer, path, parent activity, and related persistence evidence before acknowledging.';
    case 'sensitive_path_change':
      return 'Confirm the changed path is expected and correlate nearby audit or policy events before resolving.';
    case 'new_external_destination':
    case 'beaconing':
    case 'data_exfiltration':
      return 'Identify the source process and destination reputation, then correlate with host or gateway evidence.';
    case 'new_listening_port':
    case 'port_change':
    case 'mass_port_open':
    case 'unusual_service':
      return 'Identify the owner of the exposed service and verify the exposure matches an approved workflow.';
    case 'firewall_change':
    case 'gateway_firewall_change':
    case 'gateway_port_forward_change':
    case 'gateway_admin_change':
      return 'Review the exact policy or admin delta and confirm who authorized the perimeter change.';
    case 'arp_conflict':
      return 'Corroborate the address conflict with gateway, DHCP, and host evidence before escalating incident mode.';
    case 'new_device':
    case 'device_gone':
      return 'Validate the asset identity and expected presence before acknowledging the inventory change.';
    default:
      if (alert.source === 'assistant' || alert.type.startsWith('assistant_security_')) {
        return 'Review the Assistant Security finding target, evidence, confidence, and containment state before triage.';
      }
      if (alert.source === 'install' || alert.type.startsWith('package_install_')) {
        return 'Review package trust evidence and approve or resolve only after the install risk is explained.';
      }
      if (alert.severity === 'critical' || alert.severity === 'high') {
        return 'Review evidence, correlate related alerts, and resolve only after the condition is explained or remediated.';
      }
      if (alert.severity === 'medium') {
        return 'Confirm whether the condition persists and acknowledge or resolve after review.';
      }
      return 'Monitor for repeats and acknowledge if the signal is expected.';
  }
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
