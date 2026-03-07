import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { ToolDefinition, ToolResult } from './types.js';

const handler = async (): Promise<ToolResult> => ({ success: true });

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: `${overrides.name} tool`,
    risk: 'read_only',
    parameters: { type: 'object', properties: {} },
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  describe('listAlwaysLoaded', () => {
    it('excludes deferred tools', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'always1' }), handler);
      registry.register(makeTool({ name: 'deferred1', deferLoading: true }), handler);
      registry.register(makeTool({ name: 'always2' }), handler);
      registry.register(makeTool({ name: 'deferred2', deferLoading: true }), handler);

      const always = registry.listAlwaysLoaded();
      expect(always.map((t) => t.name)).toEqual(['always1', 'always2']);
    });

    it('returns all tools when none are deferred', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'a' }), handler);
      registry.register(makeTool({ name: 'b' }), handler);

      expect(registry.listAlwaysLoaded()).toHaveLength(2);
    });
  });

  describe('searchTools', () => {
    it('finds tools by name keyword', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'net_ping', description: 'Ping a host' }), handler);
      registry.register(makeTool({ name: 'net_arp_scan', description: 'ARP scan' }), handler);
      registry.register(makeTool({ name: 'fs_read', description: 'Read a file' }), handler);

      const results = registry.searchTools('net');
      expect(results.map((t) => t.name)).toContain('net_ping');
      expect(results.map((t) => t.name)).toContain('net_arp_scan');
      expect(results.map((t) => t.name)).not.toContain('fs_read');
    });

    it('finds tools by description keyword', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'web_fetch', description: 'Fetch content from URL' }), handler);
      registry.register(makeTool({ name: 'fs_read', description: 'Read a file' }), handler);

      const results = registry.searchTools('fetch');
      expect(results.map((t) => t.name)).toEqual(['web_fetch']);
    });

    it('finds tools by category', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'net_ping', category: 'network' }), handler);
      registry.register(makeTool({ name: 'fs_read', category: 'filesystem' }), handler);

      const results = registry.searchTools('network');
      expect(results.map((t) => t.name)).toEqual(['net_ping']);
    });

    it('ranks name matches higher than description matches', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'email_send', description: 'Send an email' }), handler);
      registry.register(makeTool({ name: 'web_fetch', description: 'Fetch email content from web' }), handler);

      const results = registry.searchTools('email');
      expect(results[0].name).toBe('email_send');
    });

    it('respects maxResults', () => {
      const registry = new ToolRegistry();
      for (let i = 0; i < 20; i++) {
        registry.register(makeTool({ name: `tool_${i}`, description: 'common keyword' }), handler);
      }

      const results = registry.searchTools('common', 5);
      expect(results).toHaveLength(5);
    });

    it('returns empty for no match', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'fs_read', description: 'Read a file' }), handler);

      expect(registry.searchTools('nonexistent')).toHaveLength(0);
    });

    it('handles multi-word queries', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'net_arp_scan', description: 'Scan ARP table for devices' }), handler);
      registry.register(makeTool({ name: 'net_ping', description: 'Ping a host' }), handler);

      const results = registry.searchTools('scan devices');
      expect(results[0].name).toBe('net_arp_scan');
    });

    it('searches shortDescription', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool({ name: 'myTool', description: 'Full desc', shortDescription: 'unicorn magic' }),
        handler,
      );

      const results = registry.searchTools('unicorn');
      expect(results).toHaveLength(1);
    });
  });
});
