import { describe, expect, it } from 'vitest';
import {
  normalizeToolCallsForExecution,
  parseStructuredJsonObjectDetailed,
  parseStructuredJsonValueDetailed,
  recoverToolCallsFromStructuredText,
} from './structured-json.js';

describe('structured-json', () => {
  it('repairs fenced JSON objects with trailing commas', () => {
    const parsed = parseStructuredJsonObjectDetailed<{
      route?: string;
      operation?: string;
    }>([
      'Here is the result:',
      '```json',
      '{',
      '  "route": "coding_task",',
      '  "operation": "inspect",',
      '}',
      '```',
    ].join('\n'));

    expect(parsed?.value).toEqual({
      route: 'coding_task',
      operation: 'inspect',
    });
    expect(parsed?.repaired).toBe(true);
    expect(parsed?.flags).toContain('outer_json_extraction');
    expect(parsed?.flags).toContain('trailing_commas');
  });

  it('extracts the first balanced JSON value from surrounding prose', () => {
    const parsed = parseStructuredJsonValueDetailed('Result: [{"tool":"web_search","arguments":{"query":"guardian"}}] thanks.');

    expect(Array.isArray(parsed?.value)).toBe(true);
    expect(parsed?.flags).toContain('outer_json_extraction');
  });

  it('recovers JSON-shaped tool calls from plain text content', () => {
    const recovered = recoverToolCallsFromStructuredText(
      JSON.stringify({
        tool_calls: [
          {
            function: {
              name: 'web_search',
              arguments: { query: 'guardian agent', maxResults: 5 },
            },
          },
        ],
      }),
      [{ name: 'web_search' }, { name: 'fs_list' }],
    );

    expect(recovered?.toolCalls).toEqual([
      {
        id: 'recovered-tool-call-1',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'guardian agent', maxResults: 5 }),
      },
    ]);
  });

  it('recovers provider tokenized tool calls from assistant text', () => {
    const recovered = recoverToolCallsFromStructuredText(
      [
        'I will create that now.',
        '<|tool_calls_section_begin|>',
        '<|tool_call_begin|> functions.fs_write:0 <|tool_call_argument_begin|>',
        '{"path":"S:\\\\Development\\\\GuardianAgent\\\\tmp\\\\live-approval.txt","content":"APPROVAL-LIVE-27491"}',
        '<|tool_call_end|>',
        '<|tool_calls_section_end|>',
      ].join(' '),
      [{ name: 'fs_write' }, { name: 'fs_read' }],
    );

    expect(recovered).toMatchObject({
      flags: ['provider_tool_tokens'],
      confidence: 'medium',
      repaired: true,
    });
    expect(recovered?.toolCalls).toEqual([
      {
        id: 'recovered-tool-call-1',
        name: 'fs_write',
        arguments: JSON.stringify({
          path: 'S:\\Development\\GuardianAgent\\tmp\\live-approval.txt',
          content: 'APPROVAL-LIVE-27491',
        }),
      },
    ]);
  });

  it('normalizes malformed tool-call names that were serialized as JSON wrappers', () => {
    const normalized = normalizeToolCallsForExecution(
      [
        {
          id: 'call-1',
          name: '{"name":"fs_search","arguments":{"path":"src","pattern":"timeline"}}',
          arguments: '{}',
        },
      ],
      [{ name: 'fs_search' }, { name: 'fs_read' }],
    );

    expect(normalized).toEqual([
      {
        id: 'call-1',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'src', pattern: 'timeline' }),
      },
    ]);
  });

  it('preserves existing argument objects when recovering the tool name from malformed fields', () => {
    const normalized = normalizeToolCallsForExecution(
      [
        {
          id: 'call-1',
          name: '{"name":"fs_write","arguments":{"path":"tmp/out.md"}}',
          arguments: JSON.stringify({ content: 'hello' }),
        },
      ],
      [{ name: 'fs_write' }],
    );

    expect(normalized).toEqual([
      {
        id: 'call-1',
        name: 'fs_write',
        arguments: JSON.stringify({ path: 'tmp/out.md', content: 'hello' }),
      },
    ]);
  });
});
