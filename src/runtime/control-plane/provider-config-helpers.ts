import type { DashboardProviderInfo } from '../../channels/web-types.js';
import type { GuardianAgentConfig } from '../../config/types.js';
import type { LLMProvider } from '../../llm/types.js';
import { getDefaultBaseUrlForProviderType, getProviderTier } from '../../llm/provider-metadata.js';
import { resolveRuntimeCredentialView } from '../credentials.js';
import type { LocalSecretStore } from '../secret-store.js';

interface ProviderConfigHelperOptions {
  configRef: { current: GuardianAgentConfig };
  runtimeProviders: ReadonlyMap<string, LLMProvider>;
  secretStore: LocalSecretStore;
  isLocalProviderEndpoint: (baseUrl: string | undefined, providerType: string | undefined) => boolean;
  providerHealthCacheTtlMs?: number;
}

export function createProviderConfigHelpers(options: ProviderConfigHelperOptions) {
  const providerHealth = new Map<string, Pick<DashboardProviderInfo, 'connected' | 'healthChecked' | 'healthCheckedAt' | 'availableModels'>>();
  const providerHealthChecks = new Map<string, Promise<Pick<DashboardProviderInfo, 'connected' | 'healthChecked' | 'healthCheckedAt' | 'availableModels'>>>();
  const providerHealthCacheTtlMs = options.providerHealthCacheTtlMs ?? 10 * 60 * 1000;

  const describeProvider = (name: string, provider: LLMProvider): DashboardProviderInfo => {
    const llmConfig = options.configRef.current.llm[name];
    const isLocal = options.isLocalProviderEndpoint(llmConfig?.baseUrl, provider.name);
    const health = providerHealth.get(name);
    return {
      name,
      type: provider.name,
      model: llmConfig?.model ?? 'unknown',
      baseUrl: llmConfig?.baseUrl,
      locality: isLocal ? 'local' : 'external',
      tier: getProviderTier(provider.name) ?? (isLocal ? 'local' : 'frontier'),
      connected: health?.connected ?? false,
      ...(health?.healthChecked ? { healthChecked: true } : {}),
      ...(typeof health?.healthCheckedAt === 'number' ? { healthCheckedAt: health.healthCheckedAt } : {}),
      ...(health?.availableModels ? { availableModels: health.availableModels } : {}),
    };
  };

  const getProviderInfoSnapshot = (): DashboardProviderInfo[] => {
    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of options.runtimeProviders) {
      results.push(describeProvider(name, provider));
    }
    return results;
  };

  const refreshProviderHealth = async (
    name: string,
    provider: LLMProvider,
  ): Promise<Pick<DashboardProviderInfo, 'connected' | 'healthChecked' | 'healthCheckedAt' | 'availableModels'>> => {
    const checkedAt = Date.now();
    let health: Pick<DashboardProviderInfo, 'connected' | 'healthChecked' | 'healthCheckedAt' | 'availableModels'>;
    try {
      const models = await provider.listModels();
      health = {
        connected: true,
        healthChecked: true,
        healthCheckedAt: checkedAt,
        ...(models.length > 0 ? { availableModels: models.map((model) => model.id) } : {}),
      };
    } catch {
      health = {
        connected: false,
        healthChecked: true,
        healthCheckedAt: checkedAt,
      };
    }
    providerHealth.set(name, health);
    return health;
  };

  const isFreshHealth = (
    health: Pick<DashboardProviderInfo, 'healthChecked' | 'healthCheckedAt'> | undefined,
    now: number,
  ): boolean => !!health?.healthChecked
    && typeof health.healthCheckedAt === 'number'
    && now - health.healthCheckedAt < providerHealthCacheTtlMs;

  const buildProviderInfo = async (
    withConnectivity: boolean,
    healthOptions: { force?: boolean } = {},
  ): Promise<DashboardProviderInfo[]> => {
    if (!withConnectivity) {
      return getProviderInfoSnapshot();
    }

    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of options.runtimeProviders) {
      const cached = providerHealth.get(name);
      if (healthOptions.force !== true && isFreshHealth(cached, Date.now())) {
        results.push(describeProvider(name, provider));
        continue;
      }
      let healthCheck = providerHealthChecks.get(name);
      if (!healthCheck) {
        healthCheck = refreshProviderHealth(name, provider);
        providerHealthChecks.set(name, healthCheck);
        healthCheck.finally(() => {
          if (providerHealthChecks.get(name) === healthCheck) {
            providerHealthChecks.delete(name);
          }
        }).catch(() => undefined);
      }
      await healthCheck;
      results.push(describeProvider(name, provider));
    }
    return results;
  };

  const existingProfilesById = (rawCloud: Record<string, unknown>, key: string): Map<string, Record<string, unknown>> => {
    const profiles = Array.isArray(rawCloud[key]) ? rawCloud[key] : [];
    return new Map(
      profiles
        .filter((profile): profile is Record<string, unknown> => typeof profile === 'object' && profile !== null)
        .map((profile) => [typeof profile.id === 'string' ? profile.id : '', profile] as const)
        .filter(([id]) => !!id),
    );
  };

  const getDefaultModelForProviderType = (providerType: string): string => {
    switch (providerType.trim().toLowerCase()) {
      case 'ollama': return 'gpt-oss:120b';
      case 'ollama_cloud': return 'gpt-oss:120b';
      case 'openrouter': return 'qwen/qwen3.6-plus';
      case 'nvidia': return 'qwen/qwen3-coder-480b-a35b-instruct';
      case 'anthropic': return 'claude-sonnet-4-6';
      case 'openai': return 'gpt-4o';
      case 'groq': return 'llama-3.3-70b-versatile';
      case 'mistral': return 'mistral-large-latest';
      case 'deepseek': return 'deepseek-chat';
      case 'together': return 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
      case 'xai': return 'grok-4-1-fast-reasoning';
      case 'google': return 'gemini-2.0-flash';
      default: return 'provider-model';
    }
  };

  const resolveCredentialForProviderInput = (
    credentialRef: string | undefined,
    apiKey: string | undefined,
  ): string | undefined => {
    const direct = apiKey?.trim();
    if (direct) return direct;
    const ref = credentialRef?.trim();
    if (!ref) return undefined;
    const runtimeCredentials = resolveRuntimeCredentialView(options.configRef.current, options.secretStore);
    return runtimeCredentials.credentialProvider.resolve(ref);
  };

  return {
    existingProfilesById,
    getProviderInfoSnapshot,
    buildProviderInfo,
    getDefaultModelForProviderType,
    getDefaultBaseUrlForProviderType,
    resolveCredentialForProviderInput,
  };
}
