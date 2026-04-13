import { describe, it, expect } from 'vitest';
import { runLlmLoop } from './worker-llm-loop.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ToolCaller, ToolResult } from '../broker/types.js';

describe('runLlmLoop', () => {
  it('returns a tool-result summary when a post-tool LLM round produces empty content', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Resolve the WHM hostname IP.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'net_dns_lookup', arguments: JSON.stringify({ target: 'vmres13.web-servers.com.au' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: '',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'net_dns_lookup',
          description: 'Resolve hostname to IPs.',
          parameters: {
            type: 'object',
            properties: {
              target: { type: 'string' },
            },
            required: ['target'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(): Promise<ToolResult> {
        return {
          success: true,
          output: { target: 'vmres13.web-servers.com.au', type: 'A', records: ['203.0.113.10'] },
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (_msgs: ChatMessage[], _opts?: ChatOptions) => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      3,
      32_000,
    );

    expect(result.finalContent).toBe('Completed net_dns_lookup.');
  });

  it('tries one tool-free recovery round before falling back to a raw tool summary', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Inspect the repo and give me an implementation plan.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'fs_list', arguments: JSON.stringify({ path: 'src' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: '',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: 'Acceptance Gates\n- Ship a usable plan.\n\nExisting Checks To Reuse\n- Reuse the existing test harness before adding narrower checks.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_list',
          description: 'List files.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(): Promise<ToolResult> {
        return {
          success: true,
          output: { path: 'src', entries: [{ name: 'App.tsx', type: 'file' }] },
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (msgs: ChatMessage[], opts?: ChatOptions) => {
        chatCalls.push({ messages: msgs, options: opts });
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      3,
      32_000,
    );

    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[2]?.options?.tools).toEqual([]);
    expect(result.finalContent).toContain('Acceptance Gates');
    expect(result.finalContent).not.toBe('Completed fs_list.');
  });

  it('re-prompts when the model falsely claims update_tool_policy is unavailable', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Add vmres13.web-servers.com.au to allowed domains and then test my social WHM.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: "The update_tool_policy tool is not available in this environment. You'll need to manually add the domain to the config.",
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'update_tool_policy', arguments: JSON.stringify({ action: 'add_domain', value: 'vmres13.web-servers.com.au' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Policy updated: vmres13.web-servers.com.au is pending approval.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const calledTools: string[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'update_tool_policy',
          description: 'Update tool sandbox policy.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['action', 'value'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        return {
          success: true,
          output: { message: "Policy updated: add_domain 'vmres13.web-servers.com.au'." },
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (_msgs: ChatMessage[], _opts?: ChatOptions) => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      4,
      32_000,
    );

    expect(calledTools).toEqual(['update_tool_policy']);
    expect(result.finalContent).toContain('pending approval');
  });

  it('recovers tool calls when the model emits JSON in content instead of native tool calls', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Search the web for Guardian Agent.' }];
    const responses: ChatResponse[] = [
      {
        content: JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'web_search',
                arguments: { query: 'Guardian Agent', maxResults: 3 },
              },
            },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: 'Guardian Agent is an orchestration-focused assistant runtime.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const calledTools: string[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'web_search',
          description: 'Search the web.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              maxResults: { type: 'number' },
            },
            required: ['query'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        expect(request.args).toEqual({ query: 'Guardian Agent', maxResults: 3 });
        return {
          success: true,
          output: {
            answer: 'Guardian Agent is an orchestration-focused assistant runtime.',
          },
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      3,
      32_000,
    );

    expect(calledTools).toEqual(['web_search']);
    expect(result.finalContent).toContain('orchestration-focused assistant runtime');
  });

  it('denies memory mutations unless the user explicitly requested them', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'What did I ask you to remember last week?' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'memory_save', arguments: JSON.stringify({ content: 'Remember the secret build token.' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'I will not save that unless you explicitly ask me to remember it.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const toolCalls: string[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'memory_save',
          description: 'Save something to durable memory.',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string' },
            },
            required: ['content'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        toolCalls.push(request.toolName);
        return {
          success: true,
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      3,
      32_000,
    );

    expect(toolCalls).toEqual([]);
    expect(result.finalContent).toContain('explicitly ask');
  });

  it('discovers deferred tools through search when the tool is not initially loaded', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Read the page.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'browser_read', arguments: JSON.stringify({ url: 'https://example.com' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Read complete.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const searchQueries: string[] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [];
      },
      async searchTools(query) {
        searchQueries.push(query);
        return [{
          name: 'browser_read',
          description: 'Read page content.',
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
          risk: 'read_only',
          category: 'browser',
        }];
      },
      async callTool(request): Promise<ToolResult> {
        expect(request.toolName).toBe('browser_read');
        return { success: true, output: { content: 'Example Domain' } };
      },
    };

    const result = await runLlmLoop(messages, async () => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected extra chatFn call');
      return next;
    }, toolCaller, 3, 32_000);

    expect(searchQueries.length).toBeGreaterThan(0);
    expect(result.finalContent).toContain('Read complete.');
    expect(messages.some((message) => message.role === 'tool' && message.content.includes('<tool_result name="browser_read"'))).toBe(true);
  });

  it('passes the model memory-mutation allowance through to the tool caller', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Please remember that I prefer terse updates.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'memory_save', arguments: JSON.stringify({ content: 'User prefers terse updates.' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Saved it.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const allowances: boolean[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'memory_save',
          description: 'Save something to durable memory.',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string' },
            },
            required: ['content'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        allowances.push(request.allowModelMemoryMutation === true);
        return {
          success: true,
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      3,
      32_000,
      undefined,
      { allowModelMemoryMutation: true },
    );

    expect(allowances).toEqual([true]);
    expect(result.finalContent).toContain('Saved it.');
  });
});
