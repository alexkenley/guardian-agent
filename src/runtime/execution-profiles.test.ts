import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import {
  attachSelectedExecutionProfileMetadata,
  readSelectedExecutionProfileMetadata,
  resolveDelegatedExecutionDecision,
  selectEscalatedDelegatedExecutionProfile,
  selectDelegatedExecutionProfile,
  selectExecutionProfile,
} from './execution-profiles.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

function createConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud-general'] = {
    provider: 'ollama_cloud',
    model: 'gpt-oss:120b',
    credentialRef: 'llm.ollama_cloud.primary',
  };
  config.llm['ollama-cloud-tools'] = {
    provider: 'ollama_cloud',
    model: 'qwen3:32b',
    credentialRef: 'llm.ollama_cloud.tools',
  };
  config.llm['ollama-cloud-direct'] = {
    provider: 'ollama_cloud',
    model: 'minimax-m2.1',
    credentialRef: 'llm.ollama_cloud.direct',
  };
  config.llm['ollama-cloud-coding'] = {
    provider: 'ollama_cloud',
    model: 'qwen3-coder-next',
    credentialRef: 'llm.ollama_cloud.coding',
  };
  config.llm.anthropic = {
    provider: 'anthropic',
    model: 'claude-opus-4.6',
    apiKey: 'test-key',
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud-general',
    frontier: 'anthropic',
  };
  config.assistant.tools.modelSelection = {
    ...(config.assistant.tools.modelSelection || {}),
    autoPolicy: 'balanced',
    preferManagedCloudForLowPressureExternal: true,
    preferFrontierForRepoGrounded: true,
    preferFrontierForSecurity: true,
    managedCloudRouting: {
      enabled: true,
      roleBindings: {
        general: 'ollama-cloud-general',
        direct: 'ollama-cloud-direct',
        toolLoop: 'ollama-cloud-tools',
        coding: 'ollama-cloud-coding',
      },
    },
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
      providerName: 'ollama-cloud-tools',
      providerModel: 'qwen3:32b',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
      toolContextMode: 'tight',
    });
    expect(profile?.fallbackProviderOrder).toEqual([
      'ollama-cloud-tools',
      'anthropic',
      'ollama',
      'ollama-cloud-general',
      'ollama-cloud-coding',
      'ollama-cloud-direct',
    ]);
  });

  it('direct reasoning tasks use managed cloud instead of frontier in balanced auto mode', () => {
    // Repo-inspection with inspect operation uses direct reasoning mode
    // (iterative tool loop), so managed cloud is adequate — no frontier
    // preference needed.
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerTier: 'managed_cloud',
      expectedContextPressure: 'high',
    });
  });

  it('does not treat repo inspections with structured write steps as direct reasoning', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        requiresToolSynthesis: false,
        plannedSteps: [
          { kind: 'search', summary: 'Search src/runtime for planned_steps.', required: true },
          {
            kind: 'write',
            summary: 'Write a grounded summary to tmp/manual-web/planned-steps-summary.txt.',
            expectedToolCategories: ['fs_write'],
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
    });
  });

  it('prefers frontier for non-inspect repo-grounded chat_synthesis in balanced auto mode', () => {
    // When a repo-grounded task goes through the delegated pipeline (e.g.,
    // chat_synthesis without inspect operation), frontier preference applies.
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        operation: 'create',
        executionClass: 'tool_orchestration',
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
    });
  });

  it('still uses managed cloud for low-confidence repo-grounded coding inspection in balanced auto mode', () => {
    // Even with low confidence, inspect operations use direct reasoning
    // mode (iterative tool loop), so managed cloud is sufficient.
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        confidence: 'low',
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerTier: 'managed_cloud',
      expectedContextPressure: 'high',
    });
  });

  it('does not prefer frontier for repo-inspection (direct reasoning) in balanced auto mode', () => {
    // Repo-inspection uses direct reasoning mode (iterative tool loop),
    // so managed cloud is adequate — no need to escalate to frontier.
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        operation: 'inspect',
        executionClass: 'repo_grounded',
        requiresRepoGrounding: true,
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerTier: 'managed_cloud',
    });
  });

  it('still prefers frontier for delegated repo-grounded tasks with chat_synthesis answer path', () => {
    // Non-inspect repo-grounded tasks (e.g., security analysis) still
    // go through the delegated pipeline and should still prefer frontier.
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        executionClass: 'security_analysis',
        requiresRepoGrounding: true,
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerTier: 'frontier',
    });
  });

  it('uses the managed-cloud coding profile when managed-cloud-only mode forces coding through that tier', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'managed-cloud-only',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-coding',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
  });

  it('uses OpenRouter role bindings when the OpenRouter managed-cloud family is selected', () => {
    const config = createConfig();
    config.llm['openrouter-general'] = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-plus',
      credentialRef: 'llm.openrouter.primary',
    };
    config.llm['openrouter-coding'] = {
      provider: 'openrouter',
      model: 'qwen/qwen3.6-coder',
      credentialRef: 'llm.openrouter.primary',
    };
    config.assistant.tools.preferredProviders = {
      ...config.assistant.tools.preferredProviders,
      managedCloud: 'openrouter',
    };
    config.assistant.tools.modelSelection = {
      ...(config.assistant.tools.modelSelection || {}),
      managedCloudRouting: {
        enabled: true,
        providerRoleBindings: {
          ollama_cloud: {
            coding: 'ollama-cloud-coding',
          },
          openrouter: {
            general: 'openrouter-general',
            coding: 'openrouter-coding',
          },
        },
        roleBindings: {
          coding: 'ollama-cloud-coding',
        },
      },
    };

    const profile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'managed-cloud-only',
    });

    expect(profile).toMatchObject({
      providerName: 'openrouter-coding',
      providerModel: 'qwen/qwen3.6-coder',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
    expect(profile?.reason).toContain("managed-cloud role 'coding' selected provider 'openrouter-coding'");
  });

  it('uses NVIDIA Cloud role bindings when the NVIDIA managed-cloud family is selected', () => {
    const config = createConfig();
    config.llm['nvidia-general'] = {
      provider: 'nvidia',
      model: 'qwen/qwen3-5-122b-a10b',
      credentialRef: 'llm.nvidia.primary',
    };
    config.llm['nvidia-coding'] = {
      provider: 'nvidia',
      model: 'qwen/qwen3-coder-480b-a35b-instruct',
      credentialRef: 'llm.nvidia.primary',
    };
    config.assistant.tools.preferredProviders = {
      ...config.assistant.tools.preferredProviders,
      managedCloud: 'nvidia',
    };
    config.assistant.tools.modelSelection = {
      ...(config.assistant.tools.modelSelection || {}),
      managedCloudRouting: {
        enabled: true,
        providerRoleBindings: {
          nvidia: {
            general: 'nvidia-general',
            coding: 'nvidia-coding',
          },
        },
      },
    };

    const profile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'managed-cloud-only',
    });

    expect(profile).toMatchObject({
      providerName: 'nvidia-coding',
      providerModel: 'qwen/qwen3-coder-480b-a35b-instruct',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
    expect(profile?.reason).toContain("managed-cloud role 'coding' selected provider 'nvidia-coding'");
  });

  it('uses the managed-cloud coding profile for explicit remote sandbox runs in balanced auto mode', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
          command: 'pwd',
        },
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-coding',
      providerModel: 'qwen3-coder-next',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
    expect(profile?.reason).toContain("managed-cloud role 'coding' selected provider 'ollama-cloud-coding'");
  });

  it('uses the managed-cloud direct profile for direct-assistant personal work even when the gateway prefers tool_loop', () => {
    const config = createConfig();
    config.llm.ollama.enabled = false;

    const profile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'local' },
      gatewayDecision: createGatewayDecision({
        route: 'personal_assistant_task',
        operation: 'create',
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-direct',
      providerModel: 'minimax-m2.1',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
  });

  it('falls back to the general managed-cloud profile when a specific role binding is unset', () => {
    const config = createConfig();
    config.assistant.tools.modelSelection = {
      ...(config.assistant.tools.modelSelection || {}),
      managedCloudRouting: {
        enabled: true,
        roleBindings: {
          general: 'ollama-cloud-general',
        },
      },
    };

    const profile = selectExecutionProfile({
      config,
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
      providerName: 'ollama-cloud-general',
      providerTier: 'managed_cloud',
    });
  });

  it('infers a managed-cloud role provider from profile names when no role bindings are configured', () => {
    const config = createConfig();
    config.assistant.tools.modelSelection = {
      ...(config.assistant.tools.modelSelection || {}),
      managedCloudRouting: {
        enabled: true,
        roleBindings: {},
      },
    };

    const profile = selectExecutionProfile({
      config,
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
      providerName: 'ollama-cloud-tools',
      providerTier: 'managed_cloud',
    });
  });

  it('falls back to the preferred managed-cloud provider when managed-cloud role routing is disabled', () => {
    const config = createConfig();
    config.assistant.tools.modelSelection = {
      ...(config.assistant.tools.modelSelection || {}),
      managedCloudRouting: {
        enabled: false,
        roleBindings: {
          general: 'ollama-cloud-general',
          toolLoop: 'ollama-cloud-tools',
          coding: 'ollama-cloud-coding',
        },
      },
    };

    const profile = selectExecutionProfile({
      config,
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
      providerName: 'ollama-cloud-general',
      providerTier: 'managed_cloud',
    });
  });

  it('falls back to the general managed-cloud profile for low-confidence unknown turns', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        executionClass: 'direct_assistant',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'tool_loop',
      }),
      mode: 'auto',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-general',
      providerModel: 'gpt-oss:120b',
      providerTier: 'managed_cloud',
      id: 'managed_cloud_tool',
    });
  });

  it('skips disabled managed-cloud providers when choosing the execution profile', () => {
    const config = createConfig();
    config.llm['ollama-cloud-tools'].enabled = false;

    const profile = selectExecutionProfile({
      config,
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
      providerName: 'ollama-cloud-general',
      providerTier: 'managed_cloud',
    });
  });

  it('honors an explicit provider override instead of auto tier/profile selection', () => {
    const profile = selectExecutionProfile({
      config: createConfig(),
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
      forcedProviderName: 'ollama-cloud-direct',
    });

    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-direct',
      providerModel: 'minimax-m2.1',
      providerTier: 'managed_cloud',
      providerLocality: 'external',
      requestedTier: 'external',
      id: 'managed_cloud_tool',
    });
    expect(profile?.fallbackProviderOrder[0]).toBe('ollama-cloud-direct');
    expect(profile?.reason).toContain("request-scoped provider override selected provider 'ollama-cloud-direct'");
  });

  it('re-selects a role-specific managed-cloud coding profile for delegated workspace exploration', () => {
    const config = createConfig();
    const parentProfile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
    });

    const profile = selectDelegatedExecutionProfile({
      config,
      parentProfile,
      gatewayDecision: createGatewayDecision(),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
    });

    // Inspect operations now route through direct reasoning mode, so
    // the parent profile uses managed_cloud instead of frontier.
    expect(parentProfile).toMatchObject({
      providerTier: 'managed_cloud',
    });
    expect(profile).toMatchObject({
      providerName: 'ollama-cloud-coding',
      providerModel: 'qwen3-coder-next',
      providerTier: 'managed_cloud',
      selectionSource: 'delegated_role',
      routingMode: 'auto',
    });
    expect(profile?.reason).toContain('Workspace Explorer');
  });

  it('derives a role-specific delegated workload instead of reusing the parent repo-inspection shape verbatim', () => {
    const delegatedDecision = resolveDelegatedExecutionDecision({
      gatewayDecision: createGatewayDecision({
        route: 'coding_task',
        operation: 'inspect',
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      }),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
      parentProfile: null,
    });

    expect(delegatedDecision).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
    });
    expect(delegatedDecision?.provenance).toMatchObject({
      route: 'derived.workload',
      operation: 'derived.workload',
      executionClass: 'derived.workload',
      preferredAnswerPath: 'derived.workload',
      expectedContextPressure: 'derived.workload',
    });
  });

  it('keeps security verification on frontier when delegating to a security verifier', () => {
    const config = createConfig();
    const parentProfile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision({
        route: 'search_task',
        operation: 'search',
        executionClass: 'tool_orchestration',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'tool_loop',
      }),
      mode: 'auto',
    });

    const profile = selectDelegatedExecutionProfile({
      config,
      parentProfile,
      gatewayDecision: createGatewayDecision({
        route: 'security_task',
        operation: 'inspect',
        executionClass: 'security_analysis',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      }),
      orchestration: {
        role: 'verifier',
        label: 'Security Verifier',
        lenses: ['security'],
      },
    });

    expect(parentProfile).toMatchObject({
      providerName: 'ollama-cloud-tools',
      providerTier: 'managed_cloud',
    });
    expect(profile).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
      selectionSource: 'delegated_role',
    });
  });

  it('escalates delegated coding-workspace retries from the managed-cloud coding profile to frontier', () => {
    const config = createConfig();
    const parentProfile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
    });
    const delegatedProfile = selectDelegatedExecutionProfile({
      config,
      parentProfile,
      gatewayDecision: createGatewayDecision(),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
      mode: 'auto',
    });

    const escalated = selectEscalatedDelegatedExecutionProfile({
      config,
      currentProfile: delegatedProfile,
      parentProfile,
      gatewayDecision: createGatewayDecision(),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
      mode: 'auto',
    });

    expect(delegatedProfile).toMatchObject({
      providerName: 'ollama-cloud-coding',
      providerTier: 'managed_cloud',
    });
    expect(escalated).toMatchObject({
      providerName: 'anthropic',
      providerTier: 'frontier',
      selectionSource: 'delegated_role',
    });
  });

  it('keeps delegated direct general-assistant turns non-repo-grounded', () => {
    const delegatedDecision = resolveDelegatedExecutionDecision({
      gatewayDecision: createGatewayDecision({
        route: 'general_assistant',
        operation: 'read',
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
      }),
      orchestration: {
        role: 'coordinator',
        label: 'Guardian Coordinator',
      },
      parentProfile: null,
    });

    expect(delegatedDecision).toMatchObject({
      route: 'general_assistant',
      operation: 'read',
      executionClass: 'direct_assistant',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
    });
  });

  it('preserves explicit provider overrides across delegated profile selection', () => {
    const config = createConfig();
    const parentProfile = selectExecutionProfile({
      config,
      routeDecision: { tier: 'external' },
      gatewayDecision: createGatewayDecision(),
      mode: 'auto',
      forcedProviderName: 'ollama-cloud-direct',
    });

    const profile = selectDelegatedExecutionProfile({
      config,
      parentProfile,
      gatewayDecision: createGatewayDecision(),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
    });

    expect(profile).toEqual(parentProfile);
    expect(profile?.selectionSource).toBe('request_override');
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
