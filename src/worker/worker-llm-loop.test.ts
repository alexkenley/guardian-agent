import { describe, it, expect } from 'vitest';
import { runLlmLoop } from './worker-llm-loop.js';
import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from '../llm/types.js';
import type { ToolCaller, ToolResult } from '../broker/types.js';
import type { PlannedTask } from '../runtime/execution/types.js';

describe('runLlmLoop', () => {
  it('falls back to an explicit empty-response failure when a post-tool LLM round produces empty content', async () => {
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

    expect(result.finalContent).toBe('I could not generate a final response for that request.');
    expect(result.outcome).toMatchObject({
      stopReason: 'end_turn',
      completionReason: 'empty_response_fallback',
      responseQuality: 'final',
      toolCallCount: 1,
      toolResultCount: 1,
      successfulToolResultCount: 1,
    });
  });

  it('returns narration-only replies as normal terminal model responses', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Inspect the repo and start fixing the bug.' }];

    const result = await runLlmLoop(
      messages,
      async () => ({
        content: 'I will inspect the repository first and then start fixing the bug.',
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
          throw new Error('Tool execution should not run for a narration-only turn.');
        },
      },
      2,
      32_000,
    );

    expect(result.finalContent).toContain('inspect the repository first');
    expect(result.outcome).toEqual({
      stopReason: 'end_turn',
      completionReason: 'model_response',
      responseQuality: 'final',
      roundCount: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      successfulToolResultCount: 0,
    });
  });

  it('counts only successful tool results as usable evidence', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write the report file if policy allows it.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'fs_write', arguments: JSON.stringify({ path: 'tmp/report.md', content: 'report' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'The write is still blocked pending policy approval.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
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
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(): Promise<ToolResult> {
        return {
          success: false,
          status: 'failed',
          message: 'Path is blocked by policy.',
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

    expect(result.outcome).toMatchObject({
      toolCallCount: 1,
      toolResultCount: 1,
      successfulToolResultCount: 0,
    });
  });

  it('normalizes malformed JSON-wrapped tool calls before invoking broker tools', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Find timeline rendering in the repo.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: '{"name":"fs_search","arguments":{"path":"src","pattern":"timeline"}}',
          arguments: '{}',
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Found timeline-related files.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const seenRequests: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_search',
          description: 'Search files.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              pattern: { type: 'string' },
            },
          },
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        seenRequests.push({
          toolName: request.toolName,
          args: request.args,
        });
        return {
          success: true,
          output: {
            matches: [{ path: 'src/runtime/run-timeline.ts' }],
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

    expect(seenRequests).toEqual([
      {
        toolName: 'fs_search',
        args: { path: 'src', pattern: 'timeline' },
      },
    ]);
    expect(result.finalContent).toBe('Found timeline-related files.');
    expect(result.outcome).toMatchObject({
      toolCallCount: 1,
      toolResultCount: 1,
      successfulToolResultCount: 1,
    });
  });

  it('does not fabricate a raw tool summary when a post-tool round stays empty', async () => {
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

    expect(chatCalls).toHaveLength(2);
    expect(result.finalContent).toBe('I could not generate a final response for that request.');
    expect(result.outcome.completionReason).toBe('empty_response_fallback');
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

  it('does not accept tool-free answer-first replies when the turn requires repo evidence', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Inspect src/chat-agent.ts and write tmp/repo-summary.md with a short summary.' }];
    const responses: ChatResponse[] = [
      {
        content: "I'll inspect the file and then write the requested report.",
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
        preferAnswerFirst: true,
        toolExecutionCorrectionPrompt: 'System correction: this turn is a repo-grounded coding request. Use repo/filesystem tools now instead of narrating the work.',
      },
    );

    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[0]?.options?.tools).toEqual([]);
    expect(calledTools).toEqual(expect.arrayContaining(['fs_read', 'fs_write']));
    expect(result.outcome.completionReason).toBe('model_response');
    expect(result.finalContent).toContain('wrote tmp/repo-summary.md');
  });

  it('does not accept synthetic tool-response markup as answer-first completion', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Find matching automations and suggest one useful automation.' }];
    const responses: ChatResponse[] = [
      {
        content: '<tool_response><tool_name>fs_search</tool_name><tool_args>{"pattern":"approval"}</tool_args></tool_response>',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'fs_search', arguments: JSON.stringify({ pattern: 'approval' }) },
        ],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Found related automation material and suggested an approval continuity monitor.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
    const calledTools: string[] = [];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'fs_search',
          description: 'Search files.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
            required: ['pattern'],
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
          output: { matches: [{ path: 'docs/design/PENDING-ACTION-ORCHESTRATION-DESIGN.md' }] },
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
      },
    );

    expect(chatCalls[0]?.options?.tools).toEqual([]);
    expect(calledTools).toEqual(['fs_search']);
    expect(result.outcome.completionReason).toBe('model_response');
    expect(result.finalContent).toContain('approval continuity monitor');
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
    expect(result.hasPendingApprovals).toBe(true);
    expect(result.outcome.completionReason).toBe('approval_pending');
    expect(result.finalContent).toBe('');
  });

  it('re-prompts after a policy-blocked tool round instead of accepting a claimed filesystem success', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please create an empty file called brokered-test.txt in C:\\Sensitive.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'fs_write', arguments: JSON.stringify({ path: 'C:\\Sensitive\\brokered-test.txt', content: '' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Created empty file: C:\\Sensitive\\brokered-test.txt',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'update_tool_policy', arguments: JSON.stringify({ action: 'add_path', value: 'C:\\Sensitive' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Waiting for approval to add C:\\Sensitive to allowed paths.',
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
          {
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
          },
        ];
      },
      searchTools() {
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'fs_write') {
          return {
            success: false,
            status: 'failed',
            message: "Path 'C:\\Sensitive\\brokered-test.txt' is outside allowed paths. Use the update_tool_policy tool to add the path, or update manually via Tools policy > Allowed Paths (web) / /tools policy paths (CLI).",
          };
        }
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
      async (msgs: ChatMessage[], opts?: ChatOptions) => {
        chatCalls.push({ messages: msgs, options: opts });
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      5,
      32_000,
    );

    expect(calledTools).toEqual(['fs_write', 'update_tool_policy']);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls[2]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('previous tool call did not complete because tool policy blocked it'),
    });
    expect(result.hasPendingApprovals).toBe(true);
    expect(result.outcome.completionReason).toBe('approval_pending');
    expect(result.finalContent).toBe('');
  });

  it('does not infer additional tool work from a post-tool progress update', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write a two-line report to D:\\GuardianApprovalSmokeRound4\\round4.txt and continue once approval is granted.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'update_tool_policy', arguments: JSON.stringify({ action: 'add_path', value: 'D:\\GuardianApprovalSmokeRound4' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: "Path added. Now I'll write the two-line report.",
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'fs_write', arguments: JSON.stringify({ path: 'D:\\GuardianApprovalSmokeRound4\\round4.txt', content: 'Guardian approval smoke test - round 4 completed successfully.\\napproval continuity smoke' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Done. Wrote D:\\GuardianApprovalSmokeRound4\\round4.txt with the requested two lines.',
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
      5,
      32_000,
    );

    expect(calledTools).toEqual(['update_tool_policy']);
    expect(chatCalls).toHaveLength(2);
    expect(result.finalContent).toContain("Path added. Now I'll write the two-line report.");
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

  it('preloads exact tools required by the planned task without broadening deferred loading', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Find matching automations and suggest one useful automation.' }];
    const plannedTask: PlannedTask = {
      planId: 'plan:automation_control:read:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'read',
          summary: 'Read the automation catalog.',
          expectedToolCategories: ['automation_list'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Suggest one useful automation.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'automation_list', arguments: JSON.stringify({ step_id: 'step_1' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Create a stale-approval monitor automation.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const searchQueries: string[] = [];
    const toolNamesByRound: string[][] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'find_tools',
          description: 'Find deferred tools.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          risk: 'read_only',
          category: 'system',
        }];
      },
      async searchTools(query) {
        searchQueries.push(query);
        return [
          {
            name: 'automation_list',
            description: 'List automations from the canonical catalog.',
            parameters: { type: 'object', properties: {} },
            risk: 'read_only',
            category: 'automation',
          },
          {
            name: 'automation_save',
            description: 'Create an automation.',
            parameters: { type: 'object', properties: {} },
            risk: 'mutating',
            category: 'automation',
          },
        ];
      },
      async callTool(request): Promise<ToolResult> {
        expect(request.toolName).toBe('automation_list');
        return { success: true, output: { automations: [] } };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (_messages, options) => {
        toolNamesByRound.push(options?.tools?.map((tool) => tool.name) ?? []);
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      3,
      32_000,
      undefined,
      { plannedTask },
    );

    expect(searchQueries).toEqual(['automation_list']);
    expect(toolNamesByRound[0]).toContain('automation_list');
    expect(toolNamesByRound[0]).not.toContain('automation_save');
    expect(result.finalContent).toContain('stale-approval monitor');
  });

  it('repairs empty find_tools queries from the latest user request', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Run whoami in the remote sandbox for this workspace.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'find_tools', arguments: JSON.stringify({}) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Found the tool.',
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
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        expect(request.toolName).toBe('find_tools');
        expect(request.args).toMatchObject({
          query: 'Run whoami in the remote sandbox for this workspace.',
        });
        return {
          success: true,
          output: { tools: [] },
        };
      },
    };

    await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      3,
      32_000,
    );

    expect(searchQueries).toContain('find tools');
  });

  it('continues past discovery-only rounds instead of stopping after find_tools', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Run whoami in the remote sandbox for this workspace.' }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'find_tools', arguments: JSON.stringify({ query: 'remote sandbox' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'I found the code_remote_exec tool but have not run the command yet. Would you like me to proceed?',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'code_remote_exec', arguments: JSON.stringify({ command: 'whoami' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Remote sandbox user: daytona',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const calledTools: string[] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [];
      },
      async searchTools() {
        return [{
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
          risk: 'mutating',
          category: 'coding',
        }];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'find_tools') {
          return {
            success: true,
            output: {
              tools: [{
                name: 'code_remote_exec',
                description: 'Run a command in the remote sandbox.',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
                risk: 'mutating',
                category: 'coding',
              }],
            },
          };
        }
        expect(request.toolName).toBe('code_remote_exec');
        expect(request.args).toMatchObject({ command: 'whoami' });
        return {
          success: true,
          output: { stdout: 'daytona' },
        };
      },
    };

    const result = await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      4,
      32_000,
      undefined,
      {
        toolExecutionCorrectionPrompt: 'System correction: this turn requires real execution evidence.',
      },
    );

    expect(calledTools).toEqual(['find_tools', 'code_remote_exec']);
    expect(result.finalContent).toBe('Remote sandbox user: daytona');
  });

  it('does not treat progress text on a tool-call turn as the final answer', async () => {
    const messages: ChatMessage[] = [{
      role: 'user',
      content: 'Inspect Vercel status with read-only tools and return the result.',
    }];
    const responses: ChatResponse[] = [
      {
        content: 'I will discover the Vercel status tool first.',
        toolCalls: [{ id: 'call-1', name: 'find_tools', arguments: JSON.stringify({ query: 'vercel_status' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'vercel_status', arguments: JSON.stringify({ profile: 'main' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Vercel profile main is available.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const calledTools: string[] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'find_tools',
          description: 'Find deferred tools.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          risk: 'read_only',
          category: 'system',
        }];
      },
      async searchTools() {
        return [{
          name: 'vercel_status',
          description: 'Summarize Vercel projects and recent deployments.',
          parameters: { type: 'object', properties: { profile: { type: 'string' } } },
          risk: 'read_only',
          category: 'cloud',
        }];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'find_tools') {
          return {
            success: true,
            output: {
              tools: [{
                name: 'vercel_status',
                description: 'Summarize Vercel projects and recent deployments.',
                parameters: { type: 'object', properties: { profile: { type: 'string' } } },
                risk: 'read_only',
                category: 'cloud',
              }],
            },
          };
        }
        expect(request.toolName).toBe('vercel_status');
        return { success: true, output: { profile: 'main', connected: true } };
      },
    };

    const result = await runLlmLoop(
      messages,
      async () => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      4,
      32_000,
      undefined,
      {
        toolExecutionCorrectionPrompt: 'System correction: this turn requires real tool evidence.',
      },
    );

    expect(calledTools).toEqual(['find_tools', 'vercel_status']);
    expect(result.finalContent).toBe('Vercel profile main is available.');
  });

  it('reissues discovery-continuation correction when a multi-domain worker keeps discovering instead of calling tools', async () => {
    const messages: ChatMessage[] = [{
      role: 'user',
      content: 'Inspect connected cloud and workspace services with read-only tools, then return a compact table.',
    }];
    const plannedTask: PlannedTask = {
      planId: 'plan:general_assistant:inspect:2',
      allowAdditionalSteps: true,
      steps: [
        {
          stepId: 'step_1',
          kind: 'tool_call',
          summary: 'Collect real runtime/tool evidence needed to answer the request across the requested domains.',
          expectedToolCategories: ['runtime_evidence'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Return a compact table.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'find_tools', arguments: JSON.stringify({ query: 'vercel status' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'I found a Vercel status tool and will keep checking what is available.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'find_tools', arguments: JSON.stringify({ query: 'workspace status' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'I found workspace tools too.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-3', name: 'vercel_status', arguments: JSON.stringify({ profile: 'main' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: '| Domain | Status |\n| --- | --- |\n| Vercel | available |',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const correctionPrompts: string[] = [];
    const calledTools: string[] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'find_tools',
          description: 'Find deferred tools.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          risk: 'read_only',
          category: 'system',
        }];
      },
      async searchTools(query) {
        if (query.includes('vercel')) {
          return [{
            name: 'vercel_status',
            description: 'Summarize Vercel projects and recent deployments.',
            parameters: { type: 'object', properties: { profile: { type: 'string' } } },
            risk: 'read_only',
            category: 'cloud',
          }];
        }
        return [{
          name: 'gws_schema',
          description: 'Discover Google Workspace methods.',
          parameters: { type: 'object', properties: {} },
          risk: 'read_only',
          category: 'workspace',
        }];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'find_tools') {
          const query = typeof request.args.query === 'string' ? request.args.query : '';
          return {
            success: true,
            output: {
              tools: query.includes('vercel')
                ? [{
                    name: 'vercel_status',
                    description: 'Summarize Vercel projects and recent deployments.',
                    parameters: { type: 'object', properties: { profile: { type: 'string' } } },
                    risk: 'read_only',
                    category: 'cloud',
                  }]
                : [{
                    name: 'gws_schema',
                    description: 'Discover Google Workspace methods.',
                    parameters: { type: 'object', properties: {} },
                    risk: 'read_only',
                    category: 'workspace',
                  }],
            },
          };
        }
        expect(request.toolName).toBe('vercel_status');
        return { success: true, output: { profile: 'main', projects: [] } };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (roundMessages) => {
        const latest = roundMessages.at(-1);
        if (latest?.role === 'user' && latest.content.includes('discovering a tool is not the requested outcome')) {
          correctionPrompts.push(latest.content);
        }
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      6,
      32_000,
      undefined,
      {
        plannedTask,
        toolExecutionCorrectionPrompt: 'System correction: this turn requires real tool evidence.',
      },
    );

    expect(correctionPrompts).toHaveLength(2);
    expect(correctionPrompts.at(-1)).toContain('Available non-discovery tools now include: vercel_status');
    expect(calledTools).toEqual(['find_tools', 'find_tools', 'vercel_status']);
    expect(result.finalContent).toContain('Vercel');
  });

  it('keeps correcting a discovery-only stop when the first correction still returns progress text', async () => {
    const messages: ChatMessage[] = [{
      role: 'user',
      content: 'Inspect Vercel status with read-only tools.',
    }];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'find_tools', arguments: JSON.stringify({ query: 'vercel_status' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'I found the Vercel status tool and will inspect it next.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: 'I will now call vercel_status.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'vercel_status', arguments: JSON.stringify({ profile: 'main' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Vercel profile main is available.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];
    const correctionPrompts: string[] = [];
    const calledTools: string[] = [];
    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
          name: 'find_tools',
          description: 'Find deferred tools.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          risk: 'read_only',
          category: 'system',
        }];
      },
      async searchTools() {
        return [{
          name: 'vercel_status',
          description: 'Summarize Vercel projects and recent deployments.',
          parameters: { type: 'object', properties: { profile: { type: 'string' } } },
          risk: 'read_only',
          category: 'cloud',
        }];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'find_tools') {
          return {
            success: true,
            output: {
              tools: [{
                name: 'vercel_status',
                description: 'Summarize Vercel projects and recent deployments.',
                parameters: { type: 'object', properties: { profile: { type: 'string' } } },
                risk: 'read_only',
                category: 'cloud',
              }],
            },
          };
        }
        expect(request.toolName).toBe('vercel_status');
        return { success: true, output: { profile: 'main' } };
      },
    };

    const result = await runLlmLoop(
      messages,
      async (roundMessages) => {
        const latest = roundMessages.at(-1);
        if (latest?.role === 'user' && latest.content.includes('discovering a tool is not the requested outcome')) {
          correctionPrompts.push(latest.content);
        }
        const next = responses.shift();
        if (!next) throw new Error('Unexpected extra chatFn call');
        return next;
      },
      toolCaller,
      5,
      32_000,
      undefined,
      {
        toolExecutionCorrectionPrompt: 'System correction: this turn requires real tool evidence.',
      },
    );

    expect(correctionPrompts).toHaveLength(2);
    expect(calledTools).toEqual(['find_tools', 'vercel_status']);
    expect(result.finalContent).toContain('available');
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

  it('auto-loads deferred update_tool_policy after a policy-blocked round and forces the correction retry', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please create an empty file called brokered-test.txt in C:\\Sensitive.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'fs_write', arguments: JSON.stringify({ path: 'C:\\Sensitive\\brokered-test.txt', content: '' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Done — brokered-test.txt has been created.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'update_tool_policy', arguments: JSON.stringify({ action: 'add_path', value: 'C:\\Sensitive' }) }],
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
    const searchQueries: string[] = [];
    const chatCalls: Array<{ tools?: unknown }> = [];

    const updatePolicyDef: ToolDefinition = {
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
    };

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
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
        }];
      },
      searchTools(query: string) {
        searchQueries.push(query);
        if (query.toLowerCase().includes('update_tool_policy') || query.toLowerCase().includes('update tool policy')) {
          return [updatePolicyDef];
        }
        return [];
      },
      async callTool(request): Promise<ToolResult> {
        calledTools.push(request.toolName);
        if (request.toolName === 'fs_write') {
          return {
            success: false,
            status: 'failed',
            message: "Path 'C:\\Sensitive\\brokered-test.txt' is outside allowed paths. Use the update_tool_policy tool to add the path.",
          };
        }
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
      async (_msgs: ChatMessage[], opts?: ChatOptions) => {
        chatCalls.push({ tools: opts?.tools });
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected extra chatFn call');
        }
        return next;
      },
      toolCaller,
      5,
      32_000,
    );

    expect(calledTools).toEqual(['fs_write', 'update_tool_policy']);
    expect(searchQueries.some((q) => q.toLowerCase().includes('update'))).toBe(true);
    const toolsOnThirdCall = (chatCalls[2]?.tools ?? []) as Array<{ name: string }>;
    expect(toolsOnThirdCall.some((tool) => tool.name === 'update_tool_policy')).toBe(true);
    expect(result.hasPendingApprovals).toBe(true);
    expect(result.finalContent).not.toMatch(/Done — brokered-test\.txt has been created/);
  });

  it('does not fabricate a recovery answer when every tool result in the round was policy-blocked', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please create an empty file called brokered-test.txt in C:\\Sensitive.' },
    ];
    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'fs_write', arguments: JSON.stringify({ path: 'C:\\Sensitive\\brokered-test.txt', content: '' }) }],
        model: 'test-model',
        finishReason: 'tool_calls',
      },
      {
        content: 'Let me inspect the repository first.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: 'Let me inspect the repository first.',
        model: 'test-model',
        finishReason: 'stop',
      },
      {
        content: 'Let me inspect the repository first.',
        model: 'test-model',
        finishReason: 'stop',
      },
    ];

    const toolCaller: ToolCaller = {
      listAlwaysLoaded() {
        return [{
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
        }];
      },
      searchTools() {
        return [];
      },
      async callTool(): Promise<ToolResult> {
        return {
          success: false,
          status: 'failed',
          message: "Path 'C:\\Sensitive\\brokered-test.txt' is outside allowed paths. Use update_tool_policy.",
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

    expect(result.outcome.successfulToolResultCount).toBe(0);
    expect(result.outcome.completionReason).not.toBe('tool_result_recovery');
    expect(result.finalContent).not.toMatch(/Created|Done|Successfully/i);
  });
});
