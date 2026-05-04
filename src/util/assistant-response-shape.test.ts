import { describe, expect, it } from 'vitest';

import {
  lacksUsableAssistantContent,
  looksLikeOngoingWorkResponse,
  looksLikeRawToolMarkup,
} from './assistant-response-shape.js';

describe('assistant-response-shape', () => {
  it('treats provider tokenized tool calls as raw tool markup', () => {
    const content = [
      'I will search memory now.',
      '<|tool_calls_section_begin|>',
      '<|tool_call_begin|>functions.memory_search:0<|tool_call_argument_begin|>{"query":"*"}',
      '<|tool_call_end|>',
      '<|tool_calls_section_end|>',
    ].join('');

    expect(looksLikeRawToolMarkup(content)).toBe(true);
    expect(lacksUsableAssistantContent(content)).toBe(true);
  });

  it('treats provider XML-style tool calls as raw tool markup', () => {
    const content = [
      '<minimax:tool_call>',
      '<invoke name="assistant_security_summary">',
      '<parameter name="scope">recent</parameter>',
      '</invoke>',
      '</minimax:tool_call>',
    ].join('');

    expect(looksLikeRawToolMarkup(content)).toBe(true);
    expect(lacksUsableAssistantContent(content)).toBe(true);
  });

  it('treats tool-round-only status text as lacking usable assistant content', () => {
    const content = [
      'Tool round status:',
      '- Tool \'find_tools\' completed.',
      '- Tool \'find_tools\' completed.',
    ].join('\n');

    expect(lacksUsableAssistantContent(content)).toBe(true);
  });

  it('treats bare tool promises as ongoing work rather than final answers', () => {
    expect(looksLikeOngoingWorkResponse('Will perform web_search.')).toBe(true);
    expect(looksLikeOngoingWorkResponse(
      'Attempting to fetch NASA Apollo 13 page for verification.',
    )).toBe(true);
    expect(looksLikeOngoingWorkResponse(
      'We\'ll search for detailed analyses of Apollo 13, fetch key pages, then synthesize a deep-dive report.',
    )).toBe(true);
  });
});
