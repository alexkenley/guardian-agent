import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  formatToolThreatWarnings,
  toBoolean,
  toString,
} from '../../chat-agent-helpers.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import { parseWebSearchIntent } from '../search-intent.js';
import type { StoredToolLoopSanitizedResult } from './tool-loop-runtime.js';

export async function tryDirectWebSearch(input: {
  agentId: string;
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null;
  message: UserMessage;
  ctx: AgentContext;
  llmMessages: ChatMessage[];
  fallbackProviderOrder?: string[];
  defaultToolResultProviderKind: 'local' | 'external';
  sanitizeToolResultForLlm: (
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ) => StoredToolLoopSanitizedResult;
  chatWithFallback: (
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: ChatOptions,
    fallbackProviderOrder?: string[],
  ) => Promise<ChatResponse>;
}): Promise<string | null> {
  if (!input.tools?.isEnabled()) return null;

  const rawResult = await executeDirectWebSearch(input);
  if (!rawResult) return null;

  const sanitizedWebSearch = input.sanitizeToolResultForLlm(
    'web_search',
    rawResult,
    input.defaultToolResultProviderKind,
  );
  const safeWebSearchResult = typeof sanitizedWebSearch.sanitized === 'string'
    ? sanitizedWebSearch.sanitized
    : String(sanitizedWebSearch.sanitized ?? '');
  const warningPrefix = formatToolThreatWarnings(sanitizedWebSearch.threats);
  const llmSearchPayload = warningPrefix
    ? `${warningPrefix}\n${safeWebSearchResult}`
    : safeWebSearchResult;

  if (!input.ctx.llm) {
    return llmSearchPayload;
  }

  try {
    const llmFormat: ChatMessage[] = [
      ...input.llmMessages,
      { role: 'user', content: `Here are web search results for the user's query. Summarize and present them clearly:\n\n${llmSearchPayload}` },
    ];
    const formatted = await input.chatWithFallback(
      input.ctx,
      llmFormat,
      undefined,
      input.fallbackProviderOrder,
    );
    if (
      isDegradedDirectWebSearchSynthesis(formatted.content)
      || shouldUseGroundedSearchPayload(formatted.content, llmSearchPayload)
    ) {
      return llmSearchPayload;
    }
    return formatted.content || llmSearchPayload;
  } catch {
    return llmSearchPayload;
  }
}

function isDegradedDirectWebSearchSynthesis(content: string | undefined): boolean {
  const normalized = content?.trim() ?? '';
  if (!normalized) return false;
  if (/\bweb_search\s+query\s*:/i.test(normalized)) return true;
  if (/^let'?s\s+call\s+(?:fs_search|web_search|doc_search)\.?$/i.test(normalized)) return true;
  if (
    normalized.length < 320
    && /\b(?:i'?ll|i\s+will|we'?ll|we\s+will|let\s+me|let'?s)\b.{0,80}\b(?:fetch|search|look\s+up|browse|open|read|call|use|run)\b/i.test(normalized)
  ) {
    return true;
  }
  if (
    normalized.length < 240
    && /\b(?:call|use|run)\s+(?:the\s+)?(?:fs_search|web_search|doc_search)\b/i.test(normalized)
  ) {
    return true;
  }
  return false;
}

function shouldUseGroundedSearchPayload(content: string | undefined, groundedPayload: string): boolean {
  const normalized = content?.trim() ?? '';
  if (!normalized) return false;
  if (!/\bhttps?:\/\//i.test(groundedPayload)) return false;
  if (/\bhttps?:\/\//i.test(normalized)) return false;
  return normalized.length < 500 || /\b(?:source|sources|citation|citations|link|links)\b/i.test(groundedPayload);
}

async function executeDirectWebSearch(input: {
  agentId: string;
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<string | null> {
  if (!input.tools?.isEnabled()) return null;

  const query = parseWebSearchIntent(input.message.content);
  if (!query) return null;

  const toolResult = await input.tools.executeModelTool(
    'web_search',
    { query, maxResults: 10 },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    },
  );

  if (!toBoolean(toolResult.success)) {
    const msg = toString(toolResult.message) || toString(toolResult.error) || 'Web search failed.';
    return `I tried to search the web for "${query}" but it failed: ${msg}`;
  }

  const output = (toolResult.output && typeof toolResult.output === 'object'
    ? toolResult.output
    : null) as {
      provider?: unknown;
      results?: unknown;
      answer?: unknown;
    } | null;

  const provider = output ? toString(output.provider) : 'unknown';
  const results = output && Array.isArray(output.results)
    ? output.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>
    : [];
  const answer = output ? toString(output.answer) : '';

  if (results.length === 0 && !answer) {
    return `I searched the web for "${query}" (via ${provider}) but found no results.`;
  }

  const lines = [`Web search results for "${query}" (via ${provider}):\n`];
  if (answer) {
    lines.push(`Summary: ${answer}\n`);
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = toString(r.title) || '(untitled)';
    const url = toString(r.url);
    const snippet = toString(r.snippet);
    lines.push(`${i + 1}. **${title}**`);
    if (url) lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  }
  return lines.join('\n');
}
