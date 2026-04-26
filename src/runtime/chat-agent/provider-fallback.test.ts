import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../agent/types.js';
import type { ChatMessage, ChatResponse } from '../../llm/types.js';
import {
  chatWithFallback,
  chatWithRoutingMetadata,
  resolvePreferredProviderOrder,
} from './provider-fallback.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const response = (content: string): ChatResponse => ({
  content,
  toolCalls: [],
  model: 'test-model',
  finishReason: 'stop',
});

function ctx(name: string, chat = vi.fn(async () => response('primary'))): AgentContext {
  return {
    agentId: 'chat',
    emit: vi.fn(async () => {}),
    llm: {
      name,
      chat,
    } as never,
    checkAction: vi.fn(),
    capabilities: [],
  };
}

describe('provider fallback runtime', () => {
  it('normalizes preferred provider order', () => {
    expect(resolvePreferredProviderOrder([' ollama-cloud ', '', 'openai', 'ollama-cloud'])).toEqual([
      'ollama-cloud',
      'openai',
    ]);
    expect(resolvePreferredProviderOrder([])).toBeUndefined();
  });

  it('starts on the selected provider when it differs from the current context provider', async () => {
    const primaryChat = vi.fn(async () => response('primary'));
    const fallbackChain = {
      chatWithProviderOrder: vi.fn(async () => ({
        providerName: 'ollama-cloud-coding',
        usedFallback: false,
        skipped: [],
        response: response('selected provider'),
      })),
      chatWithFallback: vi.fn(),
      chatWithFallbackAfterPrimary: vi.fn(),
      chatWithFallbackAfterProvider: vi.fn(),
    };

    const result = await chatWithRoutingMetadata({
      agentId: 'chat',
      ctx: ctx('ollama', primaryChat),
      messages,
      fallbackProviderOrder: ['ollama-cloud-coding', 'openai'],
      fallbackChain,
      log: { warn: vi.fn() },
    });

    expect(primaryChat).not.toHaveBeenCalled();
    expect(fallbackChain.chatWithProviderOrder).toHaveBeenCalledWith(
      ['ollama-cloud-coding', 'openai'],
      messages,
      undefined,
    );
    expect(result).toMatchObject({
      providerName: 'ollama-cloud-coding',
      providerLocality: 'external',
      response: { content: 'selected provider' },
      usedFallback: false,
    });
  });

  it('falls back after a primary provider failure', async () => {
    const primaryChat = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const fallbackChain = {
      chatWithProviderOrder: vi.fn(),
      chatWithFallback: vi.fn(async () => ({
        providerName: 'openai',
        usedFallback: true,
        skipped: ['ollama'],
        response: response('fallback'),
      })),
      chatWithFallbackAfterPrimary: vi.fn(),
      chatWithFallbackAfterProvider: vi.fn(),
    };

    const result = await chatWithFallback({
      agentId: 'chat',
      ctx: ctx('ollama', primaryChat),
      messages,
      fallbackChain,
      log: { warn: vi.fn() },
    });

    expect(result.content).toBe('fallback');
    expect(fallbackChain.chatWithFallback).toHaveBeenCalledWith(messages, undefined);
  });
});
