import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import { createConfigStateHelpers } from './config-state-helpers.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

describe('createConfigStateHelpers', () => {
  it('normalizes credential ref updates and stores local secrets', () => {
    const secretStore = {
      set: vi.fn(),
      delete: vi.fn(),
    };
    const helpers = createConfigStateHelpers({
      configRef: { current: createConfig() },
      loadRawConfig: () => ({}),
      persistAndApplyConfig: () => ({ success: true, message: 'ok' }),
      secretStore,
      connectors: { getConfig: () => ({}) },
    });

    const normalized = helpers.normalizeCredentialRefUpdates({
      '  env-ref  ': {
        source: 'env',
        env: '  OPENAI_API_KEY  ',
        description: '  External key  ',
      },
      'local-ref': {
        source: 'local',
        secretId: 'secret-1',
        secretValue: '  shh  ',
        description: '  Saved secret  ',
      },
      'ignored-ref': {
        source: 'env',
        env: '   ',
      },
    });

    expect(normalized).toEqual({
      'env-ref': {
        source: 'env',
        env: 'OPENAI_API_KEY',
        description: 'External key',
      },
      'local-ref': {
        source: 'local',
        secretId: 'secret-1',
        description: 'Saved secret',
      },
    });
    expect(secretStore.set).toHaveBeenCalledWith('secret-1', 'shh');
  });

  it('persists tool policy state into raw config through persistAndApplyConfig', () => {
    const rawConfig = { assistant: { tools: { existing: true } } };
    const persistAndApplyConfig = vi.fn(() => ({ success: true, message: 'persisted' }));
    const config = createConfig();
    config.assistant.tools.providerRouting = { browser: 'external' };
    config.assistant.tools.disabledCategories = ['browser'];
    const helpers = createConfigStateHelpers({
      configRef: { current: config },
      loadRawConfig: () => structuredClone(rawConfig),
      persistAndApplyConfig,
      secretStore: {
        set: vi.fn(),
        delete: vi.fn(),
      },
      connectors: { getConfig: () => ({}) },
    });

    helpers.persistToolsState({
      mode: 'approve_by_policy',
      toolPolicies: { shell_exec: 'deny' },
      sandbox: {
        allowedPaths: ['/workspace'],
        allowedCommands: ['npm test'],
        allowedDomains: ['example.test'],
      },
    });

    expect(persistAndApplyConfig).toHaveBeenCalledOnce();
    expect(persistAndApplyConfig).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({
        tools: expect.objectContaining({
          existing: true,
          policyMode: 'approve_by_policy',
          toolPolicies: { shell_exec: 'deny' },
          allowedPaths: ['/workspace'],
          allowedCommands: ['npm test'],
          allowedDomains: ['example.test'],
          providerRouting: { browser: 'external' },
          disabledCategories: ['browser'],
        }),
      }),
    }), {
      changedBy: 'tools-control-plane',
      reason: 'tool policy update',
    });
  });
});
