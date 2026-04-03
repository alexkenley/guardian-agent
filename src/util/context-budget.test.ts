import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/types.js';
import { compactMessagesIfOverBudget } from './context-budget.js';

function makeToolMessage(content: string): ChatMessage {
  return {
    role: 'tool',
    toolCallId: 'tool-1',
    content,
  };
}

describe('compactMessagesIfOverBudget', () => {
  it('leaves small conversations unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];

    const result = compactMessagesIfOverBudget(messages, 1000);

    expect(result.applied).toBe(false);
    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
  });

  it('compacts historical tool outputs and assistant tool args while preserving recent messages', () => {
    const recentUser = { role: 'user', content: 'recent user prompt' } satisfies ChatMessage;
    const recentAssistant = { role: 'assistant', content: 'recent assistant reply' } satisfies ChatMessage;
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: 'older assistant',
        toolCalls: [{ id: 'call-1', name: 'code_edit', arguments: JSON.stringify({ value: 'x'.repeat(1200) }) }],
      },
      makeToolMessage(JSON.stringify({ success: true, output: 'y'.repeat(2000) })),
      { role: 'assistant', content: 'older assistant 2' },
      makeToolMessage(JSON.stringify({ success: true, output: 'z'.repeat(1600) })),
      { role: 'user', content: 'older user' },
      recentUser,
      recentAssistant,
      { role: 'tool', toolCallId: 'tool-2', content: 'recent tool result should remain intact' },
    ];

    const result = compactMessagesIfOverBudget(messages, 1400);

    expect(result.applied).toBe(true);
    expect(result.stages).toContain('truncate_tool_calls');
    expect(result.stages).toContain('truncate_tool_results');
    expect(result.afterChars).toBeLessThan(result.beforeChars);
    const compactedTool = messages.find((message) => message.role === 'tool' && String(message.content).includes('compacted'));
    expect(compactedTool).toBeDefined();
    expect(messages[messages.length - 3]).toEqual(recentUser);
    expect(messages[messages.length - 2]).toEqual(recentAssistant);
    expect(messages[messages.length - 1].content).toBe('recent tool result should remain intact');
  });

  it('aggressively trims history when far over budget', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system rules' },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'tool',
        content: `message-${index}-` + 'x'.repeat(900),
        ...(index % 2 === 1 ? { toolCallId: `tool-${index}` } : {}),
      })) as ChatMessage[],
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: 'final answer in progress' },
    ];

    const result = compactMessagesIfOverBudget(messages, 80);

    expect(result.applied).toBe(true);
    expect(result.stages).toContain('aggressive_trim');
    expect(result.summary).toContain('Compacted prior work summary');
    expect(result.summary).toContain('objective:keep me');
    expect(messages.length).toBeLessThan(8);
    expect(messages.some((message) => message.role === 'system' && message.content.includes('Compacted prior work summary'))).toBe(true);
    expect(messages[messages.length - 1].content).toBe('final answer in progress');
  });

  it('preserves assistant tool calls that match kept tool results during aggressive trim', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system rules' },
      {
        role: 'assistant',
        content: 'calling browser read',
        toolCalls: [{ id: 'call-1', name: 'browser_read', arguments: JSON.stringify({ url: 'https://example.com' }) }],
      },
      { role: 'tool', toolCallId: 'call-1', content: JSON.stringify({ success: true, output: { content: 'Example Domain' } }) },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'tool',
        content: `message-${index}-` + 'y'.repeat(1000),
        ...(index % 2 === 1 ? { toolCallId: `tool-${index}` } : {}),
      })) as ChatMessage[],
      { role: 'user', content: 'summarize the page result' },
      { role: 'tool', toolCallId: 'call-1', content: JSON.stringify({ success: true, output: { content: 'Example Domain final' } }) },
      { role: 'assistant', content: 'final answer in progress' },
    ];

    compactMessagesIfOverBudget(messages, 80);

    expect(messages.some((message) => message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.some((toolCall) => toolCall.id === 'call-1'))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.toolCallId === 'call-1')).toBe(true);
  });
});
