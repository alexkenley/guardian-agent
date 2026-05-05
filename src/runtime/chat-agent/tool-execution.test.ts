import { describe, expect, it, vi } from 'vitest';

import { executeToolsConflictAware } from './tool-execution.js';

describe('executeToolsConflictAware', () => {
  it('normalizes malformed JSON-wrapped tool names before execution', async () => {
    const executeModelTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => ({
      success: true,
      toolName,
      args,
    }));

    const results = await Promise.all(
      executeToolsConflictAware({
        toolCalls: [
          {
            id: 'call-1',
            name: '{"name":"fs_search","arguments":{"path":"src","pattern":"timeline"}}',
            arguments: '{}',
          },
        ],
        toolExecOrigin: {
          origin: 'assistant',
          agentId: 'chat',
          principalId: 'owner',
          principalRole: 'owner',
          channel: 'web',
        },
        referenceTime: 1,
        tools: {
          executeModelTool,
          getToolDefinition: vi.fn((toolName: string) => toolName === 'fs_search'
            ? {
                name: 'fs_search',
                description: 'Search files.',
                parameters: {},
                risk: 'read_only',
              }
            : undefined),
        } as never,
      }),
    );

    expect(executeModelTool).toHaveBeenCalledWith(
      'fs_search',
      { path: 'src', pattern: 'timeline' },
      expect.objectContaining({
        origin: 'assistant',
        agentId: 'chat',
        channel: 'web',
        principalId: 'owner',
        principalRole: 'owner',
      }),
    );
    expect(results).toEqual([
      {
        toolCall: {
          id: 'call-1',
          name: 'fs_search',
          arguments: JSON.stringify({ path: 'src', pattern: 'timeline' }),
        },
        result: {
          success: true,
          toolName: 'fs_search',
          args: { path: 'src', pattern: 'timeline' },
        },
      },
    ]);
  });

  it('coalesces compatible package installs before execution', async () => {
    const executeModelTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => ({
      success: true,
      toolName,
      args,
    }));

    const results = await Promise.all(
      executeToolsConflictAware({
        toolCalls: [
          {
            id: 'call-1',
            name: 'package_install',
            arguments: JSON.stringify({ command: 'npm install -D typescript', cwd: 'S:\\Development\\MusicApp' }),
          },
          {
            id: 'call-2',
            name: 'package_install',
            arguments: JSON.stringify({ command: 'npm install -D tsx', cwd: 'S:\\Development\\MusicApp' }),
          },
        ],
        toolExecOrigin: {
          origin: 'assistant',
          agentId: 'chat',
          principalId: 'owner',
          principalRole: 'owner',
          channel: 'web',
        },
        referenceTime: 1,
        tools: {
          executeModelTool,
          getToolDefinition: vi.fn((toolName: string) => toolName === 'package_install'
            ? {
                name: 'package_install',
                description: 'Install packages.',
                parameters: {},
                risk: 'mutating',
              }
            : undefined),
        } as never,
      }),
    );

    expect(executeModelTool).toHaveBeenCalledTimes(1);
    expect(executeModelTool).toHaveBeenCalledWith(
      'package_install',
      { command: 'npm install -D typescript tsx', cwd: 'S:\\Development\\MusicApp' },
      expect.objectContaining({ origin: 'assistant', channel: 'web' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCall).toEqual({
      id: 'call-1',
      name: 'package_install',
      arguments: JSON.stringify({
        command: 'npm install -D typescript tsx',
        cwd: 'S:\\Development\\MusicApp',
      }),
    });
  });
});
