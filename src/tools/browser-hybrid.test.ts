import { describe, expect, it, vi } from 'vitest';
import { HybridBrowserService } from './browser-hybrid.js';
import type { MCPClientManager } from './mcp-client.js';
import type { ToolDefinition, ToolResult } from './types.js';

function makeDefinition(name: string): ToolDefinition {
  return {
    name,
    description: name,
    risk: 'read_only',
    category: 'browser',
    parameters: { type: 'object', properties: {} },
  };
}

function makeManager(
  toolNames: string[],
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>,
): MCPClientManager {
  return {
    getAllToolDefinitions: () => toolNames.map((toolName) => makeDefinition(toolName)),
    callTool: vi.fn(callTool),
  } as unknown as MCPClientManager;
}

describe('HybridBrowserService', () => {
  it('reports read-first and interaction backend preferences', () => {
    const manager = makeManager([
      'mcp-playwright-browser_navigate',
      'mcp-playwright-browser_snapshot',
      'mcp-playwright-browser_click',
      'mcp-lightpanda-goto',
      'mcp-lightpanda-markdown',
      'mcp-lightpanda-links',
      'mcp-lightpanda-structuredData',
      'mcp-lightpanda-semantic_tree',
      'mcp-lightpanda-interactiveElements',
    ], async () => ({ success: true }));
    const service = new HybridBrowserService(manager);

    const capabilities = service.getCapabilities();

    expect(capabilities.available).toBe(true);
    expect(capabilities.preferredReadBackend).toBe('lightpanda');
    expect(capabilities.preferredInteractionBackend).toBe('playwright');
    expect(capabilities.wrappers.browserExtract).toBe(true);
    expect(capabilities.wrappers.browserInteract).toBe(true);
  });

  it('falls back to Playwright snapshots when Lightpanda read fails', async () => {
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === 'mcp-lightpanda-goto') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com', title: 'Example' }) };
      }
      if (toolName === 'mcp-lightpanda-markdown') {
        return { success: false, error: 'markdown failed' };
      }
      if (toolName === 'mcp-playwright-browser_navigate') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com', title: 'Example' }) };
      }
      if (toolName === 'mcp-playwright-browser_snapshot') {
        return { success: true, output: 'link ref=nav-home Home\nbutton ref=btn-login Log in' };
      }
      return { success: false, error: `Unexpected tool ${toolName}` };
    });
    const manager = makeManager([
      'mcp-playwright-browser_navigate',
      'mcp-playwright-browser_snapshot',
      'mcp-lightpanda-goto',
      'mcp-lightpanda-markdown',
    ], callTool);
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
    expect(callTool).toHaveBeenCalledWith('mcp-lightpanda-markdown', {});
    expect(callTool).toHaveBeenCalledWith('mcp-playwright-browser_snapshot', {});
  });

  it('lists interactive elements from the Lightpanda read lane', async () => {
    const manager = makeManager([
      'mcp-playwright-browser_navigate',
      'mcp-playwright-browser_click',
      'mcp-lightpanda-goto',
      'mcp-lightpanda-interactiveElements',
    ], async (toolName: string) => {
      if (toolName === 'mcp-lightpanda-goto') {
        return { success: true, output: JSON.stringify({ url: 'https://example.com/login', title: 'Login' }) };
      }
      if (toolName === 'mcp-lightpanda-interactiveElements') {
        return {
          success: true,
          output: JSON.stringify([
            { ref: 'btn-login', type: 'button', text: 'Log in' },
            { ref: 'email', type: 'textbox', text: 'Email' },
          ]),
        };
      }
      return { success: true, output: JSON.stringify({ url: 'https://example.com/login', title: 'Login' }) };
    });
    const service = new HybridBrowserService(manager);

    await service.navigate('scope-2', 'https://example.com/login');
    const result = await service.interact('scope-2', { action: 'list' });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      backend: 'lightpanda',
      action: 'list',
      elements: [
        { ref: 'btn-login', type: 'button', text: 'Log in' },
        { ref: 'email', type: 'textbox', text: 'Email' },
      ],
    });
  });
});
