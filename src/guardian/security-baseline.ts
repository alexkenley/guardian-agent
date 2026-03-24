import type { GuardianAgentConfig } from '../config/types.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('security-baseline');

export interface SecurityBaseline {
  guardianEnabled: true;
  guardianAgentEnabled: true;
  guardianAgentFailOpen: false;
  minimumDeniedPaths: string[];
  maxApprovalPolicy: 'approve_by_policy';
  minimumPolicyMode: 'shadow';
}

export interface SecurityBaselineViolation {
  field: string;
  attempted: unknown;
  enforced: unknown;
  source: 'config_file' | 'web_api' | 'runtime';
}

export const SECURITY_BASELINE: SecurityBaseline = {
  guardianEnabled: true,
  guardianAgentEnabled: true,
  guardianAgentFailOpen: false,
  minimumDeniedPaths: [
    '(^|/)\\.env(?:$|\\.)',
    '\\.pem$',
    '\\.key$',
    '(^|/)credentials\\.[^/]+$',
    '(^|/)id_rsa(?:$|\\.)',
    '(^|/)\\.guardianagent(?:/|$)',
  ],
  maxApprovalPolicy: 'approve_by_policy',
  minimumPolicyMode: 'shadow',
};

function approvalPolicyRank(mode: GuardianAgentConfig['assistant']['tools']['policyMode']): number {
  switch (mode) {
    case 'approve_each':
      return 0;
    case 'approve_by_policy':
      return 1;
    case 'autonomous':
      return 2;
  }
}

function policyModeRank(mode: NonNullable<GuardianAgentConfig['guardian']['policy']>['mode']): number {
  switch (mode) {
    case 'off':
      return 0;
    case 'shadow':
      return 1;
    case 'enforce':
      return 2;
  }
}

export function isSecurityBaselineDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['GUARDIAN_DISABLE_BASELINE'];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function enforceSecurityBaseline(
  config: GuardianAgentConfig,
  source: SecurityBaselineViolation['source'],
  env: NodeJS.ProcessEnv = process.env,
): SecurityBaselineViolation[] {
  if (isSecurityBaselineDisabled(env)) {
    return [];
  }

  const violations: SecurityBaselineViolation[] = [];
  config.guardian.guardianAgent = {
    enabled: true,
    llmProvider: 'auto',
    failOpen: false,
    ...(config.guardian.guardianAgent ?? {}),
  };
  config.guardian.policy = {
    enabled: true,
    mode: 'shadow',
    ...(config.guardian.policy ?? {}),
  };

  if (config.guardian.enabled !== SECURITY_BASELINE.guardianEnabled) {
    violations.push({
      field: 'guardian.enabled',
      attempted: config.guardian.enabled,
      enforced: true,
      source,
    });
    config.guardian.enabled = true;
  }

  if (config.guardian.guardianAgent.enabled !== SECURITY_BASELINE.guardianAgentEnabled) {
    violations.push({
      field: 'guardian.guardianAgent.enabled',
      attempted: config.guardian.guardianAgent.enabled,
      enforced: true,
      source,
    });
    config.guardian.guardianAgent.enabled = true;
  }

  if (config.guardian.guardianAgent.failOpen !== SECURITY_BASELINE.guardianAgentFailOpen) {
    violations.push({
      field: 'guardian.guardianAgent.failOpen',
      attempted: config.guardian.guardianAgent.failOpen,
      enforced: false,
      source,
    });
    config.guardian.guardianAgent.failOpen = false;
  }

  if (approvalPolicyRank(config.assistant.tools.policyMode) > approvalPolicyRank(SECURITY_BASELINE.maxApprovalPolicy)) {
    violations.push({
      field: 'assistant.tools.policyMode',
      attempted: config.assistant.tools.policyMode,
      enforced: SECURITY_BASELINE.maxApprovalPolicy,
      source,
    });
    config.assistant.tools.policyMode = SECURITY_BASELINE.maxApprovalPolicy;
    if (config.approval_policy === 'autonomous') {
      config.approval_policy = 'auto-approve';
    }
  }

  const existingDeniedPaths = Array.isArray(config.guardian.deniedPaths) ? config.guardian.deniedPaths : [];
  const missingDeniedPaths = SECURITY_BASELINE.minimumDeniedPaths.filter((pattern) => !existingDeniedPaths.includes(pattern));
  if (missingDeniedPaths.length > 0) {
    violations.push({
      field: 'guardian.deniedPaths',
      attempted: existingDeniedPaths,
      enforced: [...existingDeniedPaths, ...missingDeniedPaths],
      source,
    });
    config.guardian.deniedPaths = [...existingDeniedPaths, ...missingDeniedPaths];
  }

  if (config.guardian.policy.enabled !== true) {
    violations.push({
      field: 'guardian.policy.enabled',
      attempted: config.guardian.policy.enabled,
      enforced: true,
      source,
    });
    config.guardian.policy.enabled = true;
  }

  if (policyModeRank(config.guardian.policy.mode) < policyModeRank(SECURITY_BASELINE.minimumPolicyMode)) {
    violations.push({
      field: 'guardian.policy.mode',
      attempted: config.guardian.policy.mode,
      enforced: SECURITY_BASELINE.minimumPolicyMode,
      source,
    });
    config.guardian.policy.mode = SECURITY_BASELINE.minimumPolicyMode;
  }

  return violations;
}

export function previewSecurityBaselineViolations(
  config: GuardianAgentConfig,
  source: SecurityBaselineViolation['source'],
  env: NodeJS.ProcessEnv = process.env,
): SecurityBaselineViolation[] {
  const cloned = structuredClone(config);
  return enforceSecurityBaseline(cloned, source, env);
}

export function logSecurityBaselineEnforcement(violations: SecurityBaselineViolation[]): void {
  if (violations.length === 0) {
    return;
  }
  log.warn({ violations }, 'Security baseline enforced');
}
