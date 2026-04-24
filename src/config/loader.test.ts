import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  interpolateEnvVars,
  deepMerge,
  validateConfig,
  loadConfigFromFile,
  loadConfig,
} from './loader.js';
import { DEFAULT_CONFIG } from './types.js';
import type { GuardianAgentConfig } from './types.js';

const TEST_DIR = join(tmpdir(), 'guardianagent-test-config');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('interpolateEnvVars', () => {
  it('should replace ${ENV_VAR} with environment value', () => {
    vi.stubEnv('TEST_API_KEY', 'sk-12345');
    expect(interpolateEnvVars('key=${TEST_API_KEY}')).toBe('key=sk-12345');
    vi.unstubAllEnvs();
  });

  it('should throw for undefined environment variable', () => {
    delete process.env['UNDEFINED_VAR_XYZ'];
    expect(() => interpolateEnvVars('${UNDEFINED_VAR_XYZ}')).toThrow(
      "Environment variable 'UNDEFINED_VAR_XYZ' is not set",
    );
  });

  it('should handle multiple env vars in one string', () => {
    vi.stubEnv('HOST', 'localhost');
    vi.stubEnv('PORT', '8080');
    expect(interpolateEnvVars('http://${HOST}:${PORT}')).toBe('http://localhost:8080');
    vi.unstubAllEnvs();
  });

  it('should return strings without vars unchanged', () => {
    expect(interpolateEnvVars('no vars here')).toBe('no vars here');
  });

  it('preserves dotted automation placeholders', () => {
    expect(interpolateEnvVars('${step2.output}')).toBe('${step2.output}');
    expect(interpolateEnvVars('Body: ${step2.output}')).toBe('Body: ${step2.output}');
  });

  it('preserves incidental template placeholders from automation content', () => {
    expect(interpolateEnvVars('${i}')).toBe('${i}');
    expect(interpolateEnvVars('Target ref: ${select_target.output} / loop ${i}')).toBe('Target ref: ${select_target.output} / loop ${i}');
  });
});

describe('deepMerge', () => {
  it('should merge top-level properties', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 } as Partial<typeof target & { c: number }>;
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should deep merge nested objects', () => {
    const target = { nested: { a: 1, b: 2 } };
    const source = { nested: { b: 3 } };
    const result = deepMerge(target, source as Partial<typeof target>);
    expect(result.nested).toEqual({ a: 1, b: 3 });
  });

  it('should not merge arrays (replace instead)', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    const result = deepMerge(target, source);
    expect(result.items).toEqual([4, 5]);
  });
});

