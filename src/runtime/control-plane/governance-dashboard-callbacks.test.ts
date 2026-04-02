import { describe, expect, it, vi } from 'vitest';

import type { DashboardMutationResult } from '../../channels/web-types.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import type { SecurityBaselineViolation } from '../../guardian/security-baseline.js';
import { createGovernanceDashboardCallbacks } from './governance-dashboard-callbacks.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createOptions(
  overrides: Partial<Parameters<typeof createGovernanceDashboardCallbacks>[0]> = {},
): Parameters<typeof createGovernanceDashboardCallbacks>[0] {
  return {
    configRef: { current: createConfig() },
    guardianAgentService: {
      getConfig: vi.fn(() => ({
        enabled: true,
        llmProvider: 'auto' as const,
        failOpen: false,
        timeoutMs: 5_000,
        actionTypes: ['command'],
      })),
      updateConfig: vi.fn(),
    } as never,
    previewSecurityBaselineViolations: vi.fn((): SecurityBaselineViolation[] => []),
    buildSecurityBaselineRejection: vi.fn((violations, source): DashboardMutationResult => ({
      success: false,
      message: `${source}:${violations.length}`,
      statusCode: 403,
      errorCode: 'security_baseline_enforced',
    })),
    policyState: {
      getStatus: vi.fn(() => ({
        enabled: true,
        mode: 'shadow' as const,
        families: { tool: 'shadow', admin: 'shadow', guardian: 'shadow', event: 'shadow' },
        rulesPath: 'policies/',
        ruleCount: 3,
        mismatchLogLimit: 1000,
      })),
      update: vi.fn((input) => ({
        success: true,
        message: `updated:${input.mode ?? 'unchanged'}`,
      })),
      reload: vi.fn(() => ({
        success: true,
        message: 'reloaded',
        loaded: 2,
        skipped: 0,
        errors: [],
      })),
    },
    sentinelAuditService: {
      runAudit: vi.fn(async () => ({
        anomalies: [{
          type: 'rate_limit',
          severity: 'warn',
          description: 'too many requests',
          agentId: 'default',
        }],
        llmFindings: [{
          severity: 'medium',
          description: 'review needed',
          recommendation: 'inspect',
        }],
        timestamp: 123,
        windowMs: 60000,
      })),
    } as never,
    auditLog: {
      record: vi.fn(),
      query: vi.fn(),
      getSummary: vi.fn(),
      verifyChain: vi.fn(),
      addListener: vi.fn(),
    } as never,
    ...overrides,
  };
}

describe('createGovernanceDashboardCallbacks', () => {
  it('returns guardian agent status and applies allowed updates', () => {
    const options = createOptions();
    const callbacks = createGovernanceDashboardCallbacks(options);

    expect(callbacks.onGuardianAgentStatus?.()).toEqual({
      enabled: true,
      llmProvider: 'auto',
      failOpen: false,
      timeoutMs: 5_000,
      actionTypes: ['command'],
    });

    expect(callbacks.onGuardianAgentUpdate?.({
      enabled: false,
      timeoutMs: 1_000,
    })).toEqual({
      success: true,
      message: 'Guardian Agent configuration updated.',
    });
    expect(options.guardianAgentService.updateConfig).toHaveBeenCalledWith({
      enabled: false,
      timeoutMs: 1_000,
    });
  });

  it('rejects guardian and policy updates when the security baseline blocks them', () => {
    const violation: SecurityBaselineViolation = {
      field: 'guardian.guardianAgent.enabled',
      attempted: false,
      enforced: true,
      message: 'must stay enabled',
    };
    const previewSecurityBaselineViolations = vi
      .fn<Parameters<Parameters<typeof createGovernanceDashboardCallbacks>[0]['previewSecurityBaselineViolations']>, ReturnType<Parameters<typeof createGovernanceDashboardCallbacks>[0]['previewSecurityBaselineViolations']>>()
      .mockReturnValue([violation]);
    const buildSecurityBaselineRejection = vi.fn((violations, source): DashboardMutationResult => ({
      success: false,
      message: `${source}:${violations.length}`,
      statusCode: 403,
      errorCode: 'security_baseline_enforced',
    }));
    const options = createOptions({
      previewSecurityBaselineViolations,
      buildSecurityBaselineRejection,
    });
    const callbacks = createGovernanceDashboardCallbacks(options);

    expect(callbacks.onGuardianAgentUpdate?.({ enabled: false })).toEqual({
      success: false,
      message: 'guardian_agent_update:1',
      statusCode: 403,
      errorCode: 'security_baseline_enforced',
    });
    expect(callbacks.onPolicyUpdate?.({ mode: 'enforce' })).toEqual({
      success: false,
      message: 'policy_update:1',
      statusCode: 403,
      errorCode: 'security_baseline_enforced',
    });
    expect(buildSecurityBaselineRejection).toHaveBeenNthCalledWith(
      1,
      [violation],
      'guardian_agent_update',
      { enabled: false },
    );
    expect(buildSecurityBaselineRejection).toHaveBeenNthCalledWith(
      2,
      [violation],
      'policy_update',
      { mode: 'enforce' },
    );
    expect(options.guardianAgentService.updateConfig).not.toHaveBeenCalled();
    expect(options.policyState.update).not.toHaveBeenCalled();
  });

  it('delegates policy status and reload, and formats sentinel audit results', async () => {
    const options = createOptions();
    const callbacks = createGovernanceDashboardCallbacks(options);

    expect(callbacks.onPolicyStatus?.()).toEqual({
      enabled: true,
      mode: 'shadow',
      families: { tool: 'shadow', admin: 'shadow', guardian: 'shadow', event: 'shadow' },
      rulesPath: 'policies/',
      ruleCount: 3,
      mismatchLogLimit: 1000,
    });
    expect(callbacks.onPolicyUpdate?.({ mode: 'off' })).toEqual({
      success: true,
      message: 'updated:off',
    });
    expect(callbacks.onPolicyReload?.()).toEqual({
      success: true,
      message: 'reloaded',
      loaded: 2,
      skipped: 0,
      errors: [],
    });

    await expect(callbacks.onSentinelAuditRun?.(15 * 60 * 1000)).resolves.toEqual({
      success: true,
      anomalies: [{
        type: 'rate_limit',
        severity: 'warn',
        description: 'too many requests',
        agentId: 'default',
      }],
      llmFindings: [{
        severity: 'medium',
        description: 'review needed',
        recommendation: 'inspect',
      }],
      timestamp: 123,
      windowMs: 60000,
    });
    expect(options.policyState.update).toHaveBeenCalledWith({ mode: 'off' });
    expect(options.policyState.reload).toHaveBeenCalledOnce();
    expect(options.sentinelAuditService.runAudit).toHaveBeenCalledWith(options.auditLog, 15 * 60 * 1000);
  });
});
