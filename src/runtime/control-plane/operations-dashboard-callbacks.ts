import type { DashboardCallbacks } from '../../channels/web-types.js';
import type { AssistantConnectorPlaybookDefinition, GuardianAgentConfig } from '../../config/types.js';
import type { AiSecurityService } from '../ai-security.js';
import { materializeBuiltinAutomationExample } from '../builtin-packs.js';
import type { ContainmentService } from '../containment-service.js';
import type { ConnectorPlaybookService } from '../connectors.js';
import type { DeviceInventoryService } from '../device-inventory.js';
import type { GatewayMonitorReport, GatewayFirewallMonitoringService } from '../gateway-monitor.js';
import type { HostMonitorReport, HostMonitoringService } from '../host-monitor.js';
import type { NetworkAnomalyReport, NetworkBaselineService } from '../network-baseline.js';
import type { PackageInstallTrustService } from '../package-install-trust-service.js';
import type { SecurityActivityLogService } from '../security-activity-log.js';
import {
  acknowledgeUnifiedSecurityAlert,
  availableSecurityAlertSources,
  collectUnifiedSecurityAlerts,
  matchesSecurityAlertQuery,
  normalizeSecurityAlertSeverity,
  normalizeSecurityAlertSources,
  resolveUnifiedSecurityAlert,
  suppressUnifiedSecurityAlert,
} from '../security-alerts.js';
import type { SecurityAlertSeverity, SecurityAlertSource } from '../security-alerts.js';
import { isSecurityAlertStatus } from '../security-alert-lifecycle.js';
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  DEFAULT_SECURITY_OPERATING_MODE,
} from '../security-controls.js';
import { assessSecurityPosture } from '../security-posture.js';
import type { WindowsDefenderProvider, WindowsDefenderProviderStatus } from '../windows-defender-provider.js';

export interface ConnectorWorkflowOps {
  upsert: (playbook: AssistantConnectorPlaybookDefinition) => { success: boolean; message: string };
  delete: (playbookId: string) => { success: boolean; message: string };
  run: (input: ConnectorWorkflowRunInput) => Promise<Awaited<ReturnType<ConnectorPlaybookService['runPlaybook']>>>;
}

type OperationsDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onConnectorsState'
  | 'onConnectorsSettingsUpdate'
  | 'onConnectorsPackUpsert'
  | 'onConnectorsPackDelete'
  | 'onNetworkDevices'
  | 'onNetworkScan'
  | 'onNetworkBaseline'
  | 'onNetworkThreats'
  | 'onNetworkThreatAcknowledge'
  | 'onSecurityAlerts'
  | 'onSecurityAlertAcknowledge'
  | 'onSecurityAlertResolve'
  | 'onSecurityAlertSuppress'
  | 'onSecurityPosture'
  | 'onSecurityContainmentStatus'
  | 'onSecurityActivityLog'
  | 'onWindowsDefenderStatus'
  | 'onWindowsDefenderRefresh'
  | 'onWindowsDefenderScan'
  | 'onWindowsDefenderUpdateSignatures'
  | 'onHostMonitorStatus'
  | 'onHostMonitorAlerts'
  | 'onHostMonitorAcknowledge'
  | 'onHostMonitorCheck'
  | 'onGatewayMonitorStatus'
  | 'onGatewayMonitorAlerts'
  | 'onGatewayMonitorAcknowledge'
  | 'onGatewayMonitorCheck'
>;

type ConnectorWorkflowRunInput = {
  playbookId: string;
  dryRun?: boolean;
  origin?: 'assistant' | 'cli' | 'web';
  agentId?: string;
  userId?: string;
  channel?: string;
  requestedBy?: string;
};

