import type {
  GuardianAgentConfig,
  ManagedCloudRoutingRole,
} from './types.js';
import { getProviderTier } from '../llm/provider-metadata.js';

export type ManagedCloudRoleBindings = Partial<Record<ManagedCloudRoutingRole, string>>;

const MANAGED_CLOUD_ROLES: ManagedCloudRoutingRole[] = ['general', 'direct', 'toolLoop', 'coding'];

function normalizeProviderType(providerType: string | undefined): string {
  return providerType?.trim().toLowerCase() || '';
}

function isEnabledManagedCloudProfile(
  config: GuardianAgentConfig,
  providerName: string | undefined,
): providerName is string {
  const trimmed = providerName?.trim();
  if (!trimmed) return false;
  const llmConfig = config.llm[trimmed];
  return !!llmConfig && llmConfig.enabled !== false && getProviderTier(llmConfig.provider) === 'managed_cloud';
}

export function isManagedCloudProviderType(providerType: string | undefined): boolean {
  return getProviderTier(providerType) === 'managed_cloud';
}

export function resolveManagedCloudProviderTypeSelection(
  config: GuardianAgentConfig,
  selection: string | undefined | null,
): { providerType: string | null; legacyProviderName?: string | null } {
  const trimmed = selection?.trim();
  if (!trimmed) return { providerType: null, legacyProviderName: null };
  if (isEnabledManagedCloudProfile(config, trimmed)) {
    return {
      providerType: normalizeProviderType(config.llm[trimmed]?.provider),
      legacyProviderName: trimmed,
    };
  }
  if (isManagedCloudProviderType(trimmed)) {
    return {
      providerType: normalizeProviderType(trimmed),
      legacyProviderName: null,
    };
  }
  return { providerType: null, legacyProviderName: null };
}

export function listConfiguredManagedCloudProviderTypes(config: GuardianAgentConfig): string[] {
  return [...new Set(
    Object.values(config.llm)
      .filter((llmConfig) => llmConfig.enabled !== false && getProviderTier(llmConfig.provider) === 'managed_cloud')
      .map((llmConfig) => normalizeProviderType(llmConfig.provider))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

export function listConfiguredManagedCloudProfilesForType(
  config: GuardianAgentConfig,
  providerType: string | undefined,
): string[] {
  const normalizedType = normalizeProviderType(providerType);
  if (!normalizedType) return [];
  return Object.entries(config.llm)
    .filter(([, llmConfig]) => llmConfig.enabled !== false && normalizeProviderType(llmConfig.provider) === normalizedType)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

export function resolvePreferredManagedCloudProviderType(config: GuardianAgentConfig): string | null {
  const preferred = resolveManagedCloudProviderTypeSelection(
    config,
    config.assistant.tools.preferredProviders?.managedCloud,
  );
  if (preferred.providerType) return preferred.providerType;

  const legacyExternal = resolveManagedCloudProviderTypeSelection(
    config,
    config.assistant.tools.preferredProviders?.external,
  );
  if (legacyExternal.providerType) return legacyExternal.providerType;

  return listConfiguredManagedCloudProviderTypes(config)[0] ?? null;
}

export function getManagedCloudRoleBindingsForProviderType(
  config: GuardianAgentConfig,
  providerType: string | undefined,
): ManagedCloudRoleBindings {
  const normalizedType = normalizeProviderType(providerType);
  if (!normalizedType) return {};

  const routing = config.assistant.tools.modelSelection?.managedCloudRouting;
  const explicitBindings = routing?.providerRoleBindings?.[normalizedType];
  if (explicitBindings && typeof explicitBindings === 'object' && !Array.isArray(explicitBindings)) {
    return explicitBindings;
  }

  const legacyBindings = routing?.roleBindings;
  if (!legacyBindings || typeof legacyBindings !== 'object' || Array.isArray(legacyBindings)) {
    return {};
  }

  const filtered: ManagedCloudRoleBindings = {};
  for (const role of MANAGED_CLOUD_ROLES) {
    const providerName = legacyBindings[role]?.trim();
    if (!providerName || !isEnabledManagedCloudProfile(config, providerName)) continue;
    if (normalizeProviderType(config.llm[providerName]?.provider) === normalizedType) {
      filtered[role] = providerName;
    }
  }
  return filtered;
}

export function isManagedCloudProfileForProviderType(
  config: GuardianAgentConfig,
  providerName: string | undefined,
  providerType: string | undefined,
): providerName is string {
  const normalizedType = normalizeProviderType(providerType);
  if (!normalizedType || !isEnabledManagedCloudProfile(config, providerName)) {
    return false;
  }
  return normalizeProviderType(config.llm[providerName]?.provider) === normalizedType;
}

export function resolvePreferredManagedCloudSelection(config: GuardianAgentConfig): {
  providerType: string | null;
  legacyProviderName?: string | null;
} {
  const preferred = resolveManagedCloudProviderTypeSelection(
    config,
    config.assistant.tools.preferredProviders?.managedCloud,
  );
  if (preferred.providerType) return preferred;

  const legacyExternal = resolveManagedCloudProviderTypeSelection(
    config,
    config.assistant.tools.preferredProviders?.external,
  );
  if (legacyExternal.providerType) return legacyExternal;

  return { providerType: listConfiguredManagedCloudProviderTypes(config)[0] ?? null, legacyProviderName: null };
}
