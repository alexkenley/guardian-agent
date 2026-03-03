/**
 * MCP Integration Tests
 *
 * Tests the wiring between MCPClientManager → ToolExecutor:
 * - MCP tool registration
 * - Tool call routing to MCPClientManager
 * - Policy enforcement on MCP tools
 * - Tool name parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClientManager, type MCPServerConfig } from './mcp-client.js';
import { ToolExecutor } from './executor.js';
import type { ToolDefinition, ToolResult } from './types.js';

// ─── Mock MCPClientManager ─────────────────────────────────

function createMockMCPManager(tools: ToolDefinition[], callResult?: ToolResult): MCPClientManager {
  const manager = new MCPClientManager();

  // Override getAllToolDefinitions to return mock tools
  vi.spyOn(manager, 'getAllToolDefinitions').mockReturnValue(tools);

  // Override callTool to return mock result
  vi.spyOn(manager, 'callTool').mockResolvedValue(
    callResult ?? { success: true, output: 'mock output' },
  );

  return manager;
}

// ─── Tests ──────────────────────────────────────────────────

describe('MCPClientManager.parseToolName', () => {
  it('should parse valid mcp-<serverId>-<toolName>', () => {
    const result = MCPClientManager.parseToolName('mcp-filesystem-read_file');
    expect(result).toEqual({ serverId: 'filesystem', toolName: 'read_file' });
  });

  it('should parse tool names with hyphens', () => {
    const result = MCPClientManager.parseToolName('mcp-db-query-execute');
    expect(result).toEqual({ serverId: 'db', toolName: 'query-execute' });
  });

  it('should return null for non-mcp names', () => {
    expect(MCPClientManager.parseToolName('read_file')).toBeNull();
    expect(MCPClientManager.parseToolName('mcp-')).toBeNull();
    expect(MCPClientManager.parseToolName('mcp-only')).toBeNull();
  });
});

describe('ToolExecutor MCP integration', () => {
  const mcpTools: ToolDefinition[] = [
    {
      name: 'mcp-fs-read_file',
      description: 'Read a file from the filesystem MCP server',
      risk: 'network',
      parameters: { path: { type: 'string' } },
    },
    {
      name: 'mcp-fs-write_file',
      description: 'Write a file via the filesystem MCP server',
      risk: 'network',
      parameters: { path: { type: 'string' }, content: { type: 'string' } },
    },
    {
      name: 'mcp-db-query',
      description: 'Run a SQL query via the database MCP server',
      risk: 'network',
      parameters: { sql: { type: 'string' } },
    },
  ];

  let executor: ToolExecutor;
  let mockManager: MCPClientManager;

  beforeEach(() => {
    mockManager = createMockMCPManager(mcpTools, {
      success: true,
      output: 'file contents here',
      metadata: { server: 'fs', tool: 'read_file' },
    });

    executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'autonomous',
      mcpManager: mockManager,
    });
  });

  it('should register MCP tools in the tool registry', () => {
    const defs = executor.listToolDefinitions();
    const mcpDefs = defs.filter(d => d.name.startsWith('mcp-'));

    expect(mcpDefs).toHaveLength(3);
    expect(mcpDefs.map(d => d.name).sort()).toEqual([
      'mcp-db-query',
      'mcp-fs-read_file',
      'mcp-fs-write_file',
    ]);
  });

  it('should include MCP tools alongside built-in tools', () => {
    const defs = executor.listToolDefinitions();
    const builtinDefs = defs.filter(d => !d.name.startsWith('mcp-'));
    const mcpDefs = defs.filter(d => d.name.startsWith('mcp-'));

    expect(builtinDefs.length).toBeGreaterThan(0);
    expect(mcpDefs.length).toBe(3);
  });

  it('should route MCP tool calls to MCPClientManager.callTool', async () => {
    const result = await executor.runTool({
      toolName: 'mcp-fs-read_file',
      args: { path: '/test.txt' },
      origin: 'assistant',
    });

    expect(result.success).toBe(true);
    expect(mockManager.callTool).toHaveBeenCalledWith(
      'mcp-fs-read_file',
      { path: '/test.txt' },
    );
  });

  it('should return tool result from MCP server', async () => {
    const result = await executor.runTool({
      toolName: 'mcp-db-query',
      args: { sql: 'SELECT 1' },
      origin: 'assistant',
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('file contents here');
  });

  it('should handle MCP tool call failure', async () => {
    vi.spyOn(mockManager, 'callTool').mockResolvedValue({
      success: false,
      error: 'MCP server connection lost',
    });

    const result = await executor.runTool({
      toolName: 'mcp-fs-read_file',
      args: { path: '/missing.txt' },
      origin: 'assistant',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('MCP server connection lost');
  });

  it('should reject unknown MCP tool names', async () => {
    const result = await executor.runTool({
      toolName: 'mcp-unknown-nonexistent',
      args: {},
      origin: 'assistant',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown tool");
  });

  it('should track MCP tool calls in job history', async () => {
    await executor.runTool({
      toolName: 'mcp-fs-read_file',
      args: { path: '/test.txt' },
      origin: 'assistant',
    });

    const jobs = executor.listJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].toolName).toBe('mcp-fs-read_file');
    expect(jobs[0].risk).toBe('network');
    expect(jobs[0].status).toBe('succeeded');
  });

  it('should preserve MCP tool risk level as network', () => {
    const defs = executor.listToolDefinitions();
    const mcpDefs = defs.filter(d => d.name.startsWith('mcp-'));

    for (const def of mcpDefs) {
      expect(def.risk).toBe('network');
    }
  });
});

describe('ToolExecutor MCP policy enforcement', () => {
  it('should apply approve_each policy to MCP tools', async () => {
    const tools: ToolDefinition[] = [{
      name: 'mcp-srv-dangerous_tool',
      description: 'A risky tool',
      risk: 'network',
      parameters: {},
    }];

    const manager = createMockMCPManager(tools);
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'approve_each',
      mcpManager: manager,
    });

    const result = await executor.runTool({
      toolName: 'mcp-srv-dangerous_tool',
      args: {},
      origin: 'assistant',
    });

    // network risk + approve_each = require_approval
    expect(result.status).toBe('pending_approval');
    expect(result.approvalId).toBeDefined();
  });

  it('should allow MCP tools in approve_by_policy mode (network risk = allow)', async () => {
    const tools: ToolDefinition[] = [{
      name: 'mcp-srv-safe_tool',
      description: 'A safe network tool',
      risk: 'network',
      parameters: {},
    }];

    const manager = createMockMCPManager(tools);
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'approve_by_policy',
      mcpManager: manager,
    });

    const result = await executor.runTool({
      toolName: 'mcp-srv-safe_tool',
      args: {},
      origin: 'assistant',
    });

    // network risk + approve_by_policy = allow
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('should deny MCP tools with explicit deny policy', async () => {
    const tools: ToolDefinition[] = [{
      name: 'mcp-srv-blocked_tool',
      description: 'A blocked tool',
      risk: 'network',
      parameters: {},
    }];

    const manager = createMockMCPManager(tools);
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'autonomous',
      toolPolicies: { 'mcp-srv-blocked_tool': 'deny' },
      mcpManager: manager,
    });

    const result = await executor.runTool({
      toolName: 'mcp-srv-blocked_tool',
      args: {},
      origin: 'assistant',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('denied');
  });

  it('should auto-allow MCP tools with explicit auto policy', async () => {
    const tools: ToolDefinition[] = [{
      name: 'mcp-srv-auto_tool',
      description: 'Auto-allowed tool',
      risk: 'network',
      parameters: {},
    }];

    const manager = createMockMCPManager(tools);
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'approve_each',
      toolPolicies: { 'mcp-srv-auto_tool': 'auto' },
      mcpManager: manager,
    });

    const result = await executor.runTool({
      toolName: 'mcp-srv-auto_tool',
      args: {},
      origin: 'assistant',
    });

    // explicit auto overrides approve_each
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
  });
});

describe('ToolExecutor without MCP', () => {
  it('should work normally without mcpManager', () => {
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'autonomous',
    });

    const defs = executor.listToolDefinitions();
    const mcpDefs = defs.filter(d => d.name.startsWith('mcp-'));
    expect(mcpDefs).toHaveLength(0);
    expect(defs.length).toBeGreaterThan(0);
  });
});

describe('ToolExecutor registerMCPTools idempotency', () => {
  it('should not duplicate tools on repeated calls', () => {
    const tools: ToolDefinition[] = [{
      name: 'mcp-srv-tool_a',
      description: 'Tool A',
      risk: 'network',
      parameters: {},
    }];

    const manager = createMockMCPManager(tools);
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: '/workspace',
      policyMode: 'autonomous',
      mcpManager: manager,
    });

    // registerMCPTools already called in constructor; call again
    executor.registerMCPTools();
    executor.registerMCPTools();

    const defs = executor.listToolDefinitions();
    const matches = defs.filter(d => d.name === 'mcp-srv-tool_a');
    expect(matches).toHaveLength(1);
  });
});
