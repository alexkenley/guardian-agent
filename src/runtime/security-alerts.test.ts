import { describe, expect, it } from 'vitest';
import { AiSecurityService, type AiSecurityFinding, type AiSecurityRuntimeSnapshot } from './ai-security.js';
import type { PackageInstallTrustAlert } from './package-install-trust-service.js';
import {
  acknowledgeUnifiedSecurityAlert,
  availableSecurityAlertSources,
  collectUnifiedSecurityAlerts,
  resolveUnifiedSecurityAlert,
  suppressUnifiedSecurityAlert,
} from './security-alerts.js';

function createRuntimeSnapshot(overrides?: Partial<AiSecurityRuntimeSnapshot>): AiSecurityRuntimeSnapshot {
  return {
    sandbox: {
      enabled: true,
      availability: 'degraded',
      enforcementMode: 'permissive',
      backend: 'bubblewrap',
      degradedFallbackActive: true,
      degradedFallback: {
        allowNetworkTools: true,
        allowBrowserTools: true,
        allowMcpServers: false,
        allowPackageManagers: false,
        allowManualCodeTerminals: true,
      },
      ...(overrides?.sandbox ?? {}),
    },
    browser: {
      enabled: true,
      allowedDomains: [],
      playwrightEnabled: true,
      ...(overrides?.browser ?? {}),
    },
    mcp: {
      enabled: true,
      configuredThirdPartyServerCount: 1,
      connectedThirdPartyServerCount: 1,
      managedProviderIds: [],
      usesDynamicPlaywrightPackage: false,
      thirdPartyServers: [{
        id: 'dangerous-server',
        name: 'Dangerous Server',
        command: 'dangerous-mcp',
        trustLevel: 'read_only',
        startupApproved: true,
        networkAccess: true,
        inheritEnv: true,
        allowedEnvKeyCount: 3,
        envKeyCount: 1,
        connected: true,
      }],
      ...(overrides?.mcp ?? {}),
    },
    agentPolicyUpdates: {
      allowedPaths: true,
      allowedCommands: false,
      allowedDomains: true,
      toolPolicies: false,
      ...(overrides?.agentPolicyUpdates ?? {}),
    },
  };
}

function createAssistantFinding(overrides: Partial<AiSecurityFinding>): AiSecurityFinding {
  return {
    id: 'assistant-finding',
    dedupeKey: 'assistant:finding',
    targetId: 'workspace:demo',
    targetType: 'workspace',
    targetLabel: 'Demo Workspace',
    category: 'workspace',
    severity: 'medium',
    confidence: 0.8,
    alertSemantics: 'posture_only',
    status: 'new',
    title: 'Assistant Security finding',
    summary: 'Assistant Security summary',
    firstSeenAt: 5_000,
    lastSeenAt: 5_000,
    occurrenceCount: 1,
    evidence: [{
      kind: 'workspace',
      summary: 'workspace evidence',
    }],
    ...overrides,
  };
}

async function createAssistantSecurityService() {
  const service = new AiSecurityService({
    enabled: true,
    getRuntimeSnapshot: () => createRuntimeSnapshot(),
    listCodeSessions: () => [],
    now: () => 5_000,
  });
  await service.scan({ profileId: 'runtime-hardening' });
  return service;
}

