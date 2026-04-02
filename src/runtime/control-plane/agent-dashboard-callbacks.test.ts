import { describe, expect, it, vi } from 'vitest';

import { AgentState, type AgentInstance } from '../../agent/types.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig, type LLMConfig } from '../../config/types.js';
import { createAgentDashboardCallbacks } from './agent-dashboard-callbacks.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createAgentInstance(overrides: Partial<AgentInstance> & Pick<AgentInstance, 'agent' | 'definition'>): AgentInstance {
  return {
    state: AgentState.Ready,
    lastActivityMs: 1000,
    consecutiveErrors: 0,
    retryAfterMs: 0,
    ...overrides,
  };
}

describe('createAgentDashboardCallbacks', () => {
  it('maps runtime agents into dashboard agent summaries and details', () => {
    const config = createConfig();
    config.defaultProvider = 'local-provider';
    config.llm['local-provider'] = {
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://127.0.0.1:11434',
    } as LLMConfig;
    config.llm.research = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    } as LLMConfig;

    const instances: AgentInstance[] = [
      createAgentInstance({
        agent: {
          id: 'local-agent',
          name: 'Local Lane',
          capabilities: { handleMessages: true, handleEvents: false, handleSchedule: false },
        },
        definition: {
          agent: {
            id: 'local-agent',
            name: 'Local Lane',
            capabilities: { handleMessages: true, handleEvents: false, handleSchedule: false },
          },
          grantedCapabilities: ['read_files'],
          providerName: undefined,
          resourceLimits: {
            maxInvocationBudgetMs: 10,
            maxTokensPerMinute: 20,
            maxConcurrentTools: 1,
            maxQueueDepth: 2,
          },
        },
      }),
      createAgentInstance({
        agent: {
          id: 'security-triage',
          name: 'Security Triage',
          capabilities: { handleMessages: true, handleEvents: true, handleSchedule: false },
        },
        definition: {
          agent: {
            id: 'security-triage',
            name: 'Security Triage',
            capabilities: { handleMessages: true, handleEvents: true, handleSchedule: false },
          },
          grantedCapabilities: ['security_audit'],
          providerName: 'research',
          resourceLimits: {
            maxInvocationBudgetMs: 30,
            maxTokensPerMinute: 40,
            maxConcurrentTools: 2,
            maxQueueDepth: 3,
          },
        },
        consecutiveErrors: 2,
      }),
    ];

    const callbacks = createAgentDashboardCallbacks({
      configRef: { current: config },
      runtimeRegistry: {
        getAll: () => instances,
        get: (agentId: string) => instances.find((instance) => instance.agent.id === agentId),
      },
      router: {
        findAgentByRole: vi.fn((role: string) => {
          if (role === 'local') return { id: 'local-agent' };
          return undefined;
        }),
      } as never,
      getProviderLocality: (llmCfg) => (llmCfg?.provider === 'ollama' ? 'local' : 'external'),
      internalAgentIds: new Set(['security-triage']),
    });

    expect(callbacks.onAgents?.()).toEqual([
      {
        id: 'local-agent',
        name: 'Local Lane',
        state: AgentState.Ready,
        canChat: true,
        internal: true,
        routingRole: 'local',
        capabilities: ['read_files'],
        provider: 'local-provider',
        providerType: 'ollama',
        providerModel: 'llama3.2',
        providerLocality: 'local',
        schedule: undefined,
        lastActivityMs: 1000,
        consecutiveErrors: 0,
      },
      {
        id: 'security-triage',
        name: 'Security Triage',
        state: AgentState.Ready,
        canChat: true,
        internal: true,
        capabilities: ['security_audit'],
        provider: 'research',
        providerType: 'anthropic',
        providerModel: 'claude-sonnet-4-6',
        providerLocality: 'external',
        schedule: undefined,
        lastActivityMs: 1000,
        consecutiveErrors: 2,
      },
    ]);

    expect(callbacks.onAgentDetail?.('security-triage')).toEqual({
      id: 'security-triage',
      name: 'Security Triage',
      state: AgentState.Ready,
      canChat: true,
      internal: true,
      capabilities: ['security_audit'],
      provider: 'research',
      providerType: 'anthropic',
      providerModel: 'claude-sonnet-4-6',
      providerLocality: 'external',
      schedule: undefined,
      lastActivityMs: 1000,
      consecutiveErrors: 2,
      resourceLimits: {
        maxInvocationBudgetMs: 30,
        maxTokensPerMinute: 40,
        maxConcurrentTools: 2,
        maxQueueDepth: 3,
      },
    });
  });
});
