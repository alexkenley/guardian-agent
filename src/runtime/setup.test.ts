import { describe, expect, it } from 'vitest';
import { evaluateSetupStatus } from './setup.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type { DashboardProviderInfo } from '../channels/web-types.js';
import type { SandboxHealth } from '../sandbox/types.js';

const providers: DashboardProviderInfo[] = [
  {
    name: DEFAULT_CONFIG.defaultProvider,
    type: DEFAULT_CONFIG.llm[DEFAULT_CONFIG.defaultProvider]?.provider ?? 'ollama',
    model: DEFAULT_CONFIG.llm[DEFAULT_CONFIG.defaultProvider]?.model ?? 'unknown',
    locality: 'local',
    connected: true,
  },
];

describe('evaluateSetupStatus', () => {
  it('reports strict sandbox blocking guidance when no strong backend is available', () => {
    const sandboxHealth: SandboxHealth = {
      enabled: true,
      platform: 'win32',
      availability: 'unavailable',
      backend: 'env',
      enforcementMode: 'strict',
      reasons: ['No native Windows sandbox helper is available.'],
    };

    const status = evaluateSetupStatus(DEFAULT_CONFIG, providers, sandboxHealth);
    const sandboxStep = status.steps.find((step) => step.id === 'sandbox');

    expect(sandboxStep?.status).toBe('warning');
    expect(sandboxStep?.detail).toContain('Strict mode is active');
    expect(sandboxStep?.detail).toContain('Linux/Unix with bubblewrap');
    expect(sandboxStep?.detail).toContain('Windows portable app with the AppContainer helper');
  });

  it('warns when permissive sandbox mode is explicitly enabled', () => {
    const sandboxHealth: SandboxHealth = {
      enabled: true,
      platform: 'win32',
      availability: 'unavailable',
      backend: 'env',
      enforcementMode: 'permissive',
      reasons: ['No native Windows sandbox helper is available.'],
    };

    const permissiveConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          sandbox: {
            ...DEFAULT_CONFIG.assistant.tools.sandbox,
            enforcementMode: 'permissive' as const,
          },
        },
      },
    };

    const status = evaluateSetupStatus(permissiveConfig, providers, sandboxHealth);
    const sandboxStep = status.steps.find((step) => step.id === 'sandbox');

    expect(sandboxStep?.status).toBe('warning');
    expect(sandboxStep?.detail).toContain('Permissive mode is explicitly enabled');
    expect(sandboxStep?.detail).toContain('higher host risk');
  });
});
