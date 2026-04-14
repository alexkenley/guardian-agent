import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  isRecord,
  stripLeadingContextPrefix,
  toBoolean,
  toString,
} from '../../chat-agent-helpers.js';
import {
  parseDirectMemoryReadRequest,
  parseDirectMemorySaveRequest,
} from '../../util/memory-intent.js';
import type { ToolExecutor } from '../../tools/executor.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type { PendingActionRecord } from '../pending-actions.js';
import type { PendingActionSetResult } from './orchestration-state.js';

type MemoryResponse = string | { content: string; metadata?: Record<string, unknown> } | null;

function formatDirectMemorySearchResponse(
  output: unknown,
  options: {
    query: string;
    scope: 'global' | 'code_session' | 'both';
    separateScopes: boolean;
    labelSources: boolean;
  },
): string {
  const record = isRecord(output) ? output : {};
  const results = Array.isArray(record.results)
    ? record.results.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const searchedScopes: Array<'global' | 'code_session'> = Array.isArray(record.persistentScopesSearched)
    ? record.persistentScopesSearched
      .map((value) => toString(value))
      .filter((value): value is 'global' | 'code_session' => value === 'global' || value === 'code_session')
    : [];
  const effectiveScopes: Array<'global' | 'code_session'> = searchedScopes.length > 0
    ? searchedScopes
    : (options.scope === 'both' ? ['global', 'code_session'] : [options.scope]);
  const grouped = new Map<'global' | 'code_session', Record<string, unknown>[]>(
    effectiveScopes.map((scope) => [scope, []]),
  );
  for (const row of results) {
    const source = toString(row.source);
    if (source === 'global' || source === 'code_session') {
      const existing = grouped.get(source) ?? [];
      existing.push(row);
      grouped.set(source, existing);
    }
  }

  if (results.length === 0) {
    if (effectiveScopes.length === 2 || options.separateScopes || options.labelSources) {
      return `I didn't find any matching persistent memory in global or code-session memory for "${options.query}".`;
    }
    return `I didn't find any matching ${effectiveScopes[0] === 'code_session' ? 'code-session memory' : 'global memory'} for "${options.query}".`;
  }

  const formatRow = (row: Record<string, unknown>): string => {
    const summary = toString(row.summary).trim();
    const content = toString(row.content).trim();
    const category = toString(row.category).trim();
    const combined = summary && content && !content.toLowerCase().includes(summary.toLowerCase())
      ? `${summary} — ${content}`
      : (content || summary || '(empty memory entry)');
    return category ? `${category}: ${combined}` : combined;
  };
  const sourceLabel = (scope: 'global' | 'code_session') => scope === 'code_session' ? 'Code-session memory' : 'Global memory';

  if (effectiveScopes.length === 2 || options.separateScopes || options.labelSources) {
    const lines = [`I found ${results.length} matching persistent memory ${results.length === 1 ? 'entry' : 'entries'} for "${options.query}".`];
    for (const scope of effectiveScopes) {
      lines.push(`${sourceLabel(scope)}:`);
      const rows = grouped.get(scope) ?? [];
      if (rows.length === 0) {
        lines.push('- no matching entries');
        continue;
      }
      rows.forEach((row) => lines.push(`- ${formatRow(row)}`));
    }
    return lines.join('\n');
  }

  if (results.length === 1) {
    const scope = effectiveScopes[0] ?? 'global';
    return `I found this in ${sourceLabel(scope).toLowerCase()}: ${formatRow(results[0])}`;
  }
  return [
    `I found ${results.length} matching persistent memory entries for "${options.query}":`,
    ...results.map((row) => `- ${formatRow(row)}`),
  ].join('\n');
}

