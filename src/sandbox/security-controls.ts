import type {
  SandboxConfig,
  SandboxDegradedFallbackConfig,
  SandboxEnforcementMode,
  SandboxHealth,
} from './types.js';

export function getEffectiveSandboxEnforcementMode(
  config?: SandboxConfig,
  health?: SandboxHealth,
): SandboxEnforcementMode {
  return health?.enforcementMode ?? config?.enforcementMode ?? 'permissive';
}

export function isStrictSandboxLockdown(
  config?: SandboxConfig,
  health?: SandboxHealth,
): boolean {
  if (!health || config?.enabled === false) return false;
  return getEffectiveSandboxEnforcementMode(config, health) === 'strict'
    && health.availability !== 'strong';
}

export function isDegradedSandboxFallbackActive(
  config?: SandboxConfig,
  health?: SandboxHealth,
): boolean {
  if (!health || config?.enabled === false) return false;
  return getEffectiveSandboxEnforcementMode(config, health) !== 'strict'
    && health.availability !== 'strong';
}

export function resolveDegradedFallbackConfig(
  config?: SandboxConfig,
): SandboxDegradedFallbackConfig {
  return {
    allowNetworkTools: config?.degradedFallback?.allowNetworkTools === true,
    allowBrowserTools: config?.degradedFallback?.allowBrowserTools === true,
    allowMcpServers: config?.degradedFallback?.allowMcpServers === true,
    allowPackageManagers: config?.degradedFallback?.allowPackageManagers === true,
    allowManualCodeTerminals: config?.degradedFallback?.allowManualCodeTerminals === true,
  };
}

export function listEnabledDegradedFallbackAllowances(
  config?: SandboxConfig,
): string[] {
  const allowances = resolveDegradedFallbackConfig(config);
  const enabled: string[] = [];
  if (allowances.allowNetworkTools) enabled.push('network and web search tools');
  if (allowances.allowBrowserTools) enabled.push('browser automation');
  if (allowances.allowMcpServers) enabled.push('third-party MCP servers');
  if (allowances.allowPackageManagers) enabled.push('package manager install and exec commands');
  if (allowances.allowManualCodeTerminals) enabled.push('manual code terminals');
  return enabled;
}

export function isBrowserMcpToolName(toolName: string): boolean {
  return toolName.startsWith('mcp-playwright-');
}
