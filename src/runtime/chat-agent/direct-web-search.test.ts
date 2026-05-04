import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import { tryDirectWebSearch } from './direct-web-search.js';

const message: UserMessage = {
  id: 'msg-search',
  userId: 'owner',
  channel: 'web',
  content: 'Search the web for Guardian Agent architecture',
  timestamp: 1_700_000_000_000,
};

describe('direct web search runtime', () => {
  it('formats direct search results through the active LLM when available', async () => {
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          provider: 'test-search',
          answer: 'Guardian Agent uses shared orchestration.',
          results: [
            { title: 'Architecture', url: 'https://example.test/arch', snippet: 'Shared runtime.' },
          ],
        },
      })),
    };
    const chatWithFallback = vi.fn(async () => ({ content: 'Formatted search answer.\n\nSource: https://example.test/arch' }));

    const result = await tryDirectWebSearch({
      agentId: 'chat',
      tools: tools as never,
      message,
      ctx,
      llmMessages: [{ role: 'user', content: message.content }],
      defaultToolResultProviderKind: 'external',
      sanitizeToolResultForLlm: (_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      }),
      chatWithFallback,
    });

    expect(result).toBe('Formatted search answer.\n\nSource: https://example.test/arch');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'web_search',
      { query: 'Guardian Agent architecture', maxResults: 10 },
      expect.objectContaining({
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
      }),
    );
    expect(chatWithFallback).toHaveBeenCalled();
  });

  it('returns sanitized search text directly without an LLM', async () => {
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          provider: 'test-search',
          results: [],
        },
      })),
    };

    const result = await tryDirectWebSearch({
      agentId: 'chat',
      tools: tools as never,
      message,
      ctx,
      llmMessages: [],
      defaultToolResultProviderKind: 'external',
      sanitizeToolResultForLlm: (_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      }),
      chatWithFallback: vi.fn(),
    });

    expect(result).toContain('I searched the web for "Guardian Agent architecture"');
  });

  it('falls back to grounded search text when the formatter emits tool-call planning', async () => {
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          provider: 'test-search',
          answer: 'Use source-backed release notes.',
          results: [
            { title: 'Notes', url: 'https://example.test/notes', snippet: 'Intent gateway notes.' },
          ],
        },
      })),
    };

    const result = await tryDirectWebSearch({
      agentId: 'chat',
      tools: tools as never,
      message,
      ctx,
      llmMessages: [],
      defaultToolResultProviderKind: 'external',
      sanitizeToolResultForLlm: (_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      }),
      chatWithFallback: vi.fn(async () => ({ content: 'Let’s call fs_search.' })),
    });

    expect(result).toContain('Web search results for "Guardian Agent architecture"');
    expect(result).toContain('https://example.test/notes');
  });

  it('falls back to grounded search text when the formatter narrates a future fetch', async () => {
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async () => ({
        success: true,
        output: {
          provider: 'test-search',
          results: [
            { title: 'Random useful facts', url: 'https://example.test/facts', snippet: 'Useful information.' },
          ],
        },
      })),
    };

    const result = await tryDirectWebSearch({
      agentId: 'chat',
      tools: tools as never,
      message,
      ctx,
      llmMessages: [],
      defaultToolResultProviderKind: 'external',
      sanitizeToolResultForLlm: (_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      }),
      chatWithFallback: vi.fn(async () => ({ content: 'We’ll fetch random.org and scribbr pages.' })),
    });

    expect(result).toContain('Web search results for "Guardian Agent architecture"');
    expect(result).toContain('https://example.test/facts');
  });
});
