import { describe, expect, it } from 'vitest';
import {
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
});
