import type { DashboardCallbacks } from '../../channels/web-types.js';
import type { GuardianAgentConfig } from '../../config/types.js';
import type { AuditLog } from '../../guardian/audit-log.js';
import type { AssistantJobTracker } from '../assistant-jobs.js';
import type { AiSecurityService } from '../ai-security.js';
import type { ThreatIntelService } from '../threat-intel.js';

type SecurityDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onAiSecuritySummary'
  | 'onAiSecurityProfiles'
  | 'onAiSecurityTargets'
  | 'onAiSecurityRuns'
  | 'onAiSecurityScan'
  | 'onAiSecurityFindings'
  | 'onAiSecurityUpdateFindingStatus'
  | 'onThreatIntelSummary'
  | 'onThreatIntelPlan'
  | 'onThreatIntelWatchlist'
  | 'onThreatIntelWatchAdd'
  | 'onThreatIntelWatchRemove'
  | 'onThreatIntelScan'
  | 'onThreatIntelFindings'
  | 'onThreatIntelUpdateFindingStatus'
  | 'onThreatIntelActions'
  | 'onThreatIntelDraftAction'
  | 'onThreatIntelSetResponseMode'
>;

interface SecurityDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (
    rawConfig: Record<string, unknown>,
    meta?: { changedBy?: string; reason?: string },
  ) => { success: boolean; message: string };
  aiSecurity: AiSecurityService;
  runAssistantSecurityScan: (input: {
    profileId?: string;
    targetIds?: string[];
    source?: 'manual' | 'scheduled' | 'system';
    requestedBy?: string;
  }) => Promise<Awaited<ReturnType<AiSecurityService['scan']>>>;
  threatIntel: ThreatIntelService;
  jobTracker: AssistantJobTracker;
  auditLog?: AuditLog;
  trackAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
}

export function createSecurityDashboardCallbacks(
  options: SecurityDashboardCallbackOptions,
): SecurityDashboardCallbacks {
  const persistThreatIntelState = (): { success: boolean; message: string } => {
    const rawConfig = options.loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingThreatIntel = (rawAssistant.threatIntel as Record<string, unknown> | undefined) ?? {};

    rawAssistant.threatIntel = {
      ...existingThreatIntel,
      enabled: options.configRef.current.assistant.threatIntel.enabled,
      allowDarkWeb: options.configRef.current.assistant.threatIntel.allowDarkWeb,
      responseMode: options.threatIntel.getSummary().responseMode,
      watchlist: options.threatIntel.listWatchlist(),
      autoScanIntervalMinutes: options.configRef.current.assistant.threatIntel.autoScanIntervalMinutes,
    };

    return options.persistAndApplyConfig(rawConfig, {
      changedBy: 'threat-intel',
      reason: 'threat intel settings update',
    });
  };

  return {
    onAiSecuritySummary: () => options.aiSecurity.getSummary(),

    onAiSecurityProfiles: () => options.aiSecurity.getProfiles(),

    onAiSecurityTargets: () => options.aiSecurity.listTargets(),

    onAiSecurityRuns: (limit) => options.aiSecurity.listRuns(limit ?? 20),

    onAiSecurityScan: async (input) => options.runAssistantSecurityScan({
      profileId: input?.profileId,
      targetIds: input?.targetIds,
      source: input?.source ?? 'manual',
      requestedBy: 'web-security-page',
    }),

    onAiSecurityFindings: ({ limit, status }) => options.aiSecurity.listFindings(limit ?? 50, status),

    onAiSecurityUpdateFindingStatus: ({ findingId, status }) => {
      const result = options.aiSecurity.updateFindingStatus(findingId, status);
      options.trackAnalytics(
        result.success ? 'assistant_security_finding_status_updated' : 'assistant_security_finding_status_failed',
        { findingId, status, success: result.success },
      );
      return result;
    },

    onThreatIntelSummary: () => options.threatIntel.getSummary(),

    onThreatIntelPlan: () => options.threatIntel.getPlan(),

    onThreatIntelWatchlist: () => options.threatIntel.listWatchlist(),

    onThreatIntelWatchAdd: (target) => {
      const result = options.threatIntel.addWatchTarget(target);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        options.threatIntel.removeWatchTarget(target);
        return {
          success: false,
          message: `${result.message} Rollback applied. ${persisted.message}`,
        };
      }

      options.trackAnalytics('threat_intel_watch_add', { target });
      return result;
    },

    onThreatIntelWatchRemove: (target) => {
      const result = options.threatIntel.removeWatchTarget(target);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        options.threatIntel.addWatchTarget(target);
        return {
          success: false,
          message: `${result.message} Rollback applied. ${persisted.message}`,
        };
      }

      options.trackAnalytics('threat_intel_watch_remove', { target });
      return result;
    },

    onThreatIntelScan: async (input) => {
      return options.jobTracker.run(
        {
          type: 'threat_intel.scan',
          source: 'manual',
          detail: input.query
            ? `Manual scan for '${input.query}'`
            : 'Manual scan for configured watchlist',
          metadata: {
            includeDarkWeb: !!input.includeDarkWeb,
            sources: input.sources,
          },
        },
        async () => {
          const result = await options.threatIntel.scan(input);
          options.trackAnalytics(
            result.success ? 'threat_intel_scan' : 'threat_intel_scan_failed',
            {
              query: input.query,
              includeDarkWeb: input.includeDarkWeb,
              findings: result.findings.length,
              success: result.success,
            },
          );

          const highRisk = result.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical');
          if (highRisk.length > 0) {
            options.auditLog?.record({
              type: 'anomaly_detected',
              severity: 'warn',
              agentId: 'threat-intel',
              details: {
                source: 'threat_intel_scan',
                anomalyType: 'high_risk_signal',
                description: `${highRisk.length} high-risk finding(s) detected in threat-intel scan.`,
                evidence: {
                  findingIds: highRisk.map((finding) => finding.id),
                  targets: highRisk.map((finding) => finding.target),
                },
              },
            });
          }
          return result;
        },
      );
    },

    onThreatIntelFindings: ({ limit, status }) => {
      const safeLimit = limit && limit > 0 ? limit : 50;
      return options.threatIntel.listFindings(safeLimit, status);
    },

    onThreatIntelUpdateFindingStatus: ({ findingId, status }) => {
      const result = options.threatIntel.updateFindingStatus(findingId, status);
      options.trackAnalytics(
        result.success ? 'threat_intel_finding_status_updated' : 'threat_intel_finding_status_failed',
        { findingId, status, success: result.success },
      );
      return result;
    },

    onThreatIntelActions: (limit) => options.threatIntel.listActions(limit ?? 50),

    onThreatIntelDraftAction: ({ findingId, type }) => {
      const result = options.threatIntel.draftAction(findingId, type);
      options.trackAnalytics(
        result.success ? 'threat_intel_action_drafted' : 'threat_intel_action_draft_failed',
        { findingId, type, success: result.success },
      );
      return result;
    },

    onThreatIntelSetResponseMode: (mode) => {
      const previousMode = options.threatIntel.getSummary().responseMode;
      const result = options.threatIntel.setResponseMode(mode);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        options.threatIntel.setResponseMode(previousMode);
        return {
          success: false,
          message: `Failed to persist mode change. ${persisted.message}`,
        };
      }

      options.trackAnalytics('threat_intel_response_mode_updated', { mode });
      return result;
    },
  };
}
