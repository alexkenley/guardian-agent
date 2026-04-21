import { describe, expect, it } from 'vitest';
import {
  redactConfig,
  formatDirectFilesystemSearchResponse,
  formatToolResultForLLM,
  parseDirectGoogleWorkspaceIntent,
} from './chat-agent-helpers.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from './config/types.js';

describe('formatToolResultForLLM', () => {
  it('keeps filesystem search results path-oriented instead of collapsing matches into opaque objects', () => {
    const rendered = formatToolResultForLLM('fs_search', {
      success: true,
      status: 'succeeded',
      output: {
        root: 'S:\\Development\\GuardianAgent',
        query: 'ollama_cloud',
        mode: 'auto',
        scannedDirs: 12,
        scannedFiles: 87,
        truncated: false,
        matches: [
          {
            path: 'S:\\Development\\GuardianAgent\\src\\llm\\provider-registry.ts',
            relativePath: 'src/llm/provider-registry.ts',
            matchType: 'content',
            snippet: 'this.register(\'ollama_cloud\', (config) => new OllamaProvider(config, \'ollama_cloud\'));',
          },
        ],
      },
    });

    expect(rendered).toContain('src/llm/provider-registry.ts');
    expect(rendered).toContain('ollama_cloud');
    expect(rendered).not.toContain('[Object omitted]');
  });

  it('keeps code symbol search results path-oriented instead of collapsing matches into opaque objects', () => {
    const rendered = formatToolResultForLLM('code_symbol_search', {
      success: true,
      status: 'succeeded',
      output: {
        root: 'S:\\Development\\GuardianAgent',
        query: 'ollama_cloud',
        mode: 'auto',
        scannedDirs: 12,
        scannedFiles: 87,
        truncated: false,
        matches: [
          {
            path: 'S:\\Development\\GuardianAgent\\src\\runtime\\message-router.ts',
            relativePath: 'src/runtime/message-router.ts',
            matchType: 'name',
          },
        ],
      },
    });

    expect(rendered).toContain('src/runtime/message-router.ts');
    expect(rendered).not.toContain('[Object omitted]');
  });

  it('keeps large filesystem search results flat enough for follow-on tool calls', () => {
    const rendered = formatToolResultForLLM('fs_search', {
      success: true,
      status: 'succeeded',
      output: {
        root: 'S:\\Development\\GuardianAgent',
        query: 'routing trace',
        mode: 'content',
        scannedDirs: 12,
        scannedFiles: 87,
        truncated: false,
        matches: Array.from({ length: 40 }, (_value, index) => ({
          relativePath: `src/runtime/file-${index}.ts`,
          matchType: 'content',
          snippet: `routing trace match ${index}`,
        })),
      },
    });

    expect(rendered).toContain('src/runtime/file-39.ts');
    expect(rendered).toContain('routing trace match 39');
    expect(rendered).not.toContain('[Object omitted]');
  });

  it('keeps filesystem list results flat instead of collapsing directory entries', () => {
    const rendered = formatToolResultForLLM('fs_list', {
      success: true,
      status: 'succeeded',
      output: {
        path: 'S:\\Development\\GuardianAgent',
        entries: [
          { name: 'src', type: 'dir' },
          { name: 'package.json', type: 'file' },
        ],
      },
    });

    expect(rendered).toContain('[dir] src');
    expect(rendered).toContain('[file] package.json');
    expect(rendered).not.toContain('[Object omitted]');
  });

  it('preserves mid-file helper definitions when compacting large fs_read results', () => {
    const rendered = formatToolResultForLLM('fs_read', {
      success: true,
      status: 'succeeded',
      output: {
        path: 'S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts',
        content: [
          ...Array.from({ length: 55 }, (_value, index) => `const fillerHead${index} = ${index};`),
          'private buildCodeSessionRegistrySection(input: WorkerMessageRequest): PromptAssemblyAdditionalSection | null {',
          '  return null;',
          '}',
          ...Array.from({ length: 30 }, (_value, index) => `const fillerTail${index} = ${index};`),
        ].join('\n'),
      },
    });

    expect(rendered).toContain('definitions');
    expect(rendered).toContain('private buildCodeSessionRegistrySection');
    expect(rendered).not.toContain('[Object omitted]');
  });
});

