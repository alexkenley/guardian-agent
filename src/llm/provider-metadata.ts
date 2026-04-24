export type ProviderLocality = 'local' | 'external';
export type ProviderTier = 'local' | 'managed_cloud' | 'frontier';
export type ProviderPreferenceBucket = 'local' | 'managedCloud' | 'frontier';

export interface ProviderTypeMetadata {
  name: string;
  displayName: string;
  compatible: boolean;
  locality: ProviderLocality;
  tier: ProviderTier;
  requiresCredential: boolean;
  defaultBaseUrl?: string;
}

const PROVIDER_TYPE_METADATA: Record<string, ProviderTypeMetadata> = {
  ollama: {
    name: 'ollama',
    displayName: 'Ollama',
    compatible: false,
    locality: 'local',
    tier: 'local',
    requiresCredential: false,
    defaultBaseUrl: 'http://127.0.0.1:11434',
  },
  ollama_cloud: {
    name: 'ollama_cloud',
    displayName: 'Ollama Cloud',
    compatible: false,
    locality: 'external',
    tier: 'managed_cloud',
    requiresCredential: true,
    defaultBaseUrl: 'https://ollama.com',
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter',
    compatible: true,
    locality: 'external',
    tier: 'managed_cloud',
    requiresCredential: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    compatible: false,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    compatible: false,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
  },
  groq: {
    name: 'groq',
    displayName: 'Groq',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  mistral: {
    name: 'mistral',
    displayName: 'Mistral AI',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  together: {
    name: 'together',
    displayName: 'Together AI',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://api.together.xyz/v1',
  },
  xai: {
    name: 'xai',
    displayName: 'xAI (Grok)',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
  },
  google: {
    name: 'google',
    displayName: 'Google Gemini',
    compatible: true,
    locality: 'external',
    tier: 'frontier',
    requiresCredential: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
};

const PROVIDER_TYPE_ORDER = [
  'ollama',
  'ollama_cloud',
  'openrouter',
  'openai',
  'anthropic',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'xai',
  'google',
] as const;

export function getProviderTypeMetadata(providerType: string | undefined): ProviderTypeMetadata | undefined {
  if (!providerType) return undefined;
  return PROVIDER_TYPE_METADATA[providerType.trim().toLowerCase()];
}

export function listProviderTypeMetadata(): ProviderTypeMetadata[] {
  return PROVIDER_TYPE_ORDER
    .map((name) => PROVIDER_TYPE_METADATA[name])
    .filter((metadata): metadata is ProviderTypeMetadata => !!metadata);
}

export function getProviderLocality(providerType: string | undefined): ProviderLocality | undefined {
  return getProviderTypeMetadata(providerType)?.locality;
}

export function getProviderTier(providerType: string | undefined): ProviderTier | undefined {
  return getProviderTypeMetadata(providerType)?.tier;
}

export function getProviderPreferenceBucket(providerType: string | undefined): ProviderPreferenceBucket | undefined {
  const tier = getProviderTier(providerType);
  if (tier === 'local') return 'local';
  if (tier === 'managed_cloud') return 'managedCloud';
  if (tier === 'frontier') return 'frontier';
  return undefined;
}

export function providerRequiresCredential(providerType: string | undefined): boolean {
  return getProviderTypeMetadata(providerType)?.requiresCredential ?? true;
}

export function getDefaultBaseUrlForProviderType(providerType: string | undefined): string | undefined {
  return getProviderTypeMetadata(providerType)?.defaultBaseUrl;
}

export function isOllamaProviderType(providerType: string | undefined): boolean {
  const normalized = providerType?.trim().toLowerCase();
  return normalized === 'ollama' || normalized === 'ollama_cloud';
}

export function normalizeOllamaHost(baseUrl: string | undefined, providerType: string | undefined): string {
  const fallback = getDefaultBaseUrlForProviderType(providerType) ?? 'http://127.0.0.1:11434';
  const trimmed = (baseUrl?.trim() || fallback).replace(/\/$/, '');
  return trimmed.replace(/\/(?:api|v1)\/?$/i, '');
}

export function formatProviderTierLabel(tier: ProviderTier | undefined): string {
  switch (tier) {
    case 'local':
      return 'local';
    case 'managed_cloud':
      return 'managed cloud';
    case 'frontier':
      return 'frontier';
    default:
      return 'system';
  }
}
