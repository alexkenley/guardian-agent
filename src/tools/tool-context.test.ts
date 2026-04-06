import { describe, expect, it } from 'vitest';
import { buildToolContext } from './tool-context.js';

describe('buildToolContext', () => {
  const baseInput = {
    workspaceRoot: '/repo',
    policyMode: 'approve_by_policy',
    enabledCategories: ['filesystem', 'coding', 'workspace'],
    allowedPaths: ['/repo', '/repo/src', '/repo/tests', '/repo/docs', '/repo/scripts', '/repo/tmp'],
    allowedCommands: ['git status', 'git diff', 'npm test', 'npm run check', 'ls', 'cat', 'head', 'tail', 'pwd', 'date', 'echo'],
    allowedDomains: ['api.example.com', 'docs.example.com', 'github.com', 'ollama.com', 'openai.com', 'anthropic.com'],
    browserAllowedDomains: ['example.com', 'github.com'],
    browserUsesDedicatedAllowlist: true,
    browserAvailable: true,
    browserReadBackend: 'playwright',
    browserInteractBackend: 'playwright',
    dependencyLines: ['Dependencies: none'],
    deferredInventoryLines: ['Deferred tools available via find_tools.'],
    providerContextLines: [
      'Provider default: ollama',
      'Managed cloud default: ollama-cloud',
      'Frontier default: anthropic',
    ],
    googleContextLines: [
      'Google Workspace: connected',
      'Google Drive: enabled',
      'Google Docs: enabled',
      'Google Calendar: enabled',
    ],
    cloudEnabled: false,
    cloudSummaryLines: [],
    cloudProfileLines: [],
    policyUpdateActions: 'Policy updates disabled.',
  } as const;

  it('compacts inventory harder in tight mode', () => {
    const context = buildToolContext({
      ...baseInput,
      request: {
        requestText: 'Search the repo for ollama_cloud routing references.',
        toolContextMode: 'tight',
      },
    });

    expect(context).toContain('Provider default: ollama');
    expect(context).not.toContain('Managed cloud default: ollama-cloud');
    expect(context).not.toContain('Google Calendar: enabled');
    expect(context).toContain('Allowed paths (6): /repo, /repo/src, /repo/tests, /repo/docs (+2 more)');
  });

  it('keeps broader provider and workspace context in standard mode', () => {
    const context = buildToolContext({
      ...baseInput,
      request: {
        requestText: 'Review external provider routing.',
        toolContextMode: 'standard',
      },
    });

    expect(context).toContain('Provider default: ollama');
    expect(context).toContain('Managed cloud default: ollama-cloud');
    expect(context).toContain('Frontier default: anthropic');
    expect(context).toContain('Google Calendar: enabled');
  });
});
