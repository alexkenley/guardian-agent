import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { OutputGuardian } from '../guardian/output-guardian.js';
import type { Runtime } from '../runtime/runtime.js';
import type { ToolExecutor } from '../tools/executor.js';
import { CapabilityTokenManager } from './capability-token.js';
import { BrokerServer } from './broker-server.js';
import { DEFAULT_CHAT_PROVIDER_TIMEOUT_MS } from '../llm/model-fallback.js';

describe('BrokerServer', () => {
  it('returns sanitized tool output without nesting the full tool response under output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responsePromise = readFirstJsonLine(output);
    const tokenManager = new CapabilityTokenManager();
    const token = tokenManager.mint({
      workerId: 'worker-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      authorizedBy: 'owner',
      authorizedChannel: 'code-session',
      grantedCapabilities: ['tool.call'],
    });
    const runTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-1',
      message: "Tool 'fs_search' completed.",
      output: {
        root: 'S:/Development/GuardianAgent/src',
        query: 'run timeline',
        matches: [{
          relativePath: 'src/runtime/run-timeline.ts',
          matchType: 'content',
          snippet: 'export class RunTimelineStore',
        }],
      },
    }));
    const tools = {
      searchTools: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => []),
      getToolDefinition: vi.fn(() => ({
        name: 'fs_search',
        description: 'Search files.',
        parameters: { type: 'object' },
        category: 'filesystem',
      })),
      runTool,
      getApprovalSummaries: vi.fn(() => new Map()),
    } as unknown as ToolExecutor;
    const runtime = {
      outputGuardian: new OutputGuardian(undefined, { enabled: false }),
      auditLog: { record: vi.fn() },
    } as unknown as Runtime;

    new BrokerServer({
      tools,
      runtime,
      tokenManager,
      inputStream: input,
      outputStream: output,
      workerId: 'worker-1',
    });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'tool.call',
      params: {
        capabilityToken: token.id,
        toolName: 'fs_search',
        args: { query: 'run timeline' },
        requestId: 'message-1',
      },
    })}\n`);

    const response = await responsePromise as {
      result?: {
        success?: boolean;
        output?: Record<string, unknown>;
      };
      error?: unknown;
    };

    expect(response.error).toBeUndefined();
    expect(response.result?.success).toBe(true);
    expect(response.result?.output).toMatchObject({
      query: 'run timeline',
      matches: [{
        relativePath: 'src/runtime/run-timeline.ts',
        matchType: 'content',
      }],
    });
    expect(response.result?.output?.output).toBeUndefined();
    expect(runTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'fs_search',
      requestId: 'message-1',
      channel: 'code-session',
    }));
  });

  it('honors brokered LLM fallback provider order when the requested provider fails', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responsePromise = readFirstJsonLine(output);
    const tokenManager = new CapabilityTokenManager();
    const token = tokenManager.mint({
      workerId: 'worker-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      authorizedBy: 'owner',
      authorizedChannel: 'web',
      grantedCapabilities: ['llm.chat'],
    });
    const primaryChat = vi.fn(async () => {
      throw new Error('primary quota exhausted');
    });
    const fallbackChat = vi.fn(async () => ({
      content: 'fallback answer',
      model: 'fallback-model',
      finishReason: 'stop',
    }));
    const runtime = {
      registry: {
        get: vi.fn(() => ({
          definition: {
            providerName: 'openai-frontier',
          },
        })),
      },
      defaultProviderName: 'openai-frontier',
      getProviderNames: vi.fn(() => ['openai-frontier', 'anthropic-frontier']),
      getProvider: vi.fn((name: string) => {
        if (name === 'openai-frontier') {
          return { name, chat: primaryChat };
        }
        if (name === 'anthropic-frontier') {
          return { name, chat: fallbackChat };
        }
        return undefined;
      }),
    } as unknown as Runtime;
    const tools = {
      searchTools: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => []),
    } as unknown as ToolExecutor;

    new BrokerServer({
      tools,
      runtime,
      tokenManager,
      inputStream: input,
      outputStream: output,
      workerId: 'worker-1',
    });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'request-llm',
      method: 'llm.chat',
      params: {
        capabilityToken: token.id,
        providerName: 'openai-frontier',
        fallbackProviderOrder: ['openai-frontier', 'anthropic-frontier'],
        messages: [{ role: 'user', content: 'Use the ordered provider chain.' }],
        options: {},
      },
    })}\n`);

    const response = await responsePromise as {
      result?: {
        content?: string;
        providerName?: string;
        model?: string;
      };
      error?: unknown;
    };

    expect(response.error).toBeUndefined();
    expect(primaryChat).toHaveBeenCalledTimes(1);
    expect(fallbackChat).toHaveBeenCalledTimes(1);
    expect(response.result).toMatchObject({
      content: 'fallback answer',
      providerName: 'anthropic-frontier',
      model: 'fallback-model',
    });
  });

  it('times out brokered LLM calls before the agent invocation budget expires', async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const responsePromise = readFirstJsonLine(output);
      const tokenManager = new CapabilityTokenManager();
      const token = tokenManager.mint({
        workerId: 'worker-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        authorizedBy: 'owner',
        authorizedChannel: 'web',
        grantedCapabilities: ['llm.chat'],
      });
      const hungChat = vi.fn((_messages, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      }));
      const runtime = {
        registry: {
          get: vi.fn(() => ({
            definition: {
              providerName: 'slow-provider',
            },
          })),
        },
        defaultProviderName: 'slow-provider',
        getProviderNames: vi.fn(() => ['slow-provider']),
        getProvider: vi.fn((name: string) => (
          name === 'slow-provider'
            ? { name, chat: hungChat }
            : undefined
        )),
      } as unknown as Runtime;
      const tools = {
        searchTools: vi.fn(() => []),
        listAlwaysLoadedDefinitions: vi.fn(() => []),
        listCodeSessionEagerToolDefinitions: vi.fn(() => []),
      } as unknown as ToolExecutor;

      new BrokerServer({
        tools,
        runtime,
        tokenManager,
        inputStream: input,
        outputStream: output,
        workerId: 'worker-1',
      });

      input.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 'request-llm-timeout',
        method: 'llm.chat',
        params: {
          capabilityToken: token.id,
          providerName: 'slow-provider',
          messages: [{ role: 'user', content: 'This provider never responds.' }],
          options: {},
        },
      })}\n`);

      await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_PROVIDER_TIMEOUT_MS + 1);
      const response = await responsePromise as {
        result?: unknown;
        error?: { message?: string };
      };

      expect(response.result).toBeUndefined();
      expect(response.error?.message).toMatch(/timed out/i);
      expect(hungChat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the selected fallback provider profile name instead of the provider implementation type', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responsePromise = readFirstJsonLine(output);
    const tokenManager = new CapabilityTokenManager();
    const token = tokenManager.mint({
      workerId: 'worker-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      authorizedBy: 'owner',
      authorizedChannel: 'web',
      grantedCapabilities: ['llm.chat'],
    });
    const primaryChat = vi.fn(async () => {
      throw new Error('frontier unavailable');
    });
    const fallbackChat = vi.fn(async () => ({
      content: 'managed fallback answer',
      model: 'moonshotai/kimi-k2-instruct-0905',
      finishReason: 'stop',
    }));
    const runtime = {
      registry: {
        get: vi.fn(() => ({
          definition: {
            providerName: 'openai',
          },
        })),
      },
      defaultProviderName: 'openai',
      getProviderNames: vi.fn(() => ['openai', 'nvidia-tools']),
      getProvider: vi.fn((name: string) => {
        if (name === 'openai') {
          return { name: 'openai', chat: primaryChat };
        }
        if (name === 'nvidia-tools') {
          return { name: 'nvidia', chat: fallbackChat };
        }
        return undefined;
      }),
    } as unknown as Runtime;
    const tools = {
      searchTools: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => []),
    } as unknown as ToolExecutor;

    new BrokerServer({
      tools,
      runtime,
      tokenManager,
      inputStream: input,
      outputStream: output,
      workerId: 'worker-1',
    });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'request-llm-profile',
      method: 'llm.chat',
      params: {
        capabilityToken: token.id,
        providerName: 'openai',
        fallbackProviderOrder: ['openai', 'nvidia-tools'],
        messages: [{ role: 'user', content: 'Use managed cloud fallback.' }],
        options: {},
      },
    })}\n`);

    const response = await responsePromise as {
      result?: {
        content?: string;
        providerName?: string;
        providerLocality?: string;
        model?: string;
      };
      error?: unknown;
    };

    expect(response.error).toBeUndefined();
    expect(primaryChat).toHaveBeenCalledTimes(1);
    expect(fallbackChat).toHaveBeenCalledTimes(1);
    expect(response.result).toMatchObject({
      content: 'managed fallback answer',
      providerName: 'nvidia-tools',
      providerLocality: 'external',
      model: 'moonshotai/kimi-k2-instruct-0905',
    });
  });
});

function readFirstJsonLine(stream: PassThrough): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      stream.off('data', onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newlineIndex)));
      } catch (error) {
        reject(error);
      }
    };
    stream.on('data', onData);
  });
}
