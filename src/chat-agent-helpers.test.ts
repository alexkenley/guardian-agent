import { describe, expect, it } from 'vitest';
import {
  formatDirectFilesystemSearchResponse,
  formatToolResultForLLM,
  parseDirectGoogleWorkspaceIntent,
} from './chat-agent-helpers.js';

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
          relativePath: 'docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md',
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
    expect(rendered).not.toContain('docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md');
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

  it('does not treat Outlook calendar requests as mailbox reads', () => {
    expect(parseDirectGoogleWorkspaceIntent(
      'Show me my Outlook calendar events for tomorrow.',
    )).toBeNull();
  });
});