interface OperationsDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  connectors: ConnectorPlaybookService;
  deviceInventory: DeviceInventoryService;
  networkBaseline: NetworkBaselineService;
  hostMonitor: HostMonitoringService;
  gatewayMonitor: GatewayFirewallMonitoringService;
  windowsDefender: WindowsDefenderProvider;
  aiSecurity: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
  containmentService: ContainmentService;
  securityActivityLog: SecurityActivityLogService;
  persistConnectorsState: () => { success: boolean; message: string };
  runNetworkAnalysis: (source: string) => NetworkAnomalyReport;
  runHostMonitoring: (source: string) => Promise<HostMonitorReport>;
  runGatewayMonitoring: (source: string) => Promise<GatewayMonitorReport>;
  runWindowsDefenderRefresh: (source: string) => Promise<WindowsDefenderProviderStatus>;
  getSecurityContainmentInputs: () => {
    profile: 'personal' | 'home' | 'organization';
    currentMode: 'monitor' | 'guarded' | 'lockdown' | 'ir_assist';
    alerts: ReturnType<typeof collectUnifiedSecurityAlerts>;
    posture: ReturnType<typeof assessSecurityPosture>;
  };
  trackSystemAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
  trackConnectorRunAnalytics: (
    input: ConnectorWorkflowRunInput,
    result: Awaited<ReturnType<ConnectorPlaybookService['runPlaybook']>>,
  ) => void;
}