describe('validateConfig', () => {
  it('should default tool sandbox enforcement to permissive', () => {
    expect(DEFAULT_CONFIG.assistant.tools.sandbox?.enforcementMode).toBe('permissive');
  });

  it('should default assistant tools to approve_each with a read-only shell allowlist', () => {
    expect(DEFAULT_CONFIG.assistant.tools.policyMode).toBe('approve_each');
    expect(DEFAULT_CONFIG.assistant.tools.allowedCommands).toEqual(
      expect.arrayContaining(['git status', 'git diff', 'ls', 'cat']),
    );
    expect(DEFAULT_CONFIG.assistant.tools.allowedCommands).not.toEqual(
      expect.arrayContaining(['node', 'npm', 'npx']),
    );
  });

  it('should default security profile, operating mode, and triage provider to personal/monitor/auto', () => {
    expect(DEFAULT_CONFIG.assistant.security?.deploymentProfile).toBe('personal');
    expect(DEFAULT_CONFIG.assistant.security?.operatingMode).toBe('monitor');
    expect(DEFAULT_CONFIG.assistant.security?.triageLlmProvider).toBe('auto');
    expect(DEFAULT_CONFIG.assistant.security?.continuousMonitoring).toEqual({
      enabled: true,
      profileId: 'quick',
      cron: '15 */12 * * *',
    });
    expect(DEFAULT_CONFIG.assistant.security?.autoContainment).toEqual({
      enabled: true,
      minSeverity: 'high',
      minConfidence: 0.95,
      categories: ['sandbox', 'trust_boundary', 'mcp'],
    });
  });

  it('should default security alert delivery to no operator channels', () => {
    expect(DEFAULT_CONFIG.assistant.notifications.destinations).toEqual({
      web: false,
      cli: false,
      telegram: false,
    });
  });

  it('should pass with valid default config', () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toEqual([]);
  });

  it('should default knowledge base readOnly to false', () => {
    expect(DEFAULT_CONFIG.assistant.memory.knowledgeBase?.readOnly).toBe(false);
  });

  it('should default automated maintenance to enabled with bounded memory hygiene', () => {
    expect(DEFAULT_CONFIG.assistant.maintenance).toEqual({
      enabled: true,
      sweepIntervalMs: 300000,
      idleAfterMs: 600000,
      jobs: {
        memoryHygiene: {
          enabled: true,
          includeGlobalScope: true,
          includeCodeSessions: true,
          maxScopesPerSweep: 4,
          minIntervalMs: 21600000,
        },
      },
    });
  });

  it('should reject invalid assistant security defaults', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        security: {
          deploymentProfile: 'lab' as any,
          operatingMode: 'observe' as any,
          triageLlmProvider: 'remote' as any,
        },
      },
    };

    expect(validateConfig(config)).toContain('assistant.security.deploymentProfile must be one of: personal, home, organization');
    expect(validateConfig(config)).toContain('assistant.security.operatingMode must be one of: monitor, guarded, lockdown, ir_assist');
    expect(validateConfig(config)).toContain('assistant.security.triageLlmProvider must be one of: auto, local, external');
  });

  it('should reject invalid Assistant Security monitoring and auto-containment settings', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        security: {
          ...DEFAULT_CONFIG.assistant.security!,
          continuousMonitoring: {
            enabled: true,
            profileId: 'deep-dive' as any,
            cron: '',
          },
          autoContainment: {
            enabled: true,
            minSeverity: 'medium' as any,
            minConfidence: 1.5,
            categories: ['sandbox', 'unknown-category' as any],
          },
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toContain('assistant.security.continuousMonitoring.profileId must be one of: quick, runtime-hardening, workspace-boundaries');
    expect(errors).toContain('assistant.security.continuousMonitoring.cron is required');
    expect(errors).toContain('assistant.security.autoContainment.minSeverity must be one of: high, critical');
    expect(errors).toContain('assistant.security.autoContainment.minConfidence must be between 0 and 1');
    expect(errors).toContain("assistant.security.autoContainment.categories contains unknown category 'unknown-category'");
  });

  it('should reject invalid automated maintenance settings', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        maintenance: {
          enabled: true,
          sweepIntervalMs: 5000,
          idleAfterMs: 9000,
          jobs: {
            memoryHygiene: {
              enabled: true,
              includeGlobalScope: true,
              includeCodeSessions: true,
              maxScopesPerSweep: 0,
              minIntervalMs: 1000,
            },
          },
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toContain('assistant.maintenance.sweepIntervalMs must be >= 10000');
    expect(errors).toContain('assistant.maintenance.idleAfterMs must be >= 10000');
    expect(errors).toContain('assistant.maintenance.jobs.memoryHygiene.maxScopesPerSweep must be >= 1');
    expect(errors).toContain('assistant.maintenance.jobs.memoryHygiene.minIntervalMs must be >= 60000');
  });

  it('should reject invalid playbook evidence grounding settings', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          ...DEFAULT_CONFIG.assistant.connectors,
          playbooks: {
            ...DEFAULT_CONFIG.assistant.connectors.playbooks,
            definitions: [
              {
                id: 'grounded-report',
                name: 'Grounded Report',
                enabled: true,
                mode: 'sequential',
                steps: [
                  {
                    id: 'report',
                    type: 'instruction',
                    packId: '',
                    toolName: '',
                    instruction: 'Summarize the evidence.',
                    evidenceMode: 'unsupported' as any,
                    citationStyle: 'footnotes' as any,
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toContain("assistant.connectors.playbook 'grounded-report' step 'report' evidenceMode must be none, grounded, or strict");
    expect(errors).toContain("assistant.connectors.playbook 'grounded-report' step 'report' citationStyle must be sources_list or inline_markers");
  });

  it('should reject evidence grounding fields on non-instruction playbook steps', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          ...DEFAULT_CONFIG.assistant.connectors,
          playbooks: {
            ...DEFAULT_CONFIG.assistant.connectors.playbooks,
            definitions: [
              {
                id: 'invalid-tool-step',
                name: 'Invalid Tool Step',
                enabled: true,
                mode: 'sequential',
                steps: [
                  {
                    id: 'search',
                    type: 'tool',
                    packId: '',
                    toolName: 'web_search',
                    args: { query: 'guardian' },
                    evidenceMode: 'grounded',
                    citationStyle: 'sources_list',
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toContain("assistant.connectors.playbook 'invalid-tool-step' step 'search' evidenceMode/citationStyle are only valid for instruction steps");
  });

  it('should fail when defaultProvider is missing', () => {
    const config = { ...DEFAULT_CONFIG, defaultProvider: '' };
    const errors = validateConfig(config);
    expect(errors).toContain('defaultProvider is required');
  });

  it('should fail when defaultProvider references missing provider', () => {
    const config = { ...DEFAULT_CONFIG, defaultProvider: 'nonexistent' };
    const errors = validateConfig(config);
    expect(errors).toContain(
      "defaultProvider 'nonexistent' not found in llm configuration",
    );
  });

  it('should fail when model is missing', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        test: { provider: 'ollama', model: '' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain('llm.test.model is required');
  });

  it('should require credentialRef for non-ollama providers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      "llm.anthropic.credentialRef is required for provider 'anthropic'",
    );
  });

  it('should reject inline apiKey for non-ollama providers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'sk-inline' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'llm.anthropic.apiKey is not allowed in config. Use llm.anthropic.credentialRef with assistant.credentials.refs instead.',
    );
  });

  it('should accept credentialRef for non-ollama providers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should accept openai-compatible provider families from the runtime registry', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        openrouterCoding: { provider: 'openrouter', model: 'qwen/qwen3.6-plus', credentialRef: 'llm.openrouter.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openrouter.primary': { source: 'env', env: 'OPENROUTER_API_KEY' },
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should accept OpenRouter as a managed-cloud preferred provider family', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        openrouterGeneral: { provider: 'openrouter', model: 'qwen/qwen3.6-plus', credentialRef: 'llm.openrouter.primary' },
        claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openrouter.primary': { source: 'env', env: 'OPENROUTER_API_KEY' },
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            local: 'ollama',
            managedCloud: 'openrouter',
            frontier: 'claude',
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should accept managed-cloud role bindings scoped by provider family', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        ollamaCloud: { provider: 'ollama_cloud', model: 'gpt-oss:120b', credentialRef: 'llm.ollama_cloud.primary' },
        openrouterGeneral: { provider: 'openrouter', model: 'qwen/qwen3.6-plus', credentialRef: 'llm.openrouter.primary' },
        openrouterCoding: { provider: 'openrouter', model: 'qwen/qwen3.6-coder', credentialRef: 'llm.openrouter.primary' },
        claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.ollama_cloud.primary': { source: 'env', env: 'OLLAMA_API_KEY' },
            'llm.openrouter.primary': { source: 'env', env: 'OPENROUTER_API_KEY' },
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            local: 'ollama',
            managedCloud: 'openrouter',
            frontier: 'claude',
          },
          modelSelection: {
            ...DEFAULT_CONFIG.assistant.tools.modelSelection,
            managedCloudRouting: {
              enabled: true,
              providerRoleBindings: {
                ollama_cloud: {
                  general: 'ollamaCloud',
                },
                openrouter: {
                  general: 'openrouterGeneral',
                  coding: 'openrouterCoding',
                },
              },
            },
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should accept preferred local, managed-cloud, and frontier providers when they match tier', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        ollamaCloud: { provider: 'ollama_cloud', model: 'gpt-oss:120b', credentialRef: 'llm.ollama_cloud.primary' },
        claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.ollama_cloud.primary': { source: 'env', env: 'OLLAMA_API_KEY' },
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            local: 'ollama',
            managedCloud: 'ollamaCloud',
            frontier: 'claude',
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should reject a preferred external provider that points at a local model', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            local: 'ollama',
            external: 'ollama',
          },
        },
      },
    };

    expect(validateConfig(config)).toContain(
      "assistant.tools.preferredProviders.external must reference an external provider, got 'ollama'",
    );
  });

  it('should reject a preferred managed-cloud provider that points at a frontier model', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            managedCloud: 'claude',
          },
        },
      },
    };

    expect(validateConfig(config)).toContain(
      "assistant.tools.preferredProviders.managedCloud must reference a managed-cloud provider family or legacy managed-cloud profile, got 'claude'",
    );
  });

  it('should reject managed-cloud role bindings that point at non-managed-cloud providers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        ollamaCloud: { provider: 'ollama_cloud', model: 'gpt-oss:120b', credentialRef: 'llm.ollama_cloud.primary' },
        claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'llm.anthropic.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.ollama_cloud.primary': { source: 'env', env: 'OLLAMA_API_KEY' },
            'llm.anthropic.primary': { source: 'env', env: 'ANTHROPIC_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          preferredProviders: {
            managedCloud: 'ollamaCloud',
          },
          modelSelection: {
            ...DEFAULT_CONFIG.assistant.tools.modelSelection,
            managedCloudRouting: {
              enabled: true,
              roleBindings: {
                direct: 'claude',
              },
            },
          },
        },
      },
    };

    expect(validateConfig(config)).toContain(
      "assistant.tools.modelSelection.managedCloudRouting.roleBindings.direct must reference a managed-cloud provider, got 'claude'",
    );
  });

  it('should reject managed-cloud provider role bindings keyed by a frontier provider family', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        openrouterGeneral: { provider: 'openrouter', model: 'qwen/qwen3.6-plus', credentialRef: 'llm.openrouter.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openrouter.primary': { source: 'env', env: 'OPENROUTER_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          modelSelection: {
            ...DEFAULT_CONFIG.assistant.tools.modelSelection,
            managedCloudRouting: {
              enabled: true,
              providerRoleBindings: {
                openai: {
                  general: 'openrouterGeneral',
                },
              },
            },
          },
        },
      },
    };

    expect(validateConfig(config)).toContain(
      'assistant.tools.modelSelection.managedCloudRouting.providerRoleBindings.openai must use a managed-cloud provider family name',
    );
  });

  it('should reject managed-cloud provider role bindings that point across provider families', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        ollamaCloud: { provider: 'ollama_cloud', model: 'gpt-oss:120b', credentialRef: 'llm.ollama_cloud.primary' },
        openrouterGeneral: { provider: 'openrouter', model: 'qwen/qwen3.6-plus', credentialRef: 'llm.openrouter.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.ollama_cloud.primary': { source: 'env', env: 'OLLAMA_API_KEY' },
            'llm.openrouter.primary': { source: 'env', env: 'OPENROUTER_API_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          modelSelection: {
            ...DEFAULT_CONFIG.assistant.tools.modelSelection,
            managedCloudRouting: {
              enabled: true,
              providerRoleBindings: {
                openrouter: {
                  general: 'ollamaCloud',
                },
              },
            },
          },
        },
      },
    };

    expect(validateConfig(config)).toContain(
      "assistant.tools.modelSelection.managedCloudRouting.providerRoleBindings.openrouter.general must reference a managed-cloud provider profile from the openrouter family, got 'ollamaCloud'",
    );
  });

  it('should tolerate a credentialRef that points to an unknown ref (auto-managed local refs may not be in config)', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'missing.ref' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).not.toContain("llm.anthropic.credentialRef references unknown credential ref 'missing.ref'");
  });

  it('should fail when a credential ref has no env name', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            broken: { source: 'env', env: '' },
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain('assistant.credentials.refs.broken.env is required');
  });

  it('should accept local credential refs with secret ids', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.openai.local': { source: 'local', secretId: 'secret-123' },
          },
        },
      },
      llm: {
        ...DEFAULT_CONFIG.llm,
        openaiLocal: { provider: 'openai', model: 'gpt-4o', credentialRef: 'llm.openai.local' },
      },
      defaultProvider: 'openaiLocal',
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate cloud cPanel credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.cpanel.primary': { source: 'env', env: 'CPANEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cpanelProfiles: [{
              id: 'primary',
              name: 'Primary cPanel',
              type: 'cpanel',
              host: 'server.example.com',
              username: 'alice',
              credentialRef: 'cloud.cpanel.primary',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should accept cPanel hosts entered as full root URLs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.cpanel.primary': { source: 'env', env: 'CPANEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cpanelProfiles: [{
              id: 'social',
              name: 'Social WHM',
              type: 'whm',
              host: 'https://vmres13.web-servers.com.au/',
              username: 'root',
              credentialRef: 'cloud.cpanel.primary',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate llm baseUrl as a clean http(s) URL', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        local: { provider: 'ollama', model: 'qwen3:latest', baseUrl: 'https://gateway.example.com/v1?api-version=1' },
      },
      defaultProvider: 'local',
    };

    expect(validateConfig(config)).toContain('llm.local.baseUrl must not include a query string or fragment');
  });

  it('should validate second-brain preference config', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        secondBrain: {
          enabled: true,
          onboarding: {
            completed: false,
            dismissed: false,
          },
          profile: {
            timezone: 'Australia/Brisbane',
            workdayStart: '08:30',
            workdayEnd: '17:30',
            proactivityLevel: 'balanced',
          },
          delivery: {
            defaultChannels: ['web', 'telegram'],
          },
          knowledge: {
            prioritizeConnectedSources: true,
            defaultRetrievalMode: 'hybrid',
            rerankerEnabled: true,
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should reject invalid second-brain time inputs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        secondBrain: {
          ...DEFAULT_CONFIG.assistant.secondBrain,
          profile: {
            ...DEFAULT_CONFIG.assistant.secondBrain.profile,
            workdayStart: '8:30am',
          },
        },
      },
    };

    expect(validateConfig(config)).toContain('assistant.secondBrain.profile.workdayStart must be in HH:MM 24-hour format');
  });

  it('should validate cloud Vercel credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.vercel.primary': { source: 'env', env: 'VERCEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            vercelProfiles: [{
              id: 'vercel-main',
              name: 'Vercel Main',
              credentialRef: 'cloud.vercel.primary',
              teamId: 'team_123',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate Vercel sandbox requirements and limits', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.vercel.primary': { source: 'env', env: 'VERCEL_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            vercelProfiles: [{
              id: 'vercel-main',
              name: 'Vercel Main',
              credentialRef: 'cloud.vercel.primary',
              teamId: 'team_123',
              sandbox: {
                enabled: true,
                projectId: 'prj_123',
                baseSnapshotId: 'snap_vercel_base',
                defaultTimeoutMs: 300_000,
                defaultVcpus: 2,
                allowNetwork: true,
                allowedDomains: ['registry.npmjs.org'],
              },
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
    config.assistant.tools.cloud!.vercelProfiles![0]!.sandbox!.defaultVcpus = 9;
    expect(validateConfig(config)).toContain("assistant.tools.cloud.vercelProfiles.vercel-main.sandbox.defaultVcpus must be an integer between 1 and 8");
  });

  it('loadConfigFromFile should normalize cloud, llm, and Moltbook URL-like inputs', () => {
    const configPath = join(TEST_DIR, 'config.yaml');
    const rawConfig: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      defaultProvider: 'local',
      llm: {
        ...DEFAULT_CONFIG.llm,
        local: { provider: 'ollama', model: 'qwen3:latest', baseUrl: 'https://gateway.example.com/v1/' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cpanelProfiles: [{
              id: 'social',
              name: 'Social WHM',
              type: 'whm',
              host: 'https://vmres13.web-servers.com.au/',
              username: 'root',
              credentialRef: 'cloud.cpanel.primary',
            }],
            vercelProfiles: [{
              id: 'vercel-main',
              name: 'Vercel Main',
              credentialRef: 'cloud.vercel.primary',
              apiBaseUrl: 'https://api.vercel.com/',
              teamId: 'team_123',
              sandbox: {
                enabled: true,
                projectId: 'prj_123',
                baseSnapshotId: ' snap_vercel_base ',
                allowedDomains: ['Registry.Npmjs.org', 'api.anthropic.com '],
              },
            }],
            daytonaProfiles: [{
              id: 'daytona-main',
              name: 'Daytona Main',
              credentialRef: 'cloud.daytona.primary',
              enabled: true,
              snapshot: ' snapshot-main ',
            }],
            awsProfiles: [{
              id: 'aws-main',
              name: 'AWS Main',
              region: 'us-east-1',
              accessKeyIdCredentialRef: 'cloud.aws.access',
              secretAccessKeyCredentialRef: 'cloud.aws.secret',
              endpoints: { s3: 'http://localhost:4566/' },
            }],
            gcpProfiles: [{
              id: 'gcp-main',
              name: 'GCP Main',
              projectId: 'guardian-prod',
              serviceAccountCredentialRef: 'cloud.gcp.service',
              endpoints: { storage: 'https://storage.googleapis.com/' },
            }],
            azureProfiles: [{
              id: 'azure-main',
              name: 'Azure Main',
              subscriptionId: 'sub-123',
              accessTokenCredentialRef: 'cloud.azure.token',
              blobBaseUrl: 'https://account.blob.core.windows.net/',
              endpoints: { management: 'https://management.azure.com/' },
            }],
          },
        },
        credentials: {
          refs: {
            ...DEFAULT_CONFIG.assistant.credentials.refs,
            'cloud.cpanel.primary': { source: 'env', env: 'CPANEL_TOKEN' },
            'cloud.vercel.primary': { source: 'env', env: 'VERCEL_TOKEN' },
            'cloud.daytona.primary': { source: 'env', env: 'DAYTONA_API_KEY' },
            'cloud.aws.access': { source: 'env', env: 'AWS_ACCESS_KEY_ID' },
            'cloud.aws.secret': { source: 'env', env: 'AWS_SECRET_ACCESS_KEY' },
            'cloud.gcp.service': { source: 'env', env: 'GCP_SERVICE_ACCOUNT_JSON' },
            'cloud.azure.token': { source: 'env', env: 'AZURE_ACCESS_TOKEN' },
          },
        },
        threatIntel: {
          ...DEFAULT_CONFIG.assistant.threatIntel,
          moltbook: {
            ...DEFAULT_CONFIG.assistant.threatIntel.moltbook,
            enabled: true,
            mode: 'api',
            baseUrl: 'https://moltbook.com/',
            allowedHosts: ['moltbook.com'],
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2));
    const loaded = loadConfigFromFile(configPath);

    expect(loaded.llm.local?.baseUrl).toBe('https://gateway.example.com/v1');
    expect(loaded.assistant.tools.cloud?.cpanelProfiles?.[0]?.host).toBe('vmres13.web-servers.com.au');
    expect(loaded.assistant.tools.cloud?.cpanelProfiles?.[0]?.ssl).toBe(true);
    expect(loaded.assistant.tools.cloud?.vercelProfiles?.[0]?.apiBaseUrl).toBe('https://api.vercel.com');
    expect(loaded.assistant.tools.cloud?.vercelProfiles?.[0]?.sandbox?.projectId).toBe('prj_123');
    expect(loaded.assistant.tools.cloud?.vercelProfiles?.[0]?.sandbox?.baseSnapshotId).toBe('snap_vercel_base');
    expect(loaded.assistant.tools.cloud?.vercelProfiles?.[0]?.sandbox?.allowedDomains).toEqual(['registry.npmjs.org', 'api.anthropic.com']);
    expect(loaded.assistant.tools.cloud?.daytonaProfiles?.[0]?.snapshot).toBe('snapshot-main');
    expect(loaded.assistant.tools.cloud?.awsProfiles?.[0]?.endpoints?.s3).toBe('http://localhost:4566');
    expect(loaded.assistant.tools.cloud?.gcpProfiles?.[0]?.endpoints?.storage).toBe('https://storage.googleapis.com');
    expect(loaded.assistant.tools.cloud?.azureProfiles?.[0]?.blobBaseUrl).toBe('https://account.blob.core.windows.net');
    expect(loaded.assistant.tools.cloud?.azureProfiles?.[0]?.endpoints?.management).toBe('https://management.azure.com');
    expect(loaded.assistant.threatIntel.moltbook.baseUrl).toBe('https://moltbook.com');
  });

  it('loadConfigFromFile aligns the implicit local preferred provider with an explicit local defaultProvider', () => {
    const configPath = join(TEST_DIR, 'explicit-default-provider.yaml');
    const rawConfig = {
      defaultProvider: 'local',
      llm: {
        local: {
          provider: 'ollama',
          model: 'brokered-harness-model',
          baseUrl: 'http://127.0.0.1:44729',
        },
      },
    } as Partial<GuardianAgentConfig>;

    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2));
    const loaded = loadConfigFromFile(configPath);

    expect(loaded.defaultProvider).toBe('local');
    expect(loaded.assistant.tools.preferredProviders?.local).toBe('local');
  });

  it('loadConfigFromFile preserves an explicit local preferred provider override', () => {
    const configPath = join(TEST_DIR, 'explicit-local-preferred-provider.yaml');
    const rawConfig = {
      defaultProvider: 'local',
      llm: {
        local: {
          provider: 'ollama',
          model: 'brokered-harness-model',
          baseUrl: 'http://127.0.0.1:44729',
        },
      },
      assistant: {
        tools: {
          preferredProviders: {
            local: 'ollama',
          },
        },
      },
    } as Partial<GuardianAgentConfig>;

    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2));
    const loaded = loadConfigFromFile(configPath);

    expect(loaded.defaultProvider).toBe('local');
    expect(loaded.assistant.tools.preferredProviders?.local).toBe('ollama');
  });

  it('should validate cloud Cloudflare credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.cloudflare.primary': { source: 'env', env: 'CLOUDFLARE_TOKEN' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            cloudflareProfiles: [{
              id: 'cf-main',
              name: 'Cloudflare Main',
              credentialRef: 'cloud.cloudflare.primary',
              accountId: 'acc_123',
              defaultZoneId: 'zone_123',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate cloud AWS credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.aws.primary.accessKeyId': { source: 'env', env: 'AWS_ACCESS_KEY_ID' },
            'cloud.aws.primary.secretAccessKey': { source: 'env', env: 'AWS_SECRET_ACCESS_KEY' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            awsProfiles: [{
              id: 'aws-main',
              name: 'AWS Main',
              region: 'us-east-1',
              accessKeyIdCredentialRef: 'cloud.aws.primary.accessKeyId',
              secretAccessKeyCredentialRef: 'cloud.aws.primary.secretAccessKey',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate cloud GCP credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.gcp.primary.serviceAccount': { source: 'env', env: 'GCP_SERVICE_ACCOUNT_JSON' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            gcpProfiles: [{
              id: 'gcp-main',
              name: 'GCP Main',
              projectId: 'guardian-prod',
              location: 'australia-southeast1',
              serviceAccountCredentialRef: 'cloud.gcp.primary.serviceAccount',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should validate cloud Azure credential refs', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'cloud.azure.primary.clientId': { source: 'env', env: 'AZURE_CLIENT_ID' },
            'cloud.azure.primary.clientSecret': { source: 'env', env: 'AZURE_CLIENT_SECRET' },
          },
        },
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          cloud: {
            enabled: true,
            azureProfiles: [{
              id: 'azure-main',
              name: 'Azure Main',
              subscriptionId: 'sub-123',
              tenantId: 'tenant-123',
              clientIdCredentialRef: 'cloud.azure.primary.clientId',
              clientSecretCredentialRef: 'cloud.azure.primary.clientSecret',
              defaultResourceGroup: 'rg-main',
            }],
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should require telegram botTokenCredentialRef when enabled', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      channels: {
        ...DEFAULT_CONFIG.channels,
        telegram: { enabled: true },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'channels.telegram.botTokenCredentialRef is required when Telegram is enabled',
    );
  });

  it('should reject inline web search API keys', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          webSearch: {
            provider: 'brave',
            braveApiKey: 'inline-brave-key',
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'assistant.tools.webSearch.braveApiKey is not allowed in config. Use assistant.tools.webSearch.braveCredentialRef with assistant.credentials.refs instead.',
    );
  });

  it('should validate soul summary size against max', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        soul: {
          ...DEFAULT_CONFIG.assistant.soul,
          maxChars: 500,
          summaryMaxChars: 700,
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain('assistant.soul.summaryMaxChars must be <= assistant.soul.maxChars');
  });

  it('should reject wildcard web allowedOrigins when web channel is enabled', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      channels: {
        ...DEFAULT_CONFIG.channels,
        web: {
          ...DEFAULT_CONFIG.channels.web,
          enabled: true,
          allowedOrigins: ['*'],
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("channels.web.allowedOrigins must not contain '*' because the web API is auth-protected and served on localhost");
  });
});

describe('loadConfigFromFile', () => {
  it('should load and merge YAML config with defaults', () => {
    const configPath = join(TEST_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `
llm:
  ollama:
    model: mistral
runtime:
  logLevel: debug
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.llm.ollama.model).toBe('mistral');
    expect(config.llm.ollama.provider).toBe('ollama'); // from default
    expect(config.runtime.logLevel).toBe('debug');
    expect(config.runtime.maxStallDurationMs).toBe(180_000); // from default
  });

  it('should interpolate environment variables', () => {
    vi.stubEnv('TEST_OLLAMA_MODEL', 'codellama');
    const configPath = join(TEST_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `
llm:
  ollama:
    model: \${TEST_OLLAMA_MODEL}
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.llm.ollama.model).toBe('codellama');
    vi.unstubAllEnvs();
  });

  it('should normalize partial search config created by config updates', () => {
    const configPath = join(TEST_DIR, 'partial-search.yaml');
    writeFileSync(
      configPath,
      `
assistant:
  tools:
    search:
      enabled: true
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.assistant.tools.search).toBeDefined();
    expect(config.assistant.tools.search?.enabled).toBe(true);
    expect(config.assistant.tools.search?.sources).toEqual([]);
  });

  it('should load YAML scalars with JSON schema semantics', () => {
    const configPath = join(TEST_DIR, 'json-schema.yaml');
    writeFileSync(
      configPath,
      `
assistant:
  memory:
    knowledgeBase:
      basePath: 2026-03-20
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.assistant.memory.knowledgeBase?.basePath).toBe('2026-03-20');
    expect(typeof config.assistant.memory.knowledgeBase?.basePath).toBe('string');
  });

  it('enforces the immutable security baseline on loaded config', () => {
    const configPath = join(TEST_DIR, 'baseline.yaml');
    writeFileSync(
      configPath,
      `
guardian:
  enabled: false
  deniedPaths: []
  guardianAgent:
    enabled: false
    failOpen: true
  policy:
    enabled: false
    mode: off
assistant:
  tools:
    policyMode: autonomous
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.guardian.enabled).toBe(true);
    expect(config.guardian.guardianAgent.enabled).toBe(true);
    expect(config.guardian.guardianAgent.failOpen).toBe(false);
    expect(config.guardian.policy.enabled).toBe(true);
    expect(config.guardian.policy.mode).toBe('shadow');
    expect(config.assistant.tools.policyMode).toBe('approve_by_policy');
    expect(config.guardian.deniedPaths).toEqual(expect.arrayContaining([
      '(^|/)\\.env(?:$|\\.)',
      '\\.pem$',
      '\\.key$',
      '(^|/)credentials\\.[^/]+$',
      '(^|/)id_rsa(?:$|\\.)',
    ]));
  });

  it('allows baseline relaxation only when GUARDIAN_DISABLE_BASELINE is set before load', () => {
    vi.stubEnv('GUARDIAN_DISABLE_BASELINE', '1');
    const configPath = join(TEST_DIR, 'baseline-override.yaml');
    writeFileSync(
      configPath,
      `
guardian:
  enabled: false
assistant:
  tools:
    policyMode: autonomous
`,
    );

    const config = loadConfigFromFile(configPath);
    expect(config.guardian.enabled).toBe(false);
    expect(config.assistant.tools.policyMode).toBe('autonomous');
    vi.unstubAllEnvs();
  });

  it('should throw for missing config file', () => {
    expect(() => loadConfigFromFile('/nonexistent/path/config.yaml')).toThrow(
      'Configuration file not found',
    );
  });

  it('should throw for invalid YAML content', () => {
    const configPath = join(TEST_DIR, 'bad.yaml');
    writeFileSync(configPath, '');

    expect(() => loadConfigFromFile(configPath)).toThrow(
      'Invalid configuration file',
    );
  });
});

describe('validateConfig — MCP', () => {
  it('should pass with MCP disabled (default)', () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toEqual([]);
  });

  it('should fail when MCP enabled but no servers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: { enabled: true, servers: [] },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'assistant.tools.mcp.servers must include at least one server or managed provider when MCP is enabled',
    );
  });

  it('should fail when MCP server missing required fields', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [{ id: '', name: '', command: '' }],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('server id is required'))).toBe(true);
    expect(errors.some(e => e.includes('name is required'))).toBe(true);
    expect(errors.some(e => e.includes('command is required'))).toBe(true);
  });

  it('should fail on duplicate server ids', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [
              { id: 'fs', name: 'FS 1', command: 'cmd1' },
              { id: 'fs', name: 'FS 2', command: 'cmd2' },
            ],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("assistant.tools.mcp server id 'fs' is duplicated");
  });

  it('should fail when timeoutMs is too low', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [{ id: 'fast', name: 'Fast Server', command: 'cmd', timeoutMs: 100 }],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("assistant.tools.mcp server 'fast' timeoutMs must be >= 1000");
  });

  it('should pass with valid MCP config', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [{
              id: 'filesystem',
              name: 'Filesystem Tools',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
              startupApproved: true,
              networkAccess: false,
              inheritEnv: false,
              allowedEnvKeys: ['PATH'],
              timeoutMs: 10000,
            }],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should fail when MCP hardening fields are invalid', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [{
              id: 'filesystem',
              name: 'Filesystem Tools',
              command: 'npx',
              startupApproved: 'yes' as unknown as boolean,
              networkAccess: 'on' as unknown as boolean,
              inheritEnv: 'maybe' as unknown as boolean,
              allowedEnvKeys: ['PATH', ''],
            }],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("assistant.tools.mcp server 'filesystem' startupApproved must be a boolean");
    expect(errors).toContain("assistant.tools.mcp server 'filesystem' networkAccess must be a boolean");
    expect(errors).toContain("assistant.tools.mcp server 'filesystem' inheritEnv must be a boolean");
    expect(errors).toContain("assistant.tools.mcp server 'filesystem' allowedEnvKeys must be an array of non-empty strings");
  });

  it('should skip validation when MCP is disabled', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: { enabled: false, servers: [] },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should pass with managed gws provider and no raw servers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          mcp: {
            enabled: true,
            servers: [],
            managedProviders: {
              gws: {
                enabled: true,
                services: ['gmail', 'calendar'],
                exposeSkills: true,
              },
            },
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should fail with invalid windows sandbox helper config', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        tools: {
          ...DEFAULT_CONFIG.assistant.tools,
          sandbox: {
            ...DEFAULT_CONFIG.assistant.tools.sandbox,
            enforcementMode: 'strict',
            windowsHelper: {
              enabled: true,
              command: '   ',
              timeoutMs: 500,
            },
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain('assistant.tools.sandbox.windowsHelper.command must be a non-empty string when provided');
    expect(errors).toContain('assistant.tools.sandbox.windowsHelper.timeoutMs must be >= 1000');
  });
});

describe('validateConfig — connectors', () => {
  it('should allow connectors enabled with no access profiles', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          ...DEFAULT_CONFIG.assistant.connectors,
          enabled: true,
          packs: [],
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should allow connectors enabled when all access profiles are disabled', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          ...DEFAULT_CONFIG.assistant.connectors,
          enabled: true,
          packs: [{
            id: 'lab-core',
            name: 'Lab Core',
            enabled: false,
            allowedCapabilities: ['inventory.read'],
            allowedHosts: ['localhost'],
            allowedPaths: ['./workspace'],
            allowedCommands: ['ssh'],
            authMode: 'api_key',
            requireHumanApprovalForWrites: true,
          }],
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should fail on duplicate connector pack ids', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          ...DEFAULT_CONFIG.assistant.connectors,
          packs: [
            {
              id: 'ops',
              name: 'Ops A',
              enabled: true,
              allowedCapabilities: ['inventory.read'],
              allowedHosts: ['localhost'],
              allowedPaths: ['./workspace'],
              allowedCommands: ['ssh'],
              authMode: 'api_key',
              requireHumanApprovalForWrites: true,
            },
            {
              id: 'ops',
              name: 'Ops B',
              enabled: true,
              allowedCapabilities: ['network.device.read'],
              allowedHosts: ['localhost'],
              allowedPaths: ['./workspace'],
              allowedCommands: ['snmpwalk'],
              authMode: 'oauth2',
              requireHumanApprovalForWrites: true,
            },
          ],
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("assistant.connectors.pack id 'ops' is duplicated");
  });

  it('should pass with a valid connector framework config', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          enabled: true,
          executionMode: 'plan_then_execute',
          maxConnectorCallsPerRun: 20,
          packs: [{
            id: 'infra-core',
            name: 'Infrastructure Core',
            enabled: true,
            allowedCapabilities: ['inventory.read', 'vm.power.write'],
            allowedHosts: ['localhost', '10.0.0.1'],
            allowedPaths: ['./workspace', './docs'],
            allowedCommands: ['ssh', 'ansible-playbook'],
            authMode: 'oauth2',
            requireHumanApprovalForWrites: true,
          }],
          playbooks: {
            definitions: [{
              id: 'infra-audit',
              name: 'Infra Audit',
              enabled: true,
              mode: 'sequential',
              signature: 'signed',
              steps: [{
                id: 'scan',
                packId: 'infra-core',
                toolName: 'fs_list',
                args: { path: './workspace' },
              }],
            }],
            enabled: true,
            maxSteps: 20,
            maxParallelSteps: 4,
            defaultStepTimeoutMs: 20_000,
            requireSignedDefinitions: true,
            requireDryRunOnFirstExecution: true,
          },
          studio: {
            enabled: true,
            mode: 'builder',
            requirePrivilegedTicket: true,
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('should allow built-in playbook steps without an access profile', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        connectors: {
          enabled: true,
          executionMode: 'plan_then_execute',
          maxConnectorCallsPerRun: 20,
          packs: [],
          playbooks: {
            definitions: [{
              id: 'lan-arp-scan',
              name: 'LAN ARP Scan',
              enabled: true,
              mode: 'sequential',
              signature: 'signed',
              steps: [{
                id: 'scan',
                packId: '',
                toolName: 'net_arp_scan',
                args: {},
              }],
            }],
            enabled: true,
            maxSteps: 20,
            maxParallelSteps: 4,
            defaultStepTimeoutMs: 20_000,
            requireSignedDefinitions: true,
            requireDryRunOnFirstExecution: true,
          },
          studio: {
            enabled: true,
            mode: 'builder',
            requirePrivilegedTicket: true,
          },
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('should return defaults when no config file exists', () => {
    const config = loadConfig('/nonexistent/path/config.yaml');
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
