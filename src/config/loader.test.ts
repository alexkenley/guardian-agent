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
  it('should default tool sandbox enforcement to strict', () => {
    expect(DEFAULT_CONFIG.assistant.tools.sandbox?.enforcementMode).toBe('strict');
  });

  it('should pass with valid default config', () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toEqual([]);
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

  it('should require apiKey for non-ollama providers', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      "llm.anthropic.apiKey or llm.anthropic.credentialRef is required for provider 'anthropic'",
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

  it('should fail when credentialRef points to an unknown ref', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', credentialRef: 'missing.ref' },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain("llm.anthropic.credentialRef references unknown credential ref 'missing.ref'");
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

  it('should require telegram botToken when enabled', () => {
    const config: GuardianAgentConfig = {
      ...DEFAULT_CONFIG,
      channels: {
        ...DEFAULT_CONFIG.channels,
        telegram: { enabled: true },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'channels.telegram.botToken is required when Telegram is enabled',
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
              timeoutMs: 10000,
            }],
          },
        },
      },
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
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
  it('should fail when connectors enabled but no packs are defined', () => {
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
    expect(errors).toContain(
      'assistant.connectors.packs must include at least one pack when connectors are enabled',
    );
  });

  it('should fail when connectors enabled but all packs are disabled', () => {
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
    expect(errors).toContain(
      'assistant.connectors requires at least one enabled pack when connectors are enabled',
    );
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
});

describe('loadConfig', () => {
  it('should return defaults when no config file exists', () => {
    const config = loadConfig('/nonexistent/path/config.yaml');
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
