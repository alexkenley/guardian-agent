import { describe, expect, it, vi } from 'vitest';
import { HybridBrowserService } from './browser-hybrid.js';
import type { MCPClientManager } from './mcp-client.js';
import type { ToolDefinition, ToolResult } from './types.js';

function makeDefinition(name: string, properties: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description: name,
    risk: 'read_only',
    category: 'browser',
    parameters: { type: 'object', properties },
  };
}

function makeManager(
  definitions: ToolDefinition[],
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>,
): MCPClientManager {
  return {
    getAllToolDefinitions: () => definitions,
    callTool: vi.fn(callTool),
  } as unknown as MCPClientManager;
}

const PLAYWRIGHT_DEFINITIONS = [
  makeDefinition('mcp-playwright-browser_navigate', { url: { type: 'string' } }),
  makeDefinition('mcp-playwright-browser_snapshot'),
  makeDefinition('mcp-playwright-browser_click', { ref: { type: 'string' } }),
  makeDefinition('mcp-playwright-browser_type', { ref: { type: 'string' }, text: { type: 'string' } }),
  makeDefinition('mcp-playwright-browser_select_option', { ref: { type: 'string' }, values: { type: 'array' } }),
  makeDefinition('mcp-playwright-browser_evaluate', { function: { type: 'string' } }),
];

describe('HybridBrowserService', () => {
  it('reports Playwright-only browser capabilities', () => {
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, async () => ({ success: true }));
    const service = new HybridBrowserService(manager);

    const capabilities = service.getCapabilities();

    expect(capabilities.available).toBe(true);
    expect(capabilities.preferredReadBackend).toBe('playwright');
    expect(capabilities.preferredInteractionBackend).toBe('playwright');
    expect(capabilities.backends.playwright).toMatchObject({
      available: true,
      navigate: true,
      snapshot: true,
      interact: true,
      evaluate: true,
    });
    expect(capabilities.wrappers.browserRead).toBe(true);
    expect(capabilities.wrappers.browserLinks).toBe(true);
    expect(capabilities.wrappers.browserExtract).toBe(true);
    expect(capabilities.wrappers.browserState).toBe(true);
    expect(capabilities.wrappers.browserAct).toBe(true);
  });

  it('reads page content from the Playwright snapshot lane', async () => {
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com', title: 'Example Domain' }) };
      }
      if (toolName === 'mcp-playwright-browser_snapshot') {
        return {
          success: true,
          output: JSON.stringify({
            snapshot: 'heading ref=h1 Example Domain\nlink ref=link-more-info More information...',
          }),
        };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, callTool);
    const service = new HybridBrowserService(manager);

    const navigate = await service.navigate('scope-1', 'https://example.com');
    const read = await service.read('scope-1', {});

    expect(navigate.success).toBe(true);
    expect(read.success).toBe(true);
    expect(read.output).toMatchObject({
      backend: 'playwright',
      contentType: 'snapshot',
      url: 'https://example.com',
    });
    expect((read.output as { content: string }).content).toContain('Example Domain');
    expect(callTool).toHaveBeenCalledWith('mcp-playwright-browser_snapshot', {});
  });

  it('extracts page links through Playwright evaluate', async () => {
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com', title: 'Example Domain' }) };
      }
      if (toolName === 'mcp-playwright-browser_evaluate') {
        return {
          success: true,
          output: JSON.stringify([{ text: 'More information...', href: '/help/example-domains' }]),
        };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, callTool);
    const service = new HybridBrowserService(manager);

    const result = await service.links('scope-links', { url: 'https://example.com' });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      backend: 'playwright',
      links: [{ text: 'More information...', href: 'https://example.com/help/example-domains' }],
    });
    expect(callTool).toHaveBeenCalledWith(
      'mcp-playwright-browser_evaluate',
      expect.objectContaining({ function: expect.stringContaining('querySelectorAll') }),
    );
  });

  it('extracts structured metadata and semantic outline through Playwright', async () => {
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://github.com', title: 'GitHub' }) };
      }
      if (toolName === 'mcp-playwright-browser_snapshot') {
        return {
          success: true,
          output: JSON.stringify({
            snapshot: 'heading ref=h1 Build and ship software\nlink ref=signin Sign in',
          }),
        };
      }
      if (toolName === 'mcp-playwright-browser_evaluate') {
        return {
          success: true,
          output: JSON.stringify({
            metadata: { title: 'GitHub', description: 'Build and ship software.' },
            headings: [{ level: 1, text: 'Build and ship software' }],
            landmarks: [{ role: 'main', label: null }],
            jsonLd: [],
          }),
        };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, callTool);
    const service = new HybridBrowserService(manager);

    const result = await service.extract('scope-extract', { url: 'https://github.com', type: 'both' });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      backend: 'playwright',
      type: 'both',
      structuredData: {
        metadata: { title: 'GitHub' },
      },
    });
    expect((result.output as { semanticTree: string }).semanticTree).toContain('Document: GitHub');
    expect((result.output as { semanticTree: string }).semanticTree).toContain('- Main');
  });

  it('captures Playwright-backed interactive state and acts on stable refs', async () => {
    let tick = 1_000;
    const now = vi.fn(() => {
      tick += 100;
      return tick;
    });
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, async (toolName: string) => {
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com/login', title: 'Login' }) };
      }
      if (toolName === 'mcp-playwright-browser_snapshot') {
        return {
          success: true,
          output: 'textbox ref=email Email\nbutton ref=btn-login Log in',
        };
      }
      if (toolName === 'mcp-playwright-browser_click') {
        return { success: true, output: JSON.stringify({ clicked: 'btn-login', url: 'https://example.com/login' }) };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const service = new HybridBrowserService(manager, now);

    const state = await service.state('scope-2', { url: 'https://example.com/login' });
    expect(state.success).toBe(true);
    expect(state.output).toMatchObject({
      backend: 'playwright',
      elements: [
        { ref: 'email', type: 'textbox', text: 'Email' },
        { ref: 'btn-login', type: 'button', text: 'Log in' },
      ],
    });

    const stateId = (state.output as { stateId: string }).stateId;
    const act = await service.act('scope-2', {
      stateId,
      action: 'click',
      ref: 'btn-login',
    });

    expect(act.success).toBe(true);
    expect(act.output).toMatchObject({
      backend: 'playwright',
      action: 'click',
      ref: 'btn-login',
      target: { ref: 'btn-login', type: 'button' },
    });
  });

  it('parses interactive roles even when Playwright snapshot lines are prefixed', async () => {
    const manager = makeManager(PLAYWRIGHT_DEFINITIONS, async (toolName: string) => {
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://httpbin.org/forms/post', title: 'HTTPBin Forms' }) };
      }
      if (toolName === 'mcp-playwright-browser_snapshot') {
        return {
          success: true,
          output: [
            '- generic [ref=e2]:',
            '- textbox "Customer name:" [ref=e5]',
            '- textbox "Telephone:" [ref=e8]',
            '- button "Submit order" [ref=e20]',
          ].join('\n'),
        };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const service = new HybridBrowserService(manager);

    const state = await service.state('scope-3', { url: 'https://httpbin.org/forms/post' });

    expect(state.success).toBe(true);
    expect(state.output).toMatchObject({
      elements: [
        { ref: 'e5', type: 'textbox', text: '"Customer name:" []' },
        { ref: 'e8', type: 'textbox', text: '"Telephone:" []' },
        { ref: 'e20', type: 'button', text: '"Submit order" []' },
      ],
    });
  });
});
