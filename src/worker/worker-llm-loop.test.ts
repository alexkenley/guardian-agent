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

  it('re-prompts repo/file turns to use tools before narrating the work', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Inspect src/chat-agent.ts and write tmp/repo-summary.md with a short summary.' }];
    const responses: ChatResponse[] = [
      {
        content: 'I will inspect the file and then write the requested report.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'fs_read', arguments: JSON.stringify({ path: 'src/chat-agent.ts' }) },
          { id: 'call-2', name: 'fs_write', arguments: JSON.stringify({ path: 'tmp/repo-summary.md', content: 'chat-agent summary' }) },
        ],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Done. Inspected src/chat-agent.ts and wrote tmp/repo-summary.md.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
    const calledTools: string[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [
          {
            name: 'fs_read',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
          },
          {
            name: 'fs_write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        ];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        return {
          success: true,
          output: { message: `Completed ${request.toolName}.` },
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
      4,
      32_000,
      undefined,
      {
        toolExecutionCorrectionPrompt: 'System correction: this turn is a repo-grounded coding request. Use repo/filesystem tools now instead of narrating the work.',
      },
    );

    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('System correction'),
    });
    expect(calledTools).toHaveLength(2);
    expect(calledTools).toEqual(expect.arrayContaining(['fs_read', 'fs_write']));
    expect(result.finalContent).toContain('wrote tmp/repo-summary.md');
  });

  it('prefers a tool-free answer first for writing-plan style turns when the response is strong', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write an implementation plan before editing anything.' }];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_read',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(): Promise<ToolResult> {
        throw new Error('Tool execution should not run for a successful answer-first turn.');
      },
    };

    const result = await runLlmLoop(
      messages,
      async (msgs: ChatMessage[], opts?: ChatOptions) => {
        chatCalls.push({ messages: msgs, options: opts });
        return {
          content: 'Acceptance Gates\n- Keep the scope bounded.\n\nExisting Checks To Reuse\n- Reuse the existing coding harness before adding narrower checks.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
        };
      },
      toolCaller,
      4,
      32_000,
      undefined,
      {
        preferAnswerFirst: true,
        answerFirstResponseIsSufficient: (content) => /acceptance gates/i.test(content) && /existing checks to reuse/i.test(content),
      },
    );

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.options?.tools).toEqual([]);
    expect(result.finalContent).toContain('Acceptance Gates');
    expect(result.finalContent).toContain('Existing Checks To Reuse');
  });

  it('carries answer-first skill reads into the first real tool round when the model requests them', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write an implementation plan before editing anything.' }];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
    const calledTools: string[] = [];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{
          id: 'call-read-skill',
          name: 'fs_read',
          arguments: JSON.stringify({ path: '/skills/writing-plans/templates/implementation-plan.md' }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Acceptance Gates\n- Keep the scope bounded.\n\nExisting Checks To Reuse\n- Reuse the existing dashboard coverage.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_read',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
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
          output: {
            content: '# Plan\n\n## Acceptance Gates\n## Existing Checks To Reuse',
          },
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
      4,
      32_000,
      undefined,
      {
        preferAnswerFirst: true,
        answerFirstResponseIsSufficient: (content) => /acceptance gates/i.test(content) && /existing checks to reuse/i.test(content),
      },
    );

    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.options?.tools).toEqual([]);
    expect(calledTools).toEqual(['fs_read']);
    expect(result.finalContent).toContain('Acceptance Gates');
  });

  it('rejects weak answer-first narration and continues into the real tool loop', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write an implementation plan before editing anything.' }];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
    const calledTools: string[] = [];
    const responses: ChatResponse[] = [
      {
        content: 'Now let me find the routines code in the codebase.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{
          id: 'call-read-skill',
          name: 'fs_read',
          arguments: JSON.stringify({ path: '/skills/writing-plans/templates/implementation-plan.md' }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Acceptance Gates\n- Keep the scope bounded.\n\nExisting Checks To Reuse\n- Reuse the existing dashboard coverage.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_read',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
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
          output: {
            content: '# Plan\n\n## Acceptance Gates\n## Existing Checks To Reuse',
          },
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
      4,
      32_000,
      undefined,
      {
        preferAnswerFirst: true,
        answerFirstResponseIsSufficient: (content) => /acceptance gates/i.test(content) && /existing checks to reuse/i.test(content),
      },
    );

    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[0]?.options?.tools).toEqual([]);
    expect(calledTools).toEqual(['fs_read']);
    expect(result.finalContent).toContain('Acceptance Gates');
  });

  it('uses the shared skill-contract fallback when no valid writing-plan answer is produced', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write an implementation plan before editing anything.' }];

    const result = await runLlmLoop(
      messages,
      async () => ({
        content: 'Let me inspect the relevant files first.',
        model: 'test-model',
        finishReason: 'stop',
      }),
      {
        listAlwaysLoaded() {
          return [];
        },
        searchTools() {
          return [];
        },
        async callTool(): Promise<ToolResult> {
          throw new Error('Tool execution should not run in this fallback-only scenario.');
        },
      },
      2,
      32_000,
      undefined,
      {
        preferAnswerFirst: true,
        answerFirstCorrectionPrompt: 'Respond directly with Acceptance Gates and Existing Checks To Reuse.',
        answerFirstFallbackContent: '# Implementation Plan\n\n## Acceptance Gates\n- gate\n\n## Existing Checks To Reuse\n- reuse existing checks',
        answerFirstResponseIsSufficient: (content) => /acceptance gates/i.test(content) && /existing checks to reuse/i.test(content),
      },
    );

    expect(result.finalContent).toContain('Acceptance Gates');
    expect(result.finalContent).toContain('Existing Checks To Reuse');
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

  it('re-prompts when the model asks the user to confirm a policy update instead of calling update_tool_policy', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write a short report to C:\\Sensitive\\approval-smoke.txt and continue once approval is granted.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: "I can't write to C:\\Sensitive\\approval-smoke.txt with the current policy because that path is not on the allowed-paths list. If you'd like me to add the folder to the allowed paths, I can request that approval now. Please confirm that you want me to add C:\\Sensitive.",
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'update_tool_policy', arguments: JSON.stringify({ action: 'add_path', value: 'C:\\Sensitive' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Waiting for approval to add C:\\Sensitive to allowed paths.',
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
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
          jobId: 'job-1',
          message: 'Waiting for approval to add C:\\Sensitive to allowed paths.',
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
      4,
      32_000,
    );

    expect(calledTools).toEqual(['update_tool_policy']);
    expect(result.finalContent).toContain('Waiting for approval');
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
