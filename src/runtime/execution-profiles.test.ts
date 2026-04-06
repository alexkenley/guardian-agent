import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import {
  attachSelectedExecutionProfileMetadata,
  readSelectedExecutionProfileMetadata,
  selectExecutionProfile,
} from './execution-profiles.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

function createConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud'] = {
    provider: 'ollama_cloud',
    model: 'qwen3-coder-next',
    credentialRef: 'llm.ollama_cloud.primary',
  };
  config.llm.anthropic = {
    provider: 'anthropic',
    model: 'claude-opus-4.6',
    apiKey: 'test-key',
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud',
    frontier: 'anthropic',
  };
  return config;
}

function createGatewayDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect the repo change.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

describe('execution profiles', () => {
  it('prefers managed cloud for lower-pressure external work in balanced auto mode', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        route: 'email_task',
        operation: 'read',
        executionClass: 'provider_crud',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'tool_loop',
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
      toolContextMode: 'tight',
    });
    expect(profile?.fallbackProviderOrder).toEqual(['ollama-cloud', 'anthropic', 'ollama']);
  });

  it('prefers frontier for heavier repo-grounded synthesis in balanced auto mode', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
      id: 'frontier_deep',
      preferredAnswerPath: 'chat_synthesis',
      expectedContextPressure: 'high',
    });
    expect(profile?.fallbackProviderOrder).toEqual(['anthropic', 'ollama-cloud', 'ollama']);
  });

  it('round-trips execution profile metadata through message metadata', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
    });
    expect(profile).toBeTruthy();

    const metadata = attachSelectedExecutionProfileMetadata({ existing: true }, profile);
    expect(readSelectedExecutionProfileMetadata(metadata)).toEqual(profile);
  });
});
