import type { GuardianAgentConfig } from '../config/types.js';
import {
  getManagedCloudRoleBindingsForProviderType,
  resolvePreferredManagedCloudProviderType,
} from '../config/managed-cloud-routing.js';
import {
  formatProviderTierLabel,
  getProviderLocality,
  getProviderTier,
  getProviderTypeMetadata,
  type ProviderLocality,
  type ProviderTier,
} from '../llm/provider-metadata.js';

export const CHAT_PROVIDER_SELECTION_METADATA_KEY = '__guardian_chat_provider_selection';

export interface ChatProviderSelectorOption {
  value: string;
  label: string;
  providerName?: string;
  providerType?: string;
  providerTier?: ProviderTier;
  providerLocality?: ProviderLocality;
  model?: string;
}

interface EnabledChatProviderOption extends ChatProviderSelectorOption {
  providerName: string;
  providerType: string;
  providerTier: ProviderTier;
  providerLocality: ProviderLocality;
}

export interface RequestedChatProviderSelection {
  providerName: string;
  providerType?: string;
  providerTier?: ProviderTier;
  providerLocality?: ProviderLocality;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderIdentity(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function isEnabledProvider(
  config: GuardianAgentConfig,
  providerName: string | undefined,
): providerName is string {
  const trimmed = providerName?.trim();
  return !!trimmed && !!config.llm[trimmed] && config.llm[trimmed].enabled !== false;
}

function buildProviderOptionLabel(
  providerName: string,
  providerType: string,
  providerTier: ProviderTier,
  model: string | undefined,
): string {
  const providerDisplayName = getProviderTypeMetadata(providerType)?.displayName ?? providerType.replaceAll('_', ' ');
  const normalizedProviderName = normalizeProviderIdentity(providerName);
  const sameIdentity = normalizedProviderName === normalizeProviderIdentity(providerDisplayName)
    || normalizedProviderName === normalizeProviderIdentity(providerType);
  const primaryLabel = sameIdentity ? providerDisplayName : providerName;
  const detailParts = [
    formatProviderTierLabel(providerTier),
    ...(sameIdentity ? [] : [providerDisplayName]),
    ...(model ? [model] : []),
  ];
  return detailParts.length > 0
    ? `${primaryLabel} (${detailParts.join(' · ')})`
    : primaryLabel;
}

function buildPreferredProviderRanks(config: GuardianAgentConfig): Map<string, number> {
  const preferredProviders = config.assistant.tools.preferredProviders ?? {};
  const ranks = new Map<string, number>();
  const preferredLocal = preferredProviders.local?.trim();
  if (preferredLocal && isEnabledProvider(config, preferredLocal)) {
    ranks.set(preferredLocal, 0);
  }

  const preferredManagedCloudType = resolvePreferredManagedCloudProviderType(config);
  if (preferredManagedCloudType) {
    const bindings = getManagedCloudRoleBindingsForProviderType(config, preferredManagedCloudType);
    const general = bindings.general?.trim();
    if (general && isEnabledProvider(config, general) && !ranks.has(general)) {
      ranks.set(general, 1);
    }
    Object.entries(config.llm)
      .filter(([, llmCfg]) => llmCfg.enabled !== false && llmCfg.provider?.trim().toLowerCase() === preferredManagedCloudType)
      .map(([providerName]) => providerName)
      .sort((left, right) => left.localeCompare(right))
      .forEach((providerName) => {
        if (!ranks.has(providerName)) {
          ranks.set(providerName, 2);
        }
      });
  }

  const preferredFrontier = preferredProviders.frontier?.trim();
  if (preferredFrontier && isEnabledProvider(config, preferredFrontier) && !ranks.has(preferredFrontier)) {
    ranks.set(preferredFrontier, 3);
  }

  const legacyExternal = preferredProviders.external?.trim();
  if (legacyExternal && isEnabledProvider(config, legacyExternal) && !ranks.has(legacyExternal)) {
    ranks.set(legacyExternal, 4);
  }

  return ranks;
}

export function normalizeChatProviderSelectionValue(
  config: GuardianAgentConfig,
  value: string | undefined | null,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === 'auto') return 'auto';
  return isEnabledProvider(config, trimmed) ? trimmed : 'auto';
}

export function buildChatProviderSelectorOptions(
  config: GuardianAgentConfig,
): ChatProviderSelectorOption[] {
  const preferredRanks = buildPreferredProviderRanks(config);
  const tierRanks: Record<ProviderTier, number> = {
    local: 0,
    managed_cloud: 1,
    frontier: 2,
  };
  const options: EnabledChatProviderOption[] = Object.entries(config.llm)
    .filter(([, llmCfg]) => llmCfg.enabled !== false)
    .map(([providerName, llmCfg]) => {
      const providerType = llmCfg.provider?.trim() || providerName;
      const providerTier = getProviderTier(providerType);
      const providerLocality = getProviderLocality(providerType);
      if (!providerTier || !providerLocality) return null;
      const model = llmCfg.model?.trim() || undefined;
      return {
        value: providerName,
        label: buildProviderOptionLabel(providerName, providerType, providerTier, model),
        providerName,
        providerType,
        providerTier,
        providerLocality,
        ...(model ? { model } : {}),
      };
    })
    .filter((value): value is EnabledChatProviderOption => value !== null)
    .sort((left, right) => {
      const leftTier = tierRanks[left.providerTier];
      const rightTier = tierRanks[right.providerTier];
      if (leftTier !== rightTier) return leftTier - rightTier;
      const leftPreferred = preferredRanks.get(left.providerName) ?? Number.MAX_SAFE_INTEGER;
      const rightPreferred = preferredRanks.get(right.providerName) ?? Number.MAX_SAFE_INTEGER;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      return left.label.localeCompare(right.label);
    });
  return [
    { value: 'auto', label: 'Automatic' },
    ...options,
  ];
}

export function attachChatProviderSelectionMetadata(
  metadata: Record<string, unknown> | undefined,
  providerName: string | undefined | null,
): Record<string, unknown> | undefined {
  const trimmed = typeof providerName === 'string' ? providerName.trim() : '';
  if (!trimmed || trimmed === 'auto') {
    if (!metadata) return undefined;
    const next = { ...metadata };
    delete next[CHAT_PROVIDER_SELECTION_METADATA_KEY];
    return Object.keys(next).length > 0 ? next : undefined;
  }
  return {
    ...(metadata ?? {}),
    [CHAT_PROVIDER_SELECTION_METADATA_KEY]: {
      providerName: trimmed,
    },
  };
}

export function readChatProviderSelectionMetadata(
  metadata: Record<string, unknown> | undefined,
  config?: GuardianAgentConfig,
): RequestedChatProviderSelection | null {
  const record = isRecord(metadata?.[CHAT_PROVIDER_SELECTION_METADATA_KEY])
    ? metadata?.[CHAT_PROVIDER_SELECTION_METADATA_KEY] as Record<string, unknown>
    : null;
  const providerName = typeof record?.providerName === 'string' && record.providerName.trim()
    ? record.providerName.trim()
    : '';
  if (!providerName) return null;
  if (config && !isEnabledProvider(config, providerName)) return null;
  const providerType = config?.llm[providerName]?.provider?.trim() || undefined;
  const providerTier = getProviderTier(providerType);
  const providerLocality = getProviderLocality(providerType);
  const model = config?.llm[providerName]?.model?.trim() || undefined;
  return {
    providerName,
    ...(providerType ? { providerType } : {}),
    ...(providerTier ? { providerTier } : {}),
    ...(providerLocality ? { providerLocality } : {}),
    ...(model ? { model } : {}),
  };
}