describe('security alert integration', () => {
  it('collects Assistant Security findings as unified alerts', async () => {
    const assistantSecurity = await createAssistantSecurityService();

    const alerts = collectUnifiedSecurityAlerts({
      assistantSecurity,
      includeAcknowledged: false,
    });

    expect(availableSecurityAlertSources({ assistantSecurity })).toEqual(['assistant']);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((alert) => alert.source === 'assistant')).toBe(true);
    expect(alerts.some((alert) => alert.type.startsWith('assistant_security_'))).toBe(true);
    expect(alerts.some((alert) => alert.evidence?.category === 'mcp')).toBe(true);
    expect(alerts.every((alert) => typeof alert.confidence === 'number')).toBe(true);
    expect(alerts.every((alert) => alert.recommendedAction.includes('Assistant Security'))).toBe(true);
  });

  it('maps triaged Assistant Security findings into acknowledged alert state', async () => {
    const assistantSecurity = await createAssistantSecurityService();
    const findingId = assistantSecurity.listFindings(10)[0]?.id ?? '';

    const result = acknowledgeUnifiedSecurityAlert({
      alertId: findingId,
      source: 'assistant',
      assistantSecurity,
    });

    expect(result.success).toBe(true);

    const activeOnly = collectUnifiedSecurityAlerts({
      assistantSecurity,
      includeAcknowledged: false,
    });
    expect(activeOnly.some((alert) => alert.id === findingId)).toBe(false);

    const withAcknowledged = collectUnifiedSecurityAlerts({
      assistantSecurity,
      includeAcknowledged: true,
    });
    const acknowledged = withAcknowledged.find((alert) => alert.id === findingId);
    expect(acknowledged?.status).toBe('acknowledged');
    expect(acknowledged?.acknowledged).toBe(true);
  });

  it('can scope Assistant Security unified alerts to promoted incident candidates only', () => {
    const assistantSecurity = {
      listFindings: () => [
        createAssistantFinding({
          id: 'assistant-posture-critical',
          severity: 'critical',
          alertSemantics: 'posture_only',
          title: 'Sandbox isolation is disabled',
          category: 'sandbox',
        }),
        createAssistantFinding({
          id: 'assistant-incident-high',
          severity: 'high',
          alertSemantics: 'incident_candidate',
          title: 'Workspace contains prompt injection',
          category: 'trust_boundary',
        }),
        createAssistantFinding({
          id: 'assistant-incident-medium',
          severity: 'medium',
          alertSemantics: 'incident_candidate',
          title: 'Workspace contains encoded exec',
          category: 'trust_boundary',
        }),
      ],
    };

    const alerts = collectUnifiedSecurityAlerts({
      assistantSecurity: assistantSecurity as any,
      includeAcknowledged: false,
      assistantVisibility: 'promoted_only',
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe('assistant-incident-high');
    expect(alerts[0]?.evidence?.alertSemantics).toBe('incident_candidate');
  });

  it('routes resolve and suppress actions through the unified alert state APIs', async () => {
    const assistantSecurity = await createAssistantSecurityService();
    const findings = assistantSecurity.listFindings(10);
    expect(findings.length).toBeGreaterThan(1);
    const resolveId = findings[0]?.id ?? '';
    const suppressId = findings[1]?.id ?? '';

    const resolveResult = resolveUnifiedSecurityAlert({
      alertId: resolveId,
      source: 'assistant',
      reason: 'Resolved during test',
      assistantSecurity,
    });
    const suppressResult = suppressUnifiedSecurityAlert({
      alertId: suppressId,
      source: 'assistant',
      suppressedUntil: Date.now() + 60_000,
      reason: 'Suppressed during test',
      assistantSecurity,
    });

    expect(resolveResult.success).toBe(true);
    expect(suppressResult.success).toBe(true);

    const inactive = collectUnifiedSecurityAlerts({
      assistantSecurity,
      includeAcknowledged: true,
      includeInactive: true,
    });

    expect(inactive.find((alert) => alert.id === resolveId)?.status).toBe('resolved');
    expect(inactive.find((alert) => alert.id === suppressId)?.status).toBe('suppressed');
    expect(assistantSecurity.listFindings(10).find((finding) => finding.id === resolveId)?.status).toBe('resolved');
    expect(assistantSecurity.listFindings(10).find((finding) => finding.id === suppressId)?.status).toBe('suppressed');
  });

  it('collects and updates package-install trust alerts as a unified install source', () => {
    const installAlert: PackageInstallTrustAlert = {
      id: 'install-1',
      type: 'package_install_caution',
      severity: 'high',
      timestamp: 10_000,
      firstSeenAt: 10_000,
      lastSeenAt: 10_000,
      occurrenceCount: 1,
      description: 'Install requires caution review',
      dedupeKey: 'install:1',
      evidence: { packageSpecs: ['left-pad'] },
      subject: 'left-pad',
      acknowledged: false,
      status: 'active',
      lastStateChangedAt: 10_000,
    };
    const installService = {
      listAlerts: () => [installAlert],
      acknowledgeAlert: () => ({ success: true, message: "Alert 'install-1' acknowledged." }),
      resolveAlert: () => ({ success: true, message: "Alert 'install-1' resolved." }),
      suppressAlert: () => ({ success: true, message: "Alert 'install-1' suppressed." }),
    };

    const alerts = collectUnifiedSecurityAlerts({
      packageInstallTrust: installService as any,
      includeAcknowledged: false,
    });

    expect(availableSecurityAlertSources({ packageInstallTrust: installService as any })).toEqual(['install']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe('install');
    expect(alerts[0]?.confidence).toBe(0.85);
    expect(alerts[0]?.recommendedAction).toContain('package trust evidence');

    const acknowledged = acknowledgeUnifiedSecurityAlert({
      alertId: 'install-1',
      source: 'install',
      packageInstallTrust: installService as any,
    });

    expect(acknowledged.success).toBe(true);
  });
});
