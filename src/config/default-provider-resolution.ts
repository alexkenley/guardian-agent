import type { GuardianAgentConfig } from './types.js';
import { getProviderLocality, getProviderTier } from '../llm/provider-metadata.js';
import {
  getManagedCloudRoleBindingsForProviderType,
  isManagedCloudProfileForProviderType,
  listConfiguredManagedCloudProfilesForType,
  resolvePreferredManagedCloudSelection,
} from './managed-cloud-routing.js';

function isEnabledProvider(config: GuardianAgentConfig, providerName: string | undefined): providerName is string {
  const trimmed = providerName?.trim();
  return !!trimmed && config.llm[trimmed]?.enabled !== false;
}

function isManagedCloudProvider(config: GuardianAgentConfig, providerName: string | undefined): providerName is string {
  const trimmed = providerName?.trim();
  return isEnabledProvider(config, trimmed) && getProviderTier(config.llm[trimmed]?.provider) === 'managed_cloud';
}

function isLocalProvider(config: GuardianAgentConfig, providerName: string | undefined): providerName is string {
  const trimmed = providerName?.trim();
  return isEnabledProvider(config, trimmed) && getProviderLocality(config.llm[trimmed]?.provider) === 'local';
}

function isFrontierProvider(config: GuardianAgentConfig, providerName: string | undefined): providerName is string {
  const trimmed = providerName?.trim();
  return isEnabledProvider(config, trimmed) && getProviderTier(config.llm[trimmed]?.provider) === 'frontier';
}

function listProvidersByTier(config: GuardianAgentConfig, tier: 'managed_cloud' | 'frontier'): string[] {
  return Object.entries(config.llm)
    .filter(([, llmCfg]) => llmCfg.enabled !== false && getProviderTier(llmCfg.provider) === tier)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function listLocalProviders(config: GuardianAgentConfig): string[] {
  return Object.entries(config.llm)
    .filter(([, llmCfg]) => llmCfg.enabled !== false && getProviderLocality(llmCfg.provider) === 'local')
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveDerivedDefaultProvider(config: GuardianAgentConfig): string {
  const providerNames = Object.entries(config.llm)
    .filter(([, llmCfg]) => llmCfg.enabled !== false)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  if (providerNames.length === 0) return '';

  const preferredProviders = config.assistant.tools?.preferredProviders;
  const managedCloudRouting = config.assistant.tools?.modelSelection?.managedCloudRouting;
  const managedCloudPreference = resolvePreferredManagedCloudSelection(config);
  const preferredManagedCloudType = managedCloudPreference.providerType;
  const managedCloudBindings = preferredManagedCloudType
    ? getManagedCloudRoleBindingsForProviderType(config, preferredManagedCloudType)
    : {};
  const generalManagedCloud = managedCloudRouting?.enabled !== false
    ? managedCloudBindings.general
    : undefined;
  const preferredManagedCloudProvider = preferredManagedCloudType
    ? listConfiguredManagedCloudProfilesForType(config, preferredManagedCloudType)[0]
    : undefined;
  const legacyExternal = preferredProviders?.external;

  const candidates = [
    isManagedCloudProfileForProviderType(config, generalManagedCloud, preferredManagedCloudType || undefined)
      ? generalManagedCloud
      : undefined,
    isManagedCloudProvider(config, managedCloudPreference.legacyProviderName || undefined)
      ? managedCloudPreference.legacyProviderName || undefined
      : undefined,
    isManagedCloudProvider(config, preferredManagedCloudProvider) ? preferredManagedCloudProvider : undefined,
    isManagedCloudProvider(config, legacyExternal) ? legacyExternal : undefined,
    listProvidersByTier(config, 'managed_cloud')[0],
    isLocalProvider(config, preferredProviders?.local) ? preferredProviders?.local : undefined,
    listLocalProviders(config)[0],
    isFrontierProvider(config, preferredProviders?.frontier) ? preferredProviders?.frontier : undefined,
    isFrontierProvider(config, legacyExternal) ? legacyExternal : undefined,
    listProvidersByTier(config, 'frontier')[0],
    providerNames[0],
  ];

  return candidates.find((candidate): candidate is string => !!candidate) ?? '';
}

export function applyDerivedDefaultProvider(config: GuardianAgentConfig): GuardianAgentConfig {
  config.defaultProvider = resolveDerivedDefaultProvider(config);
  return config;
}
