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
        groqMain: { provider: 'groq', model: 'llama-3.3-70b-versatile', credentialRef: 'llm.groq.primary' },
      },
      assistant: {
        ...DEFAULT_CONFIG.assistant,
        credentials: {
          refs: {
            'llm.groq.primary': { source: 'env', env: 'GROQ_API_KEY' },
          },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('should accept preferred local and external providers when they match locality', () => {
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
            local: 'ollama',
            external: 'claude',
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
    expect(loaded.assistant.tools.cloud?.awsProfiles?.[0]?.endpoints?.s3).toBe('http://localhost:4566');
    expect(loaded.assistant.tools.cloud?.gcpProfiles?.[0]?.endpoints?.storage).toBe('https://storage.googleapis.com');
    expect(loaded.assistant.tools.cloud?.azureProfiles?.[0]?.blobBaseUrl).toBe('https://account.blob.core.windows.net');
    expect(loaded.assistant.tools.cloud?.azureProfiles?.[0]?.endpoints?.management).toBe('https://management.azure.com');
    expect(loaded.assistant.threatIntel.moltbook.baseUrl).toBe('https://moltbook.com');
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
