import type { ChatMessage } from '../llm/types.js';

export interface ContextCompactionResult {
  applied: boolean;
  beforeChars: number;
  afterChars: number;
  capacityChars: number;
  stages: Array<'truncate_tool_calls' | 'truncate_tool_results' | 'aggressive_trim'>;
  summary?: string;
}

function summarizeObjective(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const compact = message.content.replace(/\s+/g, ' ').trim();
    if (!compact) continue;
    return truncateText(compact, 140);
  }
  return undefined;
}

function expandRetainedMessagesWithToolPairs(messages: ChatMessage[], retainedBase: ChatMessage[]): ChatMessage[] {
  const retainedRefs = new Set<ChatMessage>(retainedBase);
  const requiredToolCallIds = new Set<string>();

  const seedRequiredIds = (message: ChatMessage) => {
    if (message.role === 'tool' && typeof message.toolCallId === 'string' && message.toolCallId.trim().length > 0) {
      requiredToolCallIds.add(message.toolCallId);
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        requiredToolCallIds.add(toolCall.id);
      }
    }
  };

  for (const message of retainedBase) {
    seedRequiredIds(message);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      const needsAssistant = message.role === 'assistant'
        && Array.isArray(message.toolCalls)
        && message.toolCalls.some((toolCall) => requiredToolCallIds.has(toolCall.id));
      const needsTool = message.role === 'tool'
        && typeof message.toolCallId === 'string'
        && requiredToolCallIds.has(message.toolCallId);
      if ((needsAssistant || needsTool) && !retainedRefs.has(message)) {
        retainedRefs.add(message);
        seedRequiredIds(message);
        changed = true;
      }
    }
  }

  return messages.filter((message) => retainedRefs.has(message));
}

function expandTailWithRequiredToolPairs(messages: ChatMessage[], tail: ChatMessage[]): ChatMessage[] {
  return expandRetainedMessagesWithToolPairs(messages, tail);
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message, index, array) => array.findIndex((candidate) => candidate === message) === index);
}

function buildHistoricalSummary(historical: ChatMessage[], objectiveSource: ChatMessage[]): string | undefined {
  const objective = summarizeObjective(objectiveSource);
  const summaryParts: string[] = objective ? [`objective:${objective}`] : [];
  for (const message of historical) {
    if (message.role === 'tool' && message.content) {
      summaryParts.push(`tool:${truncateText(message.content, 120)}`);
    } else if (message.role === 'assistant' && message.content) {
      summaryParts.push(`assistant:${truncateText(message.content, 120)}`);
    }
    if (summaryParts.length >= 5) break;
  }
  return summaryParts.length > 0
    ? `Compacted prior work summary:\n${summaryParts.join('\n')}`
    : undefined;
}

function isHistoricalUserAnchor(message: ChatMessage): boolean {
  return message.role === 'user';
}

function preserveHistoricalAnchors(historical: ChatMessage[]): ChatMessage[] {
  return historical.filter(isHistoricalUserAnchor).slice(-2);
}

function aggressivelyTrimHistoricalMessages(messages: ChatMessage[], keepCount: number): string | undefined {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const historical = messages.slice(0, Math.max(0, messages.length - keepCount));
  const preservedHistorical = preserveHistoricalAnchors(historical);
  const tail = expandTailWithRequiredToolPairs(messages, messages.slice(-keepCount));
  const summary = buildHistoricalSummary(historical, messages);
  const summaryMessage: ChatMessage | null = summary
    ? {
      role: 'system',
      content: summary,
    }
    : null;

  messages.splice(0, messages.length, ...dedupeMessages([
    ...systemMessages,
    ...(summaryMessage ? [summaryMessage] : []),
    ...preservedHistorical,
    ...tail,
  ]));
  return summaryMessage?.content;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}[...truncated]`;
}

function totalChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const toolCallChars = Array.isArray(m.toolCalls)
      ? m.toolCalls.reduce((inner, toolCall) => inner + (toolCall.arguments?.length ?? 0), 0)
      : 0;
    return sum + (m.content?.length ?? 0) + toolCallChars;
  }, 0);
}

function compactHistoricalToolMessages(messages: ChatMessage[], protectedStart: number, maxChars: number): number {
  let compacted = 0;
  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !msg.content || msg.content.length <= maxChars) continue;
    try {
      const parsed = JSON.parse(msg.content) as Record<string, unknown>;
      msg.content = JSON.stringify({
        success: parsed.success,
        status: parsed.status,
        summary: truncateText(String(parsed.message ?? parsed.output ?? ''), Math.max(80, maxChars - 50)),
        compacted: true,
      });
    } catch {
      msg.content = truncateText(msg.content, maxChars);
    }
    compacted += 1;
  }
  return compacted;
}

function compactHistoricalAssistantToolCalls(messages: ChatMessage[], protectedStart: number, maxArgChars: number): number {
  let compacted = 0;
  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) continue;
    let touched = false;
    msg.toolCalls = msg.toolCalls.map((toolCall) => ({
      ...toolCall,
      arguments: (() => {
        const original = toolCall.arguments ?? '';
        const next = truncateText(original, maxArgChars);
        if (next !== original) touched = true;
        return next;
      })(),
    }));
    if (msg.content) {
      const nextContent = truncateText(msg.content, 400);
      if (nextContent !== msg.content) touched = true;
      msg.content = nextContent;
    }
    if (touched) compacted += 1;
  }
  return compacted;
}

/**
 * Compact message history using a staged strategy as the conversation approaches
 * the token budget (approximated as budget * 4 chars per token).
 */
export function compactMessagesIfOverBudget(messages: ChatMessage[], budget: number): ContextCompactionResult {
  const capacity = budget * 4;
  const currentTotal = totalChars(messages);
  const result: ContextCompactionResult = {
    applied: false,
    beforeChars: currentTotal,
    afterChars: currentTotal,
    capacityChars: capacity,
    stages: [],
  };
  if (currentTotal <= capacity * 0.7) return result;

  const protectedCount = 6;
  const protectedStart = Math.max(0, messages.length - protectedCount);

  if (currentTotal > capacity * 0.8) {
    const compactedToolCalls = compactHistoricalAssistantToolCalls(messages, protectedStart, 400);
    const compactedToolMessages = compactHistoricalToolMessages(messages, protectedStart, 260);
    if (compactedToolCalls > 0) result.stages.push('truncate_tool_calls');
    if (compactedToolMessages > 0 && !result.stages.includes('truncate_tool_results')) {
      result.stages.push('truncate_tool_results');
    }
  }

  if (totalChars(messages) > capacity * 0.85) {
    const compactedToolMessages = compactHistoricalToolMessages(messages, protectedStart, 180);
    const compactedToolCalls = compactHistoricalAssistantToolCalls(messages, protectedStart, 180);
    if (compactedToolMessages > 0 && !result.stages.includes('truncate_tool_results')) {
      result.stages.push('truncate_tool_results');
    }
    if (compactedToolCalls > 0 && !result.stages.includes('truncate_tool_calls')) {
      result.stages.push('truncate_tool_calls');
    }
  }

  if (totalChars(messages) > capacity * 0.95) {
    const summary = aggressivelyTrimHistoricalMessages(messages, 5);
    result.stages.push('aggressive_trim');
    if (summary) result.summary = summary;
  }

  result.afterChars = totalChars(messages);
  result.applied = result.afterChars < result.beforeChars;
  if (!result.applied) {
    result.stages = [];
    delete result.summary;
  }
  return result;
}
