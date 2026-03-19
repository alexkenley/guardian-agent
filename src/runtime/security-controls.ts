export type DeploymentProfile = 'personal' | 'home' | 'organization';
export type SecurityOperatingMode = 'monitor' | 'guarded' | 'lockdown' | 'ir_assist';
export type SecurityTriageLlmProvider = 'local' | 'external' | 'auto';

export const DEFAULT_DEPLOYMENT_PROFILE: DeploymentProfile = 'personal';
export const DEFAULT_SECURITY_OPERATING_MODE: SecurityOperatingMode = 'monitor';
export const DEFAULT_SECURITY_TRIAGE_LLM_PROVIDER: SecurityTriageLlmProvider = 'auto';

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = ['personal', 'home', 'organization'];
export const SECURITY_OPERATING_MODES: readonly SecurityOperatingMode[] = ['monitor', 'guarded', 'lockdown', 'ir_assist'];
export const SECURITY_TRIAGE_LLM_PROVIDERS: readonly SecurityTriageLlmProvider[] = ['auto', 'local', 'external'];

export function isDeploymentProfile(value: string): value is DeploymentProfile {
  return DEPLOYMENT_PROFILES.includes(value as DeploymentProfile);
}

export function isSecurityOperatingMode(value: string): value is SecurityOperatingMode {
  return SECURITY_OPERATING_MODES.includes(value as SecurityOperatingMode);
}

export function isSecurityTriageLlmProvider(value: string): value is SecurityTriageLlmProvider {
  return SECURITY_TRIAGE_LLM_PROVIDERS.includes(value as SecurityTriageLlmProvider);
}
