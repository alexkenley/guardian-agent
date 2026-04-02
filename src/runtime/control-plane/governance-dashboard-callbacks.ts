import type { DashboardCallbacks, DashboardMutationResult } from '../../channels/web-types.js';
import type { GuardianAgentConfig } from '../../config/types.js';
import type { SecurityBaselineViolation } from '../../guardian/security-baseline.js';
import type { GuardianAgentService, SentinelAuditService } from '../sentinel.js';
import type { Runtime } from '../runtime.js';

type GovernanceDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onGuardianAgentStatus'
  | 'onGuardianAgentUpdate'
  | 'onPolicyStatus'
  | 'onPolicyUpdate'
  | 'onPolicyReload'
  | 'onSentinelAuditRun'
>;

interface GovernancePolicyState {
  getStatus: NonNullable<DashboardCallbacks['onPolicyStatus']>;
  update: NonNullable<DashboardCallbacks['onPolicyUpdate']>;
  reload: NonNullable<DashboardCallbacks['onPolicyReload']>;
}

interface GovernanceDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  guardianAgentService: Pick<GuardianAgentService, 'getConfig' | 'updateConfig'>;
  previewSecurityBaselineViolations: (
    config: GuardianAgentConfig,
    source: 'web_api',
  ) => SecurityBaselineViolation[];
  buildSecurityBaselineRejection: (
    violations: SecurityBaselineViolation[],
    source: 'guardian_agent_update' | 'policy_update',
    attemptedChange: Record<string, unknown>,
  ) => DashboardMutationResult;
  policyState: GovernancePolicyState;
  sentinelAuditService: Pick<SentinelAuditService, 'runAudit'>;
  auditLog: Runtime['auditLog'];
}

export function createGovernanceDashboardCallbacks(
  options: GovernanceDashboardCallbackOptions,
): GovernanceDashboardCallbacks {
  return {
    onGuardianAgentStatus: () => {
      const cfg = options.guardianAgentService.getConfig();
      return {
        enabled: cfg.enabled,
        llmProvider: cfg.llmProvider,
        failOpen: cfg.failOpen,
        timeoutMs: cfg.timeoutMs,
        actionTypes: cfg.actionTypes,
      };
    },

    onGuardianAgentUpdate: (input) => {
      const nextConfig = structuredClone(options.configRef.current);
      nextConfig.guardian.guardianAgent = {
        enabled: true,
        llmProvider: 'auto',
        failOpen: false,
        ...(nextConfig.guardian.guardianAgent ?? {}),
        ...input,
      };
      const baselineViolations = options.previewSecurityBaselineViolations(nextConfig, 'web_api');
      if (baselineViolations.length > 0) {
        return options.buildSecurityBaselineRejection(
          baselineViolations,
          'guardian_agent_update',
          input as Record<string, unknown>,
        );
      }
      options.guardianAgentService.updateConfig(input);
      return { success: true, message: 'Guardian Agent configuration updated.' };
    },

    onPolicyStatus: options.policyState.getStatus,

    onPolicyUpdate: (input) => {
      const nextConfig = structuredClone(options.configRef.current);
      const currentPolicy = nextConfig.guardian.policy;
      nextConfig.guardian.policy = {
        ...(currentPolicy ?? { enabled: true, mode: 'shadow' as const }),
        enabled: input.enabled ?? currentPolicy?.enabled ?? true,
        mode: input.mode ?? currentPolicy?.mode ?? 'shadow',
        families: input.families
          ? {
              ...(currentPolicy?.families ?? {}),
              ...input.families,
            }
          : currentPolicy?.families,
        mismatchLogLimit: input.mismatchLogLimit ?? currentPolicy?.mismatchLogLimit,
      };
      const baselineViolations = options.previewSecurityBaselineViolations(nextConfig, 'web_api');
      if (baselineViolations.length > 0) {
        return options.buildSecurityBaselineRejection(
          baselineViolations,
          'policy_update',
          input as Record<string, unknown>,
        );
      }
      return options.policyState.update(input);
    },

    onPolicyReload: options.policyState.reload,

    onSentinelAuditRun: async (windowMs) => {
      const result = await options.sentinelAuditService.runAudit(options.auditLog, windowMs);
      return {
        success: true,
        anomalies: result.anomalies.map((anomaly) => ({
          type: anomaly.type,
          severity: anomaly.severity,
          description: anomaly.description,
          agentId: anomaly.agentId,
        })),
        llmFindings: result.llmFindings,
        timestamp: result.timestamp,
        windowMs: result.windowMs,
      };
    },
  };
}