export function createOperationsDashboardCallbacks(
  options: OperationsDashboardCallbackOptions,
): {
  connectorWorkflowOps: ConnectorWorkflowOps;
  callbacks: OperationsDashboardCallbacks;
} {
  const connectorWorkflowOps: ConnectorWorkflowOps = {
    upsert: (playbook) => {
      const before = options.connectors.getConfig();
      const result = options.connectors.upsertPlaybook(playbook);
      if (!result.success) return result;
      const persisted = options.persistConnectorsState();
      if (!persisted.success) {
        options.connectors.updateConfig(before);
        return persisted;
      }
      options.trackSystemAnalytics('playbook_upserted', {
        playbookId: playbook.id,
        enabled: String(playbook.enabled),
        mode: playbook.mode,
      });
      return result;
    },

    delete: (playbookId) => {
      const before = options.connectors.getConfig();
      const result = options.connectors.deletePlaybook(playbookId);
      if (!result.success) return result;
      const persisted = options.persistConnectorsState();
      if (!persisted.success) {
        options.connectors.updateConfig(before);
        return persisted;
      }
      options.trackSystemAnalytics('playbook_deleted', { playbookId });
      return result;
    },

    run: async (input) => {
      const result = await options.connectors.runPlaybook({
        playbookId: input.playbookId,
        dryRun: input.dryRun,
        origin: input.origin ?? 'web',
        agentId: input.agentId,
        userId: input.userId,
        channel: input.channel,
        requestedBy: input.requestedBy,
      });
      options.trackConnectorRunAnalytics(input, result);
      if (result.run?.steps) {
        options.deviceInventory.ingestPlaybookResults(result.run.steps);
        const hasNetworkScanSteps = result.run.steps.some((step) =>
          step.toolName === 'net_arp_scan'
          || step.toolName === 'net_port_check'
          || step.toolName === 'net_dns_lookup',
        );
        if (hasNetworkScanSteps) {
          options.runNetworkAnalysis('playbook-run:web');
        }
      }
      return result;
    },
  };

  const collectSecurityAlerts = (args?: {
    includeAcknowledged?: boolean;
    includeInactive?: boolean;
  }) => collectUnifiedSecurityAlerts({
    hostMonitor: options.hostMonitor,
    networkBaseline: options.networkBaseline,
    gatewayMonitor: options.gatewayMonitor,
    windowsDefender: options.windowsDefender,
    assistantSecurity: options.aiSecurity,
    packageInstallTrust: options.packageInstallTrust,
    includeAcknowledged: !!args?.includeAcknowledged,
    includeInactive: !!args?.includeInactive,
  });

  const listAvailableSecuritySources = () => availableSecurityAlertSources({
    hostMonitor: options.hostMonitor,
    networkBaseline: options.networkBaseline,
    gatewayMonitor: options.gatewayMonitor,
    windowsDefender: options.windowsDefender,
    assistantSecurity: options.aiSecurity,
    packageInstallTrust: options.packageInstallTrust,
  });

  return {
    connectorWorkflowOps,
    callbacks: {
      onConnectorsState: ({ limitRuns } = {}) => options.connectors.getState(limitRuns ?? 50),

      onConnectorsSettingsUpdate: (input) => {
        const before = options.connectors.getConfig();
        const result = options.connectors.updateSettings(input);
        if (!result.success) return result;
        const persisted = options.persistConnectorsState();
        if (!persisted.success) {
          options.connectors.updateConfig(before);
          return persisted;
        }

        options.trackSystemAnalytics('connector_settings_updated', {
          enabled: String(input.enabled ?? ''),
          executionMode: input.executionMode ?? '',
        });
        return result;
      },

      onConnectorsPackUpsert: (pack) => {
        const before = options.connectors.getConfig();
        const result = options.connectors.upsertPack(pack);
        if (!result.success) return result;
        const persisted = options.persistConnectorsState();
        if (!persisted.success) {
          options.connectors.updateConfig(before);
          return persisted;
        }

        options.trackSystemAnalytics('connector_pack_upserted', {
          packId: pack.id,
          enabled: String(pack.enabled),
        });
        return result;
      },

      onConnectorsPackDelete: (packId) => {
        const before = options.connectors.getConfig();
        const result = options.connectors.deletePack(packId);
        if (!result.success) return result;
        const persisted = options.persistConnectorsState();
        if (!persisted.success) {
          options.connectors.updateConfig(before);
          return persisted;
        }

        options.trackSystemAnalytics('connector_pack_deleted', { packId });
        return result;
      },

      onNetworkDevices: () => ({
        devices: options.deviceInventory.listDevices(),
      }),

      onNetworkScan: async () => {
        const state = options.connectors.getState();
        const playbook = state.playbooks.find((entry) => entry.id === 'network-discovery');
        if (!playbook) {
          const materialized = materializeBuiltinAutomationExample('home-network', options.connectors);
          if (!materialized.success) {
            return { success: false, message: 'Could not create the Home Network starter example for scanning.', devicesFound: 0 };
          }
          options.persistConnectorsState();
        }
        const result = await options.connectors.runPlaybook({
          playbookId: 'network-discovery',
          origin: 'web',
          userId: 'web-user',
          channel: 'web',
          requestedBy: 'web-user',
        });
        if (result.run?.steps) {
          options.deviceInventory.ingestPlaybookResults(result.run.steps);
        }
        const report = options.runNetworkAnalysis('network-scan:web');
        return {
          success: result.success,
          message: report.anomalies.length > 0
            ? `${result.message} (${report.anomalies.length} network anomalies detected)`
            : result.message,
          devicesFound: options.deviceInventory.size,
          run: result.run,
        };
      },

      onNetworkBaseline: () => options.networkBaseline.getSnapshot(),

      onNetworkThreats: (args) => {
        const includeAcknowledged = !!args?.includeAcknowledged;
        const parsedLimit = Number(args?.limit ?? 100);
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
        const alerts = options.networkBaseline.listAlerts({ includeAcknowledged, limit });
        const bySeverity = {
          low: alerts.filter((alert) => alert.severity === 'low').length,
          medium: alerts.filter((alert) => alert.severity === 'medium').length,
          high: alerts.filter((alert) => alert.severity === 'high').length,
          critical: alerts.filter((alert) => alert.severity === 'critical').length,
        };
        const baseline = options.networkBaseline.getSnapshot();
        return {
          alerts,
          activeAlertCount: alerts.length,
          bySeverity,
          baselineReady: baseline.baselineReady,
          snapshotCount: baseline.snapshotCount,
        };
      },

      onNetworkThreatAcknowledge: (alertId) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        return options.networkBaseline.acknowledgeAlert(alertId.trim());
      },

      onSecurityAlerts: (args) => {
        const includeAcknowledged = !!args?.includeAcknowledged;
        const includeInactive = !!args?.includeInactive;
        const parsedLimit = Number(args?.limit ?? 100);
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        const severity = normalizeSecurityAlertSeverity(args?.severity);
        const status = typeof args?.status === 'string' && isSecurityAlertStatus(args.status)
          ? args.status
          : undefined;
        const typeFilter = typeof args?.type === 'string' ? args.type.trim().toLowerCase() : '';
        const selectedSources = normalizeSecurityAlertSources(args?.source, args?.sources);

        let alerts = collectSecurityAlerts({ includeAcknowledged, includeInactive });
        if (selectedSources.length > 0) {
          const allowed = new Set(selectedSources);
          alerts = alerts.filter((alert) => allowed.has(alert.source));
        }
        if (severity) {
          alerts = alerts.filter((alert) => alert.severity === severity);
        }
        if (status) {
          alerts = alerts.filter((alert) => alert.status === status);
        }
        if (typeFilter) {
          alerts = alerts.filter((alert) => alert.type.toLowerCase() === typeFilter);
        }
        if (query) {
          alerts = alerts.filter((alert) => matchesSecurityAlertQuery(alert, query));
        }

        alerts.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        const bySource: Record<SecurityAlertSource, number> = { host: 0, network: 0, gateway: 0, native: 0, assistant: 0, install: 0 };
        const bySeverity: Record<SecurityAlertSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
        for (const alert of alerts) {
          bySource[alert.source] += 1;
          bySeverity[alert.severity] += 1;
        }

        return {
          alerts: alerts.slice(0, limit),
          totalMatches: alerts.length,
          returned: Math.min(alerts.length, limit),
          searchedSources: selectedSources.length > 0 ? selectedSources : listAvailableSecuritySources(),
          includeAcknowledged,
          includeInactive,
          query: query || undefined,
          severity: severity ?? undefined,
          status,
          type: typeFilter || undefined,
          bySource,
          bySeverity,
        };
      },

      onSecurityAlertAcknowledge: ({ alertId, source }) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        const result = acknowledgeUnifiedSecurityAlert({
          alertId: alertId.trim(),
          source,
          hostMonitor: options.hostMonitor,
          networkBaseline: options.networkBaseline,
          gatewayMonitor: options.gatewayMonitor,
          windowsDefender: options.windowsDefender,
          assistantSecurity: options.aiSecurity,
          packageInstallTrust: options.packageInstallTrust,
        });
        return {
          success: result.success,
          message: result.message,
          source: result.source,
        };
      },

      onSecurityAlertResolve: ({ alertId, source, reason }) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        const result = resolveUnifiedSecurityAlert({
          alertId: alertId.trim(),
          source,
          reason,
          hostMonitor: options.hostMonitor,
          networkBaseline: options.networkBaseline,
          gatewayMonitor: options.gatewayMonitor,
          windowsDefender: options.windowsDefender,
          assistantSecurity: options.aiSecurity,
          packageInstallTrust: options.packageInstallTrust,
        });
        return {
          success: result.success,
          message: result.message,
          source: result.source,
        };
      },

      onSecurityAlertSuppress: ({ alertId, source, suppressedUntil, reason }) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        const result = suppressUnifiedSecurityAlert({
          alertId: alertId.trim(),
          source,
          suppressedUntil,
          reason,
          hostMonitor: options.hostMonitor,
          networkBaseline: options.networkBaseline,
          gatewayMonitor: options.gatewayMonitor,
          windowsDefender: options.windowsDefender,
          assistantSecurity: options.aiSecurity,
          packageInstallTrust: options.packageInstallTrust,
        });
        return {
          success: result.success,
          message: result.message,
          source: result.source,
        };
      },

      onSecurityPosture: (args) => {
        const configuredSecurity = options.configRef.current.assistant.security;
        const profile = args?.profile
          ?? configuredSecurity?.deploymentProfile
          ?? DEFAULT_DEPLOYMENT_PROFILE;
        const currentMode = args?.currentMode
          ?? configuredSecurity?.operatingMode
          ?? DEFAULT_SECURITY_OPERATING_MODE;
        const alerts = collectSecurityAlerts({
          includeAcknowledged: !!args?.includeAcknowledged,
          includeInactive: false,
        });
        return assessSecurityPosture({
          profile,
          currentMode,
          alerts,
          availableSources: listAvailableSecuritySources(),
        });
      },

      onSecurityContainmentStatus: (args) => {
        const base = options.getSecurityContainmentInputs();
        const profile = args?.profile ?? base.profile;
        const currentMode = args?.currentMode ?? base.currentMode;
        const posture = assessSecurityPosture({
          profile,
          currentMode,
          alerts: base.alerts,
          availableSources: listAvailableSecuritySources(),
        });
        return options.containmentService.getState({
          profile,
          currentMode,
          alerts: base.alerts,
          posture,
          assistantAutoContainment: options.configRef.current.assistant.security?.autoContainment,
        });
      },

      onSecurityActivityLog: (args) => {
        const status = typeof args?.status === 'string' ? args.status : undefined;
        return options.securityActivityLog.list({
          limit: args?.limit,
          status,
          agentId: args?.agentId,
        });
      },

      onWindowsDefenderStatus: () => ({
        status: options.windowsDefender.getStatus(),
        alerts: options.windowsDefender.listAlerts({
          includeAcknowledged: true,
          includeInactive: true,
          limit: 100,
        }),
      }),

      onWindowsDefenderRefresh: async () => ({
        status: await options.runWindowsDefenderRefresh('web:manual'),
        alerts: options.windowsDefender.listAlerts({
          includeAcknowledged: true,
          includeInactive: true,
          limit: 100,
        }),
      }),

      onWindowsDefenderScan: async ({ type, path }) => options.windowsDefender.runScan({ type, path }),

      onWindowsDefenderUpdateSignatures: async () => options.windowsDefender.updateSignatures(),

      onHostMonitorStatus: () => options.hostMonitor.getStatus(),

      onHostMonitorAlerts: (args) => {
        const includeAcknowledged = !!args?.includeAcknowledged;
        const parsedLimit = Number(args?.limit ?? 100);
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
        const alerts = options.hostMonitor.listAlerts({ includeAcknowledged, limit });
        const status = options.hostMonitor.getStatus();
        return {
          alerts,
          activeAlertCount: alerts.length,
          bySeverity: status.bySeverity,
          baselineReady: status.baselineReady,
          lastUpdatedAt: status.lastUpdatedAt,
        };
      },

      onHostMonitorAcknowledge: (alertId) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        return options.hostMonitor.acknowledgeAlert(alertId.trim());
      },

      onHostMonitorCheck: () => options.runHostMonitoring('web:manual'),

      onGatewayMonitorStatus: () => options.gatewayMonitor.getStatus(),

      onGatewayMonitorAlerts: (args) => {
        const includeAcknowledged = !!args?.includeAcknowledged;
        const parsedLimit = Number(args?.limit ?? 100);
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
        const alerts = options.gatewayMonitor.listAlerts({ includeAcknowledged, limit });
        const status = options.gatewayMonitor.getStatus();
        return {
          alerts,
          activeAlertCount: alerts.length,
          bySeverity: status.bySeverity,
          baselineReady: status.baselineReady,
          lastUpdatedAt: status.lastUpdatedAt,
        };
      },

      onGatewayMonitorAcknowledge: (alertId) => {
        if (!alertId.trim()) {
          return { success: false, message: 'alertId is required' };
        }
        return options.gatewayMonitor.acknowledgeAlert(alertId.trim());
      },

      onGatewayMonitorCheck: () => options.runGatewayMonitoring('web:manual'),
    },
  };
}