describe('formatDirectFilesystemSearchResponse', () => {
  it('prioritizes implementation files for definition-style repo searches', () => {
    const rendered = formatDirectFilesystemSearchResponse({
      requestText: 'Search the repo for "ollama_cloud" and tell me which files define its routing.',
      root: 'S:\\Development\\GuardianAgent',
      query: 'ollama_cloud',
      scannedFiles: 20000,
      truncated: true,
      matches: [
        {
          relativePath: 'src/runtime/control-plane/provider-config-helpers.ts',
          matchType: 'content',
          snippet: `case 'ollama_cloud': return 'gpt-oss:120b';`,
        },
        {
          relativePath: 'src/llm/provider-metadata.ts',
          matchType: 'content',
          snippet: `ollama_cloud: { locality: 'external', tier: 'managed_cloud' }`,
        },
        {
          relativePath: 'src/llm/provider-registry.ts',
          matchType: 'content',
          snippet: `this.register('ollama_cloud', (config) => new OllamaProvider(config, 'ollama_cloud'));`,
        },
        {
          relativePath: 'src/llm/ollama.ts',
          matchType: 'content',
          snippet: `constructor(config: LLMConfig, providerType: 'ollama' | 'ollama_cloud' = 'ollama')`,
        },
        {
          relativePath: 'src/config/types.ts',
          matchType: 'content',
          snippet: `including ollama, ollama_cloud, openai, anthropic`,
        },
        {
          relativePath: 'src/runtime/intent-gateway.ts',
          matchType: 'content',
          snippet: `Examples: "Search the repo for ollama_cloud and tell me which files define its routing." -> route="coding_task", operation="search"`,
        },
        {
          relativePath: 'src/reference-guide.ts',
          matchType: 'content',
          snippet: `search requests in an attached coding workspace, such as \`Search the repo for "ollama_cloud"\`, should route through guarded filesystem search`,
        },
        {
          relativePath: 'src/runtime/intent-gateway.test.ts',
          matchType: 'content',
          snippet: `Search the repo for "ollama_cloud" and tell me which files define its routing.`,
        },
        {
          relativePath: 'docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md',
          matchType: 'content',
          snippet: `Search the repo for ollama_cloud and tell me which files define its routing.`,
        },
        {
          relativePath: 'scripts/ollama-harness-provider.mjs',
          matchType: 'content',
          snippet: `const DEFAULT_CLOUD_CREDENTIAL_REF = 'llm.ollama_cloud.primary';`,
        },
      ],
    });

    expect(rendered).toContain('The implementation files most likely defining this are:');
    expect(rendered).toContain('src/llm/provider-metadata.ts');
    expect(rendered).toContain('src/llm/provider-registry.ts');
    expect(rendered).not.toContain('src/runtime/intent-gateway.ts');
    expect(rendered).not.toContain('src/reference-guide.ts');
    expect(rendered).not.toContain('src/runtime/intent-gateway.test.ts');
    expect(rendered).not.toContain('docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md');
    expect(rendered).toContain('I left out 1 test match, 2 doc matches, 1 script match');
    expect(rendered).toContain('Search stopped at configured limits');
  });
});

describe('parseDirectGoogleWorkspaceIntent', () => {
  it('parses unread Outlook mailbox checks that request the top 10 items', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Check my unread Outlook mail and list the top 10 by sender, subject, and date.',
    )).toEqual({
      kind: 'gmail_unread',
      count: 10,
    });
  });

  it('parses Outlook recent summary phrasing with provider names in the middle', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Show me the recent Outlook emails with subject and snippet.',
    )).toEqual({
      kind: 'gmail_recent_summary',
      count: 3,
    });
  });

  it('parses newest Gmail inbox requests as latest-message reads instead of unread reads', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Can you show me the newest five emails in Gmail?',
    )).toEqual({
      kind: 'gmail_recent_summary',
      count: 5,
    });
  });

  it('does not treat generic "show me more emails" phrasing as unread mail without more context', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Show me 2 more emails.',
    )).toBeNull();
  });

  it('does not treat Outlook calendar requests as mailbox reads', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Show me my Outlook calendar events for tomorrow.',
    )).toBeNull();
  });
});

describe('redactConfig', () => {
  it('preserves model auto selection policy and managed-cloud role bindings in GET /api/config responses', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.llm['ollama-cloud-general'] = {
      provider: 'ollama_cloud',
      model: 'gpt-oss:120b',
      credentialRef: 'llm.ollama_cloud.general',
    };
    config.llm['ollama-cloud-coding'] = {
      provider: 'ollama_cloud',
      model: 'qwen3-coder:480b',
      credentialRef: 'llm.ollama_cloud.coding',
    };
    config.assistant.tools.modelSelection = {
      autoPolicy: 'quality_first',
      preferManagedCloudForLowPressureExternal: true,
      preferFrontierForRepoGrounded: false,
      preferFrontierForSecurity: true,
      managedCloudRouting: {
        enabled: true,
        roleBindings: {
          general: 'ollama-cloud-general',
          coding: 'ollama-cloud-coding',
        },
      },
    };

    const redacted = redactConfig(config);

    expect(redacted.assistant.tools.modelSelection).toEqual({
      autoPolicy: 'quality_first',
      preferManagedCloudForLowPressureExternal: true,
      preferFrontierForRepoGrounded: false,
      preferFrontierForSecurity: true,
      managedCloudRouting: {
        enabled: true,
        roleBindings: {
          general: 'ollama-cloud-general',
          coding: 'ollama-cloud-coding',
        },
      },
    });
  });

  it('preserves provider enabled state in GET /api/config responses', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.llm.ollama.enabled = false;

    const redacted = redactConfig(config);

    expect(redacted.llm.ollama.enabled).toBe(false);
  });
});
