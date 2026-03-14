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
});
