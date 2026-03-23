import { describe, expect, it } from 'vitest';
import { AiSecurityService, type AiSecurityRuntimeSnapshot } from './ai-security.js';
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
});
