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
    expect(capabilities.wrappers.browserState).toBe(true);
    expect(capabilities.wrappers.browserAct).toBe(true);
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

  it('captures Playwright-backed interactive state and acts on stable refs', async () => {
    let tick = 1_000;
    const now = vi.fn(() => {
      tick += 100;
      return tick;
    });
    const manager = makeManager([
      'mcp-playwright-browser_navigate',
      'mcp-playwright-browser_snapshot',
      'mcp-playwright-browser_click',
      'mcp-playwright-browser_type',
    ], async (toolName: string) => {
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
});
