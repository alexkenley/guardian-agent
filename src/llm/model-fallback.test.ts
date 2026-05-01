import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from './types.js';
import { classifyError } from './circuit-breaker.js';
import { chatProviderWithTimeout, ModelFallbackChain } from './model-fallback.js';

function createProvider(name: string, chat: LLMProvider['chat']): LLMProvider {
  return {
    name,
    chat,
    stream: async function* () {},
    listModels: async () => [],
  };
}

describe('chatProviderWithTimeout', () => {
  it('aborts and rejects provider calls that exceed the per-attempt timeout', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const provider = createProvider('stuck-provider', async (_messages, options) => {
        observedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      });

      const promise = chatProviderWithTimeout({
        provider,
        providerName: 'stuck-provider',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 50,
      });
      const expectation = expect(promise).rejects.toThrow("LLM provider 'stuck-provider' timed out after 50ms");

      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ModelFallbackChain', () => {
  it('falls through when the preferred provider hangs', async () => {
    vi.useFakeTimers();
    try {
      const stuck = createProvider('stuck', async () => new Promise<never>(() => undefined));
      const fallback = createProvider('fallback', async () => ({
        content: 'fallback ok',
        model: 'fallback-model',
        finishReason: 'stop',
      }));
      const chain = new ModelFallbackChain(new Map([
        ['stuck', stuck],
        ['fallback', fallback],
      ]), ['stuck', 'fallback']);

      const promise = chain.chatWithProviderOrder(
        ['stuck', 'fallback'],
        [{ role: 'user', content: 'hello' }],
        { maxTokens: 20 },
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(promise).resolves.toMatchObject({
        providerName: 'fallback',
        usedFallback: true,
        response: {
          content: 'fallback ok',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks the requested fallback order until a provider succeeds', async () => {
    const providers = new Map<string, LLMProvider>();
    for (const name of ['one', 'two']) {
      providers.set(name, createProvider(name, async () => {
        throw new Error(`${name} failed`);
      }));
    }
    providers.set('three', createProvider('three', async () => ({
      content: 'third provider ok',
      model: 'third-model',
      finishReason: 'stop',
    })));
    const chain = new ModelFallbackChain(providers, ['one', 'two', 'three']);

    await expect(chain.chatWithProviderOrder(
      ['one', 'two', 'three'],
      [{ role: 'user', content: 'hello' }],
      {},
    )).resolves.toMatchObject({
      providerName: 'three',
      usedFallback: true,
      response: {
        content: 'third provider ok',
      },
    });
  });
});

describe('classifyError', () => {
  it('classifies provider timeout messages as timeout errors', () => {
    expect(classifyError(new Error("LLM provider 'nvidia-direct' timed out after 30000ms"))).toBe('timeout');
  });
});
