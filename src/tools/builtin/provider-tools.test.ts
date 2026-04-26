import { describe, expect, it, vi } from 'vitest';

import { ToolRegistry } from '../registry.js';
import { registerBuiltinProviderTools } from './provider-tools.js';

describe('provider tools', () => {
  const runRegisteredTool = async (
    registry: ToolRegistry,
    toolName: string,
    args: Record<string, unknown>,
  ) => {
    const entry = registry.get(toolName);
    if (!entry) {
      throw new Error(`Tool '${toolName}' was not registered.`);
    }
    return entry.handler(args, {
      toolName,
      args,
      origin: 'cli',
    });
  };

  const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
      throw new Error(`${field} must be a string`);
    }
    return value;
  };

  it('lists configured providers with default and preferred flags', async () => {
    const registry = new ToolRegistry();
    registerBuiltinProviderTools({
      registry,
      requireString,
      listProviders: async () => [
        {
          name: 'ollama',
          type: 'ollama',
          model: 'gpt-oss:120b',
          locality: 'local',
          tier: 'local',
          connected: true,
          availableModels: ['gpt-oss:120b', 'gemma3:latest'],
          isDefault: true,
          isPreferredLocal: true,
        },
        {
          name: 'ollama-cloud',
          type: 'ollama_cloud',
          model: 'gpt-oss:120b',
          locality: 'external',
          tier: 'managed_cloud',
          connected: true,
          isPreferredManagedCloud: true,
        },
        {
          name: 'openai',
          type: 'openai',
          model: 'gpt-4o',
          locality: 'external',
          tier: 'frontier',
          connected: true,
          isPreferredFrontier: true,
        },
      ],
    });

    const result = await runRegisteredTool(registry, 'llm_provider_list', {});
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      providerCount: 3,
      providers: [
        expect.objectContaining({
          name: 'ollama',
          isDefault: true,
          isPreferredLocal: true,
        }),
        expect.objectContaining({
          name: 'ollama-cloud',
          isPreferredManagedCloud: true,
        }),
        expect.objectContaining({
          name: 'openai',
          isPreferredFrontier: true,
        }),
      ],
    });
  });

  it('validates model changes against the provider model list', async () => {
    const registry = new ToolRegistry();
    const updateConfig = vi.fn(async () => ({ success: true, message: 'updated' }));
    registerBuiltinProviderTools({
      registry,
      requireString,
      listProviders: async () => [{
        name: 'ollama',
        type: 'ollama',
        model: 'gpt-oss:120b',
        locality: 'local',
        tier: 'local',
        connected: true,
        availableModels: ['gpt-oss:120b', 'gemma3:latest'],
        isDefault: true,
      }],
      listModelsForProvider: async () => ['gpt-oss:120b', 'gemma3:latest'],
      updateConfig,
    });

    const bad = await runRegisteredTool(registry, 'llm_provider_update', {
      action: 'set_model',
      provider: 'ollama',
      model: 'missing-model',
    });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('missing-model');
    expect(updateConfig).not.toHaveBeenCalled();

    const ok = await runRegisteredTool(registry, 'llm_provider_update', {
      action: 'set_model',
      provider: 'ollama',
      model: 'gemma3:latest',
    });
    expect(ok.success).toBe(true);
    expect(updateConfig).toHaveBeenCalledWith({
      llm: {
        ollama: {
          model: 'gemma3:latest',
        },
      },
    });
  });

  it('updates the preferred managed-cloud provider bucket', async () => {
    const registry = new ToolRegistry();
    const updateConfig = vi.fn(async () => ({ success: true, message: 'updated' }));
    registerBuiltinProviderTools({
      registry,
      requireString,
      listProviders: async () => [{
        name: 'ollama-cloud',
        type: 'ollama_cloud',
        model: 'gpt-oss:120b',
        locality: 'external',
        tier: 'managed_cloud',
        connected: true,
      }],
      updateConfig,
    });

    const result = await runRegisteredTool(registry, 'llm_provider_update', {
      action: 'set_preferred',
      provider: 'ollama-cloud',
      locality: 'managed-cloud',
    });

    expect(result.success).toBe(true);
    expect(updateConfig).toHaveBeenCalledWith({
      assistant: {
        tools: {
          preferredProviders: {
            managedCloud: 'ollama-cloud',
          },
        },
      },
    });
  });
});