function formatDirectMemoryRecallResponse(
  output: unknown,
  scope: 'global' | 'code_session' | 'both',
): string {
  const sourceLabel = (value: 'global' | 'code_session') => value === 'code_session' ? 'Code-session memory' : 'Global memory';
  const formatEntries = (entries: unknown): string[] => (
    Array.isArray(entries)
      ? entries
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => {
          const summary = toString(entry.summary).trim();
          const content = toString(entry.content).trim();
          const category = toString(entry.category).trim();
          const combined = summary && content && !content.toLowerCase().includes(summary.toLowerCase())
            ? `${summary} — ${content}`
            : (content || summary || '(empty memory entry)');
          return category ? `${category}: ${combined}` : combined;
        })
      : []
  );
  if (scope === 'both' && isRecord(output)) {
    const globalEntries = formatEntries(isRecord(output.global) ? output.global.entries : []);
    const codeEntries = formatEntries(isRecord(output.codeSession) ? output.codeSession.entries : []);
    const lines = ['Here is the current persistent memory state:'];
    lines.push(`${sourceLabel('global')}:`);
    lines.push(...(globalEntries.length > 0 ? globalEntries.map((entry) => `- ${entry}`) : ['- no stored entries']));
    lines.push(`${sourceLabel('code_session')}:`);
    lines.push(...(codeEntries.length > 0 ? codeEntries.map((entry) => `- ${entry}`) : ['- no stored entries']));
    return lines.join('\n');
  }
  const entries = formatEntries(isRecord(output) ? output.entries : []);
  const label = sourceLabel(scope === 'both' ? 'global' : scope);
  if (entries.length === 0) {
    return `${label} is currently empty.`;
  }
  return [
    `Here is the current ${label.toLowerCase()} state:`,
    ...entries.map((entry) => `- ${entry}`),
  ].join('\n');
}

export async function tryDirectMemorySave(input: {
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'getApprovalSummaries' | 'isEnabled'> | null;
  agentId: string;
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  codeContext?: { workspaceRoot?: string; sessionId?: string };
  originalUserContent?: string;
  getPendingApprovals: (
    userKey: string,
    surfaceId?: string,
  ) => { ids: string[]; createdAt: number; expiresAt: number } | null;
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved?: string; denied?: string },
  ) => void;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string; actionLabel?: string }>,
  ) => string;
  setPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionRecord['blocker']['approvalSummaries'];
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  buildPendingApprovalBlockedResponse: (
    result: PendingActionSetResult,
    fallbackContent: string,
  ) => { content: string; metadata?: Record<string, unknown> };
}): Promise<MemoryResponse> {
  if (!input.tools?.isEnabled()) return null;

  const intent = parseDirectMemorySaveRequest(stripLeadingContextPrefix(input.message.content))
    ?? parseDirectMemorySaveRequest(stripLeadingContextPrefix(input.originalUserContent ?? ''));
  if (!intent) return null;

  const toolResult = await input.tools.executeModelTool(
    'memory_save',
    {
      content: intent.content,
      scope: intent.scope,
      ...(intent.scope === 'code_session' && input.codeContext?.sessionId ? { sessionId: input.codeContext.sessionId } : {}),
    },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole ?? 'owner',
      channel: input.message.channel,
      requestId: input.message.id,
      allowModelMemoryMutation: true,
      bypassApprovals: true,
      agentContext: { checkAction: input.ctx.checkAction },
      ...(input.codeContext?.workspaceRoot ? {
        codeContext: {
          workspaceRoot: input.codeContext.workspaceRoot,
          ...(input.codeContext.sessionId ? { sessionId: input.codeContext.sessionId } : {}),
        },
      } : {}),
    },
  );

  if (!toBoolean(toolResult.success)) {
    const status = toString(toolResult.status);
    if (status === 'pending_approval') {
      const approvalId = toString(toolResult.approvalId);
      const existingIds = input.getPendingApprovals(input.userKey)?.ids ?? [];
      const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
      if (approvalId) {
        const scopeLabel = intent.scope === 'code_session' ? 'code-session memory' : 'global memory';
        input.setApprovalFollowUp(approvalId, {
          approved: `I saved that to ${scopeLabel}.`,
          denied: `I did not save that to ${scopeLabel}.`,
        });
      }
      const summaries = pendingIds.length > 0 ? input.tools.getApprovalSummaries(pendingIds) : undefined;
      const prompt = input.formatPendingApprovalPrompt(pendingIds, summaries);
      const pendingActionResult = input.setPendingApprovalActionForRequest(
        input.userKey,
        input.message.surfaceId,
        {
          prompt,
          approvalIds: pendingIds,
          approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
          originalUserContent: input.message.content,
          route: 'memory_task',
          operation: 'save',
          summary: intent.scope === 'code_session'
            ? 'Saves a fact to code-session memory.'
            : 'Saves a fact to global memory.',
          turnRelation: 'new_request',
          resolution: 'ready',
          ...(input.codeContext?.sessionId ? { codeSessionId: input.codeContext.sessionId } : {}),
        },
      );
      return input.buildPendingApprovalBlockedResponse(
        pendingActionResult,
        [
          `I prepared a memory save for ${intent.scope === 'code_session' ? 'code-session memory' : 'global memory'}, but it needs approval first.`,
          prompt,
        ].filter(Boolean).join('\n\n'),
      );
    }
    const errorMessage = toString(toolResult.message) || toString(toolResult.error) || 'Memory save failed.';
    return intent.scope === 'code_session'
      ? `I couldn't save that to code-session memory: ${errorMessage}`
      : `I couldn't save that to global memory: ${errorMessage}`;
  }

  const output = isRecord(toolResult.output) ? toolResult.output : {};
  const savedScope = toString(output.scope) === 'code_session' ? 'code-session memory' : 'global memory';
  return `I saved that to ${savedScope}.`;
}

