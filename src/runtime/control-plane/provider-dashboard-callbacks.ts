import type { DashboardCallbacks, DashboardProviderInfo } from '../../channels/web-types.js';
import type { LLMConfig } from '../../config/types.js';
import { getProviderRegistry } from '../../llm/provider.js';

type ProviderDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onProviders'
  | 'onProviderTypes'
  | 'onProvidersStatus'
  | 'onProviderModels'
>;

interface ProviderRegistryLike {
  listProviderTypes(): Array<{
    name: string;
    displayName: string;
    compatible: boolean;
  }>;
  hasProvider(name: string): boolean;
  createProvider(config: LLMConfig): {
    listModels(): Promise<Array<{ id: string }>>;
  };
}

interface ProviderDashboardCallbackOptions {
  getProviderInfoSnapshot: () => DashboardProviderInfo[];
  buildProviderInfo: (withConnectivity: boolean) => Promise<DashboardProviderInfo[]>;
  resolveCredentialForProviderInput: (credentialRef: string | undefined, apiKey: string | undefined) => string | undefined;
  getDefaultModelForProviderType: (providerType: string) => string;
  isLocalProviderEndpoint: (baseUrl: string | undefined, providerType: string | undefined) => boolean;
  providerRegistry?: ProviderRegistryLike;
}

export function createProviderDashboardCallbacks(
  options: ProviderDashboardCallbackOptions,
): ProviderDashboardCallbacks {
  const providerRegistry = options.providerRegistry ?? getProviderRegistry();

  return {
    onProviders: () => options.getProviderInfoSnapshot(),

    onProviderTypes: () => providerRegistry.listProviderTypes().map((type) => ({
      ...type,
      locality: options.isLocalProviderEndpoint(undefined, type.name) ? 'local' : 'external',
    })),

    onProvidersStatus: async () => options.buildProviderInfo(true),

    onProviderModels: async (input) => {
      const providerType = input.providerType.trim().toLowerCase();
      if (!providerRegistry.hasProvider(providerType)) {
        throw new Error(`Unknown provider type '${providerType}'`);
      }

      const apiKey = options.resolveCredentialForProviderInput(input.credentialRef, input.apiKey);
      const providerConfig: LLMConfig = {
        provider: providerType,
        model: input.model?.trim() || options.getDefaultModelForProviderType(providerType),
        baseUrl: input.baseUrl?.trim() || undefined,
        apiKey,
      };

      if (providerType !== 'ollama' && !providerConfig.apiKey) {
        throw new Error('Provide an API key or credential ref to load models for this provider.');
      }

      const models = await providerRegistry.createProvider(providerConfig).listModels();
      return {
        models: models.map((model) => model.id),
      };
    },
  };
}
