import type { ConfigUpdate, DashboardMutationResult } from '../../channels/web-types.js';
import { ToolRegistry } from '../registry.js';

export interface ProviderToolInventoryItem {
  name: string;
  type: string;
  model: string;
  baseUrl?: string;
  locality: 'local' | 'external';
  connected: boolean;
  availableModels?: string[];
  isDefault?: boolean;
  isPreferredLocal?: boolean;
  isPreferredExternal?: boolean;
}

interface ProviderToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  listProviders?: () => Promise<ProviderToolInventoryItem[]>;
  listModelsForProvider?: (providerName: string) => Promise<string[]>;
  updateConfig?: (updates: ConfigUpdate) => Promise<DashboardMutationResult>;
}

function findProviderByName(
  providers: readonly ProviderToolInventoryItem[],
  providerName: string,
): ProviderToolInventoryItem | undefined {
  const normalized = providerName.trim();
  return providers.find((provider) => provider.name === normalized);
}

function buildProviderSummary(provider: ProviderToolInventoryItem | undefined): Record<string, unknown> | undefined {
  if (!provider) return undefined;
  return {
    name: provider.name,
    type: provider.type,
    model: provider.model,
    locality: provider.locality,
    connected: provider.connected,
    isDefault: !!provider.isDefault,
    isPreferredLocal: !!provider.isPreferredLocal,
    isPreferredExternal: !!provider.isPreferredExternal,
    ...(provider.availableModels?.length ? { availableModels: provider.availableModels } : {}),
  };
}