export async function tryDirectMemoryRead(input: {
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null;
  agentId: string;
  message: UserMessage;
  ctx: AgentContext;
  codeContext?: { workspaceRoot?: string; sessionId?: string };
  originalUserContent?: string;
}): Promise<MemoryResponse> {
  if (!input.tools?.isEnabled()) return null;

  const intent = parseDirectMemoryReadRequest(stripLeadingContextPrefix(input.message.content))
    ?? parseDirectMemoryReadRequest(stripLeadingContextPrefix(input.originalUserContent ?? ''));
  if (!intent) return null;

  const scope = intent.scope ?? (input.codeContext?.sessionId ? 'both' : 'global');
  const toolRequest = {
    origin: 'assistant' as const,
    agentId: input.agentId,
    userId: input.message.userId,
    surfaceId: input.message.surfaceId,
    principalId: input.message.principalId ?? input.message.userId,
    principalRole: input.message.principalRole ?? 'owner',
    channel: input.message.channel,
    requestId: input.message.id,
    agentContext: { checkAction: input.ctx.checkAction },
    ...(input.codeContext?.workspaceRoot ? {
      codeContext: {
        workspaceRoot: input.codeContext.workspaceRoot,
        ...(input.codeContext.sessionId ? { sessionId: input.codeContext.sessionId } : {}),
      },
    } : {}),
  };

  if (intent.mode === 'search' && intent.query) {
    const toolResult = await input.tools.executeModelTool(
      'memory_search',
      {
        query: intent.query,
        scope: 'persistent',
        persistentScope: scope,
        ...((scope === 'code_session' || scope === 'both') && input.codeContext?.sessionId
          ? { sessionId: input.codeContext.sessionId }
          : {}),
      },
      toolRequest,
    );
    if (!toBoolean(toolResult.success)) {
      const errorMessage = toString(toolResult.message) || toString(toolResult.error) || 'Memory search failed.';
      return `I couldn't search persistent memory: ${errorMessage}`;
    }
    return formatDirectMemorySearchResponse(toolResult.output, {
      query: intent.query,
      scope,
      separateScopes: intent.separateScopes,
      labelSources: intent.labelSources,
    });
  }

  const toolResult = await input.tools.executeModelTool(
    'memory_recall',
    {
      scope,
      ...((scope === 'code_session' || scope === 'both') && input.codeContext?.sessionId
        ? { sessionId: input.codeContext.sessionId }
        : {}),
    },
    toolRequest,
  );
  if (!toBoolean(toolResult.success)) {
    const errorMessage = toString(toolResult.message) || toString(toolResult.error) || 'Memory recall failed.';
    return `I couldn't recall persistent memory: ${errorMessage}`;
  }
  return formatDirectMemoryRecallResponse(toolResult.output, scope);
}
