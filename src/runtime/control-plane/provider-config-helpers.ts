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
}

export function createProviderConfigHelpers(options: ProviderConfigHelperOptions) {
  const describeProvider = (name: string, provider: LLMProvider): DashboardProviderInfo => {
    const llmConfig = options.configRef.current.llm[name];
    const isLocal = options.isLocalProviderEndpoint(llmConfig?.baseUrl, provider.name);
    return {
      name,
      type: provider.name,
      model: llmConfig?.model ?? 'unknown',
      baseUrl: llmConfig?.baseUrl,
      locality: isLocal ? 'local' : 'external',
      tier: getProviderTier(provider.name) ?? (isLocal ? 'local' : 'frontier'),
      connected: false,
    };
  };

  const getProviderInfoSnapshot = (): DashboardProviderInfo[] => {
    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of options.runtimeProviders) {
      results.push(describeProvider(name, provider));
    }
    return results;
  };

  const buildProviderInfo = async (withConnectivity: boolean): Promise<DashboardProviderInfo[]> => {
    if (!withConnectivity) {
      return getProviderInfoSnapshot();
    }

    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of options.runtimeProviders) {
      const info = describeProvider(name, provider);
      try {
        const models = await provider.listModels();
        info.connected = true;
        if (models.length > 0) {
          info.availableModels = models.map((model) => model.id);
        }
      } catch {
        info.connected = false;
      }
      results.push(info);
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
      case 'ollama': return 'llama3.2';
      case 'ollama_cloud': return 'gpt-oss:120b';
      case 'openrouter': return 'qwen/qwen3.6-plus';
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
