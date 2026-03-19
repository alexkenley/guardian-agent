import type { SecurityAlertSeverity, SecurityAlertSource } from './security-alerts.js';
import type { SecurityAlertStatus } from './security-alert-lifecycle.js';
import {
  DEPLOYMENT_PROFILES,
  SECURITY_OPERATING_MODES,
  type DeploymentProfile,
  type SecurityOperatingMode,
  isDeploymentProfile,
  isSecurityOperatingMode,
} from './security-controls.js';

export type SecurityPostureSource = SecurityAlertSource;
export type SecurityPostureSeverity = SecurityAlertSeverity;

export interface SecurityPostureAlert {
  id: string;
  source: SecurityPostureSource;
  type: string;
  severity: SecurityPostureSeverity;
  description: string;
  timestamp?: number;
  acknowledged?: boolean;
  status?: SecurityAlertStatus;
}

export interface SecurityPostureAssessmentInput {
  profile: DeploymentProfile;
  currentMode: SecurityOperatingMode;
  alerts: SecurityPostureAlert[];
  availableSources?: SecurityPostureSource[];
}

export interface SecurityPostureAssessment {
  profile: DeploymentProfile;
  currentMode: SecurityOperatingMode;
  recommendedMode: SecurityOperatingMode;
  shouldEscalate: boolean;
  summary: string;
  reasons: string[];
  counts: {
    total: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  bySource: Record<SecurityPostureSource, number>;
  availableSources: SecurityPostureSource[];
  topAlerts: SecurityPostureAlert[];
}

const MODE_RANK: Record<SecurityOperatingMode, number> = {
  monitor: 0,
  guarded: 1,
  ir_assist: 2,
  lockdown: 3,
};

const LOCKDOWN_ALERT_TYPES = new Set<string>([
  'firewall_disabled',
  'gateway_firewall_disabled',
  'data_exfiltration',
  'lateral_movement',
  'defender_antivirus_disabled',
  'defender_realtime_protection_disabled',
  'defender_firewall_profile_disabled',
]);

const IR_ASSIST_ALERT_TYPES = new Set<string>([
  'beaconing',
  'port_scanning',
  'gateway_admin_change',
  'suspicious_process',
  'defender_threat_detected',
]);

const LOW_CONFIDENCE_MEDIUM_ALERT_TYPES = new Set<string>([
  'new_external_destination',
  'new_listening_port',
  'sensitive_path_change',
  'firewall_change',
  'defender_controlled_folder_access_disabled',
]);

export { DEPLOYMENT_PROFILES, SECURITY_OPERATING_MODES, isDeploymentProfile, isSecurityOperatingMode };
export type { DeploymentProfile, SecurityOperatingMode };

export function assessSecurityPosture(input: SecurityPostureAssessmentInput): SecurityPostureAssessment {
  const activeAlerts = input.alerts
    .filter((alert) => (alert.status ?? (alert.acknowledged ? 'acknowledged' : 'active')) === 'active')
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.timestamp ?? 0) - (a.timestamp ?? 0));

  const counts = {
    total: activeAlerts.length,
    low: activeAlerts.filter((alert) => alert.severity === 'low').length,
    medium: activeAlerts.filter((alert) => alert.severity === 'medium').length,
    high: activeAlerts.filter((alert) => alert.severity === 'high').length,
    critical: activeAlerts.filter((alert) => alert.severity === 'critical').length,
  };
  const bySource: Record<SecurityPostureSource, number> = { host: 0, network: 0, gateway: 0, native: 0 };
  for (const alert of activeAlerts) {
    bySource[alert.source] += 1;
  }

  const availableSources = [...new Set((input.availableSources ?? activeAlerts.map((alert) => alert.source)).filter(Boolean))]
    .filter((value): value is SecurityPostureSource => value === 'host' || value === 'network' || value === 'gateway' || value === 'native');

  const criticalAlerts = activeAlerts.filter((alert) => alert.severity === 'critical');
  const highAlerts = activeAlerts.filter((alert) => alert.severity === 'high');
  const mediumAlerts = activeAlerts.filter((alert) => alert.severity === 'medium');
  const actionableMediumAlerts = mediumAlerts.filter((alert) => !LOW_CONFIDENCE_MEDIUM_ALERT_TYPES.has(alert.type));
  const reasons: string[] = [];

  let recommendedMode: SecurityOperatingMode = 'monitor';
  if (criticalAlerts.length > 0) {
    const lockdownCandidate = criticalAlerts.some((alert) => LOCKDOWN_ALERT_TYPES.has(alert.type))
      || new Set(criticalAlerts.map((alert) => alert.source)).size >= 2;
    if (lockdownCandidate) {
      recommendedMode = 'lockdown';
      reasons.push('Critical alerts indicate a likely active incident or weakened protection boundary.');
    } else {
      recommendedMode = 'ir_assist';
      reasons.push('A critical alert is active and warrants operator-led investigation.');
    }
  } else if (highAlerts.length >= 2 || (highAlerts.length >= 1 && new Set(activeAlerts.map((alert) => alert.source)).size >= 2)) {
    recommendedMode = 'guarded';
    reasons.push('Multiple elevated alerts suggest raising controls while preserving normal operation where possible.');
  } else if (highAlerts.length === 1) {
    recommendedMode = 'guarded';
    reasons.push('A high-severity alert is active and should tighten approvals and outbound actions.');
  } else if (actionableMediumAlerts.length >= 2 && new Set(actionableMediumAlerts.map((alert) => alert.source)).size >= 2) {
    recommendedMode = 'guarded';
    reasons.push('Medium-severity alerts across multiple sources suggest a broader issue than a single noisy signal.');
  }

  if (recommendedMode === 'monitor' && activeAlerts.length === 0) {
    reasons.push('No active alerts currently justify tighter controls.');
  }
  if (recommendedMode === 'ir_assist' && criticalAlerts.some((alert) => IR_ASSIST_ALERT_TYPES.has(alert.type))) {
    reasons.push('The active signal pattern fits investigation-oriented response rather than immediate full lockdown.');
  }
  if (availableSources.length === 0) {
    reasons.push('No alert sources are currently available, so recommendations are based on limited visibility.');
  }

  const shouldEscalate = MODE_RANK[recommendedMode] > MODE_RANK[input.currentMode];
  const summary = buildSummary({
    currentMode: input.currentMode,
    recommendedMode,
    shouldEscalate,
    counts,
    profile: input.profile,
  });

  return {
    profile: input.profile,
    currentMode: input.currentMode,
    recommendedMode,
    shouldEscalate,
    summary,
    reasons,
    counts,
    bySource,
    availableSources,
    topAlerts: activeAlerts.slice(0, 5),
  };
}

function severityRank(severity: SecurityPostureSeverity): number {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function buildSummary(input: {
  profile: DeploymentProfile;
  currentMode: SecurityOperatingMode;
  recommendedMode: SecurityOperatingMode;
  shouldEscalate: boolean;
  counts: SecurityPostureAssessment['counts'];
}): string {
  const { currentMode, recommendedMode, shouldEscalate, counts, profile } = input;
  if (counts.total === 0) {
    return `Profile '${profile}' has no active alerts. Stay in '${currentMode}'.`;
  }
  if (!shouldEscalate) {
    return `Profile '${profile}' has ${counts.total} active alerts. Current mode '${currentMode}' is already at or above the recommended posture.`;
  }
  return `Profile '${profile}' has ${counts.total} active alerts. Escalate from '${currentMode}' to '${recommendedMode}'.`;
}