export function registerBuiltinProviderTools(context: ProviderToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'llm_provider_list',
      description: 'List configured LLM provider profiles, including provider type, active model, locality, connectivity, default/preferred routing flags, and any discovered available models.',
      shortDescription: 'List configured LLM providers and their active models.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Optional configured provider profile name to filter to one provider.',
          },
        },
      },
      examples: [
        { input: {}, description: 'List all configured LLM provider profiles' },
        { input: { provider: 'ollama' }, description: 'Show one configured provider profile' },
      ],
    },
    async (args) => {
      if (!context.listProviders) {
        return { success: false, error: 'LLM provider inspection is not available in this runtime.' };
      }
      const providers = await context.listProviders();
      const providerFilter = typeof args.provider === 'string' ? args.provider.trim() : '';
      const filtered = providerFilter
        ? providers.filter((provider) => provider.name === providerFilter)
        : providers;
      if (providerFilter && filtered.length === 0) {
        return { success: false, error: `Provider '${providerFilter}' is not configured.` };
      }
      return {
        success: true,
        output: {
          providerCount: filtered.length,
          providers: filtered,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'llm_provider_models',
      description: 'Load and list the available models for one configured LLM provider profile. Use this before changing the active model.',
      shortDescription: 'List available models for one configured LLM provider.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Configured provider profile name to inspect.',
          },
        },
        required: ['provider'],
      },
      examples: [
        { input: { provider: 'ollama' }, description: 'List available models for the Ollama profile' },
      ],
    },
    async (args) => {
      if (!context.listProviders || !context.listModelsForProvider) {
        return { success: false, error: 'LLM model discovery is not available in this runtime.' };
      }
      const providerName = context.requireString(args.provider, 'provider').trim();
      const providers = await context.listProviders();
      const provider = findProviderByName(providers, providerName);
      if (!provider) {
        return { success: false, error: `Provider '${providerName}' is not configured.` };
      }
      const models = await context.listModelsForProvider(providerName);
      return {
        success: true,
        output: {
          provider: providerName,
          activeModel: provider.model,
          locality: provider.locality,
          connected: provider.connected,
          modelCount: models.length,
          models,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'llm_provider_update',
      description: 'Update configured LLM provider settings. Supports switching the active model on an existing provider profile, changing the default provider, or choosing the preferred local/external provider profile used by smart routing. Always requires user approval.',
      shortDescription: 'Switch models or preferred/default LLM providers.',
      risk: 'external_post',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Update action: set_model, set_default, or set_preferred.',
          },
          provider: {
            type: 'string',
            description: 'Configured provider profile name to update or select.',
          },
          model: {
            type: 'string',
            description: 'Required when action=set_model. Must be available for the selected provider.',
          },
          locality: {
            type: 'string',
            description: 'Required when action=set_preferred. Must be local or external.',
          },
        },
        required: ['action', 'provider'],
      },
      examples: [
        { input: { action: 'set_model', provider: 'ollama', model: 'gemma3:latest' }, description: 'Switch a configured provider profile to another available model' },
        { input: { action: 'set_default', provider: 'openai' }, description: 'Set the default provider profile' },
        { input: { action: 'set_preferred', provider: 'ollama', locality: 'local' }, description: 'Set the preferred local provider profile' },
      ],
    },
    async (args) => {
      if (!context.listProviders || !context.updateConfig) {
        return { success: false, error: 'LLM provider updates are not available in this runtime.' };
      }
      const action = context.requireString(args.action, 'action').trim();
      const providerName = context.requireString(args.provider, 'provider').trim();
      const providers = await context.listProviders();
      const provider = findProviderByName(providers, providerName);
      if (!provider) {
        return { success: false, error: `Provider '${providerName}' is not configured.` };
      }

      let patch: ConfigUpdate | null = null;
      let successMessage = '';

      switch (action) {
        case 'set_model': {
          if (!context.listModelsForProvider) {
            return { success: false, error: 'Model switching is not available in this runtime.' };
          }
          const model = context.requireString(args.model, 'model').trim();
          if (!model) {
            return { success: false, error: 'model is required for set_model.' };
          }
          const models = await context.listModelsForProvider(providerName);
          if (!models.includes(model)) {
            return {
              success: false,
              error: `Model '${model}' is not available for provider '${providerName}'. Available models: ${models.join(', ') || '(none)'}.`,
            };
          }
          if (provider.model === model) {
            return {
              success: true,
              output: {
                message: `Provider '${providerName}' already uses model '${model}'.`,
                provider: buildProviderSummary(provider),
              },
            };
          }
          patch = {
            llm: {
              [providerName]: {
                model,
              },
            },
          };
          successMessage = `Updated provider '${providerName}' to model '${model}'.`;
          break;
        }
        case 'set_default': {
          if (provider.isDefault) {
            return {
              success: true,
              output: {
                message: `Provider '${providerName}' is already the default provider.`,
                provider: buildProviderSummary(provider),
              },
            };
          }
          patch = { defaultProvider: providerName };
          successMessage = `Set default provider to '${providerName}'.`;
          break;
        }
        case 'set_preferred': {
          const locality = context.requireString(args.locality, 'locality').trim().toLowerCase();
          if (locality !== 'local' && locality !== 'external') {
            return { success: false, error: `Invalid locality '${locality}'. Use local or external.` };
          }
          if (provider.locality !== locality) {
            return {
              success: false,
              error: `Provider '${providerName}' is ${provider.locality}, so it cannot be set as the preferred ${locality} provider.`,
            };
          }
          const alreadyPreferred = locality === 'local' ? provider.isPreferredLocal : provider.isPreferredExternal;
          if (alreadyPreferred) {
            return {
              success: true,
              output: {
                message: `Provider '${providerName}' is already the preferred ${locality} provider.`,
                provider: buildProviderSummary(provider),
              },
            };
          }
          patch = {
            assistant: {
              tools: {
                preferredProviders: {
                  [locality]: providerName,
                },
              },
            },
          };
          successMessage = `Set preferred ${locality} provider to '${providerName}'.`;
          break;
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Use set_model, set_default, or set_preferred.` };
      }

      const updateResult = await context.updateConfig(patch);
      if (!updateResult.success) {
        return { success: false, error: updateResult.message };
      }

      const refreshedProviders = await context.listProviders();
      const refreshedProvider = findProviderByName(refreshedProviders, providerName);
      return {
        success: true,
        output: {
          message: successMessage,
          provider: buildProviderSummary(refreshedProvider),
        },
      };
    },
  );
}
